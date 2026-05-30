import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import {
  DashboardRepository,
  AdminKpi,
  SalesFunnel,
  TeacherLeaderboard,
  LeaderboardSortKey,
  HomeAlertStats,
} from './dashboard.repository';
import { PromotionEligibilityService } from './promotion-eligibility.service';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';
import { RbacGuard } from '../../guards/rbac.guard';
import { Roles } from '../../guards/rbac.decorator';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';

/**
 * DashboardController — V19 KPI 看板 + V20 早鸟门槛探测钩子
 *
 * 路由：
 *   GET /api/db/dashboards/admin                - admin KPI（4 项）
 *                                                  + V20 后置异步探测早鸟门槛 → reserveQuota
 *   GET /api/db/dashboards/sales-funnel
 *   GET /api/db/dashboards/teacher-leaderboard
 *
 * 鉴权：x-tenant-schema header
 */
// 2026-05-22 P0 修生产 429: home 一次并发 3 dashboards GET, 全局 throttle 60/min 太严
//   dashboards 全只读 + RBAC + tenant scope, 不需限流 (越权由 guard 拦)
@SkipThrottle()
@UseGuards(TenantScopeGuard)
@Controller('db/dashboards')
export class DashboardController {
  constructor(
    private readonly dashRepo: DashboardRepository,
    private readonly promoEligibility: PromotionEligibilityService,
  ) {}

  @Get('admin')
  @HttpCode(HttpStatus.OK)
  async adminKpi(
    @Headers('x-tenant-schema') tenantSchema: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<AdminKpi> {
    if (!tenantSchema) {
      throw new BadRequestException('x-tenant-schema header required');
    }
    const kpi = await this.dashRepo.getAdminKpi(tenantSchema);

    // V20: 异步探测早鸟门槛（不阻塞 KPI 返回）
    const tenantId = req?.user?.tenantId || null;
    if (tenantId) {
      this.promoEligibility
        .detectAndReserve(tenantId, tenantSchema)
        .catch(() => {/* 已在 service 内吞错并 log */});
    }

    return kpi;
  }

  /**
   * GET /api/db/dashboards/alerts — 首页预警聚合（b/home attentionStats）
   *
   * 来源：Phase 3 (2026-05-30 item #4) — 前端 b/home attentionStats
   *   { lowBalance, refundPending, handover } 现全 0，需补真值。
   *
   * 返回 HomeAlertStats { lowBalance, refundPending, handover }（口径见 repository）。
   *
   * RBAC: @Roles('admin','boss') — 仅经营管理者看全机构预警
   *   （lowBalance/refundPending/handover 是机构级运营预警，非单校区/单销售视角）。
   *
   * 鉴权：TenantScopeGuard 校验 x-tenant-schema === jwt（与 admin KPI 一致）。
   * 全只读 → @SkipThrottle（class 级已加）+ 不写 audit。
   */
  @Get('alerts')
  @UseGuards(RbacGuard)
  @Roles('admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async homeAlerts(
    @Headers('x-tenant-schema') tenantSchema: string,
  ): Promise<HomeAlertStats> {
    if (!tenantSchema) {
      throw new BadRequestException('x-tenant-schema header required');
    }
    return this.dashRepo.getHomeAlerts(tenantSchema);
  }

  @Get('sales-funnel')
  @HttpCode(HttpStatus.OK)
  async salesFunnel(
    @Headers('x-tenant-schema') tenantSchema: string,
    @Req() req: AuthenticatedRequest,
    @Query('campusId') campusId?: string,
    @Query('owner') owner?: string,
  ): Promise<SalesFunnel> {
    if (!tenantSchema) {
      throw new BadRequestException('x-tenant-schema header required');
    }
    // V26 老板视角校区切换：admin 切到具体校区时传 campusId 过滤；
    // boss / sales 等单校 role 由前端从 jwt.campusId 自动带上。
    //
    // 2026-05-25 #3 闭环 — owner filter（销售看自己的漏斗，老板看全机构）：
    //   owner === 'me' → 从 JWT 取 req.user.sub 作为 ownerUserId filter
    //   其他值（如显式 userId）不解析（防止越权看他人漏斗）— 仅支持 'me' 一种语义
    //   缺省（admin/boss）→ 不过滤，看全机构
    const ownerUserId = owner === 'me' ? req?.user?.sub : undefined;
    return this.dashRepo.getSalesFunnel(tenantSchema, { campusId, ownerUserId });
  }

  @Get('teacher-leaderboard')
  @HttpCode(HttpStatus.OK)
  async teacherLeaderboard(
    @Headers('x-tenant-schema') tenantSchema: string,
    @Query('month') month?: string,
    @Query('sortBy') sortBy?: string,
  ): Promise<TeacherLeaderboard> {
    if (!tenantSchema) {
      throw new BadRequestException('x-tenant-schema header required');
    }
    // V37: 排序键删 'payroll'（薪资下线），默认 'lessons'
    const validSorts: LeaderboardSortKey[] = ['lessons', 'rating', 'feedbackRate'];
    const safeSort: LeaderboardSortKey = validSorts.includes(sortBy as LeaderboardSortKey)
      ? (sortBy as LeaderboardSortKey)
      : 'lessons';
    return this.dashRepo.getTeacherLeaderboard(tenantSchema, {
      month,
      sortBy: safeSort,
    });
  }
}
