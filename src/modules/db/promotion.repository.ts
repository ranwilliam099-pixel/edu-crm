import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PgPoolService, PgRow } from './pg-pool.service';
import { PLAN_META, PlanTier } from './subscription.repository';
import { PromotionAuditRepository } from './promotion-audit.repository';
import {
  AuditCtx,
  PromotionDryRun,
  PromotionSourceType,
  PromotionStatus,
  PromotionTier,
  ActivationRules,
} from './promotion.types';

// 兼容老引用：types 默认从这里导出
export type {
  AuditCtx,
  PromotionDryRun,
  PromotionSourceType,
  PromotionStatus,
  PromotionTier,
  ActivationRules,
} from './promotion.types';

/**
 * PromotionRepository — V20 折扣档位 CRUD + 查询（tier 表为主）
 *
 * 不含状态机（reserve/commit/release）— 已拆到 PromotionQuotaService
 * 不含审计写入实现 — 已拆到 PromotionAuditRepository
 */
@Injectable()
export class PromotionRepository {
  constructor(
    private readonly pg: PgPoolService,
    private readonly audit: PromotionAuditRepository,
  ) {}

  static mapRow(r: PgRow): PromotionTier {
    return {
      id: Number(r.id),
      code: r.code,
      name: r.name,
      discountPct: Math.round(Number(r.discount_pct) * 100) / 100,
      quotaTotal: r.quota_total === null ? null : Number(r.quota_total),
      quotaUsed: Number(r.quota_used),
      active: !!r.active,
      startsAt: r.starts_at ? new Date(r.starts_at).toISOString() : null,
      endsAt: r.ends_at ? new Date(r.ends_at).toISOString() : null,
      activationRules: r.activation_rules || null,
      appliesToPlans: (r.applies_to_plans || []) as PlanTier[],
      appliesYears: Number(r.applies_years),
      sourceType: r.source_type as PromotionSourceType,
      inviteCode: r.invite_code,
      version: Number(r.version),
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
    };
  }

  // ===== 配置面板 CRUD =====

  async listTiers(): Promise<PromotionTier[]> {
    const rows = await this.pg.query<any>(
      `SELECT * FROM public.promotion_tiers ORDER BY id ASC`,
    );
    return rows.map((r) => PromotionRepository.mapRow(r));
  }

  async getTier(code: string): Promise<PromotionTier> {
    const rows = await this.pg.query<any>(
      `SELECT * FROM public.promotion_tiers WHERE code = $1`,
      [code],
    );
    if (rows.length === 0) {
      throw new NotFoundException(`promotion tier ${code} not found`);
    }
    return PromotionRepository.mapRow(rows[0]);
  }

  async findByInviteCode(inviteCode: string): Promise<PromotionTier | null> {
    const rows = await this.pg.query<any>(
      `SELECT * FROM public.promotion_tiers WHERE invite_code = $1 LIMIT 1`,
      [inviteCode],
    );
    return rows.length === 0 ? null : PromotionRepository.mapRow(rows[0]);
  }

  /**
   * 2026-05-29 §12C.5 自动匹配：选一个可「无码自动应用」的折扣档（付款时用）。
   *   条件：active + 非 kol（kol 是输码专用，不自动套）+ 名额未满 + 在时间窗 + 适用本 plan。
   *   多个匹配取「折扣最狠 = 实付最低 = discount_pct 最小」。无匹配返 null。
   *   注：本方法只「选码」；实际抢名额由 PromotionQuotaService.reserveQuota 原子完成
   *       （auto 与输码共用同一 quota_used 名额池 → 拍板「不管自不自动都算前 N 位」）。
   */
  async findBestAutoPromotion(planTier: PlanTier): Promise<PromotionTier | null> {
    const rows = await this.pg.query<any>(
      `SELECT * FROM public.promotion_tiers
         WHERE active = TRUE
           AND source_type <> 'kol'
           AND (quota_total IS NULL OR quota_used < quota_total)
           AND (starts_at IS NULL OR NOW() >= starts_at)
           AND (ends_at IS NULL OR NOW() < ends_at)
           AND $1 = ANY(applies_to_plans)
         ORDER BY discount_pct ASC
         LIMIT 1`,
      [planTier],
    );
    return rows.length === 0 ? null : PromotionRepository.mapRow(rows[0]);
  }

