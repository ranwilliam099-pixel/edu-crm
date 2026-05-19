import { detectEnv, detectLevel, makePinoOptions } from './logger.config';
import { REDACT_PATHS } from './redact-paths';

describe('LoggerConfig', () => {
  let savedEnv: string | undefined;
  let savedLevel: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.NODE_ENV;
    savedLevel = process.env.LOG_LEVEL;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedEnv;
    if (savedLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = savedLevel;
  });

  describe('detectEnv()', () => {
    it.each([
      ['production', 'production'],
      ['prod', 'production'],
      ['development', 'development'],
      ['dev', 'development'],
      ['test', 'test'],
      [undefined, 'development'],
      ['', 'development'],
    ])('NODE_ENV=%s → %s', (input, expected) => {
      if (input === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = input;
      expect(detectEnv()).toBe(expected);
    });
  });

  describe('detectLevel()', () => {
    it('test env → silent（不污染单测输出）', () => {
      expect(detectLevel('test')).toBe('silent');
    });

    it('production 默认 info', () => {
      delete process.env.LOG_LEVEL;
      expect(detectLevel('production')).toBe('info');
    });

    it('development 默认 debug', () => {
      delete process.env.LOG_LEVEL;
      expect(detectLevel('development')).toBe('debug');
    });

    it('LOG_LEVEL env 覆盖默认', () => {
      process.env.LOG_LEVEL = 'warn';
      expect(detectLevel('production')).toBe('warn');
      expect(detectLevel('development')).toBe('warn');
    });

    it('test env 不被 LOG_LEVEL 覆盖（始终 silent）', () => {
      process.env.LOG_LEVEL = 'debug';
      expect(detectLevel('test')).toBe('silent');
    });
  });

  describe('makePinoOptions()', () => {
    it('返回带 pinoHttp 的合法配置', () => {
      const opts = makePinoOptions('production');
      expect(opts.pinoHttp).toBeDefined();
      const pinoHttp = opts.pinoHttp as Record<string, unknown>;
      expect(pinoHttp.level).toBe('info');
      expect(pinoHttp.redact).toBeDefined();
    });

    it('production env → 不带 transport（默认 stdout JSON）', () => {
      const opts = makePinoOptions('production');
      const pinoHttp = opts.pinoHttp as Record<string, unknown>;
      expect(pinoHttp.transport).toBeUndefined();
    });

    it('development env → 带 pino-pretty transport', () => {
      const opts = makePinoOptions('development');
      const pinoHttp = opts.pinoHttp as Record<string, unknown>;
      expect(pinoHttp.transport).toBeDefined();
      const transport = pinoHttp.transport as { target: string };
      expect(transport.target).toBe('pino-pretty');
    });

    it('test env → silent level', () => {
      const opts = makePinoOptions('test');
      const pinoHttp = opts.pinoHttp as Record<string, unknown>;
      expect(pinoHttp.level).toBe('silent');
    });

    it('redact paths 来自 REDACT_PATHS', () => {
      const opts = makePinoOptions('production');
      const pinoHttp = opts.pinoHttp as Record<string, unknown>;
      const redact = pinoHttp.redact as { paths: string[]; censor: string };
      expect(redact.paths).toBe(REDACT_PATHS);
      expect(redact.censor).toBe('[REDACTED]');
    });

    describe('genReqId 链路追踪', () => {
      it('上游带 X-Request-Id → 复用', () => {
        const opts = makePinoOptions('production');
        const pinoHttp = opts.pinoHttp as Record<string, unknown>;
        const genReqId = pinoHttp.genReqId as (req: any) => string;
        expect(
          genReqId({ headers: { 'x-request-id': 'req-existing-123' } }),
        ).toBe('req-existing-123');
      });

      it('上游不带 → 自生成 UUID', () => {
        const opts = makePinoOptions('production');
        const pinoHttp = opts.pinoHttp as Record<string, unknown>;
        const genReqId = pinoHttp.genReqId as (req: any) => string;
        const id = genReqId({ headers: {} });
        expect(typeof id).toBe('string');
        expect(id.length).toBeGreaterThanOrEqual(32);
      });

      it('headers 是数组（异常情况）→ 取第一个', () => {
        const opts = makePinoOptions('production');
        const pinoHttp = opts.pinoHttp as Record<string, unknown>;
        const genReqId = pinoHttp.genReqId as (req: any) => string;
        expect(
          genReqId({ headers: { 'x-request-id': ['req-arr-1', 'req-arr-2'] } }),
        ).toBe('req-arr-1');
      });

      it('headers undefined → 自生成 UUID', () => {
        const opts = makePinoOptions('production');
        const pinoHttp = opts.pinoHttp as Record<string, unknown>;
        const genReqId = pinoHttp.genReqId as (req: any) => string;
        const id = genReqId({});
        expect(typeof id).toBe('string');
      });
    });

    describe('autoLogging 屏蔽健康检查', () => {
      it('健康检查请求 → 不记日志', () => {
        const opts = makePinoOptions('production');
        const pinoHttp = opts.pinoHttp as Record<string, unknown>;
        const autoLogging = pinoHttp.autoLogging as { ignore: (req: any) => boolean };
        expect(autoLogging.ignore({ url: '/api/public/health' })).toBe(true);
        expect(autoLogging.ignore({ url: '/health' })).toBe(true);
        expect(autoLogging.ignore({ url: '/favicon.ico' })).toBe(true);
      });

      it('业务请求 → 记日志', () => {
        const opts = makePinoOptions('production');
        const pinoHttp = opts.pinoHttp as Record<string, unknown>;
        const autoLogging = pinoHttp.autoLogging as { ignore: (req: any) => boolean };
        expect(autoLogging.ignore({ url: '/api/db/students/list' })).toBe(false);
        expect(autoLogging.ignore({ url: '/api/login' })).toBe(false);
      });

      it('url undefined → 不屏蔽', () => {
        const opts = makePinoOptions('production');
        const pinoHttp = opts.pinoHttp as Record<string, unknown>;
        const autoLogging = pinoHttp.autoLogging as { ignore: (req: any) => boolean };
        expect(autoLogging.ignore({})).toBe(false);
      });
    });

    describe('serializers.err 错误序列化', () => {
      it('Error 对象 → 含 type/message/stack', () => {
        const opts = makePinoOptions('production');
        const pinoHttp = opts.pinoHttp as Record<string, unknown>;
        const serializers = pinoHttp.serializers as { err: (e: Error) => any };
        const out = serializers.err(new TypeError('boom'));
        expect(out.type).toBe('TypeError');
        expect(out.message).toBe('boom');
        expect(out.stack).toContain('TypeError');
      });

      it('错误带 code/statusCode → 透传', () => {
        const opts = makePinoOptions('production');
        const pinoHttp = opts.pinoHttp as Record<string, unknown>;
        const serializers = pinoHttp.serializers as { err: (e: any) => any };
        const err: any = new Error('not found');
        err.code = 'ENOENT';
        err.statusCode = 404;
        const out = serializers.err(err);
        expect(out.code).toBe('ENOENT');
        expect(out.statusCode).toBe(404);
      });
    });
  });

  describe('REDACT_PATHS', () => {
    it('包含鉴权类敏感路径', () => {
      expect(REDACT_PATHS).toContain('req.headers.authorization');
      expect(REDACT_PATHS).toContain('req.headers.cookie');
    });

    it('包含密码 / token 类', () => {
      expect(REDACT_PATHS).toContain('req.body.password');
      expect(REDACT_PATHS).toContain('*.token');
      expect(REDACT_PATHS).toContain('*.refreshToken');
    });

    it('包含 PII 业务字段', () => {
      expect(REDACT_PATHS).toContain('*.phone');
      expect(REDACT_PATHS).toContain('*.mobile');
      expect(REDACT_PATHS).toContain('*.id_number');
      expect(REDACT_PATHS).toContain('*.wechat');
    });

    it('包含微信小程序专用字段', () => {
      expect(REDACT_PATHS).toContain('*.openid');
      expect(REDACT_PATHS).toContain('*.session_key');
    });

    it('包含加密字段（双重保险）', () => {
      expect(REDACT_PATHS).toContain('*.phone_encrypted');
    });
  });
});
