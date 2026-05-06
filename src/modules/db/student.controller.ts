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
import { StudentRepository, StudentBrief, StudentTransferResult } from './student.repository';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';
import { Roles } from '../../guards/rbac.decorator';
import { RbacGuard } from '../../guards/rbac.guard';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';

/**
 * StudentController — V28 学生归属转移 HTTP 暴露
 *
 * 路径前缀 /api/db/students/*
 *
 * 来源：用户 2026-05-07「学生也可以切换给别的老师和销售」
 *
 * Endpoints:
 *   POST /db/students/:id/transfer-sales   学生 → 另一个销售（admin/boss/sales 自己转）
 *   POST /db/students/:id/transfer-teacher 学生主带老师 → 另一个老师（admin/boss/hr）
 *
 * RBAC：
 *   transfer-sales：admin / boss / sales / sales_manager（销售可主动转给同事，校长可调整归属）
 *   transfer-teacher：admin / boss / hr（教学主管类决策）
 */
@Controller('db/students')
@UseGuards(TenantScopeGuard)
export class StudentController {
  constructor(private readonly repo: StudentRepository) {}

  /**
   * V29 R2 销售即时建学生（替代仅 batch import）
   *
   * 来源：用户 2026-05-07「全做」— 销售签约前临时新增学员
   *
   * Body:
   *   id            32-char ULID（前端生成）
   *   studentName   学员名 *
   *   customerId    家长 customer.id *（FK，必须已存在）
   *   gradeOrAge / intendedSubject / schoolName / gender / assignedTeacherId — 可选
   *   ownerSalesId 自动 = req.user.sub（销售自己创建归自己）
   *
   * RBAC：sales / sales_manager / sales_director / boss / admin
   */
  @Post()
  @UseGuards(RbacGuard)
  @Roles('sales', 'sales_manager', 'sales_director', 'boss', 'admin')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body()
    body: {
      tenantId: string;
      tenantSchema: string;
      id: string;
      studentName: string;
      customerId: string;
      gradeOrAge?: string;
      intendedSubject?: string;
      schoolName?: string;
      gender?: '男' | '女' | '未知';
      assignedTeacherId?: string;
    },
    @Req() req: AuthenticatedRequest,
  ) {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    const operatorUserId = req.user?.sub;
    if (!operatorUserId) throw new BadRequestException('user sub required');
    return this.repo.create(body.tenantSchema, {
      id: body.id,
      studentName: body.studentName,
      customerId: body.customerId,
      gradeOrAge: body.gradeOrAge,
      intendedSubject: body.intendedSubject,
      schoolName: body.schoolName,
      gender: body.gender,
      ownerSalesId: operatorUserId, // 销售自建归自己
      assignedTeacherId: body.assignedTeacherId,
      operatorUserId,
    });
  }

  /**
   * V29 R4 老师视角：列该老师主带学生（OOUX teacher → students[]）
   *
   * 用户 2026-05-07 OOUX 哲学 — 老师详情一站式
   *
   * RBAC：本租户内 teacher / admin / boss / hr / sales 等都可看（学生归属是公开数据）
   */
  @Get('by-teacher/:teacherId')
  @HttpCode(HttpStatus.OK)
  async listByTeacher(
    @Param('teacherId') teacherId: string,
    @Query('tenantSchema') tenantSchema: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<{ items: StudentBrief[] }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    if (!teacherId || teacherId.length !== 32) {
      throw new BadRequestException('teacherId must be 32-char ULID');
    }
    const items = await this.repo.listByTeacher(tenantSchema, teacherId, {
      limit: limit ? Math.min(parseInt(limit, 10), 200) : 100,
      offset: offset ? parseInt(offset, 10) : 0,
    });
    return { items };
  }

  @Post(':id/transfer-sales')
  @UseGuards(RbacGuard)
  @Roles('admin', 'boss', 'sales', 'sales_manager', 'sales_director')
  @HttpCode(HttpStatus.OK)
  async transferSales(
    @Param('id') id: string,
    @Body()
    body: {
      tenantId: string;
      tenantSchema: string;
      toSalesId: string | null;
      reason?: string;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<StudentTransferResult> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    const operatorRole = req.user?.role || 'sales';
    const reason =
      body.reason ||
      (operatorRole === 'admin' || operatorRole === 'boss'
        ? '校长再分配'
        : '销售主动转交');
    return this.repo.transferSales(
      body.tenantSchema,
      id,
      body.toSalesId === undefined ? null : body.toSalesId,
      reason,
    );
  }

  @Post(':id/transfer-teacher')
  @UseGuards(RbacGuard)
  @Roles('admin', 'boss', 'hr')
  @HttpCode(HttpStatus.OK)
  async transferTeacher(
    @Param('id') id: string,
    @Body()
    body: {
      tenantId: string;
      tenantSchema: string;
      toTeacherId: string | null;
      reason?: string;
    },
  ): Promise<StudentTransferResult> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    return this.repo.transferTeacher(
      body.tenantSchema,
      id,
      body.toTeacherId === undefined ? null : body.toTeacherId,
      body.reason || '校长再分配',
    );
  }
}
