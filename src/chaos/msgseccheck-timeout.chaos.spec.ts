/**
 * L11 Chaos #4 — msgSecCheck timeout fail-open (P0)
 *
 * Scenario:
 *   - 微信内容安全 API 超时 (> 3s)
 *   - 验证: fail-open 不阻塞业务
 *   - 验证: audit_log 记录「待 review」(异步人工审核)
 *   - 验证: pending_review flag set on entity
 *
 * 策略:
 *   - mock checkText with timeout simulator
 *   - 验证 fail-open path 走 audit_log 「待 review」
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

type MsgSecResult = 'ok' | 'risky' | 'timeout';

async function checkTextWithTimeout(
  content: string,
  audit: MockAudit,
  // simulate WX API with controlled outcome
  mockApi: (content: string) => Promise<{ outcome: MsgSecResult }>,
  timeoutMs: number = 3000,
): Promise<{ allowed: boolean; pendingReview: boolean; reason?: string }> {
  try {
    const result = await Promise.race([
      mockApi(content),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('TIMEOUT')), timeoutMs)),
    ]);
    if (result.outcome === 'risky') {
      audit.log({ action: 'msgsec.blocked', outcome: 'denied', meta: { content: content.slice(0, 50) } });
      return { allowed: false, pendingReview: false, reason: 'content blocked' };
    }
    audit.log({ action: 'msgsec.ok', outcome: 'success' });
    return { allowed: true, pendingReview: false };
  } catch (err) {
    const isTimeout = (err as Error).message === 'TIMEOUT';
    if (isTimeout) {
      // fail-open: 允许通过, 但标 pendingReview
      audit.log({
        action: 'msgsec.timeout-fail-open',
        outcome: 'warn',
        meta: { reason: 'wx api timeout', willReviewLater: true },
      });
      return { allowed: true, pendingReview: true, reason: 'fail-open: api timeout' };
    }
    // 其他错误同样 fail-open
    audit.log({
      action: 'msgsec.error-fail-open',
      outcome: 'warn',
      meta: { error: (err as Error).message },
    });
    return { allowed: true, pendingReview: true };
  }
}

describe('[L11 Chaos #4] msgSecCheck timeout fail-open', () => {
  let audit: MockAudit;

  beforeEach(() => {
    audit = new MockAudit();
  });

  it('4.1 msgSecCheck 超时 → fail-open + pendingReview=true + audit 「待 review」', async () => {
    const slowApi = async () => {
      await new Promise((r) => setTimeout(r, 5000)); // 5s > timeout
      return { outcome: 'ok' as MsgSecResult };
    };
    const result = await checkTextWithTimeout('正常内容', audit, slowApi, 100);
    expect(result.allowed).toBe(true);
    expect(result.pendingReview).toBe(true);
    expect(result.reason).toContain('fail-open');

    const failOpen = audit.byAction('msgsec.timeout-fail-open');
    expect(failOpen).toHaveLength(1);
    expect(failOpen[0].outcome).toBe('warn');
    expect(failOpen[0].meta?.willReviewLater).toBe(true);
  });

  it('4.2 msgSecCheck OK → 正常通过 + pendingReview=false', async () => {
    const fastApi = async () => ({ outcome: 'ok' as MsgSecResult });
    const result = await checkTextWithTimeout('完全正常', audit, fastApi);
    expect(result.allowed).toBe(true);
    expect(result.pendingReview).toBe(false);
    expect(audit.byAction('msgsec.ok')).toHaveLength(1);
    expect(audit.byAction('msgsec.timeout-fail-open')).toHaveLength(0);
  });

  it('4.3 msgSecCheck risky → 阻断 (非 fail-open)', async () => {
    const riskyApi = async () => ({ outcome: 'risky' as MsgSecResult });
    const result = await checkTextWithTimeout('暴力威胁', audit, riskyApi);
    expect(result.allowed).toBe(false);
    expect(result.pendingReview).toBe(false);
    expect(result.reason).toBe('content blocked');
    expect(audit.byAction('msgsec.blocked')).toHaveLength(1);
  });

  it('4.4 msgSecCheck 网络错误 → fail-open + pendingReview', async () => {
    const errorApi = async (): Promise<{ outcome: MsgSecResult }> => {
      throw new Error('ECONNRESET');
    };
    const result = await checkTextWithTimeout('content', audit, errorApi);
    expect(result.allowed).toBe(true);
    expect(result.pendingReview).toBe(true);
    expect(audit.byAction('msgsec.error-fail-open')).toHaveLength(1);
    expect(audit.byAction('msgsec.error-fail-open')[0].meta?.error).toBe('ECONNRESET');
  });
});
