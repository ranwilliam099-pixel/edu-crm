import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { RedisOptions } from 'ioredis';

/**
 * RedisService — 生产架构 P0 第 4 项
 *
 * 来源：用户 2026-05-10 「可上架生产架构」P0 第 4 项
 *
 * 用途：
 *   - session 缓存（5 min TTL）
 *   - KPI 缓存（30 sec TTL）
 *   - idempotency-key 写操作幂等（24h TTL）
 *   - rate limit token bucket
 *   - 分布式锁（FCFS 公海抢客 / 排课冲突）
 *   - BullMQ 队列后端
 *
 * 配置（按环境读 ENV）：
 *   REDIS_URL = redis://[:password@]host:port[/db]
 *     dev:  redis://localhost:6379
 *     prod: redis://localhost:6379（同机部署）
 *   REDIS_KEY_PREFIX = edu:（默认）
 *
 * 关键设计：
 *   - 全局 keyPrefix 防多服务串扰
 *   - lazyConnect：test 环境禁连，单测 mock
 *   - retryStrategy：网络断开指数退避，不无限重试占满 CPU
 *   - 分布式锁用 SET NX + Lua 脚本释放（防误删别人的锁）
 *   - onModuleDestroy 优雅 quit（PM2 reload 无停机）
 */

const RELEASE_LOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`.trim();

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client!: Redis;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const url = this.config.get<string>('REDIS_URL', 'redis://localhost:6379');
    const keyPrefix = this.config.get<string>('REDIS_KEY_PREFIX', 'edu:');
    const isTest = (process.env.NODE_ENV ?? '').toLowerCase() === 'test';

    const options: RedisOptions = {
      keyPrefix,
      lazyConnect: isTest, // test 环境不主动连
      maxRetriesPerRequest: 3,
      enableOfflineQueue: true,
      retryStrategy: (times) => {
        // 指数退避 50ms / 100ms / 200ms ... 上限 2s
        const delay = Math.min(50 * Math.pow(2, times), 2000);
        return delay;
      },
      reconnectOnError: (err) => {
        // READONLY 错（主从切换时）→ 重连
        return /READONLY/.test(err.message);
      },
    };

    this.client = new Redis(url, options);

    if (!isTest) {
      this.client.on('connect', () => this.logger.log(`Redis connected: ${url}`));
      this.client.on('error', (err) => this.logger.error(`Redis error: ${err.message}`));
      this.client.on('close', () => this.logger.warn('Redis connection closed'));
      this.client.on('reconnecting', () => this.logger.warn('Redis reconnecting'));
    }
  }

  async onModuleDestroy() {
    if (this.client && this.client.status !== 'end') {
      await this.client.quit();
      this.logger.log('Redis quit gracefully');
    }
  }

  /** 暴露原始 client（BullMQ 等需要直接传 Redis 实例时用）*/
  getClient(): Redis {
    return this.client;
  }

  // ============================================================
  // 基础 K/V
  // ============================================================

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSec?: number): Promise<void> {
    if (ttlSec && ttlSec > 0) {
      await this.client.set(key, value, 'EX', ttlSec);
    } else {
      await this.client.set(key, value);
    }
  }

  async setNX(key: string, value: string, ttlSec: number): Promise<boolean> {
    // SET key value NX EX ttl — 仅 key 不存在时设置 + TTL
    const ret = await this.client.set(key, value, 'EX', ttlSec, 'NX');
    return ret === 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return this.client.del(...keys);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.client.exists(key)) === 1;
  }

  async expire(key: string, ttlSec: number): Promise<boolean> {
    return (await this.client.expire(key, ttlSec)) === 1;
  }

  async ttl(key: string): Promise<number> {
    return this.client.ttl(key);
  }

  // ============================================================
  // 计数（限流 / FCFS 抢客 / 配额扣减）
  // ============================================================

  async incr(key: string): Promise<number> {
    return this.client.incr(key);
  }

  async incrBy(key: string, n: number): Promise<number> {
    return this.client.incrby(key, n);
  }

  async decr(key: string): Promise<number> {
    return this.client.decr(key);
  }

  // ============================================================
  // 分布式锁（FCFS 公海抢客 / 排课冲突 / 数据迁移单实例）
  // ============================================================

  /**
   * 加锁：成功返回 owner（用于解锁验证）；失败返回 null
   *
   * @param resource 资源 key（如 'pool:claim:cust_xxx'）
   * @param ttlSec 锁过期时间（防死锁）
   * @returns owner token（解锁时必传）或 null
   */
  async acquireLock(resource: string, ttlSec = 30): Promise<string | null> {
    const owner = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const ok = await this.setNX(`lock:${resource}`, owner, ttlSec);
    return ok ? owner : null;
  }

  /**
   * 解锁：仅持有 owner 才能解（防误删）
   * 用 Lua 脚本保证 GET + DEL 原子性
   *
   * @returns true=解锁成功 / false=锁已过期或被别人持有
   */
  async releaseLock(resource: string, owner: string): Promise<boolean> {
    const ret = (await this.client.eval(
      RELEASE_LOCK_LUA,
      1,
      `lock:${resource}`,
      owner,
    )) as number;
    return ret === 1;
  }

  // ============================================================
  // Hash（KPI cache / 多字段聚合）
  // ============================================================

  async hset(key: string, field: string, value: string): Promise<number> {
    return this.client.hset(key, field, value);
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.client.hget(key, field);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return this.client.hgetall(key);
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    if (fields.length === 0) return 0;
    return this.client.hdel(key, ...fields);
  }

  // ============================================================
  // 健康检查（/health/ready 用）
  // ============================================================

  async ping(): Promise<boolean> {
    try {
      const ret = await this.client.ping();
      return ret === 'PONG';
    } catch {
      return false;
    }
  }
}
