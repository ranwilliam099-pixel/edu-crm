/**
 * jest.setup.ts — V34/A02-1 单测全局环境注入
 *
 * 通过 `package.json#jest.setupFiles` + `test/jest-e2e.json#setupFiles` 引入。
 * 在 Test.createTestingModule 编译模块之前执行，确保以下条件：
 *
 *   1. process.env.ENCRYPTION_KEY 总是有值（FieldEncryptor 构造器需要）
 *      - 单测：无须真实加密，仅满足构造（mock 会替换实际行为）
 *      - e2e：用 32 字节全 0 base64 key 跑端到端，明文/密文双轨可读
 *
 *   2. 不污染生产 / 已有 .env：仅在缺失时 fallback 注入
 *
 * 来源：V34 字段加密拍板 + A02-1（仅 teacher）实施 → 后续 A02-2 parent/customer 复用。
 */

// 32 字节（base64 44 字符）全 0 密钥 — 仅供测试。生产请用 openssl rand -base64 32。
const TEST_ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

if (!process.env.ENCRYPTION_KEY) {
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
}
