import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Optional,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';
import { RbacGuard } from '../../guards/rbac.guard';
import { Roles } from '../../guards/rbac.decorator';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';
import {
  KpiService,
  SignedKpiResult,
  RenewalKpiResult,
  ConsumptionKpiResult,
  StudentActivityKpiResult,
  SalesHomeKpiResult,
  TeacherHomeKpiResult,
  AcademicHomeKpiResult,
  FinanceHomeKpiResult,
  KpiContractItem,
  KpiConsumptionItem,
  KpiStudentActivityItem,
  KpiListResult,
  CourseSalesResult,
  CourseSalesByPersonResult,
  ConsumptionRankingResult,
} from './kpi.service';
import {
  ActorRole,
  AuditLogRepository,
  normalizeActorRole,
} from './audit-log.repository';
// 2026-05-22 SSOT §6.9 KPI 5min Redis cache (fail-open)
import { RedisService } from '../redis/redis.service';
// #24: B 端自由文本内容安全统一收口（@Global SecurityModule 注入）
import { ContentModerationService } from '../security/content-moderation.service';
// 2026-06-02 SSOT §3.-2 D 全局校区筛选：admin override / 非 admin 恒 JWT.campusId
import { CampusRepository } from './campus.repository';
import { resolveEffectiveCampusId } from '../../common/campus-scope/resolve-effective-campus';

/**
 * KpiController — 4 KPI dashboard endpoint（2026-05-20 P4-X 拍板）
 *
 * 来源：
 *   - SSOT §3.1/§3.2 老板/校长 home 4 KPI 组 Level 2 下钻
 *   - SSOT §6 操作权限矩阵 2026-05-20 新增 kpi.*.read = [admin, boss]
 *
 * Endpoints（全部 admin/boss 角色）：
 *   GET /db/kpi/signed             本月新签聚合（sales + academic）
 *   GET /db/kpi/renewal            本月续约聚合（academic + sales）
 *   GET /db/kpi/consumption        本月消课聚合（仅 academic）
 *   GET /db/kpi/student-activity   学员活跃度聚合（按校区分桶）
 *
 * 守门 5 层：
 *   1. TenantScopeGuard class-level（body/query/header 三重 schema 校验）
 *   2. RbacGuard class-level + @Roles('admin', 'boss')
 *   3. tenantSchema query 必填（缺 → BadRequest）
 *   4. boss 强制 callerCampusId = jwt.campusId（即便 query.campusId 传他校 → 403）
 *   5. admin 可选 campusId csv 多选 / 不传 = 跨校全部
 *
 * 不写 audit_log：KPI 是高频读路径（home Level 2 进入即触发），写 audit_log 会污染。
 * 越权由 RbacGuard 自动 403（A09 已在 RbacGuard 层覆盖；本 endpoint 不再单独写）。
 */
// 2026-05-22 P0 修生产 429: home 并发 5 KPI GET (signed/renewal/consumption/student-activity + leaderboard)
//   全局 throttle 60/min 太严 → 5 next refresh 触发 → home 卡 loading
//   KPI 全只读 + 5min Redis cache + RBAC + tenant scope, 不需要再加限流
//   越权由 RbacGuard + audit_log 兜住; POST set-target 单独保留默认限流
@SkipThrottle()
@Controller('db/kpi')
@UseGuards(TenantScopeGuard, RbacGuard)
export class KpiController {
  private readonly logger = new Logger(KpiController.name);

  constructor(
    private readonly kpi: KpiService,
    // #24: B 端自由文本内容安全统一收口（@Global SecurityModule 注入，生产必有）
    //   set-target note 字段写库前过微信 msgSecCheck（默认 reject 策略）
    private readonly contentModeration: ContentModerationService,
    // 2026-05-22 Sprint Y: 老师/教务/财务 home audit_log read 写入
    // @Optional unit spec 兼容；fail-open log() 内部已 catch
    @Optional() private readonly auditLog?: AuditLogRepository,
    // 2026-05-22 SSOT §6.9 Redis 5min KPI cache (fail-open PG 兜底)
    @Optional() private readonly redis?: RedisService,
    // 2026-06-02 SSOT §3.-2 D 全局校区筛选：校验 admin override ∈ 本租户 campuses
    // @Optional isolated unit spec 不传 → resolveEffectiveCampusId 回退 JWT.campusId
    @Optional() private readonly campusRepo?: CampusRepository,
  ) {}

