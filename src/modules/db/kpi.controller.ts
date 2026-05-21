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
} from './kpi.service';
import {
  ActorRole,
  AuditLogRepository,
  normalizeActorRole,
} from './audit-log.repository';
// 2026-05-22 SSOT §6.9 KPI 5min Redis cache (fail-open)
import { RedisService } from '../redis/redis.service';

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
@Controller('db/kpi')
@UseGuards(TenantScopeGuard, RbacGuard)
export class KpiController {
  private readonly logger = new Logger(KpiController.name);

  constructor(
    private readonly kpi: KpiService,
    // 2026-05-22 Sprint Y: 老师/教务/财务 home audit_log read 写入
    // @Optional unit spec 兼容；fail-open log() 内部已 catch
    @Optional() private readonly auditLog?: AuditLogRepository,
    // 2026-05-22 SSOT §6.9 Redis 5min KPI cache (fail-open PG 兜底)
    @Optional() private readonly redis?: RedisService,
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
    if (!this.auditLog) return;
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
   * 2026-05-21 销售自视角 home KPI
   *   GET /db/kpi/sales-home?tenantSchema=
   *   Auth: JWT.sub → salesUserId（不接受 client 传 userId 防伪造）
   *   RBAC: sales / sales_manager 可读自己 home 数据
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
    return this.kpi.getSalesHomeKpi(tenantSchema, salesUserId);
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
  @Post('set-target')
  @Roles('boss', 'admin')
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
   * GET /db/kpi/signed — 本月新签聚合
   * Query: tenantSchema (必填) + campusId (csv, admin 可选 / boss 仅本校)
   */
  @Get('signed')
  @Roles('admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async signedKpi(
    @Query('tenantSchema') tenantSchema: string,
    @Req() req: AuthenticatedRequest,
    @Query('campusId') campusIdCsv?: string,
  ): Promise<SignedKpiResult> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const campusIds = this.resolveCampusScope(
      req.user?.role,
      req.user?.campusId,
      campusIdCsv,
    );
    return this.kpi.getSignedKpi(tenantSchema, { campusIds });
  }

  /**
   * GET /db/kpi/renewal — 本月续约聚合
   * Query: tenantSchema (必填) + campusId (csv)
   */
  @Get('renewal')
  @Roles('admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async renewalKpi(
    @Query('tenantSchema') tenantSchema: string,
    @Req() req: AuthenticatedRequest,
    @Query('campusId') campusIdCsv?: string,
  ): Promise<RenewalKpiResult> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const campusIds = this.resolveCampusScope(
      req.user?.role,
      req.user?.campusId,
      campusIdCsv,
    );
    return this.kpi.getRenewalKpi(tenantSchema, { campusIds });
  }

  /**
   * GET /db/kpi/consumption — 本月消课聚合（仅 academic 维度）
   * Query: tenantSchema (必填) + campusId (csv)
   */
  @Get('consumption')
  @Roles('admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async consumptionKpi(
    @Query('tenantSchema') tenantSchema: string,
    @Req() req: AuthenticatedRequest,
    @Query('campusId') campusIdCsv?: string,
  ): Promise<ConsumptionKpiResult> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const campusIds = this.resolveCampusScope(
      req.user?.role,
      req.user?.campusId,
      campusIdCsv,
    );
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
}
