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
  ScheduleService,
  Schedule,
  ScheduleStudent,
  CreateScheduleInput,
  AttendanceStatus,
  SchedulerRole,
  CurrentUser,
} from './schedule.service';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';
import { TeacherRepository } from '../db/teacher.repository';
import { StudentRepository } from '../db/student.repository';
import { ActorRole, AuditLogRepository } from '../db/audit-log.repository';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';

/**
 * ScheduleController — V8 排课核心 HTTP 暴露 BE-V8-1
 *
 * 路由前缀：/api/schedules
 *
 * USER-AUTH(2026-05-02): PD §3 + 条目 31 #2 + 条目 32 L2
 *
 * Sprint B.4-1（2026-05-12）RBAC 收紧（leader 拍板 Q1/Q2/Q3）：
 *   1. Q1: callerRole 严格限定 {teacher, sales}，其他 role 直接 403
 *      ONLY_TEACHER_OR_SALES_CAN_CREATE_SCHEDULE，admin/boss/academic 排课
 *      功能记入 backlog 独立 Sprint 评估
 *   2. Q3: server-derive 模式，前端 body 不再自报权限载荷
 *      - callerRole: JWT.role
 *      - currentUser: { id: JWT.sub, role: JWT.role, tenantId: JWT.tenantId }
 *      - schedulableTeachers: teacher → 自己 / sales → 全 active 列表（teacherRepo）
 *      - studentResponsibleSalesPairs: sales → batch findBrief input.studentIds（studentRepo）
 *   3. 即使前端 body 仍传上述字段，controller 全部忽略并以 server 派生为准
 *      （body 上的字段标 deprecated，spec 验证「攻击者自报 callerRole」无效）
 *
 * Sprint B.4-1 round 2（business P1-A + security A04 修复）：
 *   1. cancel / complete / attendance 三个写 endpoint 加 @Req() + 早期 403
 *      （原本任何登录用户都能调 → 限到 {teacher, sales}，trust boundary 收紧）
 *   2. 内存版 createSchedule 强制要求 tenantSchema + server-derive schedulableTeachers
 *      / studentResponsibleSalesMap（与 /db 版本完全一致，不再支持 body 注入 fixture）
 *      —— A04 Insecure Design：tenantSchema 可选导致 RBAC skip 路径
 *   ⚠ ownership 校验（schedule 是否归属当前 sales/teacher）记入 Sprint X backlog
 *      本轮仅做角色级 trust boundary 修复，不引入 sched-level scope
 *
 * Sprint B.6 mini (2026-05-11) 深度防御：
 *   - class-level @UseGuards(TenantScopeGuard) — 兜底所有 /db endpoint body.tenantSchema 跨租户校验
 *
 * Sprint E backlog #3 (2026-05-13) audit_log 整体补齐：
 *   - 5 写 endpoint × 2 路径（成功 + 拒绝）= 10 处 audit_log 调用
 *   - action 命名：schedule.create / schedule.cancel / schedule.complete /
 *                  schedule.mark-attendance + 同名 .denied 后缀
 *   - targetType: 'schedule'
 *   - 拒绝路径含 BadRequestException(TENANT_SCHEMA_REQUIRED / JWT sub/role required)
 *     + ForbiddenException(ONLY_TEACHER_OR_SALES / TEACHER_USER_NOT_BOUND)
 *   - 5 个原同步方法 (cancel/complete/attendance) → 全 async（audit 必须 await
 *     避免主业务流先返但 audit 还未写）
 *   - schedule 模块无 PII（仅 ID/时间），不需要 maskPhone
 */
@UseGuards(TenantScopeGuard)
@Controller('schedules')
export class ScheduleController {
  constructor(
    private readonly service: ScheduleService,
    private readonly teacherRepo: TeacherRepository,
    private readonly studentRepo: StudentRepository,
    // Sprint E backlog #3: audit_log 注入
    //   - @Optional 兼容现有 spec 直接 new ScheduleController(svc, teacherRepo, studentRepo)
    //   - fail-open: audit 失败不阻塞主业务（AuditLogRepository.log 内部 catch；这里 tryAudit 再加一层）
    @Optional() private readonly auditLog?: AuditLogRepository,
  ) {}

