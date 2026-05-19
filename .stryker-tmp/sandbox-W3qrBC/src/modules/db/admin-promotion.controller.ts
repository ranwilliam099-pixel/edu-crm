import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PromotionRepository, PromotionTier, PromotionDryRun } from './promotion.repository';
import { PlanTier } from './subscription.repository';
import { Roles } from '../../guards/rbac.decorator';
import { RbacGuard } from '../../guards/rbac.guard';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';

/**
 * AdminPromotionController — V20 平台超管促销配置面板
 *
 * 路径：/api/admin/promotions/*
 *   命中 TenantMiddleware admin 白名单（强制 tenantId=null + platformRole）
 *   再加 RbacGuard @Roles('platform_admin') 双重保险
 *
 * 严守边界：
 *   - 只处理平台超管视角，租户视角的 redeem 在 PromotionRedeemController
 */
@Controller('admin/promotions')
@UseGuards(RbacGuard)
@Roles('platform_admin')
export class AdminPromotionController {
  constructor(private readonly promoRepo: PromotionRepository) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(): Promise<{ items: PromotionTier[] }> {
    return { items: await this.promoRepo.listTiers() };
  }

  @Get(':code')
  @HttpCode(HttpStatus.OK)
  async get(@Param('code') code: string): Promise<PromotionTier> {
    return this.promoRepo.getTier(code);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body()
    body: {
      code: string;
      name: string;
      discountPct: number;
      quotaTotal: number | null;
      active?: boolean;
      startsAt?: string | null;
      endsAt?: string | null;
      activationRules?: Record<string, number> | null;
      appliesToPlans?: PlanTier[];
      appliesYears?: number;
      sourceType?: 'self_service' | 'kol' | 'campaign';
      inviteCode?: string | null;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<PromotionTier> {
    if (!body.code || !body.name) {
      throw new BadRequestException('code and name required');
    }
    this.validateKolInvariant(body);
    return this.promoRepo.upsertTier(body, this.audit(req));
  }

  @Patch(':code')
  @HttpCode(HttpStatus.OK)
  async update(
    @Param('code') code: string,
    @Body()
    body: {
      name?: string;
      discountPct?: number;
      quotaTotal?: number | null;
      active?: boolean;
      startsAt?: string | null;
      endsAt?: string | null;
      activationRules?: Record<string, number> | null;
      appliesToPlans?: PlanTier[];
      appliesYears?: number;
      sourceType?: 'self_service' | 'kol' | 'campaign';
      inviteCode?: string | null;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<PromotionTier> {
    const existing = await this.promoRepo.getTier(code);
    const merged = {
      code,
      name: body.name ?? existing.name,
      discountPct: body.discountPct ?? existing.discountPct,
      quotaTotal: body.quotaTotal === undefined ? existing.quotaTotal : body.quotaTotal,
      active: body.active ?? existing.active,
      startsAt: body.startsAt === undefined ? existing.startsAt : body.startsAt,
      endsAt: body.endsAt === undefined ? existing.endsAt : body.endsAt,
      activationRules:
        body.activationRules === undefined ? existing.activationRules : body.activationRules,
      appliesToPlans: body.appliesToPlans ?? existing.appliesToPlans,
      appliesYears: body.appliesYears ?? existing.appliesYears,
      sourceType: body.sourceType ?? existing.sourceType,
      inviteCode: body.inviteCode === undefined ? existing.inviteCode : body.inviteCode,
    };
    this.validateKolInvariant(merged);
    return this.promoRepo.upsertTier(merged, this.audit(req));
  }

  @Patch(':code/toggle')
  @HttpCode(HttpStatus.OK)
  async toggle(
    @Param('code') code: string,
    @Body() body: { active: boolean },
    @Req() req: AuthenticatedRequest,
  ): Promise<PromotionTier> {
    if (typeof body.active !== 'boolean') {
      throw new BadRequestException('active boolean required');
    }
    return this.promoRepo.toggleActive(code, body.active, this.audit(req));
  }

  @Delete(':code')
  @HttpCode(HttpStatus.OK)
  async remove(@Param('code') code: string, @Req() req: any): Promise<{ ok: true }> {
    return this.promoRepo.softDelete(code, this.audit(req));
  }

  @Post(':code/dry-run')
  @HttpCode(HttpStatus.OK)
  async dryRun(
    @Param('code') code: string,
    @Body() body: { discountPct?: number; quotaTotal?: number | null },
  ): Promise<PromotionDryRun> {
    return this.promoRepo.dryRun(code, body || {});
  }

  @Get(':code/locked-tenants')
  @HttpCode(HttpStatus.OK)
  async lockedTenants(
    @Param('code') code: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.promoRepo.listLockedTenants(code, {
      limit: limit ? Math.min(parseInt(limit, 10), 200) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
    });
  }

  // ===== Helpers =====
  private validateKolInvariant(payload: {
    sourceType?: string;
    inviteCode?: string | null;
  }): void {
    const isKol = payload.sourceType === 'kol';
    if (isKol && !payload.inviteCode) {
      throw new BadRequestException('KOL source requires non-null inviteCode');
    }
    if (!isKol && payload.inviteCode) {
      throw new BadRequestException('inviteCode only allowed when sourceType=kol');
    }
  }

  private audit(req: AuthenticatedRequest): {
    operatorId?: string;
    operatorRole: string;
    operatorIp?: string;
  } {
    const user = req.user;
    const xff = req.headers?.['x-forwarded-for'];
    const ip =
      (Array.isArray(xff) ? xff[0] : xff || '').toString().split(',')[0].trim() ||
      req.ip ||
      undefined;
    return {
      operatorId: user?.sub || undefined,
      operatorRole: user?.role || 'platform_admin',
      operatorIp: ip || undefined,
    };
  }
}
