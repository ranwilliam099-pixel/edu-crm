import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PgPoolService } from './pg-pool.service';

/**
 * SubscriptionRepository — V19 SaaS 计费档位（public.tenants.plan_tier / max_campuses）
 *
 * 来源：用户 2026-05-04 endpoint #6（subscription/upgrade）
 *
 * 业务约束：
 *   - PLAN_META 定义 single/growth/chain 档位（max_campuses + price）
 *   - upgrade() 将 tenants.plan_tier + max_campuses 同步更新
 *   - 微信支付集成 mock：返回 paymentRequired + mockPayUrl（EXT-01 待真接入）
 */

export type PlanTier = 'single' | 'growth' | 'chain';

export const PLAN_META: Record<
  PlanTier,
  { name: string; maxCampuses: number; priceYuan: number }
> = {
  single: { name: '单校区版', maxCampuses: 1, priceYuan: 1999 },
  growth: { name: '成长版', maxCampuses: 3, priceYuan: 5999 },
  chain: { name: '连锁版', maxCampuses: 99, priceYuan: 19999 },
};

export interface Subscription {
  tenantId: string;
  planTier: PlanTier;
  maxCampuses: number;
  priceYuan: number;
}

@Injectable()
export class SubscriptionRepository {
  constructor(private readonly pg: PgPoolService) {}

  async getCurrent(tenantId: string): Promise<Subscription> {
    const rows = await this.pg.query<{
      plan_tier: PlanTier;
      max_campuses: number;
    }>(
      `SELECT plan_tier, max_campuses FROM public.tenants WHERE id = $1`,
      [tenantId],
    );
    if (rows.length === 0) {
      throw new NotFoundException(`tenant ${tenantId} not found`);
    }
    const planTier = rows[0].plan_tier || 'single';
    return {
      tenantId,
      planTier,
      maxCampuses: rows[0].max_campuses,
      priceYuan: PLAN_META[planTier]?.priceYuan ?? 0,
    };
  }

  /**
   * 升级订阅
   * - 校验 targetPlan 合法性
   * - 改 tenants.plan_tier + max_campuses
   * - 返回 oldPlan / newPlan / priceDiff
   *
   * TODO(EXT-01): 真接微信支付（当前返回 mockPayUrl）
   */
  async upgrade(
    tenantId: string,
    targetPlan: PlanTier,
  ): Promise<{
    ok: true;
    oldPlan: PlanTier;
    newPlan: PlanTier;
    priceDiff: number;
    paymentRequired: boolean;
    mockPayUrl: string;
  }> {
    if (!PLAN_META[targetPlan]) {
      throw new BadRequestException(`invalid targetPlan: ${targetPlan}`);
    }

    const currentRows = await this.pg.query<{ plan_tier: PlanTier }>(
      `SELECT plan_tier FROM public.tenants WHERE id = $1`,
      [tenantId],
    );
    if (currentRows.length === 0) {
      throw new NotFoundException(`tenant ${tenantId} not found`);
    }
    const oldPlan = (currentRows[0].plan_tier || 'single') as PlanTier;
    const newMeta = PLAN_META[targetPlan];
    const oldMeta = PLAN_META[oldPlan];
    const priceDiff = newMeta.priceYuan - oldMeta.priceYuan;

    await this.pg.query(
      `UPDATE public.tenants
       SET plan_tier = $1, max_campuses = $2
       WHERE id = $3`,
      [targetPlan, newMeta.maxCampuses, tenantId],
    );

    return {
      ok: true,
      oldPlan,
      newPlan: targetPlan,
      priceDiff,
      paymentRequired: priceDiff > 0,
      mockPayUrl: 'EXT-01-todo',
    };
  }
}
