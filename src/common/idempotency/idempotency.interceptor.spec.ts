import { BadRequestException, CallHandler, ExecutionContext, Logger } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { IdempotencyInterceptor, sanitizeRedisError } from './idempotency.interceptor';
import { RedisService } from '../../modules/redis/redis.service';

describe('IdempotencyInterceptor', () => {
  let interceptor: IdempotencyInterceptor;
  let redis: { get: jest.Mock; set: jest.Mock };
  let next: { handle: jest.Mock };

  function makeCtx(opts: {
    method: string;
    headers?: Record<string, string | string[] | undefined>;
    user?: { id?: string };
    statusCode?: number;
  }): ExecutionContext {
    const res = { statusCode: opts.statusCode ?? 200, status: jest.fn() };
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          method: opts.method,
          headers: opts.headers ?? {},
          user: opts.user,
        }),
        getResponse: () => res,
      }),
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    redis = { get: jest.fn(), set: jest.fn() };
    interceptor = new IdempotencyInterceptor(redis as unknown as RedisService);
    next = { handle: jest.fn() };
  });

  // ============================================================
  // 跳过：GET / 无 key / 不写
  // ============================================================

  describe('跳过逻辑', () => {
    it('GET 请求 → 直接放行', async () => {
      next.handle.mockReturnValue(of({ data: 'x' }));
      const ctx = makeCtx({
        method: 'GET',
        headers: { 'idempotency-key': 'abcdefgh-1234' },
      });
      const out = await firstValueFrom(
        (await interceptor.intercept(ctx, next as unknown as CallHandler)) as never,
      );
      expect(out).toEqual({ data: 'x' });
      expect(redis.get).not.toHaveBeenCalled();
    });

    it('HEAD / OPTIONS 跳过', async () => {
      for (const m of ['HEAD', 'OPTIONS']) {
        next.handle.mockReturnValue(of({ ok: true }));
        const ctx = makeCtx({
          method: m,
          headers: { 'idempotency-key': 'abcdefgh-1234' },
        });
        await interceptor.intercept(ctx, next as unknown as CallHandler);
      }
      expect(redis.get).not.toHaveBeenCalled();
    });

    it('POST 但没带 Idempotency-Key → 放行（不强制）', async () => {
      next.handle.mockReturnValue(of({ data: 'x' }));
      const ctx = makeCtx({ method: 'POST', headers: {} });
      const out = await firstValueFrom(
        (await interceptor.intercept(ctx, next as unknown as CallHandler)) as never,
      );
      expect(out).toEqual({ data: 'x' });
      expect(redis.get).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // key 格式校验
  // ============================================================

  describe('Idempotency-Key 格式校验', () => {
    it('过短（< 8）→ 400', async () => {
      const ctx = makeCtx({
        method: 'POST',
        headers: { 'idempotency-key': 'abc' },
      });
      await expect(
        interceptor.intercept(ctx, next as unknown as CallHandler),
      ).rejects.toThrow(BadRequestException);
    });

    it('过长（> 128）→ 400', async () => {
      const ctx = makeCtx({
        method: 'POST',
        headers: { 'idempotency-key': 'a'.repeat(129) },
      });
      await expect(
        interceptor.intercept(ctx, next as unknown as CallHandler),
      ).rejects.toThrow(BadRequestException);
    });

    it('含非法字符（如空格）→ 400', async () => {
      const ctx = makeCtx({
        method: 'POST',
        headers: { 'idempotency-key': 'abc def 12345' },
      });
      await expect(
        interceptor.intercept(ctx, next as unknown as CallHandler),
      ).rejects.toThrow(BadRequestException);
    });

    it('合法 UUID 格式 → 通过', async () => {
      next.handle.mockReturnValue(of({ data: 'x' }));
      redis.get.mockResolvedValueOnce(null);
      const ctx = makeCtx({
        method: 'POST',
        headers: { 'idempotency-key': '550e8400-e29b-41d4-a716-446655440000' },
        user: { id: 'user-1' },
      });
      await firstValueFrom(
        (await interceptor.intercept(ctx, next as unknown as CallHandler)) as never,
      );
      // 验证用 cache key 格式 `idem:{userId}:{key}` 查 Redis（跨用户隔离）
      expect(redis.get).toHaveBeenCalledWith(
        'idem:user-1:550e8400-e29b-41d4-a716-446655440000',
      );
      expect(redis.get).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // 缓存命中 / 未命中
  // ============================================================

  describe('缓存命中', () => {
    it('命中 → 返回缓存 body + 设置 status', async () => {
      redis.get.mockResolvedValueOnce(JSON.stringify({ status: 201, body: { id: 'cust-x' } }));
      const ctx = makeCtx({
        method: 'POST',
        headers: { 'idempotency-key': 'idem-key-12345678' },
        user: { id: 'sales-1' },
      });
      const out = await firstValueFrom(
        (await interceptor.intercept(ctx, next as unknown as CallHandler)) as never,
      );
      expect(out).toEqual({ id: 'cust-x' });
      // res.status(201) 应被调用
      const res = ctx.switchToHttp().getResponse() as unknown as { status: jest.Mock };
      expect(res.status).toHaveBeenCalledWith(201);
      // 业务未被调
      expect(next.handle).not.toHaveBeenCalled();
    });

    it('cache key 包含 user.id（跨用户隔离）', async () => {
      redis.get.mockResolvedValueOnce(null);
      next.handle.mockReturnValue(of({ ok: true }));
      const ctx = makeCtx({
        method: 'POST',
        headers: { 'idempotency-key': 'idem-key-12345678' },
        user: { id: 'sales-1' },
      });
      await firstValueFrom(
        (await interceptor.intercept(ctx, next as unknown as CallHandler)) as never,
      );
      expect(redis.get).toHaveBeenCalledWith('idem:sales-1:idem-key-12345678');
    });

    it('user 缺失 → fallback "anon"', async () => {
      redis.get.mockResolvedValueOnce(null);
      next.handle.mockReturnValue(of({}));
      const ctx = makeCtx({
        method: 'POST',
        headers: { 'idempotency-key': 'idem-key-12345678' },
      });
      await firstValueFrom(
        (await interceptor.intercept(ctx, next as unknown as CallHandler)) as never,
      );
      expect(redis.get).toHaveBeenCalledWith('idem:anon:idem-key-12345678');
    });
  });

  // ============================================================
  // 未命中：业务执行 → 后置缓存
  // ============================================================

  describe('未命中 → 放行 + 后置缓存', () => {
    it('2xx 响应 → 缓存 24h', async () => {
      redis.get.mockResolvedValueOnce(null);
      next.handle.mockReturnValue(of({ id: 'new' }));
      const ctx = makeCtx({
        method: 'POST',
        headers: { 'idempotency-key': 'idem-key-12345678' },
        user: { id: 'sales-1' },
        statusCode: 201,
      });
      await firstValueFrom(
        (await interceptor.intercept(ctx, next as unknown as CallHandler)) as never,
      );
      expect(redis.set).toHaveBeenCalledWith(
        'idem:sales-1:idem-key-12345678',
        JSON.stringify({ status: 201, body: { id: 'new' } }),
        86400,
      );
    });

    it('5xx 响应 → 不缓存（让客户端自然重试）', async () => {
      redis.get.mockResolvedValueOnce(null);
      next.handle.mockReturnValue(of({ error: 'boom' }));
      const ctx = makeCtx({
        method: 'POST',
        headers: { 'idempotency-key': 'idem-key-12345678' },
        user: { id: 'sales-1' },
        statusCode: 500,
      });
      await firstValueFrom(
        (await interceptor.intercept(ctx, next as unknown as CallHandler)) as never,
      );
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('4xx 响应（业务错误）→ 不缓存', async () => {
      redis.get.mockResolvedValueOnce(null);
      next.handle.mockReturnValue(of({ error: 'bad' }));
      const ctx = makeCtx({
        method: 'POST',
        headers: { 'idempotency-key': 'idem-key-12345678' },
        user: { id: 'sales-1' },
        statusCode: 400,
      });
      await firstValueFrom(
        (await interceptor.intercept(ctx, next as unknown as CallHandler)) as never,
      );
      expect(redis.set).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // 容灾：Redis 失败不阻塞主业务
  // ============================================================

  describe('容灾（fail-open）', () => {
    it('Redis get 失败 → 业务正常放行', async () => {
      redis.get.mockRejectedValueOnce(new Error('redis down'));
      next.handle.mockReturnValue(of({ ok: true }));
      const ctx = makeCtx({
        method: 'POST',
        headers: { 'idempotency-key': 'idem-key-12345678' },
        user: { id: 'sales-1' },
      });
      const out = await firstValueFrom(
        (await interceptor.intercept(ctx, next as unknown as CallHandler)) as never,
      );
      expect(out).toEqual({ ok: true });
    });

    it('Redis set 失败 → 不抛错（业务正常完成）', async () => {
      redis.get.mockResolvedValueOnce(null);
      redis.set.mockRejectedValueOnce(new Error('redis down'));
      next.handle.mockReturnValue(of({ id: 'new' }));
      const ctx = makeCtx({
        method: 'POST',
        headers: { 'idempotency-key': 'idem-key-12345678' },
        user: { id: 'sales-1' },
      });
      const out = await firstValueFrom(
        (await interceptor.intercept(ctx, next as unknown as CallHandler)) as never,
      );
      expect(out).toEqual({ id: 'new' });
    });
  });

  // ============================================================
  // P1-5 round 2 加强：Redis 错误 message 必须 sanitize 防 password 泄漏
  // ============================================================

  describe('sanitizeRedisError() 单元', () => {
    it('redis://user:password@host 必须脱敏为 redis://***@host', () => {
      const err = new Error('connect ETIMEDOUT redis://default:s3cretP4ss@redis.prod:6379');
      const sanitized = sanitizeRedisError(err);
      expect(sanitized).not.toContain('s3cretP4ss');
      expect(sanitized).toContain('redis://***@redis.prod:6379');
    });

    it('rediss://（TLS）+ 用户名:密码 → 同样脱敏', () => {
      const err = new Error('Auth failed at rediss://admin:topSecret@rds.example.com:6380/0');
      const sanitized = sanitizeRedisError(err);
      expect(sanitized).not.toContain('topSecret');
      expect(sanitized).not.toContain('admin:topSecret');
      expect(sanitized).toContain('rediss://***@rds.example.com:6380/0');
    });

    it('redis://:password@host (无用户名仅密码) → 脱敏', () => {
      const err = new Error('NOAUTH redis://:onlyPassword@1.2.3.4:6379');
      const sanitized = sanitizeRedisError(err);
      expect(sanitized).not.toContain('onlyPassword');
      expect(sanitized).toContain('redis://***@1.2.3.4:6379');
    });

    it('多个 redis URL → 全部脱敏', () => {
      const err = new Error('master redis://a:p1@h1 / replica rediss://b:p2@h2');
      const sanitized = sanitizeRedisError(err);
      expect(sanitized).not.toContain('p1');
      expect(sanitized).not.toContain('p2');
      // 两个 URL 都被 ***@ 替换
      expect(sanitized.match(/\*\*\*@/g)).toHaveLength(2);
    });

    it('普通错误 message（无 URL）→ 原样输出', () => {
      const err = new Error('ECONNREFUSED 127.0.0.1:6379');
      expect(sanitizeRedisError(err)).toBe('ECONNREFUSED 127.0.0.1:6379');
    });

    it('非 Error 对象（字符串 / 对象 / null）→ fallback 安全字符串', () => {
      expect(sanitizeRedisError('redis://x:p@y')).toBe('redis://***@y');
      expect(sanitizeRedisError({ message: 'redis://a:b@c' })).toBe('redis://***@c');
      expect(sanitizeRedisError(null)).toBe('unknown error');
      expect(sanitizeRedisError(undefined)).toBe('unknown error');
    });
  });

  describe('safeGet/safeSet 日志含敏感凭据时 → sanitized 后输出', () => {
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
      warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('safeGet Redis 错误含 password → 日志输出脱敏后字符串（不含明文密码）', async () => {
      const err = new Error('connect failed redis://default:LeakedPw123@10.0.0.5:6379');
      redis.get.mockRejectedValueOnce(err);
      next.handle.mockReturnValue(of({ ok: true }));
      const ctx = makeCtx({
        method: 'POST',
        headers: { 'idempotency-key': 'idem-key-12345678' },
        user: { id: 'sales-1' },
      });
      await firstValueFrom(
        (await interceptor.intercept(ctx, next as unknown as CallHandler)) as never,
      );
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const loggedMessage = warnSpy.mock.calls[0][0] as string;
      expect(loggedMessage).toContain('idem safeGet failed');
      expect(loggedMessage).not.toContain('LeakedPw123'); // 关键断言：密码不能出现在日志
      expect(loggedMessage).toContain('***@10.0.0.5:6379');
    });

    it('safeSet Redis 错误含 password → 日志脱敏', async () => {
      redis.get.mockResolvedValueOnce(null);
      const err = new Error('SET timeout rediss://user:AnotherSecret@redis.cn:6380');
      redis.set.mockRejectedValueOnce(err);
      next.handle.mockReturnValue(of({ id: 'new' }));
      const ctx = makeCtx({
        method: 'POST',
        headers: { 'idempotency-key': 'idem-key-12345678' },
        user: { id: 'sales-1' },
      });
      await firstValueFrom(
        (await interceptor.intercept(ctx, next as unknown as CallHandler)) as never,
      );
      // warn 至少 1 次（safeSet 调用）
      const setWarnCall = warnSpy.mock.calls.find((c) =>
        (c[0] as string).includes('idem safeSet failed'),
      );
      expect(setWarnCall).toBeDefined();
      const loggedMessage = setWarnCall![0] as string;
      expect(loggedMessage).not.toContain('AnotherSecret');
      expect(loggedMessage).toContain('***@redis.cn:6380');
    });
  });

  // ============================================================
  // 边界情况
  // ============================================================

  describe('边界', () => {
    it('header 是数组（异常情况）→ 取第一个', async () => {
      redis.get.mockResolvedValueOnce(null);
      next.handle.mockReturnValue(of({}));
      const ctx = makeCtx({
        method: 'POST',
        headers: { 'idempotency-key': ['idem-key-12345678', 'idem-key-99999999'] },
        user: { id: 'sales-1' },
      });
      await firstValueFrom(
        (await interceptor.intercept(ctx, next as unknown as CallHandler)) as never,
      );
      expect(redis.get).toHaveBeenCalledWith('idem:sales-1:idem-key-12345678');
    });

    it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
      '%s 写方法 → 进入幂等检查',
      async (method) => {
        redis.get.mockResolvedValueOnce(null);
        next.handle.mockReturnValue(of({}));
        const ctx = makeCtx({
          method,
          headers: { 'idempotency-key': 'idem-key-12345678' },
          user: { id: 'sales-1' },
        });
        await firstValueFrom(
          (await interceptor.intercept(ctx, next as unknown as CallHandler)) as never,
        );
        // 写方法 必查 Redis 一次，cache key 同 user-scope
        expect(redis.get).toHaveBeenCalledTimes(1);
        expect(redis.get).toHaveBeenCalledWith('idem:sales-1:idem-key-12345678');
      },
    );
  });
});
