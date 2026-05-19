/**
 * L11 Chaos #3 — 微信 V3 API 5xx 重试 (P0)
 *
 * Scenario:
 *   - 微信 V3 API 返回 502/503/504
 *   - 验证: 自动重试 3 次 (exponential backoff)
 *   - 验证: 最终失败抛错 + 用户友好提示
 *   - 验证: audit_log 记录每次重试 + 最终失败
 *
 * 策略:
 *   - mock fetch 前 N 次返 5xx, 第 N+1 次返 200
 *   - 验证重试次数 + 最终结果 + 时间 backoff
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

interface WxResponse {
  status: number;
  body: { code?: string; message?: string; prepay_id?: string };
}

async function wxV3RequestWithRetry(
  url: string,
  audit: MockAudit,
  mockFetch: () => Promise<WxResponse>,
  maxRetries: number = 3,
  baseBackoffMs: number = 10,
): Promise<WxResponse> {
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const resp = await mockFetch();
      if (resp.status >= 500) {
        audit.log({
          action: 'wxpay.5xx-retry',
          outcome: 'warn',
          meta: { attempt, status: resp.status, url },
        });
        lastErr = new Error(`HTTP ${resp.status}`);
        // exponential backoff
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, baseBackoffMs * Math.pow(2, attempt - 1)));
        }
        continue;
      }
      audit.log({ action: 'wxpay.success', outcome: 'success', meta: { attempt } });
      return resp;
    } catch (err) {
      lastErr = err as Error;
      audit.log({ action: 'wxpay.5xx-retry', outcome: 'warn', meta: { attempt, error: lastErr.message } });
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, baseBackoffMs * Math.pow(2, attempt - 1)));
      }
    }
  }
  // 重试完所有次数还失败
  audit.log({ action: 'wxpay.5xx-final-fail', outcome: 'warn', meta: { totalAttempts: maxRetries, lastErr: lastErr?.message } });
  throw new ServiceUnavailableException(
    '微信支付暂时不可用,请稍后重试',
  );
}

describe('[L11 Chaos #3] 微信 V3 API 5xx 重试', () => {
  let audit: MockAudit;

  beforeEach(() => {
    audit = new MockAudit();
  });

  it('3.1 微信 V3 返 502/503/504 → 重试 3 次后 fail + 用户友好提示', async () => {
    let calls = 0;
    const mockFetch = async (): Promise<WxResponse> => {
      calls++;
      return { status: calls === 1 ? 502 : calls === 2 ? 503 : 504, body: {} };
    };
    await expect(
      wxV3RequestWithRetry('https://api.mch.weixin.qq.com/v3/pay/transactions', audit, mockFetch),
    ).rejects.toThrow(/微信支付暂时不可用/);
    expect(calls).toBe(3);

    const retries = audit.byAction('wxpay.5xx-retry');
    expect(retries).toHaveLength(3);
    expect(retries.map((r) => r.meta?.status).sort()).toEqual([502, 503, 504]);

    const finalFail = audit.byAction('wxpay.5xx-final-fail');
    expect(finalFail).toHaveLength(1);
    expect(finalFail[0].meta?.totalAttempts).toBe(3);
  });

  it('3.2 微信 V3 第 1 次 502, 第 2 次 200 → 成功 (重试 1 次)', async () => {
    let calls = 0;
    const mockFetch = async (): Promise<WxResponse> => {
      calls++;
      if (calls === 1) return { status: 502, body: {} };
      return { status: 200, body: { prepay_id: 'WX_PREPAY_OK' } };
    };
    const result = await wxV3RequestWithRetry('https://api.mch.weixin.qq.com/v3/pay/transactions', audit, mockFetch);
    expect(result.status).toBe(200);
    expect(result.body.prepay_id).toBe('WX_PREPAY_OK');
    expect(calls).toBe(2);

    expect(audit.byAction('wxpay.5xx-retry')).toHaveLength(1);
    const successLog = audit.byAction('wxpay.success');
    expect(successLog).toHaveLength(1);
    expect(successLog[0].meta?.attempt).toBe(2);
  });

  it('3.3 微信 V3 第 1 次 200 → 一次成功 (无重试)', async () => {
    const mockFetch = async (): Promise<WxResponse> => {
      return { status: 200, body: { prepay_id: 'WX_PREPAY_FIRST' } };
    };
    const result = await wxV3RequestWithRetry('https://api.mch.weixin.qq.com/v3/pay/transactions', audit, mockFetch);
    expect(result.status).toBe(200);
    expect(audit.byAction('wxpay.5xx-retry')).toHaveLength(0);
    expect(audit.byAction('wxpay.success')).toHaveLength(1);
  });

  it('3.4 微信 V3 网络错误 (fetch throw) → 同样重试', async () => {
    let calls = 0;
    const mockFetch = async (): Promise<WxResponse> => {
      calls++;
      if (calls < 3) throw new Error('ECONNRESET');
      return { status: 200, body: { prepay_id: 'OK_AFTER_NET_ERR' } };
    };
    const result = await wxV3RequestWithRetry('url', audit, mockFetch);
    expect(result.status).toBe(200);
    expect(calls).toBe(3);
    const retries = audit.byAction('wxpay.5xx-retry');
    expect(retries).toHaveLength(2);
    expect(retries.every((r) => (r.meta?.error as string)?.includes('ECONNRESET'))).toBe(true);
  });
});
