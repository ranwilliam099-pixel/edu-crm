/**
 * ParentSubscriptionService 单元测试
 *
 * USER-AUTH(2026-05-02 台账条目 31 #4): 7 天免费试用 + 9.9/月续费
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  ParentSubscriptionService,
  ParentSubscription,
  PARENT_MONTHLY_PRICE_YUAN,
  PARENT_MONTHLY_SKU,
  TRIAL_DURATION_DAYS,
} from './parent-subscription.service';

const ULID32_S1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMSU1';
const ULID32_P1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMPR1';
const ULID32_O1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMORD';
const ULID32_O2 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMOR2';

describe('ParentSubscriptionService - V10/V11 BE-V10-2 PD §5.1/5.4/5.5 + 条目 31/32', () => {
  let service: ParentSubscriptionService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ParentSubscriptionService],
    }).compile();
    service = module.get<ParentSubscriptionService>(ParentSubscriptionService);
  });

  describe('startTrial - 启动 7 天免费试用（条目 31 #4）', () => {
    it('合法启动 → status=trialing + trial_end=now+7d', () => {
      const now = new Date('2026-05-02T00:00:00Z');
      const sub = service.startTrial({
        subscriptionId: ULID32_S1,
        parentId: ULID32_P1,
        now,
      });
      expect(sub.status).toBe('trialing');
      expect(sub.trialEndAt?.getTime()).toBe(
        now.getTime() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000,
      );
      expect(sub.autoRenew).toBe(true);
    });

    it('subscriptionId 长度非 32 → BadRequestException', () => {
      expect(() =>
        service.startTrial({ subscriptionId: 'short', parentId: ULID32_P1 }),
      ).toThrow(BadRequestException);
    });
  });

  describe('convertTrialToActive - 试用转 9.9/月（cron）', () => {
    it('trialing 状态合法转 active', () => {
      const now = new Date('2026-05-09T00:00:00Z');
      const trialing: ParentSubscription = {
        id: ULID32_S1,
        parentId: ULID32_P1,
        status: 'trialing',
        trialEndAt: now,
        currentPeriodEnd: now,
        autoRenew: true,
        cancelAtPeriodEnd: false,
      };
      const result = service.convertTrialToActive({
        subscription: trialing,
        paymentOrderId: ULID32_O1,
        now,
      });
      expect(result.subscription.status).toBe('active');
      expect(result.paymentOrder.amountYuan).toBe(PARENT_MONTHLY_PRICE_YUAN);
      expect(result.paymentOrder.sku).toBe(PARENT_MONTHLY_SKU);
    });

    it('非 trialing 状态 → BadRequestException', () => {
      const active: ParentSubscription = {
        id: ULID32_S1,
        parentId: ULID32_P1,
        status: 'active',
        autoRenew: true,
        cancelAtPeriodEnd: false,
      };
      expect(() =>
        service.convertTrialToActive({
          subscription: active,
          paymentOrderId: ULID32_O1,
        }),
      ).toThrow(BadRequestException);
    });
  });

  describe('monthlyRenew - 月度续费（cron）', () => {
    const baseActive: ParentSubscription = {
      id: ULID32_S1,
      parentId: ULID32_P1,
      status: 'active',
      currentPeriodEnd: new Date('2026-05-15T00:00:00Z'),
      autoRenew: true,
      cancelAtPeriodEnd: false,
    };

    it('扣款成功 → currentPeriodEnd +30 天 + paymentOrder.status=paid', () => {
      const now = new Date('2026-05-15T00:00:00Z');
      const result = service.monthlyRenew({
        subscription: baseActive,
        paymentOrderId: ULID32_O1,
        paymentSucceeded: true,
        now,
      });
      expect(result.subscription.status).toBe('active');
      expect(result.subscription.currentPeriodEnd?.getTime()).toBe(
        now.getTime() + 30 * 24 * 60 * 60 * 1000,
      );
      expect(result.paymentOrder.status).toBe('paid');
    });

    it('扣款失败 → status=past_due + paymentOrder.status=failed', () => {
      const result = service.monthlyRenew({
        subscription: baseActive,
        paymentOrderId: ULID32_O1,
        paymentSucceeded: false,
      });
      expect(result.subscription.status).toBe('past_due');
      expect(result.paymentOrder.status).toBe('failed');
    });

    it('autoRenew=false 不能续 → BadRequestException', () => {
      expect(() =>
        service.monthlyRenew({
          subscription: { ...baseActive, autoRenew: false },
          paymentOrderId: ULID32_O1,
          paymentSucceeded: true,
        }),
      ).toThrow(BadRequestException);
    });

    it('cancel_at_period_end=true 不能续 → BadRequestException', () => {
      expect(() =>
        service.monthlyRenew({
          subscription: { ...baseActive, cancelAtPeriodEnd: true },
          paymentOrderId: ULID32_O1,
          paymentSucceeded: true,
        }),
      ).toThrow(BadRequestException);
    });

    it('非 active（如 past_due）不能续 → BadRequestException', () => {
      expect(() =>
        service.monthlyRenew({
          subscription: { ...baseActive, status: 'past_due' },
          paymentOrderId: ULID32_O1,
          paymentSucceeded: true,
        }),
      ).toThrow(BadRequestException);
    });
  });

  describe('cancelSubscription - 取消订阅', () => {
    const baseActive: ParentSubscription = {
      id: ULID32_S1,
      parentId: ULID32_P1,
      status: 'active',
      currentPeriodEnd: new Date('2026-05-15T00:00:00Z'),
      autoRenew: true,
      cancelAtPeriodEnd: false,
    };

    it('立即取消 → status=cancelled', () => {
      const result = service.cancelSubscription({
        subscription: baseActive,
        atPeriodEnd: false,
      });
      expect(result.status).toBe('cancelled');
    });

    it('周期结束取消 → cancelAtPeriodEnd=true + autoRenew=false', () => {
      const result = service.cancelSubscription({
        subscription: baseActive,
        atPeriodEnd: true,
      });
      expect(result.cancelAtPeriodEnd).toBe(true);
      expect(result.autoRenew).toBe(false);
      expect(result.status).toBe('active'); // 状态不变直到周期结束
    });

    it('已 cancelled 再取消 → BadRequestException', () => {
      expect(() =>
        service.cancelSubscription({
          subscription: { ...baseActive, status: 'cancelled' },
          atPeriodEnd: false,
        }),
      ).toThrow(BadRequestException);
    });
  });

  describe('canAccessContent / assertCanAccess - ParentReadGuard 核心（P10 + 条目 32 #10）', () => {
    const now = new Date('2026-05-05T00:00:00Z');
    const futureEnd = new Date('2026-05-15T00:00:00Z');
    const pastEnd = new Date('2026-05-01T00:00:00Z');

    it('trialing 期内 → true', () => {
      const sub: ParentSubscription = {
        id: ULID32_S1,
        parentId: ULID32_P1,
        status: 'trialing',
        trialEndAt: futureEnd,
        autoRenew: true,
        cancelAtPeriodEnd: false,
      };
      expect(service.canAccessContent({ subscription: sub, now })).toBe(true);
    });

    it('trialing 已过期 → false', () => {
      const sub: ParentSubscription = {
        id: ULID32_S1,
        parentId: ULID32_P1,
        status: 'trialing',
        trialEndAt: pastEnd,
        autoRenew: true,
        cancelAtPeriodEnd: false,
      };
      expect(service.canAccessContent({ subscription: sub, now })).toBe(false);
    });

    it('active 周期内 → true', () => {
      const sub: ParentSubscription = {
        id: ULID32_S1,
        parentId: ULID32_P1,
        status: 'active',
        currentPeriodEnd: futureEnd,
        autoRenew: true,
        cancelAtPeriodEnd: false,
      };
      expect(service.canAccessContent({ subscription: sub, now })).toBe(true);
    });

    it('past_due → false（条目 32 #10 退订后保留绑定但 403 内容）', () => {
      const sub: ParentSubscription = {
        id: ULID32_S1,
        parentId: ULID32_P1,
        status: 'past_due',
        currentPeriodEnd: pastEnd,
        autoRenew: true,
        cancelAtPeriodEnd: false,
      };
      expect(service.canAccessContent({ subscription: sub, now })).toBe(false);
    });

    it('cancelled → false', () => {
      const sub: ParentSubscription = {
        id: ULID32_S1,
        parentId: ULID32_P1,
        status: 'cancelled',
        autoRenew: false,
        cancelAtPeriodEnd: false,
      };
      expect(service.canAccessContent({ subscription: sub, now })).toBe(false);
    });

    it('subscription undefined（家长未注册订阅）→ false', () => {
      expect(service.canAccessContent({ subscription: undefined, now })).toBe(false);
    });

    it('assertCanAccess 失败 → ForbiddenException(SUBSCRIPTION_REQUIRED)', () => {
      expect(() =>
        service.assertCanAccess({ subscription: undefined, now }),
      ).toThrow(ForbiddenException);
    });

    it('assertCanAccess 通过（trialing 内）→ 不抛', () => {
      const sub: ParentSubscription = {
        id: ULID32_S1,
        parentId: ULID32_P1,
        status: 'trialing',
        trialEndAt: futureEnd,
        autoRenew: true,
        cancelAtPeriodEnd: false,
      };
      expect(() => service.assertCanAccess({ subscription: sub, now })).not.toThrow();
    });
  });
});
