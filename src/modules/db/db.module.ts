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
import { TeacherShowcaseRepository } from './teacher-showcase.repository';
import { LeaveRepository } from './leave.repository';
import { RecommendationRepository } from './recommendation.repository';
import { StudentImportRepository } from './student-import.repository';
import { CampusRepository } from './campus.repository';
import { SubscriptionRepository } from './subscription.repository';
import { DashboardRepository } from './dashboard.repository';
import { OnboardingController } from './onboarding.controller';
import { TeacherShowcaseController } from './teacher-showcase.controller';
import { LeaveController } from './leave.controller';
import { RecommendationController } from './recommendation.controller';
import { StudentImportController } from './student-import.controller';
import { BossController } from './boss.controller';
import { DashboardController } from './dashboard.controller';

/**
 * DbModule — 全局 PG 接入 + 租户开通 + Repository 层
 *
 * @Global() 让所有 Repository 可在任意业务模块注入
 */
@Global()
@Module({
  controllers: [
    OnboardingController,
    TeacherShowcaseController,
    LeaveController,
    RecommendationController,
    StudentImportController,
    BossController,
    DashboardController,
  ],
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
    TeacherShowcaseRepository,
    LeaveRepository,
    RecommendationRepository,
    StudentImportRepository,
    CampusRepository,
    SubscriptionRepository,
    DashboardRepository,
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
    TeacherShowcaseRepository,
    LeaveRepository,
    RecommendationRepository,
    StudentImportRepository,
    CampusRepository,
    SubscriptionRepository,
    DashboardRepository,
  ],
})
export class DbModule {}
