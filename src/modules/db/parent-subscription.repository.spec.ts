/**
 * parent-subscription.repository.spec.ts (V10 C 端家长订阅 + 支付订单持久化 — 5/20 stryker 0% coverage 修补)
 *
 * 来源：5/20 stryker mutation 跑出 parent-subscription.repository 64 mutant 全 no-cov
 *   → 该 repository 是 C 端付费订阅 + 微信支付订单核心（V10/V11 BE-V10-2）
 *   → 5/14 wxpay V3 全链路上线后真实涉及钱（订单 sku/amount/status/wxpay_*）
 *   → 同 audit_log + business-metrics silent fail 模式（核心代码上线后从未单测）
 *
 * 范围（covers 64 mutant / 147 行）：
 *   - upsertSubscription happy + mapRow null 字段保护
 *   - findByParent 0 行 → null / 1 行 → mapped
 *   - listExpiredTrials happy + 时间窗 SQL 参数验证
 *   - listDueSubscriptions happy + WHERE 条件 SQL 验证
 *   - insertPaymentOrder happy + null 字段保护（subscriptionId/wxpayOutTradeNo 等）
 *   - listOrdersForParent happy + LIMIT 50 + ORDER BY created_at DESC
 *   - mapRow / mapOrderRow null-coalesce → undefined（兼容 PG NULL）
 *   - amount_yuan 字符串 → Number 转换（PG numeric 字段）
 *
 * 注：pg.query 是 public schema 直查（订阅/订单都在 public，非 tenant schema）
 */

import { Test } from '@nestjs/testing';
import { ParentSubscriptionRepository } from './parent-subscription.repository';
import { PgPoolService } from './pg-pool.service';
import {
  ParentSubscription,
  ParentPaymentOrder,
} from '../parent/parent-subscription.service';