  async getTenantPlanTier(tenantId: string): Promise<PlanTier | null> {
    const rows = await this.pg.query<{ plan_tier: PlanTier | null }>(
      `SELECT plan_tier FROM public.tenants WHERE id = $1`,
      [tenantId],
    );
    if (rows.length === 0) return null;
    const t = rows[0].plan_tier;
    if (t === 'single' || t === 'growth' || t === 'chain') return t;
    return null;
  }

  async upsertTier(
    payload: {
      code: string;
      name: string;
      discountPct: number;
      quotaTotal: number | null;
      active?: boolean;
      startsAt?: string | null;
      endsAt?: string | null;
      activationRules?: ActivationRules | null;
      appliesToPlans?: PlanTier[];
      appliesYears?: number;
      sourceType?: PromotionSourceType;
      inviteCode?: string | null;
    },
    ctx: AuditCtx = {},
  ): Promise<PromotionTier> {
    if (!payload.code) {
      throw new BadRequestException('code required');
    }
    if (payload.discountPct < 0 || payload.discountPct > 100) {
      throw new BadRequestException('discountPct must be 0-100');
    }
    if (payload.quotaTotal !== null && payload.quotaTotal! < 0) {
      throw new BadRequestException('quotaTotal must be >= 0 or null');
    }

    const existingRows = await this.pg.query<any>(
      `SELECT * FROM public.promotion_tiers WHERE code = $1`,
      [payload.code],
    );
    const exists = existingRows.length > 0;
    const before = exists ? PromotionRepository.mapRow(existingRows[0]) : null;

    const sourceType: PromotionSourceType = payload.sourceType || 'self_service';
    const appliesToPlans = payload.appliesToPlans || ['single', 'growth', 'chain'];
    const appliesYears = payload.appliesYears ?? 1;

    let row: any;
    if (exists) {
      const r = await this.pg.query<any>(
        `UPDATE public.promotion_tiers
            SET name = $2,
                discount_pct = $3,
                quota_total = $4,
                active = $5,
                starts_at = $6,
                ends_at = $7,
                activation_rules = $8,
                applies_to_plans = $9,
                applies_years = $10,
                source_type = $11,
                invite_code = $12,
                version = version + 1,
                updated_at = NOW()
          WHERE code = $1
        RETURNING *`,
        [
          payload.code,
          payload.name,
          payload.discountPct,
          payload.quotaTotal,
          payload.active ?? true,
          payload.startsAt || null,
          payload.endsAt || null,
          payload.activationRules ? JSON.stringify(payload.activationRules) : null,
          appliesToPlans,
          appliesYears,
          sourceType,
          payload.inviteCode || null,
        ],
      );
      row = r[0];
    } else {
      const r = await this.pg.query<any>(
        `INSERT INTO public.promotion_tiers
           (code, name, discount_pct, quota_total, active, starts_at, ends_at,
            activation_rules, applies_to_plans, applies_years, source_type, invite_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [
          payload.code,
          payload.name,
          payload.discountPct,
          payload.quotaTotal,
          payload.active ?? true,
          payload.startsAt || null,
          payload.endsAt || null,
          payload.activationRules ? JSON.stringify(payload.activationRules) : null,
          appliesToPlans,
          appliesYears,
          sourceType,
          payload.inviteCode || null,
        ],
      );
      row = r[0];
    }

    const after = PromotionRepository.mapRow(row);
    await this.audit.write({
      tierCode: payload.code,
      action: exists ? 'update' : 'create',
      before,
      after,
      ctx,
    });
    return after;
  }

  async toggleActive(
    code: string,
    active: boolean,
    ctx: AuditCtx = {},
  ): Promise<PromotionTier> {
    const before = await this.getTier(code);
    const rows = await this.pg.query<any>(
      `UPDATE public.promotion_tiers
          SET active = $1, version = version + 1, updated_at = NOW()
        WHERE code = $2
      RETURNING *`,
      [active, code],
    );
    if (rows.length === 0) {
      throw new NotFoundException(`promotion tier ${code} not found`);
    }
    const after = PromotionRepository.mapRow(rows[0]);
    await this.audit.write({
      tierCode: code,
      action: 'toggle',
      before,
      after,
      ctx,
    });
    return after;
  }

  /**
   * 软删除 — 仅 active=FALSE，不真删（保护历史 audit/tenant 引用）
   */
  async softDelete(code: string, ctx: AuditCtx = {}): Promise<{ ok: true }> {
    const before = await this.getTier(code);
    const usedRows = await this.pg.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM public.tenants
         WHERE promotion_code = $1
           AND promotion_status IN ('reserved','committed')`,
      [code],
    );
    const usedCount = Number(usedRows[0]?.count || 0);
    await this.pg.query(
      `UPDATE public.promotion_tiers
          SET active = FALSE, version = version + 1, updated_at = NOW()
        WHERE code = $1`,
      [code],
    );
    await this.audit.write({
      tierCode: code,
      action: 'delete',
      before,
      after: null,
      ctx: { ...ctx, note: `soft-delete; ${usedCount} tenants still hold this promo` },
    });
    return { ok: true };
  }

  /**
   * 干跑预估 — 改折扣前看影响
   */
  async dryRun(
    code: string,
    proposed: { discountPct?: number; quotaTotal?: number | null },
  ): Promise<PromotionDryRun> {
    const tier = await this.getTier(code);
    const lockedRows = await this.pg.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM public.tenants
         WHERE promotion_code = $1 AND promotion_status IN ('reserved','committed')`,
      [code],
    );
    const affectedTenantsLocked = Number(lockedRows[0]?.count || 0);

    const remainingQuota =
      tier.quotaTotal === null ? null : tier.quotaTotal - tier.quotaUsed;

    const newDiscount = proposed.discountPct ?? tier.discountPct;
    const newQuotaTotal =
      proposed.quotaTotal === undefined ? tier.quotaTotal : proposed.quotaTotal;

    const newRemaining =
      newQuotaTotal === null ? null : newQuotaTotal - tier.quotaUsed;
    const estimatedNewActivations =
      newRemaining === null ? 0 : Math.max(0, newRemaining);

    // 用 single 价做基准估算（实际按 applies_to_plans 加权应更精确）
    const basePrice = PLAN_META.single.priceYuan;
    const oldUnit = Math.round((basePrice * tier.discountPct) / 100);
    const newUnit = Math.round((basePrice * newDiscount) / 100);
    const estimatedGmvDeltaYuan = (newUnit - oldUnit) * estimatedNewActivations;

    const warnings: string[] = [];
    if (affectedTenantsLocked > 0) {
      warnings.push(
        `${affectedTenantsLocked} 家租户已锁定本档位，价格 snapshot 不变`,
      );
    }
    if (
      remainingQuota !== null &&
      newQuotaTotal !== null &&
      newQuotaTotal < tier.quotaUsed
    ) {
      warnings.push(
        `新名额 ${newQuotaTotal} 小于已用 ${tier.quotaUsed}，无法保存`,
      );
    }
    return {
      affectedTenantsLocked,
      remainingQuota,
      estimatedNewActivations,
      estimatedGmvDeltaYuan,
      warnings,
    };
  }

  // ===== 命中租户列表 =====
  async listLockedTenants(
    code: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<{
    items: Array<{
      tenantId: string;
      status: PromotionStatus;
      lockedAt: string;
      priceYuan: number | null;
    }>;
    total: number;
  }> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const total = Number(
      (
        await this.pg.query<{ count: string }>(
          `SELECT COUNT(*) as count FROM public.tenants WHERE promotion_code = $1`,
          [code],
        )
      )[0]?.count || 0,
    );
    const rows = await this.pg.query<any>(
      `SELECT id, promotion_status, promotion_locked_at, promotion_price_yuan
         FROM public.tenants
        WHERE promotion_code = $1
        ORDER BY promotion_locked_at DESC NULLS LAST
        LIMIT $2 OFFSET $3`,
      [code, limit, offset],
    );
    return {
      total,
      items: rows.map((r) => ({
        tenantId: r.id,
        status: r.promotion_status as PromotionStatus,
        lockedAt: r.promotion_locked_at
          ? new Date(r.promotion_locked_at).toISOString()
          : '',
        priceYuan: r.promotion_price_yuan === null ? null : Number(r.promotion_price_yuan),
      })),
    };
  }
}
