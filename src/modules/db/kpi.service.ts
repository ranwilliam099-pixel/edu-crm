import { Injectable, Logger } from '@nestjs/common';
import { PgPoolService } from './pg-pool.service';

/**
 * KpiService — admin/boss home KPI Level 2 下钻聚合（2026-05-20 拍板）
 *
 * 来源：
 *   - SSOT §3.1 老板 home 4 KPI 组（Level 1 卡 tap → Level 2 聚合 page）
 *   - SSOT §3.2 校长 home mirror 老板结构 + scope 限本校
 *   - SSOT §6 操作权限矩阵 2026-05-20 新增 kpi.*.read = [admin, boss]
 *
 * 4 endpoint 对应 4 个 KPI 组：
 *   1. signed       — 本月新签：sales 前 + academic 后（5/16 Q1 修订）
 *   2. renewal      — 本月续约：academic 前 + sales 后（5/16 Q1 修订）
 *   3. consumption  — 本月消课：仅 academic 聚合
 *   4. studentActivity — 学员状态：按校区分桶活跃 vs 不活跃
 *
 * 30 天滚动窗口：所有 KPI 时间窗 = NOW() - INTERVAL '30 days' AT TIMEZONE 'UTC'
 *   - 本月口径 = 滚动 30 天（不用 date_trunc('month') 避开月初零值 + 月末高峰失真）
 *   - SSOT §3.1 说"本月"为业务文案，技术口径用滚动 30 天匹配 home Level 1 卡数据
 *
 * scope filter（A04 防 client-controlled scope）：
 *   - admin 不强制 campus filter（看全 tenant），可选 campusIds 多选过滤
 *   - boss 强制 callerCampusId = jwt.campusId（即便 client 传他校 → controller 抛 403）
 *
 * 不写 audit_log（KPI 是高频读路径，前端缓存 30-60s；越权由 RBAC + scope guard 拦截）
 */

export interface KpiAggregateRow {
  userId: string;
  name: string;
  amountYuanRaw: number;
  count: number;
  rankText: string;
  amountText: string;
}

export interface SignedKpiResult {
  total: { amount: string; count: number };
  sales: KpiAggregateRow[];
  academic: KpiAggregateRow[];
}

export interface RenewalKpiResult {
  total: { amount: string; count: number };
  sales: KpiAggregateRow[];
  academic: KpiAggregateRow[];
}

export interface ConsumptionKpiRow {
  userId: string;
  name: string;
  hoursText: string;
  hoursRaw: number;
  lessonsCount: number;
  rankText: string;
}

export interface ConsumptionKpiResult {
  total: { hours: number; lessons: number };
  academic: ConsumptionKpiRow[];
}

export interface CampusActivityBreakdownRow {
  campusId: string;
  campusName: string;
  activeCount: number;
  totalCount: number;
  rate: string;
}

export interface StudentActivityKpiResult {
  total: { activeStudents: number; totalStudents: number; activityRate: string };
  campusBreakdown: CampusActivityBreakdownRow[];
}

/**
 * 2026-05-21 销售视角 home KPI（拍板：销售自己的 home 必须接真接口）
 *   personalSigned   本月签约金额 + 笔数 (contracts SUM by owner_user_id, 30 天窗口)
 *   customersInProgress  在跟客户数 (opportunities count by owner_user_id, stage NOT IN [已报名,已失单])
 *   trialRate        试听转化率（Sprint Y 后端补 schedule + status 分析）
 */
export interface SalesHomeKpiResult {
  personalSigned: { amount: string; count: number; rankText: string };
  customersInProgress: { count: number };
  trialRate: { rate: string; total: number };
}

/**
 * 格式化金额：1234567 → '¥1,234,567'
 */
function formatAmountText(yuan: number): string {
  if (!Number.isFinite(yuan) || yuan <= 0) return '¥0';
  const rounded = Math.round(yuan);
  return `¥${rounded.toLocaleString('en-US')}`;
}

/**
 * 格式化金额（无前缀，主用于 total.amount）：1234567 → '1,234,567'
 */
function formatPlainAmount(yuan: number): string {
  if (!Number.isFinite(yuan) || yuan <= 0) return '0';
  return Math.round(yuan).toLocaleString('en-US');
}

