import { Injectable, BadRequestException, ConflictException, Logger } from '@nestjs/common';

/**
 * RecurringScheduleService — V8.1 周期性课表 BE-V8-2
 *
 * 来源：
 *   - 《PD设计稿-排课-教学反馈-家长订阅-V1-2026-05-02.md》§3.6
 *   - PD 硬规则 P12（默认排课走"学员-老师固定绑定 + 周期性课表模板"）
 *
 * 简化 RRULE：BYDAY 字段为 ["MO","WE","FR"] + startMinutes（0-1439）
 *   完整 iCal RRULE 后续用 rrule.js 库扩展（V12+）
 */
export type WeekDay = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';

export interface StudentTeacherBinding {
  id: string;
  studentId: string;
  teacherId: string;
  subject?: string;
  status: 'active' | 'unbound';
  boundAt: Date;
  unboundAt?: Date;
  boundByUserId: string;
}

export interface RecurringSchedule {
  id: string;
  bindingId: string;
  studentId: string;
  teacherId: string;
  courseProductId?: string;
  byDay: ReadonlyArray<WeekDay>;
  startMinutes: number; // 0-1439
  durationMin: number;
  startDate: Date;
  endDate?: Date;
  status: 'active' | 'archived';
  createdByUserId: string;
  createdByRole: 'teacher' | 'sales';
  createdAt: Date;
  archivedAt?: Date;
}

const WEEKDAY_TO_NUM: Record<WeekDay, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

@Injectable()
export class RecurringScheduleService {
  private readonly logger = new Logger(RecurringScheduleService.name);

  /**
   * 创建学员-老师绑定（B-32 学员档案页）
   */
  createBinding(input: {
    id: string;
    studentId: string;
    teacherId: string;
    subject?: string;
    boundByUserId: string;
  }): StudentTeacherBinding {
    if (!input.id || input.id.length !== 32) {
      throw new BadRequestException('binding id must be 32-char ULID');
    }
    if (!input.studentId || input.studentId.length !== 32) {
      throw new BadRequestException('studentId must be 32-char ULID');
    }
    if (!input.teacherId || input.teacherId.length !== 32) {
      throw new BadRequestException('teacherId must be 32-char ULID');
    }
    if (!input.boundByUserId || input.boundByUserId.length !== 32) {
      throw new BadRequestException('boundByUserId must be 32-char ULID');
    }
    return {
      id: input.id,
      studentId: input.studentId,
      teacherId: input.teacherId,
      subject: input.subject,
      status: 'active',
      boundAt: new Date(),
      boundByUserId: input.boundByUserId,
    };
  }

  /**
   * 解绑（级联归档相关 recurring_schedules）
   */
  unbindBinding(binding: StudentTeacherBinding): StudentTeacherBinding {
    if (binding.status === 'unbound') {
      throw new BadRequestException('binding already unbound');
    }
    return { ...binding, status: 'unbound', unboundAt: new Date() };
  }

  /**
   * 创建周期性模板（PD §3.6.3）
   *
   * 创建时**预检未来 N 天**所有展开时段是否冲突，任一冲突 → 整模板拒绝
   *
   * @param expandRangeDays 预检的天数（PD 默认 90 天）
   * @param existingSchedulesInRange 该期间内已存在的 schedules（用于冲突检测）
   * @param existingAttachmentsInRange 该期间内已存在的 schedule_students
   */
  createRecurring(
    input: {
      id: string;
      bindingId: string;
      studentId: string;
      teacherId: string;
      courseProductId?: string;
      byDay: ReadonlyArray<WeekDay>;
      startMinutes: number;
      durationMin: number;
      startDate: Date;
      endDate?: Date;
      createdByUserId: string;
      createdByRole: 'teacher' | 'sales';
    },
    expandRangeDays: number,
    existingSchedules: ReadonlyArray<{
      teacherId: string;
      studentIds: ReadonlyArray<string>;
      startAt: Date;
      endAt: Date;
      status: string;
    }>,
  ): RecurringSchedule {
    // 输入校验
    this.assertRecurringInputs(input);

    // 展开未来 N 天的所有候选时段
    const candidates = this.expandToCandidates(
      input.byDay,
      input.startMinutes,
      input.durationMin,
      input.startDate,
      input.endDate,
      expandRangeDays,
    );

    // 检测每个候选时段是否冲突
    const conflicts: Array<{ startAt: Date; reason: string }> = [];
    for (const c of candidates) {
      // 老师同时段
      const teacherConflict = existingSchedules.find(
        (s) =>
          s.teacherId === input.teacherId &&
          s.status !== '已取消' &&
          c.startAt < s.endAt &&
          s.startAt < c.endAt,
      );
      if (teacherConflict) {
        conflicts.push({ startAt: c.startAt, reason: 'TEACHER_CONFLICT' });
        continue;
      }
      // 学员同时段
      const studentConflict = existingSchedules.find(
        (s) =>
          s.status !== '已取消' &&
          s.studentIds.includes(input.studentId) &&
          c.startAt < s.endAt &&
          s.startAt < c.endAt,
      );
      if (studentConflict) {
        conflicts.push({ startAt: c.startAt, reason: 'STUDENT_CONFLICT' });
      }
    }

    if (conflicts.length > 0) {
      throw new ConflictException(
        `RECURRING_SCHEDULE_CONFLICT: ${conflicts.length} 时段冲突，前 3: ${conflicts
          .slice(0, 3)
          .map((c) => `${c.startAt.toISOString()}(${c.reason})`)
          .join('; ')}`,
      );
    }

    this.logger.log(
      `[BE-V8-2] createRecurring id=${input.id} student=${input.studentId} ` +
        `teacher=${input.teacherId} byDay=${input.byDay.join(',')} ` +
        `expanded ${candidates.length} 时段全部无冲突`,
    );

    return {
      id: input.id,
      bindingId: input.bindingId,
      studentId: input.studentId,
      teacherId: input.teacherId,
      courseProductId: input.courseProductId,
      byDay: input.byDay,
      startMinutes: input.startMinutes,
      durationMin: input.durationMin,
      startDate: input.startDate,
      endDate: input.endDate,
      status: 'active',
      createdByUserId: input.createdByUserId,
      createdByRole: input.createdByRole,
      createdAt: new Date(),
    };
  }

