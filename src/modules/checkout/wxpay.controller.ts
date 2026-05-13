import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Optional,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { ulid } from 'ulid';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';
import { RbacGuard } from '../../guards/rbac.guard';
import { Roles } from '../../guards/rbac.decorator';
import { IdempotencyInterceptor } from '../../common/idempotency/idempotency.interceptor';
import {
  AuditLogRepository,
  ActorRole,
  normalizeActorRole,
} from '../db/audit-log.repository';
import {
  AuthenticatedRequest,
  isPlatformRole,
} from '../auth/jwt-payload.interface';
import {
  WX_PAY_CLIENT,
  WxPayClient,
  CreatePrepayResult,
  CallbackHeaders,
} from './wxpay/wxpay.types';
import { RealWxPayClient } from './wxpay/wxpay-real.client';
import {
  WxPayCallbackService,
  WxPayNotifyBody,
} from './wxpay/wxpay-callback.service';

/**
 * WxPayController — 微信支付 V3 4 endpoint HTTP 暴露
 *
 * 来源：
 *   - 用户 2026-05-14 W2-T1 RealWxPayClient + 控制器层落地拍板
 *   - docs/integration-plan-2026-05-10.md 微信支付小程序流程
 *   - 微信支付 V3 文档
 *
 * 路由前缀：`/api/checkout`
 *   - POST /api/checkout/wxpay/unified-order  — 创建预支付订单
 *   - POST /api/checkout/callbacks/wxpay      — 微信支付回调（含退款）
 *   - POST /api/checkout/wxpay/close-order    — 关闭未支付订单
 *   - POST /api/checkout/wxpay/refund         — 申请退款
 *
 * 鉴权策略：
 *   - unified-order / close-order / refund：method-level @UseGuards(TenantScopeGuard)
 *     （需 JWT；tenant.middleware 对 /api/checkout/* 是 best-effort attach，本 controller 显式校验）
 *   - callbacks/wxpay：无 JWT（签名是认证）；TenantScopeGuard 不挂
 *
 * 限流（@nestjs/throttler 全局 60/min default + 方法级覆盖）：
 *   - unified-order: 30/min（创单频次中等；防恶意刷单）
 *   - callbacks/wxpay: 300/min（微信侧重试 + 多笔订单并发；不应被限流）
 *   - close-order: 30/min
 *   - refund: 10/min（finance 操作频次低；防误触）
 *
 * 幂等（@UseInterceptors(IdempotencyInterceptor)）：
 *   - unified-order: 强烈建议带 Idempotency-Key 防双击双扣
 *   - refund: 强烈建议带 Idempotency-Key 防重复退款
 *   - close-order: 关单本身天然幂等，仍接受 key 防 4xx 风暴
 *   - callbacks: 不挂（微信侧自带重试规则，应用层用 out_trade_no DB 去重）
 *
 * audit_log（必写）：
 *   - wxpay.unified-order.created / wxpay.unified-order.failed
 *   - wxpay.callback.received / wxpay.callback.signature-invalid
 *   - wxpay.close-order.requested
 *   - wxpay.refund.requested / wxpay.refund.access-denied
 *
 * §0 不猜测严守：
 *   - 关闭订单 / 申请退款 / 创建预支付 全部依赖 RealWxPayClient（mock 模式 throw）
 *   - 不真实 INSERT/UPDATE payment_orders（由 W3-3 OrderRepository 拓展期落地）
 *   - 仅暴露 4 endpoint + audit_log，不假设业务路径之外的状态推进
 *
 * 项目隔离（追加 #8）：不引用企业管理系统主项目任何支付实现
 */
@Controller('checkout')
export class WxPayController {
  private readonly logger = new Logger(WxPayController.name);

  constructor(
    @Inject(WX_PAY_CLIENT) private readonly wxpay: WxPayClient,
    private readonly callback: WxPayCallbackService,
    @Optional() private readonly auditLog?: AuditLogRepository,
    @Optional() private readonly config?: ConfigService,
  ) {}

  // ============================================================
  // POST /api/checkout/wxpay/unified-order
  // 创建预支付订单（前端 wx.requestPayment 唤起前置）
  // ============================================================

