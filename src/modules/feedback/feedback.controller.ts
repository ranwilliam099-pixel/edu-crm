import {
  Body,
  Controller,
  Param,
  Post,
  Patch,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  LessonFeedbackService,
  LessonFeedback,
  AttendanceForFeedback,
  ClassroomPerformance,
  HomeworkDifficulty,
} from './lesson-feedback.service';
import {
  CourseConsumptionService,
  CourseConsumption,
} from './course-consumption.service';
import {
  MonthlyReportService,
  MonthlyReport,
} from './monthly-report.service';

/**
 * FeedbackController — V9 教学反馈 + 课消 + 月报 HTTP 暴露 BE-V9-1/2/3
 *
 * 路由前缀（多个）：
 *   - /api/lesson-feedbacks
 *   - /api/course-consumptions
 *   - /api/monthly-reports
 *
 * USER-AUTH(2026-05-02): PD §4 + P6 24h 必填 + P7 月报自动
 */
@Controller()
export class FeedbackController {
  constructor(
    private readonly feedback: LessonFeedbackService,
    private readonly consumption: CourseConsumptionService,
    private readonly report: MonthlyReportService,
  ) {}

  // ==================== LessonFeedback ====================

  /**
   * POST /api/lesson-feedbacks — 老师提交反馈（24h 内）
   */
  @Post('lesson-feedbacks')
  @HttpCode(HttpStatus.CREATED)
  submitFeedback(
    @Body()
    body: {
      id: string;
      scheduleId: string;
      studentId: string;
      teacherId: string;
      attendanceStatus: AttendanceForFeedback;
      classroomPerformance: ClassroomPerformance;
      knowledgePoints?: Array<{ name: string; mastery: ClassroomPerformance }>;
      homework?: string;
      homeworkAttachments?: Array<{ url: string; type: string; filename: string }>;
      teacherNote?: string;
      teacherInternalNote?: string;
    },
  ): LessonFeedback {
    return this.feedback.submit(body);
  }

  /**
   * PATCH /api/lesson-feedbacks/:id — 24h 内修改反馈
   */
  @Patch('lesson-feedbacks/:id')
  @HttpCode(HttpStatus.OK)
  updateFeedback(
    @Param('id') _id: string,
    @Body()
    body: {
      feedback: LessonFeedback;
      patch: Partial<{
        attendanceStatus: AttendanceForFeedback;
        classroomPerformance: ClassroomPerformance;
        knowledgePoints: Array<{ name: string; mastery: ClassroomPerformance }>;
        homework: string;
        teacherNote: string;
        teacherInternalNote: string;
      }>;
      nowMs?: number;
    },
  ): LessonFeedback {
    return this.feedback.update(
      this.deserializeFeedback(body.feedback),
      body.patch,
      body.nowMs ? new Date(body.nowMs) : new Date(),
    );
  }

  /**
   * POST /api/lesson-feedbacks/:id/parent-read
   */
  @Post('lesson-feedbacks/:id/parent-read')
  @HttpCode(HttpStatus.OK)
  markParentReadFeedback(
    @Param('id') _id: string,
    @Body() body: { feedback: LessonFeedback; nowMs?: number },
  ): LessonFeedback {
    return this.feedback.markParentRead(
      this.deserializeFeedback(body.feedback),
      body.nowMs ? new Date(body.nowMs) : new Date(),
    );
  }

  // ==================== CourseConsumption ====================

  /**
   * POST /api/course-consumptions — schedule.complete 时为每个学员创建一条
   */
  @Post('course-consumptions')
  @HttpCode(HttpStatus.CREATED)
  createConsumption(
    @Body()
    body: {
      id: string;
      scheduleId: string;
      studentId: string;
      teacherId: string;
      scheduleEndAt: string;
      amountYuan?: number;
    },
  ): CourseConsumption {
    return this.consumption.createConsumption({
      ...body,
      scheduleEndAt: new Date(body.scheduleEndAt),
    });
  }

  /**
   * POST /api/course-consumptions/:id/confirm — 反馈提交时 confirm
   */
  @Post('course-consumptions/:id/confirm')
  @HttpCode(HttpStatus.OK)
  confirmConsumption(
    @Param('id') _id: string,
    @Body() body: { consumption: CourseConsumption; feedbackId: string; nowMs?: number },
  ): CourseConsumption {
    return this.consumption.confirmByFeedback(
      this.deserializeConsumption(body.consumption),
      body.feedbackId,
      body.nowMs ? new Date(body.nowMs) : new Date(),
    );
  }

