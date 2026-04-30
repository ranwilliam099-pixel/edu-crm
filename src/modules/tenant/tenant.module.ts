import { Module } from '@nestjs/common';
import { TenantService } from './tenant.service';
import { CapacityService } from './capacity.service';
import { TenantLifecycleService } from './tenant-lifecycle.service';

/**
 * Tenant 模块（W1 BE-W1-2 + BE-W1-5）
 *
 * - TenantService：schema-per-tenant 初始化（BE-W1-2），由 checkout 模块（W2-T3 微信支付回调）注入
 * - CapacityService：A07 账号上限 + A08 校区上限守护（BE-W1-5），由 onboarding/admin 注入
 *
 * 不暴露 HTTP 路由 — 内部服务，由业务编排触发。
 */
@Module({
  // PM-AUTH-7(2026-04-30): TenantLifecycleService W3-1 Phase 2.1 — A10 状态机（条目 14 BE-W3-2）
  providers: [TenantService, CapacityService, TenantLifecycleService],
  exports: [TenantService, CapacityService, TenantLifecycleService],
})
export class TenantModule {}
