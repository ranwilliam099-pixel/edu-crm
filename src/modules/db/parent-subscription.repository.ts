import { Injectable, NotFoundException } from '@nestjs/common';
import { PgPoolService } from './pg-pool.service';
import {
  ParentSubscription,
  ParentPaymentOrder,
} from '../parent/parent-subscription.service';

/**
 * ParentSubscriptionRepository — V10 订阅 + 支付（public schema）
 */
@Injectable()
export class ParentSubscriptionRepository {
  constructor(private readonly pg: PgPoolService) {}

  async upsertSubscription(s: ParentSubscription): Promise<ParentSubscription> {
    const rows = await this.pg.query<any>(
      `INSERT INTO public.parent_subscriptions (
         id, parent_id, status, current_period_end, trial_end_at,
         auto_renew, cancel_at_period_end, last_payment_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (parent_id) DO UPDATE SET
         status = EXCLUDED.status,
         current_period_end = EXCLUDED.current_period_end,
         trial_end_at = EXCLUDED.trial_end_at,
         auto_renew = EXCLUDED.auto_renew,
         cancel_at_period_end = EXCLUDED.cancel_at_period_end,
         last_payment_id = EXCLUDED.last_payment_id,
         updated_at = NOW()
       RETURNING id, parent_id, status, current_period_end, trial_end_at,
                 auto_renew, cancel_at_period_end, last_payment_id`,
      [
        s.id,
        s.parentId,
        s.status,
        s.currentPeriodEnd || null,
        s.trialEndAt || null,
        s.autoRenew,
        s.cancelAtPeriodEnd,
        s.lastPaymentId || null,
      ],
    );
    return this.mapRow(rows[0]);
  }

  async findByParent(parentId: string): Promise<ParentSubscription | null> {
    const rows = await this.pg.query<any>(
      `SELECT id, parent_id, status, current_period_end, trial_end_at,
              auto_renew, cancel_at_period_end, last_payment_id
       FROM public.parent_subscriptions WHERE parent_id = $1`,
      [parentId],
    );
    return rows.length === 0 ? null : this.mapRow(rows[0]);
  }

  async listExpiredTrials(now: Date): Promise<ParentSubscription[]> {
    const rows = await this.pg.query<any>(
      `SELECT id, parent_id, status, current_period_end, trial_end_at,
              auto_renew, cancel_at_period_end, last_payment_id
       FROM public.parent_subscriptions
       WHERE status = 'trialing' AND trial_end_at < $1 AND auto_renew = true
         AND cancel_at_period_end = false`,
      [now],
    );
    return rows.map((r) => this.mapRow(r));
  }

  async listDueSubscriptions(threshold: Date): Promise<ParentSubscription[]> {
    const rows = await this.pg.query<any>(
      `SELECT id, parent_id, status, current_period_end, trial_end_at,
              auto_renew, cancel_at_period_end, last_payment_id
       FROM public.parent_subscriptions
       WHERE status = 'active' AND current_period_end < $1 AND auto_renew = true
         AND cancel_at_period_end = false`,
      [threshold],
    );
    return rows.map((r) => this.mapRow(r));
  }

  // ===== payment orders =====

  async insertPaymentOrder(o: ParentPaymentOrder): Promise<ParentPaymentOrder> {
    const rows = await this.pg.query<any>(
      `INSERT INTO public.parent_payment_orders (
         id, parent_id, subscription_id, amount_yuan, sku, status,
         wxpay_out_trade_no, wxpay_transaction_id, paid_at, refunded_at, failure_reason
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, parent_id, subscription_id, amount_yuan, sku, status,
                 wxpay_out_trade_no, wxpay_transaction_id, paid_at, refunded_at, failure_reason`,
      [
        o.id,
        o.parentId,
        o.subscriptionId || null,
        o.amountYuan,
        o.sku,
        o.status,
        o.wxpayOutTradeNo || null,
        o.wxpayTransactionId || null,
        o.paidAt || null,
        null,
        o.failureReason || null,
      ],
    );
    return this.mapOrderRow(rows[0]);
  }

  async listOrdersForParent(parentId: string): Promise<ParentPaymentOrder[]> {
    const rows = await this.pg.query<any>(
      `SELECT id, parent_id, subscription_id, amount_yuan, sku, status,
              wxpay_out_trade_no, wxpay_transaction_id, paid_at, refunded_at, failure_reason
       FROM public.parent_payment_orders
       WHERE parent_id = $1
       ORDER BY created_at DESC LIMIT 50`,
      [parentId],
    );
    return rows.map((r) => this.mapOrderRow(r));
  }

  // ===== helpers =====

  private mapRow(row: any): ParentSubscription {
    return {
      id: row.id,
      parentId: row.parent_id,
      status: row.status,
      currentPeriodEnd: row.current_period_end || undefined,
      trialEndAt: row.trial_end_at || undefined,
      autoRenew: row.auto_renew,
      cancelAtPeriodEnd: row.cancel_at_period_end,
      lastPaymentId: row.last_payment_id || undefined,
    };
  }

  private mapOrderRow(row: any): ParentPaymentOrder {
    return {
      id: row.id,
      parentId: row.parent_id,
      subscriptionId: row.subscription_id || undefined,
      amountYuan: Number(row.amount_yuan),
      sku: row.sku,
      status: row.status,
      wxpayOutTradeNo: row.wxpay_out_trade_no || undefined,
      wxpayTransactionId: row.wxpay_transaction_id || undefined,
      paidAt: row.paid_at || undefined,
      failureReason: row.failure_reason || undefined,
    };
  }
}
