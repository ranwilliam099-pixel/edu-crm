import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  SubscriptionRepository,
  PLAN_META,
} from './subscription.repository';
import { PgPoolService } from './pg-pool.service';

describe('SubscriptionRepository', () => {
  let repo: SubscriptionRepository;
  let pg: { tenantQuery: jest.Mock; query: jest.Mock; withClient: jest.Mock; transaction: jest.Mock };

  const TENANT_ID = 't00000000000000000000000000000A01';

  beforeEach(async () => {
    pg = { tenantQuery: jest.fn(), query: jest.fn(), withClient: jest.fn(), transaction: jest.fn() };
    const m = await Test.createTestingModule({
      providers: [SubscriptionRepository, { provide: PgPoolService, useValue: pg }],
    }).compile();
    repo = m.get(SubscriptionRepository);
  });

  describe('PLAN_META 严格线性', () => {
    it('single = 1999', () => {
      expect(PLAN_META.single.priceYuan).toBe(1999);
      expect(PLAN_META.single.maxCampuses).toBe(1);
    });
    it('growth = 3 × single', () => {
      expect(PLAN_META.growth.priceYuan).toBe(1999 * 3);
      expect(PLAN_META.growth.maxCampuses).toBe(3);
    });
    it('chain = 99 × single', () => {
      expect(PLAN_META.chain.priceYuan).toBe(1999 * 99);
      expect(PLAN_META.chain.maxCampuses).toBe(99);
    });
  });

  describe('getCurrent', () => {
    it('returns plan info with no promotion (legacy/regular)', async () => {
      pg.query.mockResolvedValueOnce([{
        plan_tier: 'single',
        max_campuses: 1,
        promotion_code: null,
        promotion_status: null,
        promotion_locked_at: null,
        promotion_price_yuan: null,
        promotion_year_index: 1,
        promo_name: null,
        promo_discount: null,
        promo_applies_years: null,
        promo_active: null,
      }]);
      const sub = await repo.getCurrent(TENANT_ID);
      expect(sub.tenantId).toBe(TENANT_ID);
      expect(sub.planTier).toBe('single');
      expect(sub.priceYuan).toBe(1999);
      expect(sub.actualPriceYuan).toBe(1999);
      expect(sub.discountPct).toBe(100);
      expect(sub.promotionCode).toBeNull();
      expect(sub.nextYearPriceYuan).toBe(1999);
    });

    it('throws NotFoundException when tenant missing', async () => {
      pg.query.mockResolvedValueOnce([]);
      await expect(repo.getCurrent(TENANT_ID)).rejects.toThrow(NotFoundException);
    });

    it('uses snapshot price when available (early-bird w1, 1折)', async () => {
      const lockedAt = new Date('2026-05-01T00:00:00Z');
      pg.query.mockResolvedValueOnce([{
        plan_tier: 'single',
        max_campuses: 1,
        promotion_code: 'early_bird_w1',
        promotion_status: 'committed',
        promotion_locked_at: lockedAt,
        promotion_price_yuan: 200,
        promotion_year_index: 1,
        promo_name: '早鸟波1',
        promo_discount: '10.00',
        promo_applies_years: 1,
        promo_active: true,
      }]);
      const sub = await repo.getCurrent(TENANT_ID);
      expect(sub.actualPriceYuan).toBe(200);
      expect(sub.discountPct).toBe(10);
      expect(sub.promotionCode).toBe('early_bird_w1');
      expect(sub.promotionStatus).toBe('committed');
      expect(sub.promotionExpiresAt).toBe('2027-05-01T00:00:00.000Z');
      expect(sub.nextYearPriceYuan).toBe(1999); // applies_years=1 用完，明年正价
    });

    it('recomputes price when snapshot missing (reserved 状态)', async () => {
      pg.query.mockResolvedValueOnce([{
        plan_tier: 'single',
        max_campuses: 1,
        promotion_code: 'early_bird_w2',
        promotion_status: 'reserved',
        promotion_locked_at: new Date('2026-05-01T00:00:00Z'),
        promotion_price_yuan: null,
        promotion_year_index: 1,
        promo_name: '早鸟波2',
        promo_discount: '50.00',
        promo_applies_years: 1,
        promo_active: true,
      }]);
      const sub = await repo.getCurrent(TENANT_ID);
      expect(sub.actualPriceYuan).toBe(1000); // 1999 × 50% = 999.5 → 1000 (round)
      expect(sub.discountPct).toBe(50);
    });

    it('released status falls back to regular price', async () => {
      pg.query.mockResolvedValueOnce([{
        plan_tier: 'single',
        max_campuses: 1,
        promotion_code: 'early_bird_w1',
        promotion_status: 'released',
        promotion_locked_at: new Date('2026-05-01T00:00:00Z'),
        promotion_price_yuan: 200,
        promotion_year_index: 1,
        promo_name: '早鸟波1',
        promo_discount: '10.00',
        promo_applies_years: 1,
        promo_active: true,
      }]);
      const sub = await repo.getCurrent(TENANT_ID);
      expect(sub.actualPriceYuan).toBe(1999); // released → 正价
    });

    it('multi-year KOL promo: 第二年仍享折扣', async () => {
      pg.query.mockResolvedValueOnce([{
        plan_tier: 'single',
        max_campuses: 1,
        promotion_code: 'kol_30',
        promotion_status: 'committed',
        promotion_locked_at: new Date('2026-01-01T00:00:00Z'),
        promotion_price_yuan: 1399,
        promotion_year_index: 1,
        promo_name: 'KOL达人',
        promo_discount: '70.00',
        promo_applies_years: 2,
        promo_active: true,
      }]);
      const sub = await repo.getCurrent(TENANT_ID);
      expect(sub.nextYearPriceYuan).toBe(1399); // year 1 < applies 2，明年还折扣
    });
  });

  describe('upgrade', () => {
    beforeEach(() => {
      // mock withClient 为直接回调
      pg.transaction.mockImplementation(async (fn: any) => {
        const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
        return fn(client);
      });
    });

    it('upgrades single → growth and updates max_campuses', async () => {
      pg.query.mockResolvedValueOnce([{ plan_tier: 'single', promotion_code: null }]);
      const r = await repo.upgrade(TENANT_ID, 'growth');
      expect(r.ok).toBe(true);
      expect(r.oldPlan).toBe('single');
      expect(r.newPlan).toBe('growth');
      expect(r.priceDiff).toBe(PLAN_META.growth.priceYuan - PLAN_META.single.priceYuan);
      expect(r.paymentRequired).toBe(true);
    });

    it('upgrade releases existing promotion quota', async () => {
      pg.query.mockResolvedValueOnce([{
        plan_tier: 'single',
        promotion_code: 'early_bird_w1',
      }]);
      let releasedQuota = false;
      let auditWritten = false;
      pg.transaction.mockImplementationOnce(async (fn: any) => {
        const client = {
          query: jest.fn().mockImplementation((sql: string) => {
            if (sql.includes('quota_used = GREATEST')) releasedQuota = true;
            if (sql.includes('promotion_tier_audit')) auditWritten = true;
            return Promise.resolve({ rows: [] });
          }),
        };
        return fn(client);
      });
      await repo.upgrade(TENANT_ID, 'growth');
      expect(releasedQuota).toBe(true);
      expect(auditWritten).toBe(true);
    });

    it('downgrade returns negative priceDiff and paymentRequired=false', async () => {
      pg.query.mockResolvedValueOnce([{ plan_tier: 'chain', promotion_code: null }]);
      const r = await repo.upgrade(TENANT_ID, 'single');
      expect(r.priceDiff).toBeLessThan(0);
      expect(r.paymentRequired).toBe(false);
    });

    it('downgrade also releases existing promotion (plan_change cleanup)', async () => {
      pg.query.mockResolvedValueOnce([{
        plan_tier: 'chain',
        promotion_code: 'kol_50',
      }]);
      let releasedQuota = false;
      let auditNote = '';
      pg.transaction.mockImplementationOnce(async (fn: any) => {
        const client = {
          query: jest.fn().mockImplementation((sql: string, params: any[] = []) => {
            if (sql.includes('quota_used = GREATEST')) releasedQuota = true;
            if (sql.includes('promotion_tier_audit')) auditNote = params[3] || '';
            return Promise.resolve({ rows: [] });
          }),
        };
        return fn(client);
      });
      await repo.upgrade(TENANT_ID, 'single');
      expect(releasedQuota).toBe(true);
      expect(auditNote).toBe('plan_downgrade');
    });

    it('same plan does not touch promotion', async () => {
      pg.query.mockResolvedValueOnce([{
        plan_tier: 'single',
        promotion_code: 'early_bird_w1',
      }]);
      let releasedQuota = false;
      pg.transaction.mockImplementationOnce(async (fn: any) => {
        const client = {
          query: jest.fn().mockImplementation((sql: string) => {
            if (sql.includes('quota_used = GREATEST')) releasedQuota = true;
            return Promise.resolve({ rows: [] });
          }),
        };
        return fn(client);
      });
      await repo.upgrade(TENANT_ID, 'single');
      expect(releasedQuota).toBe(false);
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
