import { Injectable, Logger } from '@nestjs/common';
import { PgPoolService } from './pg-pool.service';
import { UserRepository } from './user.repository';

/**
 * DashboardRepository — V19 KPI 聚合查询（tenant schema）
 *
 * 来源：用户 2026-05-04 endpoint #7/#8/#9
 *   - admin KPI（pages/b/home/home 4 个 KPI）
 *   - sales-funnel 销售漏斗
 *   - teacher-leaderboard 老师业绩榜
 *
 * 不新建表，纯聚合 SQL。
 */

export interface AdminKpi {
  thisMonth: {
    newSignups: number;       // 本月激活的课时包数（≈ 新签数）
    revenueYuan: number;      // 本月已支付总额（元）
    activeStudents: number;   // 在管学员
    conversionRate: number;   // parent_subscriptions(active|trial) / parents 总数
  };
  todoCount: number;          // 待办聚合（当前=低余额；后续合同到期 + 未批改作业可加）
  lowBalanceCount: number;    // 低课时余额学员数（remaining_lessons ≤ 5）
  studentsTotal: number;
}

export interface SalesFunnelStage {
  // 2026-06-02 SSOT §3.-2 C — 漏斗重设计为 3 状态：following / trial / deal
  key: 'following' | 'trial' | 'deal' | string;
  label: string; // 跟进中 / 已试听 / 成交
  count: number;
  conversionPct: number;
}
export interface SalesFunnel {
  stages: SalesFunnelStage[];
  overallConversion: number;
  lossReasons: Array<{ reason: string; pct: number }>;
}

export interface TeacherLeaderboardItem {
  rank: number;
  id: string;
  name: string;
  subject: string;
  avatar?: string;
  // V37 删 payroll（薪资业务下线，拍板 fields-by-role.md 全角色 home 不展示工资）
  lessons: number;
  rating: number | null;
  feedbackRate: number;
  // V37 删 trend（来源 monthly_aggregates.payroll_yuan 已下线；cron 未实现
  // monthly_aggregates 写入，trend 实际一直返 'flat'，无业务价值）
}
export interface TeacherLeaderboard {
  activeMonth: string;
  // V37 删 summary.total（原 totalPayroll 别名）；保留 count + avgRating
  summary: { count: number; avgRating: number | null };
  teachers: TeacherLeaderboardItem[];
}

// V37 删 'payroll' sortKey（薪资下线）
export type LeaderboardSortKey = 'lessons' | 'rating' | 'feedbackRate';

/**
 * Phase 3 (2026-05-30 item #4) — 首页预警聚合（b/home attentionStats）
 *
 * 前端 b/home attentionStats { lowBalance, refundPending, handover } 现全 0。
 * @Roles('admin','boss') — 仅经营管理者看全机构预警。
 */
export interface HomeAlertStats {
  lowBalance: number;     // 剩余课时 < 5 的在管学员数（DISTINCT student_id, status='active'）
  refundPending: number;  // 待审批退费工单数（refund_orders.status='pending'）
  handover: number;       // 待交接数：离职(status='停用')且名下仍有 opp/contract/student 的员工数
}

@Injectable()
export class DashboardRepository {
  private readonly logger = new Logger(DashboardRepository.name);
  constructor(
    private readonly pg: PgPoolService,
    private readonly userRepo: UserRepository,
  ) {}

