import { Global, Module } from '@nestjs/common';
import { PgPoolService } from './pg-pool.service';
import { TenantProvisionService } from './tenant-provision.service';
import { TeacherRepository } from './teacher.repository';
import { ScheduleRepository } from './schedule.repository';
import { ParentRepository } from './parent.repository';
import { ParentSubscriptionRepository } from './parent-subscription.repository';
import { LessonFeedbackRepository } from './lesson-feedback.repository';
import { MonthlyReportRepository } from './monthly-report.repository';
import { CourseConsumptionRepository } from './course-consumption.repository';
import { CoursePackageRepository } from './course-package.repository';
import { HomeworkRepository } from './homework.repository';
import { AssessmentRepository } from './assessment.repository';
import { LearningProfileRepository } from './learning-profile.repository';
import { OnboardingController } from './onboarding.controller';

/**
 * DbModule — 全局 PG 接入 + 租户开通 + Repository 层
 *
 * @Global() 让所有 Repository 可在任意业务模块注入
 */
@Global()
@Module({
  controllers: [OnboardingController],
  providers: [
    PgPoolService,
    TenantProvisionService,
    TeacherRepository,
    ScheduleRepository,
    ParentRepository,
    ParentSubscriptionRepository,
    LessonFeedbackRepository,
    MonthlyReportRepository,
    CourseConsumptionRepository,
    CoursePackageRepository,
    HomeworkRepository,
    AssessmentRepository,
    LearningProfileRepository,
  ],
  exports: [
    PgPoolService,
    TenantProvisionService,
    TeacherRepository,
    ScheduleRepository,
    ParentRepository,
    ParentSubscriptionRepository,
    LessonFeedbackRepository,
    MonthlyReportRepository,
    CourseConsumptionRepository,
    CoursePackageRepository,
    HomeworkRepository,
    AssessmentRepository,
    LearningProfileRepository,
  ],
})
export class DbModule {}
