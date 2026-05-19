import { Module } from '@nestjs/common';
import { TenantLifecycleService } from './tenant-lifecycle.service';

/**
 * Tenant 模块（W3-1 Phase 2.1 BE-W3-2）
 *
 * - TenantLifecycleService：A10 状态机（trial / active / suspended / archived 4 状态 + transition 校验）
 *   被 AdminTenantService 注入（admin-tenant.service.ts:86）
 *
 * T-DEADCODE-CLEANUP (2026-05-17): 删除 TenantService + CapacityService（3-agent 共识）
 *   - TenantService：0 production callers（注释说"checkout W2-T3 注入"但 checkout 0 注入）
 *   - CapacityService：0 production callers（注释说"onboarding/admin 注入"但实际 0 注入）
 *
 * 不暴露 HTTP 路由 — 内部服务，由 AdminTenantService 编排触发。
 */
@Module({
  providers: [TenantLifecycleService],
  exports: [TenantLifecycleService],
})
export class TenantModule {}
