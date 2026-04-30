import { Body, Controller, Post, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { AdminTenantService } from './admin-tenant.service';
import { Roles } from '../../guards/rbac.decorator';
import { RbacGuard } from '../../guards/rbac.guard';

/**
 * AdminRefundController — W3-1 Phase 4 BE-W4-1 退款 / 发票审批
 *
 * 来源：
 *   - AUTH-7 A11 §3.1 双角色：退款审批 = platform_admin / finance_admin；发票审批 = finance_admin only
 *
 * PM-AUTH-7(2026-04-30)
 */
@Controller('admin')
@UseGuards(RbacGuard)
export class AdminRefundController {
  constructor(private readonly service: AdminTenantService) {}

  /**
   * POST /api/admin/refunds/approve
   */
  @Post('refunds/approve')
  @Roles('platform_admin', 'finance_admin')
  @HttpCode(HttpStatus.OK)
  approveRefund(
    @Body()
    body: {
      refundOrderId: string;
      decision: 'approve' | 'reject';
      reason: string;
      approverRole: 'platform_admin' | 'finance_admin';
      approverId: string;
    },
  ) {
    return this.service.approveRefund(body);
  }

  /**
   * POST /api/admin/invoices/approve
   * 仅 finance_admin
   */
  @Post('invoices/approve')
  @Roles('finance_admin')
  @HttpCode(HttpStatus.OK)
  approveInvoice(
    @Body()
    body: {
      invoiceId: string;
      decision: 'approve' | 'reject';
      reason: string;
      approverRole: 'finance_admin';
      approverId: string;
    },
  ) {
    return this.service.approveInvoice(body);
  }
}
