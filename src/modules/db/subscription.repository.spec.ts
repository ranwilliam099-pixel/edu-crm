import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  SubscriptionRepository,
  PLAN_META,
} from './subscription.repository';
import { PgPoolService } from './pg-pool.service';

describe('SubscriptionRepository', () => {
  let repo: SubscriptionRepository;
  let pg: { tenantQuery: jest.Mock; query: jest.Mock; withClient: jest.Mock };

  const TENANT_ID = 't00000000000000000000000000000A01';

  beforeEach(async () => {
    pg = { tenantQuery: jest.fn(), query: jest.fn(), withClient: jest.fn() };
    const m = await Test.createTestingModule({
      providers: [SubscriptionRepository, { provide: PgPoolService, useValue: pg }],
    }).compile();
    repo = m.get(SubscriptionRepository);
  });

  describe('getCurrent', () => {
    it('returns plan info', async () => {
      pg.query.mockResolvedValueOnce([{ plan_tier: 'single', max_campuses: 1 }]);
      const sub = await repo.getCurrent(TENANT_ID);
      expect(sub.tenantId).toBe(TENANT_ID);
      expect(sub.planTier).toBe('single');
      expect(sub.maxCampuses).toBe(1);
      expect(sub.priceYuan).toBe(PLAN_META.single.priceYuan);
    });

    it('throws NotFoundException when tenant missing', async () => {
      pg.query.mockResolvedValueOnce([]);
      await expect(repo.getCurrent(TENANT_ID)).rejects.toThrow(NotFoundException);
    });

    it('defaults to single when plan_tier is null (legacy tenants)', async () => {
      pg.query.mockResolvedValueOnce([{ plan_tier: null, max_campuses: 1 }]);
      const sub = await repo.getCurrent(TENANT_ID);
      expect(sub.planTier).toBe('single');
    });
  });

  describe('upgrade', () => {
    it('upgrades single → growth and updates max_campuses', async () => {
      pg.query.mockResolvedValueOnce([{ plan_tier: 'single' }]);
      pg.query.mockResolvedValueOnce([]);
      const r = await repo.upgrade(TENANT_ID, 'growth');
      expect(r.ok).toBe(true);
      expect(r.oldPlan).toBe('single');
      expect(r.newPlan).toBe('growth');
      expect(r.priceDiff).toBe(
        PLAN_META.growth.priceYuan - PLAN_META.single.priceYuan,
      );
      expect(r.paymentRequired).toBe(true);
      expect(r.mockPayUrl).toBe('EXT-01-todo');
      // verify UPDATE was called with correct max_campuses
      const updateCall = pg.query.mock.calls[1];
      expect(updateCall[1]).toEqual([
        'growth',
        PLAN_META.growth.maxCampuses,
        TENANT_ID,
      ]);
    });

    it('upgrades to chain', async () => {
      pg.query.mockResolvedValueOnce([{ plan_tier: 'growth' }]);
      pg.query.mockResolvedValueOnce([]);
      const r = await repo.upgrade(TENANT_ID, 'chain');
      expect(r.newPlan).toBe('chain');
      expect(r.priceDiff).toBeGreaterThan(0);
    });

    it('downgrade returns negative priceDiff and paymentRequired=false', async () => {
      pg.query.mockResolvedValueOnce([{ plan_tier: 'chain' }]);
      pg.query.mockResolvedValueOnce([]);
      const r = await repo.upgrade(TENANT_ID, 'single');
      expect(r.priceDiff).toBeLessThan(0);
      expect(r.paymentRequired).toBe(false);
    });

    it('throws BadRequestException for invalid plan', async () => {
      await expect(
        repo.upgrade(TENANT_ID, 'mega' as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException when tenant missing', async () => {
      pg.query.mockResolvedValueOnce([]);
      await expect(repo.upgrade(TENANT_ID, 'growth')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
