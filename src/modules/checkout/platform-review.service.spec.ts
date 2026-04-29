import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { PlatformReviewService } from './platform-review.service';
import { RefundService } from './refund.service';
import { InvoiceService } from './invoice.service';

const ULID_32 = '01HRX5Y3K2NQVWGT7ABCDEFGHJKMNP00';
const ULID_32_T = '01HRX5Y3K2NQVWGT7ABCDEFGHJKMNP01';

describe('PlatformReviewService (W2-T6 A11 §3.1)', () => {
  let service: PlatformReviewService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PlatformReviewService, RefundService, InvoiceService],
    }).compile();
    service = module.get<PlatformReviewService>(PlatformReviewService);
  });

  describe('approveRefund', () => {
    it('finance_admin can approve 待审核 → 已批准', () => {
      const entry = service.approveRefund({
        operatorId: ULID_32,
        reviewerRole: 'finance_admin',
        targetTenantId: ULID_32_T,
        fromState: '待审核',
      });
      expect(entry.action).toBe('批准退款');
      expect(entry.operatorId).toBe(ULID_32);
      expect(entry.targetTenantId).toBe(ULID_32_T);
    });

    it('platform_admin can approve', () => {
      const entry = service.approveRefund({
        operatorId: ULID_32,
        reviewerRole: 'platform_admin',
        fromState: '待审核',
      });
      expect(entry.targetTenantId).toBeNull();
    });

    it('sales role rejected (A11 §3.1)', () => {
      expect(() =>
        service.approveRefund({
          operatorId: ULID_32,
          reviewerRole: 'sales',
          fromState: '待审核',
        }),
      ).toThrow(ForbiddenException);
    });

    it('cannot approve from terminal state (已退款)', () => {
      expect(() =>
        service.approveRefund({
          operatorId: ULID_32,
          reviewerRole: 'finance_admin',
          fromState: '已退款',
        }),
      ).toThrow(ConflictException);
    });
  });

  describe('rejectRefund', () => {
    it('rejects 待审核 → 已拒绝', () => {
      const entry = service.rejectRefund({
        operatorId: ULID_32,
        reviewerRole: 'platform_admin',
        fromState: '待审核',
      });
      expect(entry.action).toBe('拒绝退款');
    });

    it('rejects 已批准 → 已拒绝 (rollback)', () => {
      expect(() =>
        service.rejectRefund({
          operatorId: ULID_32,
          reviewerRole: 'platform_admin',
          fromState: '已批准',
        }),
      ).not.toThrow();
    });
  });

  describe('approveInvoice', () => {
    it('finance_admin approves 待审核 → 已批准', () => {
      const entry = service.approveInvoice({
        operatorId: ULID_32,
        reviewerRole: 'finance_admin',
        fromState: '待审核',
      });
      expect(entry.action).toBe('批准开票');
    });

    it('rejects from 已开具 (illegal transition)', () => {
      expect(() =>
        service.approveInvoice({
          operatorId: ULID_32,
          reviewerRole: 'finance_admin',
          fromState: '已开具',
        }),
      ).toThrow(ConflictException);
    });
  });

  describe('rejectInvoice', () => {
    it('rejects 待审核 → 已拒绝', () => {
      const entry = service.rejectInvoice({
        operatorId: ULID_32,
        reviewerRole: 'platform_admin',
        fromState: '待审核',
      });
      expect(entry.action).toBe('拒绝开票');
    });
  });

  describe('triggerInvoiceRedBlue (A04 §4.3.4)', () => {
    it('platform_admin can trigger 已开具 → 红冲处理中', () => {
      const entry = service.triggerInvoiceRedBlue({
        operatorId: ULID_32,
        reviewerRole: 'platform_admin',
        fromState: '已开具',
      });
      expect(entry.meta.redBlueTriggered).toBe(true);
      expect(entry.meta.fromState).toBe('已开具');
    });

    it('finance_admin cannot trigger redBlue (platform_admin only)', () => {
      expect(() =>
        service.triggerInvoiceRedBlue({
          operatorId: ULID_32,
          reviewerRole: 'finance_admin',
          fromState: '已开具',
        }),
      ).toThrow(/platform_admin/);
    });

    it('cannot redBlue from non-issued state', () => {
      expect(() =>
        service.triggerInvoiceRedBlue({
          operatorId: ULID_32,
          reviewerRole: 'platform_admin',
          fromState: '待审核',
        }),
      ).toThrow(ConflictException);
    });
  });

  describe('audit log construction (V1 SQL §2.6)', () => {
    it('rejects non-ULID operatorId', () => {
      expect(() =>
        service.approveRefund({
          operatorId: 'short',
          reviewerRole: 'finance_admin',
          fromState: '待审核',
        }),
      ).toThrow(BadRequestException);
    });

    it('accepts null targetTenantId (cross-tenant platform action)', () => {
      const entry = service.approveRefund({
        operatorId: ULID_32,
        reviewerRole: 'platform_admin',
        targetTenantId: null,
        fromState: '待审核',
      });
      expect(entry.targetTenantId).toBeNull();
    });

    it('rejects malformed targetTenantId', () => {
      expect(() =>
        service.approveRefund({
          operatorId: ULID_32,
          reviewerRole: 'platform_admin',
          targetTenantId: 'short',
          fromState: '待审核',
        }),
      ).toThrow(BadRequestException);
    });

    it('preserves meta JSONB payload', () => {
      const meta = { reason: '测试备注', orderId: 'X' };
      const entry = service.approveRefund({
        operatorId: ULID_32,
        reviewerRole: 'finance_admin',
        fromState: '待审核',
        meta,
      });
      expect(entry.meta).toEqual(meta);
    });
  });
});