  /**
   * Sprint Y helper: 抽取 audit_log 写入 context（KPI read 路径）
   * KPI 读路径 audit_log 仅记 success/forbidden 两种事件名 + actor 元数据
   * （不记 before/after — KPI 聚合无业务前后状态，target_id 用 actorUserId 标识）
   */
  private async tryAuditKpiRead(
    tenantSchema: string,
    req: AuthenticatedRequest,
    action: string,
    targetId: string | null,
  ): Promise<void> {
    if (!this.auditLog) {
      // 2026-06-01 Sprint Y 可观测性：AuditLogRepository @Global 恒注入，
      // undefined 仅错误配线/单测脱钩 → warn 防静默丢失（KPI 读路径低频，不会刷屏）
      this.logger.warn(
        `audit log repo not injected, skipping audit for ${action} (target=${targetId})`,
      );
      return;
    }
    try {
      await this.auditLog.log(tenantSchema, {
        actorUserId: req.user?.sub ?? null,
        actorRole: normalizeActorRole(req.user?.role),
        action,
        targetType: 'kpi',
        targetId,
        before: null,
        after: null,
        ip: req.ip ?? null,
        userAgent: (req.headers?.['user-agent'] as string | undefined) ?? null,
        requestId: (req.headers?.['x-request-id'] as string | undefined) ?? null,
      });
    } catch {
      // fail-open: audit_log 写失败不阻塞 KPI 读
    }
  }

  /**
   * 解析 campusIds query：
   *   - admin 角色：解析 csv 为字符串数组（空 / 未传 → null = 全部）
   *   - boss 角色：强制 = [jwt.campusId]；如 query 含 campusId 但不含 jwt.campusId → 403
   *
   * 设计：A04 防 client-controlled scope 关键 — boss 永远不能查他校 KPI。
   */
  private resolveCampusScope(
    role: string | undefined,
    jwtCampusId: string | null | undefined,
    queryCampusIdsCsv: string | undefined,
  ): string[] | null {
    const parsedQuery = (queryCampusIdsCsv ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    if (role === 'boss') {
      if (!jwtCampusId) {
        throw new ForbiddenException(
          'BOSS_MISSING_CAMPUS_ID: boss role 必须 jwt.campusId 非空',
        );
      }
      if (parsedQuery.length > 0) {
        // boss 传了 campusIds：只允许全部 = jwt.campusId（容忍同值传递，不容忍他校）
        const hasOtherCampus = parsedQuery.some((cid) => cid !== jwtCampusId);
        if (hasOtherCampus) {
          throw new ForbiddenException(
            'FORBIDDEN_CAMPUS_MISMATCH: boss 不能查询其他校区 KPI',
          );
        }
      }
      return [jwtCampusId];
    }

    if (role === 'admin') {
      // admin 没传 → 跨校全部（null）；传了 → 按 csv 过滤
      return parsedQuery.length === 0 ? null : parsedQuery;
    }

    // 其他 role 理论被 @Roles 挡住，但兜底防御：返 [] 让 SQL where false 命中无数据
    return [];
  }

  /**
   * 2026-06-02 SSOT §3.-2 A「课程销量」专用 campus-scope（强制 JWT，禁信前端）
   *
   * 与 resolveCampusScope（admin 可 null 跨校）不同：course-sales 是「本月本校课程销量」
   * 经营首页 KPI，必须强制本校 scope。campusId 一律取自 JWT；缺失 → 403（仿
   * trial.requireCampusId）。admin（本租户单校 boss/admin 必有 campusId）+ boss 均适用。
   */
  private requireCampusId(req: AuthenticatedRequest): string {
    const campusId = req.user?.campusId;
    if (!campusId) {
      throw new ForbiddenException(
        'KPI_NO_CAMPUS: caller must have a campusId scope (course-sales 强制本校)',
      );
    }
    return campusId;
  }

  /**
   * 2026-06-02 SSOT §3.-2 D 全局校区筛选 — POST 单校 scope 端点专用
   *
   * 解析 effective campusId（admin 可经 body.campusId override ∈ 本租户 campuses；
   * 非 admin 含 boss 恒用 JWT.campusId），再强制非空（保留既有 KPI_NO_CAMPUS 403 兜底）。
   *
   * 用于 course-sales / course-sales/by-person / consumption-ranking（强制本校单值）。
   */
  private async resolveRequiredCampusId(
    req: AuthenticatedRequest,
    overrideCampusId: string | undefined,
  ): Promise<string> {
    const campusId = await resolveEffectiveCampusId(
      req,
      overrideCampusId,
      this.campusRepo,
    );
    if (!campusId) {
      throw new ForbiddenException(
        'KPI_NO_CAMPUS: caller must have a campusId scope (course-sales 强制本校)',
      );
    }
    return campusId;
  }

  /**
   * 2026-05-23 (task #34) home-alerts 通用预警 endpoint
   *   GET /db/kpi/home-alerts?tenantSchema=
   *   返每个角色的 attentionStats { lowBalance, refundPending, handover }
   *
   *   字段来源:
   *     - refundPending: V59 refund_orders WHERE status='pending' COUNT (finance scope)
   *     - lowBalance: TODO V12 student_course_packages remaining_hours < 4 COUNT (待 Sprint)
   *     - handover: TODO V28 customer ownership 变更未排课 COUNT (待 Sprint)
   *   按用户「禁止幻想」: 暂只 refundPending 真值, 其他放 0
   *
   *   RBAC: 全 B 端 role (home 都用)
   */
  @Get('home-alerts')
  @Roles('admin', 'boss', 'finance', 'academic', 'academic_admin', 'sales', 'sales_manager', 'teacher')
  @HttpCode(HttpStatus.OK)
  async homeAlerts(
    @Query('tenantSchema') tenantSchema: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ lowBalance: number; refundPending: number; handover: number }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const role = req.user?.role || '';
    const campusId = req.user?.campusId;
    return this.kpi.getHomeAlerts(tenantSchema, { role, campusId });
  }

