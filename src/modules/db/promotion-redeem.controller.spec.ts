/**
 * promotion-redeem.controller.spec.ts (V20 KOL 邀请码兑换 controller — 5/20 stryker 0% coverage 修补)
 *
 * 来源：5/20 stryker mutation 跑出 promotion-redeem.controller 53 mutant 全 no-cov
 *   → 该 controller 是「KOL 邀请码」单 endpoint POST /db/checkout/redeem-invite-code
 *   → 涉及销售线上业绩（折扣抢档 atomic）+ race 防御（reserve 后二次校验 plan_tier）
 *
 * 范围（covers 53 mutant / 93 行）：
 *   - 输入校验：tenantId 必填 / inviteCode 必填
 *   - tier 查找：findByInviteCode 返 null → INVITE_CODE_INVALID
 *   - tier 状态：sourceType 非 kol → INVITE_CODE_NOT_KOL
 *   - tier active：active=false → INVITE_CODE_INACTIVE
 *   - tier 时间窗：endsAt 已过 → INVITE_CODE_EXPIRED
 *   - planTier 覆盖：传入但不在 appliesToPlans → INVITE_CODE_PLAN_NOT_COVERED
 *   - reserveQuota 调用：operatorId / operatorRole='kol_self' / operatorIp 提取
 *   - IP 提取：x-forwarded-for 数组 / 字符串 / 多 IP 逗号分隔 / 兜底 req.ip
 *   - race 防御：reserve 后二次校验 tenant plan_tier 不兼容 → releaseQuota + 抛 PLAN_NOT_COVERED
 *   - 200 响应：promotionCode + actualPriceYuan + discountPct
 */

import { BadRequestException } from '@nestjs/common';
import { PromotionRedeemController } from './promotion-redeem.controller';
import { PromotionRepository } from './promotion.repository';
import { PromotionQuotaService } from './promotion-quota.service';
import { PromotionTier } from './promotion.types';
import { AuthenticatedRequest, JwtPayload } from '../auth/jwt-payload.interface';

