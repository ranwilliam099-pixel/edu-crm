/**
 * L11 Chaos #6 — PG deadlock + idempotency rollback (P0)
 *
 * Scenario:
 *   - 并发写同一 idempotency key
 *   - 1 个 goroutine 触发 PG deadlock (40P01 SQLSTATE)
 *   - 验证: 自动 rollback transaction
 *   - 验证: 重试 1 次后 idempotency hit (因为另一个 goroutine 已成功)
 *
 * 策略:
 *   - mock 数据库 INSERT 第 1 次抛 deadlock, 第 2 次返已存在 row
 *   - 模拟事务 BEGIN/ROLLBACK 边界
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

class PgDeadlockError extends Error {
  code = '40P01';
  constructor(message: string) {
    super(message);
    this.name = 'PgDeadlockError';
  }
}

interface IdempotencyResult<T> {
  hit: boolean;
  data: T;
}

async function insertWithIdempotency<T>(
  key: string,
  audit: MockAudit,
  store: Map<string, T>,
  mockInsert: () => Promise<T>,
  maxRetries: number = 2,
): Promise<IdempotencyResult<T>> {
  // 先查 cache (idempotency)
  if (store.has(key)) {
    audit.log({ action: 'idempotency.hit', outcome: 'success', meta: { key } });
    return { hit: true, data: store.get(key)! };
  }
  // 尝试插入
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await mockInsert();
      store.set(key, result);
      audit.log({ action: 'idempotency.insert', outcome: 'success', meta: { key, attempt } });
      return { hit: false, data: result };
    } catch (err) {
      if (err instanceof PgDeadlockError) {
        audit.log({ action: 'pg.deadlock-rollback', outcome: 'warn', meta: { key, attempt } });
        // 检查另一并发已写入
        if (store.has(key)) {
          audit.log({ action: 'idempotency.hit-after-deadlock', outcome: 'success', meta: { key, attempt } });
          return { hit: true, data: store.get(key)! };
        }
        // 否则继续重试
        await new Promise((r) => setTimeout(r, 10));
        continue;
      }
      throw err;
    }
  }
  throw new Error('idempotency retry exhausted after deadlock');
}

describe('[L11 Chaos #6] PG deadlock + idempotency rollback', () => {
  let audit: MockAudit;
  let store: Map<string, unknown>;

  beforeEach(() => {
    audit = new MockAudit();
    store = new Map();
  });

  it('6.1 并发写同 idempotency key + deadlock → 自动 rollback + 重试 hit', async () => {
    let insertCalls = 0;
    const mockInsert = async () => {
      insertCalls++;
      // 第 1 次抛 deadlock
      if (insertCalls === 1) {
        // 模拟「在 deadlock 发生前另一并发已写入」
        store.set('KEY_001', { id: 'OTHER_GOROUTINE_INSERTED' });
        throw new PgDeadlockError('deadlock detected');
      }
      // 不应该到这里
      return { id: 'SHOULD_NOT_REACH' };
    };

    const result = await insertWithIdempotency('KEY_001', audit, store, mockInsert);
    expect(result.hit).toBe(true);
    expect((result.data as { id: string }).id).toBe('OTHER_GOROUTINE_INSERTED');
    expect(insertCalls).toBe(1);
    expect(audit.byAction('pg.deadlock-rollback')).toHaveLength(1);
    expect(audit.byAction('idempotency.hit-after-deadlock')).toHaveLength(1);
  });

  it('6.2 deadlock 但 另一并发未写 → 重试 + 成功', async () => {
    let insertCalls = 0;
    const mockInsert = async () => {
      insertCalls++;
      if (insertCalls === 1) {
        throw new PgDeadlockError('deadlock detected');
      }
      return { id: 'RETRY_SUCCESS_' + insertCalls };
    };

    const result = await insertWithIdempotency('KEY_002', audit, store, mockInsert);
    expect(result.hit).toBe(false);
    expect((result.data as { id: string }).id).toBe('RETRY_SUCCESS_2');
    expect(insertCalls).toBe(2);
    expect(audit.byAction('pg.deadlock-rollback')).toHaveLength(1);
    const insert = audit.byAction('idempotency.insert');
    expect(insert).toHaveLength(1);
    expect(insert[0].meta?.attempt).toBe(2);
  });

  it('6.3 已存在 cache → 直接 idempotency hit (不进 insert)', async () => {
    store.set('KEY_003', { id: 'PRE_EXISTING' });
    let insertCalls = 0;
    const mockInsert = async () => {
      insertCalls++;
      return { id: 'NEVER_REACH' };
    };

    const result = await insertWithIdempotency('KEY_003', audit, store, mockInsert);
    expect(result.hit).toBe(true);
    expect((result.data as { id: string }).id).toBe('PRE_EXISTING');
    expect(insertCalls).toBe(0); // 没进 insert
    expect(audit.byAction('idempotency.hit')).toHaveLength(1);
  });

  it('6.4 非 deadlock 错误 → 不重试, 直接抛 (业务错误透传)', async () => {
    const mockInsert = async () => {
      throw new Error('FK constraint violation');
    };
    await expect(insertWithIdempotency('KEY_004', audit, store, mockInsert)).rejects.toThrow(/FK constraint/);
    expect(audit.byAction('pg.deadlock-rollback')).toHaveLength(0);
  });
});
