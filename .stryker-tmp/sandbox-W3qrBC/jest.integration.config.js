/**
 * jest.integration.config.js — Day 2 Phase B.L2 integration test 独立 Jest 配置
 *
 * 与 package.json#jest（单测 mock PG）严格分离：
 *   - testRegex 改 *.integration.spec.ts（与 src/**/*.spec.ts 单测不冲突）
 *   - rootDir = . （不在 src 下，避免与单测共用 testRegex）
 *   - testTimeout 30s（docker startup + migrations 跑全 28 个 tenant + 5s buffer）
 *   - maxWorkers = 1（PG pool 5 connections + 各 spec 自建 schema，避免连接饥饿）
 *
 * 使用：
 *   docker-compose -f docker-compose.test.yml up -d
 *   pnpm jest --config jest.integration.config.js
 *   docker-compose -f docker-compose.test.yml down
 *
 * 注入环境：
 *   - jest.setup.ts 自动注 ENCRYPTION_KEY / HASH_KEY（与单测同 32B 全 0 / 全 4 key）
 *   - PG_TEST_HOST/PORT / REDIS_TEST_HOST/PORT 可 env 覆盖（CI 用）
 */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: 'test/integration/.*\\.integration\\.spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  setupFiles: ['<rootDir>/jest.setup.ts'],
  // 30s — 含 docker 拉起 + 28 migration + 5s buffer；单测 timeout 5s 不变
  testTimeout: 30000,
  // 单 worker — 避免多 spec 并发抢 PG 连接 + schema 名冲突（虽然 random 后缀）
  // 后续 spec 加 globalSetup 后可放宽（每个 worker 自己的 connection pool）
  maxWorkers: 1,
  // 缺 docker-compose 时早期失败（不要等 30s timeout）
  bail: false,
  // 详细输出方便诊断 schema drift 反例
  verbose: true,
};
