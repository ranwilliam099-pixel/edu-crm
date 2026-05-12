import {
  Body,
  Controller,
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
 */
@UseGuards(TenantScopeGuard)
@Controller('schedules')
export class ScheduleController {
  constructor(
    private readonly service: ScheduleService,
    private readonly teacherRepo: TeacherRepository,
    private readonly studentRepo: StudentRepository,
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
      throw new BadRequestException('TENANT_SCHEMA_REQUIRED');
    }
    const { callerRole, currentUser } = this.assertCallerRoleAndDeriveContext(req);
    const inputDeserialized = this.deserializeInput(body.input, callerRole, currentUser);

    // Sprint B.4-1 round 2: server-derive（A04 修复，不再接受 body 注入）
    const schedulableTeachers = await this.deriveSchedulableTeachers(
      body.tenantSchema,
      callerRole,
      currentUser,
    );
    const studentResponsibleSalesMap = await this.deriveStudentResponsibleSalesMap(
      body.tenantSchema,
      callerRole,
      inputDeserialized.studentIds,
    );

    return this.service.createSchedule(
      inputDeserialized,
      body.existingSchedules.map((s) => this.deserializeSchedule(s)),
      body.existingStudentsAttachment,
      studentResponsibleSalesMap,
      schedulableTeachers,
    );
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
   */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancelSchedule(
    @Param('id') _id: string,
    @Body() body: { schedule: Schedule; reason?: string },
    @Req() req: AuthenticatedRequest,
  ): Schedule {
    this.assertCallerRoleAndDeriveContext(req); // 早期 403 {teacher,sales} 限制
    return this.service.cancelSchedule(this.deserializeSchedule(body.schedule), body.reason);
  }

  /**
   * POST /api/schedules/:id/complete — 标记排课完成（触发课消生成）
   *
   * Sprint B.4-1 round 2 (business P1-A): 同上 cancelSchedule，早期 403
   */
  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  completeSchedule(
    @Param('id') _id: string,
    @Body() body: { schedule: Schedule },
    @Req() req: AuthenticatedRequest,
  ): Schedule {
    this.assertCallerRoleAndDeriveContext(req); // 早期 403 {teacher,sales} 限制
    return this.service.completeSchedule(this.deserializeSchedule(body.schedule));
  }

  /**
   * POST /api/schedules/db — 真存盘版（自动查 PG 冲突 + 事务 INSERT）
   *
   * Sprint B.4-1: callerRole / currentUser / schedulableTeachers / studentResponsibleSalesPairs
   * 全部 server 派生，body 字段已 deprecated。
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
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    const { callerRole, currentUser } = this.assertCallerRoleAndDeriveContext(req);
    const inputDeserialized = this.deserializeInput(body.input, callerRole, currentUser);
    const schedulableTeachers = await this.deriveSchedulableTeachers(
      body.tenantSchema,
      callerRole,
      currentUser,
    );
    const studentResponsibleSalesMap = await this.deriveStudentResponsibleSalesMap(
      body.tenantSchema,
      callerRole,
      inputDeserialized.studentIds,
    );

    return this.service.createScheduleInDb(
      inputDeserialized,
      body.tenantSchema,
      studentResponsibleSalesMap,
      schedulableTeachers,
    );
  }

  /**
   * POST /api/schedules/db/list-by-teacher
   */
  @Post('db/list-by-teacher')
  @HttpCode(HttpStatus.OK)
  async listByTeacherInDb(
    @Body()
    body: { tenantSchema: string; teacherId: string; fromIso: string; toIso: string },
  ): Promise<Schedule[]> {
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
   */
  @Post(':scheduleId/students/:studentId/attendance')
  @HttpCode(HttpStatus.OK)
  markAttendance(
    @Param('scheduleId') _scheduleId: string,
    @Param('studentId') _studentId: string,
    @Body() body: { scheduleStudent: ScheduleStudent; newStatus: AttendanceStatus },
    @Req() req: AuthenticatedRequest,
  ): ScheduleStudent {
    this.assertCallerRoleAndDeriveContext(req); // 早期 403 {teacher,sales} 限制
    return this.service.markAttendance(body.scheduleStudent, body.newStatus);
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
}
