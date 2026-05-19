import { Global, Module } from '@nestjs/common';
import { SentryModule as RootSentryModule } from '@sentry/nestjs/setup';

/**
 * SentryModule — 全局 Sentry 集成（生产架构 P0 第 6 项）
 *
 * @sentry/nestjs/setup 提供的 SentryModule.forRoot() 自动：
 *   - hook NestJS 全局异常 → 上报到 Sentry
 *   - hook controller / interceptor / guard 性能 trace
 *   - 注入 Sentry context（含 X-Request-Id 链路追踪）
 *
 * 配合 instrument.ts（必须 main.ts 第 1 行 import）即可生效。
 *
 * DSN 缺失时：
 *   - instrument.ts 不执行 Sentry.init
 *   - SentryModule.forRoot() 仍可注册（无 init 的 SDK 是 noop）
 *   - 上报无害失败（fail-open）
 */
@Global()
@Module({
  imports: [RootSentryModule.forRoot()],
})
export class SentryModule {}
