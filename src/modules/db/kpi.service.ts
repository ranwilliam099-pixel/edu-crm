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
 * 2026-05-22 Level 3 明细 — 4 KPI list endpoint 数据契约 (signed/renewal items)
 *
 *   contract 明细: 合同维度, 一行一份合同
 */
export interface KpiContractItem {
  contractId: string;
  studentId: string;
  studentName: string;
  courseProductName: string | null;
  totalAmount: number;
  totalAmountText: string;
  signedAt: string;
  signedAtText: string;     // 'M/D'
  ownerUserId: string | null;
  ownerName: string | null;
  ownerRole: string | null;
  orderType: string;
}

/**
 * consumption items: schedule + course_consumption JOIN, 一行一节已消课
 */
export interface KpiConsumptionItem {
  scheduleId: string;
  studentId: string;
  studentName: string;
  teacherName: string | null;
  courseProductName: string | null;
  startAt: string;
  startAtText: string;
  durationMin: number;
  confirmedAt: string;
}

/**
 * student-activity items: 学员维度, 含最近 30d 课时数 + 活跃状态
 */
export interface KpiStudentActivityItem {
  studentId: string;
  studentName: string;
  campusName: string | null;
  lessons30d: number;
  lastAttendedAt: string | null;
  isActive: boolean;     // 30d 内有 confirmed consumption 即活跃
}

export interface KpiListResult<T> {
  items: T[];
  total: number;
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
 * 2026-05-22 Sprint Y 老师视角 home KPI（SSOT §3.5 拍板）
 *   todayLessons          今日课时 + 最近一节课距今多久（schedules.teacher_id=me, start_at::date=今）
 *   primaryStudents       主带学员数 + 本周未填反馈（student_teacher_bindings active）
 *   monthlyReferrals      本月家长推荐成功（parent_referrals.teacher_id=me, status=rated, rated_at 30d 内）
 *   monthlyAttendance     本月上课 / 请假 / 调课（schedules 30d 内 by teacher_id + leaves 30d 内）
 *   todos                 待办事项数组（今日课表 + 超 24h 未填反馈 + 月报 finalize）
 *
 * teacherId 推导：JWT.sub = users.id → teachers WHERE user_id = sub → teachers.id
 *   （5/9 拍板：teachers.user_id NULLABLE，登录账户的老师必有 user_id）
 *   若 user_id 找不到对应 teacher → 全部返 0 fallback（避免抛错破坏 home 体验）
 */
export interface TeacherHomeTodo {
  id: string;          // ULID 或 stable hash（前端 list key）
  title: string;       // 主标题
  meta?: string;       // 副标题（学员名 / 学科 etc）
  time?: string;       // ISO timestamp 字符串（前端格式化）
  type: 'today_lesson' | 'feedback_overdue' | 'monthly_report' | 'referral_pending';
}
export interface TeacherHomeKpiResult {
  todayLessons: { count: number; lastLessonAgoMin: number };
  primaryStudents: { count: number; pendingFeedback: number };
  monthlyReferrals: { count: number };
  monthlyAttendance: { taught: number; leave: number; swap: number };
  todos: TeacherHomeTodo[];
  // 2026-05-22 SSOT §6.8 KPI 4 字段（V56 monthly_kpi_targets 表数据源）
  kpiSummary?: MonthlyKpiSummary;
}

/**
 * 2026-05-22 SSOT §6.8 KPI 4 字段 — 月度统一指标
 *   target     消课目标（monthly_kpi_targets.target_lessons / 无下发则 0）
 *   scheduled  已排课节数（COUNT schedule WHERE start_at in 本月）
 *   attended   已消课节数（schedule.status='已完成'）— V8 中文 enum
 *   forecast   预计消课 = scheduled - attended - absent（未来还会消的）
 */
export interface MonthlyKpiSummary {
  target: number;
  scheduled: number;
  attended: number;
  forecast: number;
}

/**
 * 2026-05-22 Sprint Y 教务视角 home KPI（SSOT §3.4 拍板）
 *   handoverBacklog       待接交接单（opportunity stage='已报名' 但无 schedule）+ 本周已排完
 *   expiringContracts     30 天到期合同（student_course_packages.expires_at < NOW + 30d）
 *   monthlyReferrals      本月转介绍（parent_referrals.status='rated' 30d 内 + 本校 scope）
 *   unreadConsultations   未读家长咨询（占位 0，parent_communication 表 Sprint 后续）
 *   todos                 待办: 销售刚交接未排课 / 30 天到期推续费 / 老师请假需调课
 *
 * scope: academic / academic_admin 本校 = jwt.campusId
 *   - admin / boss 走 §3.1/§3.2 admin KPI；academic 角色才进本 endpoint
 *   - 本校 scope: campus_id IN ($jwt.campusId)（A04 防 client-controlled scope）
 *   - academic_admin 可批办，但仍限本校（SSOT §3.4 「本校 scope」）
 */
export interface AcademicHomeTodo {
  id: string;
  title: string;
  meta?: string;
  time?: string;
  type:
    | 'sales_handover'        // 销售刚交接未排课
    | 'contract_expiring'     // 30 天到期合同
    | 'teacher_leave_pending' // 老师请假未排课
    | 'trial_followup';       // 家长试听到期咨询
}
export interface AcademicHomeKpiResult {
  handoverBacklog: { count: number; weeklyScheduled: number };
  expiringContracts: { count: number };
  monthlyReferrals: { count: number };
  unreadConsultations: { count: number };
  todos: AcademicHomeTodo[];
  // 2026-05-22 SSOT §6.8 KPI 4 字段（V56 monthly_kpi_targets 表数据源）
  kpiSummary?: MonthlyKpiSummary;
  // 2026-05-22 用户拍板: 教务 home 主区显示续约金额（4 件事之一「续约」职责）
  //   query contracts WHERE order_type='续费' AND signed_at in 本月 sum(total_amount)
  renewalAmount?: number;
}

/**
 * 2026-05-22 Sprint Y P1: 财务 home KPI (SSOT §3.6)
 *   pendingInvoices     待开发票 count
 *   issuedThisMonth     本月已开票 amount + count
 *   refundsThisMonth    本月退费 amount + count (contracts.reverse_type='退款')
 *   todos               待办 (待开发票 preview 5 条)
 */
export interface FinanceHomeTodo {
  id: string;
  title: string;
  meta?: string;
  time?: string;
  type: 'invoice_pending' | 'refund_pending';
}
export interface FinanceHomeKpiResult {
  pendingInvoices: { count: number };
  issuedThisMonth: { amount: string; count: number };
  refundsThisMonth: { amount: string; count: number };
  todos: FinanceHomeTodo[];
}

/**
 * 2026-06-02 SSOT §3.-2 A「课程销量」— admin/boss 经营首页组 4 替换「学员状态」
 *
 * Level 2（课程销量排名）数据契约：
 *   - 本月（date_trunc('month', NOW()) 当前自然月）+ status ∉ {cancelled,refunded}
 *     + deleted_at IS NULL + campus_id = JWT.campusId（强制本校 scope，禁信前端）
 *   - GROUP BY course_product_id → salesCount DESC
 *   - total = Σ salesCount（= home Level1 KPI「本月课程销量 N」）
 *
 * 安全：campusId 一律 JWT；缺 campusId → controller 403（仿 trial.requireCampusId）。
 */
export interface CourseSalesItem {
  courseProductId: string | null;
  productName: string | null;
  salesCount: number;
}
export interface CourseSalesResult {
  total: number;
  items: CourseSalesItem[];
}

/**
 * 2026-06-02 SSOT §3.-2 A Level 3（某课程的人员销量）数据契约：
 *   - 同窗口/campus-scope，但 WHERE course_product_id = $courseProductId
 *   - GROUP BY owner_user_id → salesCount DESC，LEFT JOIN users 取 salesName
 *   - salesName 用 users.name（非一级 PII，对齐既有 salesName 先例）
 *   - owner_user_id 为 null 的合同归「系统」
 */
export interface CourseSalesByPersonItem {
  salesUserId: string | null;
  salesName: string;
  salesCount: number;
}
export interface CourseSalesByPersonResult {
  productName: string | null;
  items: CourseSalesByPersonItem[];
}

/**
 * 2026-06-02 SSOT §3.-2 E「消课数据双维度排名」数据契约：
 *   本月（confirmed_at 落自然月）+ course_consumptions.status='confirmed' + 本校 campus-scope
 *   两维度（tab 切换），各按 lessonCount DESC：
 *     - teacher：GROUP BY schedules.teacher_id（谁教的，LEFT JOIN teachers 取 name）
 *     - academic：GROUP BY schedules.created_by_user_id WHERE created_by_role ∈
 *       (academic, academic_admin)（谁排的课；admin/boss 自排不计入教务维度），
 *       LEFT JOIN users 取 name
 *   每条 confirmed consumption 计 1 节（lessonCount）。id/teacher_id 为 null 兜底「未知」。
 */
export interface ConsumptionRankingItem {
  id: string | null;
  name: string;
  lessonCount: number;
}
export interface ConsumptionRankingResult {
  teacher: ConsumptionRankingItem[];
  academic: ConsumptionRankingItem[];
}

/**
 * 2026-05-22 SSOT §6.8 校长下发月度目标 DTO
 */
export interface SetMonthlyTargetDto {
  campusId: string;
  targetRole: 'academic' | 'teacher';
  targetUserId: string;
  month: string;          // 'YYYY-MM' 格式
  targetLessons: number;
  setByBossUserId: string;
  note?: string;
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
    // 2026-05-22 修历史 bug: students 表无 campus_id 字段 (schema check 确认)
    //   campus_id 在 customers 表 — JOIN customers 取
    const campusFilter = this.buildCampusFilter(
      'cu.campus_id',
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
           SELECT DISTINCT cc.student_id
           FROM course_consumptions cc
           WHERE cc.confirmed_at >= NOW() - INTERVAL '30 days'
             AND cc.status = 'confirmed'
         )
         SELECT
           cu.campus_id,
           ca.name AS campus_name,
           COUNT(*) FILTER (WHERE a.student_id IS NOT NULL) AS active_count,
           COUNT(*) AS total_count
         FROM students s
         JOIN customers cu ON cu.id = s.customer_id
         LEFT JOIN active_30d a ON a.student_id = s.id
         LEFT JOIN campuses ca ON ca.id = cu.campus_id
         WHERE s.deleted_at IS NULL${campusFilter.clause}
         GROUP BY cu.campus_id, ca.name
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
  /**
   * 2026-05-23 (task #34): home attention 预警通用数据源
   *   - refundPending: V59 refund_orders WHERE status='pending' COUNT
   *     - finance: 限本 campus (jwt.campusId scope)
   *     - boss/admin: 跨 campus
   *     - 其他角色: 0 (不看退费)
   *   - lowBalance / handover: 暂 0 (待 Sprint 后续接通真实数据源)
   *
   * fail-open: SQL 失败返 0, 不阻塞 home
   */
  async getHomeAlerts(
    tenantSchema: string,
    ctx: { role: string; campusId?: string | null },
  ): Promise<{ lowBalance: number; refundPending: number; handover: number }> {
    const empty = { lowBalance: 0, refundPending: 0, handover: 0 };
    if (!tenantSchema) return empty;

    let refundPending = 0;
    // 退费预警: finance/boss/admin 可看 (SSOT §4.4 教学人员不看)
    if (ctx.role === 'finance' || ctx.role === 'boss' || ctx.role === 'admin') {
      try {
        const params: any[] = [];
        let where = "status = 'pending'";
        if (ctx.role === 'finance' && ctx.campusId) {
          params.push(ctx.campusId);
          where += ` AND campus_id = $${params.length}`;
        }
        const rows = await this.pg.tenantQuery<{ c: string }>(
          tenantSchema,
          `SELECT COUNT(*)::text AS c FROM refund_orders WHERE ${where}`,
          params,
        );
        refundPending = parseInt(rows[0]?.c || '0', 10) || 0;
      } catch (e) {
        // V59 表可能未 backfill 或 query fail → fail-open 返 0
        this.logger.warn(
          `[home-alerts] refund_orders query failed: ${(e as Error).message}`,
        );
      }
    }

    return { lowBalance: 0, refundPending, handover: 0 };
  }

