import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PromotionQuotaService } from './promotion-quota.service';
import { PromotionAuditRepository } from './promotion-audit.repository';
import { PgPoolService } from './pg-pool.service';

describe('PromotionQuotaService — V20 状态机', () => {
  let svc: PromotionQuotaService;
  let pg: { tenantQuery: jest.Mock; query: jest.Mock; withClient: jest.Mock; transaction: jest.Mock };
  let audit: { write: jest.Mock };

  const TENANT_ID = 't00000000000000000000000000000A01';

  const mkClient = (responses: Record<string, any[]> = {}, calls: any[] = []) => ({
    query: jest.fn().mockImplementation((sql: string, params?: any[]) => {
      calls.push({ sql, params });
      for (const [pattern, rows] of Object.entries(responses)) {
        if (sql.includes(pattern)) {
          return Promise.resolve({ rows });
        }
      }
      return Promise.resolve({ rows: [] });
    }),
  });

  beforeEach(async () => {
    pg = {
      tenantQuery: jest.fn(),
      query: jest.fn(),
      withClient: jest.fn(),
      transaction: jest.fn(),
    };
    audit = { write: jest.fn().mockResolvedValue(undefined) };
    const m = await Test.createTestingModule({
      providers: [
        PromotionQuotaService,
        { provide: PgPoolService, useValue: pg },
        { provide: PromotionAuditRepository, useValue: audit },
      ],
    }).compile();
    svc = m.get(PromotionQuotaService);
  });

  describe('reserveQuota', () => {
    it('原子抢名额成功 + 写 tenants + audit', async () => {
      const calls: any[] = [];
      const client = mkClient(
        {
          'FOR UPDATE': [{ promotion_code: null, promotion_status: null, plan_tier: 'single' }],
          'SET quota_used = quota_used + 1': [{
            id: 1, code: 'early_bird_w1', name: '早鸟波1', discount_pct: '10.00',
            quota_total: 10, quota_used: 4, active: true,
            starts_at: null, ends_at: null, activation_rules: null,
            applies_to_plans: ['single'], applies_years: 1,
            source_type: 'self_service', invite_code: null,
            version: 1, created_at: new Date(), updated_at: new Date(),
          }],
        },
        calls,
      );
      pg.transaction.mockImplementationOnce(async (fn: any) => fn(client));
      const r = await svc.reserveQuota(TENANT_ID, 'early_bird_w1');
      expect(r.actualPriceYuan).toBe(200);
      expect(r.tier.quotaUsed).toBe(4);
      const sqls = calls.map((c) => c.sql).join('\n');
      expect(sqls).toContain('UPDATE public.tenants');
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'quota_reserve', tenantId: TENANT_ID }),
      );
    });

    it('quota 满 → PROMOTION_QUOTA_EXHAUSTED', async () => {
      const client = mkClient({
        'FOR UPDATE': [{ promotion_code: null, promotion_status: null, plan_tier: 'single' }],
        'SET quota_used = quota_used + 1': [],
        'SELECT active, quota_total': [{
          active: true, quota_total: 10, quota_used: 10, starts_at: null, ends_at: null,
        }],
      });
      pg.transaction.mockImplementationOnce(async (fn: any) => fn(client));
      await expect(svc.reserveQuota(TENANT_ID, 'eb1')).rejects.toThrow(/QUOTA_EXHAUSTED/);
    });

    it('已 reserved → PROMOTION_ALREADY_LOCKED', async () => {
      const client = mkClient({
        'FOR UPDATE': [{
          promotion_code: 'early_bird_w1', promotion_status: 'reserved', plan_tier: 'single',
        }],
      });
      pg.transaction.mockImplementationOnce(async (fn: any) => fn(client));
      await expect(svc.reserveQuota(TENANT_ID, 'eb2')).rejects.toThrow(/ALREADY_LOCKED/);
    });

    it('tenant 不存在 → NotFound', async () => {
      const client = mkClient({ 'FOR UPDATE': [] });
      pg.transaction.mockImplementationOnce(async (fn: any) => fn(client));
      await expect(svc.reserveQuota(TENANT_ID, 'eb1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('commitQuota', () => {
    it('reserved → committed', async () => {
      const client = mkClient({
        'FOR UPDATE': [{ promotion_code: 'eb1', promotion_status: 'reserved' }],
      });
      pg.transaction.mockImplementationOnce(async (fn: any) => fn(client));
      const r = await svc.commitQuota(TENANT_ID);
      expect(r.ok).toBe(true);
      expect(r.promotionCode).toBe('eb1');
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'quota_commit' }),
      );
    });

    it('未 reserve → BadRequest', async () => {
      const client = mkClient({
        'FOR UPDATE': [{ promotion_code: null, promotion_status: null }],
      });
      pg.transaction.mockImplementationOnce(async (fn: any) => fn(client));
      await expect(svc.commitQuota(TENANT_ID)).rejects.toThrow(BadRequestException);
    });

    it('已 committed → Conflict', async () => {
      const client = mkClient({
        'FOR UPDATE': [{ promotion_code: 'eb1', promotion_status: 'committed' }],
      });
      pg.transaction.mockImplementationOnce(async (fn: any) => fn(client));
      await expect(svc.commitQuota(TENANT_ID)).rejects.toThrow(/INVALID_STATE/);
    });
  });

  describe('expirePromotions', () => {
    it('过期 committed 转 expired + 写 audit', async () => {
      // 锁定 1 年前的 committed，applies_years=1 → 过期
      const lockedAt = new Date('2025-05-04T00:00:00Z');
      pg.query.mockResolvedValueOnce([
        {
          tenant_id: 'tA',
          promotion_code: 'eb1',
          promotion_locked_at: lockedAt,
          applies_years: 1,
        },
      ]);
      const calls: any[] = [];
      const client = mkClient({}, calls);
      pg.transaction.mockImplementationOnce(async (fn: any) => fn(client));

      const r = await svc.expirePromotions(new Date('2026-05-05T00:00:00Z'));
      expect(r.expired).toBe(1);
      const sqls = calls.map((c) => c.sql).join('\n');
      expect(sqls).toContain(`promotion_status = 'expired'`);
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'quota_expire', tenantId: 'tA' }),
      );
    });

    it('未到期 → 不动 + 不写 audit', async () => {
      // 锁定 1 月前，applies_years=2 → 未到期
      pg.query.mockResolvedValueOnce([
        {
          tenant_id: 'tB',
          promotion_code: 'kol2',
          promotion_locked_at: new Date('2026-04-05T00:00:00Z'),
          applies_years: 2,
        },
      ]);
      const r = await svc.expirePromotions(new Date('2026-05-05T00:00:00Z'));
      expect(r.expired).toBe(0);
      expect(pg.transaction).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('多个候选混合（部分过期）只过期到期的', async () => {
      pg.query.mockResolvedValueOnce([
        {
          tenant_id: 'tA',
          promotion_code: 'eb1',
          promotion_locked_at: new Date('2025-04-01T00:00:00Z'),
          applies_years: 1,
        },
        {
          tenant_id: 'tB',
          promotion_code: 'eb2',
          promotion_locked_at: new Date('2026-03-01T00:00:00Z'),
          applies_years: 1,
        },
      ]);
      const client = mkClient();
      pg.transaction.mockImplementation(async (fn: any) => fn(client));
      const r = await svc.expirePromotions(new Date('2026-05-05T00:00:00Z'));
      expect(r.expired).toBe(1); // 只 tA 过期
    });
  });

  describe('releaseQuota', () => {
    it('committed → released + 名额回退 + audit', async () => {
      const calls: any[] = [];
      const client = mkClient(
        { 'FOR UPDATE': [{ promotion_code: 'eb1', promotion_status: 'committed' }] },
        calls,
      );
      pg.transaction.mockImplementationOnce(async (fn: any) => fn(client));
      const r = await svc.releaseQuota(TENANT_ID, 'refund');
      expect(r.releasedCode).toBe('eb1');
      const sqls = calls.map((c) => c.sql).join('\n');
      expect(sqls).toContain('GREATEST(quota_used - 1, 0)');
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'quota_release' }),
      );
    });

    it('无 promotion → no-op + 不写 audit', async () => {
      const client = mkClient({
        'FOR UPDATE': [{ promotion_code: null, promotion_status: null }],
      });
      pg.transaction.mockImplementationOnce(async (fn: any) => fn(client));
      const r = await svc.releaseQuota(TENANT_ID, 'noop');
      expect(r.releasedCode).toBeNull();
      expect(audit.write).not.toHaveBeenCalled();
    });
  });
});
