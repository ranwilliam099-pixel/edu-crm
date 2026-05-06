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
  CustomerRepository,
  Customer,
  CreateCustomerResult,
  FollowEntry,
  FollowType,
} from './customer.repository';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';
import { Roles } from '../../guards/rbac.decorator';
import { RbacGuard } from '../../guards/rbac.guard';

/**
 * CustomerController — V25 销售客户管理 HTTP 暴露
 *
 * 路径前缀 /api/db/customers/*
 *
 * Endpoints:
 *   GET  /db/customers/mine              我的客户列表
 *   GET  /db/customers/pool              公共池
 *   GET  /db/customers/:id               详情
 *   GET  /db/customers/:id/follows       跟进时间轴
 *   POST /db/customers/:id/claim         捞客户（FCFS）
 *   POST /db/customers/:id/release       退回池
 *   POST /db/customers/:id/mark-lost     标失单
 *   POST /db/customers/:id/follow        加跟进时间轴
 *
 * 鉴权：TenantScopeGuard（强制 tenantId 一致）
 */
@Controller('db/customers')
@UseGuards(TenantScopeGuard)
export class CustomerController {
  constructor(private readonly repo: CustomerRepository) {}

  /**
   * V29 R2 销售即时建客户（家长 + opportunity + 可选 student 一并）
   *
   * 用户 2026-05-07「全做」— 销售自己开拓的客户能即时录入，不必等公共池
   *
   * Body:
   *   customerId / opportunityId  32-char ULID（前端生成）
   *   parentName / primaryMobile / campusId  必填
   *   studentId / studentName     可选（提供则一并建学生）
   *   gradeOrAge / intendedSubject / source / note 可选
   *
   * RBAC：sales / sales_manager / sales_director / boss / admin
   * ownerSalesId 自动 = req.user.sub
   */
  @Post()
  @UseGuards(RbacGuard)
  @Roles('sales', 'sales_manager', 'sales_director', 'boss', 'admin')
  @HttpCode(HttpStatus.CREATED)
  async createSelfBuilt(
    @Body()
    body: {
      tenantId: string;
      tenantSchema: string;
      customerId: string;
      opportunityId: string;
      parentName: string;
      primaryMobile: string;
      campusId?: string;
      studentId?: string;
      studentName?: string;
      gradeOrAge?: string;
      intendedSubject?: string;
      source?: string;
      note?: string;
      stage?: string;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<CreateCustomerResult> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    const operatorUserId = req.user?.sub;
    if (!operatorUserId) throw new BadRequestException('user sub required');
    const campusId = body.campusId || req.user?.campusId;
    if (!campusId) {
      throw new BadRequestException(
        '跨校 role 必须显式传 campusId（admin/sales_director/hr 无单一 campus）',
      );
    }
    return this.repo.createWithOpportunity(body.tenantSchema, {
      customerId: body.customerId,
      opportunityId: body.opportunityId,
      parentName: body.parentName,
      primaryMobile: body.primaryMobile,
      campusId,
      ownerSalesId: operatorUserId,
      studentId: body.studentId,
      studentName: body.studentName,
      gradeOrAge: body.gradeOrAge,
      intendedSubject: body.intendedSubject,
      stage: body.stage,
      source: body.source,
      note: body.note,
    });
  }

  @Get('mine')
  @HttpCode(HttpStatus.OK)
  async listMine(
    @Query('tenantSchema') tenantSchema: string,
    @Query('stage') stage?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Req() req?: AuthenticatedRequest,
  ): Promise<{ items: Customer[] }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const ownerUserId = req?.user?.sub;
    if (!ownerUserId) throw new BadRequestException('user sub required');
    const items = await this.repo.listMine(tenantSchema, ownerUserId, {
      stage: stage as any,
      limit: limit ? Math.min(parseInt(limit, 10), 200) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
    });
    return { items };
  }

