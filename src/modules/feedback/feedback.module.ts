import { Module } from '@nestjs/common';
import { LessonFeedbackService } from './lesson-feedback.service';
import { CourseConsumptionService } from './course-consumption.service';
import { MonthlyReportService } from './monthly-report.service';
import { FeedbackController } from './feedback.controller';

/**
 * Feedback 模块（V9 教学反馈 + 课消 + 月报）
 *
 * USER-AUTH(2026-05-02): 24h 反馈必填 + 月报自动生成 + 课消锁定老师工资
 *
 * ⚠️ FeedbackController 还依赖 3 个 @Global 跨模块 provider（不在本 module providers，
 *    由全局模块隐式注入；生产 / e2e(imports AppModule) 安全，但 isolated module test 需自带）：
 *    - TeacherRepository / AuditLogRepository → @Global DbModule
 *    - ContentModerationService（#24 内容安全）→ @Global SecurityModule
 */
@Module({
  controllers: [FeedbackController],
  providers: [LessonFeedbackService, CourseConsumptionService, MonthlyReportService],
  exports: [LessonFeedbackService, CourseConsumptionService, MonthlyReportService],
})
export class FeedbackModule {}
