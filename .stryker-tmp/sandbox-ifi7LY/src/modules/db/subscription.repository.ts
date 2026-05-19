import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PgPoolService } from './pg-pool.service';

/**
 * SubscriptionRepository — V19 SaaS 计费档位 + V20 联查折扣
 *
 * 来源：
 *   - V19 用户 2026-05-04 endpoint #6（subscription/upgrade）
 *   - V20 用户 2026-05-05「单独走 promotion 折扣字段 + 配置面板」
 *
 * 业务约束：
 *   - PLAN_META 严格线性：single 1999 / growth 5997 (3×) / chain 197901 (99×)
 *   - upgrade() 同步 plan_tier + max_campuses；升档清空 promotion（按新激活算正价）
 *   - getCurrent() 联查 promotion_tiers，返回 actual / next-year / 续费提示
 */

export type PlanTier = 'single' | 'growth' | 'chain';

export const PLAN_META: Record<
  PlanTier,
  { name: string; maxCampuses: number; priceYuan: number }
> = {
  single: { name: '单校区版', maxCampuses: 1, priceYuan: 1999 },
  growth: { name: '成长版', maxCampuses: 3, priceYuan: 5997 },
  chain: { name: '连锁版', maxCampuses: 99, priceYuan: 197901 },
};

export type PromotionStatus = 'reserved' | 'committed' | 'released' | 'expired';

export interface Subscription {
  tenantId: string;
  planTier: PlanTier;
  maxCampuses: number;
  priceYuan: number;
  promotionCode: string | null;
  promotionName: string | null;
  discountPct: number;
  actualPriceYuan: number;
  promotionStatus: PromotionStatus | null;
  promotionLockedAt: string | null;
  promotionYearIndex: number;
  promotionExpiresAt: string | null;
  nextYearPriceYuan: number;
}

@Injectable()
export class SubscriptionRepository {
  constructor(private readonly pg: PgPoolService) {}

  async getCurrent(tenantId: string): Promise<Subscription> {
    const rows = await this.pg.query<{
      plan_tier: PlanTier;
      max_campuses: number;
      promotion_code: string | null;
      promotion_status: PromotionStatus | null;
      promotion_locked_at: Date | null;
      promotion_price_yuan: number | null;
      promotion_year_index: number;
      promo_name: string | null;
      promo_discount: string | null;
      promo_applies_years: number | null;
      promo_active: boolean | null;
    }>(
      `SELECT
         t.plan_tier,
         t.max_campuses,
         t.promotion_code,
         t.promotion_status,
         t.promotion_locked_at,
         t.promotion_price_yuan,
         t.promotion_year_index,
         pt.name           AS promo_name,
         pt.discount_pct   AS promo_discount,
         pt.applies_years  AS promo_applies_years,
         pt.active         AS promo_active
       FROM public.tenants t
       LEFT JOIN public.promotion_tiers pt ON pt.code = t.promotion_code
       WHERE t.id = $1`,
      [tenantId],
    );
    if (rows.length === 0) {
      throw new NotFoundException(`tenant ${tenantId} not found`);
    }
    const r = rows[0];
    const planTier = (r.plan_tier || 'single') as PlanTier;
    const meta = PLAN_META[planTier];
    const priceYuan = meta?.priceYuan ?? 0;

    const promotionCode = r.promotion_code;
    const status = r.promotion_status;
    const lockedAt = r.promotion_locked_at;
    const yearIndex = r.promotion_year_index || 1;
    const appliesYears = Number(r.promo_applies_years || 0);
    const discountPct = r.promo_discount === null
      ? 100
      : Math.round(Number(r.promo_discount) * 100) / 100;

    let actualPriceYuan = priceYuan;
    let promotionExpiresAt: string | null = null;
    let nextYearPriceYuan = priceYuan;

    if (
      promotionCode &&
      status &&
      status !== 'released' &&
      status !== 'expired'
    ) {
      // 折扣有效：用 snapshot 优先，否则按当前 discount 重算
      if (r.promotion_price_yuan !== null) {
        actualPriceYuan = r.promotion_price_yuan;
      } else {
        actualPriceYuan = Math.round((priceYuan * discountPct) / 100);
      }

      if (lockedAt && appliesYears > 0) {
        const expires = new Date(lockedAt);
        expires.setUTCFullYear(expires.getUTCFullYear() + appliesYears);
        promotionExpiresAt = expires.toISOString();
      }

      // 续费判定：当前年度 < 覆盖年数 → 续年仍享折扣；否则回正价
      nextYearPriceYuan =
        yearIndex < appliesYears ? actualPriceYuan : priceYuan;
    }

    return {
      tenantId,
      planTier,
      maxCampuses: r.max_campuses,
      priceYuan,
      promotionCode,
      promotionName: r.promo_name,
      discountPct,
      actualPriceYuan,
      promotionStatus: status,
      promotionLockedAt: lockedAt ? lockedAt.toISOString() : null,
      promotionYearIndex: yearIndex,
      promotionExpiresAt,
      nextYearPriceYuan,
    };
  }

  /**
   * 升级订阅
   * - 校验 targetPlan 合法性
   * - 改 tenants.plan_tier + max_campuses
   * - 升档时清空 promotion（按新激活算正价；释放名额）
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

    const currentRows = await this.pg.query<{
      plan_tier: PlanTier;
      promotion_code: string | null;
    }>(
      `SELECT plan_tier, promotion_code FROM public.tenants WHERE id = $1`,
      [tenantId],
    );
    if (currentRows.length === 0) {
      throw new NotFoundException(`tenant ${tenantId} not found`);
    }
    const oldPlan = (currentRows[0].plan_tier || 'single') as PlanTier;
    const oldPromo = currentRows[0].promotion_code;
    const newMeta = PLAN_META[targetPlan];
    const oldMeta = PLAN_META[oldPlan];
    const priceDiff = newMeta.priceYuan - oldMeta.priceYuan;
    const planChanged = oldPlan !== targetPlan;

    await this.pg.transaction(async (client) => {
      // 任何 plan 变更（升档或降档）都释放 promo + 清 snapshot
      // 同档（targetPlan === oldPlan）保留现状
      if (planChanged && oldPromo) {
        await client.query(
          `UPDATE public.promotion_tiers
              SET quota_used = GREATEST(quota_used - 1, 0),
                  version = version + 1,
                  updated_at = NOW()
            WHERE code = $1`,
          [oldPromo],
        );
        await client.query(
          `INSERT INTO public.promotion_tier_audit
             (tier_code, action, after_json, tenant_id, operator_role, note)
           VALUES ($1, 'quota_release', $2::jsonb, $3, 'system', $4)`,
          [
            oldPromo,
            JSON.stringify({ reason: 'plan_change', oldPlan, newPlan: targetPlan }),
            tenantId,
            priceDiff > 0 ? 'plan_upgrade' : 'plan_downgrade',
          ],
        );
        await client.query(
          `UPDATE public.tenants
              SET plan_tier = $1,
                  max_campuses = $2,
                  promotion_code = NULL,
                  promotion_status = NULL,
                  promotion_locked_at = NULL,
                  promotion_price_yuan = NULL,
                  promotion_year_index = 1
            WHERE id = $3`,
          [targetPlan, newMeta.maxCampuses, tenantId],
        );
      } else {
        await client.query(
          `UPDATE public.tenants
              SET plan_tier = $1, max_campuses = $2
            WHERE id = $3`,
          [targetPlan, newMeta.maxCampuses, tenantId],
        );
      }
    });

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
