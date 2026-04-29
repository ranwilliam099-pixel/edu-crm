import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { PaymentOrderStateService } from './payment-order-state.service';

describe('PaymentOrderStateService (W2-T2 A04 §5.1)', () => {
  let service: PaymentOrderStateService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PaymentOrderStateService],
    }).compile();
    service = module.get<PaymentOrderStateService>(PaymentOrderStateService);
  });

  describe('assertTransition (legal edges)', () => {
    it('待支付 → 已支付 (微信回调成功)', () => {
      expect(() => service.assertTransition('待支付', '已支付')).not.toThrow();
    });

    it('待支付 → 已取消 (用户取消/超时)', () => {
      expect(() => service.assertTransition('待支付', '已取消')).not.toThrow();
    });

    it('已支付 → 退款处理中 (A04 §3)', () => {
      expect(() => service.assertTransition('已支付', '退款处理中')).not.toThrow();
    });

    it('退款处理中 → 已退款 (退款回调成功)', () => {
      expect(() => service.assertTransition('退款处理中', '已退款')).not.toThrow();
    });

    it('退款处理中 → 已支付 (退款失败回滚, A04 §5.2 ABNORMAL)', () => {
      expect(() => service.assertTransition('退款处理中', '已支付')).not.toThrow();
    });
  });

  describe('assertTransition (illegal edges throw ConflictException)', () => {
    it('待支付 → 已退款 (skip 已支付)', () => {
      expect(() => service.assertTransition('待支付', '已退款')).toThrow(ConflictException);
    });

    it('待支付 → 退款处理中 (skip 已支付)', () => {
      expect(() => service.assertTransition('待支付', '退款处理中')).toThrow(ConflictException);
    });

    it('已支付 → 已退款 (skip 退款处理中)', () => {
      expect(() => service.assertTransition('已支付', '已退款')).toThrow(ConflictException);
    });

    it('已支付 → 已取消 (paid 锁: 已支付不可直接取消)', () => {
      expect(() => service.assertTransition('已支付', '已取消')).toThrow(ConflictException);
    });

    it('已退款 → 任何 (terminal, A12 paid 锁)', () => {
      expect(() => service.assertTransition('已退款', '已支付')).toThrow(ConflictException);
      expect(() => service.assertTransition('已退款', '退款处理中')).toThrow(ConflictException);
    });

    it('已取消 → 任何 (terminal)', () => {
      expect(() => service.assertTransition('已取消', '待支付')).toThrow(ConflictException);
      expect(() => service.assertTransition('已取消', '已支付')).toThrow(ConflictException);
    });

    it('idempotent same-state self-transition rejected (待支付 → 待支付)', () => {
      expect(() => service.assertTransition('待支付', '待支付')).toThrow(ConflictException);
    });
  });

  describe('assertTransition (input validation)', () => {
    it('rejects unknown source state', () => {
      expect(() => service.assertTransition('未知' as never, '已支付')).toThrow(BadRequestException);
    });

    it('rejects unknown target state', () => {
      expect(() => service.assertTransition('待支付', '未知' as never)).toThrow(BadRequestException);
    });
  });

  describe('isTerminal', () => {
    it('已退款 / 已取消 are terminal', () => {
      expect(service.isTerminal('已退款')).toBe(true);
      expect(service.isTerminal('已取消')).toBe(true);
    });

    it('待支付 / 已支付 / 退款处理中 are not terminal', () => {
      expect(service.isTerminal('待支付')).toBe(false);
      expect(service.isTerminal('已支付')).toBe(false);
      expect(service.isTerminal('退款处理中')).toBe(false);
    });
  });

  describe('legalTargets', () => {
    it('returns [已支付, 已取消] for 待支付', () => {
      expect(service.legalTargets('待支付')).toEqual(['已支付', '已取消']);
    });

    it('returns [] for terminal states', () => {
      expect(service.legalTargets('已退款')).toEqual([]);
      expect(service.legalTargets('已取消')).toEqual([]);
    });
  });
});
