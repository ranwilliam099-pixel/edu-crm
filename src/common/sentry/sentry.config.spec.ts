import { makeSentryOptions, shouldInitSentry, __test__ } from './sentry.config';

describe('SentryConfig', () => {
  let savedEnv: string | undefined;
  let savedDsn: string | undefined;
  let savedRelease: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.NODE_ENV;
    savedDsn = process.env.SENTRY_DSN;
    savedRelease = process.env.SENTRY_RELEASE;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedEnv;
    if (savedDsn === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = savedDsn;
    if (savedRelease === undefined) delete process.env.SENTRY_RELEASE;
    else process.env.SENTRY_RELEASE = savedRelease;
  });

  describe('shouldInitSentry()', () => {
    it('无 DSN → false', () => {
      expect(shouldInitSentry('production', undefined)).toBe(false);
      expect(shouldInitSentry('production', '')).toBe(false);
      expect(shouldInitSentry('production', '  ')).toBe(false);
    });

    it('test env → false（不污染单测）', () => {
      expect(shouldInitSentry('test', 'https://abc@sentry.io/1')).toBe(false);
    });

    it('production + DSN → true', () => {
      expect(shouldInitSentry('production', 'https://abc@sentry.io/1')).toBe(true);
    });

    it('development + DSN → true', () => {
      expect(shouldInitSentry('development', 'https://abc@sentry.io/1')).toBe(true);
    });

    it('从 process.env 读默认值', () => {
      process.env.NODE_ENV = 'production';
      process.env.SENTRY_DSN = 'https://x@sentry.io/2';
      expect(shouldInitSentry()).toBe(true);
    });
  });

  describe('makeSentryOptions()', () => {
    it('production → 采样 10%', () => {
      const o = makeSentryOptions({
        environment: 'production',
        dsn: 'https://abc@sentry.io/1',
      });
      expect(o.dsn).toBe('https://abc@sentry.io/1');
      expect(o.environment).toBe('production');
      expect(o.tracesSampleRate).toBe(0.1);
      expect(o.profilesSampleRate).toBe(0.1);
    });

    it('development → 100% 采样', () => {
      const o = makeSentryOptions({
        environment: 'development',
        dsn: 'https://abc@sentry.io/1',
      });
      expect(o.tracesSampleRate).toBe(1.0);
      expect(o.profilesSampleRate).toBe(1.0);
    });

    it('sendDefaultPii false（默认安全）', () => {
      const o = makeSentryOptions({
        environment: 'production',
        dsn: 'https://abc@sentry.io/1',
      });
      expect(o.sendDefaultPii).toBe(false);
    });

    it('release 透传', () => {
      const o = makeSentryOptions({
        environment: 'production',
        dsn: 'https://abc@sentry.io/1',
        release: 'edu-server@1.2.3',
      });
      expect(o.release).toBe('edu-server@1.2.3');
    });

    it('ignoreErrors 含网络断开 + 健康检查', () => {
      const o = makeSentryOptions({
        environment: 'production',
        dsn: 'https://abc@sentry.io/1',
      });
      expect(o.ignoreErrors).toEqual(
        expect.arrayContaining(['aborted', 'ECONNRESET', 'EPIPE']),
      );
    });

    describe('beforeSend PII 脱敏', () => {
      const dsn = 'https://abc@sentry.io/1';

      it('请求头 cookie / authorization → REDACTED', () => {
        const o = makeSentryOptions({ environment: 'production', dsn });
        const event = {
          request: {
            headers: {
              cookie: 'session=secret',
              authorization: 'Bearer xxx',
              'x-tenant-schema': 'tenant_xxx',
              'user-agent': 'WeChatMP/8.x',
            },
          },
        };
        const out = o.beforeSend!(event as never, {} as never) as { request: { headers: Record<string, string> } };
        expect(out.request.headers.cookie).toBe('[REDACTED]');
        expect(out.request.headers.authorization).toBe('[REDACTED]');
        expect(out.request.headers['x-tenant-schema']).toBe('[REDACTED]');
        expect(out.request.headers['user-agent']).toBe('WeChatMP/8.x'); // 不脱敏
      });

      it('请求 body 中的 password / phone / token → REDACTED', () => {
        const o = makeSentryOptions({ environment: 'production', dsn });
        const event = {
          request: {
            data: {
              username: 'wang',
              password: 'mypw',
              phone: '13800138000',
              token: 'jwt-xxx',
              normal: 'visible',
            },
          },
        };
        const out = o.beforeSend!(event as never, {} as never) as {
          request: { data: Record<string, string> };
        };
        expect(out.request.data.password).toBe('[REDACTED]');
        expect(out.request.data.phone).toBe('[REDACTED]');
        expect(out.request.data.token).toBe('[REDACTED]');
        expect(out.request.data.normal).toBe('visible');
        expect(out.request.data.username).toBe('wang');
      });

      it('嵌套对象敏感字段 → REDACTED', () => {
        const o = makeSentryOptions({ environment: 'production', dsn });
        const event = {
          request: {
            data: {
              user: {
                name: 'wang',
                phone: '13800138000',
                profile: {
                  id_number: '500103xxx',
                },
              },
            },
          },
        };
        const out = o.beforeSend!(event as never, {} as never) as {
          request: { data: { user: { phone: string; profile: { id_number: string } } } };
        };
        expect(out.request.data.user.phone).toBe('[REDACTED]');
        expect(out.request.data.user.profile.id_number).toBe('[REDACTED]');
      });

      it('extra 字段也脱敏', () => {
        const o = makeSentryOptions({ environment: 'production', dsn });
        const event = {
          extra: { token: 'jwt-xxx', normal: 'visible' },
        };
        const out = o.beforeSend!(event as never, {} as never) as { extra: Record<string, string> };
        expect(out.extra.token).toBe('[REDACTED]');
        expect(out.extra.normal).toBe('visible');
      });
    });
  });

  describe('scrubObject 工具', () => {
    it('深度 > 5 → 停止递归（防爆栈）', () => {
      const deep: Record<string, unknown> = { password: 'secret' };
      let cur = deep;
      for (let i = 0; i < 10; i++) {
        cur.next = { password: 'inner' };
        cur = cur.next as Record<string, unknown>;
      }
      // 不应抛错
      expect(() => __test__.scrubObject(deep)).not.toThrow();
    });

    it('SENSITIVE_KEYS 包含 PII + 凭证类', () => {
      expect(__test__.SENSITIVE_KEYS.has('phone')).toBe(true);
      expect(__test__.SENSITIVE_KEYS.has('password')).toBe(true);
      expect(__test__.SENSITIVE_KEYS.has('id_number')).toBe(true);
      expect(__test__.SENSITIVE_KEYS.has('openid')).toBe(true);
      expect(__test__.SENSITIVE_KEYS.has('refresh_token')).toBe(true);
    });
  });
});
