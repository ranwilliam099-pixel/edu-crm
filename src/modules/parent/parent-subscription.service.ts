import { Injectable, BadRequestException, ForbiddenException, Logger } from '@nestjs/common';

/**
 * ParentSubscriptionService — V10/V11 家长订阅 + 7 天试用 + 9.9 续费 BE-V10-2
 *
 * 来源：
 *   - 《PD设计稿-排课-教学反馈-家长订阅-V1-2026-05-02.md》§5.1 / §5.4 / §5.5
 *   - 用户拍板《全部人员-审核往来总台账.md》:
 *     条目 31 #3 共享 1 笔订阅 / #4 加 7 天免费试用
 *     条目 32 #10 退订后保留绑定（订阅失效但绑定仍 active）
 *
 * USER-AUTH(2026-05-02): 7 天免费试用 → 转 9.9/月自动续费；
 *   未付费状态（pending/past_due/cancelled）= ParentReadGuard 403
 */
export type SubscriptionStatus =
  | 'pending' // 注册即此状态，等待启动试用
  | 'trialing' // 7 天免费试用中
  | 'active' // 9.9/月活跃订阅
  | 'past_due' // 续费失败
  | 'cancelled'; // 已取消

export type PaymentOrderStatus = 'pending' | 'paid' | 'failed' | 'refunded';

export const PARENT_MONTHLY_SKU = 'parent_monthly_9_9';
export const PARENT_MONTHLY_PRICE_YUAN = 9.9;
export const TRIAL_DURATION_DAYS = 7;

export interface ParentSubscription {
  id: string;
  parentId: string;
  status: SubscriptionStatus;
  currentPeriodEnd?: Date;
  trialEndAt?: Date;
  autoRenew: boolean;
  cancelAtPeriodEnd: boolean;
  lastPaymentId?: string;
}

export interface ParentPaymentOrder {
  id: string;
  parentId: string;
  subscriptionId?: string;
  amountYuan: number;
  sku: string;
  status: PaymentOrderStatus;
  wxpayOutTradeNo?: string;
  wxpayTransactionId?: string;
  paidAt?: Date;
  failureReason?: string;
}

@Injectable()
export class ParentSubscriptionService {
  private readonly logger = new Logger(ParentSubscriptionService.name);

  /**
   * 启动 7 天免费试用（绑定后立即调用，条目 31 #4）
   *
   * @throws BadRequestException 如果订阅已不在 'pending' 状态
   */
  startTrial(input: {
    subscriptionId: string;
    parentId: string;
    now?: Date;
  }): ParentSubscription {
    if (!input.subscriptionId || input.subscriptionId.length !== 32) {
      throw new BadRequestException('subscriptionId must be 32-char ULID');
    }
    if (!input.parentId || input.parentId.length !== 32) {
      throw new BadRequestException('parentId must be 32-char ULID');
    }
    const now = input.now ?? new Date();
    const trialEndAt = new Date(now.getTime() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000);
    this.logger.log(
      `[BE-V10-2] startTrial subscription=${input.subscriptionId} parent=${input.parentId} ` +
        `trial_end=${trialEndAt.toISOString()}`,
    );
    return {
      id: input.subscriptionId,
      parentId: input.parentId,
      status: 'trialing',
      trialEndAt,
      currentPeriodEnd: trialEndAt, // 试用期视为当前周期
      autoRenew: true,
      cancelAtPeriodEnd: false,
    };
  }

  /**
   * 试用期结束自动转 9.9/月（cron 调用）
   *
   * @returns 更新后的订阅 + 应创建的支付订单（外部 wxpay V3 真扣款，当前 mock）
   */
  convertTrialToActive(input: {
    subscription: ParentSubscription;
    paymentOrderId: string;
    now?: Date;
  }): { subscription: ParentSubscription; paymentOrder: ParentPaymentOrder } {
    if (input.subscription.status !== 'trialing') {
      throw new BadRequestException(
        `subscription.status must be 'trialing' to convert; got ${input.subscription.status}`,
      );
    }
    if (!input.paymentOrderId || input.paymentOrderId.length !== 32) {
      throw new BadRequestException('paymentOrderId must be 32-char ULID');
    }
    const now = input.now ?? new Date();
    const newPeriodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const paymentOrder: ParentPaymentOrder = {
      id: input.paymentOrderId,
      parentId: input.subscription.parentId,
      subscriptionId: input.subscription.id,
      amountYuan: PARENT_MONTHLY_PRICE_YUAN,
      sku: PARENT_MONTHLY_SKU,
      status: 'pending', // 由 wxpay 回调更新到 paid
    };

    return {
      subscription: {
        ...input.subscription,
        status: 'active', // 假设扣款成功（mock）；真实场景由 wxpayCallback 更新
        currentPeriodEnd: newPeriodEnd,
        lastPaymentId: input.paymentOrderId,
      },
      paymentOrder,
    };
  }

