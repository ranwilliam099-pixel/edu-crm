/**
 * L11 Chaos — subscription frozen/archived tenant 跨业务路径 403（P1-7 round 2 新增）
 *
 * 来源：
 *   - 2026-05-19 Day 5 三审 round 1 P1-7 finding：L11 chaos 缺 frozen/archived tenant 验证
 *   - SSOT 拍板：5 status (trial/active/expired/archived/frozen)，expired/archived/frozen
 *     在 method != GET 全部 403；GET 放行（只读 fail-open）
 *
 * 测什么：
 *   1. frozen tenant POST /db/customers → 403 subscription_frozen
 *   2. frozen tenant GET /db/customers  → 放行（只读不阻塞，spec §3 method='GET' 早退）
 *   3. archived tenant POST /db/contracts → 403 subscription_archived
 *   4. archived tenant GET 路径 → 放行
 *   5. expired tenant POST → 403 subscription_expired（对照组）
 *   6. trial / active POST → 放行（无阻塞）
 *   7. platform_admin frozen tenant 仍可写（跨 tenant 豁免）
 *   8. PG 查询超时 → fail-open（不阻塞主业务）
 *
 * 测试边界：
 *   - 不依赖真 PG，mock PgPoolService.query
 *   - 不依赖 RbacGuard / TenantScopeGuard
 *   - 专注 TenantSubscriptionGuard 单元行为
 *   - audit_log 由 Sprint E #3 整体补齐，本 spec 不断言 audit
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { TenantSubscriptionGuard } from '../guards/tenant-subscription.guard';
import { PgPoolService } from '../modules/db/pg-pool.service';
import type { JwtPayload } from '../modules/auth/jwt-payload.interface';

const TENANT_FROZEN = '01HX_FROZEN_TENANT_XXXXXXXXXXX01';
const TENANT_ARCHIVED = '01HX_ARCHIVED_TENANT_XXXXXXXXX02';
const TENANT_EXPIRED = '01HX_EXPIRED_TENANT_XXXXXXXXXX03';
const TENANT_TRIAL = '01HX_TRIAL_TENANT_XXXXXXXXXXXX04';
const TENANT_ACTIVE = '01HX_ACTIVE_TENANT_XXXXXXXXXXX05';

function mkUser(role: string, tenantId: string | null = TENANT_FROZEN): JwtPayload {
  return {
    sub: '01HX_USER_FROZEN_TENANT_XXXXX_01',
    tenantId,
    role: role as JwtPayload['role'],
    campusId: tenantId ? '01HX_CAMPUS_XXXXXXXXXXXXXXXXXX_01' : null,
  };
}

function mkCtx(opts: {
  method: string;
  url?: string;
  user?: JwtPayload;
}): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        method: opts.method,
        url: opts.url ?? '/api/db/customers',
        originalUrl: opts.url ?? '/api/db/customers',
        user: opts.user,
      }),
    }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

describe('[L11 Chaos P1-7] subscription frozen tenant 跨业务路径 403', () => {
  let guard: TenantSubscriptionGuard;
  let pg: { query: jest.Mock };

  beforeEach(async () => {
    pg = { query: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantSubscriptionGuard,
        { provide: PgPoolService, useValue: pg },
      ],
    }).compile();
    guard = module.get<TenantSubscriptionGuard>(TenantSubscriptionGuard);
  });

  // ============================================================
  // Frozen tenant
  // ============================================================

  describe('frozen tenant', () => {
    it('POST /db/customers → 403 subscription_frozen（写阻断）', async () => {
      pg.query.mockResolvedValueOnce([{ subscription_status: 'frozen' }]);
      const ctx = mkCtx({
        method: 'POST',
        url: '/api/db/customers',
        user: mkUser('sales', TENANT_FROZEN),
      });
      let thrown: ForbiddenException | null = null;
      try {
        await guard.canActivate(ctx);
      } catch (e) {
        thrown = e as ForbiddenException;
      }
      expect(thrown).toBeInstanceOf(ForbiddenException);
      const response = thrown!.getResponse() as { code: string; message: string };
      expect(response.code).toBe('subscription_frozen');
      expect(response.message).toContain('冻结');
    });

    it('GET /db/customers → 放行（只读不阻塞，spec §3 GET 早退）', async () => {
      // pg.query 不应被调用（GET 早退）
      const ctx = mkCtx({
        method: 'GET',
        url: '/api/db/customers',
        user: mkUser('sales', TENANT_FROZEN),
      });
      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
      expect(pg.query).not.toHaveBeenCalled();
    });

    it('POST /db/contracts → 403 subscription_frozen（任意写路径都拦）', async () => {
      // 每次 canActivate 会调一次 pg.query，所以 mock 两次（同 expect 两次断言）
      pg.query
        .mockResolvedValueOnce([{ subscription_status: 'frozen' }])
        .mockResolvedValueOnce([{ subscription_status: 'frozen' }]);
      const ctx = mkCtx({
        method: 'POST',
        url: '/api/db/contracts',
        user: mkUser('sales', TENANT_FROZEN),
      });
      await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
      await expect(guard.canActivate(ctx)).rejects.toMatchObject({
        response: { code: 'subscription_frozen' },
      });
    });

    it('PATCH /db/students/xxx → 403 subscription_frozen', async () => {
      pg.query.mockResolvedValueOnce([{ subscription_status: 'frozen' }]);
      const ctx = mkCtx({
        method: 'PATCH',
        url: '/api/db/students/xxxxxxx',
        user: mkUser('academic', TENANT_FROZEN),
      });
      let thrown: ForbiddenException | null = null;
      try {
        await guard.canActivate(ctx);
      } catch (e) {
        thrown = e as ForbiddenException;
      }
      expect(thrown).toBeInstanceOf(ForbiddenException);
      expect((thrown!.getResponse() as { code: string }).code).toBe('subscription_frozen');
    });
  });

  // ============================================================
  // Archived tenant
  // ============================================================

  describe('archived tenant', () => {
    it('POST /db/contracts → 403 subscription_archived', async () => {
      pg.query.mockResolvedValueOnce([{ subscription_status: 'archived' }]);
      const ctx = mkCtx({
        method: 'POST',
        url: '/api/db/contracts',
        user: mkUser('sales', TENANT_ARCHIVED),
      });
      let thrown: ForbiddenException | null = null;
      try {
        await guard.canActivate(ctx);
      } catch (e) {
        thrown = e as ForbiddenException;
      }
      expect(thrown).toBeInstanceOf(ForbiddenException);
      const response = thrown!.getResponse() as { code: string };
      expect(response.code).toBe('subscription_archived');
    });

    it('GET /db/contracts → 放行（archived 也是 GET 早退）', async () => {
      const ctx = mkCtx({
        method: 'GET',
        url: '/api/db/contracts',
        user: mkUser('finance', TENANT_ARCHIVED),
      });
      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
      expect(pg.query).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // 对照组：expired / trial / active
  // ============================================================

  describe('对照组（expired / trial / active）', () => {
    it('expired tenant POST → 403 subscription_expired', async () => {
      pg.query.mockResolvedValueOnce([{ subscription_status: 'expired' }]);
      const ctx = mkCtx({
        method: 'POST',
        url: '/api/db/customers',
        user: mkUser('sales', TENANT_EXPIRED),
      });
      let thrown: ForbiddenException | null = null;
      try {
        await guard.canActivate(ctx);
      } catch (e) {
        thrown = e as ForbiddenException;
      }
      expect(thrown).toBeInstanceOf(ForbiddenException);
      expect((thrown!.getResponse() as { code: string }).code).toBe('subscription_expired');
    });

    it('trial tenant POST → 放行', async () => {
      pg.query.mockResolvedValueOnce([{ subscription_status: 'trial' }]);
      const ctx = mkCtx({
        method: 'POST',
        url: '/api/db/customers',
        user: mkUser('sales', TENANT_TRIAL),
      });
      expect(await guard.canActivate(ctx)).toBe(true);
    });

    it('active tenant POST → 放行', async () => {
      pg.query.mockResolvedValueOnce([{ subscription_status: 'active' }]);
      const ctx = mkCtx({
        method: 'POST',
        url: '/api/db/customers',
        user: mkUser('sales', TENANT_ACTIVE),
      });
      expect(await guard.canActivate(ctx)).toBe(true);
    });
  });

  // ============================================================
  // 跨业务路径 & 平台角色豁免
  // ============================================================

  describe('跨业务路径覆盖（任意 POST 路径都被 frozen 拦）', () => {
    const FROZEN_PATHS = [
      '/api/db/customers',
      '/api/db/contracts',
      '/api/db/students',
      '/api/db/lesson-feedbacks',
      '/api/db/schedules',
      '/api/db/assignments',
      '/api/db/assessments',
    ];

    it.each(FROZEN_PATHS)(
      'frozen tenant POST %s → 403 subscription_frozen',
      async (url) => {
        pg.query.mockResolvedValueOnce([{ subscription_status: 'frozen' }]);
        const ctx = mkCtx({ method: 'POST', url, user: mkUser('teacher', TENANT_FROZEN) });
        let thrown: ForbiddenException | null = null;
        try {
          await guard.canActivate(ctx);
        } catch (e) {
          thrown = e as ForbiddenException;
        }
        expect(thrown).toBeInstanceOf(ForbiddenException);
        expect((thrown!.getResponse() as { code: string }).code).toBe('subscription_frozen');
      },
    );
  });

  describe('平台角色 + 白名单路径豁免', () => {
    it('platform_admin frozen tenant POST → 放行（跨 tenant 豁免）', async () => {
      const ctx = mkCtx({
        method: 'POST',
        url: '/api/db/customers',
        user: mkUser('platform_admin', null),
      });
      expect(await guard.canActivate(ctx)).toBe(true);
      // platform_admin 早退，不查 DB
      expect(pg.query).not.toHaveBeenCalled();
    });

    it('finance_admin frozen tenant POST → 放行', async () => {
      const ctx = mkCtx({
        method: 'POST',
        url: '/api/db/customers',
        user: mkUser('finance_admin', null),
      });
      expect(await guard.canActivate(ctx)).toBe(true);
      expect(pg.query).not.toHaveBeenCalled();
    });

    it('frozen tenant POST /api/checkout/wxpay → 放行（付款链路白名单）', async () => {
      const ctx = mkCtx({
        method: 'POST',
        url: '/api/checkout/wxpay/unified-order',
        user: mkUser('boss', TENANT_FROZEN),
      });
      expect(await guard.canActivate(ctx)).toBe(true);
      expect(pg.query).not.toHaveBeenCalled();
    });

    it('frozen tenant POST /api/auth/login → 放行（登录链路白名单）', async () => {
      const ctx = mkCtx({
        method: 'POST',
        url: '/api/auth/login',
        user: mkUser('sales', TENANT_FROZEN),
      });
      expect(await guard.canActivate(ctx)).toBe(true);
      expect(pg.query).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // chaos: PG 查询失败时 fail-open
  // ============================================================

  describe('chaos: PG 查询失败 fail-open（不阻塞主业务）', () => {
    it('PG query 抛 ETIMEDOUT → 放行（fail-open）', async () => {
      pg.query.mockRejectedValueOnce(new Error('ETIMEDOUT connecting to PG'));
      const ctx = mkCtx({
        method: 'POST',
        url: '/api/db/customers',
        user: mkUser('sales', TENANT_FROZEN),
      });
      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
    });

    it('PG query 抛任意错误 → 放行 + logger.warn（不上抛）', async () => {
      pg.query.mockRejectedValueOnce(new Error('relation "public.tenants" does not exist'));
      const ctx = mkCtx({
        method: 'POST',
        url: '/api/db/customers',
        user: mkUser('sales', TENANT_FROZEN),
      });
      expect(await guard.canActivate(ctx)).toBe(true);
    });

    it('tenant 行不存在（边界）→ 放行（让上游 controller 处理）', async () => {
      pg.query.mockResolvedValueOnce([]);
      const ctx = mkCtx({
        method: 'POST',
        url: '/api/db/customers',
        user: mkUser('sales', 'unknown_tenant_id'),
      });
      expect(await guard.canActivate(ctx)).toBe(true);
    });
  });
});
