import {
  Body,
  Controller,
  Post,
  Get,
  Delete,
  Param,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { TenantProvisionService } from './tenant-provision.service';
import { PgPoolService } from './pg-pool.service';

/**
 * OnboardingController — 租户开通 + DB 健康检查（公开路径，无需 token）
 *
 * 路由前缀：/api/public/onboarding 和 /api/public/db
 *
 * 用户 2026-05-02「做啊」触发：
 *   - 让 mock 后端真接 PG，打通"机构开通 → 真存盘"完整链路
 */
@Controller('public')
export class OnboardingController {
  constructor(
    private readonly provision: TenantProvisionService,
    private readonly pg: PgPoolService,
  ) {}

  /**
   * GET /api/public/db/ping — 数据库健康检查
   */
  @Get('db/ping')
  @HttpCode(HttpStatus.OK)
  async dbPing(): Promise<{ ok: boolean; database: string; ts: string }> {
    const ok = await this.pg.ping();
    return { ok, database: 'edu', ts: new Date().toISOString() };
  }

  /**
   * POST /api/public/onboarding/provision-tenant
   *
   * 一键开通租户：建 schema + 跑 11 个 migration + INSERT public.tenants
   *
   * Body: { tenantId, name, sku }
   */
  @Post('onboarding/provision-tenant')
  @HttpCode(HttpStatus.CREATED)
  async provisionTenant(
    @Body()
    body: {
      tenantId: string;
      name: string;
      sku: 'trial' | 'standard_1999' | 'school_pro' | 'growth';
    },
  ): Promise<{ tenantId: string; tenantSchema: string; ranMigrations: string[] }> {
    return this.provision.provisionTenant(body);
  }

  /**
   * GET /api/public/onboarding/tenants — 列出已开通租户
   */
  @Get('onboarding/tenants')
  @HttpCode(HttpStatus.OK)
  async listTenants() {
    return this.provision.listTenants();
  }

  /**
   * DELETE /api/public/onboarding/tenants/:id — 删除租户（仅测试用）
   */
  @Delete('onboarding/tenants/:id')
  @HttpCode(HttpStatus.OK)
  async deleteTenant(@Param('id') id: string): Promise<{ ok: true }> {
    await this.provision.deleteTenant(id);
    return { ok: true };
  }
}
