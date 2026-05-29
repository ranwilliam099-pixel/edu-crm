import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  Optional,
} from '@nestjs/common';
import { ScheduleRepository } from '../db/schedule.repository';

/**
 * ScheduleService — V8 排课核心 BE-V8-1
 *
 * 来源：
 *   - 《PD设计稿-排课-教学反馈-家长订阅-V1-2026-05-02.md》§3
 *   - PD 硬规则 P1-P5（资源仅老师+学生 / 现有教师方可排课 / 冲突硬阻塞）
 *   - 用户拍板条目 31 #2（老师 RBAC 反查链路）
 *
 * USER-AUTH(2026-05-02): 排课 = 事务内冲突硬阻塞（teacher 同段 + 学员同段）+
 *   教务本校排课（5/9 拍板「教务主责」）+ 现有教师方可排课（status=在职）
 *
 * Wave 11（2026-05-15）拍板反向修复：
 *   - 5/9 拍板「教务唯一创建」(fields-by-role.md L82/L102/L133/L201/feedback L56)
 *     5 处明文：教务是唯一 ✅ 创建，老师 ✅ 自己课（执行）不创建，销售/老板/校长 ❌ 创建
 *   - 5/12 Sprint B.4-1 round 2 误读「教务主责」为「teacher + sales 创建，academic 403」
 *     连锁导致 5/12-5/15 期间生产 RBAC 与拍板完全反向
 *   - Wave 11 修正 callerRole 域 = ['academic']（admin/boss/sales/teacher/finance 全 403）
 *   - 学生归属（owner_sales_id）校验从硬规则 P3 移除（拍板矩阵 L201 教务 ✅ 创建无限定）
 *     学生层 ownership 校验留 Sprint X backlog（教务本校限制由 campus_id filter
 *     + schedulableTeachers 列表过滤兜底）
 *
 * 严守边界：
 *   1. 内存对象 + 应用层冲突检测（INT-01 挂账期间）；真 DB 跑时换为 SELECT FOR UPDATE
 *   2. 不引入排课模板逻辑（V8.1 RecurringScheduleService 待开）
 *   3. 不引入反馈 / 课消逻辑（V9 待开）
 */
export type ScheduleStatus = '已排课' | '已完成' | '已取消' | '缺席';
export type ScheduleSource = 'one_off' | 'recurring_expansion';
export type AttendanceStatus = '待出勤' | '出勤' | '迟到' | '缺席' | '请假';
/**
 * 排课调用角色（Wave 11 拍板修复）
 *
 * 仅 academic（教务）可创建。其他 role 在 controller / service 层早期 403。
 */
export type SchedulerRole = 'academic';

export interface Schedule {
  id: string;
  courseProductId?: string;
  teacherId: string;
  startAt: Date;
  durationMin: number;
  endAt: Date;
  status: ScheduleStatus;
  source: ScheduleSource;
  recurringScheduleId?: string;
  createdByUserId: string;
  createdByRole: SchedulerRole;
  notes?: string;
  // V32 班型 + 老师自填最多人数（柔性，仅校验上限）
  classType?: string;
  maxStudents?: number;
}

export interface ScheduleCalendarItem extends Schedule {
  teacherName?: string;
  courseProductName?: string;
  classType?: string;
  studentCount: number;
}

export interface ScheduleStudent {
  scheduleId: string;
  studentId: string;
  attendanceStatus: AttendanceStatus;
  joinedAt: Date;
}

export interface CurrentUser {
  id: string;
  role: string; // V2 8 枚举之一（不含 teacher，老师走 teachers.user_id 反查）
  tenantId: string;
}

export interface CreateScheduleInput {
  id: string;
  teacherId: string;
  studentIds: ReadonlyArray<string>;
  startAt: Date;
  durationMin: number;
  courseProductId?: string;
  notes?: string;
  currentUser: CurrentUser;
  /**
   * 调用方业务身份（Wave 11 拍板修复后仅 'academic' 合法）
   * controller 层从 JWT.role 派生，body 自报字段被覆盖。
   */
  callerRole: SchedulerRole;
  source?: ScheduleSource;
  recurringScheduleId?: string;
  // V32 班型 + 老师自填最多人数（柔性 — 后端兜底校验 studentIds.length ≤ maxStudents）
  classType?: string;
  maxStudents?: number;
}

@Injectable()
export class ScheduleService {
  private readonly logger = new Logger(ScheduleService.name);

