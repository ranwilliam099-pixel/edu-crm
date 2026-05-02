import { Injectable, BadRequestException, Logger } from '@nestjs/common';

/**
 * LessonFeedbackService — V9 教学反馈 BE-V9-1
 *
 * 来源：
 *   - 《PD设计稿-排课-教学反馈-家长订阅-V1-2026-05-02.md》§4
 *   - PD 硬规则 P6（24h 必填）+ 配套课消锁定
 */
export type AttendanceForFeedback = '出勤' | '迟到' | '缺席' | '请假';
export type ClassroomPerformance = '优秀' | '良好' | '合格' | '需努力' | '需关注';

export interface LessonFeedback {
  id: string;
  scheduleId: string;
  studentId: string;
  teacherId: string;
  attendanceStatus: AttendanceForFeedback;
  classroomPerformance: ClassroomPerformance;
  knowledgePoints?: ReadonlyArray<{ name: string; mastery: ClassroomPerformance }>;
  homework?: string;
  homeworkAttachments?: ReadonlyArray<{ url: string; type: string; filename: string }>;
  teacherNote?: string;
  teacherInternalNote?: string;
  parentReadAt?: Date;
  submittedAt: Date;
  updatedAt: Date;
}

@Injectable()
export class LessonFeedbackService {
  private readonly logger = new Logger(LessonFeedbackService.name);

  /**
   * 老师提交反馈（schedule.completed 后 24h 内有效）
   *
   * @throws BadRequestException 输入校验失败 / 已存在
   */
  submit(input: {
    id: string;
    scheduleId: string;
    studentId: string;
    teacherId: string;
    attendanceStatus: AttendanceForFeedback;
    classroomPerformance: ClassroomPerformance;
    knowledgePoints?: ReadonlyArray<{ name: string; mastery: ClassroomPerformance }>;
    homework?: string;
    homeworkAttachments?: ReadonlyArray<{ url: string; type: string; filename: string }>;
    teacherNote?: string;
    teacherInternalNote?: string;
  }): LessonFeedback {
    if (!input.id || input.id.length !== 32) {
      throw new BadRequestException('feedback id must be 32-char ULID');
    }
    if (!input.scheduleId || input.scheduleId.length !== 32) {
      throw new BadRequestException('scheduleId must be 32-char ULID');
    }
    if (!input.studentId || input.studentId.length !== 32) {
      throw new BadRequestException('studentId must be 32-char ULID');
    }
    if (!input.teacherId || input.teacherId.length !== 32) {
      throw new BadRequestException('teacherId must be 32-char ULID');
    }
    if (!['出勤', '迟到', '缺席', '请假'].includes(input.attendanceStatus)) {
      throw new BadRequestException(`attendanceStatus invalid: ${input.attendanceStatus}`);
    }
    if (
      !['优秀', '良好', '合格', '需努力', '需关注'].includes(input.classroomPerformance)
    ) {
      throw new BadRequestException(
        `classroomPerformance invalid: ${input.classroomPerformance}`,
      );
    }
    const now = new Date();
    this.logger.log(
      `[BE-V9-1] submitFeedback id=${input.id} schedule=${input.scheduleId} ` +
        `student=${input.studentId} attendance=${input.attendanceStatus} ` +
        `performance=${input.classroomPerformance}`,
    );
    return {
      id: input.id,
      scheduleId: input.scheduleId,
      studentId: input.studentId,
      teacherId: input.teacherId,
      attendanceStatus: input.attendanceStatus,
      classroomPerformance: input.classroomPerformance,
      knowledgePoints: input.knowledgePoints,
      homework: input.homework,
      homeworkAttachments: input.homeworkAttachments,
      teacherNote: input.teacherNote,
      teacherInternalNote: input.teacherInternalNote,
      submittedAt: now,
      updatedAt: now,
    };
  }

  /**
   * 老师 24h 内修改反馈
   *
   * @throws BadRequestException 24h 已过
   */
  update(
    feedback: LessonFeedback,
    patch: Partial<{
      attendanceStatus: AttendanceForFeedback;
      classroomPerformance: ClassroomPerformance;
      knowledgePoints: ReadonlyArray<{ name: string; mastery: ClassroomPerformance }>;
      homework: string;
      teacherNote: string;
      teacherInternalNote: string;
    }>,
    now: Date = new Date(),
  ): LessonFeedback {
    const submittedAt = feedback.submittedAt.getTime();
    const ELAPSED_24H = 24 * 60 * 60 * 1000;
    if (now.getTime() - submittedAt > ELAPSED_24H) {
      throw new BadRequestException('feedback can only be modified within 24h of submitted_at');
    }
    return { ...feedback, ...patch, updatedAt: now };
  }

  /**
   * 家长打"已读"
   */
  markParentRead(feedback: LessonFeedback, now: Date = new Date()): LessonFeedback {
    if (feedback.parentReadAt !== undefined) {
      // 重复打勾不报错（幂等）
      return feedback;
    }
    return { ...feedback, parentReadAt: now };
  }
}
