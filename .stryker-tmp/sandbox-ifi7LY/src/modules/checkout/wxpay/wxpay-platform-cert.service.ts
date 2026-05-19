import {
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as fs from 'fs';

/**
 * WxPayPlatformCertService — 微信平台公钥获取与缓存（V3 回调验签前置）
 *
 * 来源：
 *   - 用户 2026-05-14 W2-T1 RealWxPayClient 落地拍板
 *   - 微信支付 V3 文档：通用规则 / 平台证书 / 验签
 *     https://pay.weixin.qq.com/doc/v3/merchant/4012365186
 *
 * 用途：
 *   - 启动时拉取微信平台证书（GET /v3/certificates）
 *   - 微信侧用 APIv3 密钥 AES-256-GCM 加密返回 encrypt_certificate → 解密获得公钥
 *   - 缓存到内存 Map<serial_no, publicKey>，验签时按 Wechatpay-Serial header 查
 *   - 12 小时定时刷新（微信平台证书 TTL 12 个月，刷新窗口宽裕）
 *
 * Fail-open 哲学：
 *   - onModuleInit 拉取失败不阻塞 NestJS 启动（mock 模式 / 网络抖动场景）
 *   - 验签首次调用时若 cache miss 触发懒加载
 *   - 仍失败 → verifyCallbackSignature 返回 false（RealWxPayClient 视为验签失败）
 *
 * §0 不猜测严守：
 *   - 不主动从对接方系统拉取证书，仅信任微信 /v3/certificates 返回
 *   - 不复用企业管理系统主项目任何证书获取实现（追加 #8 项目隔离）
 *
 * 配置 ENV（生产 .env 已配）：
 *   WXPAY_MCHID                商户号
 *   WXPAY_API_V3_KEY           APIv3 密钥（32 字符，用于 AES-256-GCM 解密 encrypt_certificate）
 *   WXPAY_SERIAL_NO            商户证书序列号（用于 V3 签名 Authorization header）
 *   WXPAY_PRIVATE_KEY_PATH     商户私钥路径（apiclient_key.pem，用于 V3 签名）
 *
 * 2026-05-14 凌晨 03:40 新机制（微信对新商户已强制）：
 *   WXPAY_PUB_KEY_PATH         微信支付公钥本地 .pem 路径（商户平台「微信支付公钥」入口下载）
 *   WXPAY_PUB_KEY_ID           微信支付公钥 ID（PUB_KEY_ID_xxx，回调 Wechatpay-Serial header 用此值）
 *
 * 双轨设计（向后兼容）：
 *   - 优先：启动时 fs.readFileSync 本地 pub_key.pem → cache.set(WXPAY_PUB_KEY_ID, ...)
 *   - 回退：调 GET /v3/certificates（老商户仍可用 X.509 平台证书）
 *   - 验签时按 callback Wechatpay-Serial 头部查 cache：
 *     - 命中 PUB_KEY_ID_xxx → 用本地公钥验签
 *     - 命中 40 位 hex serial → 用 /v3/certificates 拿的平台证书验签
 */

const CERTIFICATES_URL = 'https://api.mch.weixin.qq.com/v3/certificates';

/** 微信平台证书的「单条」响应结构 */
interface WxPlatformCertItem {
  serial_no: string;
  effective_time: string;
  expire_time: string;
  encrypt_certificate: {
    algorithm: string;
    nonce: string;
    associated_data: string;
    ciphertext: string; // base64 编码的 AES-GCM 密文（含 16 字节 authTag 后缀）
  };
}

interface WxPlatformCertResponse {
  data?: WxPlatformCertItem[];
  code?: string;
  message?: string;
}

/** 缓存的平台公钥条目 */
export interface CachedPlatformCert {
  serialNo: string;
  publicKey: string; // PEM 格式
  effectiveTime: Date;
  expireTime: Date;
}

@Injectable()
export class WxPayPlatformCertService implements OnModuleInit {
  private readonly logger = new Logger(WxPayPlatformCertService.name);
  private readonly cache = new Map<string, CachedPlatformCert>();
  private refreshTimer: NodeJS.Timeout | null = null;
  /** 防止并发 fetchCertificates（首次 + 定时同时触发）*/
  private fetchPromise: Promise<void> | null = null;

  constructor(@Optional() private readonly config?: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const mode = this.config?.get<string>('WXPAY_MODE', 'mock');
    if (mode !== 'real') {
      this.logger.log(`WXPAY_MODE=${mode}, skip platform cert init`);
      return;
    }

    // 5/14 凌晨 03:40 新机制：优先加载本地 pub_key.pem
    //   微信对新商户强制使用「微信支付公钥」（GET /v3/certificates 已 404 RESOURCE_NOT_EXISTS）
    //   fail-open：本地文件不存在 / 配置缺失仅 warn，不阻塞启动
    try {
      this.loadLocalPublicKey();
    } catch (err) {
      this.logger.warn(
        `[fail-open] load local pub_key.pem failed: ${(err as Error).message}`,
      );
    }

    // 老机制兼容：尝试调 /v3/certificates（老商户号仍可用，新商户号会 404 fail-open）
    //   失败不阻塞，因为本地公钥已 cache（如果本地配了）
    try {
      await this.refreshCertificates();
    } catch (err) {
      this.logger.warn(
        `[fail-open] /v3/certificates fallback failed (本地 pub_key.pem 仍可用): ${(err as Error).message}`,
      );
    }

    // 12 小时定时刷新（仅对 /v3/certificates 老机制有用；本地 pub_key.pem 不需要刷新）
    this.refreshTimer = setInterval(
      () => {
        void this.refreshCertificates().catch((err) => {
          // 新商户 404 是预期，降级为 debug 级别避免日志噪音
          this.logger.debug(
            `scheduled /v3/certificates refresh failed (新商户预期 404): ${(err as Error).message}`,
          );
        });
      },
      12 * 60 * 60 * 1000,
    );
    // 防止 setInterval 阻塞 Node 退出
    this.refreshTimer.unref?.();
  }

  /**
   * 5/14 新机制：从本地 .pem 文件加载微信支付公钥到 cache
   *
   * @throws Error 如果 ENV 缺失 / 文件不存在 / .pem 格式非法
   */
  private loadLocalPublicKey(): void {
    // T14 §2.4：active 派生（与 wxpay-real.client.loadConfig 保持一致）
    const pubKeyId = this.pickByActive('WXPAY_PUB_KEY_ID');
    const pubKeyPath = this.pickByActive('WXPAY_PUB_KEY_PATH');

    if (!pubKeyId || !pubKeyPath) {
      throw new Error(
        'WXPAY_PUB_KEY_ID + WXPAY_PUB_KEY_PATH 未配（新机制必填，老商户可忽略）',
      );
    }

    if (!fs.existsSync(pubKeyPath)) {
      throw new Error(`pub_key.pem not found at ${pubKeyPath}`);
    }

    const publicKey = fs.readFileSync(pubKeyPath, 'utf8');
    if (!publicKey.includes('BEGIN PUBLIC KEY')) {
      throw new Error(`${pubKeyPath} 不是合法 PEM 公钥（缺 BEGIN PUBLIC KEY）`);
    }

    // 微信支付公钥永久有效（无 effectiveTime/expireTime 概念）
    // 用 1970-01-01 + 2099-12-31 占位让 cache 永不过期
    this.cache.set(pubKeyId, {
      serialNo: pubKeyId,
      publicKey,
      effectiveTime: new Date(0),
      expireTime: new Date('2099-12-31T23:59:59Z'),
    });

    this.logger.log(
      `loaded local pub_key.pem: serialNo=${pubKeyId} bytes=${publicKey.length}`,
    );
  }

  /** PM2 reload / shutdown 时清理 timer */
  onModuleDestroy(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * 按 serial_no 取公钥；cache miss 时触发懒加载
   *
   * @param serialNo 微信回调 Wechatpay-Serial header 值
   * @returns PEM 格式公钥，或 null（拉取失败 / serial 不在响应中）
   */
  async getPublicKey(serialNo: string): Promise<string | null> {
    const cached = this.cache.get(serialNo);
    if (cached && cached.expireTime.getTime() > Date.now()) {
      return cached.publicKey;
    }

    // cache miss：触发懒加载（防并发重复拉取）
    try {
      await this.ensureLoaded();
    } catch (err) {
      this.logger.warn(
        `lazy platform cert fetch failed for serial=${serialNo}: ${(err as Error).message}`,
      );
      return null;
    }

    const fresh = this.cache.get(serialNo);
    if (!fresh) {
      this.logger.warn(
        `platform cert not found for serial=${serialNo} after refresh (微信未返回该 serial 或已过期)`,
      );
      return null;
    }
    return fresh.publicKey;
  }

  /**
   * 暴露给单测：直接清空缓存
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * 暴露给单测：直接注入一条 cache（不走 fetch 流程）
   */
  injectCert(cert: CachedPlatformCert): void {
    this.cache.set(cert.serialNo, cert);
  }

  /**
   * 暴露给单测：当前 cache 状态
   */
  getCacheSize(): number {
    return this.cache.size;
  }

  // ============================================================
  // 内部
  // ============================================================

  /** 并发安全的 refresh wrapper（首次 + 定时 + 懒加载并发时仅 1 个 in-flight）*/
  private async ensureLoaded(): Promise<void> {
    if (this.fetchPromise) return this.fetchPromise;
    this.fetchPromise = this.refreshCertificates().finally(() => {
      this.fetchPromise = null;
    });
    return this.fetchPromise;
  }

  /**
   * 调微信 /v3/certificates → AES-256-GCM 解密 encrypt_certificate → cache 公钥
   *
   * 注意：调用 /v3/certificates 本身也需 V3 签名（用商户私钥签 GET 请求），
   *      但响应里的 encrypt_certificate 不是用商户私钥签名，是 APIv3 密钥对称加密
   */
  async refreshCertificates(): Promise<void> {
    const cfg = this.requireConfig();

    const auth = this.buildAuthorizationHeader('GET', '/v3/certificates', '', cfg);
    let data: WxPlatformCertResponse;
    try {
      const res = await fetch(CERTIFICATES_URL, {
        method: 'GET',
        headers: {
          Authorization: auth,
          Accept: 'application/json',
          // 5/14 凌晨 03:30 生产 fix：Node 20 fetch (undici) 默认携带 Accept-Language: *
          // 微信 V3 API 严格校验 Accept-Language，传 `*` 返 HTTP 406 PARAM_ERROR
          // 显式覆盖为 zh-CN（微信中国大陆地区合规）
          'Accept-Language': 'zh-CN',
          'User-Agent': 'edu-server/wxpay-v3',
        },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      data = (await res.json()) as WxPlatformCertResponse;
    } catch (err) {
      throw new Error(`fetch /v3/certificates failed: ${(err as Error).message}`);
    }

    if (!data.data || data.data.length === 0) {
      throw new Error(
        `/v3/certificates returned no certificates (code=${data.code}, message=${data.message})`,
      );
    }

    let added = 0;
    for (const item of data.data) {
      try {
        const publicKey = this.decryptCertificate(
          item.encrypt_certificate,
          cfg.apiV3Key,
        );
        this.cache.set(item.serial_no, {
          serialNo: item.serial_no,
          publicKey,
          effectiveTime: new Date(item.effective_time),
          expireTime: new Date(item.expire_time),
        });
        added++;
      } catch (err) {
        this.logger.warn(
          `decrypt platform cert serial=${item.serial_no} failed: ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `platform cert refreshed: ${added}/${data.data.length} certs cached`,
    );
  }

  /**
   * AES-256-GCM 解密微信 encrypt_certificate.ciphertext
   *
   * 微信侧 ciphertext 格式（base64 解码后）：
   *   [N-16 bytes encrypted payload] + [16 bytes auth tag]
   *
   * @param ec      encrypt_certificate 对象
   * @param key32   APIv3 密钥（必须 32 字节 UTF-8）
   * @returns       明文证书 PEM
   */
  decryptCertificate(
    ec: { algorithm: string; nonce: string; associated_data: string; ciphertext: string },
    key32: string,
  ): string {
    if (key32.length !== 32) {
      throw new Error(`WXPAY_API_V3_KEY must be 32 chars, got ${key32.length}`);
    }
    if (ec.algorithm !== 'AEAD_AES_256_GCM') {
      throw new Error(`unexpected algorithm: ${ec.algorithm}`);
    }
    const ciphertextBuf = Buffer.from(ec.ciphertext, 'base64');
    if (ciphertextBuf.length < 16) {
      throw new Error('ciphertext too short (missing auth tag)');
    }
    const authTag = ciphertextBuf.subarray(ciphertextBuf.length - 16);
    const encrypted = ciphertextBuf.subarray(0, ciphertextBuf.length - 16);

    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      Buffer.from(key32, 'utf8'),
      Buffer.from(ec.nonce, 'utf8'),
    );
    decipher.setAuthTag(authTag);
    decipher.setAAD(Buffer.from(ec.associated_data, 'utf8'));
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  }

  /**
   * 构造 Authorization header（V3 签名）— 同 RealWxPayClient.buildAuth，
   * 但此处独立实现避免循环依赖（platform-cert 调 /v3/certificates 本身需签名）
   *
   * 签名串：method\nurl\ntimestamp\nnonce_str\nbody\n
   *
   * @param method     HTTP method 大写
   * @param urlPath    URL path（含 query string；/v3/certificates 无 query）
   * @param body       请求体字符串（GET 为 ''）
   */
  buildAuthorizationHeader(
    method: string,
    urlPath: string,
    body: string,
    cfg: {
      mchid: string;
      serialNo: string;
      privateKeyPem: string;
    },
  ): string {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonceStr = crypto.randomBytes(16).toString('hex');
    const signStr = `${method}\n${urlPath}\n${timestamp}\n${nonceStr}\n${body}\n`;
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(signStr);
    const signature = signer.sign(cfg.privateKeyPem, 'base64');
    return (
      `WECHATPAY2-SHA256-RSA2048 ` +
      `mchid="${cfg.mchid}",` +
      `nonce_str="${nonceStr}",` +
      `timestamp="${timestamp}",` +
      `serial_no="${cfg.serialNo}",` +
      `signature="${signature}"`
    );
  }

  /**
   * 读取生产配置 + 加载私钥
   *
   * @throws Error 配置缺失 / 私钥文件不存在
   */
  private requireConfig(): {
    mchid: string;
    apiV3Key: string;
    serialNo: string;
    privateKeyPem: string;
  } {
    if (!this.config) {
      throw new Error('ConfigService not injected');
    }
    // T14 §2.4：active 派生 mchid/serialNo/privateKeyPath（apiV3Key 不分主备）
    const mchid = this.pickByActive('WXPAY_MCHID');
    const apiV3Key = this.config.get<string>('WXPAY_API_V3_KEY');
    const serialNo = this.pickByActive('WXPAY_SERIAL_NO');
    const privateKeyPath = this.pickByActive('WXPAY_PRIVATE_KEY_PATH');
    if (!mchid) throw new Error('WXPAY_MCHID missing');
    if (!apiV3Key) throw new Error('WXPAY_API_V3_KEY missing');
    if (!serialNo) throw new Error('WXPAY_SERIAL_NO missing');
    if (!privateKeyPath) throw new Error('WXPAY_PRIVATE_KEY_PATH missing');

    let privateKeyPem: string;
    try {
      privateKeyPem = fs.readFileSync(privateKeyPath, 'utf8');
    } catch (err) {
      throw new Error(
        `read WXPAY_PRIVATE_KEY_PATH=${privateKeyPath} failed: ${(err as Error).message}`,
      );
    }
    return { mchid, apiV3Key, serialNo, privateKeyPem };
  }

  /**
   * T14 §2.4：按 WXPAY_MCHID_ACTIVE 派生 ENV
   *
   * 优先 `<base>_<ACTIVE>`，缺则 fallback 旧无后缀 `<base>`（向后兼容）。
   * 与 wxpay-real.client.ts loadConfig 派生策略保持一致。
   */
  private pickByActive(base: string): string | undefined {
    if (!this.config) return undefined;
    const active = this.config.get<string>('WXPAY_MCHID_ACTIVE', 'primary');
    const suffix = active.toUpperCase();
    return (
      this.config.get<string>(`${base}_${suffix}`) ||
      this.config.get<string>(base)
    );
  }
}
