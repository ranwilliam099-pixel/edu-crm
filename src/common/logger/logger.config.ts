import { randomUUID } from 'crypto';
import type { Params } from 'nestjs-pino';
import { REDACT_PATHS } from './redact-paths';

/**
 * makePinoOptions — 按环境构造 pino 配置
 *
 * 来源：用户 2026-05-10 「可上架生产架构」P0 第 3 项
 *
 * 环境策略：
 *   - production : JSON 格式 → stdout（pm2-logrotate 接管轮转）/ level=info
 *   - development: pino-pretty 彩色 / level=debug
 *   - test       : silent（不污染测试输出）
 *
 * 自动能力：
 *   1. 链路追踪 — 每请求生成 X-Request-Id（如 req 已带，复用）
 *   2. PII 脱敏 — REDACT_PATHS 自动 [REDACTED]
 *   3. 自动请求日志 — pino-http 自动记录每个 req/res
 *   4. 错误日志 — Error 对象自动序列化（含 stack）
 *
 * 性能：
 *   pino 是 Node 最快的 JSON logger（~5x winston），生产无压力
 */

export type Env = 'production' | 'development' | 'test';

export function detectEnv(): Env {
  const e = (process.env.NODE_ENV ?? 'development').toLowerCase();
  if (e === 'production' || e === 'prod') return 'production';
  if (e === 'test') return 'test';
  return 'development';
}

export function detectLevel(env: Env): string {
  if (env === 'test') return 'silent';
  return process.env.LOG_LEVEL ?? (env === 'production' ? 'info' : 'debug');
}

export function makePinoOptions(envOverride?: Env): Params {
  const env = envOverride ?? detectEnv();
  const level = detectLevel(env);

  const pinoHttp: Record<string, unknown> = {
    level,

    // 链路追踪：复用上游 X-Request-Id 或自生成
    genReqId: (req: { headers?: Record<string, string | string[] | undefined> }) => {
      const existing = req.headers?.['x-request-id'];
      if (typeof existing === 'string' && existing.length > 0) return existing;
      if (Array.isArray(existing) && existing.length > 0) return existing[0];
      return randomUUID();
    },

    // 自定义请求级 props（注入到每条日志）
    customProps: () => ({ env }),

    // PII 脱敏
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
      remove: false,
    },

    // 自动错误序列化（含 stack）
    serializers: {
      err: (err: Error & { code?: string; statusCode?: number }) => ({
        type: err.constructor.name,
        message: err.message,
        stack: err.stack,
        code: err.code,
        statusCode: err.statusCode,
      }),
    },

    // 屏蔽健康检查日志（避免刷屏）
    autoLogging: {
      ignore: (req: { url?: string }) => {
        const url = req.url ?? '';
        return (
          url.startsWith('/api/public/health') ||
          url.startsWith('/health') ||
          url === '/favicon.ico'
        );
      },
    },
  };

  // dev 环境：pino-pretty 彩色输出
  if (env === 'development') {
    pinoHttp.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        singleLine: false,
        ignore: 'pid,hostname',
      },
    };
  }

  // prod 环境：默认 stdout JSON（pm2-logrotate 接管）
  // test 环境：level=silent 不输出

  return { pinoHttp };
}