  // ===================== Admin KPI =====================
  async getAdminKpi(tenantSchema: string): Promise<AdminKpi> {
    let newSignups = 0;
    let revenueYuan = 0;
    let activeStudents = 0;
    let studentsTotal = 0;
    let conversionRate = 0;
    let lowBalanceCount = 0;

    // 本月新签 + 收入：student_course_packages 本月激活 join course_packages 取 total_price_yuan
    try {
      const rows = await this.pg.tenantQuery<{
        new_signups: string;
        revenue_yuan: string;
      }>(
        tenantSchema,
        `SELECT
           COUNT(*) FILTER (
             WHERE scp.activated_at >= date_trunc('month', NOW())
           ) AS new_signups,
           COALESCE(SUM(cp.total_price_yuan) FILTER (
             WHERE scp.activated_at >= date_trunc('month', NOW())
           ), 0) AS revenue_yuan
         FROM student_course_packages scp
         JOIN course_packages cp ON cp.id = scp.course_package_id`,
      );
      newSignups = parseInt(rows[0]?.new_signups || '0', 10);
      revenueYuan = Math.round(Number(rows[0]?.revenue_yuan || 0));
    } catch (e) {
      this.logger.debug(`[KPI-revenue] ${tenantSchema}: ${(e as Error).message}`);
    }

    // 在管学员（active student_course_packages 去重）
    try {
      const rows = await this.pg.tenantQuery<{ active: string }>(
        tenantSchema,
        `SELECT COUNT(DISTINCT student_id) as active
         FROM student_course_packages
         WHERE status = 'active'`,
      );
      activeStudents = parseInt(rows[0]?.active || '0', 10);
    } catch (e) {
      this.logger.debug(`[KPI-activeStudents] ${tenantSchema}: ${(e as Error).message}`);
    }

    // 学员总数
    // V44: deleted_at IS NULL 排除已软删（KPI 只统计可见学员）
    try {
      const rows = await this.pg.tenantQuery<{ count: string }>(
        tenantSchema,
        `SELECT COUNT(*) as count FROM students WHERE deleted_at IS NULL`,
      );
      studentsTotal = parseInt(rows[0]?.count || '0', 10);
    } catch (e) {
      this.logger.debug(`[KPI-studentsTotal] ${tenantSchema}: ${(e as Error).message}`);
    }

    // 低余额学员：剩余课时 ≤ 5（V12 student_course_packages.remaining_lessons）
    try {
      const rows = await this.pg.tenantQuery<{ count: string }>(
        tenantSchema,
        `SELECT COUNT(DISTINCT student_id) as count
         FROM student_course_packages
         WHERE status = 'active' AND remaining_lessons <= 5`,
      );
      lowBalanceCount = parseInt(rows[0]?.count || '0', 10);
    } catch (e) {
      this.logger.debug(`[KPI-lowBalance] ${tenantSchema}: ${(e as Error).message}`);
    }

    // 转化率：active 学员 / 总学员（近似）。
    // 严格意义需 join public.parent_subscriptions 跨 schema 聚合 — 后续 V22 加专表
    if (studentsTotal > 0 && activeStudents > 0) {
      conversionRate = Math.round((activeStudents * 100) / studentsTotal);
    }

    return {
      thisMonth: {
        newSignups,
        revenueYuan,
        activeStudents,
        conversionRate,
      },
      // todoCount = 待批改作业 + 低余额学员（简化：仅低余额，待批改需 V13 join）
      todoCount: lowBalanceCount,
      lowBalanceCount,
      studentsTotal,
    };
  }

  // ===================== Home Alerts (Phase 3 item #4) =====================
  /**
   * 首页预警聚合 — b/home attentionStats { lowBalance, refundPending, handover }
   *
   * 三项口径（每项独立 try-catch fail-open，单项查询失败返 0 不影响其它项）：
   *
   *   1. refundPending = COUNT(refund_orders WHERE status='pending')
   *      - V59 refund_orders 在 tenant schema；待审批退费工单数。
   *      - 不按 campus 过滤（admin/boss 看全机构）。
   *
   *   2. lowBalance = COUNT(DISTINCT student_id) FROM student_course_packages
   *                   WHERE status='active' AND remaining_lessons < 5
   *      - V12 student_course_packages.remaining_lessons（GENERATED 列，干净的剩余课时数据）。
   *      - 阈值 < 5（与 getAdminKpi 的 <= 5 略不同 — 本 item 拍板明确「< 5」）。
   *      - DISTINCT student_id 去重（一个学员可能多个 active 课包）。
   *
   *   3. handover = listInactiveWithPending 返回的员工数（复用 UserRepository 同口径）
   *      - 口径：users.status='停用'（离职）且 (pending_opps + pending_contracts + pending_students) > 0
   *        - pending_opps      = COUNT(opportunities WHERE owner_user_id = u.id)
   *        - pending_contracts = COUNT(contracts WHERE owner_user_id = u.id
   *                                AND status IN ('pending','active') AND deleted_at IS NULL)
   *        - pending_students  = COUNT(students WHERE owner_sales_id = u.id)
   *      - 即「离职但名下仍有数据待转交」的员工数（与 b/home「待交接」待办语义一致）。
   *      - 复用 userRepo.listInactiveWithPending().length（同一 SQL，不另造聚合）。
   */
  async getHomeAlerts(tenantSchema: string): Promise<HomeAlertStats> {
    let lowBalance = 0;
    let refundPending = 0;
    let handover = 0;

    // 1. refundPending — V59 refund_orders.status='pending'
    try {
      const rows = await this.pg.tenantQuery<{ count: string }>(
        tenantSchema,
        `SELECT COUNT(*) AS count FROM refund_orders WHERE status = 'pending'`,
      );
      refundPending = parseInt(rows[0]?.count || '0', 10);
    } catch (e) {
      // refund_orders 表不存在（旧租户未 apply V59）→ 0
      this.logger.debug(`[ALERTS-refundPending] ${tenantSchema}: ${(e as Error).message}`);
    }

    // 2. lowBalance — V12 student_course_packages 剩余课时 < 5（拍板阈值）
    try {
      const rows = await this.pg.tenantQuery<{ count: string }>(
        tenantSchema,
        `SELECT COUNT(DISTINCT student_id) AS count
           FROM student_course_packages
          WHERE status = 'active' AND remaining_lessons < 5`,
      );
      lowBalance = parseInt(rows[0]?.count || '0', 10);
    } catch (e) {
      this.logger.debug(`[ALERTS-lowBalance] ${tenantSchema}: ${(e as Error).message}`);
    }

    // 3. handover — 复用 UserRepository.listInactiveWithPending 同口径（离职 + 名下有数据待转交）
    try {
      const inactive = await this.userRepo.listInactiveWithPending(tenantSchema);
      handover = inactive.length;
    } catch (e) {
      this.logger.debug(`[ALERTS-handover] ${tenantSchema}: ${(e as Error).message}`);
    }

    return { lowBalance, refundPending, handover };
  }