  /**
   * POST /api/course-consumptions/scan-and-lock — cron 每 10min 扫超期 → locked
   */
  @Post('course-consumptions/scan-and-lock')
  @HttpCode(HttpStatus.OK)
  scanAndLock(
    @Body() body: { consumptions: CourseConsumption[]; nowMs?: number },
  ): CourseConsumption[] {
    return this.consumption.scanAndLock(
      body.consumptions.map((c) => this.deserializeConsumption(c)),
      body.nowMs ? new Date(body.nowMs) : new Date(),
    );
  }

  /**
   * POST /api/course-consumptions/:id/unlock-late — 老师超期补填恢复
   */
  @Post('course-consumptions/:id/unlock-late')
  @HttpCode(HttpStatus.OK)
  unlockLate(
    @Param('id') _id: string,
    @Body() body: { consumption: CourseConsumption; feedbackId: string; nowMs?: number },
  ): CourseConsumption {
    return this.consumption.unlockByLateFeedback(
      this.deserializeConsumption(body.consumption),
      body.feedbackId,
      body.nowMs ? new Date(body.nowMs) : new Date(),
    );
  }

  /**
   * POST /api/teachers/:teacherId/payroll — 老师工资统计
   */
  @Post('teachers/:teacherId/payroll')
  @HttpCode(HttpStatus.OK)
  teacherPayroll(
    @Param('teacherId') teacherId: string,
    @Body() body: { consumptions: CourseConsumption[] },
  ): { teacherId: string; payrollYuan: number } {
    return {
      teacherId,
      payrollYuan: this.consumption.sumPayrollForTeacher(
        teacherId,
        body.consumptions.map((c) => this.deserializeConsumption(c)),
      ),
    };
  }

  // ==================== MonthlyReport ====================

  /**
   * POST /api/monthly-reports/generate — cron 每月 1 号 00:30 调用
   */
  @Post('monthly-reports/generate')
  @HttpCode(HttpStatus.CREATED)
  generateReport(
    @Body()
    body: {
      id: string;
      studentId: string;
      teacherId: string;
      month: string;
      feedbacksInMonth: LessonFeedback[];
    },
  ): MonthlyReport {
    return this.report.generate({
      id: body.id,
      studentId: body.studentId,
      teacherId: body.teacherId,
      month: new Date(body.month),
      feedbacksInMonth: body.feedbacksInMonth.map((f) => this.deserializeFeedback(f)),
    });
  }

  /**
   * POST /api/monthly-reports/:id/finalize — 老师补寄语 + 续报建议
   */
  @Post('monthly-reports/:id/finalize')
  @HttpCode(HttpStatus.OK)
  finalizeReport(
    @Param('id') _id: string,
    @Body()
    body: {
      report: MonthlyReport;
      teacherBlessing: string;
      renewalSuggestion: string;
      nowMs?: number;
    },
  ): MonthlyReport {
    return this.report.finalize(
      this.deserializeReport(body.report),
      { teacherBlessing: body.teacherBlessing, renewalSuggestion: body.renewalSuggestion },
      body.nowMs ? new Date(body.nowMs) : new Date(),
    );
  }

  /**
   * POST /api/monthly-reports/:id/parent-read
   */
  @Post('monthly-reports/:id/parent-read')
  @HttpCode(HttpStatus.OK)
  markParentReadReport(
    @Param('id') _id: string,
    @Body() body: { report: MonthlyReport; nowMs?: number },
  ): MonthlyReport {
    return this.report.markParentRead(
      this.deserializeReport(body.report),
      body.nowMs ? new Date(body.nowMs) : new Date(),
    );
  }

  // ==================== /db 真存盘版 ====================

  // ----- LessonFeedback -----

  @Post('db/lesson-feedbacks')
  @HttpCode(HttpStatus.CREATED)
  async submitFeedbackInDb(
    @Body()
    body: {
      id: string;
      scheduleId: string;
      studentId: string;
      teacherId: string;
      attendanceStatus: AttendanceForFeedback;
      classroomPerformance: ClassroomPerformance;
      knowledgePoints?: Array<{ name: string; mastery: ClassroomPerformance }>;
      homework?: string;
      homeworkAttachments?: Array<{ url: string; type: string; filename: string }>;
      teacherNote?: string;
      teacherInternalNote?: string;
      // V18 5 fields
      knowledgeMatrix?: Array<{ name: string; mastery: string }>;
      dimRatings?: { focus?: number; engage?: number; think?: number; homework?: number };
      homeworkDeadlineMs?: number;
      homeworkDifficulty?: HomeworkDifficulty;
      nextPreview?: string;
      tenantSchema: string;
    },
  ): Promise<LessonFeedback> {
    const { tenantSchema, homeworkDeadlineMs, ...rest } = body;
    return this.feedback.submitInDb(
      {
        ...rest,
        homeworkDeadline: homeworkDeadlineMs ? new Date(homeworkDeadlineMs) : undefined,
      },
      tenantSchema,
    );
  }

