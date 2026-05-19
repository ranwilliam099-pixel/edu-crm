import { ForbiddenException, ExecutionContext } from '@nestjs/common';
import { TenantSubscriptionGuard } from './tenant-subscription.guard';
import { PgPoolService } from '../modules/db/pg-pool.service';

/**
 * TenantSubscriptionGuard 单元测试（T9-EPIC spec 2026-05-16 §3）
 *
 * 覆盖 6 条早退分支 + 3 条 DB 分支 + DB fail-open = 10 用例
 */
describe('TenantSubscriptionGuard - T9-EPIC 14d 试用 / expired 数据只读', () => {
  let pg: { query: jest.Mock };
  let guard: TenantSubscriptionGuard;

  function makeCtx(opts: {
    method?: string;
    url?: string;
    user?: { sub: string; role: string; tenantId: string | null; campusId: string | null };
  }): ExecutionContext {
    const req = {
      method: opts.method ?? 'POST',
      originalUrl: opts.url ?? '/api/db/students',
      url: opts.url ?? '/api/db/students',
      user: opts.user,
    };
    return {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    pg = { query: jest.fn() };
    guard = new TenantSubscriptionGuard(pg as unknown as PgPoolService);
  });

  // ============================================================
  // 早退分支（不查 DB）
  // ============================================================
  it('GET 请求 → 放行不查 DB（拍板 4：method!=GET 才查）', async () => {
    const ctx = makeCtx({ method: 'GET', url: '/api/db/students' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('白名单 /api/public/* → 放行不查 DB', async () => {
    const ctx = makeCtx({
      method: 'POST',
      url: '/api/public/onboarding/provision-tenant',
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('白名单 /api/checkout/* → 放行（付款必须能解锁）', async () => {
    const ctx = makeCtx({
      method: 'POST',
      url: '/api/checkout/wxpay/unified-order',
      user: { sub: 'u', role: 'admin', tenantId: 't1', campusId: null },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('白名单 /api/auth/* → 放行（登录 / refresh）', async () => {
    const ctx = makeCtx({ method: 'POST', url: '/api/auth/refresh' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('platform_admin 跨租户角色 → 放行不查 DB', async () => {
    const ctx = makeCtx({
      method: 'POST',
      user: { sub: 'u', role: 'platform_admin', tenantId: null, campusId: null },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('无 req.user → 放行（由 middleware / 其他 Guard 决定 401）', async () => {
    const ctx = makeCtx({ method: 'POST', user: undefined });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('user.tenantId=null → 放行（其他 Guard 处理）', async () => {
    const ctx = makeCtx({
      method: 'POST',
      user: { sub: 'u', role: 'admin', tenantId: null, campusId: null },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(pg.query).not.toHaveBeenCalled();
  });

  // ============================================================
  // DB 分支
  // ============================================================
  it('trial 状态 → 放行（14d 内读写全开）', async () => {
    pg.query.mockResolvedValueOnce([{ subscription_status: 'trial' }]);
    const ctx = makeCtx({
      method: 'POST',
      url: '/api/db/students',
      user: { sub: 'u', role: 'sales', tenantId: 't1', campusId: 'c1' },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(pg.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT subscription_status FROM public.tenants'),
      ['t1'],
    );
  });

  it('active 状态 → 放行（已订阅 365d 全开）', async () => {
    pg.query.mockResolvedValueOnce([{ subscription_status: 'active' }]);
    const ctx = makeCtx({
      method: 'POST',
      user: { sub: 'u', role: 'admin', tenantId: 't1', campusId: null },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(pg.query).toHaveBeenCalledTimes(1);
  });

  it('expired 状态 → 抛 403 ForbiddenException 含 code=subscription_expired', async () => {
    pg.query.mockResolvedValue([{ subscription_status: 'expired' }]);
    const ctx = makeCtx({
      method: 'POST',
      user: { sub: 'u', role: 'sales', tenantId: 't1', campusId: 'c1' },
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    // 复用同一 ctx 再抛一次（pg.query mockResolvedValue 非 Once → 每次返同值）
    let caught: unknown;
    try {
      await guard.canActivate(ctx);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ForbiddenException);
    const response = (caught as ForbiddenException).getResponse();
    expect(response).toMatchObject({
      code: 'subscription_expired',
      message: expect.stringContaining('试用期已结束'),
    });
  });

  // ============================================================
  // V49 扩展：archived + frozen 状态阻断（5/19 leader 决策 D1.1）
  // ============================================================
  it('archived 状态 → 抛 403 ForbiddenException 含 code=subscription_archived', async () => {
    pg.query.mockResolvedValue([{ subscription_status: 'archived' }]);
    const ctx = makeCtx({
      method: 'POST',
      user: { sub: 'u', role: 'sales', tenantId: 't1', campusId: 'c1' },
    });
    let caught: unknown;
    try {
      await guard.canActivate(ctx);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ForbiddenException);
    const response = (caught as ForbiddenException).getResponse();
    expect(response).toMatchObject({
      code: 'subscription_archived',
      message: expect.stringContaining('归档'),
    });
    expect(pg.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT subscription_status FROM public.tenants'),
      ['t1'],
    );
  });

  it('frozen 状态 → 抛 403 ForbiddenException 含 code=subscription_frozen', async () => {
    pg.query.mockResolvedValue([{ subscription_status: 'frozen' }]);
    const ctx = makeCtx({
      method: 'POST',
      user: { sub: 'u', role: 'sales', tenantId: 't1', campusId: 'c1' },
    });
    let caught: unknown;
    try {
      await guard.canActivate(ctx);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ForbiddenException);
    const response = (caught as ForbiddenException).getResponse();
    expect(response).toMatchObject({
      code: 'subscription_frozen',
      message: expect.stringContaining('冻结'),
    });
  });

  it('archived + GET 请求 → 放行（数据只读保护语义）', async () => {
    const ctx = makeCtx({
      method: 'GET',
      url: '/api/db/students',
      user: { sub: 'u', role: 'sales', tenantId: 't1', campusId: 'c1' },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('frozen + GET 请求 → 放行（同 expired 早退分支）', async () => {
    const ctx = makeCtx({
      method: 'GET',
      url: '/api/db/students',
      user: { sub: 'u', role: 'sales', tenantId: 't1', campusId: 'c1' },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('DB query 抛错 → fail-open 放行（与 audit_log 一致）', async () => {
    pg.query.mockRejectedValueOnce(new Error('PG down'));
    const ctx = makeCtx({
      method: 'POST',
      user: { sub: 'u', role: 'admin', tenantId: 't1', campusId: null },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });
});
