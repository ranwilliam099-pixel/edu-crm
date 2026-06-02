import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Optional,
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
// 2026-06-02 SSOT §3.-2 D 全局校区筛选（增量 2 主 list 端点）：
//   admin 可经 @Query('campusId') 选具体校区 override（校验 ∈ 本租户 campuses）；
//   非 admin（含 boss / sales）恒用 JWT.campusId（A04 防越权选他校）。
import { CampusRepository } from './campus.repository';
import { resolveEffectiveCampusId } from '../../common/campus-scope/resolve-effective-campus';

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
    // 2026-06-02 SSOT §3.-2 D：校验 admin override ∈ 本租户 campuses
    //   @Optional isolated unit spec 不传 → resolveEffectiveCampusId 回退 JWT.campusId
    @Optional() private readonly campusRepo?: CampusRepository,
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
  @UseGuards(RbacGuard)
  // 2026-06-02 安全审 FINDING-1：原无 @Roles → 任意租户 JWT 可读全机构漏斗数据（中危 A01）。
  //   补白名单对齐前端 FUNNEL_ALLOWED_ROLES（admin/boss/sales/sales_manager）；teacher/finance/parent/academic 拒入。
  @Roles('admin', 'boss', 'sales', 'sales_manager')
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
    // 2026-06-02 SSOT §3.-2 D 全局校区筛选（增量 2）：替代 V26「前端裸传 campusId」。
    //   - admin 在首页选具体校区 → @Query('campusId') override（校验 ∈ 本租户 campuses）。
    //   - 非 admin（含 boss / sales）恒用 JWT.campusId（A04 防越权选他校；helper 忽略 override）。
    //   - effective 为 null（admin 跨校 JWT.campusId=null 且无 override）→ 不传 campus 过滤
    //     （既有「全机构」兜底；明心 admin 单校 JWT.campusId 非 null → 本校）。
    //   sales 仍 owner-scope：owner==='me' → ownerUserId=sub（owner filter 与 campus 正交，不变）。
    const effectiveCampusId = await resolveEffectiveCampusId(
      req,
      campusId,
      this.campusRepo,
    );
    const ownerUserId = owner === 'me' ? req?.user?.sub : undefined;
    return this.dashRepo.getSalesFunnel(tenantSchema, {
      campusId: effectiveCampusId ?? undefined,
      ownerUserId,
    });
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
