/**
 * L11 Chaos #2 — wx_access_token cache miss + thundering herd (P0)
 *
 * Scenario:
 *   - 100 个并发请求同时 cache miss
 *   - 验证: 只有 1 个 goroutine 真拉微信 API (其他等锁)
 *   - 验证: 后续 99 个走 cache hit (token 复用)
 *   - 验证: 锁未释放时 timeout → fallback fail-open
 *
 * 策略:
 *   - mock Redis SETNX (lock) + 并发计数器
 *   - 触发 100 个 Promise.all 测试 thundering herd 防护
 */
export {};
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

class MockRedisWithLock {
  cache: Map<string, string> = new Map();
  locks: Map<string, boolean> = new Map();

  async get(key: string): Promise<string | null> {
    return this.cache.get(key) || null;
  }
  async set(key: string, value: string): Promise<void> {
    this.cache.set(key, value);
  }
  async tryLock(key: string): Promise<boolean> {
    if (this.locks.get(key)) return false;
    this.locks.set(key, true);
    return true;
  }
  async releaseLock(key: string): Promise<void> {
    this.locks.delete(key);
  }
}

// wx_access_token 服务 with thundering herd 防护
async function getWxAccessTokenSafe(
  redis: MockRedisWithLock,
  audit: MockAudit,
  fetcher: () => Promise<string>,
  // simulate timing: lock 持有期 + cache 写入
  fetchDelayMs: number = 50,
): Promise<{ token: string; source: 'cache' | 'fetched' | 'lock-wait-cache' | 'lock-fail-open' }> {
  const cached = await redis.get('wx_access_token');
  if (cached) {
    audit.log({ action: 'wx_access_token.cache-hit', outcome: 'success' });
    return { token: cached, source: 'cache' };
  }
  // cache miss → try acquire lock
  const got = await redis.tryLock('lock:wx_access_token');
  if (got) {
    try {
      // 拉微信 API
      audit.log({ action: 'wx_access_token.fetch-from-wx', outcome: 'success' });
      const token = await fetcher();
      await redis.set('wx_access_token', token);
      return { token, source: 'fetched' };
    } finally {
      await redis.releaseLock('lock:wx_access_token');
    }
  }
  // 没拿到锁 → 等 + retry cache
  await new Promise((r) => setTimeout(r, fetchDelayMs + 10));
  const after = await redis.get('wx_access_token');
  if (after) {
    audit.log({ action: 'wx_access_token.lock-wait-cache-hit', outcome: 'success' });
    return { token: after, source: 'lock-wait-cache' };
  }
  // 锁满了但 cache 还没写 → fail-open 自己拉
  audit.log({ action: 'wx_access_token.lock-timeout-fail-open', outcome: 'warn' });
  const token = await fetcher();
  return { token, source: 'lock-fail-open' };
}

describe('[L11 Chaos #2] wx_access_token cache miss + thundering herd', () => {
  let redis: MockRedisWithLock;
  let audit: MockAudit;
  let wxApiCallCount: number;
  let fetcher: () => Promise<string>;

  beforeEach(() => {
    redis = new MockRedisWithLock();
    audit = new MockAudit();
    wxApiCallCount = 0;
    fetcher = async () => {
      wxApiCallCount++;
      await new Promise((r) => setTimeout(r, 50));
      return 'WX_TOKEN_FRESH_' + wxApiCallCount;
    };
  });

  it('2.1 100 并发 cache miss → 只 1 次拉微信 (其他等锁 + cache hit)', async () => {
    const promises = Array.from({ length: 100 }, () => getWxAccessTokenSafe(redis, audit, fetcher));
    const results = await Promise.all(promises);

    // 只 1 次拉微信
    expect(wxApiCallCount).toBe(1);

    // 1 个 fetched + 99 个 cache hit / lock-wait-cache 任一
    const fetched = results.filter((r) => r.source === 'fetched');
    expect(fetched).toHaveLength(1);
    const cached = results.filter((r) => r.source === 'cache' || r.source === 'lock-wait-cache');
    expect(cached.length).toBeGreaterThanOrEqual(50); // 至少 50% 走 cache hit

    // 所有 token 一致
    const uniqueTokens = new Set(results.map((r) => r.token));
    expect(uniqueTokens.size).toBe(1);
    expect(Array.from(uniqueTokens)[0]).toBe('WX_TOKEN_FRESH_1');
  });

  it('2.2 锁持有期太长 → 后续等待者 fail-open 自己拉', async () => {
    // 模拟 lock holder 卡死 (锁不释放)
    await redis.tryLock('lock:wx_access_token'); // 占锁但不释放

    // 后续请求只能 fail-open
    const result = await getWxAccessTokenSafe(redis, audit, fetcher, 10);
    expect(result.source).toBe('lock-fail-open');
    expect(wxApiCallCount).toBe(1);
    expect(audit.byAction('wx_access_token.lock-timeout-fail-open')).toHaveLength(1);
  });

  it('2.3 第二轮请求 → 所有走 cache hit (无拉微信)', async () => {
    // 第一轮: 先填 cache
    await getWxAccessTokenSafe(redis, audit, fetcher);
    expect(wxApiCallCount).toBe(1);
    const beforeWxCalls = wxApiCallCount;

    // 第二轮: 50 并发 → 全 cache hit
    const promises = Array.from({ length: 50 }, () => getWxAccessTokenSafe(redis, audit, fetcher));
    const results = await Promise.all(promises);

    expect(wxApiCallCount).toBe(beforeWxCalls); // 没新增
    expect(results.every((r) => r.source === 'cache')).toBe(true);
    expect(audit.byAction('wx_access_token.cache-hit').length).toBeGreaterThanOrEqual(50);
  });
});
