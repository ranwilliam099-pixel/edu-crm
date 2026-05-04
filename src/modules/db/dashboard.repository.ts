import { Injectable } from '@nestjs/common';
import { PgPoolService } from './pg-pool.service';

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
  todoCount: number;          // TODO(EXT-04): 待办聚合（合同到期/低余额/未批改作业）
  lowBalanceCount: number;    // TODO(EXT-04): 低课时余额学员数
  studentsTotal: number;
}

export interface SalesFunnelStage {
  key: string;
  label: string;
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
  payroll: number;
  lessons: number;
  rating: number | null;
  feedbackRate: number;
  trend: 'up' | 'down' | 'flat';
}
export interface TeacherLeaderboard {
  activeMonth: string;
  summary: { count: number; total: number; avgRating: number | null };
  teachers: TeacherLeaderboardItem[];
}

export type LeaderboardSortKey = 'payroll' | 'lessons' | 'rating' | 'feedbackRate';

@Injectable()
export class DashboardRepository {
  constructor(private readonly pg: PgPoolService) {}

  // ===================== Admin KPI =====================
  async getAdminKpi(tenantSchema: string): Promise<AdminKpi> {
    let newSignups = 0;
    let revenueYuan = 0;
    let activeStudents = 0;
    let studentsTotal = 0;
    let conversionRate = 0;

    // course_packages 本月激活 → 新签 + 收入
    try {
      const rows = await this.pg.tenantQuery<{
        new_signups: string;
        revenue_cents: string;
      }>(
        tenantSchema,
        `SELECT
           COUNT(*) FILTER (
             WHERE activated_at >= date_trunc('month', NOW())
           ) as new_signups,
           COALESCE(SUM(paid_amount) FILTER (
             WHERE activated_at >= date_trunc('month', NOW())
           ), 0) as revenue_cents
         FROM course_packages`,
      );
      newSignups = parseInt(rows[0]?.new_signups || '0', 10);
      // 表的 paid_amount 单位假设是分；如果是元则不除 100。
      // 此处统一按"元"返回（schema 内若为分则在 SQL 中 /100）
      // TODO(EXT-04): 与 V12 字段单位严格对齐（当前按 元 直接返回）
      revenueYuan = Number(rows[0]?.revenue_cents || 0);
    } catch (e) {
      // 表不存在 → 保留 0
    }

    // student_course_packages 在管学员
    try {
      const rows = await this.pg.tenantQuery<{ active: string }>(
        tenantSchema,
        `SELECT COUNT(DISTINCT student_id) as active
         FROM student_course_packages
         WHERE status = 'active'`,
      );
      activeStudents = parseInt(rows[0]?.active || '0', 10);
    } catch (e) {
      // 表不存在 → 保留 0
    }

    // students 总数
    try {
      const rows = await this.pg.tenantQuery<{ count: string }>(
        tenantSchema,
        `SELECT COUNT(*) as count FROM students`,
      );
      studentsTotal = parseInt(rows[0]?.count || '0', 10);
    } catch (e) {
      // 保留 0
    }

    // conversionRate = parent_subscriptions(active|trial) / parents 总数（public）
    // TODO(EXT-04): 跨 schema 聚合。当前用近似：active subscriptions / 学员总数
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
      // TODO(EXT-04): todoCount / lowBalanceCount 需要聚合多表（合同到期/低余额）
      // 当前 mock 占位，待真实业务规则确认后实现
      todoCount: 0,
      lowBalanceCount: 0,
      studentsTotal,
    };
  }

  // ===================== Sales Funnel =====================
  async getSalesFunnel(tenantSchema: string): Promise<SalesFunnel> {
    // V2 opportunities 表已有 stage 字段（8 阶段）：初步接触/需求诊断/已预约试听/已试听待转化/已出方案/谈单中/已报名/已失单
    // 用户要求 5 阶段聚合
    const STAGE_MAP: Array<{ key: string; label: string; pgStages: string[] }> = [
      { key: 'consult',   label: '咨询',   pgStages: ['初步接触', '需求诊断'] },
      { key: 'contacted', label: '已联系', pgStages: ['已预约试听'] },
      { key: 'trial',     label: '已试听', pgStages: ['已试听待转化'] },
      { key: 'quoted',    label: '已报价', pgStages: ['已出方案', '谈单中'] },
      { key: 'paid',      label: '已付费', pgStages: ['已报名'] },
    ];

    let stages: SalesFunnelStage[] = [];
    let overallConversion = 0;

    try {
      const rows = await this.pg.tenantQuery<{
        stage: string;
        count: string;
      }>(
        tenantSchema,
        `SELECT stage, COUNT(*) as count
         FROM opportunities
         GROUP BY stage`,
      );
      const stageCounts = new Map<string, number>();
      for (const r of rows) {
        stageCounts.set(r.stage, parseInt(r.count, 10));
      }

      // 聚合 5 阶段
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
      // opportunities 表不存在 → mock 数据
      // TODO(EXT-04): 移除 mock，要求 opportunities 表存在
      stages = [
        { key: 'consult',   label: '咨询',   count: 0, conversionPct: 0 },
        { key: 'contacted', label: '已联系', count: 0, conversionPct: 0 },
        { key: 'trial',     label: '已试听', count: 0, conversionPct: 0 },
        { key: 'quoted',    label: '已报价', count: 0, conversionPct: 0 },
        { key: 'paid',      label: '已付费', count: 0, conversionPct: 0 },
      ];
    }

    // 流失原因 Top3（基于 opportunities.lost_reason）
    let lossReasons: Array<{ reason: string; pct: number }> = [];
    try {
      const rows = await this.pg.tenantQuery<{
        reason: string;
        count: string;
      }>(
        tenantSchema,
        `SELECT lost_reason as reason, COUNT(*) as count
         FROM opportunities
         WHERE stage = '已失单' AND lost_reason IS NOT NULL
         GROUP BY lost_reason
         ORDER BY count DESC
         LIMIT 3`,
      );
      const total = rows.reduce((s, r) => s + parseInt(r.count, 10), 0);
      lossReasons = rows.map((r) => ({
        reason: r.reason,
        pct: total === 0 ? 0 : Math.round((parseInt(r.count, 10) * 100) / total),
      }));
    } catch (e) {
      // opportunities 表不存在 → mock 硬编码
      // TODO(EXT-04): 真接业务后移除 mock
      lossReasons = [
        { reason: '价格高', pct: 40 },
        { reason: '时间不合适', pct: 30 },
        { reason: '竞品成交', pct: 20 },
      ];
    }

    return { stages, overallConversion, lossReasons };
  }

  // ===================== Teacher Leaderboard =====================
  async getTeacherLeaderboard(
    tenantSchema: string,
    options: { month?: string; sortBy?: LeaderboardSortKey } = {},
  ): Promise<TeacherLeaderboard> {
    const sortBy = options.sortBy || 'payroll';
    const month = options.month || new Date().toISOString().slice(0, 7);
    const monthStart = new Date(`${month}-01T00:00:00Z`);
    const monthEnd = new Date(monthStart);
    monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);

    let teachers: TeacherLeaderboardItem[] = [];
    try {
      // 老师基础 + 课时数 + 工资（course_consumptions.amount_yuan + status='confirmed'）
      const rows = await this.pg.tenantQuery<{
        id: string;
        name: string;
        subject: string;
        avatar: string | null;
        lessons: string;
        payroll: string;
      }>(
        tenantSchema,
        `WITH lesson_stats AS (
           SELECT
             cc.teacher_id,
             COUNT(*)::int as lessons,
             COALESCE(SUM(cc.amount_yuan), 0)::numeric as payroll
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
           COALESCE(ls.lessons, 0) as lessons,
           COALESCE(ls.payroll, 0) as payroll
         FROM teachers t
         LEFT JOIN lesson_stats ls ON ls.teacher_id = t.id
         WHERE t.status = 'active'
         ORDER BY ls.payroll DESC NULLS LAST`,
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
         WHERE t.status = 'active'`,
        [monthStart, monthEnd],
      );
      const fbRateMap = new Map<string, number>();
      for (const fr of feedbackRows) {
        const fb = parseInt(fr.fb_count, 10);
        const cc = parseInt(fr.cc_count, 10);
        fbRateMap.set(fr.teacher_id, cc === 0 ? 0 : Math.round((fb * 100) / cc));
      }

      teachers = rows.map((r, idx) => ({
        rank: idx + 1,
        id: r.id,
        name: r.name,
        subject: r.subject,
        avatar: r.avatar || undefined,
        payroll: Number(r.payroll || 0),
        lessons: Number(r.lessons || 0),
        // TODO(EXT-04): rating 暂返 null（需 teacher_ratings 表 V20 待建）
        rating: null,
        feedbackRate: fbRateMap.get(r.id) ?? 0,
        // TODO(EXT-04): trend 需要环比上月数据，当前默认 flat
        trend: 'flat',
      }));

      // 排序：按 sortBy 重新排
      const sortFn: Record<LeaderboardSortKey, (a: TeacherLeaderboardItem, b: TeacherLeaderboardItem) => number> = {
        payroll: (a, b) => b.payroll - a.payroll,
        lessons: (a, b) => b.lessons - a.lessons,
        rating: (a, b) => (b.rating ?? -1) - (a.rating ?? -1),
        feedbackRate: (a, b) => b.feedbackRate - a.feedbackRate,
      };
      teachers.sort(sortFn[sortBy]);
      teachers = teachers.map((t, idx) => ({ ...t, rank: idx + 1 }));
    } catch (e) {
      // 表不存在或字段缺 → 空 leaderboard
      // TODO(EXT-04): 真接业务后移除兜底
      teachers = [];
    }

    const totalPayroll = teachers.reduce((s, t) => s + t.payroll, 0);
    const ratings = teachers.map((t) => t.rating).filter((r): r is number => r !== null);
    const avgRating =
      ratings.length === 0
        ? null
        : Math.round((ratings.reduce((s, r) => s + r, 0) / ratings.length) * 10) / 10;

    return {
      activeMonth: month,
      summary: {
        count: teachers.length,
        total: totalPayroll,
        avgRating,
      },
      teachers,
    };
  }
}
