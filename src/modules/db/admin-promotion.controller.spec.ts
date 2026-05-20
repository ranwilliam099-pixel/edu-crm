/**
 * admin-promotion.controller.spec.ts (5/20 stryker 0% coverage 修补)
 *
 * 来源：5/20 stryker mutation 跑出 AdminPromotionController 83 mutant 全 no-cov
 *   → 平台超管促销配置面板（V20 拍板，5 endpoint + 2 helper 私有方法），上线后从未测试
 *   → 同 audit_log + business-metrics silent fail 模式
 *
 * 覆盖 case：
 *   1. list() — 调 promoRepo.listTiers，返 { items: PromotionTier[] }
 *   2. get(:code) — 调 promoRepo.getTier(code)，转交 service 返回
 *   3. create() — body.code/name 缺一 → BadRequestException
 *   4. create() — KOL invariant 违规（sourceType=kol 但 inviteCode 空）→ BadRequest
 *   5. create() — KOL invariant 违规（sourceType≠kol 但 inviteCode 有）→ BadRequest
 *   6. create() — happy path 调 upsertTier(body, audit ctx)
 *   7. create() — audit ctx 提取（user.sub / user.role / x-forwarded-for first IP / req.ip 兜底）
 *   8. update(:code) — getTier 先取 existing，body 字段未传 → 用 existing 值
 *   9. update(:code) — body 显式传 null（quotaTotal/startsAt/endsAt/activationRules/inviteCode）→ 保留 null
 *   10. update(:code) — KOL invariant 在 merge 后校验
 *   11. update(:code) — merge 后调 upsertTier(merged, audit)
 *   12. toggle(:code) — body.active 非 boolean → BadRequest
 *   13. toggle(:code) — body.active=true → toggleActive(code, true, audit)
 *   14. toggle(:code) — body.active=false → toggleActive(code, false, audit)
 *   15. remove(:code) — 调 softDelete(code, audit) 返 { ok: true }
 *   16. dryRun(:code) — 传 body → 转交 dryRun(code, body)
 *   17. dryRun(:code) — body 为 undefined → 传 {} 给 repo
 *   18. lockedTenants(:code) — 默认 limit=50 / offset=0
 *   19. lockedTenants(:code) — limit 参数解析（Math.min 200 上限）
 *   20. lockedTenants(:code) — offset 参数解析
 *   21. audit() 私有 — x-forwarded-for 数组取第一个
 *   22. audit() 私有 — 无 user → operatorRole 默认 'platform_admin'
 *   23. audit() 私有 — 无 ip → operatorIp undefined
 *   24. service 抛错 → controller 透传（错误不吞）
 *
 * 学到的范式 (business-metrics.service.spec.ts)：
 *   - 精确 toHaveBeenCalledWith 含具体参数（非 toBeDefined / toHaveBeenCalled 无参）
 *   - rejects.toThrow 抛错断言
 *   - mock service 用 jest.fn().mockResolvedValue / .mockRejectedValue
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminPromotionController } from './admin-promotion.controller';
import { PromotionRepository } from './promotion.repository';
import { PromotionTier, PromotionDryRun } from './promotion.types';
import { AuthenticatedRequest, JwtPayload } from '../auth/jwt-payload.interface';

describe('AdminPromotionController (5/20 stryker 0% coverage 修补)', () => {
  let controller: AdminPromotionController;
  let promoRepo: {
    listTiers: jest.Mock;
    getTier: jest.Mock;
    upsertTier: jest.Mock;
    toggleActive: jest.Mock;
    softDelete: jest.Mock;
    dryRun: jest.Mock;
    listLockedTenants: jest.Mock;
  };

  const ADMIN_SUB = 'platformAdmin0000000000000000A01';

  function platformJwt(): JwtPayload {
    return {
      sub: ADMIN_SUB,
      tenantId: null,
      role: 'platform_admin',
      campusId: null,
    };
  }

  function req(
    user?: JwtPayload,
    headers: Record<string, string | string[] | undefined> = {},
    ip?: string,
  ): AuthenticatedRequest {
    return { user, headers, ip, body: {}, query: {}, params: {} };
  }

  function tier(overrides: Partial<PromotionTier> = {}): PromotionTier {
    return {
      id: 1,
      code: 'V20_EARLY',
      name: '早鸟优惠',
      discountPct: 50,
      quotaTotal: 100,
      quotaUsed: 10,
      active: true,
      startsAt: '2026-05-01T00:00:00.000Z',
      endsAt: '2026-12-31T23:59:59.000Z',
      activationRules: { teachers: 2 },
      appliesToPlans: ['single', 'growth'],
      appliesYears: 1,
      sourceType: 'self_service',
      inviteCode: null,
      version: 1,
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
      ...overrides,
    };
  }

  beforeEach(() => {
    promoRepo = {
      listTiers: jest.fn(),
      getTier: jest.fn(),
      upsertTier: jest.fn(),
      toggleActive: jest.fn(),
      softDelete: jest.fn(),
      dryRun: jest.fn(),
      listLockedTenants: jest.fn(),
    };
    controller = new AdminPromotionController(
      promoRepo as unknown as PromotionRepository,
    );
  });

  // ============================================================
  // Case 1: list()
  // ============================================================
  describe('list()', () => {
    it('调 promoRepo.listTiers 返 { items: PromotionTier[] }', async () => {
      const t1 = tier({ code: 'A' });
      const t2 = tier({ code: 'B', id: 2 });
      promoRepo.listTiers.mockResolvedValueOnce([t1, t2]);

      const result = await controller.list();

      expect(promoRepo.listTiers).toHaveBeenCalledWith();
      expect(promoRepo.listTiers).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ items: [t1, t2] });
    });

    it('空列表 → { items: [] }', async () => {
      promoRepo.listTiers.mockResolvedValueOnce([]);
      const result = await controller.list();
      expect(result).toEqual({ items: [] });
    });
  });

  // ============================================================
  // Case 2: get(:code)
  // ============================================================
  describe('get(:code)', () => {
    it('调 promoRepo.getTier(code) 直接转交返回', async () => {
      const t = tier({ code: 'EARLY' });
      promoRepo.getTier.mockResolvedValueOnce(t);

      const result = await controller.get('EARLY');

      expect(promoRepo.getTier).toHaveBeenCalledWith('EARLY');
      expect(result).toEqual(t);
    });

    it('service 抛 NotFound → controller 透传不吞', async () => {
      // mockRejectedValue (no Once) → 两次 await expect 都能命中
      promoRepo.getTier.mockRejectedValue(
        new NotFoundException('promotion tier UNKNOWN not found'),
      );

      await expect(controller.get('UNKNOWN')).rejects.toThrow(NotFoundException);
      await expect(controller.get('UNKNOWN')).rejects.toThrow(
        'promotion tier UNKNOWN not found',
      );
    });
  });

  // ============================================================
  // Case 3-7: create()
  // ============================================================
  describe('create()', () => {
    it('body.code 缺 → BadRequest "code and name required" (instanceof)', async () => {
      const body = {
        code: '',
        name: 'X',
        discountPct: 50,
        quotaTotal: 10,
      };
      await expect(
        controller.create(body as any, req(platformJwt())),
      ).rejects.toThrow(BadRequestException);
      expect(promoRepo.upsertTier).not.toHaveBeenCalled();
    });

    it('body.code 缺 → BadRequest message "code and name required"', async () => {
      const body = {
        code: '',
        name: 'X',
        discountPct: 50,
        quotaTotal: 10,
      };
      await expect(
        controller.create(body as any, req(platformJwt())),
      ).rejects.toThrow('code and name required');
    });

    it('body.name 缺 → BadRequest "code and name required"', async () => {
      const body = { code: 'X', name: '', discountPct: 50, quotaTotal: 10 };
      await expect(
        controller.create(body as any, req(platformJwt())),
      ).rejects.toThrow('code and name required');
    });

    it('KOL invariant — sourceType=kol 但 inviteCode 空 → BadRequest', async () => {
      const body = {
        code: 'KOL1',
        name: 'KOL 推广',
        discountPct: 30,
        quotaTotal: 50,
        sourceType: 'kol' as const,
        inviteCode: null,
      };
      await expect(
        controller.create(body, req(platformJwt())),
      ).rejects.toThrow('KOL source requires non-null inviteCode');
      expect(promoRepo.upsertTier).not.toHaveBeenCalled();
    });

    it('KOL invariant — sourceType=self_service 但 inviteCode 有值 → BadRequest', async () => {
      const body = {
        code: 'CAMP1',
        name: '活动',
        discountPct: 20,
        quotaTotal: 10,
        sourceType: 'self_service' as const,
        inviteCode: 'WRONG',
      };
      await expect(
        controller.create(body, req(platformJwt())),
      ).rejects.toThrow('inviteCode only allowed when sourceType=kol');
      expect(promoRepo.upsertTier).not.toHaveBeenCalled();
    });

    it('KOL 合规 + happy path → upsertTier(body, audit ctx)', async () => {
      const body = {
        code: 'KOL1',
        name: 'KOL 推广',
        discountPct: 30,
        quotaTotal: 50,
        sourceType: 'kol' as const,
        inviteCode: 'GIRL_BAND',
      };
      const after = tier({
        code: 'KOL1',
        sourceType: 'kol',
        inviteCode: 'GIRL_BAND',
      });
      promoRepo.upsertTier.mockResolvedValueOnce(after);

      const headers = {
        'x-forwarded-for': '203.0.113.1, 10.0.0.5',
      };
      const result = await controller.create(body, req(platformJwt(), headers));

      expect(promoRepo.upsertTier).toHaveBeenCalledWith(body, {
        operatorId: ADMIN_SUB,
        operatorRole: 'platform_admin',
        operatorIp: '203.0.113.1',
      });
      expect(result).toEqual(after);
    });

    it('audit ctx — x-forwarded-for 数组取第一个元素', async () => {
      const body = {
        code: 'C1',
        name: 'N',
        discountPct: 10,
        quotaTotal: 5,
      };
      promoRepo.upsertTier.mockResolvedValueOnce(tier({ code: 'C1' }));
      const headers = {
        'x-forwarded-for': ['198.51.100.1', '10.0.0.1'] as string[],
      };

      await controller.create(body, req(platformJwt(), headers));

      expect(promoRepo.upsertTier).toHaveBeenCalledWith(
        body,
        expect.objectContaining({ operatorIp: '198.51.100.1' }),
      );
    });

    it('audit ctx — 无 user → operatorId undefined + operatorRole 兜底 platform_admin', async () => {
      const body = { code: 'C2', name: 'N', discountPct: 0, quotaTotal: 0 };
      promoRepo.upsertTier.mockResolvedValueOnce(tier({ code: 'C2' }));

      await controller.create(body, req(undefined, {}, '127.0.0.1'));

      expect(promoRepo.upsertTier).toHaveBeenCalledWith(body, {
        operatorId: undefined,
        operatorRole: 'platform_admin',
        operatorIp: '127.0.0.1',
      });
    });

    it('audit ctx — 无 ip 任何来源 → operatorIp undefined', async () => {
      const body = { code: 'C3', name: 'N', discountPct: 0, quotaTotal: 0 };
      promoRepo.upsertTier.mockResolvedValueOnce(tier({ code: 'C3' }));

      await controller.create(body, req(platformJwt(), {}, undefined));

      expect(promoRepo.upsertTier).toHaveBeenCalledWith(body, {
        operatorId: ADMIN_SUB,
        operatorRole: 'platform_admin',
        operatorIp: undefined,
      });
    });

    it('audit ctx — user.role 非 platform_admin → 用 user.role（不兜底）', async () => {
      const body = { code: 'C4', name: 'N', discountPct: 0, quotaTotal: 0 };
      promoRepo.upsertTier.mockResolvedValueOnce(tier({ code: 'C4' }));
      const user = { ...platformJwt(), role: 'finance_admin' as const };

      await controller.create(body, req(user));

      expect(promoRepo.upsertTier).toHaveBeenCalledWith(
        body,
        expect.objectContaining({ operatorRole: 'finance_admin' }),
      );
    });

    it('service 抛错 → controller 透传不吞', async () => {
      const body = { code: 'C5', name: 'N', discountPct: 0, quotaTotal: 0 };
      promoRepo.upsertTier.mockRejectedValueOnce(new Error('db down'));

      await expect(
        controller.create(body, req(platformJwt())),
      ).rejects.toThrow('db down');
    });
  });

  // ============================================================
  // Case 8-11: update(:code)
  // ============================================================
  describe('update(:code)', () => {
    it('body 字段未传 → 用 existing 值 merge', async () => {
      const existing = tier({
        code: 'X',
        name: '老名',
        discountPct: 30,
        quotaTotal: 50,
        active: true,
        startsAt: '2026-01-01T00:00:00.000Z',
        endsAt: '2026-12-31T23:59:59.000Z',
        activationRules: { teachers: 1 },
        appliesToPlans: ['single'],
        appliesYears: 2,
        sourceType: 'self_service',
        inviteCode: null,
      });
      promoRepo.getTier.mockResolvedValueOnce(existing);
      promoRepo.upsertTier.mockResolvedValueOnce(existing);

      await controller.update('X', {}, req(platformJwt()));

      expect(promoRepo.getTier).toHaveBeenCalledWith('X');
      expect(promoRepo.upsertTier).toHaveBeenCalledWith(
        {
          code: 'X',
          name: '老名',
          discountPct: 30,
          quotaTotal: 50,
          active: true,
          startsAt: '2026-01-01T00:00:00.000Z',
          endsAt: '2026-12-31T23:59:59.000Z',
          activationRules: { teachers: 1 },
          appliesToPlans: ['single'],
          appliesYears: 2,
          sourceType: 'self_service',
          inviteCode: null,
        },
        expect.objectContaining({ operatorRole: 'platform_admin' }),
      );
    });

    it('body 显式传 null（quotaTotal/startsAt/endsAt/activationRules/inviteCode）→ 保留 null', async () => {
      const existing = tier({
        code: 'X',
        quotaTotal: 50,
        startsAt: '2026-01-01T00:00:00.000Z',
        endsAt: '2026-12-31T23:59:59.000Z',
        activationRules: { teachers: 1 },
        inviteCode: 'OLD',
        sourceType: 'kol',
      });
      promoRepo.getTier.mockResolvedValueOnce(existing);
      promoRepo.upsertTier.mockResolvedValueOnce(existing);

      // 显式传 null 覆盖 + sourceType 改 self_service 让 inviteCode=null 合规
      await controller.update(
        'X',
        {
          quotaTotal: null,
          startsAt: null,
          endsAt: null,
          activationRules: null,
          inviteCode: null,
          sourceType: 'self_service',
        },
        req(platformJwt()),
      );

      expect(promoRepo.upsertTier).toHaveBeenCalledWith(
        expect.objectContaining({
          quotaTotal: null,
          startsAt: null,
          endsAt: null,
          activationRules: null,
          inviteCode: null,
          sourceType: 'self_service',
        }),
        expect.any(Object),
      );
    });

    it('body 显式传新值 → 覆盖 existing', async () => {
      const existing = tier({
        code: 'X',
        name: '老',
        discountPct: 30,
      });
      promoRepo.getTier.mockResolvedValueOnce(existing);
      promoRepo.upsertTier.mockResolvedValueOnce(existing);

      await controller.update(
        'X',
        { name: '新名', discountPct: 50 },
        req(platformJwt()),
      );

      expect(promoRepo.upsertTier).toHaveBeenCalledWith(
        expect.objectContaining({ name: '新名', discountPct: 50 }),
        expect.any(Object),
      );
    });

    it('KOL invariant 在 merge 后校验 — existing kol + 改 inviteCode=null → BadRequest', async () => {
      const existing = tier({
        code: 'X',
        sourceType: 'kol',
        inviteCode: 'OLD',
      });
      promoRepo.getTier.mockResolvedValueOnce(existing);

      await expect(
        controller.update('X', { inviteCode: null }, req(platformJwt())),
      ).rejects.toThrow('KOL source requires non-null inviteCode');
      expect(promoRepo.upsertTier).not.toHaveBeenCalled();
    });

    it('KOL invariant 在 merge 后校验 — existing self + 改 sourceType=kol 但不给 inviteCode → BadRequest', async () => {
      const existing = tier({
        code: 'X',
        sourceType: 'self_service',
        inviteCode: null,
      });
      promoRepo.getTier.mockResolvedValueOnce(existing);

      await expect(
        controller.update('X', { sourceType: 'kol' }, req(platformJwt())),
      ).rejects.toThrow('KOL source requires non-null inviteCode');
    });

    it('getTier NotFound → 直接透传不查 upsert', async () => {
      promoRepo.getTier.mockRejectedValueOnce(
        new NotFoundException('promotion tier UNKNOWN not found'),
      );

      await expect(
        controller.update('UNKNOWN', { name: 'X' }, req(platformJwt())),
      ).rejects.toThrow(NotFoundException);
      expect(promoRepo.upsertTier).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // Case 12-14: toggle(:code)
  // ============================================================
  describe('toggle(:code)', () => {
    it('body.active 非 boolean (undefined) → BadRequest', async () => {
      await expect(
        controller.toggle('X', {} as any, req(platformJwt())),
      ).rejects.toThrow('active boolean required');
      expect(promoRepo.toggleActive).not.toHaveBeenCalled();
    });

    it('body.active 非 boolean (string) → BadRequest', async () => {
      await expect(
        controller.toggle('X', { active: 'true' } as any, req(platformJwt())),
      ).rejects.toThrow('active boolean required');
    });

    it('body.active=true → toggleActive(code, true, audit ctx)', async () => {
      const t = tier({ code: 'X', active: true });
      promoRepo.toggleActive.mockResolvedValueOnce(t);

      const result = await controller.toggle(
        'X',
        { active: true },
        req(platformJwt()),
      );

      expect(promoRepo.toggleActive).toHaveBeenCalledWith('X', true, {
        operatorId: ADMIN_SUB,
        operatorRole: 'platform_admin',
        operatorIp: undefined,
      });
      expect(result).toEqual(t);
    });

    it('body.active=false → toggleActive(code, false, audit ctx)', async () => {
      const t = tier({ code: 'X', active: false });
      promoRepo.toggleActive.mockResolvedValueOnce(t);

      const result = await controller.toggle(
        'X',
        { active: false },
        req(platformJwt()),
      );

      expect(promoRepo.toggleActive).toHaveBeenCalledWith(
        'X',
        false,
        expect.any(Object),
      );
      expect(result.active).toBe(false);
    });
  });

  // ============================================================
  // Case 15: remove(:code)
  // ============================================================
  describe('remove(:code)', () => {
    it('调 softDelete(code, audit ctx) 返 { ok: true }', async () => {
      promoRepo.softDelete.mockResolvedValueOnce({ ok: true });

      const result = await controller.remove('X', req(platformJwt()) as any);

      expect(promoRepo.softDelete).toHaveBeenCalledWith('X', {
        operatorId: ADMIN_SUB,
        operatorRole: 'platform_admin',
        operatorIp: undefined,
      });
      expect(result).toEqual({ ok: true });
    });

    it('service 抛 NotFound → 透传', async () => {
      promoRepo.softDelete.mockRejectedValueOnce(
        new NotFoundException('promotion tier UNKNOWN not found'),
      );

      await expect(
        controller.remove('UNKNOWN', req(platformJwt()) as any),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ============================================================
  // Case 16-17: dryRun(:code)
  // ============================================================
  describe('dryRun(:code)', () => {
    it('传 body → 转交 dryRun(code, body)', async () => {
      const dr: PromotionDryRun = {
        affectedTenantsLocked: 5,
        remainingQuota: 40,
        estimatedNewActivations: 40,
        estimatedGmvDeltaYuan: 12000,
        warnings: [],
      };
      promoRepo.dryRun.mockResolvedValueOnce(dr);

      const body = { discountPct: 60, quotaTotal: 50 };
      const result = await controller.dryRun('X', body);

      expect(promoRepo.dryRun).toHaveBeenCalledWith('X', body);
      expect(result).toEqual(dr);
    });

    it('body undefined → 传 {} 给 repo', async () => {
      promoRepo.dryRun.mockResolvedValueOnce({
        affectedTenantsLocked: 0,
        remainingQuota: 100,
        estimatedNewActivations: 100,
        estimatedGmvDeltaYuan: 0,
        warnings: [],
      });

      await controller.dryRun('X', undefined as any);

      expect(promoRepo.dryRun).toHaveBeenCalledWith('X', {});
    });

    it('body null → 传 {} 给 repo', async () => {
      promoRepo.dryRun.mockResolvedValueOnce({
        affectedTenantsLocked: 0,
        remainingQuota: null,
        estimatedNewActivations: 0,
        estimatedGmvDeltaYuan: 0,
        warnings: [],
      });

      await controller.dryRun('X', null as any);

      expect(promoRepo.dryRun).toHaveBeenCalledWith('X', {});
    });
  });

  // ============================================================
  // Case 18-20: lockedTenants(:code)
  // ============================================================
  describe('lockedTenants(:code)', () => {
    it('默认 limit=50 / offset=0', async () => {
      promoRepo.listLockedTenants.mockResolvedValueOnce({ items: [], total: 0 });

      await controller.lockedTenants('X');

      expect(promoRepo.listLockedTenants).toHaveBeenCalledWith('X', {
        limit: 50,
        offset: 0,
      });
    });

    it('limit 参数解析为 int', async () => {
      promoRepo.listLockedTenants.mockResolvedValueOnce({ items: [], total: 0 });

      await controller.lockedTenants('X', '100', undefined);

      expect(promoRepo.listLockedTenants).toHaveBeenCalledWith('X', {
        limit: 100,
        offset: 0,
      });
    });

    it('limit > 200 → 截断为 200（Math.min 上限）', async () => {
      promoRepo.listLockedTenants.mockResolvedValueOnce({ items: [], total: 0 });

      await controller.lockedTenants('X', '500', undefined);

      expect(promoRepo.listLockedTenants).toHaveBeenCalledWith('X', {
        limit: 200,
        offset: 0,
      });
    });

    it('offset 参数解析为 int', async () => {
      promoRepo.listLockedTenants.mockResolvedValueOnce({ items: [], total: 0 });

      await controller.lockedTenants('X', undefined, '25');

      expect(promoRepo.listLockedTenants).toHaveBeenCalledWith('X', {
        limit: 50,
        offset: 25,
      });
    });

    it('limit + offset 都传', async () => {
      promoRepo.listLockedTenants.mockResolvedValueOnce({
        items: [
          {
            tenantId: 'tA',
            status: 'reserved',
            lockedAt: '2026-05-01T00:00:00Z',
            priceYuan: 999,
          },
        ],
        total: 1,
      });

      const result = await controller.lockedTenants('X', '30', '60');

      expect(promoRepo.listLockedTenants).toHaveBeenCalledWith('X', {
        limit: 30,
        offset: 60,
      });
      expect(result.total).toBe(1);
    });
  });
});
