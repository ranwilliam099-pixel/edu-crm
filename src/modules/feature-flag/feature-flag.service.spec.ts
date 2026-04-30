import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import { FeatureFlagService, FEATURE_FLAGS } from './feature-flag.service';

describe('FeatureFlagService - PM-AUTH Phase 5.5 灰度开关', () => {
  let service: FeatureFlagService;
  const envStore: Record<string, string | undefined> = {};

  const mockConfig = {
    get: jest.fn((key: string) => envStore[key]),
  };

  beforeEach(async () => {
    Object.keys(envStore).forEach((k) => delete envStore[k]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FeatureFlagService,
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();
    service = module.get<FeatureFlagService>(FeatureFlagService);
  });

  describe('isEnabled - ENV 优先于默认值', () => {
    it('未设置 ENV → 用代码默认值（lifecycle_scheduler_enabled=false）', () => {
      expect(service.isEnabled('lifecycle_scheduler_enabled')).toBe(
        FEATURE_FLAGS.lifecycle_scheduler_enabled,
      );
    });

    it('ENV=true → 强制启用', () => {
      envStore.FEATURE_LIFECYCLE_SCHEDULER_ENABLED = 'true';
      expect(service.isEnabled('lifecycle_scheduler_enabled')).toBe(true);
    });

    it('ENV=false → 强制关闭', () => {
      envStore.FEATURE_MANUAL_REFUND_REVIEW = 'false';
      expect(service.isEnabled('manual_refund_review')).toBe(false);
    });

    it('ENV=TRUE 大写 → 启用', () => {
      envStore.FEATURE_REVERSE_ORDERS_ENABLED = 'TRUE';
      expect(service.isEnabled('reverse_orders_enabled')).toBe(true);
    });

    it('ENV=空字符串 → 用默认值', () => {
      envStore.FEATURE_REVERSE_ORDERS_ENABLED = '';
      expect(service.isEnabled('reverse_orders_enabled')).toBe(
        FEATURE_FLAGS.reverse_orders_enabled,
      );
    });

    it('未声明的 flag → BadRequestException', () => {
      expect(() => service.isEnabled('nonexistent' as any)).toThrow(BadRequestException);
    });

    it('缓存：第二次调用使用缓存', () => {
      service.isEnabled('lifecycle_scheduler_enabled');
      envStore.FEATURE_LIFECYCLE_SCHEDULER_ENABLED = 'true'; // 改 env
      // 没 clearCache，应该仍返回旧值
      expect(service.isEnabled('lifecycle_scheduler_enabled')).toBe(false);
      service.clearCache();
      expect(service.isEnabled('lifecycle_scheduler_enabled')).toBe(true);
    });
  });

  describe('requireEnabled', () => {
    it('启用 flag → 不抛', () => {
      envStore.FEATURE_REVERSE_ORDERS_ENABLED = 'true';
      expect(() => service.requireEnabled('reverse_orders_enabled')).not.toThrow();
    });

    it('未启用 flag → BadRequestException', () => {
      expect(() => service.requireEnabled('reverse_orders_enabled')).toThrow(BadRequestException);
    });
  });

  describe('listAll', () => {
    it('返回所有已注册 flag', () => {
      const all = service.listAll();
      const declaredFlags = Object.keys(FEATURE_FLAGS);
      expect(Object.keys(all).sort()).toEqual(declaredFlags.sort());
    });

    it('每个 flag 都有布尔值', () => {
      const all = service.listAll();
      Object.values(all).forEach((v) => {
        expect(typeof v).toBe('boolean');
      });
    });
  });
});
