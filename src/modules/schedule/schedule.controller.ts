import {
  Body,
  Controller,
  Get,
  Optional,
  Param,
  Post,
  Query,
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
import { ActorRole, AuditLogRepository, normalizeActorRole } from '../db/audit-log.repository';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';

/**
 * ScheduleController — V8 排课核心 HTTP 暴露 BE-V8-1
 *
 * 路由前缀：/api/schedules
 *
 * USER-AUTH(2026-05-02): PD §3 + 条目 31 #2 + 条目 32 L2
 *
 * Wave 11（2026-05-15）拍板反向修复 — 教务唯一创建：
 *   - 5/9 拍板 fields-by-role.md 5 处明文：教务是 ✅ 创建主责
 *     L82 教务 home「+ 新建排课（教务主责）」
 *     L102 教务 home YAML「主按钮：+ 新建排课」
 *     L133 老师 home「不该有：+ 新建排课（5/9 拍板：教务主责）」
 *     L201 schedule 矩阵「基础字段 务 ✅ 创建 / 师 ✅ 自己课（执行）/ 销 👁 自己客户孩子」
 *     feedback_教培业务架构 L56 老板 home「不该有：+ 排课」
 *   - 5/12 Sprint B.4-1 round 2 误读拍板，反向写成 {teacher, sales} 创建 +
 *     academic/admin/boss 403 → 5/12-5/15 期间生产 RBAC 与拍板完全相反
 *   - Wave 11 修正：callerRole 域 = ['academic']（教务唯一），admin/boss/sales/
 *     teacher/finance 全早期 403
 *
 * Wave 11 server-derive 模式保留（B.4-1 Q3 设计正确）：
 *   - callerRole: JWT.role
 *   - currentUser: { id: JWT.sub, role: JWT.role, tenantId: JWT.tenantId }
 *   - schedulableTeachers: academic → 本校（campus_id 匹配）active 老师列表
 *     （listActiveInTenant 后 controller 层 filter campusId === JWT.campusId）
 *   - studentResponsibleSalesPairs / Map: deprecated，传空 Map（教务无 ownership 校验）
 *   - body 自报字段全部忽略
 *
 * Sprint B.4-1 round 2（business P1-A + security A04 修复）保留：
 *   1. cancel / complete / attendance 三个写 endpoint 加 @Req() + 早期 403
 *      Wave 11 同样限到 ['academic']（与 createSchedule 对齐）
 *   2. tenantSchema 必填（A04 client 控制安全级别防御）
 *   ⚠ schedule ownership 校验（academic 是否本校 schedule）记入 Sprint X backlog
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
 *     + ForbiddenException(ONLY_ACADEMIC / TEACHER_NOT_IN_ACADEMIC_CAMPUS)
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

    // Wave 11: server-derive（schedulableTeachers 按 academic.campus_id 过滤）
    let schedulableTeachers: Array<{ id: string; userId?: string }>;
    let studentResponsibleSalesMap: Map<string, string>;
    try {
      schedulableTeachers = await this.deriveSchedulableTeachers(
        body.tenantSchema,
        callerRole,
        currentUser,
        req.user?.campusId ?? null,
      );
      // T-DEADCODE-CLEANUP P1-3 (2026-05-17): Wave 11 后 deriveStudentResponsibleSalesMap
      //   永远 return new Map()，inline 替换避免无意义 await（dual-verify G2#2 I-4 + G2#3 L4）
      studentResponsibleSalesMap = new Map<string, string>();
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
   * Wave 11 audit (5/15): 早期 403 — 仅 academic 可调
   * （admin/finance/parent/teacher/sales/boss 任何角色原本可调，trust boundary 修复）
   * 拍板 fields-by-role.md L201 schedule 矩阵教务唯一创建，cancel 复用同一 RBAC 语义
   *
   * NOTE: 暂不做 schedule ownership 校验（academic 是否归属该 schedule 所在校区），
   * 仅做角色限制。完整本校 ownership 校验需 service 内反查 schedule.teacherId →
   * teacher.campus_id 比 JWT.campusId，记 Sprint X backlog
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
    // Sprint E #3 round 5 (production observation 1): tenantSchema 改必填
    // 与 createSchedule / createScheduleInDb 对齐，避免成功路径 audit 写 'unknown' schema 静默丢失
    @Body() body: { schedule: Schedule; reason?: string; tenantSchema: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<Schedule> {
    if (!body.tenantSchema) {
      await this.tryAuditDenied(
        req,
        'unknown',
        'schedule.cancel.denied',
        body.schedule?.id ?? null,
        { reason: 'TENANT_SCHEMA_REQUIRED', endpoint: 'cancelSchedule' },
      );
      throw new BadRequestException('TENANT_SCHEMA_REQUIRED');
    }
    try {
      this.assertCallerRoleAndDeriveContext(req); // Wave 11 早期 403：仅 academic
    } catch (err) {
      await this.tryAuditDenied(
        req,
        body.tenantSchema,
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
    await this.tryAudit(req, body.tenantSchema, {
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
    // Sprint E #3 round 5: tenantSchema 改必填，与 create 系列对齐
    @Body() body: { schedule: Schedule; tenantSchema: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<Schedule> {
    if (!body.tenantSchema) {
      await this.tryAuditDenied(
        req,
        'unknown',
        'schedule.complete.denied',
        body.schedule?.id ?? null,
        { reason: 'TENANT_SCHEMA_REQUIRED', endpoint: 'completeSchedule' },
      );
      throw new BadRequestException('TENANT_SCHEMA_REQUIRED');
    }
    try {
      this.assertCallerRoleAndDeriveContext(req); // Wave 11 早期 403：仅 academic
    } catch (err) {
      await this.tryAuditDenied(
        req,
        body.tenantSchema,
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
    await this.tryAudit(req, body.tenantSchema, {
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
   * Wave 11 拍板修复：教务唯一创建（fields-by-role.md L201）
   *   - callerRole / currentUser 从 JWT 派生（仅 academic 合法）
   *   - schedulableTeachers 派生为「教务所在校区在职老师列表」
   *   - studentResponsibleSalesMap deprecated（教务无 ownership 校验）
   *   - body 自报字段全部忽略
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
      // @deprecated Wave 11 起 server 派生（教务无 ownership 校验）
      studentResponsibleSalesPairs?: Array<[string, string]>;
      // @deprecated Wave 11 起 server 派生（按 academic.campus_id 过滤）
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
        req.user?.campusId ?? null,
      );
      // T-DEADCODE-CLEANUP P1-3 (2026-05-17): Wave 11 后 deriveStudentResponsibleSalesMap
      //   永远 return new Map()，inline 替换避免无意义 await（dual-verify G2#2 I-4 + G2#3 L4）
      studentResponsibleSalesMap = new Map<string, string>();
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
   *   - 加 @Req() + assertReadRoleForListByTeacher 限 read-side 角色
   *   - 原 pre-existing 风险：任何已登录 JWT role 可调取任意 teacherId 课表
   *
   * Wave 11（2026-05-15）拍板 read 路径调整：
   *   - 拍板 L201: schedule 基础字段「师 ✅ 自己课 / 销 👁 自己客户孩子 / 务 ✅ 创建 + 看 /
   *     老校 ✅」— read 路径合法角色 = {teacher, sales, academic, boss, admin}
   *   - 写路径（create/cancel/complete/attendance）已收紧为仅 academic（Wave 11 fix）
   *   - 本 endpoint 是 read，不在 Wave 11 写路径反向修复范围
   *   - 仍保留 trust boundary：parent / finance / hr / marketing / sales_manager
   *     不应调用此 read（不在拍板矩阵 read scope 内）— 5/15 A-2 删 sales_director
   *   - teacher self-only 反查 / sales ownership 校验留 Sprint X backlog（service 层）
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
    this.assertReadRoleForListByTeacher(req); // Wave 11: read-path RBAC（与写路径区分）
    return this.service.listByTeacherInDb(
      body.tenantSchema,
      body.teacherId,
      new Date(body.fromIso),
      new Date(body.toIso),
    );
  }

  /**
   * 2026-05-22 业务事件 Step 2: 老师上完课 → 真持久化 (消课业务事件触发点)
   *
   *   POST /api/schedules/db/:id/complete-with-consumption
   *   - UPDATE schedule.status='已完成'
   *   - INSERT N 条 course_consumptions pending_feedback (每学员一条)
   *   - UPDATE schedule_students.attendance_status='出勤' (默认, 老师可在 roster 改)
   *
   *   RBAC: teacher (上自己课) / admin / boss / academic (代为完成)
   *   消课链路: 这里产生 pending → 老师填反馈 → 自动 confirmed
   */
  @Post('db/:id/complete-with-consumption')
  @HttpCode(HttpStatus.OK)
  async completeWithConsumptionInDb(
    @Param('id') id: string,
    @Body() body: { tenantSchema: string; consumptionIdPrefix: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<{ schedule: Schedule; consumptionsCreated: number; alreadyComplete: boolean }> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    if (!id || id.length !== 32) throw new BadRequestException('schedule id must be 32-char ULID');
    if (!body.consumptionIdPrefix) {
      throw new BadRequestException('consumptionIdPrefix required (前端生成 ULID)');
    }
    // RBAC: teacher / admin / boss / academic 可触发
    const role = req.user?.role;
    if (!['teacher', 'admin', 'boss', 'academic', 'academic_admin'].includes(role || '')) {
      throw new ForbiddenException('当前角色不允许标记上完课');
    }
    return this.service.completeScheduleInDb(body.tenantSchema, id, body.consumptionIdPrefix);
  }

  /**
   * 2026-05-22 老师 lesson roster 数据源:
   *   GET /api/schedules/db/:id/with-roster?tenantSchema=
   *   返完整 lesson meta + 学员 list (含每学员 feedback 是否已填)
   *   替代前端 lesson/roster page 整页 mock
   */
  @Get('db/:id/with-roster')
  @HttpCode(HttpStatus.OK)
  async findByIdWithRosterInDb(
    @Param('id') id: string,
    @Query('tenantSchema') tenantSchema: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<any> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    if (!id || id.length !== 32) throw new BadRequestException('schedule id must be 32-char ULID');
    const role = req.user?.role;
    if (!['teacher', 'admin', 'boss', 'academic', 'academic_admin', 'sales', 'sales_manager'].includes(role || '')) {
      throw new ForbiddenException('当前角色无权查看课次花名册');
    }
    const result = await this.service.findByIdWithRosterInDb(tenantSchema, id);
    if (!result) {
      throw new BadRequestException(`schedule ${id} not found`);
    }
    return result;
  }

  /**
   * POST /api/schedules/:scheduleId/students/:studentId/attendance
   *
   * Wave 11 audit (5/15): 早期 403 — 考勤标记仅 academic 可调
   * （admin/finance/parent/teacher/sales/boss 任何角色原本可调，trust boundary 修复）
   * 拍板 fields-by-role.md L201 schedule 矩阵教务唯一创建/修改，attendance 复用 RBAC
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
    // Sprint E #3 round 5: tenantSchema 改必填，与 create 系列对齐
    @Body() body: {
      scheduleStudent: ScheduleStudent;
      newStatus: AttendanceStatus;
      tenantSchema: string;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<ScheduleStudent> {
    if (!body.tenantSchema) {
      await this.tryAuditDenied(
        req,
        'unknown',
        'schedule.mark-attendance.denied',
        scheduleId,
        {
          reason: 'TENANT_SCHEMA_REQUIRED',
          endpoint: 'markAttendance',
          studentId,
          attemptedStatus: body.newStatus,
        },
      );
      throw new BadRequestException('TENANT_SCHEMA_REQUIRED');
    }
    try {
      this.assertCallerRoleAndDeriveContext(req); // Wave 11 早期 403：仅 academic
    } catch (err) {
      await this.tryAuditDenied(
        req,
        body.tenantSchema,
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
    await this.tryAudit(req, body.tenantSchema, {
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

  // -- helpers: server-derived RBAC context（Wave 11 拍板修复）--

  /**
   * 从 JWT 派生 callerRole + currentUser，并在 controller 层挡掉
   * non-academic 角色（不让到 service 才挡，避免业务路径多走一次冲突检测）。
   *
   * Wave 11 拍板修复：教务唯一创建（fields-by-role.md L201 「务 ✅ 创建」）
   *   - admin / boss / sales / teacher / finance / academic_admin 全早期 403
   *   - 教务也是单校 role（campusId 必填 32-char ULID）
   */
  private assertCallerRoleAndDeriveContext(req: AuthenticatedRequest): {
    callerRole: SchedulerRole;
    currentUser: CurrentUser;
  } {
    const jwt = req.user;
    if (!jwt?.sub || !jwt.role) {
      throw new BadRequestException('JWT sub/role required');
    }
    if (jwt.role !== 'academic') {
      // Wave 11 拍板：仅 academic 可创建/调度/标考勤，其他 role 一律 403
      throw new ForbiddenException(
        `ONLY_ACADEMIC_CAN_CREATE_SCHEDULE: role=${jwt.role}`,
      );
    }
    return {
      callerRole: 'academic',
      currentUser: {
        id: jwt.sub,
        role: jwt.role,
        tenantId: jwt.tenantId ?? '',
      },
    };
  }

  /**
   * read 路径 RBAC（list-by-teacher 等 GET 类操作）
   *
   * Wave 11 拍板修复：
   *   - 写路径 = 仅 academic
   *   - read 路径 = 拍板 L201 read scope: {teacher 自己课, sales 自己客户孩子,
   *     academic 创建+看, boss 看, admin 看（拍板 admin 跨校全字段）}
   *   - 不在 read scope: parent（C 端独立 endpoint）/ finance / hr / marketing /
   *     sales_manager / academic_admin（5/15 A-2 删 sales_director）
   *
   * ⚠ scope 内细化（teacher self-only / sales ownership）留 Sprint X backlog
   */
  private assertReadRoleForListByTeacher(req: AuthenticatedRequest): void {
    const jwt = req.user;
    if (!jwt?.sub || !jwt.role) {
      throw new BadRequestException('JWT sub/role required');
    }
    const allowed = ['teacher', 'sales', 'academic', 'boss', 'admin'] as const;
    if (!(allowed as readonly string[]).includes(jwt.role)) {
      throw new ForbiddenException(
        `SCHEDULE_READ_ROLE_NOT_ALLOWED: role=${jwt.role}`,
      );
    }
  }

  /**
   * 派生 schedulableTeachers（Wave 11 拍板修复）：
   *   - academic → 教务所在校区在职老师列表（campus_id === JWT.campusId）
   *     防止教务跨校排课（拍板 L202 班型限制 / L211 教务 👁 不改 — 教务本校权限）
   *   - JWT.campusId 缺 → 抛 ForbiddenException（academic 是单校 role，campusId 必填）
   *
   * 实现：listActiveInTenant 后 filter campus_id（避免新增 repo 方法，最小变更）
   *   TODO(perf): 若 tenant 老师 N > 200 加 listActiveByCampus repo 方法直接 SQL filter
   */
  private async deriveSchedulableTeachers(
    tenantSchema: string,
    callerRole: SchedulerRole,
    currentUser: CurrentUser,
    jwtCampusId: string | null,
  ): Promise<Array<{ id: string; userId?: string }>> {
    if (callerRole !== 'academic') {
      // 防御性，controller 早期 403 已挡，这里兜底
      throw new ForbiddenException('ONLY_ACADEMIC_CAN_CREATE_SCHEDULE');
    }
    if (!jwtCampusId) {
      // academic 是单校 role（jwt.strategy.ts L122-126 校验过）
      // 此处兜底防止极端情况 (jwt 篡改 / token 无 campusId)
      throw new ForbiddenException(
        'ACADEMIC_CAMPUS_REQUIRED: 教务必须归属单一校区',
      );
    }
    const all = await this.teacherRepo.listActiveInTenant(tenantSchema);
    // 同校区过滤（teacher.campus_id === jwt.campusId）
    const sameCampus = all.filter((t) => t.campusId === jwtCampusId);
    return sameCampus.map((t) => ({ id: t.id, userId: t.userId }));
  }

  // T-DEADCODE-CLEANUP P1-3 (2026-05-17): 删 deriveStudentResponsibleSalesMap dead helper
  //   原 method body `return new Map()`（Wave 11 拍板后教务无 ownership 校验），3 个 _underscored
  //   param 已暗示 dead。调用方 createSchedule / updateSchedule 改 inline `new Map<string, string>()`。
  //   future: 若 Sprint X 加「学生本校」校验，重新引入并实现 students→customers join 逻辑。

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
   *   - JWT 缺/role 非 academic：reason='ONLY_ACADEMIC_CAN_CREATE_SCHEDULE: role=xxx'
   *     或 'JWT sub/role required' / 'ACADEMIC_CAMPUS_REQUIRED'
   *   - service 业务校验失败（TEACHER_NOT_IN_ACADEMIC_CAMPUS / SCHEDULE_CONFLICT 等）：
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

  /**
   * Sprint E #3 round 5 (A09 FINDING-1 修复):
   * 改用 normalizeActorRole 运行时白名单校验, JWT role 越界 (marketing/finance_admin
   * 等不在 V33 CHECK 内的值) → fallback 'system', 避免 audit INSERT 违反 CHECK
   * constraint 导致拒绝路径 audit 静默丢失
   */
  private actorRole(req: AuthenticatedRequest): ActorRole {
    return normalizeActorRole(req.user?.role);
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
