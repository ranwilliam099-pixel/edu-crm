import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PgPoolService } from './pg-pool.service';
import { TenantProvisionService } from './tenant-provision.service';

// ===== V7 教师档案 =====
import { TeacherRepository } from './teacher.repository';
import { TeacherShowcaseRepository } from './teacher-showcase.repository';
import { TeacherShowcaseMetaRepository } from './teacher-showcase-meta.repository';
import { TeacherShowcaseController } from './teacher-showcase.controller';
import { LeaveRepository } from './leave.repository';
import { LeaveController } from './leave.controller';

// ===== V8/V8.1 排课 =====
import { ScheduleRepository } from './schedule.repository';

// ===== V9 反馈 / 月报 / 课消 =====
import { LessonFeedbackRepository } from './lesson-feedback.repository';
import { MonthlyReportRepository } from './monthly-report.repository';
import { CourseConsumptionRepository } from './course-consumption.repository';

// ===== V10 家长 + 9.9 订阅 =====
import { ParentRepository } from './parent.repository';
import { ParentSubscriptionRepository } from './parent-subscription.repository';

// ===== V12 课时包 =====
import { CoursePackageRepository } from './course-package.repository';

// ===== V13 作业 =====
import { HomeworkRepository } from './homework.repository';

// ===== V14 测评 =====
import { AssessmentRepository } from './assessment.repository';

// ===== V15 学情档案 =====
import { LearningProfileRepository } from './learning-profile.repository';

// ===== V17 推荐（业务卡墙）+ V22 推荐机制（家长推家长）=====
import { RecommendationRepository } from './recommendation.repository';
import { RecommendationController } from './recommendation.controller';
import { ReferralRepository } from './referral.repository';
import { ReferralController } from './referral.controller';

// ===== V19 Boss 工作台 + 校区 + 订阅升级 =====
import { CampusRepository } from './campus.repository';
import { SubscriptionRepository } from './subscription.repository';
import { DashboardRepository } from './dashboard.repository';
import { BossController } from './boss.controller';
import { DashboardController } from './dashboard.controller';

// ===== V23 C 端 校区赠送 slot（FCFS）=====
import { CampusFreeSlotRepository } from './campus-free-slot.repository';
import { CampusFreeSlotController } from './campus-free-slot.controller';

// ===== V20 促销折扣体系（PLAN_META 严格线性 + reserve/commit/release）=====
import { PromotionRepository } from './promotion.repository';
import { PromotionAuditRepository } from './promotion-audit.repository';
import { PromotionQuotaService } from './promotion-quota.service';
import { PromotionEligibilityService } from './promotion-eligibility.service';
import { AdminPromotionController } from './admin-promotion.controller';
import { PromotionRedeemController } from './promotion-redeem.controller';

// ===== V25 销售客户 + 签约（业绩数据源头）=====
import { CustomerRepository } from './customer.repository';
import { CustomerController } from './customer.controller';
import { ContractRepository } from './contract.repository';
import { ContractController } from './contract.controller';

// ===== V27 员工离职 + 数据交接 =====
import { UserRepository } from './user.repository';
import { UserController } from './user.controller';

// ===== V28 学生归属（销售 / 主带老师）+ 单条转移 =====
import { StudentRepository } from './student.repository';
import { StudentController } from './student.controller';

// ===== V29 R6 课程产品库（校长/老板预设标准产品）=====
import { CourseProductRepository } from './course-product.repository';
import { CourseProductController } from './course-product.controller';

// ===== 跨版本 =====
import { StudentImportRepository } from './student-import.repository';
import { StudentImportController } from './student-import.controller';
import { OnboardingController, OnboardingDbController } from './onboarding.controller';
import { UploadController } from './upload.controller';

// ===== Sprint X.2 (2026-05-17) — staff 端家长账户管理（SSOT §12.5）=====
//   POST /api/db/parents + PATCH /api/db/parent-bindings/:id
//   AuthModule 已 @Global，PhoneLookupService 自动可注入
import { ParentBindingController } from './parent-binding.controller';