/**
 * 格式化课时数（保留 1 位小数）
 */
function formatHoursText(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return '0';
  return (Math.round(hours * 10) / 10).toLocaleString('en-US');
}

/**
 * 格式化百分比：0.825 → '82.5%'
 */
function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '0%';
  const pct = Math.round(ratio * 1000) / 10;
  return `${pct}%`;
}

/**
 * 排名文案：1 → '第 1'
 */
function formatRank(rank: number): string {
  return `第 ${rank}`;
}

@Injectable()
export class KpiService {
  private readonly logger = new Logger(KpiService.name);

  constructor(private readonly pg: PgPoolService) {}

  /**
   * 构造 campus IN 子句 — 注入下一个 param 序号
   *
   * 返回 { clause, params } 其中 clause 形如 `AND c.campus_id IN ($N,$N+1,...)` 或 ''
   * 调用方需保证 paramStart 是 SQL 模板中下一个 $ 序号
   */
  private buildCampusFilter(
    column: string,
    campusIds: string[] | null,
    paramStart: number,
  ): { clause: string; params: string[] } {
    if (!campusIds || campusIds.length === 0) return { clause: '', params: [] };
    const placeholders = campusIds
      .map((_, i) => `$${paramStart + i}`)
      .join(',');
    return {
      clause: ` AND ${column} IN (${placeholders})`,
      params: campusIds.slice(),
    };
  }

  /**
   * 1. 本月新签 KPI — orderType IN ('新签'), signed_at 30 天内 + status='active' or 'pending'
   *
   * 按 contracts.owner_user_id JOIN users 取 role → 分桶 sales / academic
   * - sales 角色（sales/sales_manager）→ sales 数组
   * - academic 角色（academic/academic_admin）→ academic 数组
   * - 其他 role（admin/boss 自签）→ 不进任何数组（不算业绩）
   */
  async getSignedKpi(
    tenantSchema: string,
    options: { campusIds: string[] | null },
  ): Promise<SignedKpiResult> {
    const campusFilter = this.buildCampusFilter('c.campus_id', options.campusIds, 1);

    try {
      const rows = await this.pg.tenantQuery<{
        owner_user_id: string;
        owner_name: string | null;
        owner_role: string;
        total_amount: string;
        count: string;
      }>(
        tenantSchema,
        `SELECT
           c.owner_user_id,
           u.name AS owner_name,
           u.role AS owner_role,
           COALESCE(SUM(c.total_amount), 0) AS total_amount,
           COUNT(*) AS count
         FROM contracts c
         LEFT JOIN users u ON u.id = c.owner_user_id
         WHERE c.order_type = '新签'
           AND c.signed_at >= NOW() - INTERVAL '30 days'
           AND c.status IN ('active','pending')
           AND c.deleted_at IS NULL
           AND c.owner_user_id IS NOT NULL${campusFilter.clause}
         GROUP BY c.owner_user_id, u.name, u.role
         ORDER BY total_amount DESC`,
        campusFilter.params,
      );

      return this.bucketContractRowsBySalesAcademic(rows);
    } catch (e) {
      this.logger.error(
        `[KPI-signed] ${tenantSchema}: ${(e as Error).message}`,
      );
      return this.emptySignedRenewal();
    }
  }

