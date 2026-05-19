/**
 * Stryker.js Mutation Testing 配置
 *
 * 来源：Day 2 Phase B.L1 (2026-05-19) — 严谨测试方案 v2.0 §8.2
 *       桌面 `~/Desktop/2026-05-19-严谨测试方案-v2.0.md`
 *
 * 目的：mutation testing 是测试质量的「上帝视角」—
 *      改业务代码（删 if 分支 / 改运算符 / 把 return true → false 等），
 *      跑现有单测，看断言能否抓出（killed）。score = killed / total mutations
 *
 * 三阶段阈值（v2.0 §8.2）：
 *   Phase 1 (起点)：break 40 / low 60 / high 80
 *   Phase 2 (1 个月)：break 60 / low 75 / high 85
 *   Phase 3 (3 个月)：break 75 / low 80 / high 90
 *
 * 用法：
 *   # 小范围（单文件 ~5 min）
 *   npx stryker run --mutate "src/modules/db/customer.repository.ts" --reporters progress
 *
 *   # 全量（30-60 min，background 跑）
 *   npx stryker run --reporters html,json
 *
 *   # CI 集成（Day 3+）
 *   pnpm test:mutation:phase1
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
module.exports = {
  // ===== 包管理器 =====
  packageManager: 'pnpm',

  // ===== 输出 =====
  reporters: ['progress', 'clear-text', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },

  // ===== 测试 runner =====
  testRunner: 'jest',
  jest: {
    // 使用 root package.json 内嵌的 jest 配置（projectType: custom）
    projectType: 'custom',
    config: {
      // 复用 src 内嵌 jest 配置
      rootDir: 'src',
      moduleFileExtensions: ['js', 'json', 'ts'],
      testRegex: '.*\\.spec\\.ts$',
      // Stryker 注入 stryMutAct_xxx/stryCov_xxx helper 调用与 src 严格类型签名冲突
      // → 用 tsconfig.stryker.json 关 strictNullChecks（仅在 mutation testing 时生效）
      transform: {
        '^.+\\.(t|j)s$': [
          'ts-jest',
          { tsconfig: 'tsconfig.stryker.json', isolatedModules: true },
        ],
      },
      testEnvironment: 'node',
      setupFiles: ['<rootDir>/../jest.setup.ts'],
    },
    enableFindRelatedTests: true,
  },

  // ===== 要 mutate 的文件 =====
  // 排除 spec / module DI / main / migrations（无业务逻辑，mutate 无意义）
  mutate: [
    'src/**/*.ts',
    '!src/**/*.spec.ts',
    '!src/**/*.module.ts',
    '!src/main.ts',
    '!src/migrations/**',
    // 类型定义文件无业务
    '!src/**/*.types.ts',
    '!src/**/*.interface.ts',
    '!src/**/*.dto.ts', // class-validator 装饰器不 mutate（属于声明性）
  ],

  // ===== 阈值（Day 2 起点 Phase 1，v2.0 §8.2）=====
  thresholds: {
    high: 80, // ≥ 80% killed → 优秀
    low: 60, // 60-79 → 中等
    break: 40, // < 40% → CI exit 1 (严格的 hard floor)
  },

  // ===== 性能 =====
  timeoutMS: 60000, // 单个 mutant 60s 超时（jest 默认 30s × 2 buffer）
  timeoutFactor: 1.5, // 网络/慢测试给 buffer
  coverageAnalysis: 'perTest', // perTest 精度高 + 速度快（只跑相关 spec）
  ignoreStatic: true, // 跳过 static block / module-level constant 无业务影响的 mutation

  // ===== 并发 =====
  concurrency: 4, // mac/linux 4 worker（pdfserver 2 vCPU → 设 2）

  // ===== Log =====
  logLevel: 'info',
  fileLogLevel: 'trace',
  allowConsoleColors: true,

  // ===== 报告目录 =====
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,

  // ===== Plugin =====
  // 注：typescript-checker disabled — Stryker 9.x 注入 stryMutAct_xxx() 与
  //     函数签名（如 `Buffer | null` 严格签名）冲突，导致 dry-run TS 编译 fail。
  //     依赖 jest spec 跑 mutated code 验证（更接近运行时真实行为）。
  //     Day 3+ 解决：tsconfig.test.json 放宽 strictNullChecks for stryker instrument。
  plugins: ['@stryker-mutator/jest-runner'],
  checkers: [],

  // ===== 实验：禁用 mutator 黑名单 =====
  // 这些 mutator 在 NestJS 项目误报率高（DI 装饰器 / class 元数据）
  disableTypeChecks: false,
  mutator: {
    excludedMutations: [
      'StringLiteral', // @Inject('token') 字符串 mutate 无业务意义
      'ArrayDeclaration', // imports/providers 数组 mutate 破坏 DI
    ],
  },
};
