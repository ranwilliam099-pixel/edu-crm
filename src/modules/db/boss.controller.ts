import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
  Query,
} from '@nestjs/common';
import { CampusRepository, Campus } from './campus.repository';
import {
  SubscriptionRepository,
  Subscription,
  PlanTier,
} from './subscription.repository';
import { PgPoolService } from './pg-pool.service';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';
import { RbacGuard } from '../../guards/rbac.guard';
import { Roles } from '../../guards/rbac.decorator';

/**
 * BossController — V19 Boss 视角校区 + 订阅管理 HTTP 暴露
 *
 * 路由：
 *   POST /api/db/boss/campuses                  - 新增校区
 *   POST /api/db/boss/campuses/list             - 列出校区
 *   POST /api/db/boss/campuses/stats            - 30 天聚合统计
 *   POST /api/db/boss/subscription/upgrade      - 升级订阅
 *   GET  /api/db/boss/subscription              - 当前订阅状态
 *
 * 鉴权：tenantId 通过 body / query 传（不走 x-tenant-schema header — public 表）
 */
@UseGuards(TenantScopeGuard)
@Controller('db/boss')
export class BossController {
  constructor(
    private readonly campusRepo: CampusRepository,
    private readonly subRepo: SubscriptionRepository,
    private readonly pg: PgPoolService,
  ) {}

  // ===== tenant =====

  @Get('tenant/info')
  @UseGuards(RbacGuard)
  @Roles('admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async tenantInfo(@Query('tenantId') tenantId: string): Promise<{
    tenantId: string;
    name: string;
    status: string;
    version: string;
    planTier: PlanTier;
    maxCampuses: number;
    createdAt: string;
  }> {
    if (!tenantId) {
      throw new BadRequestException('tenantId required');
    }
    const rows = await this.pg.query<{
      id: string;
      name: string;
      status: string;
      version: string;
      plan_tier: PlanTier | null;
      max_campuses: number;
      created_at: Date;
    }>(
      `SELECT id, name, status, version, plan_tier, max_campuses, created_at
         FROM public.tenants
        WHERE id = $1`,
      [tenantId],
    );
    if (rows.length === 0) {
      throw new BadRequestException(`tenant ${tenantId} not found`);
    }
    const r = rows[0];
    return {
      tenantId: r.id,
      name: r.name,
      status: r.status,
      version: r.version,
      planTier: r.plan_tier || 'single',
      maxCampuses: r.max_campuses,
      createdAt: r.created_at.toISOString(),
    };
  }

  // ===== campuses =====

  @Post('campuses')
  @UseGuards(RbacGuard)
  @Roles('admin')
  @HttpCode(HttpStatus.CREATED)
  async createCampus(
    @Body()
    body: {
      tenantId: string;
      id: string;
      name: string;
      city?: string;
      district?: string;
      address?: string;
      isHq?: boolean;
    },
  ): Promise<Campus> {
    if (!body.tenantId || body.tenantId.length !== 32) {
      throw new BadRequestException('tenantId must be 32-char ULID');
    }
    if (!body.id || body.id.length !== 32) {
      throw new BadRequestException('id must be 32-char ULID');
    }
    if (!body.name) {
      throw new BadRequestException('name required');
    }
    return this.campusRepo.create(body.tenantId, {
      id: body.id,
      name: body.name,
      city: body.city,
      district: body.district,
      address: body.address,
      isHq: body.isHq,
    });
  }

  @Post('campuses/list')
  @UseGuards(RbacGuard)
  @Roles('admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async listCampuses(@Body() body: { tenantId: string }): Promise<Campus[]> {
    if (!body.tenantId) {
      throw new BadRequestException('tenantId required');
    }
    return this.campusRepo.list(body.tenantId);
  }

  @Post('campuses/stats')
  @UseGuards(RbacGuard)
  @Roles('admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async campusStats(@Body() body: { tenantId: string }) {
    if (!body.tenantId) {
      throw new BadRequestException('tenantId required');
    }
    return this.campusRepo.getStats30d(body.tenantId);
  }

  // ===== subscription =====

  @Post('subscription/upgrade')
  @UseGuards(RbacGuard)
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  async upgradeSubscription(
    @Body() body: { tenantId: string; targetPlan: PlanTier },
  ) {
    if (!body.tenantId) {
      throw new BadRequestException('tenantId required');
    }
    if (!body.targetPlan) {
      throw new BadRequestException('targetPlan required');
    }
    return this.subRepo.upgrade(body.tenantId, body.targetPlan);
  }

  @Get('subscription')
  @UseGuards(RbacGuard)
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  async getSubscription(
    @Query('tenantId') tenantId: string,
  ): Promise<Subscription> {
    if (!tenantId) {
      throw new BadRequestException('tenantId required');
    }
    return this.subRepo.getCurrent(tenantId);
  }
}
