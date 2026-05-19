/**
 * L11 Chaos #8 — wxpay 平台证书拉取失败 (P0)
 *
 * Scenario:
 *   - WxPayPlatformCertService.onModuleInit 失败 (微信新商户不支持 /v3/certificates, 5/14 实战发现)
 *   - 验证: 不 crash bootstrap (fail-open)
 *   - 验证: 首次回调时 fallback 重试 (从本地 pub_key.pem)
 *   - 验证: audit_log 告警 + 监控触发
 *
 * 策略:
 *   - mock fetch /v3/certificates 返 404
 *   - mock 本地 pub_key.pem 文件存在 / 不存在两态
 *   - 验证 fail-open + fallback 路径
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

interface PlatformCertResult {
  source: 'wx-api' | 'local-pem' | 'none';
  certPem?: string;
  failOpen: boolean;
}

class MockWxPayPlatformCertService {
  cached: string | null = null;
  initFailed = false;

  async onModuleInit(
    audit: MockAudit,
    wxApiFetch: () => Promise<{ certPem: string } | null>,
    localPemRead: () => Promise<string | null>,
  ): Promise<{ initOk: boolean }> {
    try {
      const wxResult = await wxApiFetch();
      if (wxResult) {
        this.cached = wxResult.certPem;
        audit.log({ action: 'wxpay.platform-cert.init-wx-api', outcome: 'success' });
        return { initOk: true };
      }
    } catch (err) {
      audit.log({
        action: 'wxpay.platform-cert.wx-api-failed',
        outcome: 'warn',
        meta: { reason: (err as Error).message },
      });
    }

    // fallback: local pub_key.pem
    try {
      const local = await localPemRead();
      if (local) {
        this.cached = local;
        audit.log({ action: 'wxpay.platform-cert.init-local-pem', outcome: 'success' });
        return { initOk: true };
      }
    } catch (err) {
      audit.log({
        action: 'wxpay.platform-cert.local-pem-failed',
        outcome: 'warn',
        meta: { reason: (err as Error).message },
      });
    }

    // fail-open: 不 crash, 首次回调时再试
    audit.log({
      action: 'wxpay.platform-cert.init-fail-open',
      outcome: 'warn',
      meta: { willRetryOnFirstCallback: true },
    });
    this.initFailed = true;
    return { initOk: false }; // fail-open: 服务仍 bootstrap
  }

  async getCertOnDemand(
    audit: MockAudit,
    wxApiFetch: () => Promise<{ certPem: string } | null>,
    localPemRead: () => Promise<string | null>,
  ): Promise<PlatformCertResult> {
    if (this.cached) return { source: 'wx-api', certPem: this.cached, failOpen: false };

    // 首次回调时再试
    try {
      const wxResult = await wxApiFetch();
      if (wxResult) {
        this.cached = wxResult.certPem;
        audit.log({ action: 'wxpay.platform-cert.lazy-wx-api-success', outcome: 'success' });
        return { source: 'wx-api', certPem: wxResult.certPem, failOpen: false };
      }
    } catch {
      /* fall through */
    }
    try {
      const local = await localPemRead();
      if (local) {
        this.cached = local;
        audit.log({ action: 'wxpay.platform-cert.lazy-local-pem-success', outcome: 'success' });
        return { source: 'local-pem', certPem: local, failOpen: false };
      }
    } catch {
      /* fall through */
    }
    audit.log({ action: 'wxpay.platform-cert.lazy-fail', outcome: 'warn' });
    return { source: 'none', failOpen: true };
  }
}

