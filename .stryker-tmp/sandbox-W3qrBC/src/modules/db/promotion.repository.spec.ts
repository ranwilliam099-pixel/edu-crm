import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PromotionRepository } from './promotion.repository';
import { PromotionAuditRepository } from './promotion-audit.repository';
import { PgPoolService } from './pg-pool.service';

describe('PromotionRepository — tier CRUD', () => {
  let repo: PromotionRepository;
  let pg: { tenantQuery: jest.Mock; query: jest.Mock; withClient: jest.Mock; transaction: jest.Mock };
  let audit: { write: jest.Mock };

  const TENANT_ID = 't00000000000000000000000000000A01';

  beforeEach(async () => {
    pg = { tenantQuery: jest.fn(), query: jest.fn(), withClient: jest.fn(), transaction: jest.fn() };
    audit = { write: jest.fn().mockResolvedValue(undefined) };
    const m = await Test.createTestingModule({
      providers: [
        PromotionRepository,
        { provide: PgPoolService, useValue: pg },
        { provide: PromotionAuditRepository, useValue: audit },
      ],
    }).compile();
    repo = m.get(PromotionRepository);
  });

  // ===== CRUD =====

  describe('listTiers / getTier', () => {
    const fixture = (code: string) => ({
      id: 1,
      code,
      name: '早鸟波1',
      discount_pct: '10.00',
      quota_total: 10,
      quota_used: 3,
      active: true,
      starts_at: null,
      ends_at: null,
      activation_rules: { teachers: 3 },
      applies_to_plans: ['single', 'growth', 'chain'],
      applies_years: 1,
      source_type: 'self_service',
      invite_code: null,
      version: 0,
      created_at: new Date(),
      updated_at: new Date(),
    });

    it('listTiers maps rows', async () => {
      pg.query.mockResolvedValueOnce([fixture('early_bird_w1'), fixture('early_bird_w2')]);
      const tiers = await repo.listTiers();
      expect(tiers).toHaveLength(2);
      expect(tiers[0].code).toBe('early_bird_w1');
      expect(tiers[0].discountPct).toBe(10);
      expect(tiers[0].quotaTotal).toBe(10);
      expect(tiers[0].appliesToPlans).toEqual(['single', 'growth', 'chain']);
    });

    it('getTier throws NotFound when missing', async () => {
      pg.query.mockResolvedValueOnce([]);
      await expect(repo.getTier('xx')).rejects.toThrow(NotFoundException);
    });
  });

  describe('upsertTier', () => {
    it('rejects discount > 100', async () => {
      await expect(
        repo.upsertTier({ code: 'x', name: 'X', discountPct: 150, quotaTotal: 10 }),
      ).rejects.toThrow(BadRequestException);
    });
    it('rejects negative quota', async () => {
      await expect(
        repo.upsertTier({ code: 'x', name: 'X', discountPct: 50, quotaTotal: -1 }),
      ).rejects.toThrow(BadRequestException);
    });
    it('insert when not exists + writes audit', async () => {
      pg.query.mockResolvedValueOnce([]); // existing check
      pg.query.mockResolvedValueOnce([{
        id: 1, code: 'kol_a', name: 'KOL', discount_pct: '70.00',
        quota_total: 100, quota_used: 0, active: true,
        starts_at: null, ends_at: null, activation_rules: null,
        applies_to_plans: ['single'], applies_years: 2,
        source_type: 'kol', invite_code: 'ABCD',
        version: 0, created_at: new Date(), updated_at: new Date(),
      }]); // insert
      pg.query.mockResolvedValueOnce([]); // audit insert
      const tier = await repo.upsertTier({
        code: 'kol_a', name: 'KOL', discountPct: 70, quotaTotal: 100,
        sourceType: 'kol', appliesToPlans: ['single'], appliesYears: 2, inviteCode: 'ABCD',
      });
      expect(tier.code).toBe('kol_a');
      expect(tier.discountPct).toBe(70);
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ tierCode: 'kol_a', action: 'create' }),
      );
    });
  });

  describe('toggleActive', () => {
    const baseRow = {
      id: 1, code: 'x', name: 'X', discount_pct: '50.00',
      quota_total: 10, quota_used: 0, active: true,
      starts_at: null, ends_at: null, activation_rules: null,
      applies_to_plans: ['single'], applies_years: 1,
      source_type: 'self_service', invite_code: null,
      version: 0, created_at: new Date(), updated_at: new Date(),
    };
    it('flips active flag + audit', async () => {
      pg.query.mockResolvedValueOnce([baseRow]); // getTier
      pg.query.mockResolvedValueOnce([{ ...baseRow, active: false, version: 1 }]); // update
      pg.query.mockResolvedValueOnce([]); // audit
      const tier = await repo.toggleActive('x', false);
      expect(tier.active).toBe(false);
    });
  });

  describe('softDelete', () => {
    const baseRow = {
      id: 1, code: 'x', name: 'X', discount_pct: '50.00',
      quota_total: 10, quota_used: 5, active: true,
      starts_at: null, ends_at: null, activation_rules: null,
      applies_to_plans: ['single'], applies_years: 1,
      source_type: 'self_service', invite_code: null,
      version: 0, created_at: new Date(), updated_at: new Date(),
    };
    it('marks active=false + counts holders', async () => {
      pg.query.mockResolvedValueOnce([baseRow]); // getTier
      pg.query.mockResolvedValueOnce([{ count: '5' }]); // count holders
      pg.query.mockResolvedValueOnce([]); // update
      pg.query.mockResolvedValueOnce([]); // audit
      const r = await repo.softDelete('x');
      expect(r.ok).toBe(true);
    });
  });

  // ===== dryRun =====

  describe('dryRun', () => {
    it('returns warnings and gmv delta', async () => {
      pg.query.mockResolvedValueOnce([{
        id: 1, code: 'early_bird_w1', name: '早鸟波1', discount_pct: '10.00',
        quota_total: 10, quota_used: 3, active: true,
        starts_at: null, ends_at: null, activation_rules: null,
        applies_to_plans: ['single'], applies_years: 1,
        source_type: 'self_service', invite_code: null,
        version: 0, created_at: new Date(), updated_at: new Date(),
      }]); // getTier
      pg.query.mockResolvedValueOnce([{ count: '3' }]); // locked tenants
      const r = await repo.dryRun('early_bird_w1', { discountPct: 50 });
      expect(r.affectedTenantsLocked).toBe(3);
      expect(r.remainingQuota).toBe(7);
      expect(r.estimatedNewActivations).toBe(7);
      // 1999 × 50% - 1999 × 10% = 999 - 200 = 800; 800 × 7 = 5600
      expect(r.estimatedGmvDeltaYuan).toBeGreaterThan(0);
      expect(r.warnings.some((w) => w.includes('已锁定'))).toBe(true);
    });
  });

  // 状态机测试已迁移到 promotion-quota.service.spec.ts

  describe('listLockedTenants', () => {
    it('paginated query + total', async () => {
      pg.query.mockResolvedValueOnce([{ count: '12' }]);
      pg.query.mockResolvedValueOnce([
        { id: 't1', promotion_status: 'committed', promotion_locked_at: new Date(), promotion_price_yuan: 200 },
        { id: 't2', promotion_status: 'reserved', promotion_locked_at: new Date(), promotion_price_yuan: 999 },
      ]);
      const r = await repo.listLockedTenants('eb1', { limit: 10, offset: 0 });
      expect(r.total).toBe(12);
      expect(r.items).toHaveLength(2);
      expect(r.items[0].priceYuan).toBe(200);
    });
  });

  describe('getTenantPlanTier', () => {
    it('returns plan_tier when present', async () => {
      pg.query.mockResolvedValueOnce([{ plan_tier: 'growth' }]);
      const r = await repo.getTenantPlanTier(TENANT_ID);
      expect(r).toBe('growth');
    });
    it('returns null when tenant missing', async () => {
      pg.query.mockResolvedValueOnce([]);
      const r = await repo.getTenantPlanTier(TENANT_ID);
      expect(r).toBeNull();
    });
    it('returns null when plan_tier is bogus', async () => {
      pg.query.mockResolvedValueOnce([{ plan_tier: 'invalid_value' }]);
      const r = await repo.getTenantPlanTier(TENANT_ID);
      expect(r).toBeNull();
    });
  });

  describe('findByInviteCode', () => {
    it('returns null when no match', async () => {
      pg.query.mockResolvedValueOnce([]);
      const r = await repo.findByInviteCode('NOPE');
      expect(r).toBeNull();
    });
    it('maps row when match', async () => {
      pg.query.mockResolvedValueOnce([{
        id: 1, code: 'kol_a', name: 'KOL', discount_pct: '70.00',
        quota_total: 100, quota_used: 5, active: true,
        starts_at: null, ends_at: null, activation_rules: null,
        applies_to_plans: ['single'], applies_years: 2,
        source_type: 'kol', invite_code: 'ABCD',
        version: 0, created_at: new Date(), updated_at: new Date(),
      }]);
      const r = await repo.findByInviteCode('ABCD');
      expect(r?.code).toBe('kol_a');
    });
  });
});
