import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { Injectable } from '@nestjs/common';

/**
 * FieldEncryptor — V34 字段级 AES-256-GCM 加解密
 *
 * 来源：用户 2026-05-10 「可上架生产架构」P0 第 2 项
 *       拍板「隐私分级一级（手机/身份证）仅自己/老板校长可见」→ 存储层加密
 *
 * 算法：AES-256-GCM
 *   - 密钥：32 bytes（256 bit）
 *   - IV：12 bytes 随机（NIST GCM 推荐）
 *   - AuthTag：16 bytes（防篡改 + 完整性校验）
 *
 * 密文格式（BYTEA 存 PG）：
 *   [IV 12B][AuthTag 16B][Ciphertext NB]
 *
 * 关键属性：
 *   - 同一明文每次加密结果不同（IV 随机）→ 不能做 UNIQUE 索引 / WHERE 等值查询
 *   - 密文长度 = 28 + plaintext.length 字节
 *   - 密钥泄露后所有密文同时危险（用 KMS / Vault 旋转密钥时升级方案）
 *
 * 密钥来源：
 *   process.env.ENCRYPTION_KEY（base64 编码 32 bytes，即 44 字符）
 *   生成：openssl rand -base64 32
 *
 * 注意：
 *   - 不要日志打印 plaintext
 *   - 不要让 GET /metrics 暴露密钥
 *   - 密钥旋转方案后续做（双密钥并行解密，新写入用新密钥）
 */

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

@Injectable()
export class FieldEncryptor {
  private readonly key: Buffer;

  constructor(keyBase64?: string) {
    const k = keyBase64 ?? process.env.ENCRYPTION_KEY;
    if (!k) {
      throw new Error(
        'FieldEncryptor: ENCRYPTION_KEY missing. Generate via `openssl rand -base64 32` and set in .env',
      );
    }
    this.key = Buffer.from(k, 'base64');
    if (this.key.length !== KEY_LEN) {
      throw new Error(
        `FieldEncryptor: ENCRYPTION_KEY must decode to ${KEY_LEN} bytes (AES-256), got ${this.key.length}`,
      );
    }
  }

  /**
   * 加密明文 → BYTEA Buffer
   *
   * @param plaintext 明文字符串。null/undefined 返回 null（用于 nullable 字段）
   * @returns Buffer 格式 [IV(12) + AuthTag(16) + Cipher]，或 null
   */
  encrypt(plaintext: string | null | undefined): Buffer | null {
    if (plaintext === null || plaintext === undefined) return null;
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]);
  }

  /**
   * 解密 BYTEA → 明文字符串
   *
   * @param ciphertext Buffer 格式 [IV(12) + AuthTag(16) + Cipher]，或 null
   * @returns 明文字符串，或 null
   * @throws 密文过短 / authTag 不匹配 / key 错误（GCM 模式自动校验完整性）
   */
  decrypt(ciphertext: Buffer | null | undefined): string | null {
    if (ciphertext === null || ciphertext === undefined) return null;
    if (!Buffer.isBuffer(ciphertext)) {
      throw new Error('FieldEncryptor.decrypt: input must be Buffer');
    }
    if (ciphertext.length < IV_LEN + TAG_LEN) {
      throw new Error(
        `FieldEncryptor.decrypt: ciphertext too short (${ciphertext.length} bytes, min ${IV_LEN + TAG_LEN})`,
      );
    }
    const iv = ciphertext.subarray(0, IV_LEN);
    const tag = ciphertext.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const enc = ciphertext.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv(ALGO, this.key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString('utf8');
  }

  /**
   * 静态：生成新密钥（运维用）
   *   const key = FieldEncryptor.generateKey();
   *   console.log(key); // base64 字符串
   */
  static generateKey(): string {
    return randomBytes(KEY_LEN).toString('base64');
  }
}