  constructor(@Optional() private readonly repo?: ScheduleRepository) {}

  /**
   * 创建排课（含 RBAC + 冲突硬阻塞）
   *
   * Wave 11 拍板修复：
   *   - callerRole = 'academic'（教务唯一）— 5/9 拍板 fields-by-role.md L201
   *   - schedulableTeachers 由 controller 派生为「教务所在校区在职老师列表」
   *     此处只校验 teacherId ∈ schedulableTeachers（兜底防 controller 漏过滤）
   *   - 学生 ownership 校验已移除（教务 ✅ 创建拍板无任何限定语 — 留 Sprint X
   *     backlog 评估是否补「学生本校」校验，需 students.customer_id → customers.campus_id join）
   *
   * @param existingSchedules 当前 tenant 内非 cancelled 的全部排课（用于冲突检测）
   * @param studentResponsibleSalesMap @deprecated Wave 11 — 教务路径不用，保留参数签名向后兼容
   *                                   （传空 Map 即可；预留 future ownership 扩展点）
   * @param schedulableTeachers 教务所在校区可排课的 active 教师列表（controller 派生）
   * @returns Schedule + ScheduleStudent[] 内存对象（不持久化）
   */
  createSchedule(
    input: CreateScheduleInput,
    existingSchedules: ReadonlyArray<Schedule>,
    existingStudentsAttachment: ReadonlyArray<ScheduleStudent>,
    _studentResponsibleSalesMap: Map<string, string>,
    schedulableTeachers: ReadonlyArray<{ id: string; userId?: string }>,
  ): { schedule: Schedule; students: ScheduleStudent[] } {
    // ① 输入校验
    this.assertInputs(input);

    // ② RBAC: 仅 academic 可创建（Wave 11 拍板）— controller 层已早期 403,
    //   service 层兜底防内部直调
    if (input.callerRole !== 'academic') {
      throw new ForbiddenException(
        `ONLY_ACADEMIC_CAN_CREATE_SCHEDULE: callerRole=${input.callerRole}`,
      );
    }

    // ③ 教师必须 active 可排课（status=在职 + 在 schedulableTeachers 列表中）
    //   schedulableTeachers 已被 controller 按教务校区过滤,
    //   teacherId 不在列表 = 跨校排课 / 离职老师 / 非本租户
    const teacher = schedulableTeachers.find((t) => t.id === input.teacherId);
    if (!teacher) {
      throw new ForbiddenException(
        `TEACHER_NOT_IN_ACADEMIC_CAMPUS: teacher ${input.teacherId} not in academic's campus or not active`,
      );
    }

    // ④ 计算 end_at
    const endAt = new Date(input.startAt.getTime() + input.durationMin * 60 * 1000);

    // ⑤ 冲突检测 — 老师同时段（P5）
    this.assertNoTeacherConflict(input.teacherId, input.startAt, endAt, existingSchedules);

    // ⑥ 冲突检测 — 学员同时段（P5）
    this.assertNoStudentConflict(
      input.studentIds,
      input.startAt,
      endAt,
      existingSchedules,
      existingStudentsAttachment,
    );

    // ⑦ 通过所有校验，生成 schedule + students
    const schedule: Schedule = {
      id: input.id,
      courseProductId: input.courseProductId,
      teacherId: input.teacherId,
      startAt: input.startAt,
      durationMin: input.durationMin,
      endAt,
      status: '已排课',
      source: input.source ?? 'one_off',
      recurringScheduleId: input.recurringScheduleId,
      createdByUserId: input.currentUser.id,
      createdByRole: input.callerRole,
      notes: input.notes,
      // V32 班型 + 老师自填最多人数透传
      classType: input.classType,
      maxStudents: input.maxStudents,
    };
    const students: ScheduleStudent[] = input.studentIds.map((sid) => ({
      scheduleId: input.id,
      studentId: sid,
      attendanceStatus: '待出勤',
      joinedAt: new Date(),
    }));

    this.logger.log(
      `[BE-V8-1] createSchedule id=${schedule.id} teacher=${schedule.teacherId} ` +
        `students=${input.studentIds.length} start=${schedule.startAt.toISOString()} ` +
        `by=${schedule.createdByRole}/${schedule.createdByUserId}`,
    );

    return { schedule, students };
  }