  // ===================== Sales Funnel =====================
  /**
   * 销售漏斗聚合 — V2 opportunities 表 8 阶段折叠为 3 状态展示
   *
   * 数据来源（必须真接 V2）：
   *   tenant_xxx.opportunities (PRIMARY KEY id, stage, lost_reason, ...)
   *   stage 8 枚举值（V2 业务定义）：
   *     初步接触 / 需求诊断 / 已预约试听 / 已试听待转化 /
   *     已出方案 / 谈单中 / 已报名 / 已失单
   *
   * UI 3 状态映射（2026-06-02 SSOT §3.-2 C 走查续批 II — 逆转原 5 阶段展示）：
   *   following = 初步接触 + 需求诊断 + 已预约试听   （跟进中）
   *   trial     = 已试听待转化 + 已出方案 + 谈单中    （已试听）
   *   deal      = 已报名                              （成交）
   *
   *   已失单 = 流失终态，不入 3 状态（保留下方「流失原因」lossReasons 区单独统计）。
   *
   * conversionPct（相邻阶段转化率）对 3 状态自然适用：跟进中 → 已试听 → 成交。
   *
   * 错误兜底：
   *   - 表存在但无数据 → 返回 3 状态全 0
   *   - 表不存在（旧租户 schema 缺迁移）→ 返回 3 状态全 0 + lossReasons 空数组
   */
  async getSalesFunnel(
    tenantSchema: string,
    options: { campusId?: string; ownerUserId?: string } = {},
  ): Promise<SalesFunnel> {
    const STAGE_MAP: Array<{ key: string; label: string; pgStages: string[] }> = [
      { key: 'following', label: '跟进中', pgStages: ['初步接触', '需求诊断', '已预约试听'] },
      { key: 'trial',     label: '已试听', pgStages: ['已试听待转化', '已出方案', '谈单中'] },
      { key: 'deal',      label: '成交',   pgStages: ['已报名'] },
    ];

    let stages: SalesFunnelStage[] = [];
    let overallConversion = 0;

    // V26 老板视角校区切换：campusId 提供时按校区过滤；undefined = 全机构
    // 2026-05-25 #3 闭环：ownerUserId 提供时按 owner_user_id 过滤（销售看自己的漏斗）
    //   admin/boss = 不传 ownerUserId 看全机构
    //   sales/sales_manager = 传 ownerUserId 看自己/团队（controller 解析 'me' → req.user.sub）
    const whereClauses: string[] = [];
    const params: any[] = [];
    if (options.campusId) {
      params.push(options.campusId);
      whereClauses.push(`campus_id = $${params.length}`);
    }
    if (options.ownerUserId) {
      params.push(options.ownerUserId);
      whereClauses.push(`owner_user_id = $${params.length}`);
    }
    const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    try {
      const rows = await this.pg.tenantQuery<{
        stage: string;
        count: string;
      }>(
        tenantSchema,
        `SELECT stage, COUNT(*) as count
         FROM opportunities
         ${where}
         GROUP BY stage`,
        params,
      );
      const stageCounts = new Map<string, number>();
      for (const r of rows) {
        stageCounts.set(r.stage, parseInt(r.count, 10));
      }

      // 聚合 3 状态
      const stageNumbers = STAGE_MAP.map((m) => ({
        key: m.key,
        label: m.label,
        count: m.pgStages.reduce(
          (sum, ps) => sum + (stageCounts.get(ps) || 0),
          0,
        ),
      }));

      const top = stageNumbers[0]?.count || 0;
      const last = stageNumbers[stageNumbers.length - 1]?.count || 0;
      stages = stageNumbers.map((s, i) => {
        const prev = i === 0 ? s.count : stageNumbers[i - 1].count;
        const conversionPct =
          prev === 0 ? 0 : Math.round((s.count * 100) / prev);
        return { ...s, conversionPct };
      });
      overallConversion = top === 0 ? 0 : Math.round((last * 100) / top);
    } catch (e) {
      // opportunities 表不存在 → 返回零值（新租户尚未启用销售漏斗）
      this.logger.debug(`[FUNNEL] ${tenantSchema}: ${(e as Error).message}`);
      stages = [
        { key: 'following', label: '跟进中', count: 0, conversionPct: 0 },
        { key: 'trial',     label: '已试听', count: 0, conversionPct: 0 },
        { key: 'deal',      label: '成交',   count: 0, conversionPct: 0 },
      ];
    }

    // 流失原因 Top3（基于 opportunities.lost_reason，V26 同样按 campusId 过滤）
    // 2026-05-25 #3 闭环：复用上方 params 拼接 ownerUserId（与 stages 同 filter 保持一致）
    let lossReasons: Array<{ reason: string; pct: number }> = [];
    try {
      const lossExtra = whereClauses.length > 0 ? ` AND ${whereClauses.join(' AND ')}` : '';
      const lossWhere = `WHERE stage = '已失单' AND lost_reason IS NOT NULL${lossExtra}`;
      const rows = await this.pg.tenantQuery<{
        reason: string;
        count: string;
      }>(
        tenantSchema,
        `SELECT lost_reason as reason, COUNT(*) as count
         FROM opportunities
         ${lossWhere}
         GROUP BY lost_reason
         ORDER BY count DESC
         LIMIT 3`,
        params,
      );
      const total = rows.reduce((s, r) => s + parseInt(r.count, 10), 0);
      lossReasons = rows.map((r) => ({
        reason: r.reason,
        pct: total === 0 ? 0 : Math.round((parseInt(r.count, 10) * 100) / total),
      }));
    } catch (e) {
      // opportunities 表不存在 → 不展示流失原因
      this.logger.debug(`[FUNNEL-LOSS] ${tenantSchema}: ${(e as Error).message}`);
      lossReasons = [];
    }

    return { stages, overallConversion, lossReasons };
  }

