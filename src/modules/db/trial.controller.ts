import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Logger,
  Optional,
  Param,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';
import { RbacGuard } from '../../guards/rbac.guard';
import { Roles } from '../../guards/rbac.decorator';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';
import { IdempotencyInterceptor } from '../../common/idempotency/idempotency.interceptor';
import { ContentModerationService } from '../security/content-moderation.service';
import {
  ActorRole,
  AuditLogRepository,
  normalizeActorRole,
} from './audit-log.repository';
import { TrialRepository, Trial, TrialStatus } from './trial.repository';
import { TrialAssignmentService } from './trial-assignment.service';
import { UserRepository } from './user.repository';
import { TeacherRepository } from './teacher.repository';
import { CustomerRepository } from './customer.repository';
import { ASSIGNMENT_POOL_ROLES } from './student-assignment.service';
import { actorGroupOf } from '../../common/role-field-filter';
import { ulid } from 'ulid';

/** genId32 — 全库约定（5/31 教训：新建路径 id 必用此，不用裸 ulid()） */
function genId32(): string {
  return ulid().padEnd(32, '0').slice(0, 32);
}

/** 默认试听时长（分钟）—— 冲突校验用（trials 表无 end 列，用此推算 end） */
const TRIAL_DURATION_MIN = 60;

/**
 * TrialController — V64 (Phase 4) 试听课流程（核心·一等公民）
 *
 * 来源：../edu-mp-sandbox/docs/2026-06-01-业务链方案-试听激活分配反馈.md Phase 4（#9）
 *
 * 路径前缀 /api/db/trials/*（全 POST：写动作 + 读列表统一 body 带 tenantSchema）：
 *   POST /db/trials                       销售发起试听（建 + 触发分配）        @Roles sales/sales_manager
 *   POST /db/trials/my-trials             教务「我的试听」（assigned=自己）     @Roles academic/academic_admin
 *   POST /db/trials/pending-assignment    校长本校待分配（assigned IS NULL）   @Roles boss/admin
 *   POST /db/trials/:id/assign-academic   校长手动派教务                       @Roles boss/admin
 *   POST /db/trials/:id/arrange           教务排老师（冲突校验）               @Roles academic/academic_admin
 *   POST /db/trials/:id/complete          教务标记已试听                       @Roles academic/academic_admin
 *   POST /db/trials/:id/result            销售/教务定结果 converted/lost       @Roles sales/sales_manager/academic/academic_admin
 *   POST /db/trials/campus-list           校长本校列表                         @Roles boss/admin
 *
 * 横切：
 *   - 全 @UseGuards(TenantScopeGuard, RbacGuard) — 跨租户 403 + 角色门。
 *   - campusId 一律取自 JWT（禁信前端传参防伪造跨校）；缺 campusId → 403（boss/finance 单校必有）。
 *     admin 跨校：本组「本校」语义端点同样要求 campusId 上下文（与 contract.pending-activation 同纪律）。
 *   - 写动作 audit_log（trial.create / trial.assign-academic / trial.arrange / trial.complete / trial.result）。
 *   - 自由文本（preferredTime / result_note）过 ContentModerationService.enforceStaffText（§12C/§24）。
 *   - 写动作配 IdempotencyInterceptor（全局已注册；此处显式标注语义）。
 *
 * 状态机（V64 CHECK）：pending_assign → pending_teacher → scheduled → done → converted/lost。
 *   非法转移在 repo 层 UPDATE WHERE status 二次兜底（返 null）+ controller 显式校验拒 400。
 */
@Controller('db/trials')
@UseGuards(TenantScopeGuard, RbacGuard)
export class TrialController {
  private readonly logger = new Logger(TrialController.name);

  constructor(
    private readonly trialRepo: TrialRepository,
    private readonly assignmentService: TrialAssignmentService,
    private readonly userRepo: UserRepository,
    private readonly teacherRepo: TeacherRepository,
    // #24: B 端自由文本内容安全（@Global SecurityModule 注入，生产必有）
    private readonly contentModeration: ContentModerationService,
    // @Optional：unit spec 直接 new 不传也能跑；fail-open 不阻塞主业务
    @Optional() private readonly auditLog?: AuditLogRepository,
    // 2026-06-01 IDOR 收口：create 校验「发起销售拥有该客户 + 本校」用。
    //   @Optional 兼容既有 unit spec（直接 new 不传）；生产 db.module 已注册必有。
    //   置于构造末位以保留既有 spec 的 6 位实参（auditLog 仍第 6 位）位置绑定。
    @Optional() private readonly customerRepo?: CustomerRepository,
  ) {}

