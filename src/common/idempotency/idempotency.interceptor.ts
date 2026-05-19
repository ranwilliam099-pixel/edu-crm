import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';
import { RedisService } from '../../modules/redis/redis.service';

/**
 * IdempotencyInterceptor — 写操作幂等保护（生产架构 P0 第 5 项）
 *
 * 来源：用户 2026-05-10 「可上架生产架构」P0 第 5 项
 *
 * 用途：
 *   防止重复扣款 / 重复签约 / 重复提交（网络抖动用户重发 / 浏览器双击 / 客户端重试）
 *
 * 工作原理：
 *   1. 客户端写请求带 `Idempotency-Key: <唯一字符串>` 头（推荐 UUID v4）
 *   2. 服务端按 user.id + key 查 Redis
 *   3. 命中 → 直接返回缓存的 response（status + body）
 *   4. 未命中 → 放行业务 → 后置缓存 2xx 响应 24h
 *
 * 范围：
 *   仅拦 POST / PUT / PATCH / DELETE；GET/HEAD/OPTIONS 跳过
 *
 * 不强制：
 *   没带 Idempotency-Key 直接放行（兼容旧客户端 + 安全 GET 等不需要的场景）
 *   写操作建议带，但不强制 → 兼容性优先
 *
 * 关键设计：
 *   - 跨用户隔离：cache key = `idem:{userId}:{idempotency-key}`
 *   - 仅缓存成功响应（2xx）→ 5xx 不缓存（让客户端自然重试）
 *   - key 格式校验：32-128 字符 + alphanumeric/_- 防注入
 *   - TTL 24h（够覆盖客户端常规重试窗口）
 */

const VALID_KEY = /^[a-zA-Z0-9_-]{8,128}$/;
const SKIP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const TTL_SECONDS = 86400; // 24h

/**
 * P1-5 round 2 加强（2026-05-19）：
 *   Redis 错误 message 可能含 redis://user:password@host:port 形态
 *   （ioredis URL 解析失败 / 连接失败时把完整 URL 回显到 error.message）
 *   日志输出前必须先 sanitize 防 password 泄漏到 pino 日志 / Sentry。
 *
 *   覆盖通用 URL 模式：scheme://[user:]pass@host
 *     - redis://user:password@host → redis://***@host
 *     - rediss://user:password@host:6380 → rediss://***@host:6380
 *     - redis://:password@host → redis://***@host
 *
 *   不依赖具体错误类（兼容 ioredis ReplyError / 标准 Error / Object）。
 */
export function sanitizeRedisError(err: unknown): string {
  let msg: string;
  if (err instanceof Error) {
    msg = err.message;
  } else if (typeof err === 'string') {
    msg = err;
  } else if (err && typeof err === 'object' && 'message' in err) {
    msg = String((err as { message: unknown }).message);
  } else {
    msg = 'unknown error';
  }
  // 主防御：redis(s)?:// + 任意非 @ 字符 + @ → 替换为 *** 占位
  // 同时覆盖 [user:]password 双段形态
  return msg.replace(/(rediss?:\/\/)[^@\s]+@/gi, '$1***@');
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(private readonly redis: RedisService) {}

  async intercept(ctx: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = ctx.switchToHttp().getRequest<{
      method: string;
      headers: Record<string, string | string[] | undefined>;
      user?: { id?: string };
    }>();

    if (SKIP_METHODS.has(req.method.toUpperCase())) {
      return next.handle();
    }

    const rawKey = req.headers['idempotency-key'] ?? req.headers['Idempotency-Key'];
    const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    if (!key) {
      // 不强制带 idempotency-key
      return next.handle();
    }

    if (!VALID_KEY.test(key)) {
      throw new BadRequestException(
        'Invalid Idempotency-Key (must be 8-128 alphanumeric/_/- chars)',
      );
    }

    const userId = req.user?.id ?? 'anon';
    const fullKey = `idem:${userId}:${key}`;

    // 查缓存
    const cached = await this.safeGet(fullKey);
    if (cached) {
      this.logger.debug(`idem hit: ${fullKey}`);
      const res = ctx.switchToHttp().getResponse<{ status: (n: number) => unknown }>();
      res.status(cached.status);
      return of(cached.body);
    }

    // 未命中 → 放行 + 后置缓存
    return next.handle().pipe(
      tap(async (body) => {
        const res = ctx.switchToHttp().getResponse<{ statusCode: number }>();
        const status = res.statusCode ?? 200;
        // 仅缓存 2xx
        if (status >= 200 && status < 300) {
          await this.safeSet(fullKey, { status, body });
        }
      }),
    );
  }

  // ============================================================
  // 内部：Redis 失败不影响主业务（容灾）
  // ============================================================

  private async safeGet(key: string): Promise<{ status: number; body: unknown } | null> {
    try {
      const raw = await this.redis.get(key);
      if (!raw) return null;
      return JSON.parse(raw) as { status: number; body: unknown };
    } catch (err) {
      // P1-5 round 2: sanitize 防 password 泄漏（错误 message 可能含 redis://user:pass@host）
      this.logger.warn(`idem safeGet failed (fail-open): ${sanitizeRedisError(err)}`);
      return null;
    }
  }

  private async safeSet(key: string, value: { status: number; body: unknown }): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), TTL_SECONDS);
    } catch (err) {
      // P1-5 round 2: sanitize 防 password 泄漏
      this.logger.warn(`idem safeSet failed (fail-open): ${sanitizeRedisError(err)}`);
    }
  }
}
