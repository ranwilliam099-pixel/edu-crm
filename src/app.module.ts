import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from './common/logger/logger.module';
import { SentryModule } from './common/sentry/sentry.module';
import { AlertModule } from './common/alert/alert.module';
import { IdempotencyModule } from './common/idempotency/idempotency.module';
import { RedisModule } from './modules/redis/redis.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { TenantModule } from './modules/tenant/tenant.module';
import { CheckoutModule } from './modules/checkout/checkout.module';
import { UserModule } from './modules/user/user.module';
import { LifecycleModule } from './modules/lifecycle/lifecycle.module';
import { ReverseOrderModule } from './modules/reverse-order/reverse-order.module';
import { AdminModule } from './modules/admin/admin.module';
import { FeatureFlagModule } from './modules/feature-flag/feature-flag.module';
import { TeacherModule } from './modules/teacher/teacher.module';
import { ParentModule } from './modules/parent/parent.module';
import { ScheduleModule } from './modules/schedule/schedule.module';
import { FeedbackModule } from './modules/feedback/feedback.module';
import { CronModule } from './modules/cron/cron.module';
import { CourseBalanceModule } from './modules/course-balance/course-balance.module';
import { HomeworkModule } from './modules/homework/homework.module';
import { AssessmentModule } from './modules/assessment/assessment.module';
import { LearningProfileModule } from './modules/learning-profile/learning-profile.module';
import { DbModule } from './modules/db/db.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    // PROD-ARCH(2026-05-10) P0-6: Sentry 错误上报（必须先于其他模块，hook 全局异常）
    SentryModule,
    // PROD-ARCH(2026-05-10) P0-3: 生产级日志（pino + 链路追踪 + PII 脱敏）
    LoggerModule,
    // PROD-ARCH(2026-05-10) P0-4: Redis（cache / lock / queue / idempotency）
    RedisModule,
    // PROD-ARCH(2026-05-10) P0-5: idempotency-key 写操作幂等（依赖 Redis）
    IdempotencyModule,
    // PROD-ARCH(2026-05-10) P0-8: 钉钉/企微告警（依赖 Redis dedup）
    AlertModule,
    // USER-AUTH(2026-05-02): DbModule 真接 PG（pg.Pool + tenant schema worker + Repository）
    DbModule,
    AuthModule,
    TenantModule,
    HealthModule,
    // PM-AUTH-6(2026-04-30): CheckoutModule W2/W3 主链路 + 4 SKU 价格查询 + 订单创建
    CheckoutModule,
    // PM-AUTH-5(2026-04-30): UserModule W3-1 sales campus_scope 应用层填充骨架
    UserModule,
    // PM-AUTH-7(2026-04-30): LifecycleModule W3-1 Phase 2.3 — A10 调度器（条目 14 BE-W3-6）
    LifecycleModule,
    // PM-AUTH-7(2026-04-30): ReverseOrderModule W3-1 Phase 4 — A12 逆向单状态机（条目 14 BE-W5-1）
    ReverseOrderModule,
    // PM-AUTH-7(2026-04-30): AdminModule W3-1 Phase 4 — A11 §3.4 平台超管 API（条目 14 BE-W4-1）
    AdminModule,
    // PM-AUTH(2026-04-30): FeatureFlagModule W3-1 Phase 5.5 — 全局灰度开关（条目 14 CODE-5）
    FeatureFlagModule,
    // USER-AUTH(2026-05-02): TeacherModule V7 教师独立档案（条目 29 方向 B + 条目 31 #2 + 32 L1）
    TeacherModule,
    // USER-AUTH(2026-05-02): ParentModule V10 家长 + 9.9 订阅 + 7 天试用（条目 31 #3/#4 + 32 #10）
    ParentModule,
    // USER-AUTH(2026-05-02): ScheduleModule V8 排课核心 — 冲突硬阻塞 + RBAC（PD §3 + 条目 32 L2）
    ScheduleModule,
    // USER-AUTH(2026-05-02): FeedbackModule V9 教学反馈 + 月报 + 课消（PD §4 + P6/P7）
    FeedbackModule,
    // USER-AUTH(2026-05-02): CronModule 全局 cron 编排（接 V8.1/V9/V10 所有定时任务）
    CronModule,
    // USER-AUTH(2026-05-02): CourseBalanceModule V12 课时包 + 余额管理（教学链路 §1）
    CourseBalanceModule,
    // USER-AUTH(2026-05-02): HomeworkModule V13 作业管理（教学链路 §2）
    HomeworkModule,
    // USER-AUTH(2026-05-02): AssessmentModule V14 测评/考试（教学链路 §3）
    AssessmentModule,
    // USER-AUTH(2026-05-02): LearningProfileModule V15 学情累计档案（教学链路 §4）
    LearningProfileModule,
  ],
})
export class AppModule {}
