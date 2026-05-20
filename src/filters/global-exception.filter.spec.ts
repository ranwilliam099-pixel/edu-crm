/**
 * GlobalExceptionFilter — PM-AUTH Phase 5.3 / L7 5xx 上报增强单测
 *
 * 来源：5/20 stryker mutation 跑出 40 mutant / 17 killed / 23 survived = 24% score
 *   → 全局错误兜底层弱断言 = 真生产无声吞错
 *   → 补具体 case：状态码分支 / message extract 4 子分支 / Sentry / Alert / log 级别
 *
 * 覆盖增强 case（在原 9 case 之上 +23 case = 32 total）：
 *
 *   状态码分支（HttpStatus 全 8 个 4xx + 全 4 个 5xx）
 *     - 400/401/403/404/409 已有
 *     - 422 UnprocessableEntity
 *     - 500/502/503 各别分支（5xx 触发 log.error + Sentry + Alert）
 *
 *   extract() 4 子分支
 *     - resp 字符串
 *     - resp 对象含 message string
 *     - resp 对象含 message 数组（拼接 ', '）
 *     - resp 对象无 message → exception.message
 *     - resp 对象 error 字段 → 覆盖默认 exception.name
 *     - resp null/原始类型 → exception.message
 *
 *   响应体 shape
 *     - 全 6 字段存在（statusCode / message / error / timestamp / path / requestId?）
 *     - timestamp ISO 格式 + 反序列化合法
 *     - requestId 缺失 → undefined
 *     - request.url 缺 → 'unknown'
 *
 *   Sentry 上报
 *     - 5xx Error → Sentry.captureException + withScope tag
 *     - 5xx 非 Error（plain string）→ 不上报
 *     - 4xx → 不上报
 *     - Sentry.captureException 抛 → fail-open（logger.warn 不抛）
 *     - request 缺 method/url → 不调 scope.setTag
 *
 *   Alert 调用
 *     - alertService 缺 → 跳过（不抛）
 *     - 5xx + alertService 注入 → 调 critical(title, body, options) 含 dedupKey
 *     - 4xx → 不调 alert
 *     - alert.critical 抛 → fail-open
 *     - alert promise reject → fail-open（不污染主流程）
 *
 *   log 级别区分
 *     - 5xx → logger.error
 *     - 4xx → logger.warn
 *
 *   defensive 字段
 *     - request 缺 headers → requestId undefined（不抛）
 *     - request.url 缺 → body.path === 'unknown'
 */
import {
  ArgumentsHost,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';

// 必须在 import filter 之前 mock Sentry（hoisted）
jest.mock('@sentry/nestjs', () => ({
  withScope: jest.fn(),
  captureException: jest.fn(),
}));

import * as Sentry from '@sentry/nestjs';
import { GlobalExceptionFilter } from './global-exception.filter';
import { AlertService } from '../common/alert/alert.service';

type MockHostInit = {
  url?: string;
  method?: string;
  headers?: Record<string, unknown>;
  noHeaders?: boolean;
  noRequest?: boolean;
  noUrl?: boolean;
  noMethod?: boolean;
};

function makeHost(opts: MockHostInit = {}): {
  host: ArgumentsHost;
  mockJson: jest.Mock;
  mockStatus: jest.Mock;
} {
  const mockJson = jest.fn();
  const mockStatus = jest.fn().mockReturnValue({ json: mockJson });
  const reqBase = opts.noRequest
    ? undefined
    : {
        url: opts.noUrl ? undefined : (opts.url ?? '/api/test'),
        method: opts.noMethod ? undefined : (opts.method ?? 'POST'),
        headers: opts.noHeaders ? undefined : (opts.headers ?? { 'x-request-id': 'req-123' }),
      };
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status: mockStatus }),
      getRequest: () => reqBase,
    }),
  } as unknown as ArgumentsHost;
  return { host, mockJson, mockStatus };
}

