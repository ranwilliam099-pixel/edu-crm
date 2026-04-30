import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import {
  TenantLifecycleService,
  TenantLifecycleState,
} from '../tenant/tenant-lifecycle.service';

/**
 * AdminTenantService — W3-1 Phase 4 BE-W4-1 平台超管 API
 *
 * 来源：
 *   - 《全部人员-审核往来总台账.md》条目 14 §B Track CODE-4 BE-W4-1
 *   - AUTH-7 A11 §3.4 平台超管 API：租户列表 / 详情 / 冻结 / 解冻 / 退款审批 / 发票审批 / 保留标记
 *
 * PM-AUTH-7(2026-04-30): 平台超管 API 骨架
 *
 * 严守边界：
 *   - 不真实连 DB；所有 list/get/freeze/unfreeze 接受外部传入的数据 + 返回应执行的 action
 *   - 由调用方（Controller）实际查 PG / 写 PG
 *   - 状态机推进委托 TenantLifecycleService
 */

export interface TenantListItem {
  tenantId: string;
  name: string;
  sku: string;
  state: TenantLifecycleState;
  expiresAt: Date;
  campusCount: number;
  accountCount: number;
}

export interface TenantDetailItem extends TenantListItem {
  createdAt: Date;
  contactPhone?: string;
  reservedFlag: boolean;
  paymentOrdersCount: number;
  reverseOrdersCount: number;
}

export interface FreezeAction {
  tenantId: string;
  fromState: TenantLifecycleState;
  toState: TenantLifecycleState;
  reason: string;
  executedAt: Date;
  operator: string;
}

export interface UnfreezeAction {
  tenantId: string;
  fromState: TenantLifecycleState;
  toState: TenantLifecycleState;
  executedAt: Date;
  operator: string;
}

export interface RefundApprovalAction {
  refundOrderId: string;
  decision: 'approve' | 'reject';
  reason: string;
  approverRole: 'platform_admin' | 'finance_admin';
  approverId: string;
}

export interface InvoiceApprovalAction {
  invoiceId: string;
  decision: 'approve' | 'reject';
  reason: string;
  approverRole: 'finance_admin';
  approverId: string;
}

export interface ReserveFlagAction {
  tenantId: string;
  reservedFlag: boolean;
  reason: string;
  operator: string;
  executedAt: Date;
}

@Injectable()
export class AdminTenantService {
  private readonly logger = new Logger(AdminTenantService.name);

  constructor(private readonly lifecycle: TenantLifecycleService) {}

  /**
   * 平台超管手动冻结租户
   *
   * PM-AUTH-7(2026-04-30): A11 §3.4 平台超管冻结
   *
   * @returns 应执行的状态推进 action（由调用方真实更新 DB）
   */
  freezeTenant(input: {
    tenantId: string;
    currentState: TenantLifecycleState;
    reason: string;
    operatorId: string;
  }): FreezeAction {
    if (!input.tenantId || input.tenantId.length !== 32) {
      throw new BadRequestException('tenantId must be 32-char ULID');
    }
    if (!input.reason) {
      throw new BadRequestException('reason required (A11 §3.4 audit)');
    }
    if (!input.operatorId) {
      throw new BadRequestException('operatorId required (A11 §3.4 audit)');
    }
    // assertTransition 抛 ConflictException 由调用方传播
    this.lifecycle.assertTransition(input.currentState, 'frozen');
    const now = new Date();
    this.logger.log(
      `[BE-W4-1] freezeTenant tenantId=${input.tenantId} ${input.currentState}→frozen by=${input.operatorId} reason="${input.reason}"`,
    );
    return {
      tenantId: input.tenantId,
      fromState: input.currentState,
      toState: 'frozen',
      reason: input.reason,
      executedAt: now,
      operator: input.operatorId,
    };
  }

  /**
   * 平台超管解冻租户
   *
   * PM-AUTH-7(2026-04-30): A11 §3.4
   */
  unfreezeTenant(input: {
    tenantId: string;
    currentState: TenantLifecycleState;
    operatorId: string;
  }): UnfreezeAction {
    if (!input.tenantId || input.tenantId.length !== 32) {
      throw new BadRequestException('tenantId must be 32-char ULID');
    }
    if (!input.operatorId) {
      throw new BadRequestException('operatorId required');
    }
    this.lifecycle.assertTransition(input.currentState, 'active');
    return {
      tenantId: input.tenantId,
      fromState: input.currentState,
      toState: 'active',
      executedAt: new Date(),
      operator: input.operatorId,
    };
  }

  /**
   * 退款审批（platform_admin / finance_admin 双签字）
   *
   * PM-AUTH-7(2026-04-30): A11 §3.1 双角色
   */
  approveRefund(input: RefundApprovalAction): RefundApprovalAction {
    if (!input.refundOrderId || input.refundOrderId.length !== 32) {
      throw new BadRequestException('refundOrderId must be 32-char ULID');
    }
    if (!['approve', 'reject'].includes(input.decision)) {
      throw new BadRequestException('decision must be approve / reject');
    }
    if (!['platform_admin', 'finance_admin'].includes(input.approverRole)) {
      throw new BadRequestException('approverRole must be platform_admin / finance_admin');
    }
    if (!input.reason) {
      throw new BadRequestException('reason required');
    }
    this.logger.log(
      `[BE-W4-1] approveRefund refundOrderId=${input.refundOrderId} ${input.decision} by=${input.approverRole}/${input.approverId}`,
    );
    return input;
  }

  /**
   * 发票审批（finance_admin）
   */
  approveInvoice(input: InvoiceApprovalAction): InvoiceApprovalAction {
    if (!input.invoiceId || input.invoiceId.length !== 32) {
      throw new BadRequestException('invoiceId must be 32-char ULID');
    }
    if (input.approverRole !== 'finance_admin') {
      throw new BadRequestException('Only finance_admin can approve invoice');
    }
    return input;
  }

  /**
   * 保留标记（A11 §3.4）— 标记租户保留期，避免被 cleanup
   */
  setReserveFlag(input: ReserveFlagAction): ReserveFlagAction {
    if (!input.tenantId || input.tenantId.length !== 32) {
      throw new BadRequestException('tenantId must be 32-char ULID');
    }
    if (!input.reason) {
      throw new BadRequestException('reason required (A11 audit)');
    }
    return input;
  }

  /**
   * 列表过滤 helper（按状态 / SKU / 容量过滤）
   */
  filterTenants(
    tenants: ReadonlyArray<TenantListItem>,
    filter: { state?: TenantLifecycleState; sku?: string; minAccounts?: number },
  ): TenantListItem[] {
    return tenants.filter((t) => {
      if (filter.state && t.state !== filter.state) return false;
      if (filter.sku && t.sku !== filter.sku) return false;
      if (filter.minAccounts !== undefined && t.accountCount < filter.minAccounts) return false;
      return true;
    });
  }
}
