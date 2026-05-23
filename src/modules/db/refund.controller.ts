import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { RefundRepository, RefundOrder, RefundStatus } from './refund.repository';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';
import { RbacGuard } from '../../guards/rbac.guard';
import { Roles } from '../../guards/rbac.decorator';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';

/**
 * RefundController — V59 退费工单 tenant-scope (task #36)
 * 路由前缀：/api/db/refunds
 *
 * 来源:
 *   - SSOT §3.6 财务 home (本月退费 + 待审批)
 *   - SSOT §4.4 财务字段矩阵 (退费教学人员不看)
 *   - migrations/V59__refund_orders_in_tenant_schema.sql
 *
 * Endpoints:
 *   POST /db/refunds/apply                  申请
 *   POST /db/refunds/:refundId/decide       审批
 *   POST /db/refunds/pending                待审 list
 *   POST /db/refunds/list                   历史 list
 *   GET  /db/refunds/:refundId              find by id
 *
 * RBAC:
 *   - apply (申请): teacher / sales / academic / finance / boss / admin
 *   - decide (审批): finance / boss / admin
 *   - list / find: finance / boss / admin (财务专属, 教学人员禁看)
 *
 * P1-T8 (2026-05-23): @Param('id') → @Param('refundId') 语义化重命名
 *   - URL 完全不变（NestJS 位置匹配；前端 0 改动）
 *   - 仅 controller decorator + 局部变量重命名
 *   - 配套 docs/API-接口参数规范-2026-05-23.md §3.1
 *
 * 注: 区别于 admin/refunds/approve (platform-level platform_admin/finance_admin),
 *     本 controller 走 tenant-scope (jwt.tenantId + RBAC), 服务 B 端 finance-refunds/list 页
 */
@Controller('db/refunds')
@UseGuards(TenantScopeGuard)
export class RefundController {
  constructor(private readonly refundRepo: RefundRepository) {}

  /**
   * POST /api/db/refunds/apply — 提退费申请
   *
   * RBAC: 申请者多角色, applicant_role 从 JWT 派生 (防伪造)
   */
  @Post('apply')
  @UseGuards(RbacGuard)
  @Roles('teacher', 'sales', 'sales_manager', 'academic', 'academic_admin', 'finance', 'boss', 'admin')
  @HttpCode(HttpStatus.CREATED)
  async apply(
    @Body() body: {
      id: string;
      contractId: string;
      studentId: string;
      customerId: string;
      amount: number;
      reason?: string;
      campusId: string;
      tenantSchema: string;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<RefundOrder> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    const userId = req.user?.sub;
    const role = req.user?.role;
    if (!userId || !role) throw new ForbiddenException('JWT sub/role required');
    return this.refundRepo.createInDb(body.tenantSchema, {
      id: body.id,
      contractId: body.contractId,
      studentId: body.studentId,
      customerId: body.customerId,
      amount: body.amount,
      reason: body.reason,
      applicantUserId: userId,
      applicantRole: role,
      campusId: body.campusId,
    });
  }

  /**
   * POST /api/db/refunds/:refundId/decide — 审批退费
   *
   * RBAC: finance (单校) / boss (本校) / admin (跨校)
   * approver_role 从 JWT 派生
   */
  @Post(':refundId/decide')
  @UseGuards(RbacGuard)
  @Roles('finance', 'boss', 'admin')
  @HttpCode(HttpStatus.OK)
  async decide(
    @Param('refundId') refundId: string,
    @Body() body: {
      decision: 'approve' | 'reject';
      decisionReason: string;
      tenantSchema: string;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<RefundOrder> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    if (!['approve', 'reject'].includes(body.decision)) {
      throw new BadRequestException('decision must be approve / reject');
    }
    const userId = req.user?.sub;
    const role = req.user?.role;
    if (!userId || !role) throw new ForbiddenException('JWT sub/role required');
    const result = await this.refundRepo.decideInDb(body.tenantSchema, {
      id: refundId,
      decision: body.decision,
      approverUserId: userId,
      approverRole: role,
      decisionReason: body.decisionReason || '',
    });
    if (!result) {
      throw new BadRequestException(`refund ${refundId} not pending or not found`);
    }
    return result;
  }

  /**
   * POST /api/db/refunds/pending — list 待审退费 (财务工作台主入口)
   *
   * RBAC: finance / boss / admin (SSOT §4.4 教学人员禁看)
   * campusId optional: finance 默认 jwt.campusId 自动过滤; boss/admin 可选
   */
  @Post('pending')
  @UseGuards(RbacGuard)
  @Roles('finance', 'boss', 'admin')
  @HttpCode(HttpStatus.OK)
  async listPending(
    @Body() body: { tenantSchema: string; campusId?: string; limit?: number; offset?: number },
    @Req() req: AuthenticatedRequest,
  ): Promise<RefundOrder[]> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    // finance 角色强制 jwt.campusId scope (防跨校查看)
    let campusId = body.campusId;
    if (req.user?.role === 'finance' && req.user.campusId) {
      campusId = req.user.campusId;
    }
    return this.refundRepo.listPendingInDb(body.tenantSchema, {
      campusId,
      limit: body.limit,
      offset: body.offset,
    });
  }

  /**
   * POST /api/db/refunds/list — 历史 list (含已批 / 已驳回)
   *
   * RBAC: finance / boss / admin
   */
  @Post('list')
  @UseGuards(RbacGuard)
  @Roles('finance', 'boss', 'admin')
  @HttpCode(HttpStatus.OK)
  async list(
    @Body() body: {
      tenantSchema: string;
      campusId?: string;
      status?: RefundStatus;
      limit?: number;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<RefundOrder[]> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    let campusId = body.campusId;
    if (req.user?.role === 'finance' && req.user.campusId) {
      campusId = req.user.campusId;
    }
    return this.refundRepo.listInDb(body.tenantSchema, {
      campusId,
      status: body.status,
      limit: body.limit,
    });
  }

  /**
   * GET /api/db/refunds/:refundId — find by id
   */
  @Get(':refundId')
  @UseGuards(RbacGuard)
  @Roles('finance', 'boss', 'admin')
  @HttpCode(HttpStatus.OK)
  async find(
    @Param('refundId') refundId: string,
    @Query('tenantSchema') tenantSchema: string,
  ): Promise<RefundOrder> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const result = await this.refundRepo.findByIdInDb(tenantSchema, refundId);
    if (!result) throw new BadRequestException(`refund ${refundId} not found`);
    return result;
  }
}