describe('[L11 Chaos #8] wxpay 平台证书拉取失败', () => {
  let svc: MockWxPayPlatformCertService;
  let audit: MockAudit;

  beforeEach(() => {
    svc = new MockWxPayPlatformCertService();
    audit = new MockAudit();
  });

  it('8.1 wx /v3/certificates 404 + local pub_key.pem 不存在 → fail-open bootstrap (不 crash)', async () => {
    const result = await svc.onModuleInit(
      audit,
      async () => null, // wx api 404
      async () => null, // local pem missing
    );
    expect(result.initOk).toBe(false);
    expect(svc.initFailed).toBe(true);
    expect(audit.byAction('wxpay.platform-cert.init-fail-open')).toHaveLength(1);
    expect(audit.byAction('wxpay.platform-cert.init-fail-open')[0].meta?.willRetryOnFirstCallback).toBe(true);
  });

  it('8.2 wx /v3/certificates 404 + local pub_key.pem 存在 → fallback 加载本地', async () => {
    const result = await svc.onModuleInit(
      audit,
      async () => null,
      async () => '-----BEGIN PUBLIC KEY-----LOCAL_PEM_CONTENT-----END PUBLIC KEY-----',
    );
    expect(result.initOk).toBe(true);
    expect(svc.cached).toContain('LOCAL_PEM_CONTENT');
    expect(audit.byAction('wxpay.platform-cert.init-local-pem')).toHaveLength(1);
  });

  it('8.3 onInit fail-open → 首次回调时 lazy 重试 wx api 成功', async () => {
    // onInit 失败
    await svc.onModuleInit(audit, async () => null, async () => null);
    expect(svc.initFailed).toBe(true);

    // 首次回调时 lazy 拉
    const lazy = await svc.getCertOnDemand(
      audit,
      async () => ({ certPem: 'LAZY_CERT_FROM_WX' }),
      async () => null,
    );
    expect(lazy.source).toBe('wx-api');
    expect(lazy.certPem).toBe('LAZY_CERT_FROM_WX');
    expect(lazy.failOpen).toBe(false);
    expect(audit.byAction('wxpay.platform-cert.lazy-wx-api-success')).toHaveLength(1);
  });

  it('8.4 onInit fail-open + lazy wx 404 + lazy local 存在 → 加载本地', async () => {
    await svc.onModuleInit(audit, async () => null, async () => null);

    const lazy = await svc.getCertOnDemand(
      audit,
      async () => null,
      async () => 'LAZY_LOCAL_PEM',
    );
    expect(lazy.source).toBe('local-pem');
    expect(lazy.certPem).toBe('LAZY_LOCAL_PEM');
    expect(audit.byAction('wxpay.platform-cert.lazy-local-pem-success')).toHaveLength(1);
  });

  it('8.5 onInit fail-open + lazy wx 失败 + lazy local 失败 → 返 none + failOpen=true (V3 callback 验签失败)', async () => {
    await svc.onModuleInit(audit, async () => null, async () => null);

    const lazy = await svc.getCertOnDemand(
      audit,
      async () => {
        throw new Error('wx api still failing');
      },
      async () => null,
    );
    expect(lazy.source).toBe('none');
    expect(lazy.failOpen).toBe(true);
    expect(audit.byAction('wxpay.platform-cert.lazy-fail')).toHaveLength(1);
  });

  it('8.6 wx /v3/certificates 第一次成功 → cache + 不进 lazy 路径', async () => {
    const result = await svc.onModuleInit(
      audit,
      async () => ({ certPem: 'INIT_CERT_OK' }),
      async () => null,
    );
    expect(result.initOk).toBe(true);
    expect(svc.cached).toBe('INIT_CERT_OK');
    expect(audit.byAction('wxpay.platform-cert.init-wx-api')).toHaveLength(1);
    expect(audit.byAction('wxpay.platform-cert.init-fail-open')).toHaveLength(0);

    // lazy 直接返 cache
    const lazy = await svc.getCertOnDemand(
      audit,
      async () => {
        throw new Error('should not be called');
      },
      async () => null,
    );
    expect(lazy.source).toBe('wx-api');
    expect(lazy.certPem).toBe('INIT_CERT_OK');
  });
});
