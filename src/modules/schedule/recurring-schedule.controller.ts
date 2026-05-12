import {
  Body,
  Controller,
  Optional,
  Param,
  Post,
  Req,
  HttpCode,
  HttpStatus,
  UseGuards,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import {
  RecurringScheduleService,
  StudentTeacherBinding,
  RecurringSchedule,
  WeekDay,
  RecurringRbacContext,
} from './recurring-schedule.service';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';
import { TeacherRepository } from '../db/teacher.repository';
import { StudentRepository } from '../db/student.repository';
import { ActorRole, AuditLogRepository, normalizeActorRole } from '../db/audit-log.repository';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';

/**
 * RecurringScheduleController — V8.1 学员-老师绑定 + 周期性课表 HTTP 暴露 BE-V8-2
 *
 * 路由前缀：/api/recurring
 *
 * USER-AUTH(2026-05-02): PD §3.6 + P12 学员-老师固定绑定 + 周期性模板
 *
 * Sprint B.4-1（2026-05-12）RBAC 收紧（leader 拍板 Q2）：
 *   - createBinding / createRecurring 同 schedule.controller 模式
 *   - createdByRole / createdByUserId / boundByUserId 全部 server 派生（JWT）
 *   - sales 路径：studentRepo.findBrief 反查 owner_sales_id
 *   - teacher 路径：teacherRepo.findById 反查 user_id
 *   - 其他 role: 403 ONLY_TEACHER_OR_SALES
 *
 * Sprint B.4-1 round 2（business P1-A + security A04 修复）：
 *   1. unbind / archive 两个写 endpoint 加 @Req() + 早期 403
 *      （原本任何登录用户都能调 → 限到 {teacher, sales}，trust boundary 收紧）
 *   2. createBinding / createRecurring 强制要求 tenantSchema（A04 修复）
 *      tenantSchema 可选导致 RBAC skip 路径 = client 控制安全级别（A04 硬违规）
 *   ⚠ ownership 校验（unbind/archive 是否归属当前 sales/teacher）记入 Sprint X backlog
 *
 * Sprint B.6 mini (2026-05-11) 深度防御：
 *   - class-level @UseGuards(TenantScopeGuard) — 兜底跨租户校验
 *
 * Sprint E backlog #3 (2026-05-13) audit_log 整体补齐：
 *   - 4 写 endpoint × 2 路径（成功 + 拒绝）= 8 处 audit_log 调用
 *   - createBinding/unbindBinding → targetType='student_teacher_binding'
 *     action='recurring-binding.create' / 'recurring-binding.unbind' / .denied
 *   - createRecurring/archiveRecurring → targetType='recurring_schedule'
 *     action='recurring-schedule.create' / 'recurring-schedule.archive' / .denied
 *   - unbind / archive 同步方法 → 改 async（audit 必须 await）
 *   - 拒绝路径 audit 写入相同 targetType（即使 tenantSchema='unknown' 写不进，fail-open）
 */
@UseGuards(TenantScopeGuard)
@Controller('recurring')
export class RecurringScheduleController {
  constructor(
    private readonly service: RecurringScheduleService,
    private readonly teacherRepo: TeacherRepository,
    private readonly studentRepo: StudentRepository,
    // Sprint E backlog #3: audit_log 注入
    @Optional() private readonly auditLog?: AuditLogRepository,
  ) {}

  /**
   * POST /api/recurring/bindings — 创建学员-老师绑定（按科目）
   *
   * Sprint B.4-1 round 2（A04 + business P1-B 修复）：
   *   - tenantSchema 改为必填（缺则抛 BadRequestException('TENANT_SCHEMA_REQUIRED')）
   *   - 不再有 "fixture 模式跳过 RBAC" 路径（client 控制安全级别 = A04 硬违规）
   *   - 所有调用都走 server-derive RBAC + rbacContext 强制传给 service
   *
   * Sprint E backlog #3: 成功 'recurring-binding.create' / 拒绝 'recurring-binding.create.denied'
   */
  @Post('bindings')
  @HttpCode(HttpStatus.CREATED)
  async createBinding(
    @Body()
    body: {
      id: string;
      studentId: string;
      teacherId: string;
      subject?: string;
      tenantSchema: string;
      // @deprecated Sprint B.4-1 起 server 派生
      boundByUserId?: string;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<StudentTeacherBinding> {
    if (!body.tenantSchema) {
      await this.tryAuditDenied(
        req,
        'unknown',
        'recurring-binding.create.denied',
        'student_teacher_binding',
        body.id ?? null,
        { reason: 'TENANT_SCHEMA_REQUIRED', endpoint: 'createBinding' },
      );
      throw new BadRequestException('TENANT_SCHEMA_REQUIRED');
    }
    let callerRole: 'teacher' | 'sales';
    let currentUserId: string;
    try {
      ({ callerRole, currentUserId } = this.assertCallerRoleAndDeriveContext(req));
    } catch (err) {
      await this.tryAuditDenied(
        req,
        body.tenantSchema,
        'recurring-binding.create.denied',
        'student_teacher_binding',
        body.id ?? null,
        { reason: this.reasonFromError(err), endpoint: 'createBinding' },
      );
      throw err;
    }
    let rbacContext: RecurringRbacContext;
    try {
      rbacContext = await this.deriveRbacContext(
        body.tenantSchema,
        callerRole,
        currentUserId,
        { studentId: body.studentId, teacherId: body.teacherId },
      );
    } catch (err) {
      await this.tryAuditDenied(
        req,
        body.tenantSchema,
        'recurring-binding.create.denied',
        'student_teacher_binding',
        body.id ?? null,
        { reason: this.reasonFromError(err), endpoint: 'createBinding' },
      );
      throw err;
    }

    let result: StudentTeacherBinding;
    try {
      result = await this.service.createBinding(
        {
          id: body.id,
          studentId: body.studentId,
          teacherId: body.teacherId,
          subject: body.subject,
          boundByUserId: currentUserId, // Sprint B.4-1: 强制覆盖
        },
        rbacContext,
      );
    } catch (err) {
      await this.tryAuditDenied(
        req,
        body.tenantSchema,
        'recurring-binding.create.denied',
        'student_teacher_binding',
        body.id ?? null,
        { reason: this.reasonFromError(err), endpoint: 'createBinding' },
      );
      throw err;
    }

    await this.tryAudit(req, body.tenantSchema, {
      action: 'recurring-binding.create',
      targetType: 'student_teacher_binding',
      targetId: result.id,
      before: null,
      after: this.bindingSnapshot(result, { endpoint: 'createBinding' }),
    });
    return result;
  }

  /**
   * POST /api/recurring/bindings/:id/unbind
   *
   * Sprint B.4-1 round 2 (business P1-A): 早期 403 — 仅 {teacher, sales} 可调
   * （admin/finance/parent/academic 任何登录用户原本可调，trust boundary 修复）
   *
   * NOTE: 暂不做 binding ownership 校验（sales 是否归属该 binding 的学员销售 /
   * teacher 是否归属该 binding 的老师），仅做角色限制。完整 ownership 校验记
   * Sprint X backlog。
   *
   * Sprint E backlog #3: 成功 'recurring-binding.unbind' / 拒绝 'recurring-binding.unbind.denied'
   *   - service 是同步方法，本方法因 audit 改 async
   */
  @Post('bindings/:id/unbind')
  @HttpCode(HttpStatus.OK)
  async unbindBinding(
    @Param('id') _id: string,
    // Sprint E #3 round 5: tenantSchema 改必填，与 createBinding/createRecurring 对齐
    @Body() body: { binding: StudentTeacherBinding; tenantSchema: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<StudentTeacherBinding> {
    if (!body.tenantSchema) {
      await this.tryAuditDenied(
        req,
        'unknown',
        'recurring-binding.unbind.denied',
        'student_teacher_binding',
        body.binding?.id ?? null,
        { reason: 'TENANT_SCHEMA_REQUIRED', endpoint: 'unbindBinding' },
      );
      throw new BadRequestException('TENANT_SCHEMA_REQUIRED');
    }
    try {
      this.assertCallerRoleAndDeriveContext(req); // 早期 403 {teacher,sales} 限制
    } catch (err) {
      await this.tryAuditDenied(
        req,
        body.tenantSchema,
        'recurring-binding.unbind.denied',
        'student_teacher_binding',
        body.binding?.id ?? null,
        { reason: this.reasonFromError(err), endpoint: 'unbindBinding' },
      );
      throw err;
    }
    const beforeBinding = this.deserializeBinding(body.binding);
    const before = this.bindingSnapshot(beforeBinding, { endpoint: 'unbindBinding' });
    const result = this.service.unbindBinding(beforeBinding);
    await this.tryAudit(req, body.tenantSchema, {
      action: 'recurring-binding.unbind',
      targetType: 'student_teacher_binding',
      targetId: result.id,
      before,
      after: this.bindingSnapshot(result, { endpoint: 'unbindBinding' }),
    });
    return result;
  }

  /**
   * POST /api/recurring/schedules — 创建周期性模板（含 90 天预检）
   *
   * Sprint B.4-1 round 2（A04 + business P1-B 修复）：
   *   - tenantSchema 改为必填（缺则抛 BadRequestException('TENANT_SCHEMA_REQUIRED')）
   *   - 不再有 "fixture 模式跳过 RBAC" 路径（A04 硬违规）
   *   - rbacContext 强制传给 service
   *
   * @returns active 模板（创建时未来 N 天展开预检通过）
   *
   * Sprint E backlog #3: 成功 'recurring-schedule.create' / 拒绝 'recurring-schedule.create.denied'
   */
  @Post('schedules')
  @HttpCode(HttpStatus.CREATED)
  async createRecurring(
    @Body()
    body: {
      input: {
        id: string;
        bindingId: string;
        studentId: string;
        teacherId: string;
        courseProductId?: string;
        byDay: WeekDay[];
        startMinutes: number;
        durationMin: number;
        startDate: string;
        endDate?: string;
        // @deprecated Sprint B.4-1 起 server 派生
        createdByUserId?: string;
        // @deprecated Sprint B.4-1 起 server 派生
        createdByRole?: 'teacher' | 'sales';
      };
      expandRangeDays: number;
      existingSchedules: Array<{
        teacherId: string;
        studentIds: string[];
        startAt: string;
        endAt: string;
        status: string;
      }>;
      tenantSchema: string;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<RecurringSchedule> {
    if (!body.tenantSchema) {
      await this.tryAuditDenied(
        req,
        'unknown',
        'recurring-schedule.create.denied',
        'recurring_schedule',
        body.input?.id ?? null,
        { reason: 'TENANT_SCHEMA_REQUIRED', endpoint: 'createRecurring' },
      );
      throw new BadRequestException('TENANT_SCHEMA_REQUIRED');
    }
    let callerRole: 'teacher' | 'sales';
    let currentUserId: string;
    try {
      ({ callerRole, currentUserId } = this.assertCallerRoleAndDeriveContext(req));
    } catch (err) {
      await this.tryAuditDenied(
        req,
        body.tenantSchema,
        'recurring-schedule.create.denied',
        'recurring_schedule',
        body.input?.id ?? null,
        { reason: this.reasonFromError(err), endpoint: 'createRecurring' },
      );
      throw err;
    }
    let rbacContext: RecurringRbacContext;
    try {
      rbacContext = await this.deriveRbacContext(
        body.tenantSchema,
        callerRole,
        currentUserId,
        { studentId: body.input.studentId, teacherId: body.input.teacherId },
      );
    } catch (err) {
      await this.tryAuditDenied(
        req,
        body.tenantSchema,
        'recurring-schedule.create.denied',
        'recurring_schedule',
        body.input?.id ?? null,
        { reason: this.reasonFromError(err), endpoint: 'createRecurring' },
      );
      throw err;
    }

    let result: RecurringSchedule;
    try {
      result = await this.service.createRecurring(
        {
          ...body.input,
          startDate: new Date(body.input.startDate),
          endDate: body.input.endDate ? new Date(body.input.endDate) : undefined,
          // Sprint B.4-1: server 派生覆盖
          createdByUserId: currentUserId,
          createdByRole: callerRole,
        },
        body.expandRangeDays,
        body.existingSchedules.map((s) => ({
          ...s,
          startAt: new Date(s.startAt),
          endAt: new Date(s.endAt),
        })),
        undefined, // now 默认值
        rbacContext,
      );
    } catch (err) {
      await this.tryAuditDenied(
        req,
        body.tenantSchema,
        'recurring-schedule.create.denied',
        'recurring_schedule',
        body.input?.id ?? null,
        { reason: this.reasonFromError(err), endpoint: 'createRecurring' },
      );
      throw err;
    }

    await this.tryAudit(req, body.tenantSchema, {
      action: 'recurring-schedule.create',
      targetType: 'recurring_schedule',
      targetId: result.id,
      before: null,
      after: this.recurringSnapshot(result, {
        endpoint: 'createRecurring',
        expandRangeDays: body.expandRangeDays,
      }),
    });
    return result;
  }

  /**
   * POST /api/recurring/schedules/:id/archive — 归档模板
   *
   * Sprint B.4-1 round 2 (business P1-A): 早期 403 — 仅 {teacher, sales} 可调
   * （admin/finance/parent/academic 任何登录用户原本可调，trust boundary 修复）
   *
   * NOTE: 暂不做 recurring schedule ownership 校验，仅做角色限制。完整
   * ownership 校验记 Sprint X backlog。
   *
   * Sprint E backlog #3: 成功 'recurring-schedule.archive' / 拒绝 'recurring-schedule.archive.denied'
   *   - service 是同步方法，本方法因 audit 改 async
   */
  @Post('schedules/:id/archive')
  @HttpCode(HttpStatus.OK)
  async archiveRecurring(
    @Param('id') _id: string,
    // Sprint E #3 round 5: tenantSchema 改必填，与 createBinding/createRecurring 对齐
    @Body() body: { recurring: RecurringSchedule; tenantSchema: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<RecurringSchedule> {
    if (!body.tenantSchema) {
      await this.tryAuditDenied(
        req,
        'unknown',
        'recurring-schedule.archive.denied',
        'recurring_schedule',
        body.recurring?.id ?? null,
        { reason: 'TENANT_SCHEMA_REQUIRED', endpoint: 'archiveRecurring' },
      );
      throw new BadRequestException('TENANT_SCHEMA_REQUIRED');
    }
    try {
      this.assertCallerRoleAndDeriveContext(req); // 早期 403 {teacher,sales} 限制
    } catch (err) {
      await this.tryAuditDenied(
        req,
        body.tenantSchema,
        'recurring-schedule.archive.denied',
        'recurring_schedule',
        body.recurring?.id ?? null,
        { reason: this.reasonFromError(err), endpoint: 'archiveRecurring' },
      );
      throw err;
    }
    const beforeRec = this.deserializeRecurring(body.recurring);
    const before = this.recurringSnapshot(beforeRec, { endpoint: 'archiveRecurring' });
    const result = this.service.archiveRecurring(beforeRec);
    await this.tryAudit(req, body.tenantSchema, {
      action: 'recurring-schedule.archive',
      targetType: 'recurring_schedule',
      targetId: result.id,
      before,
      after: this.recurringSnapshot(result, { endpoint: 'archiveRecurring' }),
    });
    return result;
  }

  /**
   * POST /api/recurring/schedules/expand-preview
   *
   * 用于前端创建模板前预览展开时段（不写入 DB）
   *
   * Sprint E backlog #3: pure calc read-only，不补 audit_log（本拍板范围仅写操作）
   */
  @Post('schedules/expand-preview')
  @HttpCode(HttpStatus.OK)
  expandPreview(
    @Body()
    body: {
      byDay: WeekDay[];
      startMinutes: number;
      durationMin: number;
      startDate: string;
      endDate?: string;
      rangeDays: number;
      nowMs?: number;
    },
  ): Array<{ startAt: Date; endAt: Date }> {
    return this.service.expandToCandidates(
      body.byDay,
      body.startMinutes,
      body.durationMin,
      new Date(body.startDate),
      body.endDate ? new Date(body.endDate) : undefined,
      body.rangeDays,
      body.nowMs ? new Date(body.nowMs) : new Date(),
    );
  }

  // -- helpers --

  /**
   * Sprint B.4-1: 同 ScheduleController.assertCallerRoleAndDeriveContext
   */
  private assertCallerRoleAndDeriveContext(req: AuthenticatedRequest): {
    callerRole: 'teacher' | 'sales';
    currentUserId: string;
  } {
    const jwt = req.user;
    if (!jwt?.sub || !jwt.role) {
      throw new BadRequestException('JWT sub/role required');
    }
    if (jwt.role !== 'teacher' && jwt.role !== 'sales') {
      throw new ForbiddenException(
        `ONLY_TEACHER_OR_SALES_CAN_CREATE_SCHEDULE: role=${jwt.role}`,
      );
    }
    return {
      callerRole: jwt.role,
      currentUserId: jwt.sub,
    };
  }

  /**
   * Sprint B.4-1: 派生 rbacContext，反查 student.owner_sales_id 或 teacher.user_id
   *
   * - sales: 反查 student.ownerSalesId，反查不到学生 → 抛 NotFound 风格的 403
   * - teacher: 反查 teacher.userId，反查不到老师 → 抛 NotFound 风格的 403
   *
   * TODO(perf): 反查 N=1，目前 OK；若未来 createRecurring batch 化需要批量查
   */
  private async deriveRbacContext(
    tenantSchema: string,
    callerRole: 'teacher' | 'sales',
    currentUserId: string,
    target: { studentId: string; teacherId: string },
  ): Promise<RecurringRbacContext> {
    // Sprint B.4-1 round 3 (Sprint E backlog #6 — A05 hardening): 错误 message 仅返错误码
    // 不再嵌入 studentId / teacherId 等内部 ID（统一与 service 层 assertRecurringRbac 一致）
    if (callerRole === 'sales') {
      const student = await this.studentRepo.findBrief(tenantSchema, target.studentId);
      if (!student) {
        throw new ForbiddenException('STUDENT_NOT_FOUND');
      }
      return {
        callerRole,
        currentUserId,
        studentResponsibleSalesId: student.ownerSalesId,
      };
    }
    // teacher
    const teacher = await this.teacherRepo.findById(tenantSchema, target.teacherId);
    if (!teacher) {
      throw new ForbiddenException('TEACHER_NOT_FOUND');
    }
    return {
      callerRole,
      currentUserId,
      teacherUserId: teacher.userId ?? null,
    };
  }

  private deserializeBinding(b: StudentTeacherBinding): StudentTeacherBinding {
    return {
      ...b,
      boundAt: new Date(b.boundAt as unknown as string),
      unboundAt: b.unboundAt ? new Date(b.unboundAt as unknown as string) : undefined,
    };
  }

  private deserializeRecurring(r: RecurringSchedule): RecurringSchedule {
    return {
      ...r,
      startDate: new Date(r.startDate as unknown as string),
      endDate: r.endDate ? new Date(r.endDate as unknown as string) : undefined,
      createdAt: new Date(r.createdAt as unknown as string),
      archivedAt: r.archivedAt ? new Date(r.archivedAt as unknown as string) : undefined,
    };
  }

  // -- helpers: audit_log (Sprint E backlog #3) --

  private async tryAudit(
    req: AuthenticatedRequest,
    tenantSchema: string,
    entry: {
      action: string;
      targetType: string;
      targetId: string | null;
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
    },
  ): Promise<void> {
    try {
      await this.auditLog?.log(tenantSchema, {
        actorUserId: req.user?.sub ?? null,
        actorRole: this.actorRole(req),
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        before: entry.before,
        after: entry.after,
        ip: req.ip ?? null,
        userAgent: (req.headers?.['user-agent'] as string | undefined) ?? null,
        requestId: (req.headers?.['x-request-id'] as string | undefined) ?? null,
      });
    } catch {
      // fail-open
    }
  }

  private async tryAuditDenied(
    req: AuthenticatedRequest,
    tenantSchema: string,
    action: string,
    targetType: string,
    targetId: string | null,
    after: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.auditLog?.log(tenantSchema, {
        actorUserId: req.user?.sub ?? null,
        actorRole: this.actorRole(req),
        action,
        targetType,
        targetId,
        before: null,
        after,
        ip: req.ip ?? null,
        userAgent: (req.headers?.['user-agent'] as string | undefined) ?? null,
        requestId: (req.headers?.['x-request-id'] as string | undefined) ?? null,
      });
    } catch {
      // fail-open
    }
  }

  /**
   * Sprint E #3 round 5 (A09 FINDING-1 修复):
   * 改用 normalizeActorRole 运行时白名单校验, JWT role 越界 → fallback 'system'
   * 防止 marketing/finance_admin 等违反 V33 CHECK 导致 audit 静默丢失
   */
  private actorRole(req: AuthenticatedRequest): ActorRole {
    return normalizeActorRole(req.user?.role);
  }

  private reasonFromError(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
  }

  /**
   * binding snapshot for audit_log（无 PII）
   */
  private bindingSnapshot(
    b: StudentTeacherBinding,
    extra?: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      id: b.id,
      studentId: b.studentId,
      teacherId: b.teacherId,
      subject: b.subject ?? null,
      status: b.status,
      boundByUserId: b.boundByUserId ?? null,
      boundAt: b.boundAt instanceof Date ? b.boundAt.toISOString() : b.boundAt,
      unboundAt: b.unboundAt
        ? b.unboundAt instanceof Date
          ? b.unboundAt.toISOString()
          : b.unboundAt
        : null,
      ...(extra ?? {}),
    };
  }

  /**
   * recurring snapshot for audit_log（无 PII；byDay 数组小不裁剪）
   */
  private recurringSnapshot(
    r: RecurringSchedule,
    extra?: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      id: r.id,
      bindingId: r.bindingId,
      studentId: r.studentId,
      teacherId: r.teacherId,
      courseProductId: r.courseProductId ?? null,
      byDay: r.byDay,
      startMinutes: r.startMinutes,
      durationMin: r.durationMin,
      startDate: r.startDate instanceof Date ? r.startDate.toISOString() : r.startDate,
      endDate: r.endDate
        ? r.endDate instanceof Date
          ? r.endDate.toISOString()
          : r.endDate
        : null,
      status: r.status,
      createdByUserId: r.createdByUserId,
      createdByRole: r.createdByRole,
      ...(extra ?? {}),
    };
  }
}