  // ============================================================
  // helpers
  // ============================================================
  /** 取调用者本校 campusId（缺失 → 403，禁信前端） */
  private requireCampusId(req: AuthenticatedRequest): string {
    const campusId = req.user?.campusId;
    if (!campusId) {
      throw new ForbiddenException(
        'TRIAL_NO_CAMPUS: caller must have a campusId scope (boss single-campus; admin must supply campus context)',
      );
    }
    return campusId;
  }

  private requireUserId(req: AuthenticatedRequest): string {
    const userId = req.user?.sub;
    if (!userId) throw new BadRequestException('user sub required');
    return userId;
  }

  private auditCtx(req: AuthenticatedRequest): {
    actorRole: ActorRole;
    ip: string | null;
    userAgent: string | null;
    requestId: string | null;
  } {
    return {
      actorRole: normalizeActorRole(req.user?.role),
      ip: req.ip ?? null,
      userAgent: (req.headers?.['user-agent'] as string | undefined) ?? null,
      requestId: (req.headers?.['x-request-id'] as string | undefined) ?? null,
    };
  }

  private async tryAudit(
    tenantSchema: string,
    entry: {
      actorUserId: string | null;
      actorRole: ActorRole;
      action: string;
      targetType: string;
      targetId: string | null;
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
      ip: string | null;
      userAgent: string | null;
      requestId: string | null;
    },
  ): Promise<void> {
    if (!this.auditLog) {
      this.logger.warn(
        `audit log repo not injected, skipping audit for ${entry.action} (target=${entry.targetId})`,
      );
      return;
    }
    try {
      await this.auditLog.log(tenantSchema, entry);
    } catch {
      // fail-open
    }
  }

  private requireTrialId(id: string): void {
    if (!id || id.length !== 32) {
      throw new BadRequestException('trial id must be 32-char ULID');
    }
  }

