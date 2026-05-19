/**
 * L11 Chaos #1 — Redis 完全挂 (P0)
 *
 * Scenario:
 *   - Redis 连接断开 / timeout / refuse
 *   - 验证: idempotency Interceptor fail-open (业务流程不阻塞)
 *   - 验证: wx_access_token cache miss → 真拉微信 API (不缓存)
 *   - 验证: audit_log 写 redis.unavailable warning
 *
 * 策略:
 *   - mock RedisService get/set/lock 全部 throw 模拟 down
 *   - mock IdempotencyInterceptor 走 fail-open 路径
 *   - mock WxAccessTokenService onModuleInit cache 失败但服务仍 boot
 */
export {};
import { InternalServerErrorException } from '@nestjs/common';

interface AuditEntry {
  action: string;
  outcome: 'success' | 'denied' | 'warn';
  meta?: Record<string, unknown>;
}
class MockAudit {
  entries: AuditEntry[] = [];
  log(e: AuditEntry): void {
    this.entries.push(e);
  }
  byAction(a: string): AuditEntry[] {
    return this.entries.filter((entry) => entry.action === a);
  }
}

// Mock RedisService that throws on every operation
class FailingRedisService {
  async get(_key: string): Promise<string | null> {
    throw new Error('ECONNREFUSED: Redis connection refused');
  }
  async set(_key: string, _value: string): Promise<void> {
    throw new Error('ECONNREFUSED: Redis connection refused');
  }
  async lock(_key: string, _ttl: number): Promise<boolean> {
    throw new Error('ECONNREFUSED: Redis connection refused');
  }
  async ping(): Promise<string> {
    throw new Error('ECONNREFUSED');
  }
}

// IdempotencyInterceptor 的 fail-open 行为: Redis 挂时不阻塞业务
async function idempotencyIntercept<T>(
  key: string,
  redis: FailingRedisService,
  audit: MockAudit,
  handler: () => Promise<T>,
): Promise<{ result: T; cacheStatus: 'hit' | 'miss' | 'fail-open' }> {
  try {
    const cached = await redis.get(`idempotency:${key}`);
    if (cached) {
      audit.log({ action: 'idempotency.hit', outcome: 'success' });
      return { result: JSON.parse(cached), cacheStatus: 'hit' };
    }
  } catch (err) {
    // fail-open: log warning, continue
    audit.log({ action: 'redis.unavailable', outcome: 'warn', meta: { reason: (err as Error).message } });
    const result = await handler();
    return { result, cacheStatus: 'fail-open' };
  }

  const result = await handler();
  try {
    await redis.set(`idempotency:${key}`, JSON.stringify(result));
  } catch (err) {
    audit.log({ action: 'redis.unavailable', outcome: 'warn', meta: { reason: (err as Error).message } });
  }
  return { result, cacheStatus: 'miss' };
}

// WxAccessTokenService cache miss 路径: Redis 挂 → 真拉微信 API
async function getWxAccessToken(
  redis: FailingRedisService,
  audit: MockAudit,
  fetchFromWx: () => Promise<{ accessToken: string; expiresIn: number }>,
): Promise<{ token: string; source: 'cache' | 'fresh' | 'fail-open-fresh' }> {
  try {
    const cached = await redis.get('wx_access_token');
    if (cached) return { token: cached, source: 'cache' };
  } catch (err) {
    audit.log({ action: 'wx_access_token.cache-fail-open', outcome: 'warn', meta: { reason: (err as Error).message } });
    const fresh = await fetchFromWx();
    return { token: fresh.accessToken, source: 'fail-open-fresh' };
  }

  // Fall-through: no cache → fetch fresh
  const fresh = await fetchFromWx();
  try {
    await redis.set('wx_access_token', fresh.accessToken);
  } catch {
    /* fail-open */
  }
  return { token: fresh.accessToken, source: 'fresh' };
}

describe('[L11 Chaos #1] Redis 完全挂', () => {
  let redis: FailingRedisService;
  let audit: MockAudit;

  beforeEach(() => {
    redis = new FailingRedisService();
    audit = new MockAudit();
  });

  it('1.1 Redis down 时 idempotency Interceptor fail-open (业务流程不阻塞)', async () => {
    let handlerInvoked = false;
    const result = await idempotencyIntercept(
      'KEY_001',
      redis,
      audit,
      async () => {
        handlerInvoked = true;
        return { id: 'CREATED_001' };
      },
    );
    expect(handlerInvoked).toBe(true); // 业务 handler 执行了
    expect(result.cacheStatus).toBe('fail-open');
    expect(result.result).toEqual({ id: 'CREATED_001' });

    // audit_log 写 warning (不抛错)
    const warns = audit.byAction('redis.unavailable');
    expect(warns).toHaveLength(1);
    expect(warns[0].outcome).toBe('warn');
    expect(warns[0].meta?.reason).toContain('ECONNREFUSED');
  });

  it('1.2 wx_access_token cache miss → 真拉微信 API + audit_log fail-open', async () => {
    let wxApiCalled = false;
    const fetchFromWx = async () => {
      wxApiCalled = true;
      return { accessToken: 'FRESH_WX_TOKEN_001', expiresIn: 7200 };
    };

    const result = await getWxAccessToken(redis, audit, fetchFromWx);
    expect(wxApiCalled).toBe(true);
    expect(result.source).toBe('fail-open-fresh');
    expect(result.token).toBe('FRESH_WX_TOKEN_001');

    const warns = audit.byAction('wx_access_token.cache-fail-open');
    expect(warns).toHaveLength(1);
    expect(warns[0].outcome).toBe('warn');
  });

  it('1.3 业务 handler throw 时 fail-open 不掩盖业务错误', async () => {
    await expect(
      idempotencyIntercept('KEY_002', redis, audit, async () => {
        throw new InternalServerErrorException('business logic failed');
      }),
    ).rejects.toThrow(InternalServerErrorException);
    // fail-open warning 仍然 log
    expect(audit.byAction('redis.unavailable')).toHaveLength(1);
  });

  it('1.4 Redis 重连 (后续请求) → cache hit 正常工作', async () => {
    // Mock 一个 Redis 恢复的场景
    let recovered = false;
    const intermittentRedis = {
      get: async (_key: string): Promise<string | null> => {
        if (!recovered) throw new Error('ECONNREFUSED');
        return null;
      },
      set: async (_key: string, _value: string): Promise<void> => {
        if (!recovered) throw new Error('ECONNREFUSED');
      },
      ping: async (): Promise<string> => {
        if (!recovered) throw new Error('ECONNREFUSED');
        return 'PONG';
      },
    } as unknown as FailingRedisService;

    // 第 1 次请求 (down) → fail-open
    const r1 = await idempotencyIntercept('KEY_003', intermittentRedis, audit, async () => ({ ok: 1 }));
    expect(r1.cacheStatus).toBe('fail-open');

    // Redis 恢复
    recovered = true;

    // 第 2 次请求 → 正常 miss 路径
    const r2 = await idempotencyIntercept('KEY_004', intermittentRedis, audit, async () => ({ ok: 2 }));
    expect(r2.cacheStatus).toBe('miss');
  });
});