  /**
   * 2026-05-21 销售自视角 home KPI
   *   GET /db/kpi/sales-home?tenantSchema=
   *   Auth: JWT.sub → salesUserId（不接受 client 传 userId 防伪造）
   *   RBAC: sales / sales_manager 可读自己 home 数据
   *
   *   audit_log（2026-06-01 Sprint Y 一致性补齐）:
   *     - success: kpi.sales_home.read.success（与 teacher/academic/finance home 口径一致）
   *     - forbidden (RbacGuard 拦): RbacGuard 自动写
   *     - bad request: 不写（客户端参数错误）
   */
  @Get('sales-home')
  @Roles('sales', 'sales_manager')
  @HttpCode(HttpStatus.OK)
  async salesHomeKpi(
    @Query('tenantSchema') tenantSchema: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<SalesHomeKpiResult> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const salesUserId = req.user?.sub;
    if (!salesUserId) throw new BadRequestException('user sub required');
    // 2026-05-31 §3.3① 单校区排名口径：campusId 从 JWT 拿（防 client 伪造 scope）
    const campusId = req.user?.campusId ?? null;
    const result = await this.kpi.getSalesHomeKpi(
      tenantSchema,
      salesUserId,
      campusId,
    );

    // audit_log fail-open（success 路径写一次；与其他 home 端点一致）
    await this.tryAuditKpiRead(
      tenantSchema,
      req,
      'kpi.sales_home.read.success',
      salesUserId,
    );

    return result;
  }

  /**
   * 2026-05-22 Sprint Y 老师自视角 home KPI（SSOT §3.5 拍板）
   *   GET /db/kpi/teacher-home?tenantSchema=
   *   Auth: JWT.sub → users.id → teachers WHERE user_id = sub → teachers.id
   *   RBAC: @Roles('teacher')（老师只看自己；admin/boss 走 §3.1 admin KPI 不走 home）
   *
   *   audit_log 写入:
   *     - success: kpi.teacher_home.read.success
   *     - forbidden (RbacGuard 拦): RbacGuard 自动写 kpi.*.read.forbidden
   *     - bad request: 不写 audit（参数错误属客户端问题）
   *
   *   service 内部 sub-query 全 fail-open（单卡失败返 0，不阻塞 home 整体）
   */
  @Get('teacher-home')
  @Roles('teacher')
  @HttpCode(HttpStatus.OK)
  async teacherHomeKpi(
    @Query('tenantSchema') tenantSchema: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<TeacherHomeKpiResult> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const userId = req.user?.sub;
    if (!userId) throw new BadRequestException('user sub required');

    // 2026-05-22 SSOT §6.9 Redis 5min cache wrap (fail-open PG 兜底)
    //   key: kpi:home:teacher:{tenantSchema}:{userId}:{yyyy-mm}
    //   命中 cache < 100ms / miss 后 compute + 缓存 300s
    const month = new Date().toISOString().slice(0, 7);
    const cacheKey = `kpi:home:teacher:${tenantSchema}:${userId}:${month}`;
    const result = this.redis
      ? await this.redis.getOrCompute<TeacherHomeKpiResult>(
          cacheKey,
          300,
          () => this.kpi.getTeacherHomeKpi(tenantSchema, userId),
        )
      : await this.kpi.getTeacherHomeKpi(tenantSchema, userId);

    // 2026-05-22 SSOT §6.8 KPI 4 字段合并（target / scheduled / attended / forecast）
    //   注: teacher 视角 scopeId 不用，service 内部用 userId 反查 teacher_id 后按 teacher 维度算
    try {
      result.kpiSummary = await this.kpi.getMonthlyKpiSummary(
        tenantSchema,
        'teacher',
        userId,
        null,
      );
    } catch (e) {
      // fail-open: 4 字段聚合失败不阻塞 home（kpiSummary undefined 前端 fallback 0）
      this.logger.warn(
        `[kpi.teacher-home] kpiSummary merge failed: ${(e as Error).message}`,
      );
    }

    // audit_log fail-open（success 路径写一次；不写 sub-card 明细）
    await this.tryAuditKpiRead(
      tenantSchema,
      req,
      'kpi.teacher_home.read.success',
      userId,
    );

    return result;
  }

