import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { TenantModule } from './modules/tenant/tenant.module';
import { UserModule } from './modules/user/user.module';
import { LifecycleModule } from './modules/lifecycle/lifecycle.module';
import { ReverseOrderModule } from './modules/reverse-order/reverse-order.module';

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
  ],
})
export class AppModule {}
