import { Injectable, BadRequestException, Logger, Optional, NotFoundException } from '@nestjs/common';
import { LessonFeedbackRepository } from '../db/lesson-feedback.repository';

/**
 * LessonFeedbackService — V9 教学反馈 BE-V9-1
 *
 * 来源：
 *   - 《PD设计稿-排课-教学反馈-家长订阅-V1-2026-05-02.md》§4
 *   - PD 硬规则 P6（24h 必填）+ 配套课消锁定
 */
export type AttendanceForFeedback = '出勤' | '迟到' | '缺席' | '请假';
export type ClassroomPerformance = '优秀' | '良好' | '合格' | '需努力' | '需关注';

export type HomeworkDifficulty = 'basic' | 'medium' | 'hard';

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
  // V18 5 fields（pages/b/feedback/new 前端已记录，V18 后端持久化）
  knowledgeMatrix?: ReadonlyArray<{ name: string; mastery: string }>;
  dimRatings?: { focus?: number; engage?: number; think?: number; homework?: number };
  homeworkDeadline?: Date;
  homeworkDifficulty?: HomeworkDifficulty;
  nextPreview?: string;
  parentReadAt?: Date;
  submittedAt: Date;
  updatedAt: Date;
}

@Injectable()
export class LessonFeedbackService {
  private readonly logger = new Logger(LessonFeedbackService.name);

  constructor(@Optional() private readonly repo?: LessonFeedbackRepository) {}

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
    // V18 5 fields
    knowledgeMatrix?: ReadonlyArray<{ name: string; mastery: string }>;
    dimRatings?: { focus?: number; engage?: number; think?: number; homework?: number };
    homeworkDeadline?: Date;
    homeworkDifficulty?: HomeworkDifficulty;
    nextPreview?: string;
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
      knowledgeMatrix: input.knowledgeMatrix,
      dimRatings: input.dimRatings,
      homeworkDeadline: input.homeworkDeadline,
      homeworkDifficulty: input.homeworkDifficulty,
      nextPreview: input.nextPreview,
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
      knowledgeMatrix: ReadonlyArray<{ name: string; mastery: string }>;
      dimRatings: { focus?: number; engage?: number; think?: number; homework?: number };
      homeworkDeadline: Date;
      homeworkDifficulty: HomeworkDifficulty;
      nextPreview: string;
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

  // ============= 真存盘版 =============

  async submitInDb(
    input: Parameters<LessonFeedbackService['submit']>[0],
    tenantSchema: string,
  ): Promise<LessonFeedback> {
    if (!this.repo) throw new BadRequestException('LessonFeedbackRepository not available');
    const memFeedback = this.submit(input);
    return this.repo.insert(tenantSchema, memFeedback);
  }

  async findInDb(
    id: string,
    tenantSchema: string,
  ): Promise<LessonFeedback> {
    if (!this.repo) throw new BadRequestException('LessonFeedbackRepository not available');
    const r = await this.repo.findById(tenantSchema, id);
    if (!r) throw new NotFoundException(`feedback ${id} not found`);
    return r;
  }

  async listByStudentInDb(
    studentId: string,
    tenantSchema: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<LessonFeedback[]> {
    if (!this.repo) throw new BadRequestException('LessonFeedbackRepository not available');
    return this.repo.listByStudent(tenantSchema, studentId, options);
  }

  async updateInDb(
    id: string,
    patch: {
      attendanceStatus?: AttendanceForFeedback;
      classroomPerformance?: ClassroomPerformance;
      knowledgePoints?: ReadonlyArray<{ name: string; mastery: ClassroomPerformance }>;
      homework?: string;
      teacherNote?: string;
      teacherInternalNote?: string;
      knowledgeMatrix?: ReadonlyArray<{ name: string; mastery: string }>;
      dimRatings?: { focus?: number; engage?: number; think?: number; homework?: number };
      homeworkDeadline?: Date;
      homeworkDifficulty?: HomeworkDifficulty;
      nextPreview?: string;
    },
    tenantSchema: string,
    now: Date = new Date(),
  ): Promise<LessonFeedback> {
    if (!this.repo) throw new BadRequestException('LessonFeedbackRepository not available');
    const existing = await this.repo.findById(tenantSchema, id);
    if (!existing) throw new NotFoundException(`feedback ${id} not found`);
    // 24h 校验沿用纯逻辑
    this.update(existing, patch, now);
    return this.repo.update(tenantSchema, id, patch);
  }

  async markParentReadInDb(
    id: string,
    tenantSchema: string,
  ): Promise<LessonFeedback> {
    if (!this.repo) throw new BadRequestException('LessonFeedbackRepository not available');
    return this.repo.markParentRead(tenantSchema, id);
  }
}