  @Post('db/lesson-feedbacks/:id/find')
  @HttpCode(HttpStatus.OK)
  async findFeedbackInDb(
    @Param('id') id: string,
    @Body() body: { tenantSchema: string },
  ): Promise<LessonFeedback> {
    return this.feedback.findInDb(id, body.tenantSchema);
  }

  @Post('db/students/:studentId/feedbacks')
  @HttpCode(HttpStatus.OK)
  async listFeedbacksByStudentInDb(
    @Param('studentId') studentId: string,
    @Body() body: { tenantSchema: string; limit?: number; offset?: number },
  ): Promise<LessonFeedback[]> {
    return this.feedback.listByStudentInDb(studentId, body.tenantSchema, {
      limit: body.limit,
      offset: body.offset,
    });
  }

  @Post('db/lesson-feedbacks/:id/update')
  @HttpCode(HttpStatus.OK)
  async updateFeedbackInDb(
    @Param('id') id: string,
    @Body()
    body: {
      patch: {
        attendanceStatus?: AttendanceForFeedback;
        classroomPerformance?: ClassroomPerformance;
        knowledgePoints?: Array<{ name: string; mastery: ClassroomPerformance }>;
        homework?: string;
        teacherNote?: string;
        teacherInternalNote?: string;
        // V18 5 fields
        knowledgeMatrix?: Array<{ name: string; mastery: string }>;
        dimRatings?: { focus?: number; engage?: number; think?: number; homework?: number };
        homeworkDeadlineMs?: number;
        homeworkDifficulty?: HomeworkDifficulty;
        nextPreview?: string;
      };
      tenantSchema: string;
      nowMs?: number;
    },
  ): Promise<LessonFeedback> {
    const { homeworkDeadlineMs, ...patchRest } = body.patch;
    return this.feedback.updateInDb(
      id,
      {
        ...patchRest,
        homeworkDeadline: homeworkDeadlineMs ? new Date(homeworkDeadlineMs) : undefined,
      },
      body.tenantSchema,
      body.nowMs ? new Date(body.nowMs) : new Date(),
    );
  }

  @Post('db/lesson-feedbacks/:id/parent-read')
  @HttpCode(HttpStatus.OK)
  async markParentReadFeedbackInDb(
    @Param('id') id: string,
    @Body() body: { tenantSchema: string },
  ): Promise<LessonFeedback> {
    return this.feedback.markParentReadInDb(id, body.tenantSchema);
  }

  // ----- CourseConsumption -----

  @Post('db/course-consumptions')
  @HttpCode(HttpStatus.CREATED)
  async createConsumptionInDb(
    @Body()
    body: {
      id: string;
      scheduleId: string;
      studentId: string;
      teacherId: string;
      scheduleEndAtMs: number;
      amountYuan?: number;
      tenantSchema: string;
    },
  ): Promise<CourseConsumption> {
    const { tenantSchema, scheduleEndAtMs, ...rest } = body;
    return this.consumption.createConsumptionInDb(
      { ...rest, scheduleEndAt: new Date(scheduleEndAtMs) },
      tenantSchema,
    );
  }

  @Post('db/course-consumptions/:id/confirm')
  @HttpCode(HttpStatus.OK)
  async confirmConsumptionInDb(
    @Param('id') id: string,
    @Body() body: { feedbackId: string; tenantSchema: string },
  ): Promise<CourseConsumption> {
    return this.consumption.confirmByFeedbackInDb(id, body.feedbackId, body.tenantSchema);
  }

  @Post('db/course-consumptions/scan-and-lock')
  @HttpCode(HttpStatus.OK)
  async scanAndLockInDb(
    @Body() body: { tenantSchema: string; nowMs?: number },
  ): Promise<{ locked: number; ids: string[] }> {
    return this.consumption.scanAndLockInDb(
      body.tenantSchema,
      body.nowMs ? new Date(body.nowMs) : new Date(),
    );
  }

  @Post('db/course-consumptions/:id/unlock-late')
  @HttpCode(HttpStatus.OK)
  async unlockLateInDb(
    @Param('id') id: string,
    @Body() body: { feedbackId: string; tenantSchema: string },
  ): Promise<CourseConsumption> {
    return this.consumption.unlockByLateFeedbackInDb(id, body.feedbackId, body.tenantSchema);
  }