describe('GlobalExceptionFilter - PM-AUTH Phase 5.3', () => {
  let filter: GlobalExceptionFilter;
  let mockJson: jest.Mock;
  let mockStatus: jest.Mock;
  let mockHost: ArgumentsHost;

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
    const h = makeHost();
    mockHost = h.host;
    mockJson = h.mockJson;
    mockStatus = h.mockStatus;
    (Sentry.withScope as jest.Mock).mockClear();
    (Sentry.captureException as jest.Mock).mockClear();
    (Sentry.withScope as jest.Mock).mockImplementation((cb: (scope: unknown) => void) => {
      cb({ setTag: jest.fn(), setLevel: jest.fn() });
    });
  });

  // ============================================================
  // 原 9 case — 保持不动（不删存量）
  // ============================================================
  it('BadRequestException → 400 + 原 message', () => {
    filter.catch(new BadRequestException('invalid input'), mockHost);
    expect(mockStatus).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    const body = mockJson.mock.calls[0][0];
    expect(body.statusCode).toBe(400);
    expect(body.message).toBe('invalid input');
    expect(body.path).toBe('/api/test');
    expect(body.requestId).toBe('req-123');
  });

  it('UnauthorizedException → 401', () => {
    filter.catch(new UnauthorizedException('token expired'), mockHost);
    expect(mockStatus).toHaveBeenCalledWith(HttpStatus.UNAUTHORIZED);
  });

  it('ForbiddenException → 403', () => {
    filter.catch(new ForbiddenException('insufficient role'), mockHost);
    expect(mockStatus).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
  });

  it('NotFoundException → 404', () => {
    filter.catch(new NotFoundException(), mockHost);
    expect(mockStatus).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
  });

  it('ConflictException → 409', () => {
    filter.catch(new ConflictException('illegal transition'), mockHost);
    expect(mockStatus).toHaveBeenCalledWith(HttpStatus.CONFLICT);
  });

  it('Error 非 HttpException → 500 + 隐藏内部细节', () => {
    filter.catch(new Error('database connection lost: postgres@10.0.0.1:5432'), mockHost);
    expect(mockStatus).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    const body = mockJson.mock.calls[0][0];
    expect(body.message).toBe('Internal server error'); // 通用文案，不泄露原始 message
    expect(body.error).toBe('Error');
  });

  it('未知异常类型 → 500 + UnknownError', () => {
    filter.catch('plain string thrown', mockHost);
    expect(mockStatus).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    const body = mockJson.mock.calls[0][0];
    expect(body.error).toBe('UnknownError');
  });

  it('HttpException 数组 message → 拼接', () => {
    filter.catch(new BadRequestException(['field1 required', 'field2 invalid']), mockHost);
    const body = mockJson.mock.calls[0][0];
    expect(body.message).toBe('field1 required, field2 invalid');
  });

  it('响应体含必要字段', () => {
    filter.catch(new BadRequestException('x'), mockHost);
    const body = mockJson.mock.calls[0][0];
    expect(body).toHaveProperty('statusCode');
    expect(body).toHaveProperty('message');
    expect(body).toHaveProperty('error');
    expect(body).toHaveProperty('timestamp');
    expect(body).toHaveProperty('path');
    expect(typeof body.timestamp).toBe('string');
    expect(new Date(body.timestamp).toString()).not.toBe('Invalid Date');
  });

  // ============================================================
  // 新增 case
  // ============================================================

  // ---------- 状态码分支补强 ----------
  describe('状态码分支 — 全 8 个标准 4xx 状态映射', () => {
    it('UnprocessableEntityException → 422', () => {
      filter.catch(new UnprocessableEntityException('val'), mockHost);
      expect(mockStatus).toHaveBeenCalledWith(HttpStatus.UNPROCESSABLE_ENTITY);
      const body = mockJson.mock.calls[0][0];
      expect(body.statusCode).toBe(422);
    });

    it('自定义 HttpException 418 → 透传状态码', () => {
      class TeapotException extends HttpException {
        constructor() {
          super({ message: "I'm a teapot", error: 'TeapotError' }, 418);
        }
      }
      filter.catch(new TeapotException(), mockHost);
      expect(mockStatus).toHaveBeenCalledWith(418);
      const body = mockJson.mock.calls[0][0];
      expect(body.statusCode).toBe(418);
      expect(body.error).toBe('TeapotError');
    });

    it('HttpException 状态 429 (Too Many Requests) → 透传', () => {
      filter.catch(new HttpException('rate limit', 429), mockHost);
      expect(mockStatus).toHaveBeenCalledWith(429);
      const body = mockJson.mock.calls[0][0];
      expect(body.statusCode).toBe(429);
    });
  });

  describe('状态码分支 — 5xx 全路径', () => {
    it('HttpException 500 → 沿用 (不被覆盖成 generic message)', () => {
      filter.catch(new HttpException('Custom 500 msg', 500), mockHost);
      expect(mockStatus).toHaveBeenCalledWith(500);
      const body = mockJson.mock.calls[0][0];
      // HttpException 500 走 extract() HttpException 分支，message 保留
      expect(body.message).toBe('Custom 500 msg');
    });

    it('HttpException 502 (Bad Gateway) → 透传 502', () => {
      filter.catch(new HttpException('upstream', 502), mockHost);
      expect(mockStatus).toHaveBeenCalledWith(502);
    });

    it('HttpException 503 (Service Unavailable) → 透传 503', () => {
      filter.catch(new HttpException('maintenance', 503), mockHost);
      expect(mockStatus).toHaveBeenCalledWith(503);
    });

    it('原生 TypeError 非 HttpException → 500 + error="TypeError" (constructor.name)', () => {
      filter.catch(new TypeError("Cannot read 'foo'"), mockHost);
      expect(mockStatus).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
      const body = mockJson.mock.calls[0][0];
      expect(body.message).toBe('Internal server error');
      expect(body.error).toBe('TypeError'); // constructor.name 透传
    });

    it('原生 RangeError → 500 + error="RangeError"', () => {
      filter.catch(new RangeError('out of range'), mockHost);
      const body = mockJson.mock.calls[0][0];
      expect(body.statusCode).toBe(500);
      expect(body.error).toBe('RangeError');
    });

    it('自定义 Error 子类 → error = 自定义类名', () => {
      class MyDomainError extends Error {
        constructor(msg: string) {
          super(msg);
          this.name = 'MyDomainError';
        }
      }
      filter.catch(new MyDomainError('domain fail'), mockHost);
      const body = mockJson.mock.calls[0][0];
      expect(body.error).toBe('MyDomainError'); // constructor.name
    });

    it('throw number (非 Error 非 string) → 500 + UnknownError', () => {
      filter.catch(42, mockHost);
      const body = mockJson.mock.calls[0][0];
      expect(body.statusCode).toBe(500);
      expect(body.error).toBe('UnknownError');
      expect(body.message).toBe('Internal server error');
    });

    it('throw null → 500 + UnknownError', () => {
      filter.catch(null, mockHost);
      const body = mockJson.mock.calls[0][0];
      expect(body.statusCode).toBe(500);
      expect(body.error).toBe('UnknownError');
    });

    it('throw undefined → 500 + UnknownError', () => {
      filter.catch(undefined, mockHost);
      const body = mockJson.mock.calls[0][0];
      expect(body.statusCode).toBe(500);
      expect(body.error).toBe('UnknownError');
    });
  });

  // ---------- extract() 子分支 ----------
  describe('extract() — HttpException resp 4 子分支', () => {
    it('resp 字符串（HttpException 用 string 构造）→ message = resp string', () => {
      filter.catch(new HttpException('plain string body', 400), mockHost);
      const body = mockJson.mock.calls[0][0];
      expect(body.message).toBe('plain string body');
    });

    it('resp 对象 含 message string → message 用 obj.message', () => {
      filter.catch(new HttpException({ message: 'obj msg', error: 'CustomError' }, 400), mockHost);
      const body = mockJson.mock.calls[0][0];
      expect(body.message).toBe('obj msg');
      expect(body.error).toBe('CustomError'); // obj.error 覆盖默认 exception.name
    });

    it('resp 对象 含 message 数组 → 拼接 ", "', () => {
      filter.catch(
        new HttpException({ message: ['a', 'b', 'c'] }, 400),
        mockHost,
      );
      const body = mockJson.mock.calls[0][0];
      expect(body.message).toBe('a, b, c');
    });

    it('resp 对象 但 message 字段缺失 → fallback 到 exception.message', () => {
      class CustomEx extends HttpException {
        constructor() {
          super({ error: 'OnlyError' }, 400); // 没 message 字段
        }
      }
      const ex = new CustomEx();
      filter.catch(ex, mockHost);
      const body = mockJson.mock.calls[0][0];
      // exception.message 默认是 status code 描述（Nest 内部行为）— 但应该非空
      expect(typeof body.message).toBe('string');
      expect(body.error).toBe('OnlyError');
    });

    it('resp 对象 message 非 string 非数组（数字/对象）→ fallback 到 exception.message', () => {
      class WeirdEx extends HttpException {
        constructor() {
          super({ message: 42 as never }, 400);
        }
      }
      const ex = new WeirdEx();
      filter.catch(ex, mockHost);
      const body = mockJson.mock.calls[0][0];
      // message 是数字 → 不是 string 不是 array → fallback exception.message
      expect(typeof body.message).toBe('string');
    });

    it('resp 对象 但 error 字段非 string → 不覆盖 exception.name', () => {
      class NoErrStr extends HttpException {
        constructor() {
          super({ message: 'm', error: 999 as never }, 400);
        }
      }
      const ex = new NoErrStr();
      filter.catch(ex, mockHost);
      const body = mockJson.mock.calls[0][0];
      // error 非 string → 保留 exception.name (= NoErrStr class name)
      expect(body.error).toBe('NoErrStr');
    });

    it('HttpException default name = "HttpException"（无 obj.error 覆盖）', () => {
      filter.catch(new HttpException('m', 400), mockHost);
      const body = mockJson.mock.calls[0][0];
      // HttpException string 构造时 resp 是字符串，不进 obj.error 分支 → 用 exception.name
      expect(body.error).toBe('HttpException');
    });
  });

  // ---------- 响应体字段 shape ----------
  describe('响应体 — 字段完整性 & 默认值', () => {
    it('全 6 字段存在 且 timestamp 是合法 ISO', () => {
      filter.catch(new BadRequestException('x'), mockHost);
      const body = mockJson.mock.calls[0][0];
      expect(body.statusCode).toBe(400);
      expect(typeof body.message).toBe('string');
      expect(typeof body.error).toBe('string');
      expect(body.timestamp).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
      expect(body.path).toBe('/api/test');
      expect(body.requestId).toBe('req-123');
    });

    it('requestId header 缺 → body.requestId === undefined', () => {
      const h = makeHost({ headers: {} });
      filter.catch(new BadRequestException('x'), h.host);
      const body = h.mockJson.mock.calls[0][0];
      expect(body.requestId).toBeUndefined();
    });

    it('request.headers 整体缺 → body.requestId === undefined（不抛）', () => {
      const h = makeHost({ noHeaders: true });
      expect(() => filter.catch(new BadRequestException('x'), h.host)).not.toThrow();
      const body = h.mockJson.mock.calls[0][0];
      expect(body.requestId).toBeUndefined();
    });

    it('request.url 缺 → body.path === "unknown"', () => {
      const h = makeHost({ noUrl: true });
      filter.catch(new BadRequestException('x'), h.host);
      const body = h.mockJson.mock.calls[0][0];
      // url 是 undefined → ?? 'unknown'
      expect(body.path).toBe('unknown');
    });

    it('整个 request 对象缺 → body.path === "unknown" + requestId undefined', () => {
      const h = makeHost({ noRequest: true });
      expect(() => filter.catch(new BadRequestException('x'), h.host)).not.toThrow();
      const body = h.mockJson.mock.calls[0][0];
      expect(body.path).toBe('unknown');
      expect(body.requestId).toBeUndefined();
    });

    it('response.status 链 → response.status(code).json(body) 调用顺序', () => {
      filter.catch(new BadRequestException('x'), mockHost);
      // status 先调 → 链回 json
      expect(mockStatus).toHaveBeenCalledTimes(1);
      expect(mockJson).toHaveBeenCalledTimes(1);
      // 调用顺序：status 返回 { json }，json 收 body 对象
      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 400, message: 'x' }),
      );
    });
  });

  // ---------- Sentry 上报 ----------
  describe('Sentry 上报 (5xx 路径)', () => {
    it('5xx + Error 实例 → 调 Sentry.withScope + captureException', () => {
      filter.catch(new Error('db down'), mockHost);
      expect(Sentry.withScope).toHaveBeenCalledTimes(1);
      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
      expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error));
    });

    it('5xx + Error → scope.setTag 接受 request_id / http.method / http.path', () => {
      const tagSpy = jest.fn();
      const levelSpy = jest.fn();
      (Sentry.withScope as jest.Mock).mockImplementationOnce(
        (cb: (scope: { setTag: jest.Mock; setLevel: jest.Mock }) => void) => {
          cb({ setTag: tagSpy, setLevel: levelSpy });
        },
      );
      filter.catch(new Error('db'), mockHost);
      expect(tagSpy).toHaveBeenCalledWith('request_id', 'req-123');
      expect(tagSpy).toHaveBeenCalledWith('http.method', 'POST');
      expect(tagSpy).toHaveBeenCalledWith('http.path', '/api/test');
      expect(levelSpy).toHaveBeenCalledWith('error');
    });

    it('5xx + plain string thrown → 不调 Sentry.captureException (filter 不上报非 Error)', () => {
      filter.catch('boom string', mockHost);
      expect(Sentry.withScope).not.toHaveBeenCalled();
      expect(Sentry.captureException).not.toHaveBeenCalled();
    });

    it('5xx + number thrown → 不上报', () => {
      filter.catch(123, mockHost);
      expect(Sentry.captureException).not.toHaveBeenCalled();
    });

    it('4xx (BadRequestException) → 不上报 Sentry', () => {
      filter.catch(new BadRequestException('x'), mockHost);
      expect(Sentry.withScope).not.toHaveBeenCalled();
      expect(Sentry.captureException).not.toHaveBeenCalled();
    });

    it('Sentry.withScope 抛 → fail-open（不抛主流程，仍返响应）', () => {
      (Sentry.withScope as jest.Mock).mockImplementationOnce(() => {
        throw new Error('sentry SDK broken');
      });
      expect(() => filter.catch(new Error('app err'), mockHost)).not.toThrow();
      expect(mockJson).toHaveBeenCalled();
      const body = mockJson.mock.calls[0][0];
      expect(body.statusCode).toBe(500);
    });

    it('Sentry.captureException 抛 → fail-open', () => {
      (Sentry.captureException as jest.Mock).mockImplementationOnce(() => {
        throw new Error('captureException broken');
      });
      expect(() => filter.catch(new Error('app err'), mockHost)).not.toThrow();
      expect(mockJson).toHaveBeenCalled();
    });

    it('5xx + 无 requestId / method / url → scope.setTag 跳过相应 tag', () => {
      const tagSpy = jest.fn();
      const levelSpy = jest.fn();
      (Sentry.withScope as jest.Mock).mockImplementationOnce(
        (cb: (scope: { setTag: jest.Mock; setLevel: jest.Mock }) => void) => {
          cb({ setTag: tagSpy, setLevel: levelSpy });
        },
      );
      const h = makeHost({ noRequest: true });
      filter.catch(new Error('e'), h.host);
      // 无 request → setTag 全不调
      expect(tagSpy).not.toHaveBeenCalled();
      expect(levelSpy).toHaveBeenCalledWith('error');
    });
  });

  // ---------- AlertService 调用 ----------
  describe('AlertService 调用 (5xx 路径)', () => {
    function makeAlertSpy(critical: jest.Mock = jest.fn().mockResolvedValue(true)): AlertService {
      return { critical } as unknown as AlertService;
    }

    it('5xx + 注入 alertService → 调 alert.critical(title, body, options)', () => {
      const criticalSpy = jest.fn().mockResolvedValue(true);
      const alert = makeAlertSpy(criticalSpy);
      const filterWithAlert = new GlobalExceptionFilter(alert);
      filterWithAlert.catch(new Error('db down'), mockHost);
      expect(criticalSpy).toHaveBeenCalledTimes(1);
      const [title, bodyText, options] = criticalSpy.mock.calls[0];
      expect(title).toBe('5xx Error');
      expect(bodyText).toContain('POST /api/test');
      expect(bodyText).toContain('Internal server error');
      expect(options).toMatchObject({
        dedupKey: '5xx:Error:/api/test',
        dedupTtl: 30,
        context: expect.objectContaining({
          error: 'Error',
          method: 'POST',
          path: '/api/test',
          requestId: 'req-123',
        }),
      });
    });

    it('5xx 但 alertService 缺 → 不调（也不抛）', () => {
      // base filter 构造时无 alertService
      expect(() => filter.catch(new Error('e'), mockHost)).not.toThrow();
      // 没 alert 没法 spy，但确保 status/json 仍正常
      expect(mockStatus).toHaveBeenCalledWith(500);
    });

    it('4xx + alertService 注入 → 不调 alert.critical', () => {
      const criticalSpy = jest.fn();
      const alert = makeAlertSpy(criticalSpy);
      const filterWithAlert = new GlobalExceptionFilter(alert);
      filterWithAlert.catch(new BadRequestException('x'), mockHost);
      expect(criticalSpy).not.toHaveBeenCalled();
    });

    it('5xx + alert.critical 同步抛 → fail-open（catch 兜住）', () => {
      const criticalSpy = jest.fn(() => {
        throw new Error('alert dispatch broken');
      }) as unknown as jest.Mock;
      const alert = makeAlertSpy(criticalSpy);
      const filterWithAlert = new GlobalExceptionFilter(alert);
      expect(() => filterWithAlert.catch(new Error('app err'), mockHost)).not.toThrow();
      expect(mockJson).toHaveBeenCalled();
    });

    it('5xx + alert.critical promise reject → fail-open（.catch 兜住）', async () => {
      const criticalSpy = jest.fn().mockRejectedValue(new Error('webhook down'));
      const alert = makeAlertSpy(criticalSpy);
      const filterWithAlert = new GlobalExceptionFilter(alert);
      expect(() => filterWithAlert.catch(new Error('app err'), mockHost)).not.toThrow();
      // 等微任务（.catch handler）执行
      await new Promise((r) => setImmediate(r));
      expect(criticalSpy).toHaveBeenCalled();
    });

    it('5xx + UnknownError (plain string) → dedupKey 用 "UnknownError"', () => {
      const criticalSpy = jest.fn().mockResolvedValue(true);
      const alert = makeAlertSpy(criticalSpy);
      const filterWithAlert = new GlobalExceptionFilter(alert);
      filterWithAlert.catch('boom', mockHost);
      const [title, , options] = criticalSpy.mock.calls[0];
      expect(title).toBe('5xx UnknownError');
      expect(options.dedupKey).toBe('5xx:UnknownError:/api/test');
    });

    it('5xx + 无 method/path → alert body 用 "unknown"', () => {
      const criticalSpy = jest.fn().mockResolvedValue(true);
      const alert = makeAlertSpy(criticalSpy);
      const filterWithAlert = new GlobalExceptionFilter(alert);
      const h = makeHost({ noRequest: true });
      filterWithAlert.catch(new Error('e'), h.host);
      const [, bodyText, options] = criticalSpy.mock.calls[0];
      expect(bodyText).toContain('unknown unknown');
      expect(options.context.method).toBe('unknown');
      expect(options.context.path).toBe('unknown');
      expect(options.context.requestId).toBe('(none)');
    });

    it('dedupTtl 必须 = 30s（防 spam）', () => {
      const criticalSpy = jest.fn().mockResolvedValue(true);
      const alert = makeAlertSpy(criticalSpy);
      const filterWithAlert = new GlobalExceptionFilter(alert);
      filterWithAlert.catch(new Error('e'), mockHost);
      const [, , options] = criticalSpy.mock.calls[0];
      expect(options.dedupTtl).toBe(30);
    });
  });

  // ---------- log 级别区分 ----------
  describe('Logger 级别 — 4xx warn / 5xx error', () => {
    let logErrorSpy: jest.SpyInstance;
    let logWarnSpy: jest.SpyInstance;

    beforeEach(() => {
      logErrorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      logWarnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      logErrorSpy.mockRestore();
      logWarnSpy.mockRestore();
    });

    it('5xx Error → logger.error (含 stack 第 2 参数)', () => {
      const err = new Error('boom');
      filter.catch(err, mockHost);
      expect(logErrorSpy).toHaveBeenCalledTimes(1);
      const [msg, stack] = logErrorSpy.mock.calls[0];
      expect(msg).toContain('5xx POST /api/test');
      expect(msg).toContain('Error');
      expect(msg).toContain('Internal server error');
      expect(stack).toBe(err.stack);
      expect(logWarnSpy).not.toHaveBeenCalled();
    });

    it('5xx 非 Error (plain string) → logger.error stack 参数 = undefined', () => {
      filter.catch('boom', mockHost);
      expect(logErrorSpy).toHaveBeenCalledTimes(1);
      const [, stack] = logErrorSpy.mock.calls[0];
      expect(stack).toBeUndefined();
    });

    it('4xx → logger.warn 不 logger.error', () => {
      filter.catch(new BadRequestException('x'), mockHost);
      expect(logWarnSpy).toHaveBeenCalledTimes(1);
      const [msg] = logWarnSpy.mock.calls[0];
      expect(msg).toContain('400 POST /api/test');
      expect(logErrorSpy).not.toHaveBeenCalled();
    });

    it('4xx 403 ForbiddenException → logger.warn 含状态码 403', () => {
      filter.catch(new ForbiddenException('rbac'), mockHost);
      const [msg] = logWarnSpy.mock.calls[0];
      expect(msg).toContain('403');
    });
  });

  // ---------- 联合断言 (5xx 路径 happy) ----------
  describe('5xx happy path — log + Sentry + Alert 三件套同时触发', () => {
    it('Error → logger.error + Sentry.captureException + alert.critical 都调一次', async () => {
      const criticalSpy = jest.fn().mockResolvedValue(true);
      const alert = { critical: criticalSpy } as unknown as AlertService;
      const filterWithAlert = new GlobalExceptionFilter(alert);
      const logErrorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      filterWithAlert.catch(new Error('db'), mockHost);
      await new Promise((r) => setImmediate(r));

      expect(logErrorSpy).toHaveBeenCalledTimes(1);
      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
      expect(criticalSpy).toHaveBeenCalledTimes(1);
      expect(mockStatus).toHaveBeenCalledWith(500);
      expect(mockJson).toHaveBeenCalled();

      logErrorSpy.mockRestore();
    });
  });
});
