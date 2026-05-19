import { Injectable } from '@nestjs/common';
// 用 bcryptjs (纯 JS) 而非 bcrypt 原生模块, 因 bcrypt 需 node-gyp 编译 native binding
//   - macOS / Linux pm2 部署 + Node 多版本切换时 native binding 易碎
//   - bcryptjs 100% 兼容 bcrypt $2b$ hash 格式, 性能 ~3-5x 慢但密码登录场景可忽略
//   - 业界标准: passport-local / NestJS 官方示例 / Auth0 SDK 多用 bcryptjs
//   - hash() async (内部 setImmediate 防阻塞 event loop, 与 native bcrypt 同语义)
import * as bcrypt from 'bcryptjs';

/**
 * PasswordHasher — Sprint X.2 (2026-05-17) B 端 user 密码 bcrypt 封装
 *
 * 来源：
 *   - SSOT §12.4 admin 唯一创建权 + bcrypt cost=12 初始密码
 *   - SSOT §12.7 password_hash 加密 = bcrypt cost=12
 *   - 用户拍板 D2「admin 手动设密码 + modal 显示一次」
 *
 * 设计（与 FieldEncryptor / HmacHasher 同模式，DI-friendly + 单测可 mock）：
 *   - hash(plain) → bcrypt $2b$12$ 60 字符（V46 schema VARCHAR(60) 对齐）
 *   - verify(plain, hashed) → boolean（timing-safe，bcrypt 内部用 timingSafeEqual）
 *   - generateRandomPassword(len=8) → 8 位随机密码（D2 admin 手动设密码用）
 *
 * 安全约束：
 *   - cost factor = 12（bcrypt 业界标准，~250ms/hash @ M1，平衡安全与登录延迟）
 *   - 不日志 plain / hashed（hashed 虽包含 salt 但 brute-force 暴露的攻击面）
 *   - generateRandomPassword 用 crypto.randomBytes 不是 Math.random（密码学随机）
 *
 * 不在本类（spec 外）：
 *   - 密码强度校验（spec D2 admin 手动设, 无前端 strength check 要求）
 *   - 密码历史（防重用）
 *   - 失败次数锁定（spec 走 throttler 5/min/IP 已足够）
 */

const BCRYPT_COST = 12;
const DEFAULT_PASSWORD_LEN = 8;
const PASSWORD_CHARSET =
  'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
// 去掉易混字符: 0/O/I/l/1 (用户口述场景, D2 admin 复制告知员工)

@Injectable()
export class PasswordHasher {
  /**
   * 计算 bcrypt hash
   * @param plain 明文密码（>= 1 字符；空字符串抛错防误用）
   * @returns 60-char bcrypt hash（$2b$12$...）
   */
  async hash(plain: string): Promise<string> {
    if (typeof plain !== 'string' || plain.length === 0) {
      throw new Error('PasswordHasher.hash: plain must be non-empty string');
    }
    return bcrypt.hash(plain, BCRYPT_COST);
  }

  /**
   * 校验密码
   * @param plain 用户输入的明文密码
   * @param hashed DB 存储的 bcrypt hash（password_hash 列）
   * @returns true=匹配 / false=不匹配
   *
   * 重要：hashed='' (V46 DEFAULT 旧 row) → bcrypt.compare 返 false (timing-safe)
   *   防短路 timing attack — 即使 hash 为空, compare 仍执行完整 bcrypt 计算
   */
  async verify(plain: string, hashed: string): Promise<boolean> {
    if (typeof plain !== 'string' || plain.length === 0) return false;
    if (typeof hashed !== 'string' || hashed.length === 0) {
      // hash='' (V46 DEFAULT) → 仍 compare 防 timing attack (bcrypt 抛错时 catch 返 false)
      // bcrypt.compare 对空 hash 会抛 'Invalid arguments'，等长 dummy hash 消耗时间
      try {
        // dummy hash 让 bcrypt 走完完整 cost=12 计算（防 timing attack）
        // $2b$12$ 开头 + 53 字符 salt+hash = 60 字符总长
        await bcrypt.compare(
          plain,
          '$2b$12$abcdefghijklmnopqrstuuKzCvg5LZTktJiNJq1.UpgQ8RG5xRYL.',
        );
      } catch {
        // 永远不抛, 返 false
      }
      return false;
    }
    try {
      return await bcrypt.compare(plain, hashed);
    } catch {
      return false;
    }
  }

  /**
   * 生成初始密码（D2 admin 手动设 + modal 显示一次 + 复制告知员工）
   *
   * 字符集去掉 0/O/I/l/1（口述场景防混淆）
   * 长度默认 8 位（业务场景：员工首次登录后立即改密 → 强度足够）
   *
   * 用 Node crypto.randomBytes 而非 Math.random（密码学随机性）
   */
  generateRandomPassword(length = DEFAULT_PASSWORD_LEN): string {
    if (length < 4 || length > 64) {
      throw new Error(
        `PasswordHasher.generateRandomPassword: length must be 4-64, got ${length}`,
      );
    }
    // crypto.randomBytes 同 ulid 内部, Node 原生不需额外依赖
    // 取 length*2 bytes 映射到字符集，丢余防 modulo bias
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { randomBytes } = require('crypto') as typeof import('crypto');
    const bytes = randomBytes(length * 2);
    let result = '';
    for (let i = 0; i < bytes.length && result.length < length; i++) {
      const byte = bytes[i];
      // 丢余: 256 % 55 = 36, 落 [0, 256-36) 区间无偏
      if (byte >= 256 - (256 % PASSWORD_CHARSET.length)) continue;
      result += PASSWORD_CHARSET[byte % PASSWORD_CHARSET.length];
    }
    if (result.length < length) {
      // 极小概率（每字节 ~14% 拒绝）length*2 不够 → 递归补齐
      return result + this.generateRandomPassword(length - result.length);
    }
    return result;
  }
}
