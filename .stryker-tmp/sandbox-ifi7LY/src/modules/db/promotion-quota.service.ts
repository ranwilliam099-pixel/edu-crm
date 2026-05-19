import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PgPoolService } from './pg-pool.service';
import { PLAN_META, PlanTier } from './subscription.repository';
import { PromotionRepository } from './promotion.repository';
import { PromotionAuditRepository } from './promotion-audit.repository';
import { AuditCtx, PromotionTier } from './promotion.types';

/**
 * PromotionQuotaService — V20 状态机：reserve / commit / release
 *
 * 设计：
 *   - reserveQuota：原子抢名额 + 写 tenants.promotion_*（reserved）+ audit
 *   - commitQuota：reserved → committed（首笔付款成功调用）
 *   - releaseQuota：reserved/committed → released + 名额回退（试用失败/退款/降档）
 *
 * 不含 CRUD（在 PromotionRepository）；不含 audit 实现（在 PromotionAuditRepository）
 */
@Injectable()
export class PromotionQuotaService {
  private readonly logger = new Logger(PromotionQuotaService.name);

  constructor(
    private readonly pg: PgPoolService,
    private readonly audit: PromotionAuditRepository,
  ) {}

  /**
   * expirePromotions — 巡检并把已过 applies_years 期限的 committed 锁定转 expired
   *
   * 触发：cron 每天一次（外部调度器 → CronJobsService.expirePromotions → 此方法）
   *
   * 逻辑：
   *   - 查所有 promotion_status='committed' 的 tenants
   *   - join promotion_tiers 拿 applies_years
   *   - 计算 expires_at = locked_at + applies_years 年
   *   - 若 NOW() >= expires_at → 转 expired + audit（不释放名额，名额已用 = 历史业绩）
   */
  async expirePromotions(now: Date = new Date()): Promise<{ expired: number }> {
    const candidates = await this.pg.query<{
      tenant_id: string;
      promotion_code: string;
      promotion_locked_at: Date;
      applies_years: number;
    }>(
      `SELECT t.id AS tenant_id,
              t.promotion_code,
              t.promotion_locked_at,
              pt.applies_years
         FROM public.tenants t
         JOIN public.promotion_tiers pt ON pt.code = t.promotion_code
        WHERE t.promotion_status = 'committed'
          AND t.promotion_locked_at IS NOT NULL`,
    );

    let expired = 0;
    for (const c of candidates) {
      const lockedAt = new Date(c.promotion_locked_at);
      const expiresAt = new Date(lockedAt);
      expiresAt.setUTCFullYear(expiresAt.getUTCFullYear() + Number(c.applies_years));
      if (now < expiresAt) continue;

      await this.pg.transaction(async (client) => {
        await client.query(
          `UPDATE public.tenants SET promotion_status = 'expired' WHERE id = $1`,
          [c.tenant_id],
        );
        await this.audit.write({
          tierCode: c.promotion_code,
          action: 'quota_expire',
          afterJson: {
            lockedAt: lockedAt.toISOString(),
            expiredAt: expiresAt.toISOString(),
          },
          tenantId: c.tenant_id,
          ctx: { operatorRole: 'system', note: 'cron_expire_promotions' },
          client,
        });
      });
      expired++;
    }

    if (expired > 0) {
      this.logger.log(`[CRON-EXPIRE] ${expired} promotions transitioned committed → expired`);
    }
    return { expired };
  }