  /**
   * 老板视角：本租户全部销售的客户（含未分配 + 各销售归属）
   * 仅 admin（老板）/ sales_director（大区经理）/ sales_manager 可调
   * @query campusId V26 校区切换过滤
   */
  @Get('all')
  @UseGuards(RbacGuard)
  @Roles('admin', 'sales_director', 'sales_manager')
  @HttpCode(HttpStatus.OK)
  async listAllForBoss(
    @Query('tenantSchema') tenantSchema: string,
    @Query('ownerFilter') ownerFilter?: string,
    @Query('stage') stage?: string,
    @Query('campusId') campusId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<{ items: Customer[] }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const items = await this.repo.listAllForBoss(tenantSchema, {
      ownerFilter,
      stage: stage as any,
      campusId,
      limit: limit ? Math.min(parseInt(limit, 10), 500) : 200,
      offset: offset ? parseInt(offset, 10) : 0,
    });
    return { items };
  }

  @Get('pool')
  @HttpCode(HttpStatus.OK)
  async listPool(
    @Query('tenantSchema') tenantSchema: string,
    @Query('source') source?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<{ items: Customer[] }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const items = await this.repo.listPool(tenantSchema, {
      source,
      limit: limit ? Math.min(parseInt(limit, 10), 200) : 100,
      offset: offset ? parseInt(offset, 10) : 0,
    });
    return { items };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  async detail(
    @Param('id') id: string,
    @Query('tenantSchema') tenantSchema: string,
  ): Promise<Customer | { found: false }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const c = await this.repo.findById(tenantSchema, id);
    if (!c) return { found: false };
    return c;
  }

  @Get(':id/follows')
  @HttpCode(HttpStatus.OK)
  async listFollows(
    @Param('id') id: string,
    @Query('tenantSchema') tenantSchema: string,
    @Query('limit') limit?: string,
  ): Promise<{ items: FollowEntry[] }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const items = await this.repo.listFollowLog(
      tenantSchema,
      id,
      limit ? Math.min(parseInt(limit, 10), 500) : 100,
    );
    return { items };
  }

  @Post(':id/claim')
  @HttpCode(HttpStatus.OK)
  async claim(
    @Param('id') id: string,
    @Body() body: { tenantId: string; tenantSchema: string; userLabel?: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<Customer> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    const userId = req.user?.sub;
    if (!userId) throw new BadRequestException('user sub required');
    return this.repo.claim(
      body.tenantSchema,
      id,
      userId,
      body.userLabel || `销售 ${userId.slice(0, 6)}`,
    );
  }

  @Post(':id/release')
  @HttpCode(HttpStatus.OK)
  async release(
    @Param('id') id: string,
    @Body()
    body: { tenantId: string; tenantSchema: string; userLabel?: string; reason?: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<Customer> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    const userId = req.user?.sub;
    if (!userId) throw new BadRequestException('user sub required');
    return this.repo.release(
      body.tenantSchema,
      id,
      userId,
      body.userLabel || `销售 ${userId.slice(0, 6)}`,
      body.reason,
    );
  }

  @Post(':id/mark-lost')
  @HttpCode(HttpStatus.OK)
  async markLost(
    @Param('id') id: string,
    @Body()
    body: {
      tenantId: string;
      tenantSchema: string;
      userLabel?: string;
      lostReason: string;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<Customer> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    if (!body.lostReason) throw new BadRequestException('lostReason required');
    const userId = req.user?.sub;
    if (!userId) throw new BadRequestException('user sub required');
    return this.repo.markLost(
      body.tenantSchema,
      id,
      userId,
      body.userLabel || `销售 ${userId.slice(0, 6)}`,
      body.lostReason,
    );
  }

  @Post(':id/follow')
  @HttpCode(HttpStatus.CREATED)
  async addFollow(
    @Param('id') id: string,
    @Body()
    body: {
      tenantId: string;
      tenantSchema: string;
      followType: FollowType;
      label: string;
      userLabel?: string;
      extra?: Record<string, unknown>;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<FollowEntry> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    if (!body.label) throw new BadRequestException('label required');
    const userId = req.user?.sub;
    if (!userId) throw new BadRequestException('user sub required');
    return this.repo.addFollow(body.tenantSchema, id, {
      followType: body.followType || 'remark',
      label: body.label,
      byUserId: userId,
      byLabel: body.userLabel || `销售 ${userId.slice(0, 6)}`,
      extra: body.extra,
    });
  }
}