  /**
   * 真存盘版 — 直接从 PG 查冲突 + 事务内 INSERT
   *
   * @param tenantSchema tenant_<tenantId>（小写）
   */
  async createScheduleInDb(
    input: CreateScheduleInput,
    tenantSchema: string,
    _studentResponsibleSalesMap: Map<string, string>,
    schedulableTeachers: ReadonlyArray<{ id: string; userId?: string }>,
  ): Promise<{ schedule: Schedule; students: ScheduleStudent[] }> {
    if (!this.repo) {
      throw new BadRequestException('ScheduleRepository not available');
    }
    this.assertInputs(input);

    // RBAC（同 createSchedule 内存版 — Wave 11 拍板：仅 academic 可创建）
    if (input.callerRole !== 'academic') {
      throw new ForbiddenException(
        `ONLY_ACADEMIC_CAN_CREATE_SCHEDULE: callerRole=${input.callerRole}`,
      );
    }
    const teacher = schedulableTeachers.find((t) => t.id === input.teacherId);
    if (!teacher) {
      throw new ForbiddenException(
        `TEACHER_NOT_IN_ACADEMIC_CAMPUS: teacher ${input.teacherId} not in academic's campus or not active`,
      );
    }

    const endAt = new Date(input.startAt.getTime() + input.durationMin * 60 * 1000);

    // 真查 PG 冲突
    const teacherConflicts = await this.repo.findConflictsForTeacher(
      tenantSchema,
      input.teacherId,
      input.startAt,
      endAt,
    );
    if (teacherConflicts.length > 0) {
      throw new ConflictException(
        `TEACHER_TIME_CONFLICT: teacher=${input.teacherId} conflicts=${teacherConflicts.map((c) => c.id).join(',')}`,
      );
    }
    const studentConflicts = await this.repo.findConflictsForStudents(
      tenantSchema,
      input.studentIds,
      input.startAt,
      endAt,
    );
    if (studentConflicts.length > 0) {
      throw new ConflictException(
        `STUDENT_TIME_CONFLICT: students=${studentConflicts.map((c) => c.conflictStudentId).join(',')}`,
      );
    }

    const schedule: Schedule = {
      id: input.id,
      courseProductId: input.courseProductId,
      teacherId: input.teacherId,
      startAt: input.startAt,
      durationMin: input.durationMin,
      endAt,
      status: '已排课',
      source: input.source ?? 'one_off',
      recurringScheduleId: input.recurringScheduleId,
      createdByUserId: input.currentUser.id,
      createdByRole: input.callerRole,
      notes: input.notes,
      // V32 班型 + 老师自填最多人数透传（兜底校验在 repository 层）
      classType: input.classType,
      maxStudents: input.maxStudents,
    };

    return this.repo.insertWithStudents(tenantSchema, schedule, input.studentIds);
  }

  async listByTeacherInDb(
    tenantSchema: string,
    teacherId: string,
    fromDate: Date,
    toDate: Date,
  ): Promise<Schedule[]> {
    if (!this.repo) throw new BadRequestException('ScheduleRepository not available');
    return this.repo.listByTeacher(tenantSchema, teacherId, fromDate, toDate);
  }

  async listCurrentTeacherCalendarInDb(
    tenantSchema: string,
    userId: string,
    fromDate: Date,
    toDate: Date,
  ): Promise<ScheduleCalendarItem[]> {
    if (!this.repo) throw new BadRequestException('ScheduleRepository not available');
    if (!userId) throw new BadRequestException('JWT sub required');
    return this.repo.listByTeacherUserIdWithSummary(tenantSchema, userId, fromDate, toDate);
  }

  /**
   * 2026-05-22 业务事件 Step 2 真持久化:
   *   老师上完课 → 同事务更新 schedule + INSERT N pending_feedback consumption
   *   这是消课业务事件唯一合法触发路径 (替代 seed 直接 INSERT 终态行)
   */
  async completeScheduleInDb(
    tenantSchema: string,
    scheduleId: string,
    consumptionIdPrefix: string,
    caller?: { userId?: string; role?: string },
  ): Promise<{ schedule: Schedule; consumptionsCreated: number; alreadyComplete: boolean }> {
    if (!this.repo) throw new BadRequestException('ScheduleRepository not available');
    // 2026-05-29 §12C.1: 老师角色只能完成自己任教的课 → 传 requireTeacherUserId 让 repo 事务内校验；
    //   admin/boss/academic 代操作不传（可完成任意课）
    const requireTeacherUserId =
      caller?.role === 'teacher' ? caller.userId : undefined;
    return this.repo.completeWithConsumptions(tenantSchema, scheduleId, {
      consumptionIdPrefix,
      requireTeacherUserId,
    });
  }

