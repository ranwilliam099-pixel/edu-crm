import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { StudentRepository, StudentTransferResult } from './student.repository';
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