  async getSalesHomeKpi(
    tenantSchema: string,
    salesUserId: string,
    campusId?: string | null,
  ): Promise<SalesHomeKpiResult> {
    if (!salesUserId) {
      return this.emptySalesHome();
    }

    // 1. personalSigned: 本月（30 天滚动）签约金额 + 笔数
    //   2026-06-01 Sprint Y 口径修正：排除 status='cancelled'（已取消合同不计入本月新签额），
    //   与 computeSalesMonthlyRank 排名口径一致（否则「我的金额」含取消单但排名分母不含 → 自相矛盾）。
    //   contracts.status 枚举(V25 CHECK) = pending/active/expired/cancelled，无 'refunded'
    //   （退款走 V59 refund_orders / payments.refund_status，不改 contracts.status）；
    //   保留 'refunded' 字面与 rank 查询文本对齐 + 未来若加该态自然生效（当前永不命中、无副作用）。
    //   expired（已到期）仍计入：合同曾有效签约，只是过期，属正常业绩。
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
         AND status NOT IN ('cancelled','refunded')
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

    // 3. rankText: 单校区内本月签约额排名（SSOT §3.3① 2026-05-31 拍板）
    //   - 分组：同一 users.campus_id 的销售线用户（sales + sales_manager）
    //   - 排序：本月（当前自然月 signed_at）签约额降序，status ∉ {cancelled,refunded}
    //   - 只返我的 1-based 名次，绝不返他人金额（同校也只看名次不看数额）
    //   - 本校 < 1 人 或 我无 campus_id → '— / —'
    const rankText = await this.computeSalesMonthlyRank(
      tenantSchema,
      salesUserId,
      campusId ?? null,
    );

    // 4. trialRate: 试听转化率（SSOT §3.3② 2026-05-31 拍板）
    //   - 分母 total = 我名下 stage IN ('已试听待转化','已出方案','谈单中','已报名') 客户数（已试听及之后）
    //   - 分子 = 我名下 stage = '已报名' 客户数（已转化签约）
    //   - rate = Math.round(分子/分母*100) 字符串；分母 0 → { rate:'0', total:0 }
    const trialRate = await this.computeSalesTrialRate(tenantSchema, salesUserId);

    return {
      personalSigned: {
        amount: formatPlainAmount(personalAmount),
        count: personalCount,
        rankText,
      },
      customersInProgress: { count: inProgressCount },
      trialRate,
    };
  }

  /**
   * 单校区内本月签约额排名（SSOT §3.3① 2026-05-31 拍板）
   *
   * 口径：
   *   - 同 campus_id 的销售线用户（role IN sales/sales_manager）按本月签约额降序
   *   - 本月签约额 = contracts.signed_at 落当前自然月 + status ∉ {cancelled,refunded}
   *     的 total_amount 合计，GROUP BY owner_user_id
   *   - 1-based 名次 X / 参与人数 Y → "第 X / 共 Y"
   *
   * 安全：只返我的名次，不暴露任何他人金额；全 tenantSchema scoped。
   * fail-open：聚合失败 → '— / —'（不破坏 home 渲染）。
   *
   * @param campusId 当前销售 JWT.campusId（null/空 → '— / —'）
   */
  private async computeSalesMonthlyRank(
    tenantSchema: string,
    salesUserId: string,
    campusId: string | null,
  ): Promise<string> {
    if (!campusId) return '— / —';
    try {
      // 同校区销售线用户 → 本月签约额（无合同的销售 LEFT JOIN 计 0 也参与排名）
      //   date_trunc('month', NOW()) 取当前自然月起点（与「本月」口径一致）
      const rows = await this.pg.tenantQuery<{
        owner_user_id: string;
        amount: string | number;
      }>(
        tenantSchema,
        `SELECT u.id AS owner_user_id,
                COALESCE(SUM(c.total_amount), 0) AS amount
           FROM users u
           LEFT JOIN contracts c
             ON c.owner_user_id = u.id
            AND c.deleted_at IS NULL
            AND c.signed_at >= date_trunc('month', NOW())
            AND c.signed_at < date_trunc('month', NOW()) + INTERVAL '1 month'
            AND c.status NOT IN ('cancelled','refunded')
          WHERE u.campus_id = $1
            AND u.role IN ('sales','sales_manager')
            AND u.deleted_at IS NULL
          GROUP BY u.id`,
        [campusId],
      );
      const total = rows.length;
      if (total < 1) return '— / —';
      // 降序排名（金额相同按 owner_user_id 稳定排序，确保名次确定）
      const sorted = rows
        .map((r) => ({ id: r.owner_user_id, amount: Number(r.amount || 0) }))
        .sort((a, b) => b.amount - a.amount || a.id.localeCompare(b.id));
      const idx = sorted.findIndex((r) => r.id === salesUserId);
      if (idx < 0) return '— / —'; // 我不在本校销售线（理论不该发生）
      return `第 ${idx + 1} / 共 ${total}`;
    } catch (e) {
      this.logger.warn(
        `[sales-home] rank compute failed for ${salesUserId}: ${(e as Error).message}`,
      );
      return '— / —';
    }
  }