// ===== P4-Y (2026-05-20) — 老师评分明细表 + C 端家长评老师 =====
//   POST /api/db/teacher-ratings（家长评 5 星 + 文本 + tags）
//   ParentSelfGuard 守 jwt.parentId === body.parentId
//   ParentRepository / AuditLogRepository / SecurityService（@Global）自动注入
import { TeacherRatingRepository } from './teacher-rating.repository';
import { TeacherRatingController } from './teacher-rating.controller';

// ===== P4-X (2026-05-20) — admin/boss home KPI Level 2 下钻聚合（SSOT §3.1/§6）=====
//   GET /api/db/kpi/{signed,renewal,consumption,student-activity}
//   全 @Roles('admin','boss') + boss 强制 callerCampusId=jwt.campusId（A04 防御）
import { KpiController } from './kpi.controller';
import { KpiService } from './kpi.service';

// ===== V33 审计日志（生产架构 P0 第 1 项）=====
import { AuditLogRepository } from './audit-log.repository';

// ===== V34 字段加密（生产架构 P0 第 2 项）=====
// FieldEncryptor 通过 useFactory 注入，构造时读 process.env.ENCRYPTION_KEY
// 测试环境由 jest.setup.ts 注入 TEST_ENCRYPTION_KEY；生产由 .env 注入真实 key
import { FieldEncryptor } from '../../common/crypto/field-encryptor';

// ===== V40 phone_hash（A02-3 parent.phone 等值查询）=====
// HmacHasher 与 FieldEncryptor 同模式：useFactory + 构造时读 process.env.HASH_KEY
// HASH_KEY 独立于 ENCRYPTION_KEY（密钥分离，泄露不互相牵连）
import { HmacHasher } from '../../common/crypto/hmac-hasher';

// ===== Sprint E.x F-08（2026-05-13）OnboardingController 接 server-side msgSecCheck =====
// F-08 round 2 (production validator P2 F-08-02) 2026-05-13:
//   SecurityModule 改 @Global() 后无需 db.module 显式 imports（防双 import 两套实例并发刷 token）
//   OnboardingController 注入 SecurityService 由 @Global 自动解析（同 RedisModule 模式）。
// SecurityModule 不需 import — 删除以下行（保留注释说明历史）：
// import { SecurityModule } from '../security/security.module';

/**
 * DbModule — 全局持久化基础设施层
 *
 * 设计意图（@Global）：
 *   - 这是 schema-per-tenant 架构的基础层，所有业务模块统一通过此 module 访问 PG
 *   - PgPoolService + TenantProvisionService 是真正的 infrastructure，必须全局可用
 *   - 24 个 Repository 集中在此，避免业务模块持有自己的 ORM 连接（违反 Single Source of Truth）
 *
 * 反向依赖说明：
 *   db/*.repository.ts 反向 import 业务 module 的 type（Schedule / Teacher / Parent
 *   等）— 这是**有意的**：业务 type 应该由业务模块定义，repository 只是持久化适配器
 *   即「db 依赖业务 type」是合理的单向流：repository ← types ← service
 *   不是循环依赖：业务 service 通过 @Global() 注入 repository，不直接 import repository 文件
 *
 * 长期技术债评估（2026-05-05 审计）：
 *
 *   1. 拆分到业务 module（按领域聚合）— **不推荐当前实施**
 *      理由：
 *      a) 当前 @Global 单一 module 完美工作，pm2/build/test 全绿
 *      b) 拆分后需要每个业务 module 单独 import DbModule 子集，跨模块依赖图变复杂
 *      c) 重构成本 1 人日，无功能/性能收益，纯结构优化
 *      建议：长期演化时若单 module 超过 30 个 repository 再拆
 *
 *   2. 提取共享 type 到 src/shared/types/ — **已部分实施**
 *      已抽：JwtPayload / AuthenticatedRequest / PromotionTier / AuditCtx
 *      未抽：业务模块自己持有的 type（Schedule / Teacher / Parent）— 约定就近放置
 *      建议：如未来类型在 ≥3 个模块共享再考虑提取
 *
 *   3. 拆 V20 计费层为独立 BillingModule — **不推荐**
 *      理由：promotion/subscription/audit/quota 当前都属于 SaaS 平台层，
 *      与租户业务 repository 自然不同；@Global 已隔离访问权限通过 controller
 *      （admin-promotion vs boss-subscription）
 *      建议：保持 db.module 内分组注释，version 区段清晰即可
 *
 * 见审计报告 2026-05-05 P1 决策。
 */