  /**
   * POST /api/schedules — 创建排课（内存版，应用层冲突检测，无 DB 持久化）
   *
   * Sprint B.4-1 round 2（A04 + business P1-B 修复 — 2026-05-12 晚）：
   *   - tenantSchema 改为必填（缺则抛 BadRequestException('TENANT_SCHEMA_REQUIRED')）
   *   - schedulableTeachers / studentResponsibleSalesPairs 完全 server-derive（同 /db 路径）
   *     —— A04 修复：旧"fixture 模式 body 注入"路径完全删除（client 控制安全级别）
   *   - body 仍接受 existingSchedules / existingStudentsAttachment 供应用层冲突检测
   *     （这部分是"调用方提供世界状态"语义，非安全敏感，service 仅做时间区间相交）
   *
   * 内存版 vs DB 版差异：
   *   - 内存版（POST /api/schedules）：冲突检测用 body.existingSchedules（应用层）
   *   - DB 版（POST /api/schedules/db）：冲突检测查 PG schedule_repository（事务内）
   *   - RBAC 完全一致（同样 server-derive，同样 require tenantSchema）
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createSchedule(
    @Body()
    body: {
      input: CreateScheduleInput;
      existingSchedules: Schedule[];
      existingStudentsAttachment: ScheduleStudent[];
      tenantSchema: string;
      // @deprecated Sprint B.4-1 round 2 起 server 派生
      studentResponsibleSalesPairs?: Array<[string, string]>;
      // @deprecated Sprint B.4-1 round 2 起 server 派生
      schedulableTeachers?: Array<{ id: string; userId?: string }>;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<{ schedule: Schedule; students: ScheduleStudent[] }> {
    if (!body.tenantSchema) {
      await this.tryAuditDenied(req, 'unknown', 'schedule.create.denied', body.input?.id ?? null, {
        reason: 'TENANT_SCHEMA_REQUIRED',
        endpoint: 'createSchedule',
      });
      throw new BadRequestException('TENANT_SCHEMA_REQUIRED');
    }
    let callerRole: SchedulerRole;
    let currentUser: CurrentUser;
    try {
      ({ callerRole, currentUser } = this.assertCallerRoleAndDeriveContext(req));
    } catch (err) {
      await this.tryAuditDenied(
        req,
        body.tenantSchema,
        'schedule.create.denied',
        body.input?.id ?? null,
        { reason: this.reasonFromError(err), endpoint: 'createSchedule' },
      );
      throw err;
    }
    const inputDeserialized = this.deserializeInput(body.input, callerRole, currentUser);

    // Sprint B.4-1 round 2: server-derive（A04 修复，不再接受 body 注入）
    let schedulableTeachers: Array<{ id: string; userId?: string }>;
    let studentResponsibleSalesMap: Map<string, string>;
    try {
      schedulableTeachers = await this.deriveSchedulableTeachers(
        body.tenantSchema,
        callerRole,
        currentUser,
      );
      studentResponsibleSalesMap = await this.deriveStudentResponsibleSalesMap(
        body.tenantSchema,
        callerRole,
        inputDeserialized.studentIds,
      );
    } catch (err) {
      await this.tryAuditDenied(
        req,
        body.tenantSchema,
        'schedule.create.denied',
        body.input?.id ?? null,
        { reason: this.reasonFromError(err), endpoint: 'createSchedule' },
      );
      throw err;
    }

    let result: { schedule: Schedule; students: ScheduleStudent[] };
    try {
      result = this.service.createSchedule(
        inputDeserialized,
        body.existingSchedules.map((s) => this.deserializeSchedule(s)),
        body.existingStudentsAttachment,
        studentResponsibleSalesMap,
        schedulableTeachers,
      );
    } catch (err) {
      await this.tryAuditDenied(
        req,
        body.tenantSchema,
        'schedule.create.denied',
        body.input?.id ?? null,
        { reason: this.reasonFromError(err), endpoint: 'createSchedule' },
      );
      throw err;
    }

    await this.tryAudit(req, body.tenantSchema, {
      action: 'schedule.create',
      targetType: 'schedule',
      targetId: result.schedule.id,
      before: null,
      after: this.scheduleSnapshot(result.schedule, {
        endpoint: 'createSchedule',
        ...this.studentIdsForAudit(inputDeserialized.studentIds),
      }),
    });
    return result;
  }

  /**
   * POST /api/schedules/:id/cancel — 取消排课
   *
   * Sprint B.4-1 round 2 (business P1-A): 早期 403 — 仅 {teacher, sales} 可调
   * （admin/finance/parent/academic 任何登录用户原本可调，trust boundary 修复）
   *
   * NOTE: 暂不做 schedule ownership 校验（sales 是否归属该 schedule 的学员销售 /
   * teacher 是否归属该 schedule 的老师），仅做角色限制。完整 ownership 校验需
   * service 内反查 schedule.teacherId / studentIds → owner_sales_id 等，本轮 scope
   * 仅缩小到 {teacher, sales}，ownership 校验记 Sprint X backlog
   *
   * Sprint E backlog #3: 成功路径 audit_log 'schedule.cancel'；拒绝路径 'schedule.cancel.denied'
   *   - tenantSchema 缺时 audit 用 'unknown' 占位（拒绝路径 audit 写不进 tenant schema，
   *     AuditLogRepository.log 内部 catch fail-open，不抛错）
   *   - cancel/complete/attendance 路径 service 是同步，但本方法因 audit 需 await 而改 async
   */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelSchedule(
    @Param('id') _id: string,
    @Body() body: { schedule: Schedule; reason?: string; tenantSchema?: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<Schedule> {
    try {
      this.assertCallerRoleAndDeriveContext(req); // 早期 403 {teacher,sales} 限制
    } catch (err) {
      await this.tryAuditDenied(
        req,
        body.tenantSchema ?? 'unknown',
        'schedule.cancel.denied',
        body.schedule?.id ?? null,
        { reason: this.reasonFromError(err), endpoint: 'cancelSchedule' },
      );
      throw err;
    }
    const before = this.scheduleSnapshot(this.deserializeSchedule(body.schedule), {
      endpoint: 'cancelSchedule',
    });
    const result = this.service.cancelSchedule(
      this.deserializeSchedule(body.schedule),
      body.reason,
    );
    await this.tryAudit(req, body.tenantSchema ?? 'unknown', {
      action: 'schedule.cancel',
      targetType: 'schedule',
      targetId: result.id,
      before,
      after: this.scheduleSnapshot(result, {
        endpoint: 'cancelSchedule',
        reason: body.reason ?? null,
      }),
    });
    return result;
  }

  /**
   * POST /api/schedules/:id/complete — 标记排课完成（触发课消生成）
   *
   * Sprint B.4-1 round 2 (business P1-A): 同上 cancelSchedule，早期 403
   *
   * Sprint E backlog #3: 成功路径 audit_log 'schedule.complete'；拒绝 'schedule.complete.denied'
   */
  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  async completeSchedule(
    @Param('id') _id: string,
    @Body() body: { schedule: Schedule; tenantSchema?: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<Schedule> {
    try {
      this.assertCallerRoleAndDeriveContext(req); // 早期 403 {teacher,sales} 限制
    } catch (err) {
      await this.tryAuditDenied(
        req,
        body.tenantSchema ?? 'unknown',
        'schedule.complete.denied',
        body.schedule?.id ?? null,
        { reason: this.reasonFromError(err), endpoint: 'completeSchedule' },
      );
      throw err;
    }
    const before = this.scheduleSnapshot(this.deserializeSchedule(body.schedule), {
      endpoint: 'completeSchedule',
    });
    const result = this.service.completeSchedule(this.deserializeSchedule(body.schedule));
    await this.tryAudit(req, body.tenantSchema ?? 'unknown', {
      action: 'schedule.complete',
      targetType: 'schedule',
      targetId: result.id,
      before,
      after: this.scheduleSnapshot(result, { endpoint: 'completeSchedule' }),
    });
    return result;
  }

  /**
   * POST /api/schedules/db — 真存盘版（自动查 PG 冲突 + 事务 INSERT）
   *
   * Sprint B.4-1: callerRole / currentUser / schedulableTeachers / studentResponsibleSalesPairs
   * 全部 server 派生，body 字段已 deprecated。
   *
   * Sprint E backlog #3: 成功路径 'schedule.create'；拒绝 'schedule.create.denied'
   */
  @Post('db')
  @HttpCode(HttpStatus.CREATED)
  async createScheduleInDb(
    @Body()
    body: {
      input: CreateScheduleInput;
      tenantSchema: string;
      // @deprecated Sprint B.4-1 起 server 派生
      studentResponsibleSalesPairs?: Array<[string, string]>;
      // @deprecated Sprint B.4-1 起 server 派生
      schedulableTeachers?: Array<{ id: string; userId?: string }>;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<{ schedule: Schedule; students: ScheduleStudent[] }> {
    if (!body.tenantSchema) {
      await this.tryAuditDenied(req, 'unknown', 'schedule.create.denied', body.input?.id ?? null, {
        reason: 'TENANT_SCHEMA_REQUIRED',
        endpoint: 'createScheduleInDb',
      });
      throw new BadRequestException('tenantSchema required');
    }
    let callerRole: SchedulerRole;
    let currentUser: CurrentUser;
    try {
      ({ callerRole, currentUser } = this.assertCallerRoleAndDeriveContext(req));
    } catch (err) {
      await this.tryAuditDenied(
        req,
        body.tenantSchema,
        'schedule.create.denied',
        body.input?.id ?? null,
        { reason: this.reasonFromError(err), endpoint: 'createScheduleInDb' },
      );
      throw err;
    }
    const inputDeserialized = this.deserializeInput(body.input, callerRole, currentUser);
    let schedulableTeachers: Array<{ id: string; userId?: string }>;
    let studentResponsibleSalesMap: Map<string, string>;
    try {
      schedulableTeachers = await this.deriveSchedulableTeachers(
        body.tenantSchema,
        callerRole,
        currentUser,
      );
      studentResponsibleSalesMap = await this.deriveStudentResponsibleSalesMap(
        body.tenantSchema,
        callerRole,
        inputDeserialized.studentIds,
      );
    } catch (err) {
      await this.tryAuditDenied(
        req,
        body.tenantSchema,
        'schedule.create.denied',
        body.input?.id ?? null,
        { reason: this.reasonFromError(err), endpoint: 'createScheduleInDb' },
      );
      throw err;
    }

    let result: { schedule: Schedule; students: ScheduleStudent[] };
    try {
      result = await this.service.createScheduleInDb(
        inputDeserialized,
        body.tenantSchema,
        studentResponsibleSalesMap,
        schedulableTeachers,
      );
    } catch (err) {
      await this.tryAuditDenied(
        req,
        body.tenantSchema,
        'schedule.create.denied',
        body.input?.id ?? null,
        { reason: this.reasonFromError(err), endpoint: 'createScheduleInDb' },
      );
      throw err;
    }
    await this.tryAudit(req, body.tenantSchema, {
      action: 'schedule.create',
      targetType: 'schedule',
      targetId: result.schedule.id,
      before: null,
      after: this.scheduleSnapshot(result.schedule, {
        endpoint: 'createScheduleInDb',
        ...this.studentIdsForAudit(inputDeserialized.studentIds),
      }),
    });
    return result;
  }

  /**
   * POST /api/schedules/db/list-by-teacher
   *
   * Sprint B.4-1 round 3 (Sprint E backlog #7 — A01 hardening 2026-05-13):
   *   - 加 @Req() + assertCallerRoleAndDeriveContext 限 {teacher, sales}
   *   - 原 pre-existing 风险：任何已登录 JWT role 可调取任意 teacherId 课表
   *     （受 TenantScopeGuard 跨租户隔离，但同租户内任 admin/finance/parent/academic
   *     都能查别人销售归属的老师课表，违反「教务全只读老师线」+ sales 不跨域）
   *   - 本轮仅做角色级 trust boundary 收紧（同 cancel/complete/attendance 模式），
   *     teacher self-only 反查 / sales ownership 校验留 Sprint X backlog（service 层）
   *
   * Sprint E backlog #3: read-only 不补 audit_log（本拍板范围仅写操作）
   */
  @Post('db/list-by-teacher')
  @HttpCode(HttpStatus.OK)
  async listByTeacherInDb(
    @Body()
    body: { tenantSchema: string; teacherId: string; fromIso: string; toIso: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<Schedule[]> {
    this.assertCallerRoleAndDeriveContext(req); // 早期 403 {teacher, sales} 限制
    return this.service.listByTeacherInDb(
      body.tenantSchema,
      body.teacherId,
      new Date(body.fromIso),
      new Date(body.toIso),
    );
  }

  /**
   * POST /api/schedules/:scheduleId/students/:studentId/attendance
   *
   * Sprint B.4-1 round 2 (business P1-A): 早期 403 — 考勤标记仅 {teacher, sales} 可调
   * （admin/finance/parent/academic 任何登录用户原本可调，trust boundary 修复）
   *
   * Sprint E backlog #3: 成功路径 'schedule.mark-attendance'；拒绝 'schedule.mark-attendance.denied'
   *   - 该 endpoint 操作 schedule_students 子记录，targetType 仍用 'schedule'（拍板锚定到父 schedule.id）
   *   - after 含 studentId / newStatus / scheduleId（便于 audit_log 列出某 schedule 全考勤变更）
   */
  @Post(':scheduleId/students/:studentId/attendance')
  @HttpCode(HttpStatus.OK)
  async markAttendance(
    @Param('scheduleId') scheduleId: string,
    @Param('studentId') studentId: string,
    @Body() body: {
      scheduleStudent: ScheduleStudent;
      newStatus: AttendanceStatus;
      tenantSchema?: string;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<ScheduleStudent> {
    try {
      this.assertCallerRoleAndDeriveContext(req); // 早期 403 {teacher,sales} 限制
    } catch (err) {
      await this.tryAuditDenied(
        req,
        body.tenantSchema ?? 'unknown',
        'schedule.mark-attendance.denied',
        scheduleId,
        {
          reason: this.reasonFromError(err),
          endpoint: 'markAttendance',
          studentId,
          attemptedStatus: body.newStatus,
        },
      );
      throw err;
    }
    const before = {
      scheduleId,
      studentId,
      attendanceStatus: body.scheduleStudent.attendanceStatus,
    };
    const result = this.service.markAttendance(body.scheduleStudent, body.newStatus);
    await this.tryAudit(req, body.tenantSchema ?? 'unknown', {
      action: 'schedule.mark-attendance',
      targetType: 'schedule',
      targetId: scheduleId,
      before,
      after: {
        scheduleId,
        studentId,
        attendanceStatus: result.attendanceStatus,
        previousStatus: body.scheduleStudent.attendanceStatus,
      },
    });
    return result;
  }

  // -- helpers: server-derived RBAC context（Sprint B.4-1 拍板）--

  /**
   * 从 JWT 派生 callerRole + currentUser，并在 controller 层挡掉
   * non-{teacher,sales} 角色（不让到 service 才挡，避免业务路径多走一次冲突检测）。
   *
   * Sprint B.4-1 round 2: 移除 tenantSchema 派生（所有路径已强制 body.tenantSchema 必填）。
   */
  private assertCallerRoleAndDeriveContext(req: AuthenticatedRequest): {
    callerRole: SchedulerRole;
    currentUser: CurrentUser;
  } {
    const jwt = req.user;
    if (!jwt?.sub || !jwt.role) {
      throw new BadRequestException('JWT sub/role required');
    }
    if (jwt.role !== 'teacher' && jwt.role !== 'sales') {
      // Q1 拍板：admin/boss/academic 等其他 role 一律 403
      throw new ForbiddenException(
        `ONLY_TEACHER_OR_SALES_CAN_CREATE_SCHEDULE: role=${jwt.role}`,
      );
    }
    return {
      callerRole: jwt.role as SchedulerRole,
      currentUser: {
        id: jwt.sub,
        role: jwt.role,
        tenantId: jwt.tenantId ?? '',
      },
    };
  }

  /**
   * 派生 schedulableTeachers（Q1 拍板）：
   *   - teacher → 仅返回 [ownTeacher]，反查 teachers.user_id = JWT.sub
   *     若反查不到 → 抛 ForbiddenException(TEACHER_USER_NOT_BOUND)，避免到 service
   *     才感知到（前端会更早收到 403，UX 更好）
   *   - sales → 该 tenant 全 active 老师列表（cross-campus 豁免）
   *
   * Sprint B.4-1 round 2: 内存版 和 DB 版都强制 tenantSchema 必填后调用此 helper。
   */
  private async deriveSchedulableTeachers(
    tenantSchema: string,
    callerRole: SchedulerRole,
    currentUser: CurrentUser,
  ): Promise<Array<{ id: string; userId?: string }>> {
    if (callerRole === 'teacher') {
      const own = await this.teacherRepo.findByUserId(tenantSchema, currentUser.id);
      if (!own) {
        throw new ForbiddenException(
          'TEACHER_USER_NOT_BOUND: 当前用户未在 teachers 表关联（请联系校长建档）',
        );
      }
      return [{ id: own.id, userId: own.userId }];
    }
    // sales: 全 active 列表
    const all = await this.teacherRepo.listActiveInTenant(tenantSchema);
    return all.map((t) => ({ id: t.id, userId: t.userId }));
  }

  /**
   * 派生 studentResponsibleSalesMap（Q3 拍板，sales 路径用）：
   *   - sales → batch query students.owner_sales_id by input.studentIds
   *     map studentId → ownerSalesId（null 时填空串，service 比较时不匹配 → 403）
   *   - teacher → 空 map（service 不读，不用查）
   *
   * TODO(perf): 若学生 N > 50 改 studentRepo.findBriefsByIds(ids[]) 批量查询（当前 N 通常 1-3）
   */
  private async deriveStudentResponsibleSalesMap(
    tenantSchema: string,
    callerRole: SchedulerRole,
    studentIds: ReadonlyArray<string>,
  ): Promise<Map<string, string>> {
    if (callerRole !== 'sales') return new Map();
    const map = new Map<string, string>();
    for (const sid of studentIds) {
      const brief = await this.studentRepo.findBrief(tenantSchema, sid);
      if (brief) {
        map.set(sid, brief.ownerSalesId ?? '');
      }
      // 反查不到学生 → map 中不存在该 key → service 用 map.get(sid) 返回 undefined
      // → service 的 wrongStudents.push(sid) → 抛 SALES_ONLY_OWN_STUDENTS（合理）
    }
    return map;
  }

  // -- helpers: JSON Date 反序列化 + 强制覆盖 callerRole/currentUser --

  private deserializeInput(
    input: CreateScheduleInput,
    callerRole: SchedulerRole,
    currentUser: CurrentUser,
  ): CreateScheduleInput {
    return {
      ...input,
      startAt: new Date(input.startAt as unknown as string),
      // Sprint B.4-1: 强制覆盖（前端自报无效），保留 service 现有签名
      callerRole,
      currentUser,
    };
  }

  private deserializeSchedule(s: Schedule): Schedule {
    return {
      ...s,
      startAt: new Date(s.startAt as unknown as string),
      endAt: new Date(s.endAt as unknown as string),
    };
  }

  // -- helpers: audit_log (Sprint E backlog #3) --

  /**
   * 写成功路径 audit_log，从 req 取 ip/ua/req-id，fail-open
   */
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
      // fail-open: AuditLogRepository.log 已内部 catch，此层为兜底
    }
  }

  /**
   * 写拒绝路径 audit_log（与 tryAudit 区分语义；reason 入 after 便于检索）
   *
   * 拒绝路径含三类：
   *   - tenantSchema 缺：reason='TENANT_SCHEMA_REQUIRED'，tenantSchema 占位 'unknown'
   *   - JWT 缺/role 非 {teacher,sales}：reason='ONLY_TEACHER_OR_SALES_CAN_CREATE_SCHEDULE: role=xxx'
   *     或 'JWT sub/role required'
   *   - service 业务校验失败（SALES_ONLY_OWN_STUDENTS / SCHEDULE_CONFLICT 等）：
   *     reason 取 err.message
   */
  private async tryAuditDenied(
    req: AuthenticatedRequest,
    tenantSchema: string,
    action: string,
    targetId: string | null,
    after: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.auditLog?.log(tenantSchema, {
        actorUserId: req.user?.sub ?? null,
        actorRole: this.actorRole(req),
        action,
        targetType: 'schedule',
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

  private actorRole(req: AuthenticatedRequest): ActorRole {
    return ((req.user?.role as ActorRole) ?? 'system') as ActorRole;
  }

  private reasonFromError(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
  }

  /**
   * schedule snapshot for audit_log
   *
   * 无 PII（schedule 表只有 ID + 时间 + 状态字段，studentIds 是 ID 不是名字）
   *
   * 注：Schedule 接口本身不含 studentIds（join 表 schedule_students），所以
   * studentIds 由调用方通过 extra 注入（来自 createSchedule 双值返回的 input 或 students）
   */
  private scheduleSnapshot(
    s: Schedule,
    extra?: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      id: s.id,
      teacherId: s.teacherId,
      startAt: s.startAt instanceof Date ? s.startAt.toISOString() : s.startAt,
      endAt: s.endAt instanceof Date ? s.endAt.toISOString() : s.endAt,
      durationMin: s.durationMin,
      status: s.status,
      source: s.source,
      classType: s.classType ?? null,
      maxStudents: s.maxStudents ?? null,
      ...(extra ?? {}),
    };
  }

  /**
   * studentIds 裁剪（控制 audit_log 大小：> 5 时仅记前 5 + length）
   */
  private studentIdsForAudit(ids: ReadonlyArray<string>): Record<string, unknown> {
    return {
      studentIds: ids.length > 5 ? ids.slice(0, 5) : ids,
      studentIdsLength: ids.length,
    };
  }
}