  /**
   * 2026-05-22 Sprint Y 教务自视角 home KPI（SSOT §3.4 拍板）
   *   GET /db/kpi/academic-home?tenantSchema=
   *   Auth: JWT.sub + JWT.campusId（必填，academic 单校 role）
   *   RBAC: @Roles('academic', 'academic_admin')
   *
   *   A04 防御: campusId 不接受 query 参数 — 强制使用 jwt.campusId（client 不可控制 scope）
   *   若 jwt.campusId 缺失 → ForbiddenException（academic 必有 campusId by 拍板）
   *
   *   audit_log:
   *     - success: kpi.academic_home.read.success
   *     - forbidden (无 campusId): kpi.academic_home.read.forbidden
   *     - bad request (无 tenantSchema): 不写（client 错误）
   */
  @Get('academic-home')
  @Roles('academic', 'academic_admin')
  @HttpCode(HttpStatus.OK)
  async academicHomeKpi(
    @Query('tenantSchema') tenantSchema: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<AcademicHomeKpiResult> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const userId = req.user?.sub;
    if (!userId) throw new BadRequestException('user sub required');

    const callerCampusId = req.user?.campusId;
    if (!callerCampusId) {
      // academic / academic_admin 必有 campusId（拍板 9 角色清单 + JwtPayload CROSS_CAMPUS_ROLES 限定）
      await this.tryAuditKpiRead(
        tenantSchema,
        req,
        'kpi.academic_home.read.forbidden',
        userId,
      );
      throw new ForbiddenException(
        'ACADEMIC_MISSING_CAMPUS_ID: academic role 必须 jwt.campusId 非空',
      );
    }

    // 2026-05-22 SSOT §6.9 Redis 5min cache wrap (fail-open PG 兜底)
    //   key: kpi:home:academic:{tenantSchema}:{userId}:{campusId}:{yyyy-mm}
    const month = new Date().toISOString().slice(0, 7);
    const cacheKey = `kpi:home:academic:${tenantSchema}:${userId}:${callerCampusId}:${month}`;
    const result = this.redis
      ? await this.redis.getOrCompute<AcademicHomeKpiResult>(
          cacheKey,
          300,
          () => this.kpi.getAcademicHomeKpi(tenantSchema, callerCampusId),
        )
      : await this.kpi.getAcademicHomeKpi(tenantSchema, callerCampusId);

    // 2026-05-22 SSOT §6.8 KPI 4 字段合并（target / scheduled / attended / forecast）
    //   academic 视角 scopeId = callerCampusId（本校所有 schedule 聚合）
    try {
      result.kpiSummary = await this.kpi.getMonthlyKpiSummary(
        tenantSchema,
        'academic',
        userId,
        callerCampusId,
      );
    } catch (e) {
      this.logger.warn(
        `[kpi.academic-home] kpiSummary merge failed: ${(e as Error).message}`,
      );
    }

    // 2026-05-22 用户拍板: 教务 home 主区显示「续约金额」(4 件事「续约」职责)
    try {
      result.renewalAmount = await this.kpi.getMonthlyRenewalAmount(
        tenantSchema,
        callerCampusId,
      );
    } catch (e) {
      this.logger.warn(
        `[kpi.academic-home] renewalAmount merge failed: ${(e as Error).message}`,
      );
    }

    await this.tryAuditKpiRead(
      tenantSchema,
      req,
      'kpi.academic_home.read.success',
      userId,
    );

    return result;
  }

