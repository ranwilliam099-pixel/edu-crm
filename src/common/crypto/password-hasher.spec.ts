/**
 * PasswordHasher 单测 — Sprint X.2 (2026-05-17)
 *
 * 验证：
 *   - hash() bcrypt $2b$12$ 60-char 输出
 *   - verify() timing-safe 比对
 *   - generateRandomPassword() 长度 + 字符集
 */
import { PasswordHasher } from './password-hasher';

describe('PasswordHasher - Sprint X.2 bcrypt 封装', () => {
  let hasher: PasswordHasher;

  beforeEach(() => {
    hasher = new PasswordHasher();
  });

  describe('hash()', () => {
    it('正常 hash → 返 60-char bcrypt $2b$ 格式', async () => {
      const h = await hasher.hash('password123');
      expect(typeof h).toBe('string');
      expect(h.length).toBe(60);
      expect(h.startsWith('$2')).toBe(true); // bcrypt 标识 (bcryptjs 可能用 $2a$ 或 $2b$)
    });

    it('同 plain hash 两次 → 不同 hash (随机 salt)', async () => {
      const h1 = await hasher.hash('password123');
      const h2 = await hasher.hash('password123');
      expect(h1).not.toBe(h2);
    });

    it('空字符串 plain → throw', async () => {
      await expect(hasher.hash('')).rejects.toThrow();
    });

    it('非 string 类型 → throw', async () => {
      // @ts-expect-error 故意传 number
      await expect(hasher.hash(123)).rejects.toThrow();
    });
  });

  describe('verify()', () => {
    it('正确密码 → true', async () => {
      const h = await hasher.hash('mypw123');
      expect(await hasher.verify('mypw123', h)).toBe(true);
    });

    it('错误密码 → false', async () => {
      const h = await hasher.hash('mypw123');
      expect(await hasher.verify('wrongpw', h)).toBe(false);
    });

    it('hash="" (V46 DEFAULT 旧 row) → false (timing-safe, 不抛错)', async () => {
      // 不应短路 — 应跑完 dummy bcrypt 防 timing attack
      const start = Date.now();
      expect(await hasher.verify('anything', '')).toBe(false);
      const dur = Date.now() - start;
      // bcryptjs cost=12 通常 > 50ms; 这里不严格断言数值, 仅确认 "不立即返回 false"
      // (timing attack 防御依据: 即使 hash="" 也走完整 bcrypt 计算)
      expect(dur).toBeGreaterThan(10);
    });

    it('plain="" → false (不报错)', async () => {
      const h = await hasher.hash('mypw123');
      expect(await hasher.verify('', h)).toBe(false);
    });

    it('hash 格式错乱 → false (bcryptjs.compare 抛错被 catch 返 false)', async () => {
      expect(await hasher.verify('any', 'not_a_valid_bcrypt_hash')).toBe(false);
    });
  });

  describe('generateRandomPassword()', () => {
    it('默认长度 8', () => {
      const pw = hasher.generateRandomPassword();
      expect(pw.length).toBe(8);
    });

    it('指定长度 12', () => {
      const pw = hasher.generateRandomPassword(12);
      expect(pw.length).toBe(12);
    });

    it('字符集去掉易混字符 0/O/I/l/1', () => {
      const pw = hasher.generateRandomPassword(64);
      expect(pw).not.toMatch(/[0OIl1]/);
    });

    it('每次生成不同 (随机性)', () => {
      const pw1 = hasher.generateRandomPassword(16);
      const pw2 = hasher.generateRandomPassword(16);
      expect(pw1).not.toBe(pw2);
    });

    it('长度 < 4 → throw', () => {
      expect(() => hasher.generateRandomPassword(3)).toThrow();
    });

    it('长度 > 64 → throw', () => {
      expect(() => hasher.generateRandomPassword(65)).toThrow();
    });
  });
});