  @Post('db/course-consumptions/:id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelConsumptionInDb(
    @Param('id') id: string,
    @Body() body: { tenantSchema: string },
  ): Promise<CourseConsumption> {
    return this.consumption.cancelInDb(id, body.tenantSchema);
  }

  @Post('db/teachers/:teacherId/payroll')
  @HttpCode(HttpStatus.OK)
  async teacherPayrollInDb(
    @Param('teacherId') teacherId: string,
    @Body() body: { rangeStartMs: number; rangeEndMs: number; tenantSchema: string },
  ): Promise<{ teacherId: string; payrollYuan: number; count: number }> {
    return this.consumption.sumPayrollForTeacherInDb(
      teacherId,
      new Date(body.rangeStartMs),
      new Date(body.rangeEndMs),
      body.tenantSchema,
    );
  }

  // ----- MonthlyReport -----

  @Post('db/monthly-reports/generate')
  @HttpCode(HttpStatus.CREATED)
  async generateReportInDb(
    @Body()
    body: {
      id: string;
      studentId: string;
      teacherId: string;
      monthMs: number;
      tenantSchema: string;
    },
  ): Promise<MonthlyReport> {
    const { tenantSchema, monthMs, ...rest } = body;
    return this.report.generateInDb({ ...rest, month: new Date(monthMs) }, tenantSchema);
  }

  @Post('db/monthly-reports/:id/finalize')
  @HttpCode(HttpStatus.OK)
  async finalizeReportInDb(
    @Param('id') id: string,
    @Body()
    body: { teacherBlessing: string; renewalSuggestion: string; tenantSchema: string },
  ): Promise<MonthlyReport> {
    return this.report.finalizeInDb(
      id,
      body.teacherBlessing,
      body.renewalSuggestion,
      body.tenantSchema,
    );
  }

  @Post('db/monthly-reports/:id/find')
  @HttpCode(HttpStatus.OK)
  async findReportInDb(
    @Param('id') id: string,
    @Body() body: { tenantSchema: string },
  ): Promise<MonthlyReport> {
    return this.report.findInDb(id, body.tenantSchema);
  }

  @Post('db/students/:studentId/monthly-reports')
  @HttpCode(HttpStatus.OK)
  async listReportsByStudentInDb(
    @Param('studentId') studentId: string,
    @Body() body: { tenantSchema: string },
  ): Promise<MonthlyReport[]> {
    return this.report.listByStudentInDb(studentId, body.tenantSchema);
  }

  @Post('db/monthly-reports/pending-finalize')
  @HttpCode(HttpStatus.OK)
  async listPendingFinalizeInDb(
    @Body() body: { tenantSchema: string; teacherId?: string },
  ): Promise<MonthlyReport[]> {
    return this.report.listPendingFinalizeInDb(body.tenantSchema, body.teacherId);
  }

  @Post('db/monthly-reports/:id/parent-read')
  @HttpCode(HttpStatus.OK)
  async markParentReadReportInDb(
    @Param('id') id: string,
    @Body() body: { tenantSchema: string },
  ): Promise<MonthlyReport> {
    return this.report.markParentReadInDb(id, body.tenantSchema);
  }

  // -- helpers: JSON Date 反序列化 --

  private deserializeFeedback(f: LessonFeedback): LessonFeedback {
    return {
      ...f,
      submittedAt: new Date(f.submittedAt as unknown as string),
      updatedAt: new Date(f.updatedAt as unknown as string),
      parentReadAt: f.parentReadAt
        ? new Date(f.parentReadAt as unknown as string)
        : undefined,
    };
  }

  private deserializeConsumption(c: CourseConsumption): CourseConsumption {
    return {
      ...c,
      feedbackDueAt: new Date(c.feedbackDueAt as unknown as string),
      confirmedAt: c.confirmedAt ? new Date(c.confirmedAt as unknown as string) : undefined,
      lockedAt: c.lockedAt ? new Date(c.lockedAt as unknown as string) : undefined,
      createdAt: new Date(c.createdAt as unknown as string),
    };
  }

  private deserializeReport(r: MonthlyReport): MonthlyReport {
    return {
      ...r,
      month: new Date(r.month as unknown as string),
      generatedAt: new Date(r.generatedAt as unknown as string),
      finalizedAt: r.finalizedAt ? new Date(r.finalizedAt as unknown as string) : undefined,
      parentReadAt: r.parentReadAt
        ? new Date(r.parentReadAt as unknown as string)
        : undefined,
    };
  }
}
