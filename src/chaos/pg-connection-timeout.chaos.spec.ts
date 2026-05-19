/**
 * L11 Chaos #5 — PG connection timeout / pool exhaustion (P0)
 *
 * Scenario:
 *   - pg-pool 拿不到连接 (connection timeout)
 *   - 验证: 重试 1 次后失败 → 抛 503 ServiceUnavailable
 *   - 验证: 不 fail-open (PG 是核心数据源)
 *   - 验证: audit_log 记录失败
 *
 * 策略:
 *   - mock pg client throw on connect
 *   - 验证 5xx 而不是 200 (核心存储不能 fail-open)
 */
export {};
import { ServiceUnavailableException } from '@nestjs/common';

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

async function queryWithRetry<T>(
  audit: MockAudit,
  mockQuery: () => Promise<T>,
  maxRetries: number = 2,
  backoffMs: number = 10,
): Promise<T> {
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await mockQuery();
      if (attempt > 1) {
        audit.log({ action: 'pg.retry-success', outcome: 'success', meta: { attempt } });
      }
      return result;
    } catch (err) {
      lastErr = err as Error;
      audit.log({ action: 'pg.connection-error', outcome: 'warn', meta: { attempt, error: lastErr.message } });
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }
  // 失败: 不 fail-open, 抛 503
  audit.log({ action: 'pg.fatal', outcome: 'warn', meta: { lastErr: lastErr?.message } });
  throw new ServiceUnavailableException('数据库暂时不可用,请稍后重试');
}

describe('[L11 Chaos #5] PG connection timeout', () => {
  let audit: MockAudit;

  beforeEach(() => {
    audit = new MockAudit();
  });

  it('5.1 PG 连接 timeout × 2 → 重试 1 次后抛 503 (不 fail-open, 因 PG 是核心存储)', async () => {
    let attempts = 0;
    const mockQuery = async (): Promise<{ rows: unknown[] }> => {
      attempts++;
      throw new Error('connection timeout: ETIMEDOUT');
    };
    await expect(queryWithRetry(audit, mockQuery)).rejects.toThrow(ServiceUnavailableException);
    expect(attempts).toBe(2); // 1 + 1 retry

    const errors = audit.byAction('pg.connection-error');
    expect(errors).toHaveLength(2);
    expect(errors[0].meta?.attempt).toBe(1);
    expect(errors[1].meta?.attempt).toBe(2);

    const fatal = audit.byAction('pg.fatal');
    expect(fatal).toHaveLength(1);
  });

  it('5.2 PG 第 1 次 timeout, 第 2 次成功 → 返回结果 (重试 1 次)', async () => {
    let attempts = 0;
    const mockQuery = async (): Promise<{ rows: number[] }> => {
      attempts++;
      if (attempts === 1) throw new Error('ETIMEDOUT');
      return { rows: [1, 2, 3] };
    };
    const result = await queryWithRetry(audit, mockQuery);
    expect(result.rows).toEqual([1, 2, 3]);
    expect(attempts).toBe(2);

    const retrySuccess = audit.byAction('pg.retry-success');
    expect(retrySuccess).toHaveLength(1);
    expect(retrySuccess[0].meta?.attempt).toBe(2);

    expect(audit.byAction('pg.fatal')).toHaveLength(0);
  });

  it('5.3 PG 第 1 次成功 → 一次成功 (无重试 log)', async () => {
    const mockQuery = async () => ({ rows: [{ id: 1 }] });
    const result = await queryWithRetry(audit, mockQuery);
    expect(result.rows).toHaveLength(1);
    expect(audit.byAction('pg.retry-success')).toHaveLength(0);
    expect(audit.byAction('pg.connection-error')).toHaveLength(0);
  });

  it('5.4 PG fail-open 哲学边界: 不允许 fail-open, 必须抛 503 让 client 重试', async () => {
    const mockQuery = async (): Promise<unknown> => {
      throw new Error('pool exhausted');
    };
    let exceptionType = '';
    try {
      await queryWithRetry(audit, mockQuery);
    } catch (err) {
      exceptionType = (err as Error).constructor.name;
    }
    expect(exceptionType).toBe('ServiceUnavailableException');
    expect(audit.byAction('pg.fatal')).toHaveLength(1);
  });
});