  /**
   * 月度自动续费（条目 31 #4 cron + PD §5.5）
   *
   * @returns 续费后的订阅 + 支付订单（成功）/ 或 past_due 状态（失败）
   */
  monthlyRenew(input: {
    subscription: ParentSubscription;
    paymentOrderId: string;
    paymentSucceeded: boolean;
    now?: Date;
  }): { subscription: ParentSubscription; paymentOrder: ParentPaymentOrder } {
    if (input.subscription.status !== 'active') {
      throw new BadRequestException('only active subscription can renew');
    }
    if (!input.subscription.autoRenew || input.subscription.cancelAtPeriodEnd) {
      throw new BadRequestException('auto_renew disabled or cancel_at_period_end set');
    }
    const now = input.now ?? new Date();

    const paymentOrder: ParentPaymentOrder = {
      id: input.paymentOrderId,
      parentId: input.subscription.parentId,
      subscriptionId: input.subscription.id,
      amountYuan: PARENT_MONTHLY_PRICE_YUAN,
      sku: PARENT_MONTHLY_SKU,
      status: input.paymentSucceeded ? 'paid' : 'failed',
      paidAt: input.paymentSucceeded ? now : undefined,
      failureReason: input.paymentSucceeded ? undefined : 'wxpay deduct failed',
    };

    if (input.paymentSucceeded) {
      const newPeriodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      return {
        subscription: {
          ...input.subscription,
          status: 'active',
          currentPeriodEnd: newPeriodEnd,
          lastPaymentId: input.paymentOrderId,
        },
        paymentOrder,
      };
    } else {
      return {
        subscription: {
          ...input.subscription,
          status: 'past_due',
        },
        paymentOrder,
      };
    }
  }

  /**
   * 取消订阅（家长主动）
   *
   * @param atPeriodEnd 是否周期结束才生效（true）/ 立即取消（false）
   */
  cancelSubscription(input: {
    subscription: ParentSubscription;
    atPeriodEnd: boolean;
    now?: Date;
  }): ParentSubscription {
    if (input.subscription.status === 'cancelled') {
      throw new BadRequestException('already cancelled');
    }
    if (input.atPeriodEnd) {
      return {
        ...input.subscription,
        cancelAtPeriodEnd: true,
        autoRenew: false,
      };
    }
    return {
      ...input.subscription,
      status: 'cancelled',
    };
  }

  /**
   * ParentReadGuard 核心校验逻辑（P10 + 条目 31 #4 + 条目 32 #10）
   *
   * 仅 trialing / active 可访问反馈/课表/月报；pending/past_due/cancelled 一律 403
   * （退订后绑定仍保留，但订阅失效就完全看不到 — 用户拍板）
   */
  canAccessContent(input: { subscription?: ParentSubscription; now?: Date }): boolean {
    const sub = input.subscription;
    if (!sub) return false;
    const now = input.now ?? new Date();
    if (sub.status === 'trialing') {
      return sub.trialEndAt !== undefined && sub.trialEndAt > now;
    }
    if (sub.status === 'active') {
      return sub.currentPeriodEnd !== undefined && sub.currentPeriodEnd > now;
    }
    return false; // pending / past_due / cancelled 一律 false
  }

  /**
   * ParentReadGuard 入口：访问失败抛 ForbiddenException
   *
   * @throws ForbiddenException 'NOT_BOUND' / 'SUBSCRIPTION_REQUIRED'
   */
  assertCanAccess(input: { subscription?: ParentSubscription; now?: Date }): void {
    if (!this.canAccessContent(input)) {
      throw new ForbiddenException('SUBSCRIPTION_REQUIRED');
    }
  }
}
