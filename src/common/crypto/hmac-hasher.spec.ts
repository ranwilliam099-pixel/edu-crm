import { HmacHasher } from './hmac-hasher';

describe('HmacHasher', () => {
  // 固定测试密钥（不要在生产用）
  // A02-3 round 2 (WARNING #1 修复后): TEST_KEY 必须与 jest.setup.ts 注入的
  // TEST_ENCRYPTION_KEY (全 0x00) 字节不同，否则触发新加的运行时校验
  // HASH_KEY !== ENCRYPTION_KEY → 抛 key separation 错
  const TEST_KEY = 'BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU='; // 32 字节全 0x05
  const ALT_KEY = 'BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgY='; // 32 字节全 0x06
  let hasher: HmacHasher;

  beforeEach(() => {
    hasher = new HmacHasher(TEST_KEY);
  });

  describe('构造器密钥校验', () => {
    it('合法 32 字节 key → 成功', () => {
      expect(() => new HmacHasher(TEST_KEY)).not.toThrow();
    });

    it('密钥过短 → 抛错', () => {
      const shortKey = Buffer.alloc(16).toString('base64');
      expect(() => new HmacHasher(shortKey)).toThrow(/32 bytes/);
    });

    it('密钥过长 → 抛错', () => {
      const longKey = Buffer.alloc(64).toString('base64');
      expect(() => new HmacHasher(longKey)).toThrow(/32 bytes/);
    });

    it('无密钥（构造参数 + env 都空）→ 抛错', () => {
      const saved = process.env.HASH_KEY;
      delete process.env.HASH_KEY;
      try {
        expect(() => new HmacHasher()).toThrow(/HASH_KEY missing/);
      } finally {
        if (saved !== undefined) process.env.HASH_KEY = saved;
      }
    });

    it('从 process.env.HASH_KEY 读 key', () => {
      const saved = process.env.HASH_KEY;
      process.env.HASH_KEY = TEST_KEY;
      try {
        expect(() => new HmacHasher()).not.toThrow();
      } finally {
        if (saved !== undefined) process.env.HASH_KEY = saved;
        else delete process.env.HASH_KEY;
      }
    });

    it('错误提示提到 ENCRYPTION_KEY 与 HASH_KEY 应不同', () => {
      const saved = process.env.HASH_KEY;
      delete process.env.HASH_KEY;
      try {
        expect(() => new HmacHasher()).toThrow(/different from ENCRYPTION_KEY/);
      } finally {
        if (saved !== undefined) process.env.HASH_KEY = saved;
      }
    });

    // A02-3 round 2 (security WARNING #1 修复): 运行时校验 HASH_KEY !== ENCRYPTION_KEY
    it('HASH_KEY === ENCRYPTION_KEY → 抛错（防运维误填同 key，密钥分离运行时强制）', () => {
      const savedHash = process.env.HASH_KEY;
      const encKey = process.env.ENCRYPTION_KEY;
      if (!encKey) {
        // 测试前置：ENCRYPTION_KEY 应已由 jest.setup.ts 注入
        throw new Error('test prerequisite: process.env.ENCRYPTION_KEY required');
      }
      try {
        // 把 HASH_KEY 设为与 ENCRYPTION_KEY 完全相同的字节
        expect(() => new HmacHasher(encKey)).toThrow(
          /key separation|must NOT equal ENCRYPTION_KEY/,
        );
      } finally {
        if (savedHash !== undefined) process.env.HASH_KEY = savedHash;
      }
    });

    it('HASH_KEY 与 ENCRYPTION_KEY 字节不同 → 通过（默认 jest.setup.ts 注入路径）', () => {
      // 验证默认测试环境（TEST_HASH_KEY ≠ TEST_ENCRYPTION_KEY）不被新校验误伤
      expect(() => new HmacHasher(TEST_KEY)).not.toThrow();
    });
  });

  describe('hash() 输出特性', () => {
    it('输出为 32 字节 Buffer', () => {
      const out = hasher.hash('13800138000')!;
      expect(Buffer.isBuffer(out)).toBe(true);
      expect(out.length).toBe(32);
      expect(out.length).toBe(HmacHasher.HASH_OUTPUT_LENGTH);
    });

    it('同一明文哈希两次 → 结果完全相同（确定性）', () => {
      const phone = '13800138000';
      const h1 = hasher.hash(phone)!;
      const h2 = hasher.hash(phone)!;
      expect(h1.equals(h2)).toBe(true);
    });

    it('不同明文 → 不同 hash', () => {
      const h1 = hasher.hash('13800138000')!;
      const h2 = hasher.hash('13800138001')!;
      expect(h1.equals(h2)).toBe(false);
    });

    it('中文 / 长字符串都能哈希', () => {
      const out1 = hasher.hash('张三老师@朝阳总部')!;
      const out2 = hasher.hash('wxid_a1b2c3d4e5f6g7h8i9j0_long_id')!;
      expect(out1.length).toBe(32);
      expect(out2.length).toBe(32);
      expect(out1.equals(out2)).toBe(false);
    });

    it('空字符串也产生 32 字节 hash', () => {
      const out = hasher.hash('')!;
      expect(out.length).toBe(32);
    });
  });

  describe('null / undefined 处理', () => {
    it('hash(null) → null', () => {
      expect(hasher.hash(null)).toBeNull();
    });
    it('hash(undefined) → null', () => {
      expect(hasher.hash(undefined)).toBeNull();
    });
  });

  describe('密钥隔离', () => {
    it('不同 key 哈希同一明文 → 不同结果', () => {
      const hA = new HmacHasher(TEST_KEY);
      const hB = new HmacHasher(ALT_KEY);
      const phone = '13800138000';
      const outA = hA.hash(phone)!;
      const outB = hB.hash(phone)!;
      expect(outA.equals(outB)).toBe(false);
    });
  });

  describe('已知测试向量（防回归）', () => {
    // A02-3 round 2 (security WARNING #3 修复): 锁定具体 hex 值防算法静默变更
    //   - 算法若被改成 sha512 / sha1 → spec 立刻 fail
    //   - key length 改 → spec 立刻 fail
    //   - encoding 改成非 utf8 → spec 立刻 fail
    //
    // 用 32 字节全 0x05 key（不能用全 0x00，否则触发 HASH_KEY === ENCRYPTION_KEY 校验）
    // 计算方式（Node 24+ / 20+ 都稳定）：
    //   node -e "console.log(require('crypto').createHmac('sha256', Buffer.alloc(32, 5)).update('13800138000').digest('hex'))"
    // → 96c3f9cfd536d8d55ac81a13adcf9e3701e24ab156167d605a28d1d119ecfc2a
    it('phone=13800138000 with all-0x05 key → 固定 hex 锁定（防算法变更回归）', () => {
      // 用独立的 all-0x05 key 实例（与 jest.setup.ts 的全 0x04 / 0x00 都不冲突）
      const fixedKeyHasher = new HmacHasher(Buffer.alloc(32, 5).toString('base64'));
      const out = fixedKeyHasher.hash('13800138000')!;
      expect(out.toString('hex')).toBe(
        '96c3f9cfd536d8d55ac81a13adcf9e3701e24ab156167d605a28d1d119ecfc2a',
      );
    });

    it('phone=13900000001 with all-0x05 key → 固定 hex 锁定（第二组向量）', () => {
      // 第二组向量增加防回归覆盖（防只 hard-code 单个 input 的边角实现）
      const fixedKeyHasher = new HmacHasher(Buffer.alloc(32, 5).toString('base64'));
      const out = fixedKeyHasher.hash('13900000001')!;
      expect(out.toString('hex')).toBe(
        '48dee40d73908dd06a22631919340bced3758cdb62bf4f0f686dfe22666fb5dd',
      );
    });
  });

  describe('generateKey()', () => {
    it('生成的 key 是合法 base64 + 解码 32 字节', () => {
      const key = HmacHasher.generateKey();
      const buf = Buffer.from(key, 'base64');
      expect(buf.length).toBe(32);
    });

    it('每次生成不同', () => {
      const k1 = HmacHasher.generateKey();
      const k2 = HmacHasher.generateKey();
      expect(k1).not.toBe(k2);
    });

    it('生成的 key 可用于构造 HmacHasher', () => {
      const key = HmacHasher.generateKey();
      expect(() => new HmacHasher(key)).not.toThrow();
    });
  });
});
