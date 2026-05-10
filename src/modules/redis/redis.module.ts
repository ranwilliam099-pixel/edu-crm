import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RedisService } from './redis.service';

/**
 * RedisModule — 全局 Redis（生产架构 P0 第 4 项）
 *
 * 全局注入：
 *   constructor(private readonly redis: RedisService) {}
 *
 * 用途：
 *   - session / KPI cache
 *   - idempotency-key 中间件
 *   - rate limit
 *   - 分布式锁（FCFS / 排课冲突）
 *   - BullMQ 队列后端
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
