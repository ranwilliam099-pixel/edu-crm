import { Injectable, BadRequestException, Logger, Optional, NotFoundException } from '@nestjs/common';
import { LessonFeedbackRepository } from '../db/lesson-feedback.repository';
import { CourseConsumptionRepository } from '../db/course-consumption.repository';

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

  constructor(
    @Optional() private readonly repo?: LessonFeedbackRepository,
    // P1 S3 (2026-05-21)：feedback 提交合并 consumption confirm
    //   @Optional：纯逻辑 spec 用 `new LessonFeedbackService()` 不传 repo，不影响内存版
    //   submitInDb 内部 try-catch 包裹 confirm，fail-open 不阻塞主反馈写入
    @Optional() private readonly consumptionRepo?: CourseConsumptionRepository,
  ) {}

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
    const persisted = await this.repo.insert(tenantSchema, memFeedback);

    // P1 S3 (2026-05-21) — 合并：feedback 提交自动 confirm 同 schedule 下 pending consumption
    //
    // 业务依据：
    //   - 5/20 demo-empty tenant 12 步真生产业务流痛点：
    //     teacher 完课流程需 4 API call（创建 consumption → 写 feedback → admin confirm → cron lock）
    //     UX 不连贯，stats weeklyConsumedYuan 在 admin 介入前为 0
    //   - 拍板：teacher 写反馈 = 已确认上课 = 课消立即 confirmed
    //
    // 5/21 round 2 (security BLOCKER-2 修复)：
    //   旧版 findPendingByScheduleId LIMIT 1 假设 schedule:consumption 1:1
    //   但 V9 schema `UNIQUE (schedule_id, student_id)` 允许多学生小班课 → 多条 consumption
    //   → 改用 findAllPendingByScheduleId 循环 confirm（多学生场景正确语义）
    //   → 每条 confirm 独立 try-catch（一条失败不影响其他学生）
    //
    // 设计原则：
    //   - fail-open：consumption 自动 confirm 失败 → 仅 logger.warn，不阻塞 feedback 主流程
    //   - cron scan-and-lock 兜底（pending_feedback 超 24h → locked 由现有 cron 处理）
    //   - 已 confirmed/locked/cancelled 的 consumption 不重复处理（pending 过滤天然排除）
    //   - audit_log 不在 service 写；controller 层（submitFeedbackInDb）会写 'lesson-feedback.submitted'
    if (this.consumptionRepo) {
      try {
        const pendings = await this.consumptionRepo.findAllPendingByScheduleId(
          tenantSchema,
          input.scheduleId,
        );
        let confirmed = 0;
        for (const c of pendings) {
          try {
            await this.consumptionRepo.confirmByFeedback(tenantSchema, c.id, persisted.id);
            confirmed++;
          } catch (err) {
            this.logger.warn(
              `[S3] auto-confirm consumption ${c.id} failed: ` +
                `${(err as Error).message}`,
            );
          }
        }
        this.logger.log(
          `[S3] auto-confirmed ${confirmed}/${pendings.length} consumptions ` +
            `for schedule ${input.scheduleId} by feedback ${persisted.id}`,
        );
      } catch (err) {
        // fail-open: cron scan-and-lock 兜底，feedback 主流程不受影响
        this.logger.warn(
          `[S3] findAllPending failed for schedule ${input.scheduleId}: ` +
            `${(err as Error).message}`,
        );
      }
    }

    return persisted;
  }

  async findInDb(
    id: string,
    tenantSchema: string,
  ): Promise<LessonFeedback & {
    studentName?: string | null;
    teacherName?: string | null;
    subject?: string | null;
  }> {
    if (!this.repo) throw new BadRequestException('LessonFeedbackRepository not available');
    // 2026-05-22 Wave A: 返扩展 meta (studentName/teacherName/subject) 供 B 端 detail page 直接用
    //   JOIN students + teachers + course_products, 不增加额外 HTTP roundtrip
    const r = await this.repo.findByIdWithMeta(tenantSchema, id);
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