  /**
   * 试听转化率（SSOT §3.3② 2026-05-31 拍板）
   *
   * 口径（owner = 当前销售；基于 opportunity stage 真实枚举）：
   *   - 分母 total = stage IN ('已试听待转化','已出方案','谈单中','已报名')（已试听及之后）
   *   - 分子       = stage = '已报名'（已转化签约）
   *   - rate = 分母>0 ? Math.round(分子/分母*100) 字符串 : '0'
   *
   * fail-open：聚合失败 → { rate:'0', total:0 }。
   */
  private async computeSalesTrialRate(
    tenantSchema: string,
    salesUserId: string,
  ): Promise<{ rate: string; total: number }> {
    try {
      const rows = await this.pg.tenantQuery<{
        denom: string | number;
        numer: string | number;
      }>(
        tenantSchema,
        // stage 真实枚举(V2 CHECK): 初步接触/需求诊断/已预约试听/已试听待转化/已出方案/谈单中/已报名/已失单
        // 漏斗 trial 桶 = 已试听待转化(dashboard.repository 映射)。分母 = 已试听及之后(已 trial 过)。
        `SELECT
           COUNT(*) FILTER (WHERE stage IN ('已试听待转化','已出方案','谈单中','已报名')) AS denom,
           COUNT(*) FILTER (WHERE stage = '已报名') AS numer
         FROM opportunities
         WHERE owner_user_id = $1`,
        [salesUserId],
      );
      const denom = Number(rows[0]?.denom || 0);
      const numer = Number(rows[0]?.numer || 0);
      if (denom <= 0) return { rate: '0', total: 0 };
      return { rate: String(Math.round((numer / denom) * 100)), total: denom };
    } catch (e) {
      this.logger.warn(
        `[sales-home] trialRate compute failed for ${salesUserId}: ${(e as Error).message}`,
      );
      return { rate: '0', total: 0 };
    }
  }

  private emptySalesHome(): SalesHomeKpiResult {
    return {
      personalSigned: { amount: '0', count: 0, rankText: '— / —' },
      customersInProgress: { count: 0 },
      trialRate: { rate: '0', total: 0 },
    };
  }

  /**
   * 2026-05-22 Sprint Y 老师 home KPI（SSOT §3.5 拍板）
   *
   * 子查询独立 try-catch + fail-open：单个聚合失败不影响其他卡片渲染。
   * 若 teacher record 找不到（user_id ≠ teachers.user_id）整体返空，前端展示「-」占位。
   *
   * @param tenantSchema 租户 schema
   * @param userId       JWT.sub 用户 ID（公网 RBAC 限 teacher，controller 保证）
   */
  async getTeacherHomeKpi(
    tenantSchema: string,
    userId: string,
  ): Promise<TeacherHomeKpiResult> {
    if (!userId) {
      return this.emptyTeacherHome();
    }

    // Step 0: user_id → teacher_id（teachers.user_id NULLABLE，登录账户的老师必有 user_id）
    let teacherId: string | null = null;
    try {
      const teacherRows = await this.pg.tenantQuery<{ id: string }>(
        tenantSchema,
        `SELECT id FROM teachers WHERE user_id = $1 AND status != '归档' LIMIT 1`,
        [userId],
      );
      teacherId = teacherRows[0]?.id ?? null;
    } catch (e) {
      this.logger.error(
        `[KPI-teacher-home] resolve teacherId failed for ${userId}: ${(e as Error).message}`,
      );
    }
    if (!teacherId) {
      // teacher 档案不存在或被归档 → 全部 0 返回（不抛错，home 兜底渲染）
      this.logger.warn(
        `[KPI-teacher-home] no active teacher for user_id=${userId} in ${tenantSchema}`,
      );
      return this.emptyTeacherHome();
    }

    // Step 1: 今日课时 + 最近一节课距今多久
    let todayLessons = { count: 0, lastLessonAgoMin: 0 };
    try {
      const todayRows = await this.pg.tenantQuery<{ cnt: string; last_minutes: string | null }>(
        tenantSchema,
        `SELECT
           COUNT(*) AS cnt,
           EXTRACT(EPOCH FROM (NOW() - MAX(start_at))) / 60 AS last_minutes
         FROM schedules
         WHERE teacher_id = $1
           AND start_at::date = CURRENT_DATE
           AND status != '已取消'`,
        [teacherId],
      );
      const cnt = parseInt(todayRows[0]?.cnt || '0', 10);
      const last = todayRows[0]?.last_minutes
        ? Math.max(0, Math.round(Number(todayRows[0].last_minutes)))
        : 0;
      todayLessons = { count: cnt, lastLessonAgoMin: last };
    } catch (e) {
      this.logger.error(
        `[KPI-teacher-home] todayLessons failed: ${(e as Error).message}`,
      );
    }

    // Step 2: 主带学员数 + 本周未填反馈
    //   主带学员 = student_teacher_bindings.status='active' 且 teacher_id=me
    //   本周未填反馈 = schedules 本周（CURRENT_DATE - 7d）有 schedule, 但 lesson_feedbacks 无对应
    let primaryStudents = { count: 0, pendingFeedback: 0 };
    try {
      const psRows = await this.pg.tenantQuery<{ cnt: string }>(
        tenantSchema,
        `SELECT COUNT(DISTINCT student_id) AS cnt
         FROM student_teacher_bindings
         WHERE teacher_id = $1 AND status = 'active'`,
        [teacherId],
      );
      const pCount = parseInt(psRows[0]?.cnt || '0', 10);

      const pendingRows = await this.pg.tenantQuery<{ cnt: string }>(
        tenantSchema,
        `SELECT COUNT(*) AS cnt
         FROM schedules s
         WHERE s.teacher_id = $1
           AND s.start_at >= NOW() - INTERVAL '7 days'
           AND s.start_at < NOW()
           AND s.status IN ('已完成','已排课')
           AND NOT EXISTS (
             SELECT 1 FROM lesson_feedbacks lf
             WHERE lf.schedule_id = s.id AND lf.teacher_id = $1
           )`,
        [teacherId],
      );
      const pendingFeedback = parseInt(pendingRows[0]?.cnt || '0', 10);

      primaryStudents = { count: pCount, pendingFeedback };
    } catch (e) {
      this.logger.error(
        `[KPI-teacher-home] primaryStudents failed: ${(e as Error).message}`,
      );
    }

    // Step 3: 本月推荐成功（parent_referrals.teacher_id=me, status=rated, rated_at 30d 内）
    let monthlyReferrals = { count: 0 };
    try {
      const refRows = await this.pg.tenantQuery<{ cnt: string }>(
        tenantSchema,
        `SELECT COUNT(*) AS cnt
         FROM parent_referrals
         WHERE teacher_id = $1
           AND status = 'rated'
           AND rated_at >= NOW() - INTERVAL '30 days'`,
        [teacherId],
      );
      monthlyReferrals = { count: parseInt(refRows[0]?.cnt || '0', 10) };
    } catch (e) {
      this.logger.error(
        `[KPI-teacher-home] monthlyReferrals failed: ${(e as Error).message}`,
      );
    }

    // Step 4: 本月考勤（taught / leave / swap）
    //   taught = schedules.status='已完成' 30d 内
    //   leave  = leaves type='leave' 30d 内（按 schedule.teacher_id 反查）
    //   swap   = leaves type='reschedule' 30d 内
    let monthlyAttendance = { taught: 0, leave: 0, swap: 0 };
    try {
      const taughtRows = await this.pg.tenantQuery<{ cnt: string }>(
        tenantSchema,
        `SELECT COUNT(*) AS cnt
         FROM schedules
         WHERE teacher_id = $1
           AND status = '已完成'
           AND start_at >= NOW() - INTERVAL '30 days'`,
        [teacherId],
      );
      const leaveRows = await this.pg.tenantQuery<{ leave_cnt: string; swap_cnt: string }>(
        tenantSchema,
        `SELECT
           COUNT(*) FILTER (WHERE l.type = 'leave') AS leave_cnt,
           COUNT(*) FILTER (WHERE l.type = 'reschedule') AS swap_cnt
         FROM leaves l
         JOIN schedules s ON s.id = l.lesson_id
         WHERE s.teacher_id = $1
           AND l.created_at >= NOW() - INTERVAL '30 days'`,
        [teacherId],
      );
      monthlyAttendance = {
        taught: parseInt(taughtRows[0]?.cnt || '0', 10),
        leave: parseInt(leaveRows[0]?.leave_cnt || '0', 10),
        swap: parseInt(leaveRows[0]?.swap_cnt || '0', 10),
      };
    } catch (e) {
      this.logger.error(
        `[KPI-teacher-home] monthlyAttendance failed: ${(e as Error).message}`,
      );
    }

    // Step 5: 待办（todos）— 今日剩余课表 + 超 24h 未填反馈 + 待 finalize 月报
    const todos: TeacherHomeTodo[] = [];
    try {
      // 今日剩余课表（start_at >= NOW，CURRENT_DATE 当天）
      const todayTodoRows = await this.pg.tenantQuery<{
        id: string;
        start_at: string;
        notes: string | null;
      }>(
        tenantSchema,
        `SELECT id, start_at, notes
         FROM schedules
         WHERE teacher_id = $1
           AND start_at >= NOW()
           AND start_at::date = CURRENT_DATE
           AND status != '已取消'
         ORDER BY start_at ASC LIMIT 5`,
        [teacherId],
      );
      for (const r of todayTodoRows) {
        todos.push({
          id: `lesson-${r.id}`,
          title: '今日待上课',
          meta: r.notes ?? '',
          time: new Date(r.start_at).toISOString(),
          type: 'today_lesson',
        });
      }

      // 超 24h 未填反馈
      const overdueRows = await this.pg.tenantQuery<{ id: string; start_at: string }>(
        tenantSchema,
        `SELECT s.id, s.start_at
         FROM schedules s
         WHERE s.teacher_id = $1
           AND s.start_at < NOW() - INTERVAL '24 hours'
           AND s.start_at >= NOW() - INTERVAL '14 days'
           AND s.status IN ('已完成','已排课')
           AND NOT EXISTS (
             SELECT 1 FROM lesson_feedbacks lf
             WHERE lf.schedule_id = s.id AND lf.teacher_id = $1
           )
         ORDER BY s.start_at DESC LIMIT 5`,
        [teacherId],
      );
      for (const r of overdueRows) {
        todos.push({
          id: `feedback-${r.id}`,
          title: '超 24h 未填反馈',
          meta: '请尽快补填课后反馈',
          time: new Date(r.start_at).toISOString(),
          type: 'feedback_overdue',
        });
      }

      // 待 finalize 月报（status='auto_generated' AND finalized_at IS NULL）
      const reportRows = await this.pg.tenantQuery<{ id: string; month: string }>(
        tenantSchema,
        `SELECT id, month FROM monthly_reports
         WHERE teacher_id = $1
           AND status = 'auto_generated'
           AND finalized_at IS NULL
         ORDER BY month DESC LIMIT 3`,
        [teacherId],
      );
      for (const r of reportRows) {
        todos.push({
          id: `report-${r.id}`,
          title: '月报待 finalize',
          meta: r.month,
          type: 'monthly_report',
        });
      }
    } catch (e) {
      this.logger.error(
        `[KPI-teacher-home] todos failed: ${(e as Error).message}`,
      );
    }

    return {
      todayLessons,
      primaryStudents,
      monthlyReferrals,
      monthlyAttendance,
      todos,
    };
  }