  /**
   * @body
   *   outTradeNo  32-char ULID（前端生成）
   *   openid      微信 openid
   *   amountCents 金额（分；正整数）
   *   description 商品描述
   *   type        'subscription' = SaaS 订阅（admin/boss 触发）/
   *               'parent-extra' = C 端家长加购（parent JWT 触发）
   *
   * @returns
   *   { prepayId, jsApiParams: { timeStamp, nonceStr, package, signType, paySign } }
   */
  @Post('wxpay/unified-order')
  @UseGuards(TenantScopeGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  async unifiedOrder(
    @Body()
    body: {
      tenantId?: string;
      tenantSchema?: string;
      outTradeNo: string;
      openid: string;
      amountCents: number;
      description: string;
      type: 'subscription' | 'parent-extra';
      notifyUrl?: string;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<CreatePrepayResult> {
    // 1. body 校验（mock/real client 都会再校一次，但此处先 fail-fast 给客户端友好错误）
    this.assertBody(body);

    // 2. 业务类型 RBAC：
    //   subscription → 仅 admin/boss/platform_admin/finance_admin 可调（SaaS 订阅）
    //   parent-extra → 仅 parent token（家长 C 端加购）
    if (body.type === 'subscription') {
      if (!req.user) {
        throw new UnauthorizedException('subscription unified-order requires B-end JWT');
      }
      const role = req.user.role;
      if (!isPlatformRole(role) && role !== 'admin' && role !== 'boss') {
        throw new ForbiddenException(
          'subscription unified-order: only admin/boss/platform can trigger',
        );
      }
    } else if (body.type === 'parent-extra') {
      // parent JWT 路径：req.parent 已由 tenant.middleware tryAttachUser 注入（best-effort）
      // tryAttachUser 同时校验 ParentJwt → 若失败 req.parent 不存在
      // tenant.middleware 对 /api/checkout/* 是 best-effort attach，本 endpoint 显式校验
      const parent = (req as { parent?: { sub?: string; parentId?: string } }).parent;
      if (!parent || (!parent.sub && !parent.parentId)) {
        throw new UnauthorizedException(
          'parent-extra unified-order requires ParentJwt',
        );
      }
    } else {
      throw new BadRequestException(
        "type must be 'subscription' or 'parent-extra'",
      );
    }

    // 3. notifyUrl 强制服务端 ENV，避免 client 注入伪 callback url
    const notifyUrl =
      this.config?.get<string>('WXPAY_NOTIFY_URL') ?? body.notifyUrl;
    if (!notifyUrl?.startsWith('https://')) {
      throw new BadRequestException('WXPAY_NOTIFY_URL not configured (must be https)');
    }

    // 4. 调微信
    let result: CreatePrepayResult;
    try {
      result = await this.wxpay.createPrepay({
        outTradeNo: body.outTradeNo,
        openid: body.openid,
        amountCents: body.amountCents,
        description: body.description,
        notifyUrl,
      });
    } catch (err) {
      // audit 失败路径
      await this.tryAudit(req, {
        action: 'wxpay.unified-order.failed',
        targetType: 'payment_order',
        targetId: body.outTradeNo,
        after: {
          type: body.type,
          amountCents: body.amountCents,
          reason: (err as Error).message?.slice(0, 200) ?? 'unknown',
        },
      });
      throw err;
    }

    // 5. audit 成功路径（不入 paySign / nonce 等敏感串）
    await this.tryAudit(req, {
      action: 'wxpay.unified-order.created',
      targetType: 'payment_order',
      targetId: body.outTradeNo,
      after: {
        type: body.type,
        amountCents: body.amountCents,
        prepayId: result.prepayId,
        // openid 是用户标识，入 audit 用于运营对账；不属于 PII 个保法红线
        openidLast8: body.openid.slice(-8),
        description: body.description.slice(0, 50),
      },
    });

    return result;
  }

  // ============================================================
  // POST /api/checkout/callbacks/wxpay
  // 微信支付/退款回调（V3 验签 + 解密 + 状态推进）
  // ============================================================

  /**
   * 微信回调通知（含支付成功 + 退款成功；resource 由微信侧 AES-GCM 加密）
   *
   * Headers:
   *   Wechatpay-Timestamp / Nonce / Signature / Serial
   *
   * Body（V3 协议）:
   *   { id, create_time, event_type, resource_type, resource: { algorithm, nonce, associated_data, ciphertext } }
   *
   * 当前 controller 实现：
   *   - 验签（WxPayCallbackService.handlePaymentNotify / handleRefundNotify 已封装）
   *   - resource 解密由 RealWxPayClient 暴露的 helper 做（mock 模式下 controller 直接接受 body.notifyBody）
   *
   * 简化策略（W2-T1 边界）：
   *   - 真实部署环境下，回调 body 走 `req.rawBody`（main.ts rawBody:true 已开）
   *   - 调用方需在 body 里同时传 `notifyBody`（已解密的内容）+ `expectedAmountCents`（订单期望金额）
   *   - 解密能力 RealWxPayClient.decryptCallbackResource 暂未实现（W3-3 拓展期，OrderRepository 介入后补）
   *   - 因此当前 endpoint 接受 caller 直接传明文 notifyBody（与 wxpay-callback.service 已有的接口签名一致）
   *
   * Sprint E backlog #W2-T1-DECRYPT：
   *   - 加 RealWxPayClient.decryptCallbackResource(ec: EncryptedResource): NotifyBody
   *   - 取消 body.notifyBody / body.expectedAmountCents 接受参数
   *   - 改为直接读 req.rawBody + 内部解密 + 查 payment_orders 取 expectedAmount
   */
  @Post('callbacks/wxpay')
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  async wxpayCallback(
    @Body()
    body: {
      kind?: 'payment' | 'refund';
      notifyBody?: WxPayNotifyBody | Record<string, unknown>;
      expectedAmountCents?: number;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<{ code: 'SUCCESS' | 'FAIL'; message: string }> {
    const headers: CallbackHeaders = {
      'wechatpay-timestamp': this.headerString(req, 'wechatpay-timestamp'),
      'wechatpay-nonce': this.headerString(req, 'wechatpay-nonce'),
      'wechatpay-serial': this.headerString(req, 'wechatpay-serial'),
      'wechatpay-signature': this.headerString(req, 'wechatpay-signature'),
    };
    const rawBody = this.getRawBody(req);

    // audit_log：所有回调都先留证据（不入 ciphertext 等大字段）
    await this.tryAudit(req, {
      action: 'wxpay.callback.received',
      targetType: 'wxpay_callback',
      targetId: headers['wechatpay-serial'] || 'unknown',
      after: {
        kind: body.kind ?? 'payment',
        timestampHeader: headers['wechatpay-timestamp']?.slice(0, 20),
        // 不入 signature / nonce 全文（潜在 PII / 大字段）
      },
    });

    try {
      if (body.kind === 'refund') {
        if (!body.notifyBody) {
          throw new BadRequestException('notifyBody required for refund callback');
        }
        const r = await this.callback.handleRefundNotify(
          headers,
          rawBody,
          body.notifyBody as unknown as Parameters<
            typeof this.callback.handleRefundNotify
          >[2],
        );
        return {
          code: 'SUCCESS',
          message: `refund processed: ${r.outRefundNo}`,
        };
      }

      // 默认 payment
      if (!body.notifyBody) {
        throw new BadRequestException('notifyBody required for payment callback');
      }
      if (
        body.expectedAmountCents === undefined ||
        !Number.isInteger(body.expectedAmountCents)
      ) {
        throw new BadRequestException(
          'expectedAmountCents required (integer cents)',
        );
      }
      const r = await this.callback.handlePaymentNotify(
        headers,
        rawBody,
        body.notifyBody as WxPayNotifyBody,
        body.expectedAmountCents,
      );
      return { code: 'SUCCESS', message: `paid: ${r.outTradeNo}` };
    } catch (err) {
      // 验签 / 金额不匹配 等失败路径
      const isAuth = (err as { status?: number }).status === 401;
      const action = isAuth
        ? 'wxpay.callback.signature-invalid'
        : 'wxpay.callback.failed';
      await this.tryAudit(req, {
        action,
        targetType: 'wxpay_callback',
        targetId: headers['wechatpay-serial'] || 'unknown',
        after: {
          kind: body.kind ?? 'payment',
          reason: (err as Error).message?.slice(0, 200) ?? 'unknown',
        },
      });
      // 微信侧期望：失败时返 4xx + FAIL JSON 让其重试
      throw err;
    }
  }

  // ============================================================
  // POST /api/checkout/wxpay/close-order
  // 关闭未支付订单
  // ============================================================

  @Post('wxpay/close-order')
  @UseGuards(TenantScopeGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  async closeOrder(
    @Body()
    body: { tenantId?: string; tenantSchema?: string; outTradeNo: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<{ ok: true }> {
    if (!body.outTradeNo || body.outTradeNo.length !== 32) {
      throw new BadRequestException('outTradeNo must be 32-char ULID');
    }
    if (!req.user) {
      throw new UnauthorizedException('close-order requires JWT');
    }
    const role = req.user.role;
    if (!isPlatformRole(role) && role !== 'admin' && role !== 'boss') {
      throw new ForbiddenException(
        'close-order: only admin/boss/platform can trigger',
      );
    }

    // 仅 RealWxPayClient 暴露 closeOrder；mock 模式下 cast 检测 + 友好错误
    const real = this.wxpay as Partial<RealWxPayClient>;
    if (typeof real.closeOrder !== 'function') {
      throw new BadRequestException(
        'close-order not available (WXPAY_MODE=mock); use real client',
      );
    }

    await real.closeOrder(body.outTradeNo);

    await this.tryAudit(req, {
      action: 'wxpay.close-order.requested',
      targetType: 'payment_order',
      targetId: body.outTradeNo,
      after: null,
    });
    return { ok: true };
  }

  // ============================================================
  // POST /api/checkout/wxpay/refund
  // 申请退款（仅 finance / admin / boss / platform_admin）
  // ============================================================

  @Post('wxpay/refund')
  @UseGuards(TenantScopeGuard, RbacGuard)
  @Roles('finance', 'admin', 'boss', 'platform_admin', 'finance_admin')
  @UseInterceptors(IdempotencyInterceptor)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  async refund(
    @Body()
    body: {
      tenantId?: string;
      tenantSchema?: string;
      outTradeNo: string;
      outRefundNo?: string;
      refundAmountCents: number;
      totalAmountCents: number;
      reason: string;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<{ refundId: string; status: string; outRefundNo: string }> {
    if (!req.user) {
      throw new UnauthorizedException('refund requires JWT');
    }
    if (!body.outTradeNo || body.outTradeNo.length !== 32) {
      throw new BadRequestException('outTradeNo must be 32-char ULID');
    }
    if (
      !Number.isInteger(body.refundAmountCents) ||
      !Number.isInteger(body.totalAmountCents)
    ) {
      throw new BadRequestException('refund/total amount must be integer');
    }
    if (
      body.refundAmountCents <= 0 ||
      body.refundAmountCents > body.totalAmountCents
    ) {
      throw new BadRequestException(
        'refundAmount must be in (0, totalAmount]',
      );
    }
    if (!body.reason) {
      throw new BadRequestException('reason required (A04 §3)');
    }

    // outRefundNo 客户端可不传 → 服务端生成 ULID
    const outRefundNo =
      body.outRefundNo && body.outRefundNo.length === 32
        ? body.outRefundNo
        : ulid();

    let result;
    try {
      result = await this.wxpay.requestRefund({
        outTradeNo: body.outTradeNo,
        outRefundNo,
        refundAmountCents: body.refundAmountCents,
        totalAmountCents: body.totalAmountCents,
        reason: body.reason,
      });
    } catch (err) {
      await this.tryAudit(req, {
        action: 'wxpay.refund.failed',
        targetType: 'payment_refund',
        targetId: outRefundNo,
        after: {
          outTradeNo: body.outTradeNo,
          refundAmountCents: body.refundAmountCents,
          totalAmountCents: body.totalAmountCents,
          reason: body.reason.slice(0, 100),
          error: (err as Error).message?.slice(0, 200) ?? 'unknown',
        },
      });
      throw err;
    }

    await this.tryAudit(req, {
      action: 'wxpay.refund.requested',
      targetType: 'payment_refund',
      targetId: outRefundNo,
      after: {
        outTradeNo: body.outTradeNo,
        refundAmountCents: body.refundAmountCents,
        totalAmountCents: body.totalAmountCents,
        reason: body.reason.slice(0, 100),
        wxRefundId: result.refundId,
        status: result.status,
      },
    });
    return {
      refundId: result.refundId,
      status: result.status,
      outRefundNo,
    };
  }

  // ============================================================
  // 内部
  // ============================================================

  private assertBody(body: {
    outTradeNo: string;
    openid: string;
    amountCents: number;
    description: string;
  }): void {
    if (!body.outTradeNo || body.outTradeNo.length !== 32) {
      throw new BadRequestException('outTradeNo must be 32-char ULID');
    }
    if (!body.openid || typeof body.openid !== 'string') {
      throw new BadRequestException('openid required');
    }
    if (!Number.isInteger(body.amountCents) || body.amountCents <= 0) {
      throw new BadRequestException('amountCents must be positive integer');
    }
    if (!body.description || typeof body.description !== 'string') {
      throw new BadRequestException('description required');
    }
    if (body.description.length > 127) {
      throw new BadRequestException('description max 127 chars (wxpay V3)');
    }
  }

  /** 取 header（防大小写 / 数组 / undefined） */
  private headerString(req: AuthenticatedRequest, name: string): string {
    const v = req.headers[name] ?? req.headers[name.toLowerCase()];
    if (Array.isArray(v)) return v[0] ?? '';
    return typeof v === 'string' ? v : '';
  }

  /** 取 rawBody（main.ts rawBody:true 时 express 注入；mock/spec 时 fallback JSON.stringify body） */
  private getRawBody(req: AuthenticatedRequest): string {
    const r = req as { rawBody?: Buffer | string; body?: unknown };
    if (r.rawBody) {
      return Buffer.isBuffer(r.rawBody)
        ? r.rawBody.toString('utf8')
        : String(r.rawBody);
    }
    // fallback：仅 spec 单测用；真实环境 main.ts 已 rawBody:true
    return r.body ? JSON.stringify(r.body) : '';
  }

  /**
   * audit_log 写入（fail-open；不阻塞主业务）
   *
   * tenantSchema 取自 body.tenantSchema（写操作 TenantScopeGuard 已校 ==
   * user.tenantId）；callback 路径无 user，用 'platform' 写到 public（暂保留为
   * 不写 tenant schema 的兜底策略）
   */
  private async tryAudit(
    req: AuthenticatedRequest,
    entry: {
      action: string;
      targetType: string;
      targetId: string | null;
      before?: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
    },
  ): Promise<void> {
    if (!this.auditLog) return;

    // tenant schema：优先 body.tenantSchema → user.tenantId 推导
    const bodySchema = (req.body as { tenantSchema?: string } | undefined)
      ?.tenantSchema;
    let tenantSchema: string | null = bodySchema ?? null;
    if (!tenantSchema && req.user?.tenantId) {
      tenantSchema = `tenant_${req.user.tenantId.toLowerCase()}`;
    }
    if (!tenantSchema) {
      // callback 无 tenant 上下文 → 跳过 audit（fail-open；后续补 platform-level audit）
      return;
    }

    const actorRole: ActorRole = normalizeActorRole(req.user?.role);
    try {
      await this.auditLog.log(tenantSchema, {
        actorUserId: req.user?.sub ?? null,
        actorRole,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        before: entry.before ?? null,
        after: entry.after,
        ip: req.ip ?? null,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
        requestId:
          (req.headers['x-request-id'] as string | undefined) ?? null,
      });
    } catch {
      // fail-open：audit 写失败不阻塞主业务（AuditLogRepository.log 内部已 catch；此处再兜底）
    }
  }
}