@Global()
@Module({
  imports: [
    // F-08 round 2: SecurityModule 改 @Global() 后无需此处显式 imports
    // OnboardingController 注入 SecurityService 由 @Global 自动解析
    //
    // T9-EPIC(2026-05-16) §11 NEW：OnboardingController.provisionTenant 响应签 access_token
    //   admin user 创建后立刻签 JWT 让前端跳 plan-select（需 token 才能调 start-trial）
    //   JwtModule 不是 @Global → DbModule 显式 registerAsync（与 auth.module.ts 同 secret）
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET') ?? '__CHANGE_ME_IN_PROD__',
        signOptions: {
          expiresIn: `${config.get<number>('JWT_TTL_SEC', 86400)}s`,
        },
      }),
    }),
  ],
  controllers: [
    OnboardingController,
    // T9-EPIC(2026-05-16) §6.2 — POST /api/db/onboarding/start-trial
    OnboardingDbController,
    TeacherShowcaseController,
    LeaveController,
    RecommendationController,
    StudentImportController,
    BossController,
    DashboardController,
    AdminPromotionController,
    PromotionRedeemController,
    ReferralController,
    CampusFreeSlotController,
    UploadController,
    CustomerController,
    ContractController,
    UserController,
    StudentController,
    CourseProductController,
    // Sprint X.2 (2026-05-17) — staff 端家长账户管理 controller
    ParentBindingController,
    // P4-X (2026-05-20) — admin/boss KPI Level 2 下钻
    KpiController,
    // P4-Y (2026-05-20) — C 端家长评老师
    TeacherRatingController,
  ],
  providers: [
    // 基础设施
    PgPoolService,
    TenantProvisionService,
    // 业务 Repository 按 V 版本分组
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
    TeacherShowcaseMetaRepository,
    LeaveRepository,
    RecommendationRepository,
    StudentImportRepository,
    CampusRepository,
    SubscriptionRepository,
    DashboardRepository,
    // V20 计费层
    PromotionRepository,
    PromotionAuditRepository,
    PromotionQuotaService,
    PromotionEligibilityService,
    ReferralRepository,
    CampusFreeSlotRepository,
    CustomerRepository,
    ContractRepository,
    UserRepository,
    StudentRepository,
    CourseProductRepository,
    // V33 审计日志
    AuditLogRepository,
    // V34 字段加密（A02-1 teacher / A02-2 customer / A02-3 parent.phone_encrypted 共享）
    {
      provide: FieldEncryptor,
      useFactory: () => new FieldEncryptor(),
    },
    // V40 phone_hash（A02-3 parent.phone 等值查询；独立 HASH_KEY）
    {
      provide: HmacHasher,
      useFactory: () => new HmacHasher(),
    },
    // P4-X (2026-05-20) — KPI 聚合服务
    KpiService,
    // P4-Y (2026-05-20) — 老师评分明细 repository
    TeacherRatingRepository,
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
    TeacherShowcaseMetaRepository,
    LeaveRepository,
    RecommendationRepository,
    StudentImportRepository,
    CampusRepository,
    SubscriptionRepository,
    DashboardRepository,
    PromotionRepository,
    PromotionAuditRepository,
    PromotionQuotaService,
    PromotionEligibilityService,
    ReferralRepository,
    CampusFreeSlotRepository,
    CustomerRepository,
    ContractRepository,
    UserRepository,
    StudentRepository,
    CourseProductRepository,
    AuditLogRepository,
    FieldEncryptor,
    HmacHasher,
    // P4-X (2026-05-20) — KPI 聚合服务
    KpiService,
    // P4-Y (2026-05-20) — 老师评分明细 repository
    TeacherRatingRepository,
  ],
})
export class DbModule {}