  private emptyTeacherHome(): TeacherHomeKpiResult {
    return {
      todayLessons: { count: 0, lastLessonAgoMin: 0 },
      primaryStudents: { count: 0, pendingFeedback: 0 },
      monthlyReferrals: { count: 0 },
      monthlyAttendance: { taught: 0, leave: 0, swap: 0 },
      todos: [],
    };
  }

  /**
   * 2026-05-22 Sprint Y 教务 home KPI（SSOT §3.4）
   *
   * @param tenantSchema 租户 schema
   * @param campusId     本校 scope（jwt.campusId，必填）— A04 防 client-controlled scope
   *
   * 单卡 fail-open：sub-query 抛错 → 该卡 0 返回不影响整体 home。
   */
  async getAcademicHomeKpi(
    tenantSchema: string,
    campusId: string,
  ): Promise<AcademicHomeKpiResult> {
    if (!campusId) {
      // 跨校组 academic 拍板不存在（academic/academic_admin 都是单校），但兜底返空
      return this.emptyAcademicHome();
    }

    // 1. handoverBacklog: 销售刚交接未排课（opportunity stage='已报名' + 无 schedule）+ 本周已排完
    //    "已报名" 即销售签单完毕；下一步必须由教务排课才能开始消课
    //    join contracts 取 student_id 反查 schedules.teacher_id（无 schedule 即未排课）
    let handoverBacklog = { count: 0, weeklyScheduled: 0 };
    try {
      // 2026-05-22 修历史 bug: 用 c.campus_id (V52 已加 contracts.campus_id) 替 s.campus_id (不存在)
      const backlogRows = await this.pg.tenantQuery<{ cnt: string }>(
        tenantSchema,
        `SELECT COUNT(DISTINCT c.id) AS cnt
         FROM contracts c
         WHERE c.status = 'active'
           AND c.signed_at >= NOW() - INTERVAL '30 days'
           AND c.deleted_at IS NULL
           AND c.campus_id = $1
           AND NOT EXISTS (
             SELECT 1 FROM schedule_students ss
             WHERE ss.student_id = c.student_id
           )`,
        [campusId],
      );
      // 2026-05-22 修历史 bug: schedules.campus_id 已由 V52 添加, 直接用 s.campus_id 不必 JOIN students
      const scheduledRows = await this.pg.tenantQuery<{ cnt: string }>(
        tenantSchema,
        `SELECT COUNT(DISTINCT s.id) AS cnt
         FROM schedules s
         WHERE s.created_at >= NOW() - INTERVAL '7 days'
           AND s.campus_id = $1
           AND s.status != '已取消'`,
        [campusId],
      );
      handoverBacklog = {
        count: parseInt(backlogRows[0]?.cnt || '0', 10),
        weeklyScheduled: parseInt(scheduledRows[0]?.cnt || '0', 10),
      };
    } catch (e) {
      this.logger.error(
        `[KPI-academic-home] handoverBacklog failed: ${(e as Error).message}`,
      );
    }

    // 2. expiringContracts: 30 天到期合同（student_course_packages.expires_at <= NOW + 30d 且 status='active'）
    let expiringContracts = { count: 0 };
    try {
      // 2026-05-22 修历史 bug: students 无 campus_id, JOIN customers 用 cu.campus_id
      const expRows = await this.pg.tenantQuery<{ cnt: string }>(
        tenantSchema,
        `SELECT COUNT(DISTINCT scp.id) AS cnt
         FROM student_course_packages scp
         JOIN students st ON st.id = scp.student_id
         JOIN customers cu ON cu.id = st.customer_id
         WHERE scp.status = 'active'
           AND scp.expires_at <= NOW() + INTERVAL '30 days'
           AND scp.expires_at > NOW()
           AND cu.campus_id = $1`,
        [campusId],
      );
      expiringContracts = { count: parseInt(expRows[0]?.cnt || '0', 10) };
    } catch (e) {
      this.logger.error(
        `[KPI-academic-home] expiringContracts failed: ${(e as Error).message}`,
      );
    }

    // 3. monthlyReferrals: 本月推荐成功（parent_referrals 30d 内 status='rated' + 本校 scope）
    //    通过 teacher_id JOIN teachers 限本校 campus_id
    let monthlyReferrals = { count: 0 };
    try {
      const refRows = await this.pg.tenantQuery<{ cnt: string }>(
        tenantSchema,
        `SELECT COUNT(*) AS cnt
         FROM parent_referrals pr
         JOIN teachers t ON t.id = pr.teacher_id
         WHERE pr.status = 'rated'
           AND pr.rated_at >= NOW() - INTERVAL '30 days'
           AND t.campus_id = $1`,
        [campusId],
      );
      monthlyReferrals = { count: parseInt(refRows[0]?.cnt || '0', 10) };
    } catch (e) {
      this.logger.error(
        `[KPI-academic-home] monthlyReferrals failed: ${(e as Error).message}`,
      );
    }

    // 4. unreadConsultations: 未读家长咨询 (V57 parent_communication 2026-05-22 Sprint Y P2)
    //    SQL: COUNT WHERE campus_id=本校 + sender_role='parent' + read_at IS NULL
    //    fail-open: 旧 tenant 未 backfill V57 → 返 0 不阻塞 home
    let unreadConsultations = { count: 0 };
    try {
      const unreadRows = await this.pg.tenantQuery<{ cnt: string }>(
        tenantSchema,
        `SELECT COUNT(*) AS cnt
         FROM parent_communication
         WHERE campus_id = $1
           AND sender_role = 'parent'
           AND read_at IS NULL`,
        [campusId],
      );
      unreadConsultations = { count: parseInt(unreadRows[0]?.cnt || '0', 10) };
    } catch (e) {
      // V57 backfill 未跑 (表不存在) → fail-open 返 0
      this.logger.warn(
        `[KPI-academic-home] unreadConsultations failed (V57 backfill 未跑?): ${(e as Error).message}`,
      );
    }

    // 5. todos: 待办（聚合 3 类，每类 LIMIT 5 防爆）
    const todos: AcademicHomeTodo[] = [];
    try {
      // 5a. 销售刚交接未排课 — 取 contracts 30d 内签 + 无 schedule_students 的学员
      const handoverRows = await this.pg.tenantQuery<{
        id: string;
        student_name: string;
        signed_at: string;
      }>(
        tenantSchema,
        // 2026-05-22 修双 bug: students.name 字段名是 student_name / s.campus_id 不存在用 c.campus_id (V52)
        `SELECT c.id, s.student_name, c.signed_at
         FROM contracts c
         JOIN students s ON s.id = c.student_id
         WHERE c.status = 'active'
           AND c.signed_at >= NOW() - INTERVAL '30 days'
           AND c.deleted_at IS NULL
           AND c.campus_id = $1
           AND NOT EXISTS (
             SELECT 1 FROM schedule_students ss
             WHERE ss.student_id = c.student_id
           )
         ORDER BY c.signed_at DESC LIMIT 5`,
        [campusId],
      );
      for (const r of handoverRows) {
        todos.push({
          id: `handover-${r.id}`,
          title: '销售已交接，需排课',
          meta: r.student_name,
          time: new Date(r.signed_at).toISOString(),
          type: 'sales_handover',
        });
      }

      // 5b. 30 天到期合同 — 取 student_course_packages.expires_at <= NOW + 30d 的学员
      const expiringRows = await this.pg.tenantQuery<{
        id: string;
        student_name: string;
        expires_at: string;
      }>(
        tenantSchema,
        // 2026-05-22 修双 bug: students.name 实际字段 student_name / JOIN customers 取 campus_id
        `SELECT scp.id, st.student_name, scp.expires_at
         FROM student_course_packages scp
         JOIN students st ON st.id = scp.student_id
         JOIN customers cu ON cu.id = st.customer_id
         WHERE scp.status = 'active'
           AND scp.expires_at <= NOW() + INTERVAL '30 days'
           AND scp.expires_at > NOW()
           AND cu.campus_id = $1
         ORDER BY scp.expires_at ASC LIMIT 5`,
        [campusId],
      );
      for (const r of expiringRows) {
        todos.push({
          id: `expiring-${r.id}`,
          title: '合同 30 天内到期',
          meta: r.student_name,
          time: new Date(r.expires_at).toISOString(),
          type: 'contract_expiring',
        });
      }

      // 5c. 老师请假未处理（leaves.status='pending' + 涉本校 schedules.teacher 的请假）
      const teacherLeaveRows = await this.pg.tenantQuery<{
        id: string;
        teacher_name: string;
        new_start_at: string | null;
        created_at: string;
      }>(
        tenantSchema,
        `SELECT l.id, t.name AS teacher_name, l.new_start_at, l.created_at
         FROM leaves l
         JOIN schedules s ON s.id = l.lesson_id
         JOIN teachers t ON t.id = s.teacher_id
         WHERE l.status = 'pending'
           AND l.type = 'reschedule'
           AND t.campus_id = $1
         ORDER BY l.created_at DESC LIMIT 5`,
        [campusId],
      );
      for (const r of teacherLeaveRows) {
        todos.push({
          id: `leave-${r.id}`,
          title: '老师调课待审',
          meta: r.teacher_name,
          time: new Date(r.new_start_at || r.created_at).toISOString(),
          type: 'teacher_leave_pending',
        });
      }
    } catch (e) {
      this.logger.error(
        `[KPI-academic-home] todos failed: ${(e as Error).message}`,
      );
    }

    return {
      handoverBacklog,
      expiringContracts,
      monthlyReferrals,
      unreadConsultations,
      todos,
    };
  }

