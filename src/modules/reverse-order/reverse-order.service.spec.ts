import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { ReverseOrderService, ReverseOrderState } from './reverse-order.service';

describe('ReverseOrderService - PM-AUTH-7 A12 4 类逆向单', () => {
  let service: ReverseOrderService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ReverseOrderService],
    }).compile();
    service = module.get<ReverseOrderService>(ReverseOrderService);
  });

  describe('assertType', () => {
    ['refund', 'transfer', 'extend', 'cancel'].forEach((t) => {
      it(`${t} 合法`, () => {
        expect(() => service.assertType(t)).not.toThrow();
      });
    });

    it('未知类型 → BadRequestException', () => {
      expect(() => service.assertType('unknown')).toThrow(BadRequestException);
    });
  });

  describe('assertTransition - 合法转换', () => {
    const legal: Array<[ReverseOrderState, ReverseOrderState]> = [
      ['待审核', '已批准'],
      ['待审核', '已拒绝'],
      ['待审核', '已取消'],
      ['已批准', '已执行'],
    ];
    legal.forEach(([from, to]) => {
      it(`${from} → ${to} 合法`, () => {
        expect(() => service.assertTransition(from, to)).not.toThrow();
      });
    });
  });

  describe('assertTransition - 非法转换（A12 paid 锁严守）', () => {
    const illegal: Array<[ReverseOrderState, ReverseOrderState]> = [
      ['待审核', '已执行'], // 必须先审批通过
      ['已批准', '已拒绝'], // 已通过不能再驳回
      ['已批准', '已取消'], // 已通过不能撤回
      ['已拒绝', '待审核'], // 终态
      ['已取消', '待审核'], // 终态
      ['已执行', '已拒绝'], // 终态 + paid 锁
      ['已执行', '已取消'], // paid 锁
      ['已执行', '待审核'], // paid 锁
    ];
    illegal.forEach(([from, to]) => {
      it(`${from} → ${to} 抛 ConflictException`, () => {
        expect(() => service.assertTransition(from, to)).toThrow(ConflictException);
      });
    });

    it('未知 from → BadRequestException', () => {
      expect(() => service.assertTransition('unknown' as any, '待审核')).toThrow(BadRequestException);
    });

    it('未知 to → BadRequestException', () => {
      expect(() => service.assertTransition('待审核', 'unknown' as any)).toThrow(BadRequestException);
    });
  });

  describe('isTerminal', () => {
    it('审批驳回 / 已撤回 / 已生效 都是终态', () => {
      expect(service.isTerminal('已拒绝')).toBe(true);
      expect(service.isTerminal('已取消')).toBe(true);
      expect(service.isTerminal('已执行')).toBe(true);
    });

    it('申请中 / 审批通过 不是终态', () => {
      expect(service.isTerminal('待审核')).toBe(false);
      expect(service.isTerminal('已批准')).toBe(false);
    });
  });

  describe('isPaidLocked', () => {
    it('已生效 → paid 锁定', () => {
      expect(service.isPaidLocked('已执行')).toBe(true);
    });

    it('其他状态 → 未锁定', () => {
      expect(service.isPaidLocked('待审核')).toBe(false);
      expect(service.isPaidLocked('已批准')).toBe(false);
      expect(service.isPaidLocked('已拒绝')).toBe(false);
      expect(service.isPaidLocked('已取消')).toBe(false);
    });
  });
});
