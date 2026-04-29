import { Module } from '@nestjs/common';
import { TenantService } from './tenant.service';
import { CapacityService } from './capacity.service';

/**
 * Tenant 模块（W1 BE-W1-2 + BE-W1-5）
 *
 * - TenantService：schema-per-tenant 初始化（BE-W1-2），由 checkout 模块（W2-T3 微信支付回调）注入
 * - CapacityService：A07 账号上限 + A08 校区上限守护（BE-W1-5），由 onboarding/admin 注入
 *
 * 不暴露 HTTP 路由 — 内部服务，由业务编排触发。
 */
@Module({
  providers: [TenantService, CapacityService],
  exports: [TenantService, CapacityService],
})
export class TenantModule {}
