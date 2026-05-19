import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { RevenueAdjustmentService } from './revenue-adjustment.service';

const ULID32_O = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNOO';
const ULID32_R = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNOR';

describe('RevenueAdjustmentService - PM-AUTH-7 A12 §4.5 报表口径', () => {
  let service: RevenueAdjustmentService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [RevenueAdjustmentService],
    }).compile();
    service = module.get<RevenueAdjustmentService>(RevenueAdjustmentService);
  });

  describe('refund - GMV/实收双冲减', () => {
    it('全额退款 1999 → GMV 冲减 1999, 实收 0', () => {
      const r = service.calculate({
        originalOrderId: ULID32_O,
        reverseOrderId: ULID32_R,
        type: 'refund',
        originalAmountCnyYuan: 1999,
        reverseAmountCnyYuan: 1999,
      });
      expect(r.gmvDeltaCnyYuan).toBe(1999);
      expect(r.actualRevenueDeltaCnyYuan).toBe(1999);
      expect(r.adjustedGmvCnyYuan).toBe(0);
      expect(r.adjustedActualRevenueCnyYuan).toBe(0);
    });

    it('部分退款 800 → 实收 1199', () => {
      const r = service.calculate({
        originalOrderId: ULID32_O,
        reverseOrderId: ULID32_R,
        type: 'refund',
        originalAmountCnyYuan: 1999,
        reverseAmountCnyYuan: 800,
      });
      expect(r.adjustedActualRevenueCnyYuan).toBe(1199);
    });

    it('退款金额超过原订单 → BadRequestException', () => {
      expect(() =>
        service.calculate({
          originalOrderId: ULID32_O,
          reverseOrderId: ULID32_R,
          type: 'refund',
          originalAmountCnyYuan: 1999,
          reverseAmountCnyYuan: 3000,
        }),
      ).toThrow(BadRequestException);
    });
  });

  describe('cancel - 退课全额冲减', () => {
    it('退课全额 → GMV 0, 实收 0', () => {
      const r = service.calculate({
        originalOrderId: ULID32_O,
        reverseOrderId: ULID32_R,
        type: 'cancel',
        originalAmountCnyYuan: 4999,
        reverseAmountCnyYuan: 4999,
      });
      expect(r.adjustedGmvCnyYuan).toBe(0);
    });

    it('cancel 金额超过原订单 → BadRequestException', () => {
      expect(() =>
        service.calculate({
          originalOrderId: ULID32_O,
          reverseOrderId: ULID32_R,
          type: 'cancel',
          originalAmountCnyYuan: 1999,
          reverseAmountCnyYuan: 5000,
        }),
      ).toThrow(BadRequestException);
    });
  });

  describe('transfer - GMV/实收不变', () => {
    it('转班 amount=0 → 不影响', () => {
      const r = service.calculate({
        originalOrderId: ULID32_O,
        reverseOrderId: ULID32_R,
        type: 'transfer',
        originalAmountCnyYuan: 1999,
        reverseAmountCnyYuan: 0,
      });
      expect(r.gmvDeltaCnyYuan).toBe(0);
      expect(r.actualRevenueDeltaCnyYuan).toBe(0);
      expect(r.adjustedGmvCnyYuan).toBe(1999);
    });

    it('transfer amount 非 0 → BadRequestException', () => {
      expect(() =>
        service.calculate({
          originalOrderId: ULID32_O,
          reverseOrderId: ULID32_R,
          type: 'transfer',
          originalAmountCnyYuan: 1999,
          reverseAmountCnyYuan: 100,
        }),
      ).toThrow(BadRequestException);
    });
  });

  describe('extend - 扩科补加', () => {
    it('扩科补缴 500 → GMV 补加 500, 实收 +500', () => {
      const r = service.calculate({
        originalOrderId: ULID32_O,
        reverseOrderId: ULID32_R,
        type: 'extend',
        originalAmountCnyYuan: 1999,
        reverseAmountCnyYuan: 500,
      });
      expect(r.gmvDeltaCnyYuan).toBe(-500);
      expect(r.actualRevenueDeltaCnyYuan).toBe(-500);
      expect(r.adjustedGmvCnyYuan).toBe(2499);
    });
  });

  describe('calculateBatch - 多笔累计', () => {
    it('refund 800 + cancel 200 + transfer 0 + extend 100 → 累计', () => {
      const result = service.calculateBatch([
        {
          originalOrderId: ULID32_O,
          reverseOrderId: ULID32_R,
          type: 'refund',
          originalAmountCnyYuan: 1999,
          reverseAmountCnyYuan: 800,
        },
        {
          originalOrderId: ULID32_O,
          reverseOrderId: '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNOS',
          type: 'cancel',
          originalAmountCnyYuan: 999,
          reverseAmountCnyYuan: 200,
        },
        {
          originalOrderId: ULID32_O,
          reverseOrderId: '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNOT',
          type: 'transfer',
          originalAmountCnyYuan: 1999,
          reverseAmountCnyYuan: 0,
        },
        {
          originalOrderId: ULID32_O,
          reverseOrderId: '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNOU',
          type: 'extend',
          originalAmountCnyYuan: 1999,
          reverseAmountCnyYuan: 100,
        },
      ]);
      expect(result.totalGmvDelta).toBe(800 + 200 + 0 - 100); // 900
      expect(result.totalActualRevenueDelta).toBe(900);
      expect(result.adjustments).toHaveLength(4);
    });
  });

  describe('输入校验', () => {
    it('originalOrderId 长度非 32 → BadRequestException', () => {
      expect(() =>
        service.calculate({
          originalOrderId: 'short',
          reverseOrderId: ULID32_R,
          type: 'refund',
          originalAmountCnyYuan: 1999,
          reverseAmountCnyYuan: 500,
        }),
      ).toThrow(BadRequestException);
    });

    it('originalAmountCnyYuan < 0 → BadRequestException', () => {
      expect(() =>
        service.calculate({
          originalOrderId: ULID32_O,
          reverseOrderId: ULID32_R,
          type: 'refund',
          originalAmountCnyYuan: -100,
          reverseAmountCnyYuan: 0,
        }),
      ).toThrow(BadRequestException);
    });
  });
});
