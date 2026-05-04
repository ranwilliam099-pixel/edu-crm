import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Query,
} from '@nestjs/common';
import {
  DashboardRepository,
  AdminKpi,
  SalesFunnel,
  TeacherLeaderboard,
  LeaderboardSortKey,
} from './dashboard.repository';

/**
 * DashboardController — V19 KPI 看板 HTTP 暴露
 *
 * 路由：
 *   GET /api/db/dashboards/admin                - admin KPI（4 项）
 *   GET /api/db/dashboards/sales-funnel         - 销售漏斗
 *   GET /api/db/dashboards/teacher-leaderboard  - 老师业绩榜
 *
 * 鉴权：x-tenant-schema header
 */
@Controller('db/dashboards')
export class DashboardController {
  constructor(private readonly dashRepo: DashboardRepository) {}

  @Get('admin')
  @HttpCode(HttpStatus.OK)
  async adminKpi(
    @Headers('x-tenant-schema') tenantSchema: string,
  ): Promise<AdminKpi> {
    if (!tenantSchema) {
      throw new BadRequestException('x-tenant-schema header required');
    }
    return this.dashRepo.getAdminKpi(tenantSchema);
  }

  @Get('sales-funnel')
  @HttpCode(HttpStatus.OK)
  async salesFunnel(
    @Headers('x-tenant-schema') tenantSchema: string,
  ): Promise<SalesFunnel> {
    if (!tenantSchema) {
      throw new BadRequestException('x-tenant-schema header required');
    }
    return this.dashRepo.getSalesFunnel(tenantSchema);
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