describe('PromotionRedeemController (5/20 stryker no-cov 修补 — V20 KOL 邀请码)', () => {
  let controller: PromotionRedeemController;
  let promoRepo: {
    findByInviteCode: jest.Mock;
    getTenantPlanTier: jest.Mock;
  };
  let quota: {
    reserveQuota: jest.Mock;
    releaseQuota: jest.Mock;
  };

  const TENANT_A = 'tenant00000000000000000000000A01';
  const USER_A = 'user0000000000000000000000000A01';
  const INVITE_CODE = 'KOL-ABC123';

  function jwt(sub = USER_A): JwtPayload {
    return { sub, tenantId: TENANT_A, role: 'admin', campusId: null };
  }

  function req(
    user?: JwtPayload,
    headers: Record<string, string | string[] | undefined> = {},
    ip?: string,
  ): AuthenticatedRequest {
    return { user, headers, body: {}, query: {}, params: {}, ip };
  }

  function tierFixture(overrides: Partial<PromotionTier> = {}): PromotionTier {
    return {
      id: 1,
      code: 'kol_abc',
      name: 'KOL ABC 折扣',
      discountPct: 70,
      quotaTotal: 100,
      quotaUsed: 5,
      active: true,
      startsAt: null,
      endsAt: null,
      activationRules: null,
      appliesToPlans: ['single', 'growth', 'chain'],
      appliesYears: 1,
      sourceType: 'kol',
      inviteCode: INVITE_CODE,
      version: 1,
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
      ...overrides,
    };
  }

  beforeEach(() => {
    promoRepo = {
      findByInviteCode: jest.fn(),
      getTenantPlanTier: jest.fn(),
    };
    quota = {
      reserveQuota: jest.fn(),
      releaseQuota: jest.fn(),
    };
    controller = new PromotionRedeemController(
      promoRepo as unknown as PromotionRepository,
      quota as unknown as PromotionQuotaService,
    );
  });

  // ============================================================
  // 输入校验
  // ============================================================
  describe('input validation', () => {
    it('case-1: 缺 tenantId → BadRequest tenantId required', async () => {
      await expect(
        controller.redeem(
          { tenantId: '', inviteCode: INVITE_CODE },
          req(jwt()),
        ),
      ).rejects.toThrow(new BadRequestException('tenantId required'));
      expect(promoRepo.findByInviteCode).not.toHaveBeenCalled();
    });

    it('case-2: 缺 inviteCode → BadRequest inviteCode required', async () => {
      await expect(
        controller.redeem({ tenantId: TENANT_A, inviteCode: '' }, req(jwt())),
      ).rejects.toThrow(new BadRequestException('inviteCode required'));
      expect(promoRepo.findByInviteCode).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // tier 状态校验
  // ============================================================
  describe('tier validation', () => {
    it('case-3: findByInviteCode 返 null → INVITE_CODE_INVALID', async () => {
      promoRepo.findByInviteCode.mockResolvedValueOnce(null);
      await expect(
        controller.redeem(
          { tenantId: TENANT_A, inviteCode: INVITE_CODE },
          req(jwt()),
        ),
      ).rejects.toThrow(new BadRequestException('INVITE_CODE_INVALID'));
      expect(quota.reserveQuota).not.toHaveBeenCalled();
    });

    it('case-4: tier.sourceType=self_service → INVITE_CODE_NOT_KOL（防 self_service 当 KOL 用）', async () => {
      promoRepo.findByInviteCode.mockResolvedValueOnce(
        tierFixture({ sourceType: 'self_service' }),
      );
      await expect(
        controller.redeem(
          { tenantId: TENANT_A, inviteCode: INVITE_CODE },
          req(jwt()),
        ),
      ).rejects.toThrow(new BadRequestException('INVITE_CODE_NOT_KOL'));
    });

    it('case-5: tier.sourceType=campaign → INVITE_CODE_NOT_KOL', async () => {
      promoRepo.findByInviteCode.mockResolvedValueOnce(
        tierFixture({ sourceType: 'campaign' }),
      );
      await expect(
        controller.redeem(
          { tenantId: TENANT_A, inviteCode: INVITE_CODE },
          req(jwt()),
        ),
      ).rejects.toThrow(new BadRequestException('INVITE_CODE_NOT_KOL'));
    });

    it('case-6: tier.active=false → INVITE_CODE_INACTIVE', async () => {
      promoRepo.findByInviteCode.mockResolvedValueOnce(
        tierFixture({ active: false }),
      );
      await expect(
        controller.redeem(
          { tenantId: TENANT_A, inviteCode: INVITE_CODE },
          req(jwt()),
        ),
      ).rejects.toThrow(new BadRequestException('INVITE_CODE_INACTIVE'));
    });

    it('case-7: tier.endsAt < now → INVITE_CODE_EXPIRED', async () => {
      const past = new Date(Date.now() - 86400000).toISOString();
      promoRepo.findByInviteCode.mockResolvedValueOnce(
        tierFixture({ endsAt: past }),
      );
      await expect(
        controller.redeem(
          { tenantId: TENANT_A, inviteCode: INVITE_CODE },
          req(jwt()),
        ),
      ).rejects.toThrow(new BadRequestException('INVITE_CODE_EXPIRED'));
    });

    it('case-8: tier.endsAt = now 边界（<= now）→ INVITE_CODE_EXPIRED（代码用 <= 严格判断）', async () => {
      const justNow = new Date();
      promoRepo.findByInviteCode.mockResolvedValueOnce(
        tierFixture({ endsAt: justNow.toISOString() }),
      );
      // 因为代码用 <=，相同时间也算过期
      await expect(
        controller.redeem(
          { tenantId: TENANT_A, inviteCode: INVITE_CODE },
          req(jwt()),
        ),
      ).rejects.toThrow(/INVITE_CODE_EXPIRED/);
    });

    it('case-9: tier.endsAt 未来时间 → 不算过期，继续走 reserveQuota', async () => {
      const future = new Date(Date.now() + 86400000 * 30).toISOString();
      promoRepo.findByInviteCode.mockResolvedValueOnce(
        tierFixture({ endsAt: future }),
      );
      promoRepo.getTenantPlanTier.mockResolvedValueOnce(null);
      quota.reserveQuota.mockResolvedValueOnce({
        tier: tierFixture(),
        reservedAt: '2026-05-15T00:00:00.000Z',
        actualPriceYuan: 1399,
      });

      await expect(
        controller.redeem(
          { tenantId: TENANT_A, inviteCode: INVITE_CODE },
          req(jwt()),
        ),
      ).resolves.toBeDefined();
      expect(quota.reserveQuota).toHaveBeenCalledTimes(1);
    });

    it('case-10: tier.endsAt=null（永久有效）→ 跳过时间窗判断，继续', async () => {
      promoRepo.findByInviteCode.mockResolvedValueOnce(
        tierFixture({ endsAt: null }),
      );
      promoRepo.getTenantPlanTier.mockResolvedValueOnce(null);
      quota.reserveQuota.mockResolvedValueOnce({
        tier: tierFixture(),
        reservedAt: '2026-05-15T00:00:00.000Z',
        actualPriceYuan: 1399,
      });

      await expect(
        controller.redeem(
          { tenantId: TENANT_A, inviteCode: INVITE_CODE },
          req(jwt()),
        ),
      ).resolves.toBeDefined();
    });
  });

  // ============================================================
  // plan_tier 限定（前置校验）
  // ============================================================
  describe('planTier coverage (pre-reserve)', () => {
    it('case-11: planTier=single 在 [single,growth] 中 → 通过', async () => {
      promoRepo.findByInviteCode.mockResolvedValueOnce(
        tierFixture({ appliesToPlans: ['single', 'growth'] }),
      );
      promoRepo.getTenantPlanTier.mockResolvedValueOnce(null);
      quota.reserveQuota.mockResolvedValueOnce({
        tier: tierFixture(),
        reservedAt: '2026-05-15T00:00:00.000Z',
        actualPriceYuan: 999,
      });

      await expect(
        controller.redeem(
          { tenantId: TENANT_A, inviteCode: INVITE_CODE, planTier: 'single' },
          req(jwt()),
        ),
      ).resolves.toBeDefined();
    });

    it('case-12: planTier=chain 不在 [single,growth] → INVITE_CODE_PLAN_NOT_COVERED + 列举 applies', async () => {
      promoRepo.findByInviteCode.mockResolvedValueOnce(
        tierFixture({ appliesToPlans: ['single', 'growth'] }),
      );
      await expect(
        controller.redeem(
          { tenantId: TENANT_A, inviteCode: INVITE_CODE, planTier: 'chain' },
          req(jwt()),
        ),
      ).rejects.toThrow(/INVITE_CODE_PLAN_NOT_COVERED.*applies to single,growth/);
      expect(quota.reserveQuota).not.toHaveBeenCalled();
    });

    it('case-13: planTier 未传 → 跳过前置校验，直接 reserve（race 防御走二次）', async () => {
      promoRepo.findByInviteCode.mockResolvedValueOnce(
        tierFixture({ appliesToPlans: ['single'] }),
      );
      promoRepo.getTenantPlanTier.mockResolvedValueOnce(null);
      quota.reserveQuota.mockResolvedValueOnce({
        tier: tierFixture(),
        reservedAt: '2026-05-15T00:00:00.000Z',
        actualPriceYuan: 999,
      });

      await expect(
        controller.redeem(
          { tenantId: TENANT_A, inviteCode: INVITE_CODE },
          req(jwt()),
        ),
      ).resolves.toBeDefined();
    });
  });

  // ============================================================
  // reserveQuota 调用（含 IP / 操作者上下文）
  // ============================================================
  describe('reserveQuota call context', () => {
    function setupHappy() {
      promoRepo.findByInviteCode.mockResolvedValueOnce(tierFixture());
      promoRepo.getTenantPlanTier.mockResolvedValueOnce(null);
      quota.reserveQuota.mockResolvedValueOnce({
        tier: tierFixture(),
        reservedAt: '2026-05-15T00:00:00.000Z',
        actualPriceYuan: 999,
      });
    }

    it('case-14: reserveQuota 入参 = tenantId + code + ctx.operatorRole=kol_self', async () => {
      setupHappy();
      await controller.redeem(
        { tenantId: TENANT_A, inviteCode: INVITE_CODE },
        req(jwt(), {}, '1.2.3.4'),
      );

      expect(quota.reserveQuota).toHaveBeenCalledTimes(1);
      const [tenantId, code, ctx] = quota.reserveQuota.mock.calls[0];
      expect(tenantId).toBe(TENANT_A);
      expect(code).toBe('kol_abc'); // tier.code 不是 inviteCode
      expect(ctx.operatorId).toBe(USER_A);
      expect(ctx.operatorRole).toBe('kol_self');
      expect(ctx.operatorIp).toBe('1.2.3.4');
    });

    it('case-15: req.user 缺失 → operatorId 为 undefined（兜底）', async () => {
      setupHappy();
      await controller.redeem(
        { tenantId: TENANT_A, inviteCode: INVITE_CODE },
        req(undefined, {}, '1.2.3.4'),
      );
      const ctx = quota.reserveQuota.mock.calls[0][2];
      expect(ctx.operatorId).toBeUndefined();
    });

    it('case-16: x-forwarded-for 字符串单 IP → ip 提取', async () => {
      setupHappy();
      await controller.redeem(
        { tenantId: TENANT_A, inviteCode: INVITE_CODE },
        req(jwt(), { 'x-forwarded-for': '203.0.113.1' }),
      );
      const ctx = quota.reserveQuota.mock.calls[0][2];
      expect(ctx.operatorIp).toBe('203.0.113.1');
    });

    it('case-17: x-forwarded-for 逗号分隔多 IP → 取第一个', async () => {
      setupHappy();
      await controller.redeem(
        { tenantId: TENANT_A, inviteCode: INVITE_CODE },
        req(jwt(), { 'x-forwarded-for': '203.0.113.1, 10.0.0.1, 192.168.1.1' }),
      );
      const ctx = quota.reserveQuota.mock.calls[0][2];
      expect(ctx.operatorIp).toBe('203.0.113.1');
    });

    it('case-18: x-forwarded-for 数组（多代理）→ 取第一个元素的第一段', async () => {
      setupHappy();
      await controller.redeem(
        { tenantId: TENANT_A, inviteCode: INVITE_CODE },
        req(jwt(), { 'x-forwarded-for': ['203.0.113.1', '10.0.0.1'] }),
      );
      const ctx = quota.reserveQuota.mock.calls[0][2];
      expect(ctx.operatorIp).toBe('203.0.113.1');
    });

    it('case-19: x-forwarded-for 缺失 + req.ip 存在 → 兜底 req.ip', async () => {
      setupHappy();
      await controller.redeem(
        { tenantId: TENANT_A, inviteCode: INVITE_CODE },
        req(jwt(), {}, '10.0.0.99'),
      );
      const ctx = quota.reserveQuota.mock.calls[0][2];
      expect(ctx.operatorIp).toBe('10.0.0.99');
    });

    it('case-20: x-forwarded-for + req.ip 都缺 → operatorIp 为 undefined（不抛）', async () => {
      setupHappy();
      await controller.redeem(
        { tenantId: TENANT_A, inviteCode: INVITE_CODE },
        req(jwt(), {}),
      );
      const ctx = quota.reserveQuota.mock.calls[0][2];
      expect(ctx.operatorIp).toBeUndefined();
    });

    it('case-21: reserveQuota 抛 ConflictException（quota 抢光）→ 透传错误，不释放', async () => {
      promoRepo.findByInviteCode.mockResolvedValueOnce(tierFixture());
      quota.reserveQuota.mockRejectedValueOnce(
        new Error('PROMOTION_QUOTA_EXHAUSTED'),
      );

      await expect(
        controller.redeem(
          { tenantId: TENANT_A, inviteCode: INVITE_CODE },
          req(jwt()),
        ),
      ).rejects.toThrow(/PROMOTION_QUOTA_EXHAUSTED/);
      expect(quota.releaseQuota).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // race 防御（reserve 后二次校验 plan_tier）
  // ============================================================
  describe('post-reserve race guard', () => {
    it('case-22: tenant plan_tier=chain 不在 [single,growth] → releaseQuota + 抛 PLAN_NOT_COVERED', async () => {
      promoRepo.findByInviteCode.mockResolvedValueOnce(
        tierFixture({ appliesToPlans: ['single', 'growth'] }),
      );
      promoRepo.getTenantPlanTier.mockResolvedValueOnce('chain');
      quota.reserveQuota.mockResolvedValueOnce({
        tier: tierFixture(),
        reservedAt: '2026-05-15T00:00:00.000Z',
        actualPriceYuan: 999,
      });
      quota.releaseQuota.mockResolvedValueOnce({ ok: true, releasedCode: 'kol_abc' });

      await expect(
        controller.redeem(
          { tenantId: TENANT_A, inviteCode: INVITE_CODE },
          req(jwt()),
        ),
      ).rejects.toThrow(
        /INVITE_CODE_PLAN_NOT_COVERED.*tenant plan=chain.*single,growth/,
      );

      expect(quota.releaseQuota).toHaveBeenCalledTimes(1);
      expect(quota.releaseQuota).toHaveBeenCalledWith(
        TENANT_A,
        'plan_not_covered_post_reserve',
      );
    });

    it('case-23: tenant plan_tier=single 在 [single,growth] → 不 release，正常返回', async () => {
      promoRepo.findByInviteCode.mockResolvedValueOnce(
        tierFixture({ appliesToPlans: ['single', 'growth'] }),
      );
      promoRepo.getTenantPlanTier.mockResolvedValueOnce('single');
      quota.reserveQuota.mockResolvedValueOnce({
        tier: tierFixture(),
        reservedAt: '2026-05-15T00:00:00.000Z',
        actualPriceYuan: 999,
      });

      await expect(
        controller.redeem(
          { tenantId: TENANT_A, inviteCode: INVITE_CODE },
          req(jwt()),
        ),
      ).resolves.toBeDefined();

      expect(quota.releaseQuota).not.toHaveBeenCalled();
    });

    it('case-24: tenant plan_tier=null（租户未选档）→ 跳过二次校验，不 release', async () => {
      promoRepo.findByInviteCode.mockResolvedValueOnce(
        tierFixture({ appliesToPlans: ['single'] }),
      );
      promoRepo.getTenantPlanTier.mockResolvedValueOnce(null);
      quota.reserveQuota.mockResolvedValueOnce({
        tier: tierFixture(),
        reservedAt: '2026-05-15T00:00:00.000Z',
        actualPriceYuan: 999,
      });

      await expect(
        controller.redeem(
          { tenantId: TENANT_A, inviteCode: INVITE_CODE },
          req(jwt()),
        ),
      ).resolves.toBeDefined();
      expect(quota.releaseQuota).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // 响应格式
  // ============================================================
  describe('response shape', () => {
    it('case-25: 200 → { ok:true, promotionCode, actualPriceYuan, discountPct }', async () => {
      const tier = tierFixture({
        code: 'kol_taylor',
        discountPct: 80,
      });
      promoRepo.findByInviteCode.mockResolvedValueOnce(tier);
      promoRepo.getTenantPlanTier.mockResolvedValueOnce('single');
      quota.reserveQuota.mockResolvedValueOnce({
        tier,
        reservedAt: '2026-05-15T00:00:00.000Z',
        actualPriceYuan: 1119,
      });

      const result = await controller.redeem(
        { tenantId: TENANT_A, inviteCode: INVITE_CODE, planTier: 'single' },
        req(jwt()),
      );

      expect(result).toEqual({
        ok: true,
        promotionCode: 'kol_taylor',
        actualPriceYuan: 1119,
        discountPct: 80,
      });
    });

    it('case-26: discountPct 来自 tier 不是 reserveQuota（防 service 改 discount 后未传）', async () => {
      const tier = tierFixture({ discountPct: 50 });
      promoRepo.findByInviteCode.mockResolvedValueOnce(tier);
      promoRepo.getTenantPlanTier.mockResolvedValueOnce(null);
      quota.reserveQuota.mockResolvedValueOnce({
        tier,
        reservedAt: '2026-05-15T00:00:00.000Z',
        actualPriceYuan: 699,
      });

      const result = await controller.redeem(
        { tenantId: TENANT_A, inviteCode: INVITE_CODE },
        req(jwt()),
      );

      expect(result.discountPct).toBe(50);
    });

    it('case-27: actualPriceYuan 来自 reserveQuota 不是 tier（用 plan_tier 实际算）', async () => {
      const tier = tierFixture({ discountPct: 70 });
      promoRepo.findByInviteCode.mockResolvedValueOnce(tier);
      promoRepo.getTenantPlanTier.mockResolvedValueOnce(null);
      quota.reserveQuota.mockResolvedValueOnce({
        tier,
        reservedAt: '2026-05-15T00:00:00.000Z',
        actualPriceYuan: 4193, // chain 价 5990 × 70% ≈ 4193
      });

      const result = await controller.redeem(
        { tenantId: TENANT_A, inviteCode: INVITE_CODE },
        req(jwt()),
      );

      expect(result.actualPriceYuan).toBe(4193);
    });
  });
});
