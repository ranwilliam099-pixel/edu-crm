import { FieldEncryptor } from './field-encryptor';

describe('FieldEncryptor', () => {
  // 固定测试密钥（不要在生产用）
  const TEST_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='; // 32 字节全 0 base64
  let enc: FieldEncryptor;

  beforeEach(() => {
    enc = new FieldEncryptor(TEST_KEY);
  });

  describe('构造器密钥校验', () => {
    it('合法 32 字节 key → 成功', () => {
      expect(() => new FieldEncryptor(TEST_KEY)).not.toThrow();
    });

    it('密钥过短 → 抛错', () => {
      const shortKey = Buffer.alloc(16).toString('base64');
      expect(() => new FieldEncryptor(shortKey)).toThrow(/32 bytes/);
    });

    it('密钥过长 → 抛错', () => {
      const longKey = Buffer.alloc(64).toString('base64');
      expect(() => new FieldEncryptor(longKey)).toThrow(/32 bytes/);
    });

    it('无密钥（构造参数 + env 都空）→ 抛错', () => {
      const saved = process.env.ENCRYPTION_KEY;
      delete process.env.ENCRYPTION_KEY;
      expect(() => new FieldEncryptor()).toThrow(/ENCRYPTION_KEY missing/);
      if (saved !== undefined) process.env.ENCRYPTION_KEY = saved;
    });

    it('从 process.env 读 key', () => {
      const saved = process.env.ENCRYPTION_KEY;
      process.env.ENCRYPTION_KEY = TEST_KEY;
      expect(() => new FieldEncryptor()).not.toThrow();
      if (saved !== undefined) process.env.ENCRYPTION_KEY = saved;
      else delete process.env.ENCRYPTION_KEY;
    });
  });

  describe('encrypt() / decrypt() 往返', () => {
    it('普通字符串往返一致', () => {
      const plain = '13800138000';
      const ct = enc.encrypt(plain)!;
      expect(Buffer.isBuffer(ct)).toBe(true);
      expect(ct.length).toBe(12 + 16 + plain.length);
      expect(enc.decrypt(ct)).toBe(plain);
    });

    it('中文字符串往返一致', () => {
      const plain = '王老师@朝阳总部';
      expect(enc.decrypt(enc.encrypt(plain)!)).toBe(plain);
    });

    it('微信号 / 长字符串', () => {
      const plain = 'wxid_a1b2c3d4e5f6g7h8i9j0';
      expect(enc.decrypt(enc.encrypt(plain)!)).toBe(plain);
    });

    it('空字符串 → 加密后非空 → 解密回空字符串', () => {
      const ct = enc.encrypt('')!;
      expect(ct.length).toBe(12 + 16 + 0);
      expect(enc.decrypt(ct)).toBe('');
    });
  });

  describe('null / undefined 处理', () => {
    it('encrypt(null) → null', () => {
      expect(enc.encrypt(null)).toBeNull();
    });
    it('encrypt(undefined) → null', () => {
      expect(enc.encrypt(undefined)).toBeNull();
    });
    it('decrypt(null) → null', () => {
      expect(enc.decrypt(null)).toBeNull();
    });
    it('decrypt(undefined) → null', () => {
      expect(enc.decrypt(undefined)).toBeNull();
    });
  });

  describe('IV 随机性（不可预测）', () => {
    it('同一明文加密两次 → 密文不同（IV 随机）', () => {
      const plain = '13800138000';
      const ct1 = enc.encrypt(plain)!;
      const ct2 = enc.encrypt(plain)!;
      expect(ct1.equals(ct2)).toBe(false);
      // 但解密都回到原文
      expect(enc.decrypt(ct1)).toBe(plain);
      expect(enc.decrypt(ct2)).toBe(plain);
    });
  });

  describe('防篡改（GCM AuthTag）', () => {
    it('密文中间字节被改 → decrypt 抛错', () => {
      const ct = enc.encrypt('13800138000')!;
      ct[20] = ct[20] ^ 0xff; // 翻转一字节
      expect(() => enc.decrypt(ct)).toThrow();
    });

    it('AuthTag 被改 → decrypt 抛错', () => {
      const ct = enc.encrypt('13800138000')!;
      ct[15] = ct[15] ^ 0xff; // 翻转 tag 区
      expect(() => enc.decrypt(ct)).toThrow();
    });

    it('IV 被改 → decrypt 抛错', () => {
      const ct = enc.encrypt('13800138000')!;
      ct[5] = ct[5] ^ 0xff; // 翻转 IV 区
      expect(() => enc.decrypt(ct)).toThrow();
    });
  });

  describe('密文格式校验', () => {
    it('密文过短 → 抛错', () => {
      const tooShort = Buffer.alloc(20); // < 12+16=28
      expect(() => enc.decrypt(tooShort)).toThrow(/too short/);
    });

    it('decrypt 输入非 Buffer → 抛错', () => {
      // @ts-expect-error 测试运行时类型校验
      expect(() => enc.decrypt('not a buffer')).toThrow(/must be Buffer/);
    });
  });

  describe('密钥隔离（不同 key 不可互解）', () => {
    it('A key 加密 → B key 解密 → 抛错', () => {
      const encA = new FieldEncryptor(TEST_KEY);
      const encB = new FieldEncryptor(FieldEncryptor.generateKey());
      const ct = encA.encrypt('13800138000')!;
      expect(() => encB.decrypt(ct)).toThrow();
    });
  });

  describe('generateKey()', () => {
    it('生成的 key 是合法 base64 + 解码 32 字节', () => {
      const key = FieldEncryptor.generateKey();
      const buf = Buffer.from(key, 'base64');
      expect(buf.length).toBe(32);
    });

    it('每次生成不同', () => {
      const k1 = FieldEncryptor.generateKey();
      const k2 = FieldEncryptor.generateKey();
      expect(k1).not.toBe(k2);
    });
  });

  describe('密文长度公式', () => {
    it.each([
      ['', 28],
      ['a', 29],
      ['1234567890', 38],
      ['abc'.repeat(100), 12 + 16 + 300],
    ])('plaintext "%s" → ciphertext %i bytes', (plain, expected) => {
      const ct = enc.encrypt(plain)!;
      expect(ct.length).toBe(expected);
    });
  });
});