  // ===================== Teacher Leaderboard =====================
  async getTeacherLeaderboard(
    tenantSchema: string,
    options: { month?: string; sortBy?: LeaderboardSortKey } = {},
  ): Promise<TeacherLeaderboard> {
    // V37: 默认 sortBy 由 'payroll' 改为 'lessons'（薪资下线）
    const sortBy = options.sortBy || 'lessons';
    const month = options.month || new Date().toISOString().slice(0, 7);
    const monthStart = new Date(`${month}-01T00:00:00Z`);
    const monthEnd = new Date(monthStart);
    monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);

    let teachers: TeacherLeaderboardItem[] = [];
    try {
      // V37: 老师基础 + 课时数（删 payroll SUM；薪资业务下线，仅留课时统计）
      const rows = await this.pg.tenantQuery<{
        id: string;
        name: string;
        subject: string;
        avatar: string | null;
        lessons: string;
      }>(
        tenantSchema,
        `WITH lesson_stats AS (
           SELECT
             cc.teacher_id,
             COUNT(*)::int as lessons
           FROM course_consumptions cc
           WHERE cc.status = 'confirmed'
             AND cc.confirmed_at >= $1 AND cc.confirmed_at < $2
           GROUP BY cc.teacher_id
         )
         SELECT
           t.id,
           t.name,
           COALESCE(t.subjects[1], '未设定') as subject,
           t.avatar_url as avatar,
           COALESCE(ls.lessons, 0) as lessons
         FROM teachers t
         LEFT JOIN lesson_stats ls ON ls.teacher_id = t.id
         WHERE t.status = 'active' AND t.deleted_at IS NULL
         ORDER BY ls.lessons DESC NULLS LAST`,
        [monthStart, monthEnd],
      );

      // 反馈率：feedbacks / consumptions
      // 简化：直接对每个老师求 feedbacks 数 + consumptions 数
      const feedbackRows = await this.pg.tenantQuery<{
        teacher_id: string;
        fb_count: string;
        cc_count: string;
      }>(
        tenantSchema,
        `SELECT
           t.id as teacher_id,
           (SELECT COUNT(*) FROM lesson_feedbacks lf
             WHERE lf.teacher_id = t.id
               AND lf.submitted_at >= $1 AND lf.submitted_at < $2) as fb_count,
           (SELECT COUNT(*) FROM course_consumptions cc
             WHERE cc.teacher_id = t.id
               AND cc.created_at >= $1 AND cc.created_at < $2) as cc_count
         FROM teachers t
         WHERE t.status = 'active' AND t.deleted_at IS NULL`,
        [monthStart, monthEnd],
      );
      const fbRateMap = new Map<string, number>();
      for (const fr of feedbackRows) {
        const fb = parseInt(fr.fb_count, 10);
        const cc = parseInt(fr.cc_count, 10);
        fbRateMap.set(fr.teacher_id, cc === 0 ? 0 : Math.round((fb * 100) / cc));
      }

      // V24: rating 真接 teacher_ratings
      const ratingMap = new Map<string, number>();
      try {
        const ratingRows = await this.pg.tenantQuery<{ teacher_id: string; avg_stars: string | null }>(
          tenantSchema,
          `SELECT teacher_id, avg_stars FROM teacher_ratings`,
        );
        for (const r of ratingRows) {
          if (r.avg_stars !== null) ratingMap.set(r.teacher_id, Number(r.avg_stars));
        }
      } catch (e) {
        this.logger.debug(`[V24-rating] ${tenantSchema}: ${(e as Error).message}`);
      }

      // V37: trend 块整体删除（Option A）
      //   原依赖 monthly_aggregates.payroll_yuan 上月对比，但
      //   1) V37 已 DROP payroll_yuan 列；
      //   2) cron 未实现 monthly_aggregates 写入，trend 一直返 'flat'，无业务价值；
      //   3) 拍板 fields-by-role.md 全角色 home 不展示工资 → trend 失去 KPI 依据。
      //   未来需要 trend 应改基于 lessons / rating / feedbackRate 而非 payroll。

      teachers = rows.map((r, idx) => ({
        rank: idx + 1,
        id: r.id,
        name: r.name,
        subject: r.subject,
        avatar: r.avatar || undefined,
        lessons: Number(r.lessons || 0),
        rating: ratingMap.get(r.id) ?? null,
        feedbackRate: fbRateMap.get(r.id) ?? 0,
      }));

      // V37: 排序键删 payroll
      const sortFn: Record<LeaderboardSortKey, (a: TeacherLeaderboardItem, b: TeacherLeaderboardItem) => number> = {
        lessons: (a, b) => b.lessons - a.lessons,
        rating: (a, b) => (b.rating ?? -1) - (a.rating ?? -1),
        feedbackRate: (a, b) => b.feedbackRate - a.feedbackRate,
      };
      teachers.sort(sortFn[sortBy]);
      teachers = teachers.map((t, idx) => ({ ...t, rank: idx + 1 }));
    } catch (e) {
      // 表不存在或字段缺 → 空 leaderboard
      this.logger.debug(`[LEADERBOARD] ${tenantSchema}: ${(e as Error).message}`);
      teachers = [];
    }

    // V37: 删 totalPayroll（薪资下线）
    const ratings = teachers.map((t) => t.rating).filter((r): r is number => r !== null);
    const avgRating =
      ratings.length === 0
        ? null
        : Math.round((ratings.reduce((s, r) => s + r, 0) / ratings.length) * 10) / 10;

    return {
      activeMonth: month,
      summary: {
        count: teachers.length,
        avgRating,
      },
      teachers,
    };
  }
}
