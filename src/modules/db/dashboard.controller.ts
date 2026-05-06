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
import {
  DashboardRepository,
  AdminKpi,
  SalesFunnel,
  TeacherLeaderboard,
  LeaderboardSortKey,
} from './dashboard.repository';
import { PromotionEligibilityService } from './promotion-eligibility.service';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';
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

  @Get('sales-funnel')
  @HttpCode(HttpStatus.OK)
  async salesFunnel(
    @Headers('x-tenant-schema') tenantSchema: string,
    @Query('campusId') campusId?: string,
  ): Promise<SalesFunnel> {
    if (!tenantSchema) {
      throw new BadRequestException('x-tenant-schema header required');
    }
    // V26 老板视角校区切换：admin 切到具体校区时传 campusId 过滤；
    // boss / sales 等单校 role 由前端从 jwt.campusId 自动带上。
    return this.dashRepo.getSalesFunnel(tenantSchema, { campusId });
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
    const validSorts: LeaderboardSortKey[] = ['payroll', 'lessons', 'rating', 'feedbackRate'];
    const safeSort: LeaderboardSortKey = validSorts.includes(sortBy as LeaderboardSortKey)
      ? (sortBy as LeaderboardSortKey)
      : 'payroll';
    return this.dashRepo.getTeacherLeaderboard(tenantSchema, {
      month,
      sortBy: safeSort,
    });
  }
}
