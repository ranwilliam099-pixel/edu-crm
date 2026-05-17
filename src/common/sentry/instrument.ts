/**
 * Sentry instrument — 必须在所有 NestJS 代码之前 import
 *
 * 用法：src/main.ts 第 1 行
 *   import './common/sentry/instrument';
 *
 * 行为：
 *   - 有 SENTRY_DSN 且非 test 环境 → init Sentry（自动捕获 unhandled / 性能 profile）
 *   - 否则 → 静默跳过（不报错，不影响运行）
 *
 * 设计意图：
 *   把 init 副作用隔离到这个模块，main.ts 只 import 一行干净
 */

import { Logger } from '@nestjs/common';
import { initSentry, shouldInitSentry } from './sentry.config';

if (shouldInitSentry()) {
  initSentry();
  // T-DEADCODE-CLEANUP P1-4 (2026-05-17): console.log → NestJS Logger（HARD_RULES §3 0 console.log）
  // Logger 在 NestApplication.bootstrap 前可用（@nestjs/common 静态实例 OK）
  new Logger('SentryInstrument').log(`[Sentry] initialized (env=${process.env.NODE_ENV})`);
}
