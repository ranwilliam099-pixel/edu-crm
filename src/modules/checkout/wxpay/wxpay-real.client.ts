import {
  Injectable,
  Logger,
  BadRequestException,
  InternalServerErrorException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as fs from 'fs';
import {
  WxPayClient,
  CreatePrepayParams,
  CreatePrepayResult,
  CallbackHeaders,
  RefundParams,
  RefundResult,
} from './wxpay.types';
import { WxPayPlatformCertService } from './wxpay-platform-cert.service';

/**
 * RealWxPayClient — 微信支付 V3 真实实现
 *
 * 来源：
 *   - 用户 2026-05-14 W2-T1 RealWxPayClient 落地拍板
 *   - 微信支付 V3 文档：
 *     - JSAPI 下单: https://pay.weixin.qq.com/doc/v3/merchant/4012791897
 *     - 回调验签: https://pay.weixin.qq.com/doc/v3/merchant/4012365186
 *     - 退款申请: https://pay.weixin.qq.com/doc/v3/merchant/4012365190
 *   - docs/integration-plan-2026-05-10.md 小程序支付流程
 *
 * 严守边界：
 *   1. 接口契约（WxPayClient）不变，与 MockWxPayClient 并存供 DI 切换
 *   2. 不直接处理 user content（msgSecCheck 由 SecurityModule 负责）
 *   3. 微信原始 errcode / errmsg 不透传给 client（A05 内部 ID 暴露规避）
 *   4. 签名 / 验签 / AES-GCM 解密用 Node crypto，无外部 SDK 依赖
 *   5. fail-open 哲学：网络异常 → 500 / 验签失败 → false（让 callback service 拒绝）
 *
 * 项目隔离（追加 #8）：不引用企业管理系统主项目任何支付逻辑
 */

const WXPAY_API_BASE = 'https://api.mch.weixin.qq.com';

/** 签名时间窗（V3 文档：±5 分钟）*/
const SIGN_TIME_WINDOW_SEC = 5 * 60;

/** ULID 32 字符校验（与 mock 对齐）*/
const ULID_LENGTH = 32;

/**
 * 微信预支付响应
 */
interface WxJsapiPrepayResponse {
  prepay_id?: string;
  code?: string;
  message?: string;
}

/**
 * 微信退款响应（V3 /v3/refund/domestic/refunds）
 */
interface WxRefundResponse {
  refund_id?: string;
  out_refund_no?: string;
  status?: 'SUCCESS' | 'CLOSED' | 'PROCESSING' | 'ABNORMAL';
  code?: string;
  message?: string;
}

/**
 * 关单响应（V3 /v3/pay/transactions/out-trade-no/{out_trade_no}/close）
 * 成功为 204 无内容；失败 4xx + JSON
 */

@Injectable()
export class RealWxPayClient implements WxPayClient, OnModuleInit {
  private readonly logger = new Logger(RealWxPayClient.name);
  private privateKeyPem: string | null = null;
  private cachedConfig: {
    mchid: string;
    appId: string;
    serialNo: string;
    apiV3Key: string;
    notifyUrl: string;
    certPath?: string;
  } | null = null;

  constructor(
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly platformCert?: WxPayPlatformCertService,
  ) {}

  onModuleInit(): void {
    const mode = this.config?.get<string>('WXPAY_MODE', 'mock');
    if (mode !== 'real') {
      this.logger.log(`WXPAY_MODE=${mode}, RealWxPayClient lazy-init only`);
      return;
    }
    // 启动时立即加载配置（fail-fast 暴露配置错误）
    try {
      this.loadConfig();
      this.logger.log(
        `RealWxPayClient ready: mchid=${this.cachedConfig?.mchid} appid=${this.cachedConfig?.appId} serial=${this.cachedConfig?.serialNo}`,
      );
    } catch (err) {
      // 加载失败仅 warn — 不阻塞启动；首次调用时再尝试
      // (与 SecurityModule WX_APP_ID 缺失策略一致)
      this.logger.warn(
        `[fail-open] RealWxPayClient config load failed: ${(err as Error).message}`,
      );
    }
  }

  // ============================================================
  // WxPayClient 接口实现
  // ============================================================

  /**
   * 创建 JSAPI 预支付订单
   * POST /v3/pay/transactions/jsapi
   */
  async createPrepay(params: CreatePrepayParams): Promise<CreatePrepayResult> {
    this.validatePrepay(params);
    const cfg = this.loadConfig();

    const urlPath = '/v3/pay/transactions/jsapi';
    const reqBody: {
      appid: string;
      mchid: string;
      description: string;
      out_trade_no: string;
      notify_url: string;
      amount: { total: number; currency: string };
      payer: { openid: string };
      attach?: string;
    } = {
      appid: cfg.appId,
      mchid: cfg.mchid,
      description: params.description,
      out_trade_no: params.outTradeNo,
      notify_url: params.notifyUrl,
      amount: {
        total: params.amountCents,
        currency: 'CNY',
      },
      payer: {
        openid: params.openid,
      },
    };
    // T9-FU-1 (2026-05-16)：tenantId 透传到 V3 attach 字段
    // 微信 V3 协议 attach 限 128 byte，32-ULID 完全够；不传则不设字段（向后兼容 parent-extra）
    // callback 端 wxpay.controller.ts:344-373 解密后读 decrypted.attach 推 subscription UPDATE
    if (params.tenantId) {
      reqBody.attach = params.tenantId;
    }
    const reqBodyStr = JSON.stringify(reqBody);

    const auth = this.buildAuthorizationHeader('POST', urlPath, reqBodyStr, cfg);

    let data: WxJsapiPrepayResponse;
    let status: number;
    try {
      const res = await fetch(`${WXPAY_API_BASE}${urlPath}`, {
        method: 'POST',
        headers: {
          Authorization: auth,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          // 5/14 凌晨 03:30 生产 fix：Node 20 fetch (undici) 默认 Accept-Language: *
          // 微信 V3 API 严格校验，传 `*` 返 HTTP 406 PARAM_ERROR
          // 显式覆盖为 zh-CN
          'Accept-Language': 'zh-CN',
          'User-Agent': 'edu-server/wxpay-v3',
        },
        body: reqBodyStr,
      });
      status = res.status;
      const text = await res.text();
      data = text ? (JSON.parse(text) as WxJsapiPrepayResponse) : {};
    } catch (err) {
      this.logger.error(
        `createPrepay network error outTradeNo=${params.outTradeNo}: ${(err as Error).message}`,
      );
      throw new InternalServerErrorException({
        code: 'WXPAY_NETWORK_ERROR',
        message: 'wxpay network error',
      });
    }

    if (status !== 200 || !data.prepay_id) {
      // A05：不透传微信 errmsg 给 client（防内部 ID / 业务字段暴露）
      // 仅 logger 记录原始信息便于排查
      this.logger.warn(
        `createPrepay failed status=${status} code=${data.code} message=${data.message} outTradeNo=${params.outTradeNo}`,
      );
      throw new InternalServerErrorException({
        code: 'WXPAY_PREPAY_FAILED',
        message: 'wxpay prepay failed',
      });
    }

    // 派生 jsApiParams（前端 wx.requestPayment 用）
    //   signString = appId\ntimestamp\nnonceStr\npackage\n
    const timeStamp = String(Math.floor(Date.now() / 1000));
    const nonceStr = crypto.randomBytes(16).toString('hex');
    const packageVal = `prepay_id=${data.prepay_id}`;
    const paySignStr = `${cfg.appId}\n${timeStamp}\n${nonceStr}\n${packageVal}\n`;
    const paySign = this.rsaSign(paySignStr, this.requirePrivateKey());

    return {
      prepayId: data.prepay_id,
      jsApiParams: {
        timeStamp,
        nonceStr,
        package: packageVal,
        signType: 'RSA',
        paySign,
      },
    };
  }

  /**
   * 验证微信回调签名（V3 SHA256-WITH-RSA + Timestamp/Nonce）
   *
   * 签名串：timestamp\nnonce\nbody\n
   *
   * @returns true=签名合法且时间窗内 / false=任意校验失败
   */
  async verifyCallbackSignature(
    headers: CallbackHeaders,
    rawBody: string,
  ): Promise<boolean> {
    const ts = headers['wechatpay-timestamp'];
    const nonce = headers['wechatpay-nonce'];
    const serial = headers['wechatpay-serial'];
    const signatureB64 = headers['wechatpay-signature'];

    if (!ts || !nonce || !serial || !signatureB64) {
      this.logger.warn('verifyCallbackSignature: missing wxpay headers');
      return false;
    }

    // ±5 分钟时间窗（防重放）
    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum)) {
      this.logger.warn(`verifyCallbackSignature: bad timestamp ${ts}`);
      return false;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - tsNum) > SIGN_TIME_WINDOW_SEC) {
      this.logger.warn(
        `verifyCallbackSignature: timestamp out of window (now=${nowSec}, ts=${tsNum})`,
      );
      return false;
    }

    if (!this.platformCert) {
      this.logger.error(
        'verifyCallbackSignature: WxPayPlatformCertService not injected',
      );
      return false;
    }

    const publicKey = await this.platformCert.getPublicKey(serial);
    if (!publicKey) {
      this.logger.warn(
        `verifyCallbackSignature: platform cert not available for serial=${serial}`,
      );
      return false;
    }

    const signStr = `${ts}\n${nonce}\n${rawBody}\n`;
    try {
      const verifier = crypto.createVerify('RSA-SHA256');
      verifier.update(signStr);
      const ok = verifier.verify(publicKey, signatureB64, 'base64');
      if (!ok) {
        this.logger.warn(
          `verifyCallbackSignature: signature mismatch serial=${serial}`,
        );
      }
      return ok;
    } catch (err) {
      this.logger.warn(
        `verifyCallbackSignature: verify error ${(err as Error).message}`,
      );
      return false;
    }
  }

  /**
   * 申请退款
   * POST /v3/refund/domestic/refunds
   */
  async requestRefund(params: RefundParams): Promise<RefundResult> {
    this.validateRefund(params);
    const cfg = this.loadConfig();

    const urlPath = '/v3/refund/domestic/refunds';
    const reqBody = {
      out_trade_no: params.outTradeNo,
      out_refund_no: params.outRefundNo,
      reason: params.reason,
      notify_url: cfg.notifyUrl,
      amount: {
        refund: params.refundAmountCents,
        total: params.totalAmountCents,
        currency: 'CNY',
      },
    };
    const reqBodyStr = JSON.stringify(reqBody);

    const auth = this.buildAuthorizationHeader('POST', urlPath, reqBodyStr, cfg);

    let data: WxRefundResponse;
    let status: number;
    try {
      const res = await fetch(`${WXPAY_API_BASE}${urlPath}`, {
        method: 'POST',
        headers: {
          Authorization: auth,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          // 5/14 凌晨 03:30 生产 fix：Node 20 fetch (undici) 默认 Accept-Language: *
          // 微信 V3 API 严格校验，传 `*` 返 HTTP 406 PARAM_ERROR
          // 显式覆盖为 zh-CN
          'Accept-Language': 'zh-CN',
          'User-Agent': 'edu-server/wxpay-v3',
        },
        body: reqBodyStr,
      });
      status = res.status;
      const text = await res.text();
      data = text ? (JSON.parse(text) as WxRefundResponse) : {};
    } catch (err) {
      this.logger.error(
        `requestRefund network error outRefundNo=${params.outRefundNo}: ${(err as Error).message}`,
      );
      throw new InternalServerErrorException({
        code: 'WXPAY_NETWORK_ERROR',
        message: 'wxpay network error',
      });
    }

    if (status !== 200 || !data.refund_id || !data.status) {
      this.logger.warn(
        `requestRefund failed status=${status} code=${data.code} message=${data.message} outRefundNo=${params.outRefundNo}`,
      );
      throw new InternalServerErrorException({
        code: 'WXPAY_REFUND_FAILED',
        message: 'wxpay refund failed',
      });
    }

    return {
      refundId: data.refund_id,
      status: data.status,
    };
  }

  // ============================================================
  // 关单 — 不在 WxPayClient 接口里（V3 控制器层补的扩展能力），
  // 由 controller 直接调本 client 实例（DI 是同一个对象）
  // ============================================================

  /**
   * 关闭未支付订单（前端取消 / 超时主动 close）
   * POST /v3/pay/transactions/out-trade-no/{out_trade_no}/close
   *
   * 注：成功返回 204 无内容；本方法返 boolean
   */
  async closeOrder(outTradeNo: string): Promise<boolean> {
    if (!outTradeNo || outTradeNo.length !== ULID_LENGTH) {
      throw new BadRequestException('outTradeNo must be 32-char ULID');
    }
    const cfg = this.loadConfig();
    const urlPath = `/v3/pay/transactions/out-trade-no/${outTradeNo}/close`;
    const reqBody = { mchid: cfg.mchid };
    const reqBodyStr = JSON.stringify(reqBody);

    const auth = this.buildAuthorizationHeader('POST', urlPath, reqBodyStr, cfg);

    let status: number;
    try {
      const res = await fetch(`${WXPAY_API_BASE}${urlPath}`, {
        method: 'POST',
        headers: {
          Authorization: auth,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          // 5/14 凌晨 03:30 生产 fix：Node 20 fetch (undici) 默认 Accept-Language: *
          // 微信 V3 API 严格校验，传 `*` 返 HTTP 406 PARAM_ERROR
          // 显式覆盖为 zh-CN
          'Accept-Language': 'zh-CN',
          'User-Agent': 'edu-server/wxpay-v3',
        },
        body: reqBodyStr,
      });
      status = res.status;
    } catch (err) {
      this.logger.error(
        `closeOrder network error outTradeNo=${outTradeNo}: ${(err as Error).message}`,
      );
      throw new InternalServerErrorException({
        code: 'WXPAY_NETWORK_ERROR',
        message: 'wxpay network error',
      });
    }

    if (status !== 204) {
      this.logger.warn(`closeOrder failed status=${status} outTradeNo=${outTradeNo}`);
      throw new InternalServerErrorException({
        code: 'WXPAY_CLOSE_FAILED',
        message: 'wxpay close failed',
      });
    }
    return true;
  }

  // ============================================================
  // 内部 — 签名 / 配置 / 校验
  // ============================================================

  /**
   * 构造 V3 Authorization header
   *
   * 签名串：method\nurl\ntimestamp\nnonce_str\nbody\n
   */
  buildAuthorizationHeader(
    method: string,
    urlPath: string,
    body: string,
    cfg: { mchid: string; serialNo: string },
  ): string {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonceStr = crypto.randomBytes(16).toString('hex');
    const signStr = `${method}\n${urlPath}\n${timestamp}\n${nonceStr}\n${body}\n`;
    const signature = this.rsaSign(signStr, this.requirePrivateKey());
    return (
      `WECHATPAY2-SHA256-RSA2048 ` +
      `mchid="${cfg.mchid}",` +
      `nonce_str="${nonceStr}",` +
      `timestamp="${timestamp}",` +
      `serial_no="${cfg.serialNo}",` +
      `signature="${signature}"`
    );
  }

  /** RSA-SHA256 签名 → base64 */
  rsaSign(data: string, privateKeyPem: string): string {
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(data);
    return signer.sign(privateKeyPem, 'base64');
  }

  /**
   * 加载配置（懒加载 + 缓存）
   * @throws Error 缺失任何必需 ENV
   */
  loadConfig(): {
    mchid: string;
    appId: string;
    serialNo: string;
    apiV3Key: string;
    notifyUrl: string;
    certPath?: string;
  } {
    if (this.cachedConfig) return this.cachedConfig;
    if (!this.config) {
      throw new InternalServerErrorException({
        code: 'WXPAY_CONFIG_MISSING',
        message: 'ConfigService not injected',
      });
    }
    // T14 §2.3：active 派生（pm2 reload --update-env 即生效切换）
    // active=primary|fallback；其他值 fail-fast 防误配
    const active = this.config.get<string>('WXPAY_MCHID_ACTIVE', 'primary');
    if (active !== 'primary' && active !== 'fallback') {
      throw new InternalServerErrorException({
        code: 'WXPAY_CONFIG_INVALID',
        message: `WXPAY_MCHID_ACTIVE must be 'primary' or 'fallback', got '${active}'`,
      });
    }
    const suffix = active.toUpperCase();
    // 优先读 _<ACTIVE>，缺则 fallback 旧无后缀 ENV（向后兼容）
    const pick = (base: string): string | undefined =>
      this.config!.get<string>(`${base}_${suffix}`) ||
      this.config!.get<string>(base);
    const mchid = pick('WXPAY_MCHID');
    const appId = this.config.get<string>('WXPAY_APP_ID'); // appId 不分主备（小程序 appId 单一）
    const serialNo = pick('WXPAY_SERIAL_NO');
    const apiV3Key = this.config.get<string>('WXPAY_API_V3_KEY'); // APIv3 密钥不分主备（商户级共享）
    const notifyUrl = this.config.get<string>('WXPAY_NOTIFY_URL');
    const privateKeyPath = pick('WXPAY_PRIVATE_KEY_PATH');
    const certPath = pick('WXPAY_CERT_PATH');

    const missing: string[] = [];
    if (!mchid) missing.push('WXPAY_MCHID');
    if (!appId) missing.push('WXPAY_APP_ID');
    if (!serialNo) missing.push('WXPAY_SERIAL_NO');
    if (!apiV3Key) missing.push('WXPAY_API_V3_KEY');
    if (!notifyUrl) missing.push('WXPAY_NOTIFY_URL');
    if (!privateKeyPath) missing.push('WXPAY_PRIVATE_KEY_PATH');

    if (missing.length > 0) {
      throw new InternalServerErrorException({
        code: 'WXPAY_CONFIG_MISSING',
        message: `wxpay config missing: ${missing.join(',')}`,
      });
    }

    // 必填检查通过：用 non-null 断言（已通过 missing 数组 + early throw 守护）
    const mchidV = mchid!;
    const appIdV = appId!;
    const serialNoV = serialNo!;
    const apiV3KeyV = apiV3Key!;
    const notifyUrlV = notifyUrl!;
    const privateKeyPathV = privateKeyPath!;

    if (apiV3KeyV.length !== 32) {
      throw new InternalServerErrorException({
        code: 'WXPAY_CONFIG_INVALID',
        message: `WXPAY_API_V3_KEY must be 32 chars, got ${apiV3KeyV.length}`,
      });
    }

    // 读私钥（缓存）
    try {
      this.privateKeyPem = fs.readFileSync(privateKeyPathV, 'utf8');
    } catch (err) {
      throw new InternalServerErrorException({
        code: 'WXPAY_PRIVATE_KEY_MISSING',
        message: `read WXPAY_PRIVATE_KEY_PATH=${privateKeyPathV} failed: ${(err as Error).message}`,
      });
    }

    this.cachedConfig = {
      mchid: mchidV,
      appId: appIdV,
      serialNo: serialNoV,
      apiV3Key: apiV3KeyV,
      notifyUrl: notifyUrlV,
      certPath,
    };
    return this.cachedConfig;
  }

  /** 暴露给单测：清缓存重新加载（覆盖 env 后） */
  resetConfigCache(): void {
    this.cachedConfig = null;
    this.privateKeyPem = null;
  }

  /** 暴露给单测：直接注入私钥（避免依赖文件系统） */
  injectPrivateKeyForTest(pem: string): void {
    this.privateKeyPem = pem;
  }

  private requirePrivateKey(): string {
    if (!this.privateKeyPem) {
      // loadConfig 已读过；fallback safety
      this.loadConfig();
    }
    if (!this.privateKeyPem) {
      throw new InternalServerErrorException({
        code: 'WXPAY_PRIVATE_KEY_MISSING',
        message: 'private key not loaded',
      });
    }
    return this.privateKeyPem;
  }

  // ============================================================
  // 内部 — 入参校验（与 mock 对齐）
  // ============================================================

  private validatePrepay(p: CreatePrepayParams): void {
    if (!p.outTradeNo || p.outTradeNo.length !== ULID_LENGTH) {
      throw new BadRequestException('outTradeNo must be 32-char ULID');
    }
    if (!p.openid) throw new BadRequestException('openid required');
    if (!Number.isInteger(p.amountCents) || p.amountCents <= 0) {
      throw new BadRequestException('amountCents must be positive integer');
    }
    if (!p.description) throw new BadRequestException('description required');
    if (!p.notifyUrl?.startsWith('http')) {
      throw new BadRequestException('notifyUrl must be http(s)');
    }
  }

  private validateRefund(p: RefundParams): void {
    if (!p.outTradeNo || p.outTradeNo.length !== ULID_LENGTH) {
      throw new BadRequestException('outTradeNo must be 32-char ULID');
    }
    if (!p.outRefundNo || p.outRefundNo.length !== ULID_LENGTH) {
      throw new BadRequestException('outRefundNo must be 32-char ULID');
    }
    if (
      !Number.isInteger(p.refundAmountCents) ||
      !Number.isInteger(p.totalAmountCents)
    ) {
      throw new BadRequestException('refund/total amount must be integer');
    }
    if (p.refundAmountCents <= 0 || p.refundAmountCents > p.totalAmountCents) {
      throw new BadRequestException('refundAmount must be in (0, totalAmount]');
    }
    if (!p.reason) throw new BadRequestException('reason required (A04 §3)');
  }
}
