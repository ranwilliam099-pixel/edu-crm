import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { TenantModule } from './modules/tenant/tenant.module';
import { UserModule } from './modules/user/user.module';
import { LifecycleModule } from './modules/lifecycle/lifecycle.module';
import { ReverseOrderModule } from './modules/reverse-order/reverse-order.module';
import { AdminModule } from './modules/admin/admin.module';
import { FeatureFlagModule } from './modules/feature-flag/feature-flag.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    AuthModule,
    TenantModule,
    HealthModule,
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
  ],
})
export class AppModule {}
