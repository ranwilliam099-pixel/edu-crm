import { Injectable, Logger } from '@nestjs/common';
import { PgPoolService } from './pg-pool.service';
import { PromotionQuotaService } from './promotion-quota.service';
import { ActivationRules } from './promotion.types';

/**
 * PromotionEligibilityService — V20 早鸟门槛达成探测 + 自动 reserveQuota
 *
 * 来源：用户 2026-05-05「设计是否科学严谨」复核
 *   - 门槛达成瞬间必须 atomic 抢名额，不能让 11 家都达成但只有先点订阅的拿到 1 折
 *
 * 触发点：admin KPI 调用时（boss/admin 看 dashboard 的瞬间也在算 KPI）
 *
 * 流程：
 *   1) 读 tenant 当前 promotion_status（已 reserved/committed → 直接跳过）
 *   2) 读 tenant 4 项 KPI（teachers / students / parents / schedules）
 *   3) 找最优档位（active + 名额未满 + 时间窗 + 门槛达成 + applies_to_plans 包含当前 plan）
 *   4) atomic reserveQuota；任何错误吞掉（KPI 接口不能因抢档失败而 5xx）
 */
@Injectable()
export class PromotionEligibilityService {
  private readonly logger = new Logger(PromotionEligibilityService.name);

  constructor(
    private readonly pg: PgPoolService,
    private readonly quota: PromotionQuotaService,
  ) {}

  /**
   * 探测并抢档 — 异步触发，不阻塞 KPI 返回
   * @returns true 表示新抢到 / false 表示无变化
   */
  async detectAndReserve(tenantId: string, tenantSchema: string): Promise<boolean> {
    try {
      // 1) 已有有效 promotion → 跳过
      const tRows = await this.pg.query<{
        promotion_code: string | null;
        promotion_status: string | null;
        plan_tier: string;
      }>(
        `SELECT promotion_code, promotion_status, plan_tier
           FROM public.tenants WHERE id = $1`,
        [tenantId],
      );
      if (tRows.length === 0) return false;
      const t = tRows[0];
      if (t.promotion_code && ['reserved', 'committed'].includes(t.promotion_status || '')) {
        return false;
      }

      // 2) tenant 4 KPI（用真实 tenantId，不从 schema 还原 — schema 是 tenantId.toLowerCase()
      //    反向 toUpperCase 会损坏混合大小写 ID 如 mxedu_xxx）
      const kpi = await this.collectActivationKpi(tenantId, tenantSchema);

      // 3) 候选档位（active + self_service + applies_to_plans 包含 plan_tier）
      const candidates = await this.pg.query<any>(
        `SELECT * FROM public.promotion_tiers
          WHERE active = TRUE
            AND source_type = 'self_service'
            AND $1 = ANY(applies_to_plans)
            AND (quota_total IS NULL OR quota_used < quota_total)
            AND (starts_at IS NULL OR NOW() >= starts_at)
            AND (ends_at IS NULL OR NOW() < ends_at)
            AND discount_pct < 100
            AND activation_rules IS NOT NULL
          ORDER BY discount_pct ASC, id ASC`, // 优先最大折扣（数字最小=折扣最深）
        [t.plan_tier || 'single'],
      );

      for (const c of candidates) {
        const rules = c.activation_rules as ActivationRules | null | undefined;
        if (!rules) continue; // defensive: SQL filter 已保证，但兜底防 null
        if (this.kpiMeetsRules(kpi, rules)) {
          try {
            await this.quota.reserveQuota(tenantId, c.code, {
              operatorRole: 'system',
              note: `auto-reserve on KPI threshold; kpi=${JSON.stringify(kpi)}`,
            });
            this.logger.log(
              `[PROMO-AUTO-RESERVE] tenant=${tenantId} code=${c.code}`,
            );
            return true;
          } catch (e: any) {
            // 并发抢档：另一家先抢满 → 跳到下一档
            if (/QUOTA_EXHAUSTED|ALREADY_LOCKED/.test(e.message || '')) {
              continue;
            }
            this.logger.warn(`[PROMO-RESERVE-FAILED] ${e.message}`);
            return false;
          }
        }
      }
      return false;
    } catch (e: any) {
      this.logger.error(`[PROMO-DETECT-FAILED] ${e.message}`);
      return false;
    }
  }

  private async collectActivationKpi(
    tenantId: string,
    tenantSchema: string,
  ): Promise<{
    teachers: number;
    students: number;
    parents: number;
    schedules: number;
  }> {
    const out = { teachers: 0, students: 0, parents: 0, schedules: 0 };
    try {
      const r = await this.pg.tenantQuery<{ count: string }>(
        tenantSchema,
        `SELECT COUNT(*) as count FROM teachers WHERE status = 'active'`,
      );
      out.teachers = parseInt(r[0]?.count || '0', 10);
    } catch (e) {
      this.logger.debug(`[KPI-teachers] ${tenantSchema}: ${(e as Error).message}`);
    }
    try {
      const r = await this.pg.tenantQuery<{ count: string }>(
        tenantSchema,
        `SELECT COUNT(*) as count FROM students`,
      );
      out.students = parseInt(r[0]?.count || '0', 10);
    } catch (e) {
      this.logger.debug(`[KPI-students] ${tenantSchema}: ${(e as Error).message}`);
    }
    // schedules：排除 cancelled（早鸟门槛意指有效排课）
    try {
      const r = await this.pg.tenantQuery<{ count: string }>(
        tenantSchema,
        `SELECT COUNT(*) as count FROM schedules
          WHERE COALESCE(status, 'scheduled') <> 'cancelled'`,
      );
      out.schedules = parseInt(r[0]?.count || '0', 10);
    } catch (e) {
      this.logger.debug(`[KPI-schedules] ${tenantSchema}: ${(e as Error).message}`);
    }
    // parents 在 public schema，按 tenant_id 聚合（用真实 tenantId，不要从 schema 还原）
    try {
      const r = await this.pg.query<{ count: string }>(
        `SELECT COUNT(DISTINCT p.id) as count
           FROM public.parents p
           JOIN public.parent_student_bindings psb ON psb.parent_id = p.id
          WHERE psb.tenant_id = $1`,
        [tenantId],
      );
      out.parents = parseInt(r[0]?.count || '0', 10);
    } catch (e) {
      this.logger.debug(`[KPI-parents] ${tenantId}: ${(e as Error).message}`);
    }
    return out;
  }

  private kpiMeetsRules(
    kpi: { teachers: number; students: number; parents: number; schedules: number },
    rules: ActivationRules,
  ): boolean {
    if (rules.teachers !== undefined && kpi.teachers < rules.teachers) return false;
    if (rules.students !== undefined && kpi.students < rules.students) return false;
    if (rules.parents !== undefined && kpi.parents < rules.parents) return false;
    if (rules.schedules !== undefined && kpi.schedules < rules.schedules) return false;
    return true;
  }
}
