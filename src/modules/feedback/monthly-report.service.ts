import { Injectable, BadRequestException, Logger, Optional, NotFoundException } from '@nestjs/common';
import { LessonFeedback, ClassroomPerformance } from './lesson-feedback.service';
import { MonthlyReportRepository } from '../db/monthly-report.repository';
import { LessonFeedbackRepository } from '../db/lesson-feedback.repository';

/**
 * MonthlyReportService — V9 月报 BE-V9-3
 *
 * 来源：
 *   - 《PD设计稿-排课-教学反馈-家长订阅-V1-2026-05-02.md》§4.3
 *   - PD 硬规则 P7（月报自动汇总，cron 每月 1 号 00:30）
 */
export type MonthlyReportStatus = 'auto_generated' | 'teacher_finalized';

export interface AttendanceSummary {
  total: number;
  '出勤': number;
  '迟到': number;
  '缺席': number;
  '请假': number;
}

export interface PerformanceTrendPoint {
  date: string; // YYYY-MM-DD
  performance: ClassroomPerformance;
}

export interface KnowledgeSummaryItem {
  name: string;
  mastery: ClassroomPerformance;
  lessonCount: number;
}

export interface MonthlyReport {
  id: string;
  studentId: string;
  teacherId: string;
  month: Date; // YYYY-MM-01
  attendanceSummary: AttendanceSummary;
  performanceTrend: ReadonlyArray<PerformanceTrendPoint>;
  knowledgeSummary: ReadonlyArray<KnowledgeSummaryItem>;
  teacherBlessing?: string;
  renewalSuggestion?: string;
  status: MonthlyReportStatus;
  generatedAt: Date;
  finalizedAt?: Date;
  parentReadAt?: Date;
}

@Injectable()
export class MonthlyReportService {
  private readonly logger = new Logger(MonthlyReportService.name);

  constructor(
    @Optional() private readonly repo?: MonthlyReportRepository,
    @Optional() private readonly feedbackRepo?: LessonFeedbackRepository,
  ) {}

  /**
   * 月报自动生成（cron 每月 1 号 00:30 调用）
   *
   * @param studentId 学员
   * @param teacherId 主讲老师（同一月内可能多个老师 → 各自生成一份）
   * @param month 月份（YYYY-MM-01）
   * @param feedbacksInMonth 该 student×teacher 当月所有反馈
   */
  generate(input: {
    id: string;
    studentId: string;
    teacherId: string;
    month: Date;
    feedbacksInMonth: ReadonlyArray<LessonFeedback>;
  }): MonthlyReport {
    if (!input.id || input.id.length !== 32) {
      throw new BadRequestException('monthly_report id must be 32-char ULID');
    }
    if (!input.studentId || input.studentId.length !== 32) {
      throw new BadRequestException('studentId must be 32-char ULID');
    }
    if (!input.teacherId || input.teacherId.length !== 32) {
      throw new BadRequestException('teacherId must be 32-char ULID');
    }

    // 出勤汇总
    const attendance: AttendanceSummary = {
      total: input.feedbacksInMonth.length,
      '出勤': 0,
      '迟到': 0,
      '缺席': 0,
      '请假': 0,
    };
    for (const f of input.feedbacksInMonth) {
      attendance[f.attendanceStatus] += 1;
    }

    // 表现趋势（按 submittedAt 排序）
    const trend: PerformanceTrendPoint[] = [...input.feedbacksInMonth]
      .sort((a, b) => a.submittedAt.getTime() - b.submittedAt.getTime())
      .map((f) => ({
        date: f.submittedAt.toISOString().slice(0, 10),
        performance: f.classroomPerformance,
      }));

    // 知识点汇总（去重 by name + 多次取最近 mastery）
    const knowledgeMap = new Map<
      string,
      { mastery: ClassroomPerformance; lessonCount: number; lastDate: Date }
    >();
    for (const f of input.feedbacksInMonth) {
      const points = f.knowledgePoints ?? [];
      for (const p of points) {
        const existing = knowledgeMap.get(p.name);
        if (!existing || f.submittedAt.getTime() > existing.lastDate.getTime()) {
          knowledgeMap.set(p.name, {
            mastery: p.mastery,
            lessonCount: (existing?.lessonCount ?? 0) + 1,
            lastDate: f.submittedAt,
          });
        } else {
          existing.lessonCount += 1;
        }
      }
    }
    const knowledgeSummary: KnowledgeSummaryItem[] = Array.from(knowledgeMap.entries()).map(
      ([name, v]) => ({
        name,
        mastery: v.mastery,
        lessonCount: v.lessonCount,
      }),
    );

    this.logger.log(
      `[BE-V9-3] generateMonthlyReport id=${input.id} student=${input.studentId} ` +
        `teacher=${input.teacherId} month=${input.month.toISOString().slice(0, 7)} ` +
        `feedbacks=${input.feedbacksInMonth.length} attendance=${JSON.stringify(attendance)}`,
    );

    return {
      id: input.id,
      studentId: input.studentId,
      teacherId: input.teacherId,
      month: input.month,
      attendanceSummary: attendance,
      performanceTrend: trend,
      knowledgeSummary,
      status: 'auto_generated',
      generatedAt: new Date(),
    };
  }