  /**
   * 2. 本月续约 KPI — orderType IN ('续费','扩科','升班','转班')
   *
   * 同 signed 一样按 owner_user_id JOIN users.role 分桶，但 OrderType 限续约系列。
   * SSOT §3.1 组 2: "本月续约金额 + 续约人数"
   */
  async getRenewalKpi(
    tenantSchema: string,
    options: { campusIds: string[] | null },
  ): Promise<RenewalKpiResult> {
    const campusFilter = this.buildCampusFilter('c.campus_id', options.campusIds, 1);

    try {
      const rows = await this.pg.tenantQuery<{
        owner_user_id: string;
        owner_name: string | null;
        owner_role: string;
        total_amount: string;
        count: string;
      }>(
        tenantSchema,
        `SELECT
           c.owner_user_id,
           u.name AS owner_name,
           u.role AS owner_role,
           COALESCE(SUM(c.total_amount), 0) AS total_amount,
           COUNT(*) AS count
         FROM contracts c
         LEFT JOIN users u ON u.id = c.owner_user_id
         WHERE c.order_type IN ('续费','扩科','升班','转班')
           AND c.signed_at >= NOW() - INTERVAL '30 days'
           AND c.status IN ('active','pending')
           AND c.deleted_at IS NULL
           AND c.owner_user_id IS NOT NULL${campusFilter.clause}
         GROUP BY c.owner_user_id, u.name, u.role
         ORDER BY total_amount DESC`,
        campusFilter.params,
      );

      return this.bucketContractRowsBySalesAcademic(rows);
    } catch (e) {
      this.logger.error(
        `[KPI-renewal] ${tenantSchema}: ${(e as Error).message}`,
      );
      return this.emptySignedRenewal();
    }
  }

  /**
   * 3. 消课 KPI — course_consumptions.status='confirmed' + confirmed_at 30 天内
   *
   * 按 schedule.created_by_user_id JOIN users → 教务（academic / academic_admin）
   * - schedules.created_by_role 字段历史值可能含 'teacher' / 'sales'（5/12 之前旧数据），
   *   Wave 11 改造后新写入 = 'academic'。本聚合用 users.role 二次校验避免旧数据干扰。
   * - course_consumptions.amount_yuan 可能为 NULL（contract 未带价 + V50 删除 teachers.hourly_price_yuan）
   *   → COALESCE 0 兜底，hoursText 按 schedule.duration_min/60 算
   */
  async getConsumptionKpi(
    tenantSchema: string,
    options: { campusIds: string[] | null },
  ): Promise<ConsumptionKpiResult> {
    const campusFilter = this.buildCampusFilter('sc.campus_id', options.campusIds, 1);

    try {
      const rows = await this.pg.tenantQuery<{
        academic_user_id: string;
        academic_name: string | null;
        total_hours: string;
        lessons_count: string;
      }>(
        tenantSchema,
        `SELECT
           sc.created_by_user_id AS academic_user_id,
           u.name AS academic_name,
           COALESCE(SUM(sc.duration_min) / 60.0, 0) AS total_hours,
           COUNT(*) AS lessons_count
         FROM course_consumptions cc
         JOIN schedules sc ON sc.id = cc.schedule_id
         LEFT JOIN users u ON u.id = sc.created_by_user_id
         WHERE cc.status = 'confirmed'
           AND cc.confirmed_at >= NOW() - INTERVAL '30 days'
           AND u.role IN ('academic','academic_admin')${campusFilter.clause}
         GROUP BY sc.created_by_user_id, u.name
         ORDER BY total_hours DESC`,
        campusFilter.params,
      );

      const academic: ConsumptionKpiRow[] = [];
      let totalHours = 0;
      let totalLessons = 0;

      rows.forEach((r, idx) => {
        const hours = Number(r.total_hours ?? 0);
        const count = parseInt(r.lessons_count, 10) || 0;
        totalHours += hours;
        totalLessons += count;
        academic.push({
          userId: r.academic_user_id,
          name: r.academic_name ?? '未知',
          hoursText: formatHoursText(hours),
          hoursRaw: Math.round(hours * 10) / 10,
          lessonsCount: count,
          rankText: formatRank(idx + 1),
        });
      });

      return {
        total: {
          hours: Math.round(totalHours * 10) / 10,
          lessons: totalLessons,
        },
        academic,
      };
    } catch (e) {
      this.logger.error(
        `[KPI-consumption] ${tenantSchema}: ${(e as Error).message}`,
      );
      return { total: { hours: 0, lessons: 0 }, academic: [] };
    }
  }