  private emptyAcademicHome(): AcademicHomeKpiResult {
    return {
      handoverBacklog: { count: 0, weeklyScheduled: 0 },
      expiringContracts: { count: 0 },
      monthlyReferrals: { count: 0 },
      unreadConsultations: { count: 0 },
      todos: [],
    };
  }

  // ============================================================
  // 2026-05-22 Level 3 明细 — 4 KPI list endpoint
  //   (合同/消课/学员 明细维度, 替代 Level 2 按销售分组的中间层)
  // ============================================================

  /**
   * 本月新签 contract list — orderType='新签' + signed_at 30d 内
   */
  async listSignedContracts(
    tenantSchema: string,
    options: { campusIds: string[] | null; limit: number; offset: number },
  ): Promise<KpiListResult<KpiContractItem>> {
    return this._listContractsByOrderType(tenantSchema, {
      orderTypes: ['新签'],
      ...options,
    });
  }

  /**
   * 本月续约 contract list — orderType IN ('续费','扩科','升班','转班')
   */
  async listRenewalContracts(
    tenantSchema: string,
    options: { campusIds: string[] | null; limit: number; offset: number },
  ): Promise<KpiListResult<KpiContractItem>> {
    return this._listContractsByOrderType(tenantSchema, {
      orderTypes: ['续费', '扩科', '升班', '转班'],
      ...options,
    });
  }

  private async _listContractsByOrderType(
    tenantSchema: string,
    options: {
      orderTypes: string[];
      campusIds: string[] | null;
      limit: number;
      offset: number;
    },
  ): Promise<KpiListResult<KpiContractItem>> {
    const { orderTypes, campusIds, limit, offset } = options;
    const params: any[] = [orderTypes];
    let p = 2; // $1 已是 orderTypes
    const campusFilter = campusIds && campusIds.length > 0
      ? ` AND c.campus_id = ANY($${p++})`
      : '';
    if (campusFilter) params.push(campusIds);
    params.push(limit, offset);
    const limitParam = `$${p++}`;
    const offsetParam = `$${p++}`;
    try {
      const rows = await this.pg.tenantQuery<any>(
        tenantSchema,
        `SELECT
           c.id              AS contract_id,
           c.student_id      AS student_id,
           s.student_name    AS student_name,
           cp.product_name   AS course_product_name,
           c.total_amount    AS total_amount,
           c.signed_at       AS signed_at,
           c.owner_user_id   AS owner_user_id,
           u.name            AS owner_name,
           u.role            AS owner_role,
           c.order_type      AS order_type
         FROM contracts c
         JOIN students s ON s.id = c.student_id
         LEFT JOIN course_products cp ON cp.id = c.course_product_id
         LEFT JOIN users u ON u.id = c.owner_user_id
         WHERE c.order_type = ANY($1)
           AND c.signed_at >= NOW() - INTERVAL '30 days'
           AND c.status IN ('active','pending')
           AND c.deleted_at IS NULL
           ${campusFilter}
         ORDER BY c.signed_at DESC
         LIMIT ${limitParam} OFFSET ${offsetParam}`,
        params,
      );
      const totalParams = campusIds && campusIds.length > 0
        ? [orderTypes, campusIds]
        : [orderTypes];
      const totalRows = await this.pg.tenantQuery<{ cnt: string }>(
        tenantSchema,
        `SELECT COUNT(*) AS cnt FROM contracts c
         WHERE c.order_type = ANY($1)
           AND c.signed_at >= NOW() - INTERVAL '30 days'
           AND c.status IN ('active','pending')
           AND c.deleted_at IS NULL
           ${campusIds && campusIds.length > 0 ? ' AND c.campus_id = ANY($2)' : ''}`,
        totalParams,
      );
      return {
        items: rows.map((r) => {
          const amount = Number(r.total_amount || 0);
          return {
            contractId: r.contract_id,
            studentId: r.student_id,
            studentName: r.student_name,
            courseProductName: r.course_product_name,
            totalAmount: amount,
            totalAmountText: formatAmountText(amount),
            signedAt: r.signed_at,
            signedAtText: this._formatMonthDay(r.signed_at),
            ownerUserId: r.owner_user_id,
            ownerName: r.owner_name,
            ownerRole: r.owner_role,
            orderType: r.order_type,
          };
        }),
        total: parseInt(totalRows[0]?.cnt || '0', 10),
      };
    } catch (e) {
      this.logger.error(
        `[KPI-list-contracts] ${tenantSchema}: ${(e as Error).message}`,
      );
      return { items: [], total: 0 };
    }
  }

  /**
   * 本月消课 list — course_consumptions.status='confirmed' + confirmed_at 30d 内
   */
  async listConsumptionItems(
    tenantSchema: string,
    options: { campusIds: string[] | null; limit: number; offset: number },
  ): Promise<KpiListResult<KpiConsumptionItem>> {
    const { campusIds, limit, offset } = options;
    const params: any[] = [];
    let p = 1;
    const campusFilter = campusIds && campusIds.length > 0
      ? ` AND sc.campus_id = ANY($${p++})`
      : '';
    if (campusFilter) params.push(campusIds);
    params.push(limit, offset);
    const limitParam = `$${p++}`;
    const offsetParam = `$${p++}`;
    try {
      const rows = await this.pg.tenantQuery<any>(
        tenantSchema,
        `SELECT
           sc.id              AS schedule_id,
           cc.student_id      AS student_id,
           s.student_name     AS student_name,
           t.name             AS teacher_name,
           cp.product_name    AS course_product_name,
           sc.start_at        AS start_at,
           sc.duration_min    AS duration_min,
           cc.confirmed_at    AS confirmed_at
         FROM course_consumptions cc
         JOIN schedules sc ON sc.id = cc.schedule_id
         LEFT JOIN students s ON s.id = cc.student_id
         LEFT JOIN teachers t ON t.id = cc.teacher_id
         LEFT JOIN course_products cp ON cp.id = sc.course_product_id
         WHERE cc.status = 'confirmed'
           AND cc.confirmed_at >= NOW() - INTERVAL '30 days'
           ${campusFilter}
         ORDER BY cc.confirmed_at DESC
         LIMIT ${limitParam} OFFSET ${offsetParam}`,
        params,
      );
      const totalParams = campusIds && campusIds.length > 0 ? [campusIds] : [];
      const totalRows = await this.pg.tenantQuery<{ cnt: string }>(
        tenantSchema,
        `SELECT COUNT(*) AS cnt
         FROM course_consumptions cc
         JOIN schedules sc ON sc.id = cc.schedule_id
         WHERE cc.status = 'confirmed'
           AND cc.confirmed_at >= NOW() - INTERVAL '30 days'
           ${campusIds && campusIds.length > 0 ? ' AND sc.campus_id = ANY($1)' : ''}`,
        totalParams,
      );
      return {
        items: rows.map((r) => ({
          scheduleId: r.schedule_id,
          studentId: r.student_id,
          studentName: r.student_name ?? '—',
          teacherName: r.teacher_name,
          courseProductName: r.course_product_name,
          startAt: r.start_at,
          startAtText: this._formatMonthDay(r.start_at),
          durationMin: parseInt(r.duration_min, 10) || 0,
          confirmedAt: r.confirmed_at,
        })),
        total: parseInt(totalRows[0]?.cnt || '0', 10),
      };
    } catch (e) {
      this.logger.error(
        `[KPI-list-consumption] ${tenantSchema}: ${(e as Error).message}`,
      );
      return { items: [], total: 0 };
    }
  }

