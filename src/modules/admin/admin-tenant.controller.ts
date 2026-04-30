import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
  Param,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AdminTenantService } from './admin-tenant.service';
import { Roles } from '../../guards/rbac.decorator';
import { RbacGuard } from '../../guards/rbac.guard';
import { TenantLifecycleState } from '../tenant/tenant-lifecycle.service';

/**
 * AdminTenantController — W3-1 Phase 4 BE-W4-1 平台超管 API HTTP 暴露
 *
 * 来源：
 *   - 《全部人员-审核往来总台账.md》条目 14 §B Track CODE-4 BE-W4-1
 *   - AUTH-7 A11 §3.4 平台超管 API + RBAC
 *
 * PM-AUTH-7(2026-04-30): 平台超管 RBAC 守护
 *
 * 路由前缀：/api/admin/tenants
 * 全部端点要求 platform_admin 或 finance_admin 角色（按方法粒度细分）
 *
 * 严守边界：
 *   - 不真实连 DB；当前为占位实现，由调用方 mock data 测试
 *   - 真实 Repository 持久化由后续 W3 阶段拓展
 */
@Controller('admin/tenants')
@UseGuards(RbacGuard)
export class AdminTenantController {
  constructor(private readonly service: AdminTenantService) {}

  /**
   * GET /api/admin/tenants
   * 平台超管 + 财务超管 都可查列表
   *
   * 注：当前为骨架，实际查询逻辑待 Repository 落地
   */
  @Get()
  @Roles('platform_admin', 'finance_admin')
  list(
    @Query('state') state?: TenantLifecycleState,
    @Query('sku') sku?: string,
    @Query('minAccounts') minAccounts?: string,
  ): { items: any[]; filter: any; note: string } {
    const filter = {
      state,
      sku,
      minAccounts: minAccounts ? parseInt(minAccounts, 10) : undefined,
    };
    // 占位：真实数据由 Repository 提供
    return {
      items: [],
      filter,
      note: '骨架接口；Repository 落地后返回真实租户列表',
    };
  }

  /**
   * GET /api/admin/tenants/:tenantId
   */
  @Get(':tenantId')
  @Roles('platform_admin', 'finance_admin')
  detail(@Param('tenantId') tenantId: string): { tenantId: string; note: string } {
    return {
      tenantId,
      note: '骨架接口；Repository 落地后返回租户详情',
    };
  }

  /**
   * POST /api/admin/tenants/:tenantId/freeze
   * 仅 platform_admin
   */
  @Post(':tenantId/freeze')
  @Roles('platform_admin')
  @HttpCode(HttpStatus.OK)
  freeze(
    @Param('tenantId') tenantId: string,
    @Body() body: { currentState: TenantLifecycleState; reason: string; operatorId: string },
  ) {
    return this.service.freezeTenant({
      tenantId,
      currentState: body.currentState,
      reason: body.reason,
      operatorId: body.operatorId,
    });
  }

  /**
   * POST /api/admin/tenants/:tenantId/unfreeze
   */
  @Post(':tenantId/unfreeze')
  @Roles('platform_admin')
  @HttpCode(HttpStatus.OK)
  unfreeze(
    @Param('tenantId') tenantId: string,
    @Body() body: { currentState: TenantLifecycleState; operatorId: string },
  ) {
    return this.service.unfreezeTenant({
      tenantId,
      currentState: body.currentState,
      operatorId: body.operatorId,
    });
  }

  /**
   * POST /api/admin/tenants/:tenantId/reserve
   * 设置保留标记（避免被 cleanup）
   */
  @Post(':tenantId/reserve')
  @Roles('platform_admin')
  @HttpCode(HttpStatus.OK)
  reserve(
    @Param('tenantId') tenantId: string,
    @Body() body: { reservedFlag: boolean; reason: string; operator: string },
  ) {
    return this.service.setReserveFlag({
      tenantId,
      reservedFlag: body.reservedFlag,
      reason: body.reason,
      operator: body.operator,
      executedAt: new Date(),
    });
  }
}
