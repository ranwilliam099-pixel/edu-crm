import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PromotionRepository } from './promotion.repository';
import { PromotionQuotaService } from './promotion-quota.service';
import { PlanTier } from './subscription.repository';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';

/**
 * PromotionRedeemController — V20 租户兑换 KOL 邀请码
 *
 * 路径：POST /api/db/checkout/redeem-invite-code
 *   命中 TenantMiddleware「其他业务」分支（强制 tenantId 非空）
 *   再加 TenantScopeGuard 校验 body.tenantId === user.tenantId 防越权
 *
 * 流程：
 *   1) findByInviteCode → 校验 active / 时间窗 / sourceType=kol
 *   2) 校验 applies_to_plans 包含当前 plan
 *   3) reserveQuota 抢档（atomic）
 *   4) 二次校验 reserveQuota 后 plan_tier 是否仍兼容（防 race）
 */
@Controller('db/checkout')
@UseGuards(TenantScopeGuard)
export class PromotionRedeemController {
  constructor(
    private readonly promoRepo: PromotionRepository,
    private readonly quota: PromotionQuotaService,
  ) {}

  @Post('redeem-invite-code')
  @HttpCode(HttpStatus.OK)
  async redeem(
    @Body() body: { tenantId: string; inviteCode: string; planTier?: PlanTier },
    @Req() req: AuthenticatedRequest,
  ): Promise<{
    ok: true;
    promotionCode: string;
    actualPriceYuan: number;
    discountPct: number;
  }> {
    if (!body.tenantId) throw new BadRequestException('tenantId required');
    if (!body.inviteCode) throw new BadRequestException('inviteCode required');

    const tier = await this.promoRepo.findByInviteCode(body.inviteCode);
    if (!tier) throw new BadRequestException('INVITE_CODE_INVALID');
    if (tier.sourceType !== 'kol') throw new BadRequestException('INVITE_CODE_NOT_KOL');
    if (!tier.active) throw new BadRequestException('INVITE_CODE_INACTIVE');
    if (tier.endsAt && new Date(tier.endsAt) <= new Date()) {
      throw new BadRequestException('INVITE_CODE_EXPIRED');
    }

    if (body.planTier && !tier.appliesToPlans.includes(body.planTier)) {
      throw new BadRequestException(
        `INVITE_CODE_PLAN_NOT_COVERED: applies to ${tier.appliesToPlans.join(',')}`,
      );
    }

    const xff = req.headers?.['x-forwarded-for'];
    const ip =
      (Array.isArray(xff) ? xff[0] : xff || '').toString().split(',')[0].trim() ||
      req.ip ||
      null;
    const r = await this.quota.reserveQuota(body.tenantId, tier.code, {
      operatorId: req.user?.sub || undefined,
      operatorRole: 'kol_self',
      operatorIp: ip || undefined,
    });

    // 二次校验 — race 防御（KOL 折扣 plan 限定时）
    const planFromTenant = await this.promoRepo.getTenantPlanTier(body.tenantId);
    if (planFromTenant && !tier.appliesToPlans.includes(planFromTenant)) {
      await this.quota.releaseQuota(body.tenantId, 'plan_not_covered_post_reserve');
      throw new BadRequestException(
        `INVITE_CODE_PLAN_NOT_COVERED: tenant plan=${planFromTenant} not in [${tier.appliesToPlans.join(',')}]`,
      );
    }

    return {
      ok: true,
      promotionCode: tier.code,
      actualPriceYuan: r.actualPriceYuan,
      discountPct: tier.discountPct,
    };
  }
}