  /**
   * 原子抢名额 + 锁定 tenant
   */
  async reserveQuota(
    tenantId: string,
    code: string,
    ctx: AuditCtx = {},
  ): Promise<{ tier: PromotionTier; reservedAt: string; actualPriceYuan: number }> {
    return this.pg.transaction(async (client) => {
      // 检查租户当前是否已有有效 promotion
      const tRows = await client.query(
        `SELECT promotion_code, promotion_status, plan_tier
           FROM public.tenants WHERE id = $1 FOR UPDATE`,
        [tenantId],
      );
      if (tRows.rows.length === 0) {
        throw new NotFoundException(`tenant ${tenantId} not found`);
      }
      const cur = tRows.rows[0];
      if (
        cur.promotion_code &&
        cur.promotion_status &&
        ['reserved', 'committed'].includes(cur.promotion_status)
      ) {
        throw new ConflictException(
          `PROMOTION_ALREADY_LOCKED: tenant has ${cur.promotion_status} ${cur.promotion_code}`,
        );
      }

      // 原子抢名额
      const updRows = await client.query(
        `UPDATE public.promotion_tiers
            SET quota_used = quota_used + 1,
                version = version + 1,
                updated_at = NOW()
          WHERE code = $1
            AND active = TRUE
            AND (quota_total IS NULL OR quota_used < quota_total)
            AND (starts_at IS NULL OR NOW() >= starts_at)
            AND (ends_at IS NULL OR NOW() < ends_at)
        RETURNING *`,
        [code],
      );

      if (updRows.rows.length === 0) {
        const checkRows = await client.query(
          `SELECT active, quota_total, quota_used, starts_at, ends_at
             FROM public.promotion_tiers WHERE code = $1`,
          [code],
        );
        if (checkRows.rows.length === 0) {
          throw new NotFoundException(`promotion ${code} not found`);
        }
        const t = checkRows.rows[0];
        if (!t.active) throw new ConflictException('PROMOTION_NOT_ACTIVE');
        const nowCheck = new Date();
        if (t.starts_at && nowCheck < new Date(t.starts_at)) {
          throw new ConflictException('PROMOTION_NOT_STARTED');
        }
        if (t.ends_at && nowCheck >= new Date(t.ends_at)) {
          throw new ConflictException('PROMOTION_EXPIRED');
        }
        if (t.quota_total !== null && t.quota_used >= t.quota_total) {
          throw new ConflictException('PROMOTION_QUOTA_EXHAUSTED');
        }
        throw new ConflictException('PROMOTION_RESERVE_FAILED');
      }

      const tierAfter = PromotionRepository.mapRow(updRows.rows[0]);
      const planTier = (cur.plan_tier || 'single') as PlanTier;
      const meta = PLAN_META[planTier];
      const actualPriceYuan = Math.round(
        (meta.priceYuan * tierAfter.discountPct) / 100,
      );

      const now = new Date();
      await client.query(
        `UPDATE public.tenants
            SET promotion_code = $1,
                promotion_status = 'reserved',
                promotion_locked_at = $2,
                promotion_price_yuan = $3,
                promotion_year_index = 1
          WHERE id = $4`,
        [code, now, actualPriceYuan, tenantId],
      );

      await this.audit.write({
        tierCode: code,
        action: 'quota_reserve',
        afterJson: { planTier, actualPriceYuan, quotaUsed: tierAfter.quotaUsed },
        tenantId,
        ctx: { ...ctx, operatorRole: ctx.operatorRole || 'system' },
        client,
      });

      return {
        tier: tierAfter,
        reservedAt: now.toISOString(),
        actualPriceYuan,
      };
    });
  }

  /**
   * reserved → committed（首笔付款成功）
   */
  async commitQuota(
    tenantId: string,
    ctx: AuditCtx = {},
  ): Promise<{ ok: true; promotionCode: string }> {
    return this.pg.transaction(async (client) => {
      const tRows = await client.query(
        `SELECT promotion_code, promotion_status FROM public.tenants
           WHERE id = $1 FOR UPDATE`,
        [tenantId],
      );
      if (tRows.rows.length === 0) {
        throw new NotFoundException(`tenant ${tenantId} not found`);
      }
      const cur = tRows.rows[0];
      if (!cur.promotion_code) {
        throw new BadRequestException('PROMOTION_NOT_RESERVED');
      }
      if (cur.promotion_status !== 'reserved') {
        throw new ConflictException(
          `PROMOTION_INVALID_STATE: ${cur.promotion_status}`,
        );
      }
      await client.query(
        `UPDATE public.tenants SET promotion_status = 'committed' WHERE id = $1`,
        [tenantId],
      );
      await this.audit.write({
        tierCode: cur.promotion_code,
        action: 'quota_commit',
        tenantId,
        ctx: { ...ctx, operatorRole: ctx.operatorRole || 'system' },
        client,
      });
      return { ok: true as const, promotionCode: cur.promotion_code };
    });
  }

  /**
   * reserved/committed → released + 名额回退
   */
  async releaseQuota(
    tenantId: string,
    reason: string,
    ctx: AuditCtx = {},
  ): Promise<{ ok: true; releasedCode: string | null }> {
    return this.pg.transaction(async (client) => {
      const tRows = await client.query(
        `SELECT promotion_code, promotion_status FROM public.tenants
           WHERE id = $1 FOR UPDATE`,
        [tenantId],
      );
      if (tRows.rows.length === 0) {
        throw new NotFoundException(`tenant ${tenantId} not found`);
      }
      const cur = tRows.rows[0];
      if (
        !cur.promotion_code ||
        !['reserved', 'committed'].includes(cur.promotion_status)
      ) {
        return { ok: true as const, releasedCode: null };
      }
      await client.query(
        `UPDATE public.promotion_tiers
            SET quota_used = GREATEST(quota_used - 1, 0),
                version = version + 1,
                updated_at = NOW()
          WHERE code = $1`,
        [cur.promotion_code],
      );
      await client.query(
        `UPDATE public.tenants
            SET promotion_status = 'released'
          WHERE id = $1`,
        [tenantId],
      );
      await this.audit.write({
        tierCode: cur.promotion_code,
        action: 'quota_release',
        afterJson: { reason, prevStatus: cur.promotion_status },
        tenantId,
        ctx: {
          ...ctx,
          operatorRole: ctx.operatorRole || 'system',
          note: ctx.note || reason,
        },
        client,
      });
      return { ok: true as const, releasedCode: cur.promotion_code };
    });
  }
}
