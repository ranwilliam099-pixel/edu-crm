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
import { CourseProductRepository, CourseProduct } from './course-product.repository';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';
import { Roles } from '../../guards/rbac.decorator';
import { RbacGuard } from '../../guards/rbac.guard';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';

/**
 * CourseProductController — V29 R6 课程产品管理（机构标准产品库）
 *
 * 来源：用户 2026-05-07 Phase 5「全做」— 校长/老板可补课程产品
 *
 * Endpoints:
 *   GET  /db/course-products         列上架产品（销售签约下拉用）
 *   GET  /db/course-products/all     列全部含下架（admin 管理用）
 *   GET  /db/course-products/:id     详情
 *   POST /db/course-products         创建（admin / boss）
 *   POST /db/course-products/:id/status  上下架切换（admin / boss）
 */
@Controller('db/course-products')
@UseGuards(TenantScopeGuard)
export class CourseProductController {
  constructor(private readonly repo: CourseProductRepository) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(
    @Query('tenantSchema') tenantSchema: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<{ items: CourseProduct[] }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const items = await this.repo.list(tenantSchema, {
      includeOffShelf: false,
      limit: limit ? Math.min(parseInt(limit, 10), 200) : 100,
      offset: offset ? parseInt(offset, 10) : 0,
    });
    return { items };
  }

  @Get('all')
  @UseGuards(RbacGuard)
  @Roles('admin', 'boss', 'sales_director')
  @HttpCode(HttpStatus.OK)
  async listAll(
    @Query('tenantSchema') tenantSchema: string,
  ): Promise<{ items: CourseProduct[] }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const items = await this.repo.list(tenantSchema, { includeOffShelf: true });
    return { items };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  async detail(
    @Param('id') id: string,
    @Query('tenantSchema') tenantSchema: string,
  ): Promise<CourseProduct | { found: false }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const c = await this.repo.findById(tenantSchema, id);
    if (!c) return { found: false };
    return c;
  }

  @Post()
  @UseGuards(RbacGuard)
  @Roles('admin', 'boss')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body()
    body: {
      tenantId: string;
      tenantSchema: string;
      id: string;
      productName: string;
      courseLine: string;
      classType: string;
      lessonPackage?: string;
      standardPrice: number;
      campusScope?: string;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<CourseProduct> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    const operatorUserId = req.user?.sub;
    if (!operatorUserId) throw new BadRequestException('user sub required');
    return this.repo.create(body.tenantSchema, {
      id: body.id,
      productName: body.productName,
      courseLine: body.courseLine,
      classType: body.classType,
      lessonPackage: body.lessonPackage,
      standardPrice: body.standardPrice,
      campusScope: body.campusScope,
      operatorUserId,
    });
  }

  @Post(':id/status')
  @UseGuards(RbacGuard)
  @Roles('admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async toggleStatus(
    @Param('id') id: string,
    @Body() body: { tenantId: string; tenantSchema: string; status: '上架' | '下架' },
    @Req() req: AuthenticatedRequest,
  ): Promise<CourseProduct> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    if (body.status !== '上架' && body.status !== '下架') {
      throw new BadRequestException('status must be 上架 or 下架');
    }
    const operatorUserId = req.user?.sub;
    if (!operatorUserId) throw new BadRequestException('user sub required');
    return this.repo.setStatus(body.tenantSchema, id, body.status, operatorUserId);
  }
}