  /**
   * 学员活跃度 list — students LEFT JOIN 30d consumption
   *   isActive = 30d 内有 status=confirmed consumption
   */
  async listStudentActivity(
    tenantSchema: string,
    options: { campusIds: string[] | null; limit: number; offset: number; activeOnly?: boolean },
  ): Promise<KpiListResult<KpiStudentActivityItem>> {
    const { campusIds, limit, offset, activeOnly } = options;
    const params: any[] = [];
    let p = 1;
    // 2026-05-22 修历史 bug: students 无 campus_id, JOIN customers 用 cu.campus_id
    const campusFilter = campusIds && campusIds.length > 0
      ? ` AND cu.campus_id = ANY($${p++})`
      : '';
    if (campusFilter) params.push(campusIds);
    params.push(limit, offset);
    const limitParam = `$${p++}`;
    const offsetParam = `$${p++}`;
    const activeFilter = activeOnly ? ' AND a.last_attended_at IS NOT NULL' : '';
    try {
      const rows = await this.pg.tenantQuery<any>(
        tenantSchema,
        `WITH activity_30d AS (
           SELECT cc.student_id,
                  COUNT(*) AS lessons,
                  MAX(cc.confirmed_at) AS last_attended_at
             FROM course_consumptions cc
            WHERE cc.confirmed_at >= NOW() - INTERVAL '30 days'
              AND cc.status = 'confirmed'
            GROUP BY cc.student_id
         )
         SELECT
           s.id              AS student_id,
           s.student_name    AS student_name,
           ca.name           AS campus_name,
           COALESCE(a.lessons, 0) AS lessons,
           a.last_attended_at AS last_attended_at
         FROM students s
         JOIN customers cu ON cu.id = s.customer_id
         LEFT JOIN activity_30d a ON a.student_id = s.id
         LEFT JOIN campuses ca ON ca.id = cu.campus_id
         WHERE s.deleted_at IS NULL
           ${campusFilter}
           ${activeFilter}
         ORDER BY a.last_attended_at DESC NULLS LAST, s.student_name ASC
         LIMIT ${limitParam} OFFSET ${offsetParam}`,
        params,
      );
      const totalParams = campusIds && campusIds.length > 0 ? [campusIds] : [];
      const totalRows = await this.pg.tenantQuery<{ cnt: string }>(
        tenantSchema,
        `SELECT COUNT(*) AS cnt FROM students s
         JOIN customers cu ON cu.id = s.customer_id
         WHERE s.deleted_at IS NULL
         ${campusIds && campusIds.length > 0 ? ' AND cu.campus_id = ANY($1)' : ''}`,
        totalParams,
      );
      return {
        items: rows.map((r) => ({
          studentId: r.student_id,
          studentName: r.student_name,
          campusName: r.campus_name,
          lessons30d: parseInt(r.lessons, 10) || 0,
          lastAttendedAt: r.last_attended_at,
          isActive: r.last_attended_at !== null,
        })),
        total: parseInt(totalRows[0]?.cnt || '0', 10),
      };
    } catch (e) {
      this.logger.error(
        `[KPI-list-student-activity] ${tenantSchema}: ${(e as Error).message}`,
      );
      return { items: [], total: 0 };
    }
  }

  /** 'M/D' 格式 (e.g. '5/22') */
  private _formatMonthDay(d: string | Date | null): string {
    if (!d) return '';
    const date = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(date.getTime())) return '';
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }

  // ============================================================
  // 2026-05-22 Sprint Y P1: finance home KPI (SSOT §3.6)
  // ============================================================
  /**
   * Finance home KPI:
   *   pendingInvoices       待开发票数 (invoices.status='pending')
   *   issuedThisMonthAmount 本月开票金额 (sum amount WHERE status='issued' + issued_at in 本月)
   *   issuedThisMonthCount  本月开票笔数
   *   refundsThisMonthAmount 本月退费金额 (contracts.reverse_type='退款' + created_at in 本月)
   *   refundsThisMonthCount  本月退费笔数
   *
   * 各子 query 独立 try-catch (fail-open). 失败返 0 不阻塞 home.
   *
   * scope: 财务 finance 角色 cross-campus (拍板说财务跨校权), 不限 campus
   */
  async getFinanceHomeKpi(
    tenantSchema: string,
  ): Promise<FinanceHomeKpiResult> {
    const result: FinanceHomeKpiResult = {
      pendingInvoices: { count: 0 },
      issuedThisMonth: { amount: '0', count: 0 },
      refundsThisMonth: { amount: '0', count: 0 },
      todos: [],
    };

    // 1. pendingInvoices
    try {
      const r = await this.pg.tenantQuery<{ cnt: string }>(
        tenantSchema,
        `SELECT COUNT(*) AS cnt FROM invoices WHERE status = 'pending'`,
        [],
      );
      result.pendingInvoices.count = parseInt(r[0]?.cnt || '0', 10);
    } catch (e) {
      this.logger.warn(`[finance-home] pendingInvoices: ${(e as Error).message}`);
    }

    // 2. issuedThisMonth (amount + count)
    try {
      const r = await this.pg.tenantQuery<{ sum_amount: string; cnt: string }>(
        tenantSchema,
        `SELECT COALESCE(SUM(amount), 0) AS sum_amount, COUNT(*) AS cnt
         FROM invoices
         WHERE status = 'issued'
           AND issued_at >= date_trunc('month', NOW())
           AND issued_at < date_trunc('month', NOW()) + INTERVAL '1 month'`,
        [],
      );
      result.issuedThisMonth = {
        amount: formatPlainAmount(Number(r[0]?.sum_amount || 0)),
        count: parseInt(r[0]?.cnt || '0', 10),
      };
    } catch (e) {
      this.logger.warn(`[finance-home] issuedThisMonth: ${(e as Error).message}`);
    }

    // 3. refundsThisMonth (contracts.reverse_type='退款' + created_at 本月)
    try {
      const r = await this.pg.tenantQuery<{ sum_amount: string; cnt: string }>(
        tenantSchema,
        `SELECT COALESCE(SUM(total_amount), 0) AS sum_amount, COUNT(*) AS cnt
         FROM contracts
         WHERE reverse_type = '退款'
           AND created_at >= date_trunc('month', NOW())
           AND created_at < date_trunc('month', NOW()) + INTERVAL '1 month'
           AND deleted_at IS NULL`,
        [],
      );
      result.refundsThisMonth = {
        amount: formatPlainAmount(Number(r[0]?.sum_amount || 0)),
        count: parseInt(r[0]?.cnt || '0', 10),
      };
    } catch (e) {
      this.logger.warn(`[finance-home] refundsThisMonth: ${(e as Error).message}`);
    }

    // 4. todos: 待开发票 (最多 5 条预览) + 本月退费 (最多 5 条预览)
    try {
      const pendingRows = await this.pg.tenantQuery<{
        id: string;
        invoice_title: string;
        amount: string;
        created_at: string;
      }>(
        tenantSchema,
        `SELECT id, invoice_title, amount, created_at
         FROM invoices
         WHERE status = 'pending'
         ORDER BY created_at DESC LIMIT 5`,
        [],
      );
      for (const r of pendingRows) {
        result.todos.push({
          id: `invoice-${r.id}`,
          title: '待开发票',
          meta: r.invoice_title,
          time: new Date(r.created_at).toISOString(),
          type: 'invoice_pending',
        });
      }
    } catch (e) {
      this.logger.warn(`[finance-home] todos.invoice_pending: ${(e as Error).message}`);
    }

    return result;
  }

  // ============================================================
  // 2026-05-22 SSOT §6.8 KPI 4 字段 — 月度消课目标 / 已排 / 已消 / 预计
  // ============================================================