  /**
   * 4. 学员活跃度 KPI — 30 天内有 schedule.status='已完成' 的学员
   *
   * SSOT §3.1 组 4: "活跃学员 + 不活跃学员 + 活跃率"
   *
   * 输出按 campus 分桶（即使 boss 单校也返单 row campusBreakdown）
   * - JOIN campuses 拿 campus name（public.campuses 跨 schema fallback）
   * - 不返学员明细（Level 3 下钻另查；本 KPI 只返聚合数）
   *
   * NOTE：campusBreakdown JOIN public.campuses (cross-schema)。tenantQuery search_path
   * = tenant_X, public 兜底，所以 students.campus_id 可被 LEFT JOIN public.campuses 找到。
   */
  async getStudentActivityKpi(
    tenantSchema: string,
    options: { campusIds: string[] | null },
  ): Promise<StudentActivityKpiResult> {
    const campusFilter = this.buildCampusFilter(
      's.campus_id',
      options.campusIds,
      1,
    );

    try {
      const rows = await this.pg.tenantQuery<{
        campus_id: string | null;
        campus_name: string | null;
        active_count: string;
        total_count: string;
      }>(
        tenantSchema,
        `WITH active_30d AS (
           SELECT DISTINCT sc.student_id
           FROM course_consumptions cc
           JOIN schedules sc ON sc.id = cc.schedule_id
           WHERE cc.confirmed_at >= NOW() - INTERVAL '30 days'
             AND cc.status = 'confirmed'
         )
         SELECT
           s.campus_id,
           ca.name AS campus_name,
           COUNT(*) FILTER (WHERE a.student_id IS NOT NULL) AS active_count,
           COUNT(*) AS total_count
         FROM students s
         LEFT JOIN active_30d a ON a.student_id = s.id
         LEFT JOIN campuses ca ON ca.id = s.campus_id
         WHERE s.deleted_at IS NULL${campusFilter.clause}
         GROUP BY s.campus_id, ca.name
         ORDER BY total_count DESC`,
        campusFilter.params,
      );

      const campusBreakdown: CampusActivityBreakdownRow[] = [];
      let activeStudents = 0;
      let totalStudents = 0;

      for (const r of rows) {
        const active = parseInt(r.active_count, 10) || 0;
        const total = parseInt(r.total_count, 10) || 0;
        const ratio = total === 0 ? 0 : active / total;
        activeStudents += active;
        totalStudents += total;
        campusBreakdown.push({
          campusId: r.campus_id ?? 'unknown',
          campusName: r.campus_name ?? '未分配',
          activeCount: active,
          totalCount: total,
          rate: formatPercent(ratio),
        });
      }

      const overallRatio = totalStudents === 0 ? 0 : activeStudents / totalStudents;

      return {
        total: {
          activeStudents,
          totalStudents,
          activityRate: formatPercent(overallRatio),
        },
        campusBreakdown,
      };
    } catch (e) {
      this.logger.error(
        `[KPI-student-activity] ${tenantSchema}: ${(e as Error).message}`,
      );
      return {
        total: { activeStudents: 0, totalStudents: 0, activityRate: '0%' },
        campusBreakdown: [],
      };
    }
  }

  // ============================================================
  // helpers
  // ============================================================

