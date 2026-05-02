import { Module } from '@nestjs/common';
import { LessonFeedbackService } from './lesson-feedback.service';
import { CourseConsumptionService } from './course-consumption.service';
import { MonthlyReportService } from './monthly-report.service';

/**
 * Feedback 模块（V9 教学反馈 + 课消 + 月报）
 *
 * USER-AUTH(2026-05-02): 24h 反馈必填 + 月报自动生成 + 课消锁定老师工资
 */
@Module({
  providers: [LessonFeedbackService, CourseConsumptionService, MonthlyReportService],
  exports: [LessonFeedbackService, CourseConsumptionService, MonthlyReportService],
})
export class FeedbackModule {}