  /**
   * 算 4 字段（target / scheduled / attended / forecast）
   *
   * target     从 V56 monthly_kpi_targets 表查（无下发返 0）
   * scheduled  COUNT schedules WHERE start_at in 本月
   * attended   COUNT WHERE status='已完成'（V8 中文 enum）
   * forecast   scheduled - attended - absent（未来还会消，absent='缺席'）
   *
   * fail-open 哲学：任一 query 失败返 0 不阻塞 home 加载
   *
   * @param role 'teacher' (查自己 teacher_id 的课) 或 'academic' (查本 campusId 的课)
   * @param scopeId teacher 时是 teacher.id / academic 时是 campusId
   */
  async getMonthlyKpiSummary(
    tenantSchema: string,
    role: 'teacher' | 'academic',
    targetUserId: string,
    scopeId: string | null,
  ): Promise<MonthlyKpiSummary> {
    const month = new Date().toISOString().slice(0, 7); // 'YYYY-MM'
    const result: MonthlyKpiSummary = { target: 0, scheduled: 0, attended: 0, forecast: 0 };

    // Step 1: target — V56 monthly_kpi_targets
    try {
      const rows = await this.pg.tenantQuery<{ target_lessons: string }>(
        tenantSchema,
        `SELECT target_lessons FROM monthly_kpi_targets
           WHERE target_user_id = $1 AND month = $2 LIMIT 1`,
        [targetUserId, month],
      );
      result.target = rows[0] ? parseInt(rows[0].target_lessons, 10) : 0;
    } catch (e) {
      // V56 未 backfill / 表不存在 → fail-open 返 0
      this.logger.warn(
        `[KPI-summary] target query failed (V56 not deployed?): ${(e as Error).message}`,
      );
    }

    // Step 2 + 3: scheduled + attended + absent (一次 SQL group)
    try {
      // 2026-05-22 修第二个 bug: teacher role 的 schedules.teacher_id 是 teachers.id,
      //   不是 users.id (controller 传的是 JWT.sub = user_id)
      //   → 必须 sub-query 反查 teachers WHERE user_id = $1
      //   (avoiding JOIN 让 SQL 在 academic + teacher 之间统一表达 conditions)
      const conditions = role === 'teacher'
        ? `teacher_id IN (SELECT id FROM teachers WHERE user_id = $1)`
        : (scopeId ? `campus_id = $1` : `1=1`); // academic 无 campusId 时全 tenant scope
      const param = role === 'teacher' ? targetUserId : (scopeId || '');
      if (param) {
        const aggRows = await this.pg.tenantQuery<{
          scheduled: string;
          attended: string;
          absent: string;
        }>(
          tenantSchema,
          // V8 schema: status IN ('已排课','已完成','已取消','缺席')
          // 之前误用英文 'attended'/'absent' 导致永远 0 — 2026-05-22 修复
          `SELECT
             COUNT(*) AS scheduled,
             COUNT(*) FILTER (WHERE status = '已完成') AS attended,
             COUNT(*) FILTER (WHERE status = '缺席') AS absent
           FROM schedules
           WHERE ${conditions}
             AND TO_CHAR(start_at, 'YYYY-MM') = $2
             AND status != '已取消'`,
          [param, month],
        );
        const r = aggRows[0] || { scheduled: '0', attended: '0', absent: '0' };
        result.scheduled = parseInt(r.scheduled, 10) || 0;
        result.attended = parseInt(r.attended, 10) || 0;
        const absent = parseInt(r.absent, 10) || 0;
        result.forecast = Math.max(0, result.scheduled - result.attended - absent);
      }
    } catch (e) {
      this.logger.warn(
        `[KPI-summary] schedules agg failed: ${(e as Error).message}`,
      );
    }
    return result;
  }

  /**
   * 2026-05-22 用户拍板: 教务 home「续约金额」KPI 字段
   *   query contracts WHERE order_type='续费' AND signed_at in 本月 + 本校 campus
   *   sum(total_amount) 单位元
   *
   * 续约语义（OrderType.续费）= 老学员加课时再消费（不含新签 / 扩科 / 升班 / 转班）
   * SSOT §3.4 教务 4 件事之一 = 续约职责
   *
   * fail-open: query 失败返 0 不阻塞 home
   */
  async getMonthlyRenewalAmount(
    tenantSchema: string,
    campusId: string | null,
  ): Promise<number> {
    try {
      const conditions = campusId ? 'AND campus_id = $1' : '';
      const params = campusId ? [campusId] : [];
      const rows = await this.pg.tenantQuery<{ sum_amount: string }>(
        tenantSchema,
        `SELECT COALESCE(SUM(total_amount), 0) AS sum_amount
         FROM contracts
         WHERE order_type = '续费'
           AND signed_at >= date_trunc('month', NOW())
           AND signed_at < date_trunc('month', NOW()) + INTERVAL '1 month'
           AND status != 'cancelled'
           ${conditions}`,
        params,
      );
      return Number(rows[0]?.sum_amount || 0);
    } catch (e) {
      this.logger.warn(
        `[KPI-renewal-amount] query failed: ${(e as Error).message}`,
      );
      return 0;
    }
  }

  /**
   * 校长（boss）下发月度目标 — UPSERT 模式（同人同月已有 → UPDATE）
   *
   * 目标硬上限校验：sum(本 campus 本月目标) ≤ sum(本月已排 schedule * 实际单价)
   *   → 调用方 (controller) 实施硬上限校验（拍板 §6.8）
   *   → 本 method 只负责 INSERT/UPDATE，不校验业务上限
   */
  /**
   * 2026-05-22 SSOT §6.8 Sprint Y: 列 campus 本月所有 target (校长 page 入口查现有)
   *
   *   返 [{ target_user_id, target_role, target_lessons, note, set_at }]
   *   只查指定 campus + month, 不返 target_user 名称 (前端用 user-list 字典 map)
   *
   *   fail-open: query 失败返 [] 不阻塞 page
   */
  async listTargets(
    tenantSchema: string,
    campusId: string,
    month: string,
  ): Promise<Array<{
    targetUserId: string;
    targetRole: 'academic' | 'teacher';
    targetLessons: number;
    note: string | null;
    setAt: string;
  }>> {
    try {
      const rows = await this.pg.tenantQuery<{
        target_user_id: string;
        target_role: 'academic' | 'teacher';
        target_lessons: string;
        note: string | null;
        set_at: string;
      }>(
        tenantSchema,
        `SELECT target_user_id, target_role, target_lessons, note, set_at
         FROM monthly_kpi_targets
         WHERE campus_id = $1 AND month = $2
         ORDER BY target_role, set_at DESC`,
        [campusId, month],
      );
      return rows.map((r) => ({
        targetUserId: r.target_user_id,
        targetRole: r.target_role,
        targetLessons: parseInt(r.target_lessons, 10) || 0,
        note: r.note,
        setAt: r.set_at,
      }));
    } catch (e) {
      this.logger.warn(
        `[KPI-list-targets] query failed: ${(e as Error).message}`,
      );
      return [];
    }
  }

  /**
   * 校长（boss）下发月度目标 — UPSERT 模式（同人同月已有 → UPDATE）
   *
   * 目标硬上限校验：sum(本 campus 本月目标) ≤ sum(本月已排 schedule * 实际单价)
   *   → 调用方 (controller) 实施硬上限校验（拍板 §6.8）
   *   → 本 method 只负责 INSERT/UPDATE，不校验业务上限
   */
  async setMonthlyTarget(
    tenantSchema: string,
    dto: SetMonthlyTargetDto,
  ): Promise<{ id: string; updated: boolean }> {
    // UPSERT — 同 (target_user_id, month) UNIQUE INDEX 触发
    const id = (require('ulid').ulid() as string).padEnd(32, '0').slice(0, 32);
    const rows = await this.pg.tenantQuery<{ id: string; existing: boolean }>(
      tenantSchema,
      `INSERT INTO monthly_kpi_targets
         (id, campus_id, target_role, target_user_id, month, target_lessons,
          set_by_boss_user_id, note, set_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
       ON CONFLICT (target_user_id, month) DO UPDATE
         SET target_lessons = EXCLUDED.target_lessons,
             set_by_boss_user_id = EXCLUDED.set_by_boss_user_id,
             note = EXCLUDED.note,
             updated_at = NOW()
       RETURNING id, (xmax::text::int > 0) AS existing`,
      [
        id,
        dto.campusId,
        dto.targetRole,
        dto.targetUserId,
        dto.month,
        dto.targetLessons,
        dto.setByBossUserId,
        dto.note || null,
      ],
    );
    return {
      id: rows[0]?.id || id,
      updated: rows[0]?.existing || false,
    };
  }

  // ============================================================
  // 2026-06-02 SSOT §3.-2 A「课程销量」— admin/boss 经营首页组 4
  // ============================================================

