import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
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

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
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
  ],
})
export class AppModule {}