  /**
   * 2026-05-22 老师 lesson roster 数据源:
   *   返完整 lesson meta + 学员 list, 替代前端 mock
   */
  async findByIdWithRosterInDb(
    tenantSchema: string,
    scheduleId: string,
  ) {
    if (!this.repo) throw new BadRequestException('ScheduleRepository not available');
    return this.repo.findByIdWithRoster(tenantSchema, scheduleId);
  }

  /**
   * 取消排课
   */
  cancelSchedule(schedule: Schedule, reason?: string): Schedule {
    if (schedule.status === '已取消') {
      throw new BadRequestException('schedule already cancelled');
    }
    if (schedule.status === '已完成') {
      throw new BadRequestException('cannot cancel completed schedule');
    }
    return {
      ...schedule,
      status: '已取消',
      notes: reason ? `[CANCEL] ${reason}` : schedule.notes,
    };
  }

  /**
   * 标记排课完成（触发 V9 课消生成）
   */
  completeSchedule(schedule: Schedule): Schedule {
    if (schedule.status !== '已排课') {
      throw new BadRequestException(
        `only 已排课 can be completed; got ${schedule.status}`,
      );
    }
    return { ...schedule, status: '已完成' };
  }

  /**
   * 标记考勤
   */
  markAttendance(
    scheduleStudent: ScheduleStudent,
    newStatus: AttendanceStatus,
  ): ScheduleStudent {
    return { ...scheduleStudent, attendanceStatus: newStatus };
  }

  // -- helpers --

  private assertInputs(input: CreateScheduleInput): void {
    if (!input.id || input.id.length !== 32) {
      throw new BadRequestException('schedule id must be 32-char ULID');
    }
    if (!input.teacherId || input.teacherId.length !== 32) {
      throw new BadRequestException('teacherId must be 32-char ULID');
    }
    if (!input.studentIds || input.studentIds.length === 0) {
      throw new BadRequestException('studentIds required (>=1)');
    }
    for (const sid of input.studentIds) {
      if (sid.length !== 32) {
        throw new BadRequestException(`studentId ${sid} must be 32-char ULID`);
      }
    }
    if (!input.startAt || isNaN(input.startAt.getTime())) {
      throw new BadRequestException('startAt invalid');
    }
    if (input.durationMin <= 0 || input.durationMin > 480) {
      throw new BadRequestException('durationMin must be in (0, 480]');
    }
    if (!input.currentUser?.id || input.currentUser.id.length !== 32) {
      throw new BadRequestException('currentUser.id must be 32-char ULID');
    }
  }

  private rangesOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
    // [aStart, aEnd) && [bStart, bEnd)  半开区间相交
    return aStart < bEnd && bStart < aEnd;
  }

  private assertNoTeacherConflict(
    teacherId: string,
    startAt: Date,
    endAt: Date,
    existingSchedules: ReadonlyArray<Schedule>,
  ): void {
    const conflicts = existingSchedules.filter(
      (s) =>
        s.teacherId === teacherId &&
        s.status !== '已取消' &&
        this.rangesOverlap(s.startAt, s.endAt, startAt, endAt),
    );
    if (conflicts.length > 0) {
      throw new ConflictException(
        `TEACHER_TIME_CONFLICT: teacher=${teacherId} conflicts=${conflicts.map((c) => c.id).join(',')}`,
      );
    }
  }

  private assertNoStudentConflict(
    studentIds: ReadonlyArray<string>,
    startAt: Date,
    endAt: Date,
    existingSchedules: ReadonlyArray<Schedule>,
    existingAttachments: ReadonlyArray<ScheduleStudent>,
  ): void {
    const conflictStudents: string[] = [];
    for (const sid of studentIds) {
      const studentSchedules = existingAttachments
        .filter((ss) => ss.studentId === sid)
        .map((ss) => existingSchedules.find((s) => s.id === ss.scheduleId))
        .filter((s): s is Schedule => s !== undefined && s.status !== '已取消');
      const hasOverlap = studentSchedules.some((s) =>
        this.rangesOverlap(s.startAt, s.endAt, startAt, endAt),
      );
      if (hasOverlap) {
        conflictStudents.push(sid);
      }
    }
    if (conflictStudents.length > 0) {
      throw new ConflictException(
        `STUDENT_TIME_CONFLICT: students=${conflictStudents.join(',')}`,
      );
    }
  }
}