  /**
   * A-Level2 课程销量排名（本月 + 本校 scope）
   *
   * 口径（SSOT §3.-2 A + §3.3「曾有效签约计入、cancelled/refunded 不计」）：
   *   - 本月 = signed_at 落当前自然月（date_trunc('month', NOW()) 起点，与
   *     personalSigned/computeSalesMonthlyRank 排名口径一致）
   *   - status NOT IN ('cancelled','refunded')（contracts.status 枚举无 'refunded'，
   *     保留字面与 rank 查询对齐 + 未来加该态自然生效；当前永不命中无副作用）
   *   - deleted_at IS NULL
   *   - campus_id = $1（强制本校 scope，campusId 由 controller 从 JWT 透传，禁信前端）
   *   - GROUP BY course_product_id，LEFT JOIN course_products 取 product_name
   *     （course_product_id 可能 NULL — V29 销售自填名合同；归一行 productName=null）
   *
   * 返回 items 按 salesCount DESC；total = Σ salesCount（= home Level1 KPI 数）。
   * fail-open：聚合失败 → { total: 0, items: [] }（不破坏 home 渲染）。
   */
  async getCourseSales(
    tenantSchema: string,
    campusId: string,
  ): Promise<CourseSalesResult> {
    try {
      const rows = await this.pg.tenantQuery<{
        course_product_id: string | null;
        product_name: string | null;
        sales_count: string;
      }>(
        tenantSchema,
        `SELECT
           c.course_product_id          AS course_product_id,
           cp.product_name              AS product_name,
           COUNT(*)                     AS sales_count
         FROM contracts c
         LEFT JOIN course_products cp ON cp.id = c.course_product_id
         WHERE c.signed_at >= date_trunc('month', NOW())
           AND c.signed_at < date_trunc('month', NOW()) + INTERVAL '1 month'
           AND c.status NOT IN ('cancelled','refunded')
           AND c.deleted_at IS NULL
           AND c.campus_id = $1
         GROUP BY c.course_product_id, cp.product_name
         ORDER BY sales_count DESC`,
        [campusId],
      );

      let total = 0;
      const items: CourseSalesItem[] = rows.map((r) => {
        const salesCount = parseInt(r.sales_count, 10) || 0;
        total += salesCount;
        return {
          courseProductId: r.course_product_id ?? null,
          productName: r.product_name ?? null,
          salesCount,
        };
      });

      return { total, items };
    } catch (e) {
      this.logger.error(
        `[KPI-course-sales] ${tenantSchema}: ${(e as Error).message}`,
      );
      return { total: 0, items: [] };
    }
  }

  /**
   * A-Level3 某课程的人员销量（本月 + 本校 scope）
   *
   * 同 getCourseSales 窗口/scope，但 WHERE course_product_id = $courseProductId：
   *   - GROUP BY owner_user_id，LEFT JOIN users 取 salesName（users.name，非一级 PII，
   *     对齐既有 salesName 先例 — contract/customer repository）
   *   - owner_user_id 为 null 的合同归「系统」
   *   - productName 从 course_products 单独取（即使该课程本月零销量也返产品名）
   *
   * 返回 items 按 salesCount DESC。
   * fail-open：聚合失败 → { productName: null, items: [] }。
   */
  async getCourseSalesByPerson(
    tenantSchema: string,
    campusId: string,
    courseProductId: string,
  ): Promise<CourseSalesByPersonResult> {
    try {
      // productName 单查（与人员聚合解耦：零销量课程也能显示标题）
      let productName: string | null = null;
      try {
        const pRows = await this.pg.tenantQuery<{ product_name: string | null }>(
          tenantSchema,
          `SELECT product_name FROM course_products WHERE id = $1`,
          [courseProductId],
        );
        productName = pRows[0]?.product_name ?? null;
      } catch {
        // product_name 取不到不阻塞人员聚合（fail-open）
      }

      const rows = await this.pg.tenantQuery<{
        owner_user_id: string | null;
        owner_name: string | null;
        sales_count: string;
      }>(
        tenantSchema,
        `SELECT
           c.owner_user_id              AS owner_user_id,
           u.name                       AS owner_name,
           COUNT(*)                     AS sales_count
         FROM contracts c
         LEFT JOIN users u ON u.id = c.owner_user_id
         WHERE c.course_product_id = $1
           AND c.signed_at >= date_trunc('month', NOW())
           AND c.signed_at < date_trunc('month', NOW()) + INTERVAL '1 month'
           AND c.status NOT IN ('cancelled','refunded')
           AND c.deleted_at IS NULL
           AND c.campus_id = $2
         GROUP BY c.owner_user_id, u.name
         ORDER BY sales_count DESC`,
        [courseProductId, campusId],
      );

      const items: CourseSalesByPersonItem[] = rows.map((r) => ({
        salesUserId: r.owner_user_id ?? null,
        // owner_user_id 为 null → 「系统」；非 null 但 users 已删/无名 → '未知'
        salesName: r.owner_user_id ? (r.owner_name ?? '未知') : '系统',
        salesCount: parseInt(r.sales_count, 10) || 0,
      }));

      return { productName, items };
    } catch (e) {
      this.logger.error(
        `[KPI-course-sales-by-person] ${tenantSchema}: ${(e as Error).message}`,
      );
      return { productName: null, items: [] };
    }
  }

  // ============================================================
  // 2026-06-02 SSOT §3.-2 E「消课数据双维度排名」— admin/boss 经营首页
  //   原「老师业绩榜·本月」改为消课数据，分 教务 / 老师 两 tab 的本月消课量
  // ============================================================

  /**
   * E 消课数据双维度排名（本月 + 本校 scope）
   *
   * 口径（SSOT §3.-2 E + 既有「本月消课 list」join 路径）：
   *   - 本月 = confirmed_at 落当前自然月（date_trunc('month', NOW()) 起点，与
   *     course-sales personalSigned 排名口径一致，对齐「本月四象」窗口）
   *   - course_consumptions.status = 'confirmed'
   *   - campus 过滤 = schedules.campus_id = $1（与既有 consumption KPI getConsumptionKpi
   *     口径一致；campusId 由 controller 从 JWT 透传，禁信前端）
   *   - 数据源：course_consumptions cc JOIN schedules sc ON sc.id = cc.schedule_id
   *
   *   teacher 维：GROUP BY sc.teacher_id，LEFT JOIN teachers t 取 name。
   *     每条 confirmed consumption 计 1 节（COUNT(*)）。
   *   academic 维：GROUP BY sc.created_by_user_id WHERE sc.created_by_role IN
   *     ('academic','academic_admin')（谁排的课；admin/boss 自排不计入教务维），
   *     LEFT JOIN users u 取 name。
   *     - created_by_role 历史值可能含 'teacher'/'sales'（5/12 之前旧数据），
   *       本聚合用 created_by_role 过滤（与 getConsumptionKpi 用 users.role 二次校验
   *       同精神，此处直接按排课时落库的 role 维度，符合 §3.-2 E「谁排的课」语义）。
   *
   * 两维各按 lessonCount DESC。id/teacher_id 为 null 兜底 name='未知'。
   * fail-open：聚合失败 → { teacher: [], academic: [] }（不破坏 home 渲染）。
   */
  async getConsumptionRanking(
    tenantSchema: string,
    campusId: string,
  ): Promise<ConsumptionRankingResult> {
    try {
      // teacher 维：谁教的（GROUP BY schedules.teacher_id）
      const teacherRows = await this.pg.tenantQuery<{
        teacher_id: string | null;
        teacher_name: string | null;
        lesson_count: string;
      }>(
        tenantSchema,
        `SELECT
           sc.teacher_id    AS teacher_id,
           t.name           AS teacher_name,
           COUNT(*)         AS lesson_count
         FROM course_consumptions cc
         JOIN schedules sc ON sc.id = cc.schedule_id
         LEFT JOIN teachers t ON t.id = sc.teacher_id
         WHERE cc.status = 'confirmed'
           AND cc.confirmed_at >= date_trunc('month', NOW())
           AND cc.confirmed_at < date_trunc('month', NOW()) + INTERVAL '1 month'
           AND sc.campus_id = $1
         GROUP BY sc.teacher_id, t.name
         ORDER BY lesson_count DESC`,
        [campusId],
      );

      // academic 维：谁排的课（GROUP BY schedules.created_by_user_id，仅教务线）
      const academicRows = await this.pg.tenantQuery<{
        user_id: string | null;
        user_name: string | null;
        lesson_count: string;
      }>(
        tenantSchema,
        `SELECT
           sc.created_by_user_id  AS user_id,
           u.name                 AS user_name,
           COUNT(*)               AS lesson_count
         FROM course_consumptions cc
         JOIN schedules sc ON sc.id = cc.schedule_id
         LEFT JOIN users u ON u.id = sc.created_by_user_id
         WHERE cc.status = 'confirmed'
           AND cc.confirmed_at >= date_trunc('month', NOW())
           AND cc.confirmed_at < date_trunc('month', NOW()) + INTERVAL '1 month'
           AND sc.created_by_role IN ('academic','academic_admin')
           AND sc.campus_id = $1
         GROUP BY sc.created_by_user_id, u.name
         ORDER BY lesson_count DESC`,
        [campusId],
      );

      const teacher: ConsumptionRankingItem[] = teacherRows.map((r) => ({
        id: r.teacher_id ?? null,
        name: r.teacher_id ? (r.teacher_name ?? '未知') : '未知',
        lessonCount: parseInt(r.lesson_count, 10) || 0,
      }));
      const academic: ConsumptionRankingItem[] = academicRows.map((r) => ({
        id: r.user_id ?? null,
        name: r.user_id ? (r.user_name ?? '未知') : '未知',
        lessonCount: parseInt(r.lesson_count, 10) || 0,
      }));

      return { teacher, academic };
    } catch (e) {
      this.logger.error(
        `[KPI-consumption-ranking] ${tenantSchema}: ${(e as Error).message}`,
      );
      return { teacher: [], academic: [] };
    }
  }
}
