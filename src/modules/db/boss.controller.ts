import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { CampusRepository, Campus } from './campus.repository';
import {
  SubscriptionRepository,
  Subscription,
  PlanTier,
} from './subscription.repository';

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
@Controller('db/boss')
export class BossController {
  constructor(
    private readonly campusRepo: CampusRepository,
    private readonly subRepo: SubscriptionRepository,
  ) {}

  // ===== campuses =====

  @Post('campuses')
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
  @HttpCode(HttpStatus.OK)
  async listCampuses(@Body() body: { tenantId: string }): Promise<Campus[]> {
    if (!body.tenantId) {
      throw new BadRequestException('tenantId required');
    }
    return this.campusRepo.list(body.tenantId);
  }

  @Post('campuses/stats')
  @HttpCode(HttpStatus.OK)
  async campusStats(@Body() body: { tenantId: string }) {
    if (!body.tenantId) {
      throw new BadRequestException('tenantId required');
    }
    return this.campusRepo.getStats30d(body.tenantId);
  }

  // ===== subscription =====

  @Post('subscription/upgrade')
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