  // ============================================================
  // 2026-05-22 Sprint Y P1: finance home endpoint (SSOT §3.6)
  // ============================================================
  /**
   * GET /db/kpi/finance-home?tenantSchema=
   *   财务自视角 home KPI (待开发票 / 本月开票 / 本月退费 / todos)
   *
   *   RBAC: @Roles('finance') — 财务专属, admin/boss 不进 (走自己视角)
   *   Scope: 财务跨校 (拍板说财务跨校权), 不限 campusId
   *
   *   Audit: 写 kpi.finance_home.read.success / .forbidden
   *   fail-open: 子查询失败返 0, 整体不抛错
   */
  @Get('finance-home')
  @Roles('finance')
  @HttpCode(HttpStatus.OK)
  async financeHomeKpi(
    @Query('tenantSchema') tenantSchema: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<FinanceHomeKpiResult> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const userId = req.user?.sub;
    if (!userId) throw new BadRequestException('user sub required');

    // 5min Redis cache (SSOT §6.9 同 teacher/academic home 模式)
    const month = new Date().toISOString().slice(0, 7);
    const cacheKey = `kpi:home:finance:${tenantSchema}:${userId}:${month}`;
    const result = this.redis
      ? await this.redis.getOrCompute<FinanceHomeKpiResult>(
          cacheKey,
          300,
          () => this.kpi.getFinanceHomeKpi(tenantSchema),
        )
      : await this.kpi.getFinanceHomeKpi(tenantSchema);

    await this.tryAuditKpiRead(
      tenantSchema,
      req,
      'kpi.finance_home.read.success',
      userId,
    );

    return result;
  }

