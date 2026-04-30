import { Module } from '@nestjs/common';
import { AdminTenantService } from './admin-tenant.service';
import { AdminTenantController } from './admin-tenant.controller';
import { AdminRefundController } from './admin-refund.controller';
import { TenantModule } from '../tenant/tenant.module';

/**
 * Admin 模块（W3-1 Phase 4 BE-W4-1）
 *
 * 来源：
 *   - 《全部人员-审核往来总台账.md》条目 14 §B Track CODE-4 BE-W4-1
 *   - AUTH-7 A11 §3.4 平台超管 API
 *
 * PM-AUTH-7(2026-04-30): 平台超管 API 骨架
 */
@Module({
  imports: [TenantModule],
  // PM-AUTH-7(2026-04-30): Controllers W3-1 Phase 4 BE-W4-1 HTTP 暴露 + RBAC 守护
  controllers: [AdminTenantController, AdminRefundController],
  providers: [AdminTenantService],
  exports: [AdminTenantService],
})
export class AdminModule {}
