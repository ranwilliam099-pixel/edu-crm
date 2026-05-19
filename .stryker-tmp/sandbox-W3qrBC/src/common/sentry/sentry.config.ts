import * as Sentry from '@sentry/nestjs';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

/**
 * Sentry 初始化（生产架构 P0 第 6 项）
 *
 * 来源：用户 2026-05-10 「可上架生产架构」P0 第 6 项
 *
 * 行为策略：
 *   - 没 SENTRY_DSN → 不 init（dev / 早期运行不强依赖）
 *   - NODE_ENV=test → 不 init（不污染单测）
 *   - production → 采样 10%（控成本）+ profiling 10%
 *   - development → 全采样（方便调试）
 *
 * PII 脱敏（与 pino logger redact 一致策略）：
 *   beforeSend 钩子里删 cookie / authorization / 敏感 body 字段
 */

export function shouldInitSentry(
  env: string | undefined = process.env.NODE_ENV,
  dsn: string | undefined = process.env.SENTRY_DSN,
): boolean {
  if (!dsn || dsn.trim() === '') return false;
  const e = (env ?? '').toLowerCase();
  if (e === 'test') return false;
  return true;
}

export interface SentryInitOptions {
  dsn?: string;
  environment?: string;
  release?: string;
}

export function makeSentryOptions(opts: SentryInitOptions = {}): Sentry.NodeOptions {
  const env = opts.environment ?? process.env.NODE_ENV ?? 'development';
  const dsn = opts.dsn ?? process.env.SENTRY_DSN;
  const release = opts.release ?? process.env.SENTRY_RELEASE ?? undefined;
  const isProd = env === 'production' || env === 'prod';

  return {
    dsn,
    environment: env,
    release,
    // 采样率：prod 10% / dev 100%
    tracesSampleRate: isProd ? 0.1 : 1.0,
    profilesSampleRate: isProd ? 0.1 : 1.0,
    // 集成
    integrations: [nodeProfilingIntegration()],
    // PII 脱敏
    sendDefaultPii: false,
    beforeSend(event) {
      // 1. 请求头 redact
      if (event.request?.headers) {
        const headers = event.request.headers as Record<string, string>;
        for (const k of Object.keys(headers)) {
          const lk = k.toLowerCase();
          if (
            lk === 'cookie' ||
            lk === 'authorization' ||
            lk === 'set-cookie' ||
            lk === 'x-tenant-schema'
          ) {
            headers[k] = '[REDACTED]';
          }
        }
      }
      // 2. body 敏感字段 redact
      if (event.request?.data && typeof event.request.data === 'object') {
        scrubObject(event.request.data as Record<string, unknown>);
      }
      // 3. extra / context 也 scrub
      if (event.extra) scrubObject(event.extra);
      if (event.contexts) {
        for (const k of Object.keys(event.contexts)) {
          if (typeof event.contexts[k] === 'object' && event.contexts[k]) {
            scrubObject(event.contexts[k] as Record<string, unknown>);
          }
        }
      }
      return event;
    },
    // 错误过滤：忽略一些已知噪音
    ignoreErrors: [
      // 客户端断开连接
      'aborted',
      'ECONNRESET',
      'EPIPE',
      // 健康检查
      /\/health/,
    ],
  };
}

const SENSITIVE_KEYS = new Set([
  'password',
  'passwordconfirm',
  'oldpassword',
  'newpassword',
  'token',
  'accesstoken',
  'refreshtoken',
  'access_token',
  'refresh_token',
  'cookie',
  'authorization',
  'phone',
  'mobile',
  'id_number',
  'idnumber',
  'id_card',
  'idcard',
  'wechat',
  'openid',
  'unionid',
  'session_key',
  'sessionkey',
  'apikey',
  'api_key',
  'secret',
]);

function scrubObject(obj: Record<string, unknown>, depth = 0): void {
  if (depth > 5 || !obj) return;
  for (const k of Object.keys(obj)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      obj[k] = '[REDACTED]';
    } else if (typeof obj[k] === 'object' && obj[k] !== null) {
      scrubObject(obj[k] as Record<string, unknown>, depth + 1);
    }
  }
}

/**
 * 真正执行 Sentry.init（注意：必须在 NestJS createApplicationContext 之前调用）
 *
 * 用法：在 instrument.ts 顶部调用
 *   import { initSentry, shouldInitSentry } from './sentry.config';
 *   if (shouldInitSentry()) initSentry();
 */
export function initSentry(opts: SentryInitOptions = {}): void {
  Sentry.init(makeSentryOptions(opts));
}

// 导出 scrubObject 供测试
export const __test__ = { scrubObject, SENSITIVE_KEYS };
