/**
 * TenantLifecycleService 单元测试 — W3-1 Phase 2.1 BE-W3-2
 *
 * PM-AUTH-7(2026-04-30): A10 状态机 + 时间轴
 *
 * 覆盖：
 *   - 4 状态合法转换全部边
 *   - 非法转换抛 ConflictException
 *   - 未知状态抛 BadRequestException
 *   - 终态判定
 *   - 时间锚点计算（D-30 / D+0 / D+90）
 *   - inferStateByTime 4 区间
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { TenantLifecycleService, TenantLifecycleState } from './tenant-lifecycle.service';

describe('TenantLifecycleService', () => {
  let service: TenantLifecycleService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TenantLifecycleService],
    }).compile();
    service = module.get<TenantLifecycleService>(TenantLifecycleService);
  });

  describe('assertTransition - PM-AUTH-7 A10 合法转换边', () => {
    const legal: Array<[TenantLifecycleState, TenantLifecycleState]> = [
      ['active', 'expiring'],
      ['active', 'frozen'],
      ['expiring', 'active'],
      ['expiring', 'frozen'],
      ['frozen', 'active'],
      ['frozen', 'pending_delete'],
    ];
    legal.forEach(([from, to]) => {
      it(`${from} → ${to} 合法`, () => {
        expect(() => service.assertTransition(from, to)).not.toThrow();
      });
    });
  });

  describe('assertTransition - 非法转换', () => {
    const illegal: Array<[TenantLifecycleState, TenantLifecycleState]> = [
      ['active', 'pending_delete'], // 不允许跨过 expiring/frozen
      ['expiring', 'pending_delete'], // 不允许跨过 frozen
      ['pending_delete', 'active'], // 终态
      ['pending_delete', 'frozen'], // 终态
    ];
    illegal.forEach(([from, to]) => {
      it(`${from} → ${to} 抛 ConflictException`, () => {
        expect(() => service.assertTransition(from, to)).toThrow(ConflictException);
      });
    });

    it('未知 from 抛 BadRequestException', () => {
      expect(() =>
        service.assertTransition('unknown' as any, 'active'),
      ).toThrow(BadRequestException);
    });

    it('未知 to 抛 BadRequestException', () => {
      expect(() =>
        service.assertTransition('active', 'unknown' as any),
      ).toThrow(BadRequestException);
    });
  });

  describe('isTerminal', () => {
    it('pending_delete 是终态', () => {
      expect(service.isTerminal('pending_delete')).toBe(true);
    });
    it('active / expiring / frozen 不是终态', () => {
      expect(service.isTerminal('active')).toBe(false);
      expect(service.isTerminal('expiring')).toBe(false);
      expect(service.isTerminal('frozen')).toBe(false);
    });
  });

  describe('computeLifecycleAnchors - A10 时间轴', () => {
    it('D-30 / D+0 / D+90 三锚点正确', () => {
      const expiresAt = new Date('2026-12-01T00:00:00Z');
      const anchors = service.computeLifecycleAnchors(expiresAt);
      expect(anchors.renewalReminderAt).toEqual(new Date('2026-11-01T00:00:00Z'));
      expect(anchors.freezeAt).toEqual(new Date('2026-12-01T00:00:00Z'));
      expect(anchors.cleanupAt).toEqual(new Date('2027-03-01T00:00:00Z'));
    });

    it('非法 Date 抛 BadRequestException', () => {
      expect(() => service.computeLifecycleAnchors(new Date('invalid'))).toThrow(
        BadRequestException,
      );
    });
  });

  describe('inferStateByTime - PM-AUTH-7 时间轴推断', () => {
    const expiresAt = new Date('2026-12-01T00:00:00Z');

    it('now < D-30 → active', () => {
      const now = new Date('2026-10-01T00:00:00Z');
      expect(service.inferStateByTime(expiresAt, now)).toBe('active');
    });

    it('D-30 ≤ now < D+0 → expiring', () => {
      const now = new Date('2026-11-15T00:00:00Z');
      expect(service.inferStateByTime(expiresAt, now)).toBe('expiring');
    });

    it('D+0 ≤ now < D+90 → frozen', () => {
      const now = new Date('2027-01-15T00:00:00Z');
      expect(service.inferStateByTime(expiresAt, now)).toBe('frozen');
    });

    it('now ≥ D+90 → pending_delete', () => {
      const now = new Date('2027-04-01T00:00:00Z');
      expect(service.inferStateByTime(expiresAt, now)).toBe('pending_delete');
    });

    it('边界：刚好 D-30 → expiring', () => {
      const now = new Date('2026-11-01T00:00:00Z');
      expect(service.inferStateByTime(expiresAt, now)).toBe('expiring');
    });

    it('边界：刚好 D+0 → frozen', () => {
      const now = new Date('2026-12-01T00:00:00Z');
      expect(service.inferStateByTime(expiresAt, now)).toBe('frozen');
    });

    it('边界：刚好 D+90 → pending_delete', () => {
      const now = new Date('2027-03-01T00:00:00Z');
      expect(service.inferStateByTime(expiresAt, now)).toBe('pending_delete');
    });
  });
});