  /**
   * 把 contracts JOIN users 后的聚合行按 role 分到 sales / academic 桶
   * - 同时返回 total（含全部桶累计金额 + count，不限 role）
   * - 排名按金额降序 1-based
   */
  private bucketContractRowsBySalesAcademic(
    rows: Array<{
      owner_user_id: string;
      owner_name: string | null;
      owner_role: string;
      total_amount: string;
      count: string;
    }>,
  ): { total: { amount: string; count: number }; sales: KpiAggregateRow[]; academic: KpiAggregateRow[] } {
    const sales: KpiAggregateRow[] = [];
    const academic: KpiAggregateRow[] = [];
    let totalAmount = 0;
    let totalCount = 0;

    // 临时 buffer 先全部入桶，再各桶 sort + rank
    const buffer: Array<{
      bucket: 'sales' | 'academic' | 'other';
      row: KpiAggregateRow;
    }> = [];

    for (const r of rows) {
      const amount = Number(r.total_amount ?? 0);
      const count = parseInt(r.count, 10) || 0;
      totalAmount += amount;
      totalCount += count;
      const item: KpiAggregateRow = {
        userId: r.owner_user_id,
        name: r.owner_name ?? '未知',
        amountYuanRaw: Math.round(amount * 100) / 100,
        count,
        amountText: formatAmountText(amount),
        rankText: '', // 占位，下一段 fill
      };
      const role = r.owner_role;
      if (role === 'sales' || role === 'sales_manager') {
        buffer.push({ bucket: 'sales', row: item });
      } else if (role === 'academic' || role === 'academic_admin') {
        buffer.push({ bucket: 'academic', row: item });
      } else {
        // admin/boss/finance 自签 → 算入 total 但不进 sales/academic 排行（业绩按角色归属）
        buffer.push({ bucket: 'other', row: item });
      }
    }

    // sort + rank within each bucket（SQL 已经 ORDER BY total_amount DESC，但跨 role 混在一起需重新切分排名）
    const salesItems = buffer
      .filter((b) => b.bucket === 'sales')
      .map((b) => b.row)
      .sort((a, b) => b.amountYuanRaw - a.amountYuanRaw);
    const academicItems = buffer
      .filter((b) => b.bucket === 'academic')
      .map((b) => b.row)
      .sort((a, b) => b.amountYuanRaw - a.amountYuanRaw);

    salesItems.forEach((it, idx) => {
      it.rankText = formatRank(idx + 1);
      sales.push(it);
    });
    academicItems.forEach((it, idx) => {
      it.rankText = formatRank(idx + 1);
      academic.push(it);
    });

    return {
      total: {
        amount: formatPlainAmount(totalAmount),
        count: totalCount,
      },
      sales,
      academic,
    };
  }

  private emptySignedRenewal(): {
    total: { amount: string; count: number };
    sales: KpiAggregateRow[];
    academic: KpiAggregateRow[];
  } {
    return {
      total: { amount: '0', count: 0 },
      sales: [],
      academic: [],
    };
  }

  /**
   * 2026-05-21 销售自视角 home KPI
   *   SQL 直查 contracts (owner_user_id=salesUserId, signed_at 30d 内) + opportunities (在跟数)
   *   salesUserId 来自 JWT req.user.sub（controller 层传入），无需 client 提供
   *   trialRate 暂留 0（Sprint Y 后端补：trial schedule 数 / consult 总数 = 转化率）
   */
  async getSalesHomeKpi(
    tenantSchema: string,
    salesUserId: string,
  ): Promise<SalesHomeKpiResult> {
    if (!salesUserId) {
      return this.emptySalesHome();
    }

    // 1. personalSigned: 本月（30 天滚动）签约金额 + 笔数
    const signedRows = await this.pg.tenantQuery<{
      total_amount: string | number;
      cnt: string | number;
    }>(
      tenantSchema,
      `SELECT
         COALESCE(SUM(total_amount), 0) AS total_amount,
         COUNT(*) AS cnt
       FROM contracts
       WHERE owner_user_id = $1
         AND signed_at >= NOW() - INTERVAL '30 days'
         AND deleted_at IS NULL`,
      [salesUserId],
    );
    const personalAmount = Number(signedRows[0]?.total_amount || 0);
    const personalCount = Number(signedRows[0]?.cnt || 0);

    // 2. customersInProgress: 在跟客户数（owner_user_id=me + stage 进行中）
    const inProgressRows = await this.pg.tenantQuery<{ cnt: string | number }>(
      tenantSchema,
      `SELECT COUNT(DISTINCT id) AS cnt
       FROM opportunities
       WHERE owner_user_id = $1
         AND stage NOT IN ('已报名','已失单')`,
      [salesUserId],
    );
    const inProgressCount = Number(inProgressRows[0]?.cnt || 0);

    // 3. trialRate: Sprint Y 后端补 schedule + status 分析
    return {
      personalSigned: {
        amount: formatPlainAmount(personalAmount),
        count: personalCount,
        rankText: '— / —',  // Sprint Y: 销售团队排名 GROUP BY owner_user_id
      },
      customersInProgress: { count: inProgressCount },
      trialRate: { rate: '0', total: 0 },
    };
  }

  private emptySalesHome(): SalesHomeKpiResult {
    return {
      personalSigned: { amount: '0', count: 0, rankText: '— / —' },
      customersInProgress: { count: 0 },
      trialRate: { rate: '0', total: 0 },
    };
  }
}