  /**
   * 老师补寄语 + 续报建议 + finalize（家长在订阅活跃时可见）
   *
   * @throws BadRequestException 状态非 auto_generated
   */
  finalize(
    report: MonthlyReport,
    input: { teacherBlessing: string; renewalSuggestion: string },
    now: Date = new Date(),
  ): MonthlyReport {
    if (report.status !== 'auto_generated') {
      throw new BadRequestException(
        `only auto_generated can be finalized; got ${report.status}`,
      );
    }
    if (!input.teacherBlessing || input.teacherBlessing.trim().length === 0) {
      throw new BadRequestException('teacherBlessing required');
    }
    if (!input.renewalSuggestion || input.renewalSuggestion.trim().length === 0) {
      throw new BadRequestException('renewalSuggestion required');
    }
    return {
      ...report,
      teacherBlessing: input.teacherBlessing,
      renewalSuggestion: input.renewalSuggestion,
      status: 'teacher_finalized',
      finalizedAt: now,
    };
  }

  /**
   * 家长打"已读"
   */
  markParentRead(report: MonthlyReport, now: Date = new Date()): MonthlyReport {
    if (report.parentReadAt !== undefined) {
      return report; // 幂等
    }
    return { ...report, parentReadAt: now };
  }

  // ============= 真存盘版 =============

  /**
   * 自动生成月报（从 PG 拉本月反馈，UPSERT 月报）
   */
  async generateInDb(
    input: { id: string; studentId: string; teacherId: string; month: Date },
    tenantSchema: string,
  ): Promise<MonthlyReport> {
    if (!this.repo || !this.feedbackRepo) {
      throw new BadRequestException('MonthlyReportRepository or LessonFeedbackRepository not available');
    }
    const monthStart = new Date(input.month.getFullYear(), input.month.getMonth(), 1);
    const monthEnd = new Date(input.month.getFullYear(), input.month.getMonth() + 1, 1);
    const feedbacks = await this.feedbackRepo.listByStudentTeacherInRange(
      tenantSchema,
      input.studentId,
      input.teacherId,
      monthStart,
      monthEnd,
    );
    const memReport = this.generate({ ...input, month: monthStart, feedbacksInMonth: feedbacks });
    return this.repo.insert(tenantSchema, memReport);
  }

  async finalizeInDb(
    id: string,
    teacherBlessing: string,
    renewalSuggestion: string,
    tenantSchema: string,
  ): Promise<MonthlyReport> {
    if (!this.repo) throw new BadRequestException('MonthlyReportRepository not available');
    if (!teacherBlessing || teacherBlessing.trim().length === 0) {
      throw new BadRequestException('teacherBlessing required');
    }
    if (!renewalSuggestion || renewalSuggestion.trim().length === 0) {
      throw new BadRequestException('renewalSuggestion required');
    }
    return this.repo.finalize(tenantSchema, id, teacherBlessing, renewalSuggestion);
  }

  async findInDb(id: string, tenantSchema: string): Promise<MonthlyReport> {
    if (!this.repo) throw new BadRequestException('MonthlyReportRepository not available');
    const r = await this.repo.findById(tenantSchema, id);
    if (!r) throw new NotFoundException(`report ${id} not found`);
    return r;
  }

  async listByStudentInDb(
    studentId: string,
    tenantSchema: string,
  ): Promise<MonthlyReport[]> {
    if (!this.repo) throw new BadRequestException('MonthlyReportRepository not available');
    return this.repo.listByStudent(tenantSchema, studentId);
  }

  async listPendingFinalizeInDb(
    tenantSchema: string,
    teacherId?: string,
  ): Promise<MonthlyReport[]> {
    if (!this.repo) throw new BadRequestException('MonthlyReportRepository not available');
    return this.repo.listPendingFinalize(tenantSchema, teacherId);
  }

  async markParentReadInDb(id: string, tenantSchema: string): Promise<MonthlyReport> {
    if (!this.repo) throw new BadRequestException('MonthlyReportRepository not available');
    return this.repo.markParentRead(tenantSchema, id);
  }
}