describe('ParentSubscriptionRepository (5/20 stryker no-cov 修补 — C 端付费订阅 + 支付订单)', () => {
  let repo: ParentSubscriptionRepository;
  let pg: { query: jest.Mock; tenantQuery: jest.Mock; withClient: jest.Mock };

  const SUB_ID = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMSU1';
  const PARENT_ID = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMPR1';
  const ORDER_ID = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMORD';
  const PERIOD_END = new Date('2026-06-01T00:00:00.000Z');
  const TRIAL_END = new Date('2026-05-09T00:00:00.000Z');
  const PAID_AT = new Date('2026-05-15T10:00:00.000Z');

  beforeEach(async () => {
    pg = {
      query: jest.fn(),
      tenantQuery: jest.fn(),
      withClient: jest.fn(),
    };
    const m = await Test.createTestingModule({
      providers: [
        ParentSubscriptionRepository,
        { provide: PgPoolService, useValue: pg },
      ],
    }).compile();
    repo = m.get(ParentSubscriptionRepository);
  });

  // ============================================================
  // upsertSubscription
  // ============================================================
  describe('upsertSubscription()', () => {
    const SUB: ParentSubscription = {
      id: SUB_ID,
      parentId: PARENT_ID,
      status: 'trialing',
      currentPeriodEnd: PERIOD_END,
      trialEndAt: TRIAL_END,
      autoRenew: true,
      cancelAtPeriodEnd: false,
      lastPaymentId: ORDER_ID,
    };

    it('case-1: happy path — 调 pg.query 1 次 + 返回 mapped ParentSubscription', async () => {
      pg.query.mockResolvedValueOnce([
        {
          id: SUB_ID,
          parent_id: PARENT_ID,
          status: 'trialing',
          current_period_end: PERIOD_END,
          trial_end_at: TRIAL_END,
          auto_renew: true,
          cancel_at_period_end: false,
          last_payment_id: ORDER_ID,
        },
      ]);
      const result = await repo.upsertSubscription(SUB);

      expect(pg.query).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        id: SUB_ID,
        parentId: PARENT_ID,
        status: 'trialing',
        currentPeriodEnd: PERIOD_END,
        trialEndAt: TRIAL_END,
        autoRenew: true,
        cancelAtPeriodEnd: false,
        lastPaymentId: ORDER_ID,
      });
    });

    it('case-2: SQL = INSERT ... ON CONFLICT (parent_id) DO UPDATE + RETURNING 关键列', async () => {
      pg.query.mockResolvedValueOnce([
        {
          id: SUB_ID,
          parent_id: PARENT_ID,
          status: 'active',
          current_period_end: PERIOD_END,
          trial_end_at: null,
          auto_renew: true,
          cancel_at_period_end: false,
          last_payment_id: null,
        },
      ]);
      await repo.upsertSubscription({ ...SUB, status: 'active' });

      const [sql, params] = pg.query.mock.calls[0];
      expect(sql).toMatch(/INSERT INTO public\.parent_subscriptions/);
      expect(sql).toMatch(/ON CONFLICT \(parent_id\) DO UPDATE/);
      expect(sql).toMatch(/RETURNING/);
      expect(params).toEqual([
        SUB_ID,
        PARENT_ID,
        'active',
        PERIOD_END,
        TRIAL_END,
        true,
        false,
        ORDER_ID,
      ]);
    });

    it('case-3: currentPeriodEnd / trialEndAt / lastPaymentId 为 undefined → 占位 NULL', async () => {
      pg.query.mockResolvedValueOnce([
        {
          id: SUB_ID,
          parent_id: PARENT_ID,
          status: 'pending',
          current_period_end: null,
          trial_end_at: null,
          auto_renew: false,
          cancel_at_period_end: false,
          last_payment_id: null,
        },
      ]);
      await repo.upsertSubscription({
        id: SUB_ID,
        parentId: PARENT_ID,
        status: 'pending',
        autoRenew: false,
        cancelAtPeriodEnd: false,
      });

      const params = pg.query.mock.calls[0][1];
      expect(params[3]).toBeNull(); // current_period_end
      expect(params[4]).toBeNull(); // trial_end_at
      expect(params[7]).toBeNull(); // last_payment_id
    });

    it('case-4: mapRow — null current_period_end → undefined（兼容 PG NULL）', async () => {
      pg.query.mockResolvedValueOnce([
        {
          id: SUB_ID,
          parent_id: PARENT_ID,
          status: 'cancelled',
          current_period_end: null,
          trial_end_at: null,
          auto_renew: false,
          cancel_at_period_end: true,
          last_payment_id: null,
        },
      ]);
      const result = await repo.upsertSubscription(SUB);
      expect(result.currentPeriodEnd).toBeUndefined();
      expect(result.trialEndAt).toBeUndefined();
      expect(result.lastPaymentId).toBeUndefined();
      expect(result.cancelAtPeriodEnd).toBe(true);
    });

    it('case-5: cancelAtPeriodEnd / autoRenew 布尔字段透传', async () => {
      pg.query.mockResolvedValueOnce([
        {
          id: SUB_ID,
          parent_id: PARENT_ID,
          status: 'active',
          current_period_end: PERIOD_END,
          trial_end_at: null,
          auto_renew: false, // 假
          cancel_at_period_end: true, // 真
          last_payment_id: ORDER_ID,
        },
      ]);
      const result = await repo.upsertSubscription({
        ...SUB,
        autoRenew: false,
        cancelAtPeriodEnd: true,
      });
      expect(result.autoRenew).toBe(false);
      expect(result.cancelAtPeriodEnd).toBe(true);
    });

    it('case-6: PG 抛错 → 抛错（不吞，订阅是核心数据不 fail-open）', async () => {
      pg.query.mockRejectedValueOnce(new Error('UNIQUE constraint violated'));
      await expect(repo.upsertSubscription(SUB)).rejects.toThrow(
        /UNIQUE constraint violated/,
      );
    });
  });

  // ============================================================
  // findByParent
  // ============================================================
  describe('findByParent()', () => {
    it('case-7: happy — 1 行 → mapped subscription', async () => {
      pg.query.mockResolvedValueOnce([
        {
          id: SUB_ID,
          parent_id: PARENT_ID,
          status: 'trialing',
          current_period_end: PERIOD_END,
          trial_end_at: TRIAL_END,
          auto_renew: true,
          cancel_at_period_end: false,
          last_payment_id: ORDER_ID,
        },
      ]);
      const result = await repo.findByParent(PARENT_ID);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(SUB_ID);
      expect(result!.status).toBe('trialing');
      expect(pg.query.mock.calls[0][1]).toEqual([PARENT_ID]);
    });

    it('case-8: 0 行 → null（家长没订过订阅）', async () => {
      pg.query.mockResolvedValueOnce([]);
      const result = await repo.findByParent(PARENT_ID);
      expect(result).toBeNull();
    });

    it('case-9: SQL = SELECT ... FROM public.parent_subscriptions WHERE parent_id = $1', async () => {
      pg.query.mockResolvedValueOnce([]);
      await repo.findByParent(PARENT_ID);
      const sql = pg.query.mock.calls[0][0] as string;
      expect(sql).toMatch(/SELECT/);
      expect(sql).toMatch(/FROM public\.parent_subscriptions/);
      expect(sql).toMatch(/WHERE parent_id = \$1/);
    });

    it('case-10: PG 抛错 → 透传（findByParent 是只读，但仍不吞错）', async () => {
      pg.query.mockRejectedValueOnce(new Error('connection lost'));
      await expect(repo.findByParent(PARENT_ID)).rejects.toThrow(
        /connection lost/,
      );
    });
  });

  // ============================================================
  // listExpiredTrials
  // ============================================================
  describe('listExpiredTrials()', () => {
    it('case-11: happy — 返回到期 trialing 列表 + 时间参数传递', async () => {
      const now = new Date('2026-05-15T00:00:00.000Z');
      pg.query.mockResolvedValueOnce([
        {
          id: SUB_ID,
          parent_id: PARENT_ID,
          status: 'trialing',
          current_period_end: null,
          trial_end_at: TRIAL_END,
          auto_renew: true,
          cancel_at_period_end: false,
          last_payment_id: null,
        },
        {
          id: '01HX7Y6P5K9N3M2QABCDEFGHIJKLMSU2',
          parent_id: '01HX7Y6P5K9N3M2QABCDEFGHIJKLMPR2',
          status: 'trialing',
          current_period_end: null,
          trial_end_at: new Date('2026-05-08T00:00:00.000Z'),
          auto_renew: true,
          cancel_at_period_end: false,
          last_payment_id: null,
        },
      ]);
      const result = await repo.listExpiredTrials(now);

      expect(result).toHaveLength(2);
      expect(result[0].status).toBe('trialing');
      expect(pg.query.mock.calls[0][1]).toEqual([now]);
    });

    it('case-12: SQL = WHERE status = trialing AND trial_end_at < $1 AND auto_renew = true AND cancel_at_period_end = false', async () => {
      pg.query.mockResolvedValueOnce([]);
      await repo.listExpiredTrials(new Date());
      const sql = pg.query.mock.calls[0][0] as string;
      expect(sql).toMatch(/status = 'trialing'/);
      expect(sql).toMatch(/trial_end_at < \$1/);
      expect(sql).toMatch(/auto_renew = true/);
      expect(sql).toMatch(/cancel_at_period_end = false/);
    });

    it('case-13: 0 行 → 空数组（不抛）', async () => {
      pg.query.mockResolvedValueOnce([]);
      const result = await repo.listExpiredTrials(new Date());
      expect(result).toEqual([]);
    });
  });

  // ============================================================
  // listDueSubscriptions
  // ============================================================
  describe('listDueSubscriptions()', () => {
    it('case-14: happy — 返回 active 到期续费列表 + 阈值参数传递', async () => {
      const threshold = new Date('2026-05-20T00:00:00.000Z');
      pg.query.mockResolvedValueOnce([
        {
          id: SUB_ID,
          parent_id: PARENT_ID,
          status: 'active',
          current_period_end: PERIOD_END,
          trial_end_at: null,
          auto_renew: true,
          cancel_at_period_end: false,
          last_payment_id: ORDER_ID,
        },
      ]);
      const result = await repo.listDueSubscriptions(threshold);

      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('active');
      expect(pg.query.mock.calls[0][1]).toEqual([threshold]);
    });

    it('case-15: SQL = WHERE status = active AND current_period_end < $1 AND auto_renew + 非 cancel', async () => {
      pg.query.mockResolvedValueOnce([]);
      await repo.listDueSubscriptions(new Date());
      const sql = pg.query.mock.calls[0][0] as string;
      expect(sql).toMatch(/status = 'active'/);
      expect(sql).toMatch(/current_period_end < \$1/);
      expect(sql).toMatch(/auto_renew = true/);
      expect(sql).toMatch(/cancel_at_period_end = false/);
    });

    it('case-16: 0 行 → 空数组', async () => {
      pg.query.mockResolvedValueOnce([]);
      const result = await repo.listDueSubscriptions(new Date());
      expect(result).toEqual([]);
    });
  });

  // ============================================================
  // insertPaymentOrder
  // ============================================================
  describe('insertPaymentOrder()', () => {
    const ORDER: ParentPaymentOrder = {
      id: ORDER_ID,
      parentId: PARENT_ID,
      subscriptionId: SUB_ID,
      amountYuan: 9.9,
      sku: 'parent_monthly_9.9',
      status: 'paid',
      wxpayOutTradeNo: 'PF9BSNVJ1VG9C3CF3PX2Z79XFPMX3YS7',
      wxpayTransactionId: '4200003132202605143963746048',
      paidAt: PAID_AT,
      failureReason: undefined,
    };

    it('case-17: happy — 调 pg.query 1 次 + 返回 mapped ParentPaymentOrder', async () => {
      pg.query.mockResolvedValueOnce([
        {
          id: ORDER_ID,
          parent_id: PARENT_ID,
          subscription_id: SUB_ID,
          amount_yuan: '9.9',
          sku: 'parent_monthly_9.9',
          status: 'paid',
          wxpay_out_trade_no: 'PF9BSNVJ1VG9C3CF3PX2Z79XFPMX3YS7',
          wxpay_transaction_id: '4200003132202605143963746048',
          paid_at: PAID_AT,
          refunded_at: null,
          failure_reason: null,
        },
      ]);
      const result = await repo.insertPaymentOrder(ORDER);

      expect(pg.query).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        id: ORDER_ID,
        parentId: PARENT_ID,
        subscriptionId: SUB_ID,
        amountYuan: 9.9,
        sku: 'parent_monthly_9.9',
        status: 'paid',
        wxpayOutTradeNo: 'PF9BSNVJ1VG9C3CF3PX2Z79XFPMX3YS7',
        wxpayTransactionId: '4200003132202605143963746048',
        paidAt: PAID_AT,
        failureReason: undefined,
      });
    });

    it('case-18: SQL = INSERT INTO public.parent_payment_orders + RETURNING 关键列', async () => {
      pg.query.mockResolvedValueOnce([
        {
          id: ORDER_ID,
          parent_id: PARENT_ID,
          subscription_id: null,
          amount_yuan: '0',
          sku: ORDER.sku,
          status: 'pending',
          wxpay_out_trade_no: null,
          wxpay_transaction_id: null,
          paid_at: null,
          refunded_at: null,
          failure_reason: null,
        },
      ]);
      await repo.insertPaymentOrder({
        ...ORDER,
        subscriptionId: undefined,
        wxpayOutTradeNo: undefined,
        wxpayTransactionId: undefined,
        paidAt: undefined,
        amountYuan: 0,
        status: 'pending',
        failureReason: undefined,
      });

      const [sql, params] = pg.query.mock.calls[0];
      expect(sql).toMatch(/INSERT INTO public\.parent_payment_orders/);
      expect(sql).toMatch(/RETURNING/);
      expect(params).toEqual([
        ORDER_ID,
        PARENT_ID,
        null, // subscription_id
        0, // amount_yuan
        ORDER.sku,
        'pending',
        null, // wxpay_out_trade_no
        null, // wxpay_transaction_id
        null, // paid_at
        null, // refunded_at（永远入参 null，退款后续 UPDATE）
        null, // failure_reason
      ]);
    });

    it('case-19: failed 订单 + failureReason 透传', async () => {
      pg.query.mockResolvedValueOnce([
        {
          id: ORDER_ID,
          parent_id: PARENT_ID,
          subscription_id: SUB_ID,
          amount_yuan: '9.9',
          sku: ORDER.sku,
          status: 'failed',
          wxpay_out_trade_no: 'PF9BSNVJ1VG9C3CF3PX2Z79XFPMX3YS7',
          wxpay_transaction_id: null,
          paid_at: null,
          refunded_at: null,
          failure_reason: 'INSUFFICIENT_BALANCE',
        },
      ]);
      const result = await repo.insertPaymentOrder({
        ...ORDER,
        status: 'failed',
        wxpayTransactionId: undefined,
        paidAt: undefined,
        failureReason: 'INSUFFICIENT_BALANCE',
      });
      expect(result.status).toBe('failed');
      expect(result.failureReason).toBe('INSUFFICIENT_BALANCE');
    });

    it('case-20: amount_yuan PG 返回字符串 → Number 转 number 类型', async () => {
      pg.query.mockResolvedValueOnce([
        {
          id: ORDER_ID,
          parent_id: PARENT_ID,
          subscription_id: SUB_ID,
          amount_yuan: '23.76', // PG numeric 字段以字符串返
          sku: 'parent_quarterly_23.76',
          status: 'paid',
          wxpay_out_trade_no: null,
          wxpay_transaction_id: null,
          paid_at: null,
          refunded_at: null,
          failure_reason: null,
        },
      ]);
      const result = await repo.insertPaymentOrder(ORDER);
      expect(typeof result.amountYuan).toBe('number');
      expect(result.amountYuan).toBe(23.76);
    });

    it('case-21: PG 抛错（FK violation / UNIQUE）→ 抛错（订单是核心数据）', async () => {
      pg.query.mockRejectedValueOnce(
        new Error('FK violation: subscription_id not found'),
      );
      await expect(repo.insertPaymentOrder(ORDER)).rejects.toThrow(
        /FK violation/,
      );
    });
  });

  // ============================================================
  // listOrdersForParent
  // ============================================================
  describe('listOrdersForParent()', () => {
    it('case-22: happy — 返回家长订单列表（最多 50 条 ORDER BY created_at DESC）', async () => {
      pg.query.mockResolvedValueOnce([
        {
          id: ORDER_ID,
          parent_id: PARENT_ID,
          subscription_id: SUB_ID,
          amount_yuan: '9.9',
          sku: 'parent_monthly_9.9',
          status: 'paid',
          wxpay_out_trade_no: 'PF...',
          wxpay_transaction_id: '4200...',
          paid_at: PAID_AT,
          refunded_at: null,
          failure_reason: null,
        },
        {
          id: '01HX7Y6P5K9N3M2QABCDEFGHIJKLMOR2',
          parent_id: PARENT_ID,
          subscription_id: SUB_ID,
          amount_yuan: '9.9',
          sku: 'parent_monthly_9.9',
          status: 'pending',
          wxpay_out_trade_no: null,
          wxpay_transaction_id: null,
          paid_at: null,
          refunded_at: null,
          failure_reason: null,
        },
      ]);
      const result = await repo.listOrdersForParent(PARENT_ID);
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe(ORDER_ID);
      expect(pg.query.mock.calls[0][1]).toEqual([PARENT_ID]);
    });

    it('case-23: SQL = WHERE parent_id = $1 + ORDER BY created_at DESC LIMIT 50', async () => {
      pg.query.mockResolvedValueOnce([]);
      await repo.listOrdersForParent(PARENT_ID);
      const sql = pg.query.mock.calls[0][0] as string;
      expect(sql).toMatch(/WHERE parent_id = \$1/);
      expect(sql).toMatch(/ORDER BY created_at DESC/);
      expect(sql).toMatch(/LIMIT 50/);
    });

    it('case-24: 0 订单 → 空数组（家长未消费）', async () => {
      pg.query.mockResolvedValueOnce([]);
      const result = await repo.listOrdersForParent(PARENT_ID);
      expect(result).toEqual([]);
    });

    it('case-25: PG 抛错 → 透传', async () => {
      pg.query.mockRejectedValueOnce(new Error('connection lost'));
      await expect(repo.listOrdersForParent(PARENT_ID)).rejects.toThrow(
        /connection lost/,
      );
    });
  });

  // ============================================================
  // mapRow / mapOrderRow 边界（private helpers 通过公共方法间接验证）
  // ============================================================
  describe('mapRow / mapOrderRow 边界（NULL → undefined）', () => {
    it('case-26: mapRow — 全 null 字段 → 全 undefined（cancelled 订阅最终态）', async () => {
      pg.query.mockResolvedValueOnce([
        {
          id: SUB_ID,
          parent_id: PARENT_ID,
          status: 'cancelled',
          current_period_end: null,
          trial_end_at: null,
          auto_renew: false,
          cancel_at_period_end: true,
          last_payment_id: null,
        },
      ]);
      const result = await repo.findByParent(PARENT_ID);
      expect(result).toEqual({
        id: SUB_ID,
        parentId: PARENT_ID,
        status: 'cancelled',
        currentPeriodEnd: undefined,
        trialEndAt: undefined,
        autoRenew: false,
        cancelAtPeriodEnd: true,
        lastPaymentId: undefined,
      });
    });

    it('case-27: mapOrderRow — subscription_id / wxpay_* / paid_at / failure_reason 全 null → undefined', async () => {
      pg.query.mockResolvedValueOnce([
        {
          id: ORDER_ID,
          parent_id: PARENT_ID,
          subscription_id: null,
          amount_yuan: '0',
          sku: 'parent_monthly_9.9',
          status: 'pending',
          wxpay_out_trade_no: null,
          wxpay_transaction_id: null,
          paid_at: null,
          refunded_at: null,
          failure_reason: null,
        },
      ]);
      const result = await repo.listOrdersForParent(PARENT_ID);
      expect(result[0]).toEqual({
        id: ORDER_ID,
        parentId: PARENT_ID,
        subscriptionId: undefined,
        amountYuan: 0,
        sku: 'parent_monthly_9.9',
        status: 'pending',
        wxpayOutTradeNo: undefined,
        wxpayTransactionId: undefined,
        paidAt: undefined,
        failureReason: undefined,
      });
    });

    it('case-28: mapOrderRow — amount_yuan 整数字符串 → Number(string) = 整数', async () => {
      pg.query.mockResolvedValueOnce([
        {
          id: ORDER_ID,
          parent_id: PARENT_ID,
          subscription_id: SUB_ID,
          amount_yuan: '100', // 整数字符串
          sku: 'parent_yearly_100',
          status: 'paid',
          wxpay_out_trade_no: null,
          wxpay_transaction_id: null,
          paid_at: PAID_AT,
          refunded_at: null,
          failure_reason: null,
        },
      ]);
      const result = await repo.listOrdersForParent(PARENT_ID);
      expect(result[0].amountYuan).toBe(100);
      expect(typeof result[0].amountYuan).toBe('number');
    });
  });
});
