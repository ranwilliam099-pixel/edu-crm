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
 *   - PD 硬规则 P1-P5（资源仅老师+学生 / 老师销售可排课 / 销售只能跟进学员 /
 *     老师跨校豁免 / 冲突硬阻塞）
 *   - 用户拍板条目 31 #2（老师 RBAC 反查链路）
 *
 * USER-AUTH(2026-05-02): 排课 = 事务内冲突硬阻塞（teacher 同段 + 学员同段）+
 *   销售只能给跟进学员排课 + 老师跨校豁免 + 现有教师方可排课（status=在职）
 *
 * 严守边界：
 *   1. 内存对象 + 应用层冲突检测（INT-01 挂账期间）；真 DB 跑时换为 SELECT FOR UPDATE
 *   2. 不引入排课模板逻辑（V8.1 RecurringScheduleService 待开）
 *   3. 不引入反馈 / 课消逻辑（V9 待开）
 */
export type ScheduleStatus = '已排课' | '已完成' | '已取消' | '缺席';
export type ScheduleSource = 'one_off' | 'recurring_expansion';
export type AttendanceStatus = '待出勤' | '出勤' | '迟到' | '缺席' | '请假';
export type SchedulerRole = 'teacher' | 'sales';

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
  /** 调用方业务身份（teacher 即"通过 teachers.user_id 反查到的老师" / sales）*/
  callerRole: SchedulerRole;
  source?: ScheduleSource;
  recurringScheduleId?: string;
}

@Injectable()
export class ScheduleService {
  private readonly logger = new Logger(ScheduleService.name);

  constructor(@Optional() private readonly repo?: ScheduleRepository) {}

  /**
   * 创建排课（含 RBAC + 冲突硬阻塞）
   *
   * @param existingSchedules 当前 tenant 内非 cancelled 的全部排课（用于冲突检测）
   * @param studentResponsibleSalesMap student_id → responsible_sales_id 映射（销售校验 P3）
   * @param schedulableTeachers 可排课的 active 教师列表（用于 P4 跨校豁免校验）
   * @returns Schedule + ScheduleStudent[] 内存对象（不持久化）
   */
  createSchedule(
    input: CreateScheduleInput,
    existingSchedules: ReadonlyArray<Schedule>,
    existingStudentsAttachment: ReadonlyArray<ScheduleStudent>,
    studentResponsibleSalesMap: Map<string, string>,
    schedulableTeachers: ReadonlyArray<{ id: string; userId?: string }>,
  ): { schedule: Schedule; students: ScheduleStudent[] } {
    // ① 输入校验
    this.assertInputs(input);

    // ② 教师必须 active 可排课（status=在职 + 在 schedulableTeachers 列表中）
    const teacher = schedulableTeachers.find((t) => t.id === input.teacherId);
    if (!teacher) {
      throw new BadRequestException(
        `teacher ${input.teacherId} not schedulable (not active or not in tenant)`,
      );
    }

    // ③ RBAC：销售只能给自己跟进的学员排课（P3）
    if (input.callerRole === 'sales') {
      const wrongStudents: string[] = [];
      for (const sid of input.studentIds) {
        const responsibleSalesId = studentResponsibleSalesMap.get(sid);
        if (responsibleSalesId !== input.currentUser.id) {
          wrongStudents.push(sid);
        }
      }
      if (wrongStudents.length > 0) {
        throw new ForbiddenException(
          `SALES_ONLY_OWN_STUDENTS: ${wrongStudents.join(',')}`,
        );
      }
    } else if (input.callerRole === 'teacher') {
      // P4：老师身份必须能反查到 teachers.user_id = currentUser.id 且对应 teacherId
      // （仅在 schedulableTeachers 中验证存在）— 跨校豁免：不校验 campus_id
      const teacherForCurrentUser = schedulableTeachers.find(
        (t) => t.userId === input.currentUser.id,
      );
      if (!teacherForCurrentUser) {
        throw new ForbiddenException(
          'TEACHER_USER_NOT_BOUND: 当前用户未在 teachers 表关联或 teacher 已归档',
        );
      }
    } else {
      throw new ForbiddenException(
        `ONLY_TEACHER_OR_SALES_CAN_CREATE_SCHEDULE: callerRole=${input.callerRole}`,
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
    studentResponsibleSalesMap: Map<string, string>,
    schedulableTeachers: ReadonlyArray<{ id: string; userId?: string }>,
  ): Promise<{ schedule: Schedule; students: ScheduleStudent[] }> {
    if (!this.repo) {
      throw new BadRequestException('ScheduleRepository not available');
    }
    this.assertInputs(input);

    // RBAC（同 createSchedule 内存版）
    const teacher = schedulableTeachers.find((t) => t.id === input.teacherId);
    if (!teacher) {
      throw new BadRequestException(
        `teacher ${input.teacherId} not schedulable`,
      );
    }
    if (input.callerRole === 'sales') {
      const wrong: string[] = [];
      for (const sid of input.studentIds) {
        if (studentResponsibleSalesMap.get(sid) !== input.currentUser.id) wrong.push(sid);
      }
      if (wrong.length > 0) {
        throw new ForbiddenException(`SALES_ONLY_OWN_STUDENTS: ${wrong.join(',')}`);
      }
    } else if (input.callerRole === 'teacher') {
      const matched = schedulableTeachers.find((t) => t.userId === input.currentUser.id);
      if (!matched) throw new ForbiddenException('TEACHER_USER_NOT_BOUND');
    } else {
      throw new ForbiddenException(`ONLY_TEACHER_OR_SALES_CAN_CREATE_SCHEDULE`);
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
