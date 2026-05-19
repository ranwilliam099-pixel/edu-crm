/**
 * jest.setup.ts — V34/V40/A02-1/A02-3 单测全局环境注入
 *
 * 通过 `package.json#jest.setupFiles` + `test/jest-e2e.json#setupFiles` 引入。
 * 在 Test.createTestingModule 编译模块之前执行，确保以下条件：
 *
 *   1. process.env.ENCRYPTION_KEY 总是有值（FieldEncryptor 构造器需要）
 *      - 单测：无须真实加密，仅满足构造（mock 会替换实际行为）
 *      - e2e：用 32 字节全 0 base64 key 跑端到端，明文/密文双轨可读
 *
 *   2. process.env.HASH_KEY 总是有值（V40/A02-3 HmacHasher 构造器需要）
 *      - 与 ENCRYPTION_KEY 用不同字节模式（全 1 vs 全 0），模拟密钥分离
 *      - 单测固定值便于检验 hash 确定性（同输入 → 同输出）
 *
 *   3. 不污染生产 / 已有 .env：仅在缺失时 fallback 注入
 *
 * 来源：V34 字段加密拍板 + A02-1（teacher）+ A02-2（customer）+ A02-3（parent）。
 */

// 32 字节（base64 44 字符）全 0 密钥 — 仅供测试。生产请用 openssl rand -base64 32。
const TEST_ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
// 32 字节 (32 个 0x04 base64) — 不同字节模式模拟与 ENCRYPTION_KEY 的密钥分离。
// node -e "console.log(Buffer.alloc(32, 4).toString('base64'))" => BAQEBA...
const TEST_HASH_KEY = 'BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ=';

if (!process.env.ENCRYPTION_KEY) {
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
}
if (!process.env.HASH_KEY) {
  process.env.HASH_KEY = TEST_HASH_KEY;
}
