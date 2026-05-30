/**
 * RefundController 单测 — #24 B 端自由文本内容安全接入（apply.reason / decide.decisionReason）
 *
 * 范围（本 spec 聚焦 #24，兼带构造/基础校验回归）：
 *   - POST /db/refunds/apply：reason 过 enforceStaffText（happy + risky→400 不写库）
 *   - POST /db/refunds/:refundId/decide：decisionReason 过 enforceStaffText（happy + risky→400 不写库）
 *
 * 红线：
 *   - enforceStaffText 必须先于 repo 写库（违规内容不落库）
 *   - mode 默认 'reject'：risky → BadRequestException
 *   - 审计不写明文由 ContentModerationService 内部负责（此处不验明文）
 */

import { BadRequestException } from '@nestjs/common';
import { RefundController } from './refund.controller';
import { RefundOrder, RefundRepository } from './refund.repository';
import { ContentModerationService } from '../security/content-moderation.service';
import { AuthenticatedRequest, JwtPayload, TenantRole } from '../auth/jwt-payload.interface';

describe('RefundController (#24 内容安全)', () => {
  let controller: RefundController;
  let refundRepo: { createInDb: jest.Mock; decideInDb: jest.Mock };
  let contentModeration: { enforceStaffText: jest.Mock };

  const TENANT_ID = 'TENANTA00000000000000000000000A1';
  const TENANT_SCHEMA = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const CAMPUS_ID = 'campus_A0000000000000000000000A01';
  const FINANCE_USER = 'financeUser0000000000000000000A1';
  const SALES_USER = 'salesUser000000000000000000000A1';
  const REFUND_ID = 'refund0000000000000000000000000A1';
  const CONTRACT_ID = 'contract000000000000000000000A01';
  const STUDENT_ID = 'student00000000000000000000000A1';
  const CUSTOMER_ID = 'customer0000000000000000000000A1';

  function jwt(role: TenantRole, sub: string): JwtPayload {
    return { sub, tenantId: TENANT_ID, role, campusId: CAMPUS_ID };
  }

  function req(user?: JwtPayload): AuthenticatedRequest {
    return { user, headers: {}, body: {}, query: {}, params: {} } as AuthenticatedRequest;
  }

  function refundFixture(overrides: Partial<RefundOrder> = {}): RefundOrder {
    return {
      id: REFUND_ID,
      contractId: CONTRACT_ID,
      studentId: STUDENT_ID,
      customerId: CUSTOMER_ID,
      amount: 1000,
      reason: '家庭原因',
      applicantUserId: SALES_USER,
      applicantRole: 'sales',
      appliedAt: new Date('2026-05-30T00:00:00.000Z'),
      status: 'pending',
      approverUserId: null,
      approverRole: null,
      decidedAt: null,
      decisionReason: null,
      campusId: CAMPUS_ID,
      ...overrides,
    };
  }

  beforeEach(() => {
    refundRepo = { createInDb: jest.fn(), decideInDb: jest.fn() };
    contentModeration = { enforceStaffText: jest.fn().mockResolvedValue(undefined) };
    controller = new RefundController(
      refundRepo as unknown as RefundRepository,
      contentModeration as unknown as ContentModerationService,
    );
  });

  // ============================================================
  // POST /db/refunds/apply — reason 自由文本
  // ============================================================
  describe('apply — #24 reason 内容安全', () => {
    const applyBody = {
      id: REFUND_ID,
      contractId: CONTRACT_ID,
      studentId: STUDENT_ID,
      customerId: CUSTOMER_ID,
      amount: 1000,
      reason: '孩子升学搬家，无法继续上课',
      campusId: CAMPUS_ID,
      tenantSchema: TENANT_SCHEMA,
    };

    it('happy → enforceStaffText 收 [reason] + ctx（action=refund / refund_order / targetId=body.id），写库前调', async () => {
      refundRepo.createInDb.mockResolvedValueOnce(refundFixture());

      await controller.apply(applyBody, req(jwt('sales', SALES_USER)));

      expect(contentModeration.enforceStaffText).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        ['孩子升学搬家，无法继续上课'],
        expect.objectContaining({
          action: 'refund',
          targetType: 'refund_order',
          targetId: REFUND_ID,
        }),
      );
      // 校验在写库前（enforceStaffText 先于 createInDb）
      const modOrder = contentModeration.enforceStaffText.mock.invocationCallOrder[0];
      const writeOrder = refundRepo.createInDb.mock.invocationCallOrder[0];
      expect(modOrder).toBeLessThan(writeOrder);
    });

    it('risky → enforceStaffText 抛 400，不写库', async () => {
      contentModeration.enforceStaffText.mockRejectedValueOnce(
        new BadRequestException('content violates content policy'),
      );

      await expect(
        controller.apply(applyBody, req(jwt('sales', SALES_USER))),
      ).rejects.toThrow(BadRequestException);
      expect(refundRepo.createInDb).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // POST /db/refunds/:refundId/decide — decisionReason 自由文本
  // ============================================================
  describe('decide — #24 decisionReason 内容安全', () => {
    const decideBody = {
      decision: 'approve' as const,
      decisionReason: '核实无误，同意退费',
      tenantSchema: TENANT_SCHEMA,
    };

    it('happy → enforceStaffText 收 [decisionReason] + ctx（targetId=refundId），写库前调', async () => {
      refundRepo.decideInDb.mockResolvedValueOnce(
        refundFixture({ status: 'approved', approverUserId: FINANCE_USER }),
      );

      await controller.decide(REFUND_ID, decideBody, req(jwt('finance', FINANCE_USER)));

      expect(contentModeration.enforceStaffText).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        ['核实无误，同意退费'],
        expect.objectContaining({
          action: 'refund',
          targetType: 'refund_order',
          targetId: REFUND_ID,
        }),
      );
      const modOrder = contentModeration.enforceStaffText.mock.invocationCallOrder[0];
      const writeOrder = refundRepo.decideInDb.mock.invocationCallOrder[0];
      expect(modOrder).toBeLessThan(writeOrder);
    });

    it('risky → enforceStaffText 抛 400，不写库', async () => {
      contentModeration.enforceStaffText.mockRejectedValueOnce(
        new BadRequestException('content violates content policy'),
      );

      await expect(
        controller.decide(REFUND_ID, decideBody, req(jwt('finance', FINANCE_USER))),
      ).rejects.toThrow(BadRequestException);
      expect(refundRepo.decideInDb).not.toHaveBeenCalled();
    });

    it('decision 非法 → 400 且内容安全/写库均不触达（校验早于 enforceStaffText）', async () => {
      await expect(
        controller.decide(
          REFUND_ID,
          { decision: 'maybe' as unknown as 'approve', decisionReason: 'x', tenantSchema: TENANT_SCHEMA },
          req(jwt('finance', FINANCE_USER)),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(contentModeration.enforceStaffText).not.toHaveBeenCalled();
      expect(refundRepo.decideInDb).not.toHaveBeenCalled();
    });
  });
});
