/**
 * business-metrics.interceptor.spec.ts (L7 业务监控 - 5/20 stryker 0% coverage 修补)
 *
 * 覆盖 case：
 *   1. happy path 200 → record(method, route, 200, durationMs)
 *   2. route fallback：req.route.path → req.url → 'UNKNOWN'
 *   3. method 缺 → 'UNKNOWN'
 *   4. 异常路径 → catchError + record(extracted status) + re-throw
 *   5. extractStatus：getStatus() 优先
 *   6. extractStatus：getStatus() 抛 → fallback status
 *   7. extractStatus：status 数字字段
 *   8. extractStatus：无 status / null → 500
 *   9. safeRecord 内部 metrics.record 抛 → fail-open 不抛
 *   10. durationMs > 0 (now() - startedAt)
 */
import { of, throwError, lastValueFrom } from 'rxjs';
import { BusinessMetricsInterceptor } from './business-metrics.interceptor';
import { BusinessMetricsService } from './business-metrics.service';
import { ExecutionContext, CallHandler, HttpException, HttpStatus } from '@nestjs/common';

describe('BusinessMetricsInterceptor', () => {
  let interceptor: BusinessMetricsInterceptor;
  let mockMetrics: { record: jest.Mock };

  function makeContext(opts: {
    method?: string;
    routePath?: string;
    url?: string;
    statusCode?: number;
  }): ExecutionContext {
    const req = {
      method: opts.method,
      route: opts.routePath ? { path: opts.routePath } : undefined,
      url: opts.url,
    };
    const res = { statusCode: opts.statusCode ?? 200 };
    return {
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => res,
      }),
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    mockMetrics = { record: jest.fn() };
    interceptor = new BusinessMetricsInterceptor(mockMetrics as unknown as BusinessMetricsService);
  });

  // ----------------------------------------------------------------
  // Case 1: happy 200 path
  // ----------------------------------------------------------------
  it('happy 200 — 调 record(method, route, 200, duration)', async () => {
    const ctx = makeContext({ method: 'POST', routePath: '/db/customers', statusCode: 201 });
    const next: CallHandler = { handle: () => of({ id: 'cus1' }) };
    await lastValueFrom(interceptor.intercept(ctx, next));
    expect(mockMetrics.record).toHaveBeenCalledWith(
      'POST',
      '/db/customers',
      201,
      expect.any(Number),
    );
  });

  // ----------------------------------------------------------------
  // Case 2: route fallback chain
  // ----------------------------------------------------------------
  it('route fallback — req.route.path 优先', async () => {
    const ctx = makeContext({ method: 'GET', routePath: '/db/students/:id', url: '/db/students/123', statusCode: 200 });
    const next: CallHandler = { handle: () => of(null) };
    await lastValueFrom(interceptor.intercept(ctx, next));
    expect(mockMetrics.record).toHaveBeenCalledWith('GET', '/db/students/:id', 200, expect.any(Number));
  });

  it('route fallback — 无 route 用 req.url', async () => {
    const ctx = makeContext({ method: 'GET', url: '/raw/url', statusCode: 200 });
    const next: CallHandler = { handle: () => of(null) };
    await lastValueFrom(interceptor.intercept(ctx, next));
    expect(mockMetrics.record).toHaveBeenCalledWith('GET', '/raw/url', 200, expect.any(Number));
  });

  it('route fallback — 无 route 无 url → UNKNOWN', async () => {
    const ctx = makeContext({ method: 'GET', statusCode: 200 });
    const next: CallHandler = { handle: () => of(null) };
    await lastValueFrom(interceptor.intercept(ctx, next));
    expect(mockMetrics.record).toHaveBeenCalledWith('GET', 'UNKNOWN', 200, expect.any(Number));
  });

  it('method 缺 → UNKNOWN', async () => {
    const ctx = makeContext({ routePath: '/x', statusCode: 200 });
    const next: CallHandler = { handle: () => of(null) };
    await lastValueFrom(interceptor.intercept(ctx, next));
    expect(mockMetrics.record).toHaveBeenCalledWith('UNKNOWN', '/x', 200, expect.any(Number));
  });

  // ----------------------------------------------------------------
  // Case 3: 异常路径 + re-throw
  // ----------------------------------------------------------------
  it('异常 + HttpException → record(method, route, status, duration) + 抛原异常', async () => {
    const ctx = makeContext({ method: 'POST', routePath: '/db/x', statusCode: 200 });
    const err = new HttpException('forbidden', HttpStatus.FORBIDDEN);
    const next: CallHandler = { handle: () => throwError(() => err) };

    await expect(lastValueFrom(interceptor.intercept(ctx, next))).rejects.toBe(err);
    expect(mockMetrics.record).toHaveBeenCalledWith('POST', '/db/x', 403, expect.any(Number));
  });

  it('异常 + getStatus() 抛 → fallback 用 .status 数字字段', async () => {
    const ctx = makeContext({ method: 'POST', routePath: '/x' });
    const err = {
      getStatus: () => {
        throw new Error('bad');
      },
      status: 418,
    };
    const next: CallHandler = { handle: () => throwError(() => err) };

    await expect(lastValueFrom(interceptor.intercept(ctx, next))).rejects.toBe(err);
    expect(mockMetrics.record).toHaveBeenCalledWith('POST', '/x', 418, expect.any(Number));
  });

  it('异常 + 仅 .status 数字 → 用之', async () => {
    const ctx = makeContext({ method: 'POST', routePath: '/x' });
    const err = { status: 429 };
    const next: CallHandler = { handle: () => throwError(() => err) };

    await expect(lastValueFrom(interceptor.intercept(ctx, next))).rejects.toBe(err);
    expect(mockMetrics.record).toHaveBeenCalledWith('POST', '/x', 429, expect.any(Number));
  });

  it('异常 + 无 status / 非 object → fallback 500', async () => {
    const ctx = makeContext({ method: 'POST', routePath: '/x' });
    const err = new Error('plain JS error');
    const next: CallHandler = { handle: () => throwError(() => err) };

    await expect(lastValueFrom(interceptor.intercept(ctx, next))).rejects.toBe(err);
    expect(mockMetrics.record).toHaveBeenCalledWith('POST', '/x', 500, expect.any(Number));
  });

  it('异常 + null → 500', async () => {
    const ctx = makeContext({ method: 'POST', routePath: '/x' });
    const next: CallHandler = { handle: () => throwError(() => null) };

    await expect(lastValueFrom(interceptor.intercept(ctx, next))).rejects.toBe(null);
    expect(mockMetrics.record).toHaveBeenCalledWith('POST', '/x', 500, expect.any(Number));
  });

  // ----------------------------------------------------------------
  // Case 4: safeRecord fail-open
  // ----------------------------------------------------------------
  it('safeRecord — metrics.record 抛 → 不污染 endpoint 结果', async () => {
    mockMetrics.record.mockImplementation(() => {
      throw new Error('metrics down');
    });
    const ctx = makeContext({ method: 'POST', routePath: '/x', statusCode: 200 });
    const next: CallHandler = { handle: () => of({ ok: true }) };

    const result = await lastValueFrom(interceptor.intercept(ctx, next));
    expect(result).toEqual({ ok: true }); // 业务结果正常返
  });

  it('safeRecord 在异常路径 也 fail-open', async () => {
    mockMetrics.record.mockImplementation(() => {
      throw new Error('metrics down');
    });
    const ctx = makeContext({ method: 'POST', routePath: '/x' });
    const err = new Error('biz fail');
    const next: CallHandler = { handle: () => throwError(() => err) };

    // 应抛原 biz err，不抛 metrics err
    await expect(lastValueFrom(interceptor.intercept(ctx, next))).rejects.toBe(err);
  });

  // ----------------------------------------------------------------
  // Case 5: duration >= 0
  // ----------------------------------------------------------------
  it('durationMs 是 number >= 0', async () => {
    const ctx = makeContext({ method: 'GET', routePath: '/x', statusCode: 200 });
    const next: CallHandler = { handle: () => of(null) };
    await lastValueFrom(interceptor.intercept(ctx, next));
    const args = mockMetrics.record.mock.calls[0];
    expect(typeof args[3]).toBe('number');
    expect(args[3]).toBeGreaterThanOrEqual(0);
  });
});