  // ============================================================
  // 2026-05-22 SSOT §6.8 Sprint Y: list-targets endpoint — 校长 page 入口查现有目标
  // ============================================================
  /**
   * GET /db/kpi/targets?tenantSchema=&campusId=&month=
   *   列 campus 本月所有 academic/teacher 已下发的 target
   *
   *   RBAC: boss / admin (boss 强制 jwt.campusId / admin 可查任意 campus)
   *   入参 month: 'YYYY-MM' 格式 (前端 picker)
   *
   *   返 { items: [{ targetUserId, targetRole, targetLessons, note, setAt }] }
   *
   *   不写 audit_log: 高频读路径同 home KPI 一致 (越权由 RBAC 拦)
   */
  @Get('targets')
  @Roles('boss', 'admin')
  @HttpCode(HttpStatus.OK)
  async listTargets(
    @Query('tenantSchema') tenantSchema: string,
    @Query('campusId') campusId: string,
    @Query('month') month: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ items: Awaited<ReturnType<KpiService['listTargets']>> }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    if (!campusId) throw new BadRequestException('campusId required');
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      throw new BadRequestException(`month must be 'YYYY-MM'`);
    }

    // A04 防御: boss 强制 jwt.campusId (admin 可任意)
    if (req.user?.role === 'boss' && req.user.campusId !== campusId) {
      throw new ForbiddenException(
        'BOSS_CROSS_CAMPUS_DENIED: boss 只能查本校 (jwt.campusId)',
      );
    }

    const items = await this.kpi.listTargets(tenantSchema, campusId, month);
    return { items };
  }

  // ============================================================
  // 2026-05-22 SSOT §6.8 set-target endpoint — 校长下发月度目标
  // ============================================================
  /**
   * POST /api/db/kpi/set-target — 校长（boss）下发本校 academic / teacher 月度消课目标
   *
   * Body: { tenantSchema, targetRole: 'academic' | 'teacher', targetUserId, month,
   *         targetLessons, note?, campusId? }
   *
   * RBAC (SSOT §6.8 + §2.10):
   *   - @Roles('boss', 'admin') — 主入口校长 / 老板兜底（不日常下发）
   *   - boss campusId 强制 = jwt.campusId (A04 防 client scope)
   *   - admin 可任意 campusId（跨校）
   *
   * 目标硬上限 (SSOT §6.8): sum(月度目标) ≤ sum(本月可消课时)
   *   → V1 不强校验（拍板说线下沟通解决），audit_log 留痕
   *   → Sprint Y backlog: 加 controller 层硬上限校验
   *
   * 谁设定谁调整（SSOT §6.8）:
   *   - UPSERT 模式: 同人同月 → UPDATE target_lessons
   *   - audit_log 'kpi.target.set' / 'kpi.target.updated'
   *
   * 软件少内部审核（§2.10）: 校长直接设定，无审批流程
   */
  // 2026-05-22: set-target 是写操作, 单独保留 throttle (60/min) 防误触/恶意
  @Post('set-target')
  @Roles('boss', 'admin')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  async setMonthlyTarget(
    @Body()
    body: {
      tenantSchema: string;
      campusId?: string;
      targetRole: 'academic' | 'teacher';
      targetUserId: string;
      month: string;
      targetLessons: number;
      note?: string;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<{ id: string; updated: boolean }> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    if (!body.targetRole || (body.targetRole !== 'academic' && body.targetRole !== 'teacher')) {
      throw new BadRequestException(`targetRole must be 'academic' or 'teacher'`);
    }
    if (!body.targetUserId || body.targetUserId.length !== 32) {
      throw new BadRequestException('targetUserId must be 32-char ULID');
    }
    if (!body.month || !/^\d{4}-\d{2}$/.test(body.month)) {
      throw new BadRequestException(`month must be 'YYYY-MM' format`);
    }
    if (typeof body.targetLessons !== 'number' || body.targetLessons < 0) {
      throw new BadRequestException('targetLessons must be >= 0');
    }
    const setByUserId = req.user?.sub;
    if (!setByUserId) throw new BadRequestException('user sub required');

    // A04 防御: boss 强制 jwt.campusId / admin 可任意
    let finalCampusId = body.campusId;
    if (req.user?.role === 'boss') {
      finalCampusId = req.user.campusId || finalCampusId;
      if (body.campusId && body.campusId !== req.user.campusId) {
        throw new ForbiddenException(
          'BOSS_CROSS_CAMPUS_DENIED: boss 只能下发本校目标 (jwt.campusId)',
        );
      }
    }
    if (!finalCampusId || finalCampusId.length !== 32) {
      throw new BadRequestException('campusId required (32-char ULID)');
    }

    // #24: B 端自由文本过微信内容安全（risky → 400 拒存；写库前拦截，违规内容不落库）
    //   set-target 唯一自由文本 = note（目标设定备注，可选）。默认 reject 策略对齐 §12C。
    await this.contentModeration.enforceStaffText(
      body.tenantSchema,
      [body.note],
      {
        action: 'kpi',
        targetType: 'kpi_target',
        targetId: body.targetUserId,
        req,
      },
    );

    const result = await this.kpi.setMonthlyTarget(body.tenantSchema, {
      campusId: finalCampusId,
      targetRole: body.targetRole,
      targetUserId: body.targetUserId,
      month: body.month,
      targetLessons: body.targetLessons,
      setByBossUserId: setByUserId,
      note: body.note,
    });

    // audit_log (SSOT §2.10 「留痕不审核」)
    await this.tryAuditKpiRead(
      body.tenantSchema,
      req,
      result.updated ? 'kpi.target.updated' : 'kpi.target.set',
      setByUserId,
    );

    return result;
  }

  /**
   * 2026-06-02 SSOT §3.-2 D 全局校区筛选 — GET KPI 聚合端点专用
   *
   * 把 effective campusId（admin 可经 @Query('campusId') override ∈ 本租户 campuses；
   * 非 admin 含 boss 恒用 JWT.campusId）转成 service 期望的 campusIds 形状：
   *   - 命中具体校区 → [campusId]（本校聚合）
   *   - null（admin JWT.campusId 为 null 且无 override）→ null（既有「全部校区」兜底，
   *     跨校聚合后续 follow-up；明心单校 admin 的 JWT.campusId 非 null → [campusId]）
   *
   * 替代旧 resolveCampusScope（csv 多选）：§3.-2 D MVP「选具体校区」单值，
   * 非 admin override 由 helper 直接忽略恒 JWT（A04 防越权选他校）。
   */
  private async resolveCampusIdsScope(
    req: AuthenticatedRequest,
    overrideCampusId: string | undefined,
  ): Promise<string[] | null> {
    const campusId = await resolveEffectiveCampusId(
      req,
      overrideCampusId,
      this.campusRepo,
    );
    return campusId ? [campusId] : null;
  }

  /**
   * GET /db/kpi/signed — 本月新签聚合
   * Query: tenantSchema (必填) + campusId (§3.-2 D: admin override ∈ 本租户 / 非 admin 恒 JWT)
   */
  @Get('signed')
  @Roles('admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async signedKpi(
    @Query('tenantSchema') tenantSchema: string,
    @Req() req: AuthenticatedRequest,
    @Query('campusId') campusId?: string,
  ): Promise<SignedKpiResult> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const campusIds = await this.resolveCampusIdsScope(req, campusId);
    return this.kpi.getSignedKpi(tenantSchema, { campusIds });
  }

  /**
   * GET /db/kpi/renewal — 本月续约聚合
   * Query: tenantSchema (必填) + campusId (§3.-2 D)
   */
  @Get('renewal')
  @Roles('admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async renewalKpi(
    @Query('tenantSchema') tenantSchema: string,
    @Req() req: AuthenticatedRequest,
    @Query('campusId') campusId?: string,
  ): Promise<RenewalKpiResult> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const campusIds = await this.resolveCampusIdsScope(req, campusId);
    return this.kpi.getRenewalKpi(tenantSchema, { campusIds });
  }

  /**
   * GET /db/kpi/consumption — 本月消课聚合（仅 academic 维度）
   * Query: tenantSchema (必填) + campusId (§3.-2 D)
   */
  @Get('consumption')
  @Roles('admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async consumptionKpi(
    @Query('tenantSchema') tenantSchema: string,
    @Req() req: AuthenticatedRequest,
    @Query('campusId') campusId?: string,
  ): Promise<ConsumptionKpiResult> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const campusIds = await this.resolveCampusIdsScope(req, campusId);
    return this.kpi.getConsumptionKpi(tenantSchema, { campusIds });
  }

  /**
   * GET /db/kpi/student-activity — 学员活跃度（按校区分桶）
   * Query: tenantSchema (必填) + campusId (csv)
   */
  @Get('student-activity')
  @Roles('admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async studentActivityKpi(
    @Query('tenantSchema') tenantSchema: string,
    @Req() req: AuthenticatedRequest,
    @Query('campusId') campusIdCsv?: string,
  ): Promise<StudentActivityKpiResult> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const campusIds = this.resolveCampusScope(
      req.user?.role,
      req.user?.campusId,
      campusIdCsv,
    );
    return this.kpi.getStudentActivityKpi(tenantSchema, { campusIds });
  }

  // ============================================================
  // 2026-06-02 SSOT §3.-2 A「课程销量」— admin/boss 经营首页组 4 替换「学员状态」
  //   全 POST（body.tenantSchema 经 tenant.middleware 回填）+ 强制本校 campus-scope
  // ============================================================

  /**
   * POST /db/kpi/course-sales — A-Level2 课程销量排名（本月 + 本校 scope）
   *   Body: { tenantSchema }（tenantSchema 由 middleware 从 header 回填）
   *   RBAC: @Roles('admin', 'boss')（经营首页 = 老板/校长视角）
   *   campusId 一律 JWT（缺 → 403）；GROUP BY course_product_id，salesCount DESC
   *
   *   返 { total, items: [{ courseProductId, productName, salesCount }] }
   *   total = Σ salesCount（= home Level1 KPI「本月课程销量 N」）
   *
   *   不写 audit_log：与既有 signed/renewal/consumption 一致（高频 KPI 读路径，
   *   越权由 RbacGuard + TenantScopeGuard + 强制 campus-scope 三层兜住）。
   */
  @Post('course-sales')
  @Roles('admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async courseSales(
    @Body() body: { tenantSchema: string; campusId?: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<CourseSalesResult> {
    if (!body?.tenantSchema) throw new BadRequestException('tenantSchema required');
    // §3.-2 D: admin 可经 body.campusId override（校验 ∈ 本租户）；非 admin 恒 JWT.campusId
    const campusId = await this.resolveRequiredCampusId(req, body.campusId);
    return this.kpi.getCourseSales(body.tenantSchema, campusId);
  }

  /**
   * POST /db/kpi/course-sales/by-person — A-Level3 某课程的人员销量（本月 + 本校 scope）
   *   Body: { tenantSchema, courseProductId }
   *   RBAC: @Roles('admin', 'boss')；campusId 一律 JWT（缺 → 403）
   *   同窗口/scope，WHERE course_product_id = $courseProductId，GROUP BY owner_user_id
   *
   *   返 { productName, items: [{ salesUserId, salesName, salesCount }] }（salesCount DESC）
   *   salesName 用 users.name（非一级 PII）；owner_user_id 为 null 归「系统」
   */
  @Post('course-sales/by-person')
  @Roles('admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async courseSalesByPerson(
    @Body() body: { tenantSchema: string; courseProductId: string; campusId?: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<CourseSalesByPersonResult> {
    if (!body?.tenantSchema) throw new BadRequestException('tenantSchema required');
    if (!body.courseProductId || body.courseProductId.length !== 32) {
      throw new BadRequestException('courseProductId must be 32-char ULID');
    }
    // 2026-06-02 D follow-up #5：与 Level-2 course-sales 校区一致（admin 选校区下钻 by-person 跟随）。
    //   resolveRequiredCampusId：admin override 校验 ∈ 本租户 / 非 admin 恒 JWT.campusId。
    const campusId = await this.resolveRequiredCampusId(req, body.campusId);
    return this.kpi.getCourseSalesByPerson(
      body.tenantSchema,
      campusId,
      body.courseProductId,
    );
  }

  // ============================================================
  // 2026-06-02 SSOT §3.-2 E「消课数据双维度排名」— admin/boss 经营首页
  //   原「老师业绩榜·本月」(teacher-leaderboard) 改为消课数据，分 教务 / 老师 两 tab
  // ============================================================

  /**
   * POST /db/kpi/consumption-ranking — E 消课数据双维度排名（本月 + 本校 scope）
   *   Body: { tenantSchema }（tenantSchema 由 middleware 从 header 回填）
   *   RBAC: @Roles('admin', 'boss')（经营首页 = 老板/校长视角）
   *   campusId 一律 JWT（缺 → 403 KPI_NO_CAMPUS）；禁信前端
   *
   *   返 { teacher: [{ id, name, lessonCount }], academic: [...] }（各 lessonCount DESC）
   *     - teacher 维：GROUP BY schedules.teacher_id（谁教的）
   *     - academic 维：GROUP BY schedules.created_by_user_id WHERE created_by_role ∈
   *       (academic, academic_admin)（谁排的课；admin/boss 自排不计入教务维）
   *   数据源 course_consumptions（status='confirmed' + confirmed_at 本月）JOIN schedules。
   *
   *   不写 audit_log：与既有 signed/renewal/consumption/course-sales 一致（高频 KPI
   *   读路径，越权由 RbacGuard + TenantScopeGuard + 强制 campus-scope 三层兜住）。
   *   fail-open：聚合失败 → { teacher: [], academic: [] }（不破坏 home）。
   */
  @Post('consumption-ranking')
  @Roles('admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async consumptionRanking(
    @Body() body: { tenantSchema: string; campusId?: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<ConsumptionRankingResult> {
    if (!body?.tenantSchema) throw new BadRequestException('tenantSchema required');
    // §3.-2 D: admin 可经 body.campusId override（校验 ∈ 本租户）；非 admin 恒 JWT.campusId
    const campusId = await this.resolveRequiredCampusId(req, body.campusId);
    return this.kpi.getConsumptionRanking(body.tenantSchema, campusId);
  }

  // ============================================================
  // 2026-05-22 Level 3 明细 — 4 KPI list endpoint (用户拍板)
  //   替代 Level 2 「按销售/教务分组」中间层, 直接列合同/消课/学员明细
  // ============================================================

  /**
   * 解析分页参数 limit/offset
   */
  private _parsePaging(
    limit: string | undefined,
    offset: string | undefined,
  ): { limit: number; offset: number } {
    const l = parseInt(limit || '50', 10);
    const o = parseInt(offset || '0', 10);
    return {
      limit: Number.isFinite(l) && l > 0 && l <= 200 ? l : 50,
      offset: Number.isFinite(o) && o >= 0 ? o : 0,
    };
  }

  @Get('signed/items')
  @Roles('admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async signedItems(
    @Query('tenantSchema') tenantSchema: string,
    @Req() req: AuthenticatedRequest,
    @Query('campusId') campusIdCsv?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<KpiListResult<KpiContractItem>> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const campusIds = this.resolveCampusScope(req.user?.role, req.user?.campusId, campusIdCsv);
    const paging = this._parsePaging(limit, offset);
    return this.kpi.listSignedContracts(tenantSchema, { campusIds, ...paging });
  }

  @Get('renewal/items')
  @Roles('admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async renewalItems(
    @Query('tenantSchema') tenantSchema: string,
    @Req() req: AuthenticatedRequest,
    @Query('campusId') campusIdCsv?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<KpiListResult<KpiContractItem>> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const campusIds = this.resolveCampusScope(req.user?.role, req.user?.campusId, campusIdCsv);
    const paging = this._parsePaging(limit, offset);
    return this.kpi.listRenewalContracts(tenantSchema, { campusIds, ...paging });
  }

  @Get('consumption/items')
  @Roles('admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async consumptionItems(
    @Query('tenantSchema') tenantSchema: string,
    @Req() req: AuthenticatedRequest,
    @Query('campusId') campusIdCsv?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<KpiListResult<KpiConsumptionItem>> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const campusIds = this.resolveCampusScope(req.user?.role, req.user?.campusId, campusIdCsv);
    const paging = this._parsePaging(limit, offset);
    return this.kpi.listConsumptionItems(tenantSchema, { campusIds, ...paging });
  }

  @Get('student-activity/items')
  @Roles('admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async studentActivityItems(
    @Query('tenantSchema') tenantSchema: string,
    @Req() req: AuthenticatedRequest,
    @Query('campusId') campusIdCsv?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('activeOnly') activeOnly?: string,
  ): Promise<KpiListResult<KpiStudentActivityItem>> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const campusIds = this.resolveCampusScope(req.user?.role, req.user?.campusId, campusIdCsv);
    const paging = this._parsePaging(limit, offset);
    return this.kpi.listStudentActivity(tenantSchema, {
      campusIds,
      ...paging,
      activeOnly: activeOnly === 'true',
    });
  }
}
