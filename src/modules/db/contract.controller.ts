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
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ContractRepository,
  Contract,
  ContractStatus,
  OrderType,
  SalesPerformance,
} from './contract.repository';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';
import { Roles } from '../../guards/rbac.decorator';
import { RbacGuard } from '../../guards/rbac.guard';

/**
 * ContractController — V25 签约管理 HTTP 暴露（业绩数据源头）
 *
 * 路径前缀 /api/db/contracts/*
 *
 * Endpoints:
 *   GET  /db/contracts/mine          我的签约列表（按 owner_user_id）
 *   GET  /db/contracts/performance   我的业绩 KPI（本月 + 累计）
 *   GET  /db/contracts/:id           详情
 *   POST /db/contracts               新增签约（业绩录入入口）
 *   POST /db/contracts/:id/activate  激活（pending → active）
 */
@Controller('db/contracts')
@UseGuards(TenantScopeGuard)
export class ContractController {
  constructor(private readonly repo: ContractRepository) {}

  @Get('mine')
  @HttpCode(HttpStatus.OK)
  async listMine(
    @Query('tenantSchema') tenantSchema: string,
    @Query('status') status?: ContractStatus,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Req() req?: AuthenticatedRequest,
  ): Promise<{ items: Contract[] }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const ownerUserId = req?.user?.sub;
    if (!ownerUserId) throw new BadRequestException('user sub required');
    const items = await this.repo.listByOwner(tenantSchema, ownerUserId, {
      status,
      limit: limit ? Math.min(parseInt(limit, 10), 200) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
    });
    return { items };
  }

  @Get('performance')
  @HttpCode(HttpStatus.OK)
  async myPerformance(
    @Query('tenantSchema') tenantSchema: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<SalesPerformance> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const ownerUserId = req.user?.sub;
    if (!ownerUserId) throw new BadRequestException('user sub required');
    return this.repo.getOwnerPerformance(tenantSchema, ownerUserId);
  }

  /**
   * 老板视角：团队业绩排行
   * 仅 admin（老板）/ sales_director（大区经理）/ sales_manager 可调
   * @query campusId V26 校区切换过滤
   */
  @Get('team-performance')
  @UseGuards(RbacGuard)
  @Roles('admin', 'sales_director', 'sales_manager')
  @HttpCode(HttpStatus.OK)
  async teamPerformance(
    @Query('tenantSchema') tenantSchema: string,
    @Query('campusId') campusId?: string,
  ): Promise<{
    items: Array<{
      ownerUserId: string;
      totalCount: number;
      totalAmount: number;
      thisMonthCount: number;
      thisMonthAmount: number;
    }>;
  }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const items = await this.repo.getTeamPerformance(tenantSchema, campusId);
    return { items };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  async detail(
    @Param('id') id: string,
    @Query('tenantSchema') tenantSchema: string,
  ): Promise<Contract | { found: false }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const c = await this.repo.findById(tenantSchema, id);
    if (!c) return { found: false };
    return c;
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body()
    body: {
      tenantId: string;
      tenantSchema: string;
      id: string;
      studentId: string;
      courseProductId: string;
      opportunityId?: string;
      campusId?: string;
      classType?: string;
      lessonHours: number;
      standardPrice: number;
      discountAmount?: number;
      giftHours?: number;
      totalAmount: number;
      orderType?: OrderType;
      signedAt?: string;
      note?: string;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<Contract> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    if (!body.studentId) throw new BadRequestException('studentId required');
    if (!body.courseProductId) throw new BadRequestException('courseProductId required');
    if (typeof body.totalAmount !== 'number') {
      throw new BadRequestException('totalAmount required');
    }
    const ownerUserId = req.user?.sub;
    if (!ownerUserId) throw new BadRequestException('user sub required');
    // V26 校区归属：跨校 role（admin/sales_director）允许 body.campusId 显式传，
    // 单校 role 从 jwt.campusId 自动填，前端不需要传。
    const campusId = body.campusId || req.user?.campusId || null;
    return this.repo.create(body.tenantSchema, {
      id: body.id,
      studentId: body.studentId,
      courseProductId: body.courseProductId,
      ownerUserId,
      opportunityId: body.opportunityId,
      campusId,
      classType: body.classType,
      lessonHours: body.lessonHours,
      standardPrice: body.standardPrice,
      discountAmount: body.discountAmount,
      giftHours: body.giftHours,
      totalAmount: body.totalAmount,
      orderType: body.orderType,
      signedAt: body.signedAt,
      note: body.note,
    });
  }

  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  async activate(
    @Param('id') id: string,
    @Body() body: { tenantId: string; tenantSchema: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<Contract> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    const userId = req.user?.sub;
    if (!userId) throw new BadRequestException('user sub required');
    return this.repo.setStatus(body.tenantSchema, id, 'active', userId);
  }
}
