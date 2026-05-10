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

import { initSentry, shouldInitSentry } from './sentry.config';

if (shouldInitSentry()) {
  initSentry();
  // eslint-disable-next-line no-console
  console.log(`[Sentry] initialized (env=${process.env.NODE_ENV})`);
}
