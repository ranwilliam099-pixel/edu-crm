/**
 * boss.controller.spec.ts (5/20 stryker 0% coverage 修补)
 *
 * 来源：5/20 stryker mutation 跑出 BossController 57 mutant 全 no-cov
 *   → V19 Boss 视角校区 + 订阅管理 HTTP 暴露（tenant/info + campuses CRUD + subscription），
 *     上线后从未测试，dev 改坏单测全绿
 *
 * 5 endpoint 覆盖：
 *   - GET  /db/boss/tenant/info        — pg.query public.tenants
 *   - POST /db/boss/campuses           — campusRepo.create
 *   - POST /db/boss/campuses/list      — campusRepo.list
 *   - POST /db/boss/campuses/stats     — campusRepo.getStats30d
 *   - POST /db/boss/subscription/upgrade — subRepo.upgrade
 *   - GET  /db/boss/subscription       — subRepo.getCurrent
 *
 * 覆盖 case：
 *   1. tenantInfo() — tenantId 缺 → BadRequest
 *   2. tenantInfo() — pg.query 返空 → BadRequest "tenant {id} not found"
 *   3. tenantInfo() — happy path response shape（含 plan_tier=null 兜底 'single' / createdAt ISO）
 *   4. tenantInfo() — plan_tier 已设 → 不走兜底
 *   5. createCampus() — tenantId 缺 → BadRequest
 *   6. createCampus() — tenantId 长度 ≠ 32 → BadRequest
 *   7. createCampus() — id 缺 → BadRequest
 *   8. createCampus() — id 长度 ≠ 32 → BadRequest
 *   9. createCampus() — name 缺 → BadRequest
 *   10. createCampus() — happy path 转交 campusRepo.create（含可选字段 city/district/address/isHq）
 *   11. createCampus() — 可选字段 undefined 透传 undefined 给 repo（不变成 null）
 *   12. listCampuses() — tenantId 缺 → BadRequest
 *   13. listCampuses() — 转交 campusRepo.list
 *   14. campusStats() — tenantId 缺 → BadRequest
 *   15. campusStats() — 转交 campusRepo.getStats30d
 *   16. upgradeSubscription() — tenantId 缺 → BadRequest
 *   17. upgradeSubscription() — targetPlan 缺 → BadRequest
 *   18. upgradeSubscription() — happy path 转交 subRepo.upgrade
 *   19. getSubscription() — tenantId 缺 → BadRequest
 *   20. getSubscription() — 转交 subRepo.getCurrent
 *   21. service 抛错 → controller 透传不吞
 *
 * 学到的范式：精确 toHaveBeenCalledWith / rejects.toThrow / mockResolvedValueOnce
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BossController } from './boss.controller';
import { CampusRepository, Campus } from './campus.repository';
import { SubscriptionRepository, Subscription, PlanTier } from './subscription.repository';
import { PgPoolService } from './pg-pool.service';

describe('BossController (5/20 stryker 0% coverage 修补)', () => {
  let controller: BossController;
  let campusRepo: {
    create: jest.Mock;
    list: jest.Mock;
    getStats30d: jest.Mock;
  };
  let subRepo: {
    upgrade: jest.Mock;
    getCurrent: jest.Mock;
  };
  let pg: { query: jest.Mock };

  // 32-char ULID 固定值
  const TENANT_ID = 'tenantBoss0000000000000000000B01';
  const CAMPUS_ID = 'campusBoss0000000000000000000B01';

  function campusFixture(overrides: Partial<Campus> = {}): Campus {
    return {
      id: CAMPUS_ID,
      tenantId: TENANT_ID,
      name: '主校区',
      city: '北京',
      district: '朝阳',
      address: '北京市朝阳区某路 100 号',
      studentCount: 50,
      teacherCount: 8,
      status: 'active',
      isHq: true,
      createdAt: new Date('2026-05-01T00:00:00.000Z'),
      ...overrides,
    };
  }

  function subscriptionFixture(overrides: Partial<Subscription> = {}): Subscription {
    return {
      tenantId: TENANT_ID,
      planTier: 'single',
      maxCampuses: 1,
      priceYuan: 1999,
      promotionCode: null,
      promotionName: null,
      discountPct: 100,
      actualPriceYuan: 1999,
      promotionStatus: null,
      promotionLockedAt: null,
      promotionYearIndex: 1,
      promotionExpiresAt: null,
      nextYearPriceYuan: 1999,
      ...overrides,
    };
  }

  beforeEach(() => {
    campusRepo = {
      create: jest.fn(),
      list: jest.fn(),
      getStats30d: jest.fn(),
    };
    subRepo = {
      upgrade: jest.fn(),
      getCurrent: jest.fn(),
    };
    pg = { query: jest.fn() };
    controller = new BossController(
      campusRepo as unknown as CampusRepository,
      subRepo as unknown as SubscriptionRepository,
      pg as unknown as PgPoolService,
    );
  });

  // ============================================================
  // Case 1-4: tenantInfo()
  // ============================================================
  describe('tenantInfo()', () => {
    it('tenantId 缺（空串）→ BadRequest instanceof', async () => {
      await expect(controller.tenantInfo('')).rejects.toThrow(BadRequestException);
      expect(pg.query).not.toHaveBeenCalled();
    });

    it('tenantId 缺（空串）→ message "tenantId required"', async () => {
      await expect(controller.tenantInfo('')).rejects.toThrow('tenantId required');
    });

    it('pg.query 返空 → BadRequest "tenant {id} not found"', async () => {
      pg.query.mockResolvedValueOnce([]);
      await expect(controller.tenantInfo(TENANT_ID)).rejects.toThrow(
        `tenant ${TENANT_ID} not found`,
      );
      expect(pg.query).toHaveBeenCalledWith(
        expect.stringContaining('FROM public.tenants'),
        [TENANT_ID],
      );
    });

    it('happy path — 返完整 shape + createdAt ISO + plan_tier=null 兜底 single', async () => {
      pg.query.mockResolvedValueOnce([
        {
          id: TENANT_ID,
          name: '阳光教育',
          status: 'active',
          version: 'v1',
          plan_tier: null, // 兜底
          max_campuses: 1,
          created_at: new Date('2026-04-01T08:30:00.000Z'),
        },
      ]);

      const result = await controller.tenantInfo(TENANT_ID);

      expect(result).toEqual({
        tenantId: TENANT_ID,
        name: '阳光教育',
        status: 'active',
        version: 'v1',
        planTier: 'single', // 兜底
        maxCampuses: 1,
        createdAt: '2026-04-01T08:30:00.000Z',
      });
    });

    it('plan_tier 已设为 chain → 不走兜底', async () => {
      pg.query.mockResolvedValueOnce([
        {
          id: TENANT_ID,
          name: 'Chain Co',
          status: 'active',
          version: 'v2',
          plan_tier: 'chain',
          max_campuses: 99,
          created_at: new Date('2026-01-01T00:00:00.000Z'),
        },
      ]);

      const result = await controller.tenantInfo(TENANT_ID);

      expect(result.planTier).toBe('chain');
      expect(result.maxCampuses).toBe(99);
    });

    it('plan_tier=growth → 透传', async () => {
      pg.query.mockResolvedValueOnce([
        {
          id: TENANT_ID,
          name: 'X',
          status: 'active',
          version: 'v1',
          plan_tier: 'growth',
          max_campuses: 3,
          created_at: new Date('2026-05-01T00:00:00.000Z'),
        },
      ]);
      const result = await controller.tenantInfo(TENANT_ID);
      expect(result.planTier).toBe('growth');
    });

    it('pg.query 抛错 → controller 透传', async () => {
      pg.query.mockRejectedValueOnce(new Error('db down'));
      await expect(controller.tenantInfo(TENANT_ID)).rejects.toThrow('db down');
    });
  });

  // ============================================================
  // Case 5-11: createCampus()
  // ============================================================
  describe('createCampus()', () => {
    function validBody() {
      return {
        tenantId: TENANT_ID,
        id: CAMPUS_ID,
        name: '主校区',
        city: '北京',
        district: '朝阳',
        address: '某路 100 号',
        isHq: true,
      };
    }

    it('tenantId 缺 → BadRequest "tenantId must be 32-char ULID"', async () => {
      const body = { ...validBody(), tenantId: '' };
      await expect(controller.createCampus(body)).rejects.toThrow(
        'tenantId must be 32-char ULID',
      );
      expect(campusRepo.create).not.toHaveBeenCalled();
    });

    it('tenantId 长度 31 → BadRequest', async () => {
      const body = { ...validBody(), tenantId: 'a'.repeat(31) };
      await expect(controller.createCampus(body)).rejects.toThrow(
        'tenantId must be 32-char ULID',
      );
    });

    it('tenantId 长度 33 → BadRequest', async () => {
      const body = { ...validBody(), tenantId: 'a'.repeat(33) };
      await expect(controller.createCampus(body)).rejects.toThrow(
        'tenantId must be 32-char ULID',
      );
    });

    it('id 缺 → BadRequest "id must be 32-char ULID"', async () => {
      const body = { ...validBody(), id: '' };
      await expect(controller.createCampus(body)).rejects.toThrow(
        'id must be 32-char ULID',
      );
    });

    it('id 长度 ≠ 32 → BadRequest', async () => {
      const body = { ...validBody(), id: 'a'.repeat(16) };
      await expect(controller.createCampus(body)).rejects.toThrow(
        'id must be 32-char ULID',
      );
    });

    it('name 缺 → BadRequest "name required"', async () => {
      const body = { ...validBody(), name: '' };
      await expect(controller.createCampus(body)).rejects.toThrow('name required');
    });

    it('happy path 转交 campusRepo.create(tenantId, dto)', async () => {
      const c = campusFixture();
      campusRepo.create.mockResolvedValueOnce(c);

      const result = await controller.createCampus(validBody());

      expect(campusRepo.create).toHaveBeenCalledWith(TENANT_ID, {
        id: CAMPUS_ID,
        name: '主校区',
        city: '北京',
        district: '朝阳',
        address: '某路 100 号',
        isHq: true,
      });
      expect(result).toEqual(c);
    });

    it('可选字段 undefined → 透传 undefined 给 repo（不强转 null）', async () => {
      campusRepo.create.mockResolvedValueOnce(campusFixture());

      await controller.createCampus({
        tenantId: TENANT_ID,
        id: CAMPUS_ID,
        name: 'X',
      });

      expect(campusRepo.create).toHaveBeenCalledWith(TENANT_ID, {
        id: CAMPUS_ID,
        name: 'X',
        city: undefined,
        district: undefined,
        address: undefined,
        isHq: undefined,
      });
    });

    it('service 抛 NotFound（tenant 不存在）→ 透传', async () => {
      campusRepo.create.mockRejectedValueOnce(
        new NotFoundException(`tenant ${TENANT_ID} not found`),
      );
      await expect(controller.createCampus(validBody())).rejects.toThrow(
        NotFoundException,
      );
    });

    it('service 抛 CAMPUS_LIMIT_REACHED → 透传', async () => {
      campusRepo.create.mockRejectedValueOnce(
        new BadRequestException('CAMPUS_LIMIT_REACHED: max 1, current 1'),
      );
      await expect(controller.createCampus(validBody())).rejects.toThrow(
        'CAMPUS_LIMIT_REACHED',
      );
    });
  });

  // ============================================================
  // Case 12-13: listCampuses()
  // ============================================================
  describe('listCampuses()', () => {
    it('tenantId 缺 → BadRequest', async () => {
      await expect(controller.listCampuses({ tenantId: '' })).rejects.toThrow(
        'tenantId required',
      );
      expect(campusRepo.list).not.toHaveBeenCalled();
    });

    it('转交 campusRepo.list(tenantId)', async () => {
      const items = [campusFixture(), campusFixture({ id: 'c2'.padEnd(32, 'b') })];
      campusRepo.list.mockResolvedValueOnce(items);

      const result = await controller.listCampuses({ tenantId: TENANT_ID });

      expect(campusRepo.list).toHaveBeenCalledWith(TENANT_ID);
      expect(result).toEqual(items);
    });

    it('空数组直接返回', async () => {
      campusRepo.list.mockResolvedValueOnce([]);
      const result = await controller.listCampuses({ tenantId: TENANT_ID });
      expect(result).toEqual([]);
    });
  });

  // ============================================================
  // Case 14-15: campusStats()
  // ============================================================
  describe('campusStats()', () => {
    it('tenantId 缺 → BadRequest', async () => {
      await expect(controller.campusStats({ tenantId: '' })).rejects.toThrow(
        'tenantId required',
      );
      expect(campusRepo.getStats30d).not.toHaveBeenCalled();
    });

    it('转交 campusRepo.getStats30d(tenantId)', async () => {
      const stats = {
        totalCampuses: 2,
        totalStudents: 100,
        totalTeachers: 12,
        perCampus: [
          { campusId: CAMPUS_ID, name: '主校区', studentCount: 60, teacherCount: 8 },
          { campusId: 'X'.repeat(32), name: '分校', studentCount: 40, teacherCount: 4 },
        ],
      };
      campusRepo.getStats30d.mockResolvedValueOnce(stats);

      const result = await controller.campusStats({ tenantId: TENANT_ID });

      expect(campusRepo.getStats30d).toHaveBeenCalledWith(TENANT_ID);
      expect(result).toEqual(stats);
    });
  });

  // ============================================================
  // Case 16-18: upgradeSubscription()
  // ============================================================
  describe('upgradeSubscription()', () => {
    it('tenantId 缺 → BadRequest', async () => {
      await expect(
        controller.upgradeSubscription({
          tenantId: '',
          targetPlan: 'growth',
        }),
      ).rejects.toThrow('tenantId required');
      expect(subRepo.upgrade).not.toHaveBeenCalled();
    });

    it('targetPlan 缺 → BadRequest', async () => {
      await expect(
        controller.upgradeSubscription({
          tenantId: TENANT_ID,
          targetPlan: '' as PlanTier,
        }),
      ).rejects.toThrow('targetPlan required');
      expect(subRepo.upgrade).not.toHaveBeenCalled();
    });

    it('转交 subRepo.upgrade(tenantId, targetPlan)', async () => {
      const upgradeResult = {
        ok: true as const,
        oldPlan: 'single' as PlanTier,
        newPlan: 'growth' as PlanTier,
        priceDiff: 3998,
        paymentRequired: true,
        mockPayUrl: 'EXT-01-todo',
      };
      subRepo.upgrade.mockResolvedValueOnce(upgradeResult);

      const result = await controller.upgradeSubscription({
        tenantId: TENANT_ID,
        targetPlan: 'growth',
      });

      expect(subRepo.upgrade).toHaveBeenCalledWith(TENANT_ID, 'growth');
      expect(result).toEqual(upgradeResult);
    });

    it('service 抛 BadRequest invalid plan → 透传', async () => {
      subRepo.upgrade.mockRejectedValueOnce(
        new BadRequestException('invalid targetPlan: bogus'),
      );
      await expect(
        controller.upgradeSubscription({
          tenantId: TENANT_ID,
          targetPlan: 'bogus' as PlanTier,
        }),
      ).rejects.toThrow('invalid targetPlan');
    });
  });

  // ============================================================
  // Case 19-20: getSubscription()
  // ============================================================
  describe('getSubscription()', () => {
    it('tenantId 缺 → BadRequest', async () => {
      await expect(controller.getSubscription('')).rejects.toThrow(
        'tenantId required',
      );
      expect(subRepo.getCurrent).not.toHaveBeenCalled();
    });

    it('转交 subRepo.getCurrent(tenantId)', async () => {
      const sub = subscriptionFixture();
      subRepo.getCurrent.mockResolvedValueOnce(sub);

      const result = await controller.getSubscription(TENANT_ID);

      expect(subRepo.getCurrent).toHaveBeenCalledWith(TENANT_ID);
      expect(result).toEqual(sub);
    });

    it('返带 promotion 的 subscription（含 actualPriceYuan/promotionExpiresAt）', async () => {
      const sub = subscriptionFixture({
        promotionCode: 'EARLY',
        promotionName: '早鸟',
        discountPct: 50,
        actualPriceYuan: 999,
        promotionStatus: 'committed',
        promotionLockedAt: '2026-05-01T00:00:00.000Z',
        promotionExpiresAt: '2027-05-01T00:00:00.000Z',
        nextYearPriceYuan: 999,
      });
      subRepo.getCurrent.mockResolvedValueOnce(sub);

      const result = await controller.getSubscription(TENANT_ID);

      expect(result.promotionCode).toBe('EARLY');
      expect(result.actualPriceYuan).toBe(999);
    });

    it('service 抛 NotFound → 透传', async () => {
      subRepo.getCurrent.mockRejectedValueOnce(
        new NotFoundException(`tenant ${TENANT_ID} not found`),
      );
      await expect(controller.getSubscription(TENANT_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
