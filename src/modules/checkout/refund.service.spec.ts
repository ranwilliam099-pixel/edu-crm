import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { RefundService } from './refund.service';

const ULID_32 = '01HRX5Y3K2NQVWGT7ABCDEFGHJKMNP00';

describe('RefundService (W2-T4 A04 §3 + A11)', () => {
  let service: RefundService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [RefundService],
    }).compile();
    service = module.get<RefundService>(RefundService);
  });

  describe('validateRefundRequest', () => {
    const valid = { orderId: ULID_32, refundAmountCents: 50000, reason: '客户申请部分退款' };

    it('accepts valid input', () => {
      expect(() => service.validateRefundRequest(valid)).not.toThrow();
    });

    it('rejects non-ULID orderId', () => {
      expect(() => service.validateRefundRequest({ ...valid, orderId: 'short' })).toThrow(BadRequestException);
    });

    it('rejects zero amount', () => {
      expect(() => service.validateRefundRequest({ ...valid, refundAmountCents: 0 })).toThrow();
    });

    it('rejects negative amount', () => {
      expect(() => service.validateRefundRequest({ ...valid, refundAmountCents: -100 })).toThrow();
    });

    it('rejects non-integer amount', () => {
      expect(() => service.validateRefundRequest({ ...valid, refundAmountCents: 1.5 })).toThrow();
    });

    it('rejects empty reason (A04 §3)', () => {
      expect(() => service.validateRefundRequest({ ...valid, reason: '' })).toThrow(/A04/);
    });

    it('rejects whitespace-only reason', () => {
      expect(() => service.validateRefundRequest({ ...valid, reason: '   ' })).toThrow();
    });

    it('rejects reason > 256 chars (V1 SQL VARCHAR(256))', () => {
      expect(() => service.validateRefundRequest({ ...valid, reason: 'x'.repeat(257) })).toThrow(/256/);
    });
  });

  describe('assertWithinBudget (A04 §3 business rule 2)', () => {
    it('passes when refund ≤ remaining', () => {
      expect(() => service.assertWithinBudget(100000, 0, 100000)).not.toThrow();
      expect(() => service.assertWithinBudget(100000, 30000, 70000)).not.toThrow();
    });

    it('rejects refund > remaining', () => {
      expect(() => service.assertWithinBudget(100000, 30000, 70001)).toThrow(ConflictException);
    });

    it('rejects refund > total when nothing refunded yet', () => {
      expect(() => service.assertWithinBudget(100000, 0, 100001)).toThrow(ConflictException);
    });

    it('rejects negative alreadyRefunded', () => {
      expect(() => service.assertWithinBudget(100000, -1, 50000)).toThrow(BadRequestException);
    });
  });

  describe('assertTransition (4-state machine)', () => {
    it('待审核 → 已批准 ✓', () => {
      expect(() => service.assertTransition('待审核', '已批准')).not.toThrow();
    });

    it('待审核 → 已拒绝 ✓', () => {
      expect(() => service.assertTransition('待审核', '已拒绝')).not.toThrow();
    });

    it('已批准 → 已退款 ✓ (wxpay refund callback success)', () => {
      expect(() => service.assertTransition('已批准', '已退款')).not.toThrow();
    });

    it('已批准 → 已拒绝 ✓ (refund failed rollback)', () => {
      expect(() => service.assertTransition('已批准', '已拒绝')).not.toThrow();
    });

    it('待审核 → 已退款 ✗ (skip 已批准)', () => {
      expect(() => service.assertTransition('待审核', '已退款')).toThrow(ConflictException);
    });

    it('已退款 → 任何 ✗ (terminal)', () => {
      expect(() => service.assertTransition('已退款', '已批准')).toThrow(ConflictException);
    });

    it('已拒绝 → 任何 ✗ (terminal)', () => {
      expect(() => service.assertTransition('已拒绝', '待审核')).toThrow(ConflictException);
    });
  });

  describe('assertReviewerRole (A11 §3.1)', () => {
    it('accepts finance_admin', () => {
      expect(() => service.assertReviewerRole('finance_admin')).not.toThrow();
    });

    it('accepts platform_admin', () => {
      expect(() => service.assertReviewerRole('platform_admin')).not.toThrow();
    });

    it('rejects sales (tenant role)', () => {
      expect(() => service.assertReviewerRole('sales')).toThrow(ForbiddenException);
    });

    it('rejects boss (tenant role, A11 cross-cutting)', () => {
      expect(() => service.assertReviewerRole('boss')).toThrow(ForbiddenException);
    });
  });

  describe('requiresRedBlue (A04 §4.3.4)', () => {
    it('returns true for invoiced order (manual red-blue)', () => {
      expect(service.requiresRedBlue('已开具')).toBe(true);
    });

    it('returns false for non-invoiced order', () => {
      expect(service.requiresRedBlue('未申请')).toBe(false);
      expect(service.requiresRedBlue('待审核')).toBe(false);
      expect(service.requiresRedBlue('已批准')).toBe(false);
    });
  });

  describe('isTerminal', () => {
    it('已退款 / 已拒绝 are terminal', () => {
      expect(service.isTerminal('已退款')).toBe(true);
      expect(service.isTerminal('已拒绝')).toBe(true);
    });

    it('待审核 / 已批准 are not terminal', () => {
      expect(service.isTerminal('待审核')).toBe(false);
      expect(service.isTerminal('已批准')).toBe(false);
    });
  });
});
