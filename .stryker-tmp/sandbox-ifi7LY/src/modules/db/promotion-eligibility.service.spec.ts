import { Test } from '@nestjs/testing';
import { PromotionEligibilityService } from './promotion-eligibility.service';
import { PromotionQuotaService } from './promotion-quota.service';
import { PgPoolService } from './pg-pool.service';

describe('PromotionEligibilityService', () => {
  let svc: PromotionEligibilityService;
  let pg: { query: jest.Mock; tenantQuery: jest.Mock; withClient: jest.Mock };
  let quota: { reserveQuota: jest.Mock };

  // 真实 tenantId 是混合大小写格式（mxedu_...）
  const TENANT_ID = 'mxedu_00000000000001777796864574';
  const TENANT_SCHEMA = `tenant_${TENANT_ID.toLowerCase()}`;

  beforeEach(async () => {
    pg = { query: jest.fn(), tenantQuery: jest.fn(), withClient: jest.fn() };
    quota = { reserveQuota: jest.fn() };
    const m = await Test.createTestingModule({
      providers: [
        PromotionEligibilityService,
        { provide: PgPoolService, useValue: pg },
        { provide: PromotionQuotaService, useValue: quota },
      ],
    }).compile();
    svc = m.get(PromotionEligibilityService);
  });

  it('skips when tenant already has reserved/committed promo', async () => {
    pg.query.mockResolvedValueOnce([{
      promotion_code: 'early_bird_w1',
      promotion_status: 'committed',
      plan_tier: 'single',
    }]);
    const r = await svc.detectAndReserve(TENANT_ID, TENANT_SCHEMA);
    expect(r).toBe(false);
    expect(quota.reserveQuota).not.toHaveBeenCalled();
  });

  it('uses real tenantId (not toUpperCase from schema) for parents query', async () => {
    pg.query.mockResolvedValueOnce([{
      promotion_code: null,
      promotion_status: null,
      plan_tier: 'single',
    }]);
    pg.tenantQuery
      .mockResolvedValueOnce([{ count: '5' }])  // teachers
      .mockResolvedValueOnce([{ count: '10' }]) // students
      .mockResolvedValueOnce([{ count: '12' }]); // schedules
    pg.query.mockResolvedValueOnce([{ count: '6' }]); // parents
    pg.query.mockResolvedValueOnce([]); // no candidate tiers

    await svc.detectAndReserve(TENANT_ID, TENANT_SCHEMA);

    // 校验 parents 查询用的是原 tenantId（大小写保留），不是 toUpperCase
    const parentsQueryCall = pg.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('parent_student_bindings'),
    );
    expect(parentsQueryCall).toBeDefined();
    expect(parentsQueryCall[1]).toEqual([TENANT_ID]); // 不是 TENANT_ID.toUpperCase()
  });

  it('schedules query excludes cancelled', async () => {
    pg.query.mockResolvedValueOnce([{
      promotion_code: null,
      promotion_status: null,
      plan_tier: 'single',
    }]);
    pg.tenantQuery.mockResolvedValue([{ count: '0' }]);
    pg.query.mockResolvedValue([{ count: '0' }]);

    await svc.detectAndReserve(TENANT_ID, TENANT_SCHEMA);

    const schedulesCall = pg.tenantQuery.mock.calls.find(
      ([_, sql]) => typeof sql === 'string' && sql.includes('FROM schedules'),
    );
    expect(schedulesCall).toBeDefined();
    expect(schedulesCall[1]).toContain(`<> 'cancelled'`);
  });

  it('reserves first matching tier and returns true', async () => {
    pg.query.mockResolvedValueOnce([{
      promotion_code: null,
      promotion_status: null,
      plan_tier: 'single',
    }]);
    pg.tenantQuery
      .mockResolvedValueOnce([{ count: '5' }])
      .mockResolvedValueOnce([{ count: '15' }])
      .mockResolvedValueOnce([{ count: '20' }]);
    pg.query.mockResolvedValueOnce([{ count: '6' }]);
    pg.query.mockResolvedValueOnce([{
      code: 'early_bird_w1',
      activation_rules: { teachers: 3, students: 5, parents: 5, schedules: 10 },
    }]);
    quota.reserveQuota.mockResolvedValueOnce({ tier: {}, reservedAt: '', actualPriceYuan: 200 });

    const r = await svc.detectAndReserve(TENANT_ID, TENANT_SCHEMA);
    expect(r).toBe(true);
    expect(quota.reserveQuota).toHaveBeenCalledWith(
      TENANT_ID,
      'early_bird_w1',
      expect.objectContaining({ operatorRole: 'system' }),
    );
  });

  it('skips tier when KPI does not meet rules', async () => {
    pg.query.mockResolvedValueOnce([{
      promotion_code: null,
      promotion_status: null,
      plan_tier: 'single',
    }]);
    pg.tenantQuery
      .mockResolvedValueOnce([{ count: '1' }])  // teachers (rules wants 3)
      .mockResolvedValueOnce([{ count: '15' }])
      .mockResolvedValueOnce([{ count: '20' }]);
    pg.query.mockResolvedValueOnce([{ count: '6' }]);
    pg.query.mockResolvedValueOnce([{
      code: 'early_bird_w1',
      activation_rules: { teachers: 3, students: 5, parents: 5, schedules: 10 },
    }]);

    const r = await svc.detectAndReserve(TENANT_ID, TENANT_SCHEMA);
    expect(r).toBe(false);
    expect(quota.reserveQuota).not.toHaveBeenCalled();
  });

  it('continues to next candidate when QUOTA_EXHAUSTED', async () => {
    pg.query.mockResolvedValueOnce([{
      promotion_code: null,
      promotion_status: null,
      plan_tier: 'single',
    }]);
    pg.tenantQuery
      .mockResolvedValueOnce([{ count: '5' }])
      .mockResolvedValueOnce([{ count: '15' }])
      .mockResolvedValueOnce([{ count: '20' }]);
    pg.query.mockResolvedValueOnce([{ count: '6' }]);
    pg.query.mockResolvedValueOnce([
      {
        code: 'early_bird_w1',
        activation_rules: { teachers: 3, students: 5, parents: 5, schedules: 10 },
      },
      {
        code: 'early_bird_w2',
        activation_rules: { teachers: 5, students: 10, parents: 5, schedules: 10 },
      },
    ]);
    quota.reserveQuota
      .mockRejectedValueOnce(new Error('PROMOTION_QUOTA_EXHAUSTED'))
      .mockResolvedValueOnce({ tier: {}, reservedAt: '', actualPriceYuan: 1000 });

    const r = await svc.detectAndReserve(TENANT_ID, TENANT_SCHEMA);
    expect(r).toBe(true);
    expect(quota.reserveQuota).toHaveBeenCalledTimes(2);
    expect(quota.reserveQuota.mock.calls[1][1]).toBe('early_bird_w2');
  });
});
