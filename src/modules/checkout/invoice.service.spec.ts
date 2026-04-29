import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { InvoiceService } from './invoice.service';

const ULID_32 = '01HRX5Y3K2NQVWGT7ABCDEFGHJKMNP00';

describe('InvoiceService (W2-T5 A04 §4 + A11)', () => {
  let service: InvoiceService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [InvoiceService],
    }).compile();
    service = module.get<InvoiceService>(InvoiceService);
  });

  describe('validateInvoiceRequest', () => {
    const valid = {
      orderId: ULID_32,
      invoiceTitle: '北京某某教育科技有限公司',
      taxNumber: '91110108MA01XXXX12',
      contactEmail: 'finance@example.com',
      remark: '增值税普票',
    };

    it('accepts valid full input', () => {
      expect(() => service.validateInvoiceRequest(valid)).not.toThrow();
    });

    it('accepts minimal input (only orderId + invoiceTitle)', () => {
      expect(() => service.validateInvoiceRequest({ orderId: ULID_32, invoiceTitle: '抬头' })).not.toThrow();
    });

    it('rejects non-ULID orderId', () => {
      expect(() => service.validateInvoiceRequest({ ...valid, orderId: 'short' })).toThrow(BadRequestException);
    });

    it('rejects empty invoiceTitle', () => {
      expect(() => service.validateInvoiceRequest({ ...valid, invoiceTitle: '' })).toThrow(/NOT NULL/);
    });

    it('rejects whitespace-only invoiceTitle', () => {
      expect(() => service.validateInvoiceRequest({ ...valid, invoiceTitle: '   ' })).toThrow();
    });

    it('rejects invoiceTitle > 128 chars', () => {
      expect(() => service.validateInvoiceRequest({ ...valid, invoiceTitle: 'x'.repeat(129) })).toThrow(/128/);
    });

    it('rejects taxNumber > 32 chars', () => {
      expect(() => service.validateInvoiceRequest({ ...valid, taxNumber: 'x'.repeat(33) })).toThrow(/32/);
    });

    it('accepts null/undefined taxNumber', () => {
      expect(() => service.validateInvoiceRequest({ ...valid, taxNumber: null })).not.toThrow();
      expect(() => service.validateInvoiceRequest({ ...valid, taxNumber: undefined })).not.toThrow();
    });

    it('rejects contactEmail without @', () => {
      expect(() => service.validateInvoiceRequest({ ...valid, contactEmail: 'no-at-sign' })).toThrow(/@/);
    });

    it('accepts empty string contactEmail (treated as not provided)', () => {
      expect(() => service.validateInvoiceRequest({ ...valid, contactEmail: '' })).not.toThrow();
    });

    it('rejects contactEmail > 128 chars', () => {
      // 123 + 6 = 129 chars > 128 limit
      expect(() => service.validateInvoiceRequest({ ...valid, contactEmail: 'x'.repeat(123) + '@a.com' })).toThrow(/128/);
    });

    it('rejects remark > 256 chars', () => {
      expect(() => service.validateInvoiceRequest({ ...valid, remark: 'x'.repeat(257) })).toThrow(/256/);
    });
  });

  describe('assertTransition (5-state machine A04 §4)', () => {
    it('待审核 → 已批准 ✓', () => {
      expect(() => service.assertTransition('待审核', '已批准')).not.toThrow();
    });

    it('待审核 → 已拒绝 ✓', () => {
      expect(() => service.assertTransition('待审核', '已拒绝')).not.toThrow();
    });

    it('已批准 → 已开具 ✓ (开票成功)', () => {
      expect(() => service.assertTransition('已批准', '已开具')).not.toThrow();
    });

    it('已批准 → 已拒绝 ✓ (开票失败)', () => {
      expect(() => service.assertTransition('已批准', '已拒绝')).not.toThrow();
    });

    it('已开具 → 红冲处理中 ✓ (A04 §4.3.4 已开票后退款)', () => {
      expect(() => service.assertTransition('已开具', '红冲处理中')).not.toThrow();
    });

    it('红冲处理中 → 已拒绝 ✓ (红冲完成=作废)', () => {
      expect(() => service.assertTransition('红冲处理中', '已拒绝')).not.toThrow();
    });

    it('待审核 → 已开具 ✗ (skip 已批准)', () => {
      expect(() => service.assertTransition('待审核', '已开具')).toThrow(ConflictException);
    });

    it('已开具 → 已批准 ✗ (no rollback to approved)', () => {
      expect(() => service.assertTransition('已开具', '已批准')).toThrow(ConflictException);
    });

    it('已拒绝 → 任何 ✗ (terminal)', () => {
      expect(() => service.assertTransition('已拒绝', '待审核')).toThrow(ConflictException);
      expect(() => service.assertTransition('已拒绝', '已批准')).toThrow(ConflictException);
    });

    it('rejects unknown source state', () => {
      expect(() => service.assertTransition('未知' as never, '已批准')).toThrow(BadRequestException);
    });

    it('rejects unknown target state', () => {
      expect(() => service.assertTransition('待审核', '未知' as never)).toThrow(BadRequestException);
    });
  });

  describe('assertReviewerRole (A11 §3.1)', () => {
    it('accepts finance_admin / platform_admin', () => {
      expect(() => service.assertReviewerRole('finance_admin')).not.toThrow();
      expect(() => service.assertReviewerRole('platform_admin')).not.toThrow();
    });

    it('rejects tenant roles', () => {
      expect(() => service.assertReviewerRole('sales')).toThrow(ForbiddenException);
      expect(() => service.assertReviewerRole('boss')).toThrow(ForbiddenException);
      expect(() => service.assertReviewerRole('admin')).toThrow(ForbiddenException);
    });
  });

  describe('isTerminal', () => {
    it('已拒绝 is terminal', () => {
      expect(service.isTerminal('已拒绝')).toBe(true);
    });

    it('待审核 / 已批准 / 已开具 / 红冲处理中 are not terminal', () => {
      expect(service.isTerminal('待审核')).toBe(false);
      expect(service.isTerminal('已批准')).toBe(false);
      expect(service.isTerminal('已开具')).toBe(false);
      expect(service.isTerminal('红冲处理中')).toBe(false);
    });
  });
});
