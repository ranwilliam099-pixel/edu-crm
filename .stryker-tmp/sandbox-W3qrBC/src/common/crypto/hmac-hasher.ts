import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { Injectable } from '@nestjs/common';

/**
 * HmacHasher — V40/A02-3 用于 parent.phone 确定性哈希（等值查询）
 *
 * 来源：用户 2026-05-13 拍板「方案 A 双列 hash+encrypted」
 *
 * 算法：HMAC-SHA256
 *   - 密钥：32 bytes（256 bit）
 *   - 输出：32 bytes 固定长度
 *
 * 用途：
 *   - 给 parents.phone 计算 phone_hash 列（BYTEA），实现 C 端登录等值查询
 *   - AES-GCM（FieldEncryptor）每次加密结果不同（IV 随机）→ 不能 UNIQUE / WHERE 等值
 *   - HMAC 是确定性函数（同输入 + 同 key → 同输出）→ 可建唯一索引 + WHERE 查询
 *
 * 关键属性：
 *   - 同一明文每次哈希结果**相同**（与 FieldEncryptor.encrypt 相反）
 *   - 单向：从 hash 反推 plaintext 在密码学上不可行（除非暴力枚举 11 位手机号）
 *   - 防枚举：手机号空间只有 10^11 ≈ 1000 亿，HASH_KEY 仅延缓不阻止暴力枚举
 *     → HASH_KEY 必须保密；泄露后需 rotate（重新 backfill 全表 phone_hash）
 *
 * 密钥分离（与 ENCRYPTION_KEY 独立）：
 *   - HASH_KEY 泄露 → 可枚举手机号、构造已知 hash 反查 parentId
 *                    → **但不能解密 phone_encrypted**（机密性仍受保护）
 *   - ENCRYPTION_KEY 泄露 → 可解密所有 phone_encrypted
 *                          → **但 phone_hash 不变**（UNIQUE 查询完整性仍受保护）
 *   - 两密钥同时泄露 = 全面 breach（必然需要全表重 backfill + 强制重置密码）
 *
 * 不加 tenant_id 盐：
 *   - parents 表在 public schema，跨租户共享（V10 拍板，同一手机号属同一 parent）
 *   - 加 tenant_id 会破坏「同手机号必须同 hash」的查询前提
 *   - 防枚举不在密钥分离层做，靠应用层 rate-limit + 监控异常查询
 *
 * 密钥来源：
 *   process.env.HASH_KEY（base64 编码 32 bytes，即 44 字符）
 *   生成：openssl rand -base64 32
 *
 * 注意：
 *   - 不要日志打印 plaintext / hash（hash 是 PII 衍生物，等同身份标识）
 *   - 不要让 GET /metrics 暴露密钥
 *   - 密钥旋转方案：增加 HASH_KEY_PREV 双查 → 写入用新 key + 渐进 backfill 后切换
 */

const HASH_ALGO = 'sha256';
const KEY_LEN = 32;
const HASH_OUT_LEN = 32;

@Injectable()
export class HmacHasher {
  private readonly key: Buffer;

  constructor(keyBase64?: string) {
    const k = keyBase64 ?? process.env.HASH_KEY;
    if (!k) {
      throw new Error(
        'HmacHasher: HASH_KEY missing. Generate via `openssl rand -base64 32` and set in .env (must be different from ENCRYPTION_KEY)',
      );
    }
    this.key = Buffer.from(k, 'base64');
    if (this.key.length !== KEY_LEN) {
      throw new Error(
        `HmacHasher: HASH_KEY must decode to ${KEY_LEN} bytes (HMAC-SHA256), got ${this.key.length}`,
      );
    }
    // A02-3 round 2 (security WARNING #1 修复): 运行时校验 HASH_KEY !== ENCRYPTION_KEY
    // 防运维误填同 key (注释 + .env.example 文案约定不可代替运行时强制)
    // 用 timingSafeEqual 防 timing side-channel
    const encKeyB64 = process.env.ENCRYPTION_KEY;
    if (encKeyB64) {
      const encKey = Buffer.from(encKeyB64, 'base64');
      if (encKey.length === this.key.length && timingSafeEqual(this.key, encKey)) {
        throw new Error(
          'HmacHasher: HASH_KEY must NOT equal ENCRYPTION_KEY (key separation). ' +
            'Generate two independent keys: `openssl rand -base64 32` (run twice).',
        );
      }
    }
  }

  /**
   * 计算 HMAC-SHA256 哈希
   *
   * @param plaintext 待哈希字符串（null/undefined 返回 null，便于 nullable 字段统一）
   * @returns 32-byte Buffer（PG BYTEA），或 null
   */
  hash(plaintext: string | null | undefined): Buffer | null {
    if (plaintext === null || plaintext === undefined) return null;
    return createHmac(HASH_ALGO, this.key).update(plaintext, 'utf8').digest();
  }

  /**
   * 静态：生成新 HASH_KEY（运维用，与 ENCRYPTION_KEY 必须不同）
   *
   *   const key = HmacHasher.generateKey();
   *   console.log(key); // base64 字符串
   */
  static generateKey(): string {
    return randomBytes(KEY_LEN).toString('base64');
  }

  /**
   * 给单测 / 内省用：输出长度常量
   */
  static readonly HASH_OUTPUT_LENGTH = HASH_OUT_LEN;
}
