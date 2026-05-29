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
import { SubscriptionRepository } from '../db/subscription.repository';
import { PromotionRepository } from '../db/promotion.repository';
import { PromotionQuotaService } from '../db/promotion-quota.service';
import { Throttle } from '@nestjs/throttler';
import { ulid } from 'ulid';
import * as crypto from 'crypto';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';
import { RbacGuard } from '../../guards/rbac.guard';
import { Roles } from '../../guards/rbac.decorator';
import { IdempotencyInterceptor } from '../../common/idempotency/idempotency.interceptor';
import {
  AuditLogRepository,
  ActorRole,
  normalizeActorRole,
} from '../db/audit-log.repository';
import { PgPoolService } from '../db/pg-pool.service';
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
    // T9-EPIC(2026-05-16) §6.3：付款成功 → UPDATE public.tenants 解锁订阅
    //   @Optional 兼容 spec / 单测可 new 不传（与 auditLog 同 fail-open 哲学）
    @Optional() private readonly pg?: PgPoolService,
    // 2026-05-29 §12C.5: subscription 服务端权威定价（DbModule @Global，@Optional 兼容 spec）
    @Optional() private readonly subscriptionRepo?: SubscriptionRepository,
    // 2026-05-29 §12C.5: 付款时自动匹配折扣（前 N 位自动 N 折，与输码共用名额池）
    @Optional() private readonly promotionRepo?: PromotionRepository,
    @Optional() private readonly promotionQuota?: PromotionQuotaService,
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
      // 2026-05-29 全面检测：删 notifyUrl 死字段（已不再回退客户端值，防未来误用注入回调 url）
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
      // T9-EPIC round 2 (2026-05-16 security audit P0): 跨 tenant 支付构造攻击 defense-in-depth
      //   前端 URL 参数 body.tenantId 不可信，攻击者 admin from tenant A 可
      //   body.tenantId=TENANT_B_ID 构造 prepay 单跨 tenant 创建付款单
      //
      //   T-DEPLOY-FIX-1 round 2 注释修正 (2026-05-16 pr-code-reviewer I-1)：
      //   TenantScopeGuard (tenant-scope.guard.ts:70-79) 已校验 body.tenantId === user.tenantId
      //   平台敏感金融操作 defense-in-depth 双层校验（5/10 P0 拍板「跨租户隔离硬红线」）
      //   platform role 豁免（运维场景需为多 tenant 创建付款，与 TenantScopeGuard L58 一致）
      if (!isPlatformRole(role) && body.tenantId && req.user.tenantId !== body.tenantId) {
        throw new ForbiddenException(
          'subscription unified-order: body.tenantId must match JWT user.tenantId',
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
    //   2026-05-29 全面检测 P0: 删 `?? body.notifyUrl` 回退 —— 注释说"避免 client 注入"但原代码
    //   在 config 缺失时回退到客户端值（自相矛盾）。改为：缺 ENV 直接抛，绝不用客户端传入的 url。
    const notifyUrl = this.config?.get<string>('WXPAY_NOTIFY_URL');
    if (!notifyUrl?.startsWith('https://')) {
      throw new BadRequestException('WXPAY_NOTIFY_URL not configured (must be https)');
    }

    // 4. 调微信
    //   T9-FU-1 (2026-05-16)：subscription 路径透传 req.user.tenantId 到 V3 attach
    //     非 platform 路径：body.tenantId 已 owner-check (L162-166) == req.user.tenantId,
    //                     用 JWT 来源消除「body 不可信」攻击面
    //     parent-extra 路径：不传 attach（家长跨 tenant 加购，attach 不适用）
    //     platform 路径：req.user.tenantId 可能 null → attach 不传 →
    //                   callback UPDATE 跳过（attach 缺失 → log warn）→
    //                   留 T9-FU-2 backlog（platform 代付场景 OrderRepository W3-3 介入后用 outTradeNo 反查）
    // 2026-05-29 §12C.5 P0-3: subscription 服务端权威定价 —— 不信前端 amountCents（防篡改）。
    //   按租户 plan + 已配折扣服务端重算（与升级页同源 SubscriptionRepository.getCurrent.actualPriceYuan：
    //   promotion_price_yuan ?? PLAN_META 基价）。fail-closed：取不到定价能力 / tenantId → 拒绝，绝不回退客户端金额。
    let chargeAmountCents = body.amountCents;
    if (body.type === 'subscription') {
      const pricingTenantId = req.user?.tenantId ?? body.tenantId;
      if (!this.subscriptionRepo || !pricingTenantId) {
        throw new BadRequestException('subscription pricing unavailable (server-side)');
      }
      let cur = await this.subscriptionRepo.getCurrent(pricingTenantId);
      // 2026-05-29 §12C.5 自动匹配：租户无生效促销时，付款自动抢一个「无码」折扣档（与输码共用名额）。
      //   best-effort fail-open：抢不到（名额满 / 已锁 reserved|committed / 无匹配 / 并发）→ 原价，绝不阻断付款。
      if (this.promotionRepo && this.promotionQuota) {
        try {
          const auto = await this.promotionRepo.findBestAutoPromotion(cur.planTier);
          if (auto) {
            await this.promotionQuota.reserveQuota(pricingTenantId, auto.code, {
              operatorId: req.user?.sub || undefined,
              operatorRole: 'auto_checkout',
            });
            cur = await this.subscriptionRepo.getCurrent(pricingTenantId); // 重读：反映已抢到的折扣价
          }
        } catch {
          /* 名额满 / 已锁 / 无匹配 / 并发失败 → 用 cur 现价（不打折），不阻断付款 */
        }
      }
      chargeAmountCents = Math.round(cur.actualPriceYuan * 100);
    }

    let result: CreatePrepayResult;
    try {
      result = await this.wxpay.createPrepay({
        outTradeNo: body.outTradeNo,
        openid: body.openid,
        amountCents: chargeAmountCents,
        description: body.description,
        notifyUrl,
        tenantId:
          body.type === 'subscription'
            ? (req.user?.tenantId ?? undefined)
            : undefined,
      });
    } catch (err) {
      // audit 失败路径
      //   T9-FU-1 round 2 (2026-05-16 3 审共识 finding)：subscription 类型 audit
      //   after 加 tenantId（来自 JWT，运营对账时不需要 JOIN auditor->user 表）
      //   parent-extra 类型 tenantId 永远 null（家长跨 tenant，与现有 actorUserId=null 一致）
      await this.tryAudit(req, {
        action: 'wxpay.unified-order.failed',
        targetType: 'payment_order',
        targetId: body.outTradeNo,
        after: {
          type: body.type,
          amountCents: chargeAmountCents,
          tenantId: req.user?.tenantId ?? null,
          reason: (err as Error).message?.slice(0, 200) ?? 'unknown',
        },
      });
      throw err;
    }

    // 5. audit 成功路径（不入 paySign / nonce 等敏感串）
    //   T9-FU-1 round 2 (2026-05-16 3 审共识 finding)：加 tenantId 字段增强对账
    await this.tryAudit(req, {
      action: 'wxpay.unified-order.created',
      targetType: 'payment_order',
      targetId: body.outTradeNo,
      after: {
        type: body.type,
        amountCents: chargeAmountCents,
        tenantId: req.user?.tenantId ?? null,
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
      // V3 原生协议字段（微信直接传）
      id?: string;
      create_time?: string;
      event_type?: string;
      resource_type?: string;
      resource?: {
        algorithm?: string;
        ciphertext?: string;
        associated_data?: string;
        nonce?: string;
      };
      // 旧 wrapper 协议字段（mock 测试用，向后兼容）
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

    // ============================================================
    // V3 原生协议分支（5/14 凌晨 04:30 修：微信回调 resource.ciphertext 直传）
    // ============================================================
    if (body && body.resource && typeof body.resource.ciphertext === 'string') {
      try {
        // 1. 验签
        const valid = await this.wxpay.verifyCallbackSignature(headers, rawBody);
        if (!valid) {
          await this.tryAudit(req, {
            action: 'wxpay.callback.signature-invalid',
            targetType: 'wxpay_callback',
            targetId: headers['wechatpay-serial'] || 'unknown',
            after: { event_type: body.event_type, id: body.id },
          });
          this.logger.warn(
            `[wxpay V3 callback] signature invalid serial=${headers['wechatpay-serial']}`,
          );
          return { code: 'FAIL', message: 'signature invalid' };
        }

        // 2. AES-256-GCM 解密 resource
        const decrypted = this.decryptV3Resource(body.resource);
        const tradeState = (decrypted as Record<string, unknown>).trade_state as string | undefined;
        const outTradeNo = (decrypted as Record<string, unknown>).out_trade_no as string | undefined;
        const amount = (decrypted as { amount?: { total?: number } }).amount;
        const transactionId = (decrypted as Record<string, unknown>).transaction_id as string | undefined;

        // 3. audit_log 记录成功回调
        await this.tryAudit(req, {
          action: 'wxpay.callback.received',
          targetType: 'payment_order',
          targetId: outTradeNo || 'unknown',
          after: {
            event_type: body.event_type,
            trade_state: tradeState,
            amount_total: amount?.total,
            transaction_id: transactionId,
            wxpay_id: body.id,
          },
        });

        this.logger.log(
          `[wxpay V3 callback] SUCCESS out_trade_no=${outTradeNo} trade_state=${tradeState} amount=${amount?.total} txn=${transactionId}`,
        );

        // 4. T9-EPIC(2026-05-16) §6.3：trade_state=SUCCESS → subscription_status='active'
        //   tenantId 来源（按优先级，遵循 spec §6.3 SQL 用 $1=tenantId）：
        //     a) decrypted.attach (V3 协议允许业务侧 携带, prepay 时设置)
        //     b) attach 缺失 → 跳过 UPDATE（OrderRepository W3-3 落地后由 outTradeNo 反查，T9-FU-2 backlog）
        //
        //   T-DEPLOY-FIX-1 round 2 (2026-05-16 silent-failure-hunter F-1 + user 拍板决策 #1)：
        //   行为分级（PG fail-close vs attach 缺失 fail-open 区分）：
        //     - PG UPDATE 抛错（transient: 连接 / 死锁 / 超时）→ 返 FAIL，微信重试 4 次自愈
        //       理由：5/10 P0 「PG 是核心数据源」/ 微信 V3 协议原生支持回调重试 (15s/15s/30s/3m/10m...)
        //       理由：付款成功是商业 source-of-truth，silent skip = 用户付款无效化 + 14d 后被锁
        //     - attach 缺失（deterministic: platform_admin 路径 / 旧订单回滚）→ 返 SUCCESS skip
        //       理由：永远重试也无 attach，T9-FU-2 (OrderRepository) 落地后由 outTradeNo 反查兜底
        if (tradeState === 'SUCCESS' && this.pg) {
          const attach = (decrypted as Record<string, unknown>).attach as string | undefined;
          const tenantId =
            typeof attach === 'string' && attach.length === 32 ? attach : null;
          if (tenantId) {
            try {
              await this.pg.query(
                `UPDATE public.tenants
                    SET subscription_status='active',
                        subscribed_until=GREATEST(COALESCE(subscribed_until, NOW()), NOW())
                                          + INTERVAL '365 days'
                  WHERE id = $1`,
                [tenantId],
              );
              this.logger.log(
                `[wxpay V3 callback] tenant ${tenantId} subscription -> active (365d)`,
              );
            } catch (e) {
              // T-DEPLOY-FIX-1 fail-close 改造：PG UPDATE 抛错 → 返 FAIL 触发微信重试
              const errMsg = (e as Error).message;
              this.logger.error(
                `[wxpay V3 callback] subscription UPDATE PG failed tenant=${tenantId}: ${errMsg} — returning FAIL for WeChat retry`,
              );
              await this.tryAudit(req, {
                action: 'wxpay.callback.subscription-update-failed',
                targetType: 'payment_order',
                targetId: outTradeNo || 'unknown',
                after: {
                  tenantId,
                  reason: errMsg.slice(0, 200),
                  trade_state: tradeState,
                },
              });
              return { code: 'FAIL', message: 'subscription UPDATE failed, please retry' };
            }
          } else {
            // attach 缺失 = T9-FU-2 backlog（platform / parent-extra 路径），永远重试也无 attach
            this.logger.warn(
              `[wxpay V3 callback] attach missing / not 32-ULID, skip subscription UPDATE out_trade_no=${outTradeNo}`,
            );
          }
        }

        // 5. 沙箱期间 OrderRepository 真持久化 W3-3 落地
        //    微信侧重试机制：返 code: SUCCESS 即停止重试
        return { code: 'SUCCESS', message: '成功' };
      } catch (err) {
        const msg = (err as Error).message || 'V3 callback error';
        this.logger.error(`[wxpay V3 callback] failed: ${msg}`);
        await this.tryAudit(req, {
          action: 'wxpay.callback.error',
          targetType: 'wxpay_callback',
          targetId: body.id || headers['wechatpay-serial'] || 'unknown',
          after: { error: msg.slice(0, 200) },
        });
        // 错误也返 FAIL（微信会重试，但我们后端 OK），不抛 4xx 防止微信告警
        return { code: 'FAIL', message: 'callback processing error' };
      }
    }

    // ============================================================
    // 旧 wrapper 协议（mock 测试用，向后兼容）
    // ============================================================

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
   * AES-256-GCM 解密微信 V3 callback resource
   *
   * 来源：微信支付 V3 协议 — 回调通知的 resource 字段
   *   https://pay.weixin.qq.com/wiki/doc/apiv3/wechatpay/wechatpay4_2.shtml
   *
   * 算法：
   *   - key = APIv3 密钥 (32 字节 UTF-8)
   *   - nonce = 12 字节 UTF-8（来自 resource.nonce）
   *   - associated_data = resource.associated_data（用作 AAD）
   *   - ciphertext = base64(encrypted_data || auth_tag[16 字节后缀])
   */
  private decryptV3Resource(resource: {
    algorithm?: string;
    ciphertext?: string;
    associated_data?: string;
    nonce?: string;
  }): Record<string, unknown> {
    if (!resource.ciphertext || !resource.nonce) {
      throw new BadRequestException('V3 resource missing ciphertext/nonce');
    }
    const apiv3Key = this.config?.getOrThrow<string>('WXPAY_API_V3_KEY');
    if (!apiv3Key || apiv3Key.length !== 32) {
      throw new Error('WXPAY_API_V3_KEY missing or not 32 chars');
    }

    const ciphertext = Buffer.from(resource.ciphertext, 'base64');
    // 微信 V3 ciphertext = encrypted_data + auth_tag (16 字节后缀)
    if (ciphertext.length < 16) {
      throw new BadRequestException('V3 resource ciphertext too short');
    }
    const authTag = ciphertext.subarray(ciphertext.length - 16);
    const encryptedData = ciphertext.subarray(0, ciphertext.length - 16);

    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      Buffer.from(apiv3Key, 'utf8'),
      Buffer.from(resource.nonce, 'utf8'),
    );
    decipher.setAuthTag(authTag);
    if (resource.associated_data) {
      decipher.setAAD(Buffer.from(resource.associated_data, 'utf8'));
    }
    const decrypted = Buffer.concat([
      decipher.update(encryptedData),
      decipher.final(),
    ]);
    return JSON.parse(decrypted.toString('utf8')) as Record<string, unknown>;
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