  /**
   * 归档模板（PD §3.6.5）
   *
   * @returns archived 模板 + 应清理的未来 schedules（start_at >= today）
   */
  archiveRecurring(recurring: RecurringSchedule): RecurringSchedule {
    if (recurring.status === 'archived') {
      throw new BadRequestException('recurring already archived');
    }
    return {
      ...recurring,
      status: 'archived',
      archivedAt: new Date(),
    };
  }

  /**
   * 展开 RRULE 为具体时段（用于 cron expandRecurringScheduleCron 或冲突预检）
   *
   * @param rangeDays 从 today 起展开多少天
   * @param now 测试用注入时钟
   */
  expandToCandidates(
    byDay: ReadonlyArray<WeekDay>,
    startMinutes: number,
    durationMin: number,
    startDate: Date,
    endDate: Date | undefined,
    rangeDays: number,
    now: Date = new Date(),
  ): Array<{ startAt: Date; endAt: Date }> {
    const result: Array<{ startAt: Date; endAt: Date }> = [];
    const numericDays = byDay.map((d) => WEEKDAY_TO_NUM[d]);
    const cursorEnd = new Date(now.getTime() + rangeDays * 24 * 60 * 60 * 1000);
    const effectiveStart = startDate.getTime() > now.getTime() ? startDate : now;
    const effectiveEnd =
      endDate !== undefined && endDate.getTime() < cursorEnd.getTime() ? endDate : cursorEnd;

    // 遍历 effectiveStart → effectiveEnd 每一天
    const cursor = new Date(effectiveStart);
    cursor.setUTCHours(0, 0, 0, 0);
    while (cursor.getTime() <= effectiveEnd.getTime()) {
      const dayOfWeek = cursor.getUTCDay();
      if (numericDays.includes(dayOfWeek)) {
        const startAt = new Date(cursor.getTime() + startMinutes * 60 * 1000);
        // 仅保留 startDate ≤ startAt ≤ endDate 的时段
        if (startAt.getTime() >= startDate.getTime() &&
            (endDate === undefined || startAt.getTime() <= endDate.getTime() + 24 * 60 * 60 * 1000)) {
          const endAt = new Date(startAt.getTime() + durationMin * 60 * 1000);
          result.push({ startAt, endAt });
        }
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return result;
  }

  // -- helpers --

  private assertRecurringInputs(input: {
    id: string;
    bindingId: string;
    studentId: string;
    teacherId: string;
    byDay: ReadonlyArray<WeekDay>;
    startMinutes: number;
    durationMin: number;
    startDate: Date;
    endDate?: Date;
    createdByUserId: string;
  }): void {
    if (!input.id || input.id.length !== 32) {
      throw new BadRequestException('recurring id must be 32-char ULID');
    }
    if (!input.bindingId || input.bindingId.length !== 32) {
      throw new BadRequestException('bindingId must be 32-char ULID');
    }
    if (!input.byDay || input.byDay.length === 0) {
      throw new BadRequestException('byDay required (>=1 weekday)');
    }
    const validDays: WeekDay[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
    for (const d of input.byDay) {
      if (!validDays.includes(d)) {
        throw new BadRequestException(`invalid weekday: ${d}`);
      }
    }
    if (input.startMinutes < 0 || input.startMinutes > 1439) {
      throw new BadRequestException('startMinutes must be in [0, 1439]');
    }
    if (input.durationMin <= 0 || input.durationMin > 480) {
      throw new BadRequestException('durationMin must be in (0, 480]');
    }
    if (input.endDate !== undefined && input.endDate.getTime() < input.startDate.getTime()) {
      throw new BadRequestException('endDate must be >= startDate');
    }
  }
}