  // ============================================================
  // 1. 销售发起试听（建 + 触发分配）
  // ============================================================
  /**
   * POST /db/trials
   * body: { tenantSchema, customerId, studentName, subject, preferredTime? }
   *
   * 1. preferredTime 过内容安全（risky → 400 不写库）。
   * 2. 建 trial（pending_assign，id=genId32）。
   * 3. 触发分配（复用 Phase 3 校长开关；auto ON 派教务+pending_teacher，OFF 留 pending_assign）。
   *    分配 side-effect try/catch fail-open（失败不让发起失败，试听落待分配校长手动兜）。
   * 4. audit trial.create + 返回最新 trial（分配后重读）。
   */
  @Post()
  @Roles('sales', 'sales_manager')
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body()
    body: {
      tenantSchema: string;
      customerId: string;
      studentName: string;
      subject: string;
      preferredTime?: string;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<Trial> {
    if (!body?.tenantSchema) throw new BadRequestException('tenantSchema required');
    if (!body.customerId || body.customerId.length !== 32) {
      throw new BadRequestException('customerId must be 32-char ULID');
    }
    if (!body.studentName || !body.studentName.trim()) {
      throw new BadRequestException('studentName required');
    }
    if (!body.subject || !body.subject.trim()) {
      throw new BadRequestException('subject required');
    }
    const campusId = this.requireCampusId(req);
    const userId = this.requireUserId(req);

    // 1. 自由文本（preferredTime）过内容安全 —— 写库前拦截违规
    await this.contentModeration.enforceStaffText(
      body.tenantSchema,
      [body.preferredTime, body.studentName, body.subject],
      {
        action: 'trial',
        targetType: 'trial',
        targetId: null,
        req,
      },
    );

    // 1.5 customer owner-scope（2026-06-01 中危 IDOR 收口）
    //   原仅校验 customerId.length===32，未验该 customer 属发起销售/本校 →
    //   sales 可给他人客户发起试听（同租户 IDOR）。仿 contract by-student 的 actorGroup scope：
    //     - sales group（个人销售线）→ customer.ownerUserId === JWT.sub 才放行（自己的客户）。
    //     - admin group（sales_manager 归 admin group，见 actorGroupOf）→ 本校放行（不 owner 收口，
    //       与既有 contract/customer 对 sales_manager「校内主管全权」口径一致）。
    //   并一律校验 customer.campusId === JWT.campusId（跨校 403）。
    //   customer 不存在 → 400（与 requireTrialId/customerId 校验同风格）。
    //   注：customerRepo @Optional（旧 unit spec 不传）→ 缺失则跳过（fail-open；生产 db.module 必注入）。
    if (this.customerRepo) {
      const ownership = await this.customerRepo.findOwnershipById(
        body.tenantSchema,
        body.customerId,
      );
      if (!ownership) {
        throw new BadRequestException(
          `TRIAL_CUSTOMER_NOT_FOUND: customer ${body.customerId} not found`,
        );
      }
      const group = actorGroupOf(req.user?.role);
      // sales 个人线：必须拥有该客户
      if (group === 'sales' && ownership.ownerUserId !== userId) {
        await this.tryAudit(body.tenantSchema, {
          actorUserId: userId,
          ...this.auditCtx(req),
          action: 'trial.create-denied',
          targetType: 'customer',
          targetId: body.customerId,
          before: null,
          after: {
            attempted_owner: userId,
            actual_owner: ownership.ownerUserId ?? null,
            reason: 'not-own-customer',
          },
        });
        throw new ForbiddenException(
          `TRIAL_CREATE_NOT_OWN_CUSTOMER: customer ${body.customerId} not owned by caller`,
        );
      }
      // 一律本校校验（sales 与 sales_manager/admin 同）：跨校 403
      if (ownership.campusId !== campusId) {
        await this.tryAudit(body.tenantSchema, {
          actorUserId: userId,
          ...this.auditCtx(req),
          action: 'trial.create-denied',
          targetType: 'customer',
          targetId: body.customerId,
          before: null,
          after: {
            attempted_campus: campusId,
            actual_campus: ownership.campusId ?? null,
            reason: 'cross-campus',
          },
        });
        throw new ForbiddenException(
          `TRIAL_CREATE_CROSS_CAMPUS: customer campus=${ownership.campusId ?? 'null'} != caller campus=${campusId}`,
        );
      }
    }

    // 2. 建 trial（pending_assign）
    const trialId = genId32();
    const created = await this.trialRepo.create(body.tenantSchema, {
      id: trialId,
      customerId: body.customerId,
      studentName: body.studentName.trim(),
      subject: body.subject.trim(),
      preferredTime: body.preferredTime?.trim() || null,
      campusId,
      initiatedBy: userId,
    });

    // 3. audit trial.create（发起留证）
    await this.tryAudit(body.tenantSchema, {
      actorUserId: userId,
      ...this.auditCtx(req),
      action: 'trial.create',
      targetType: 'trial',
      targetId: trialId,
      before: null,
      after: {
        customerId: body.customerId,
        studentName: created.studentName,
        subject: created.subject,
        campusId,
        status: created.status,
      },
    });

    // 4. 触发分配（side-effect, fail-open）
    try {
      await this.assignmentService.assignTrialIfNeeded(
        body.tenantSchema,
        trialId,
        campusId,
        { userId, role: req.user?.role },
      );
    } catch (e) {
      this.logger.warn(
        `trial assignment failed (trial=${trialId}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }

    // 重读返回最新态（分配可能把 status 推到 pending_teacher）
    const latest = await this.trialRepo.findById(body.tenantSchema, trialId);
    return latest ?? created;
  }

  // ============================================================
  // 2. 教务「我的试听」
  // ============================================================
  @Post('my-trials')
  @Roles('academic', 'academic_admin')
  @HttpCode(HttpStatus.OK)
  async myTrials(
    @Body()
    body: { tenantSchema: string; status?: TrialStatus; limit?: number; offset?: number },
    @Req() req: AuthenticatedRequest,
  ): Promise<{ items: Trial[] }> {
    if (!body?.tenantSchema) throw new BadRequestException('tenantSchema required');
    const userId = this.requireUserId(req);
    const items = await this.trialRepo.list(body.tenantSchema, {
      assignedAcademicId: userId,
      status: body.status,
      limit: body.limit,
      offset: body.offset,
    });
    return { items };
  }

  // ============================================================
  // 2b. 销售「我发起的试听」（闭环：追踪转化 + done 定结果，SSOT §5.3.2 销售闭环）
  // ============================================================
  /**
   * POST /db/trials/my-initiated  body: { tenantSchema, status?, limit?, offset? }
   *   owner-scope：销售只看**自己发起**的试听（initiated_by = JWT.sub）；
   *   sales_manager 同样按本人 sub（团队视图走 team-performance，非本端点）。
   *   配合既有 POST /db/trials/:id/result（@Roles 含 sales/sales_manager）闭合「发起→转化/流失」环。
   */
  @Post('my-initiated')
  @Roles('sales', 'sales_manager')
  @HttpCode(HttpStatus.OK)
  async myInitiated(
    @Body()
    body: { tenantSchema: string; status?: TrialStatus; limit?: number; offset?: number },
    @Req() req: AuthenticatedRequest,
  ): Promise<{ items: Trial[] }> {
    if (!body?.tenantSchema) throw new BadRequestException('tenantSchema required');
    const userId = this.requireUserId(req);
    const items = await this.trialRepo.list(body.tenantSchema, {
      initiatedBy: userId,
      status: body.status,
      limit: body.limit,
      offset: body.offset,
    });
    return { items };
  }

  // ============================================================
  // 3. 校长本校待分配（assigned IS NULL）
  // ============================================================
  @Post('pending-assignment')
  @Roles('boss', 'admin')
  @HttpCode(HttpStatus.OK)
  async pendingAssignment(
    @Body() body: { tenantSchema: string; limit?: number; offset?: number },
    @Req() req: AuthenticatedRequest,
  ): Promise<{ items: Trial[] }> {
    if (!body?.tenantSchema) throw new BadRequestException('tenantSchema required');
    const campusId = this.requireCampusId(req);
    const items = await this.trialRepo.list(body.tenantSchema, {
      campusId,
      assignedIsNull: true,
      limit: body.limit,
      offset: body.offset,
    });
    return { items };
  }

  // ============================================================
  // 4. 校长手动派教务（pending_assign → pending_teacher）
  // ============================================================
  /**
   * POST /db/trials/:id/assign-academic  body: { tenantSchema, academicId }
   *   - 校验本校 + 目标 academic 本校在职。
   *   - 状态机：仅 pending_assign 可派（repo WHERE status 兜底 + 此处显式校验）。
   */
  @Post(':id/assign-academic')
  @Roles('boss', 'admin')
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(HttpStatus.OK)
  async assignAcademic(
    @Param('id') id: string,
    @Body() body: { tenantSchema: string; academicId: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<Trial> {
    if (!body?.tenantSchema) throw new BadRequestException('tenantSchema required');
    this.requireTrialId(id);
    if (!body.academicId || body.academicId.length !== 32) {
      throw new BadRequestException('academicId must be 32-char ULID');
    }
    const campusId = this.requireCampusId(req);
    const userId = this.requireUserId(req);

    // 1. 试听存在 + 同校 + 状态机校验
    const trial = await this.trialRepo.requireExists(body.tenantSchema, id);
    if (trial.campusId !== campusId) {
      throw new ForbiddenException(
        `TRIAL_ASSIGN_CROSS_CAMPUS: trial campus=${trial.campusId} != caller campus=${campusId}`,
      );
    }
    if (trial.status !== 'pending_assign') {
      throw new BadRequestException(
        `TRIAL_INVALID_TRANSITION: assign-academic requires status='pending_assign', got '${trial.status}'`,
      );
    }

    // 2. 校验目标 academicId 本校在职教务（与发牌池一致）
    const ok = await this.userRepo.isActiveAcademicInCampus(
      body.tenantSchema,
      body.academicId,
      campusId,
      ASSIGNMENT_POOL_ROLES,
    );
    if (!ok) {
      throw new BadRequestException(
        `TRIAL_INVALID_ACADEMIC: ${body.academicId} is not an active academic in campus ${campusId}`,
      );
    }

    // 3. 推进状态机（repo WHERE status='pending_assign' 二次兜底）
    const updated = await this.trialRepo.assignAcademic(
      body.tenantSchema,
      id,
      body.academicId,
    );
    if (!updated) {
      // 并发：他人已推进状态
      throw new BadRequestException(
        `TRIAL_INVALID_TRANSITION: trial ${id} no longer in 'pending_assign'`,
      );
    }

    await this.tryAudit(body.tenantSchema, {
      actorUserId: userId,
      ...this.auditCtx(req),
      action: 'trial.assign-academic',
      targetType: 'trial',
      targetId: id,
      before: { assignedAcademicId: trial.assignedAcademicId, status: trial.status },
      after: { assignedAcademicId: body.academicId, status: updated.status },
    });

    return updated;
  }

  // ============================================================
  // 5. 教务排老师（pending_teacher → scheduled，含冲突校验）
  // ============================================================
  /**
   * POST /db/trials/:id/arrange  body: { tenantSchema, teacherId, scheduledAt }
   *   - 状态机：仅 pending_teacher 可排。
   *   - decision 3 冲突校验：teacher 该时段（schedules + trials）无重叠，冲突 → 400 含信息。
   */
  @Post(':id/arrange')
  @Roles('academic', 'academic_admin')
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(HttpStatus.OK)
  async arrange(
    @Param('id') id: string,
    @Body() body: { tenantSchema: string; teacherId: string; scheduledAt: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<Trial> {
    if (!body?.tenantSchema) throw new BadRequestException('tenantSchema required');
    this.requireTrialId(id);
    if (!body.teacherId || body.teacherId.length !== 32) {
      throw new BadRequestException('teacherId must be 32-char ULID');
    }
    if (!body.scheduledAt) throw new BadRequestException('scheduledAt required');
    const scheduledAt = new Date(body.scheduledAt);
    if (isNaN(scheduledAt.getTime())) {
      throw new BadRequestException('scheduledAt must be a valid ISO datetime');
    }
    const campusId = this.requireCampusId(req);
    const userId = this.requireUserId(req);

    // 1. 试听存在 + 同校 + 状态机校验（仅 pending_teacher 可排）
    const trial = await this.trialRepo.requireExists(body.tenantSchema, id);
    // 2026-06-01：补 trial 跨校校验（与 assign-academic/complete/result 对称；原仅校验 teacher 校区，
    //   缺 trial 校区 → 他校教务可排本校 trial 的对称漏洞）。
    if (trial.campusId !== campusId) {
      throw new ForbiddenException(
        `TRIAL_ARRANGE_CROSS_CAMPUS: trial campus=${trial.campusId} != caller campus=${campusId}`,
      );
    }
    if (trial.status !== 'pending_teacher') {
      throw new BadRequestException(
        `TRIAL_INVALID_TRANSITION: arrange requires status='pending_teacher', got '${trial.status}'`,
      );
    }

    // 2. 校验老师本校在职（teachers.campus_id = caller campus）
    const teacher = await this.teacherRepo.findById(body.tenantSchema, body.teacherId);
    if (!teacher || teacher.status === '归档') {
      throw new BadRequestException(
        `TRIAL_INVALID_TEACHER: ${body.teacherId} not found or archived`,
      );
    }
    if (teacher.campusId && teacher.campusId !== campusId) {
      throw new ForbiddenException(
        `TRIAL_ARRANGE_CROSS_CAMPUS: teacher campus=${teacher.campusId} != caller campus=${campusId}`,
      );
    }

    // 3. decision 3 冲突校验：teacher 该时段（schedules + trials）无重叠
    const endAt = new Date(scheduledAt.getTime() + TRIAL_DURATION_MIN * 60 * 1000);
    const conflicts = await this.trialRepo.findTeacherConflicts(
      body.tenantSchema,
      body.teacherId,
      scheduledAt,
      endAt,
      TRIAL_DURATION_MIN,
      id, // 排除自身（重排幂等安全）
    );
    if (conflicts.length > 0) {
      const desc = conflicts
        .map((c) => `${c.source}#${c.id}(${c.startAt}~${c.endAt})`)
        .join(', ');
      throw new BadRequestException(
        `TRIAL_TEACHER_CONFLICT: teacher ${body.teacherId} 该时段已被占用: ${desc}`,
      );
    }

    // 4. 推进状态机（repo WHERE status='pending_teacher' 二次兜底）
    const updated = await this.trialRepo.arrange(
      body.tenantSchema,
      id,
      body.teacherId,
      scheduledAt,
    );
    if (!updated) {
      throw new BadRequestException(
        `TRIAL_INVALID_TRANSITION: trial ${id} no longer in 'pending_teacher'`,
      );
    }

    await this.tryAudit(body.tenantSchema, {
      actorUserId: userId,
      ...this.auditCtx(req),
      action: 'trial.arrange',
      targetType: 'trial',
      targetId: id,
      before: { status: trial.status, teacherId: trial.teacherId, scheduledAt: trial.scheduledAt },
      after: { status: updated.status, teacherId: body.teacherId, scheduledAt: updated.scheduledAt },
    });

    return updated;
  }

  // ============================================================
  // 6. 教务标记已试听（scheduled → done）
  // ============================================================
  @Post(':id/complete')
  @Roles('academic', 'academic_admin')
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(HttpStatus.OK)
  async complete(
    @Param('id') id: string,
    @Body() body: { tenantSchema: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<Trial> {
    if (!body?.tenantSchema) throw new BadRequestException('tenantSchema required');
    this.requireTrialId(id);
    const campusId = this.requireCampusId(req);
    const userId = this.requireUserId(req);

    const trial = await this.trialRepo.requireExists(body.tenantSchema, id);
    if (trial.campusId !== campusId) {
      throw new ForbiddenException(
        `TRIAL_COMPLETE_CROSS_CAMPUS: trial campus=${trial.campusId} != caller campus=${campusId}`,
      );
    }
    if (trial.status !== 'scheduled') {
      throw new BadRequestException(
        `TRIAL_INVALID_TRANSITION: complete requires status='scheduled', got '${trial.status}'`,
      );
    }

    const updated = await this.trialRepo.complete(body.tenantSchema, id);
    if (!updated) {
      throw new BadRequestException(
        `TRIAL_INVALID_TRANSITION: trial ${id} no longer in 'scheduled'`,
      );
    }

    await this.tryAudit(body.tenantSchema, {
      actorUserId: userId,
      ...this.auditCtx(req),
      action: 'trial.complete',
      targetType: 'trial',
      targetId: id,
      before: { status: trial.status },
      after: { status: updated.status },
    });

    return updated;
  }

  // ============================================================
  // 7. 试听结果（done → converted / lost）
  // ============================================================
  /**
   * POST /db/trials/:id/result  body: { tenantSchema, result: 'converted'|'lost', note? }
   *   - 状态机：仅 done 可定结果。
   *   - note 过内容安全。
   *   - 转化签约走既有签约流（不在此自动建合同）。
   */
  @Post(':id/result')
  @Roles('sales', 'sales_manager', 'academic', 'academic_admin')
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(HttpStatus.OK)
  async result(
    @Param('id') id: string,
    @Body()
    body: { tenantSchema: string; result: 'converted' | 'lost'; note?: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<Trial> {
    if (!body?.tenantSchema) throw new BadRequestException('tenantSchema required');
    this.requireTrialId(id);
    if (body.result !== 'converted' && body.result !== 'lost') {
      throw new BadRequestException("result must be 'converted' or 'lost'");
    }
    const campusId = this.requireCampusId(req);
    const userId = this.requireUserId(req);

    // 1. 试听存在 + 同校 + 状态机校验（仅 done 可定结果）
    //   2026-06-01：存在性/状态机校验前置于内容安全之前 —— 对不存在/非法态 trial 不应白调
    //   内容安全外部 API（msgSecCheck 配额/网络成本 + 减少无效外呼）。
    const trial = await this.trialRepo.requireExists(body.tenantSchema, id);
    if (trial.campusId !== campusId) {
      throw new ForbiddenException(
        `TRIAL_RESULT_CROSS_CAMPUS: trial campus=${trial.campusId} != caller campus=${campusId}`,
      );
    }
    if (trial.status !== 'done') {
      throw new BadRequestException(
        `TRIAL_INVALID_TRANSITION: result requires status='done', got '${trial.status}'`,
      );
    }

    // 2. result_note 自由文本过内容安全（存在性/状态机校验通过后才调，写库前拦截违规）
    await this.contentModeration.enforceStaffText(
      body.tenantSchema,
      [body.note],
      {
        action: 'trial',
        targetType: 'trial',
        targetId: id,
        req,
      },
    );

    const updated = await this.trialRepo.setResult(
      body.tenantSchema,
      id,
      body.result,
      body.note?.trim() || null,
    );
    if (!updated) {
      throw new BadRequestException(
        `TRIAL_INVALID_TRANSITION: trial ${id} no longer in 'done'`,
      );
    }

    await this.tryAudit(body.tenantSchema, {
      actorUserId: userId,
      ...this.auditCtx(req),
      action: 'trial.result',
      targetType: 'trial',
      targetId: id,
      before: { status: trial.status },
      after: { status: updated.status, result: body.result },
    });

    return updated;
  }

  // ============================================================
  // 8. 校长本校列表（可选 status 过滤）
  // ============================================================
  @Post('campus-list')
  @Roles('boss', 'admin')
  @HttpCode(HttpStatus.OK)
  async campusList(
    @Body()
    body: { tenantSchema: string; status?: TrialStatus; limit?: number; offset?: number },
    @Req() req: AuthenticatedRequest,
  ): Promise<{ items: Trial[] }> {
    if (!body?.tenantSchema) throw new BadRequestException('tenantSchema required');
    const campusId = this.requireCampusId(req);
    const items = await this.trialRepo.list(body.tenantSchema, {
      campusId,
      status: body.status,
      limit: body.limit,
      offset: body.offset,
    });
    return { items };
  }
}
