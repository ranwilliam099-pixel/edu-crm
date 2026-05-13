import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WxPayPlatformCertService } from './wxpay-platform-cert.service';

/**
 * WxPayPlatformCertService 单元测试 — W2-T1 RealWxPayClient 落地
 *
 * 覆盖：
 *   - decryptCertificate AES-256-GCM 解密能力（用本地加密的固定密文）
 *   - buildAuthorizationHeader V3 签名能力
 *   - getPublicKey cache hit / cache miss / fail-open
 *   - refreshCertificates 成功 / 微信返 errcode / 网络异常
 *   - clearCache / injectCert（暴露给单测的 helper）
 *
 * 不覆盖（边界）：
 *   - 12 小时 setInterval（NodeJS.Timeout 真实流逝，单测用 .unref() 不阻塞 + skip 此分支）
 */

// 测试用 APIv3 密钥（32 字符；与生产 .env 同长度）
const TEST_API_V3_KEY = 'tuPsXFto8Ot7EiD8346ds6mp9WrELJrr';

// 生成测试用 RSA 私钥（避免依赖文件系统；单测内即时生成）
function genTestPrivateKey(): { privateKeyPath: string; cleanup: () => void } {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxpay-cert-test-'));
  const keyPath = path.join(tmpDir, 'apiclient_key.pem');
  fs.writeFileSync(keyPath, privateKey);
  return {
    privateKeyPath: keyPath,
    cleanup: () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * 构造一份「假」微信平台证书（伪 PEM 公钥）+ AES-256-GCM 加密成 encrypt_certificate
 */
function buildEncryptedFakeCert(
  apiV3Key: string,
  fakeCertPem: string,
  serial: string,
): {
  encrypt_certificate: {
    algorithm: 'AEAD_AES_256_GCM';
    nonce: string;
    associated_data: string;
    ciphertext: string;
  };
  serial_no: string;
  effective_time: string;
  expire_time: string;
} {
  const nonce = 'abcdef0123456789'; // 16 字节 IV
  const aad = 'certificate';
  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    Buffer.from(apiV3Key, 'utf8'),
    Buffer.from(nonce, 'utf8'),
  );
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const enc = Buffer.concat([
    cipher.update(fakeCertPem, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const ciphertext = Buffer.concat([enc, tag]).toString('base64');
  return {
    serial_no: serial,
    effective_time: new Date(Date.now() - 86400000).toISOString(),
    expire_time: new Date(Date.now() + 365 * 86400000).toISOString(),
    encrypt_certificate: {
      algorithm: 'AEAD_AES_256_GCM',
      nonce,
      associated_data: aad,
      ciphertext,
    },
  };
}

describe('WxPayPlatformCertService (W2-T1)', () => {
  let service: WxPayPlatformCertService;
  let config: { get: jest.Mock };
  let cleanup: () => void;
  let privateKeyPath: string;

  // 测试用 PEM 公钥占位（不需真实是 PEM，只要解密后等于原文即可验证 AES-GCM）
  const FAKE_PUB_PEM =
    '-----BEGIN PUBLIC KEY-----\nMIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEA...\n-----END PUBLIC KEY-----';

  beforeEach(async () => {
    ({ privateKeyPath, cleanup } = genTestPrivateKey());
    config = {
      get: jest.fn((k: string) => {
        const map: Record<string, string> = {
          WXPAY_MODE: 'mock', // 默认 mock，避免 onModuleInit 拉取
          WXPAY_MCHID: '1745394334',
          WXPAY_API_V3_KEY: TEST_API_V3_KEY,
          WXPAY_SERIAL_NO: '5297EF1F1145EA6220166AB51FB41E9D2F211439',
          WXPAY_PRIVATE_KEY_PATH: privateKeyPath,
        };
        return map[k];
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WxPayPlatformCertService,
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    service = module.get<WxPayPlatformCertService>(WxPayPlatformCertService);
  });

  afterEach(() => {
    cleanup();
    service.onModuleDestroy?.();
  });

  describe('decryptCertificate (AES-256-GCM)', () => {
    it('正确解密 round-trip 密文', () => {
      const enc = buildEncryptedFakeCert(
        TEST_API_V3_KEY,
        FAKE_PUB_PEM,
        'serial001',
      );
      const decrypted = service.decryptCertificate(
        enc.encrypt_certificate,
        TEST_API_V3_KEY,
      );
      expect(decrypted).toBe(FAKE_PUB_PEM);
    });

    it('密钥长度非 32 → 抛错', () => {
      const enc = buildEncryptedFakeCert(
        TEST_API_V3_KEY,
        FAKE_PUB_PEM,
        'serial001',
      );
      expect(() =>
        service.decryptCertificate(enc.encrypt_certificate, 'short_key'),
      ).toThrow(/32 chars/);
    });

    it('algorithm 不是 AEAD_AES_256_GCM → 抛错', () => {
      expect(() =>
        service.decryptCertificate(
          {
            algorithm: 'AES-256-CBC' as 'AEAD_AES_256_GCM',
            nonce: 'a'.repeat(16),
            associated_data: 'certificate',
            ciphertext: Buffer.alloc(32).toString('base64'),
          },
          TEST_API_V3_KEY,
        ),
      ).toThrow(/unexpected algorithm/);
    });

    it('ciphertext 小于 16 字节（无 authTag） → 抛错', () => {
      expect(() =>
        service.decryptCertificate(
          {
            algorithm: 'AEAD_AES_256_GCM',
            nonce: 'a'.repeat(16),
            associated_data: 'certificate',
            ciphertext: Buffer.alloc(5).toString('base64'),
          },
          TEST_API_V3_KEY,
        ),
      ).toThrow(/too short/);
    });

    it('错误的 apiV3Key 解密 → authTag 校验失败抛错', () => {
      const enc = buildEncryptedFakeCert(
        TEST_API_V3_KEY,
        FAKE_PUB_PEM,
        'serial001',
      );
      const wrongKey = 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'; // 32 字符但内容错
      expect(() =>
        service.decryptCertificate(enc.encrypt_certificate, wrongKey),
      ).toThrow();
    });
  });

  describe('buildAuthorizationHeader (V3 签名)', () => {
    it('生成包含 mchid / serial_no / signature 的 header', () => {
      const cfg = {
        mchid: '1745394334',
        serialNo: '5297EF1F',
        privateKeyPem: fs.readFileSync(privateKeyPath, 'utf8'),
      };
      const auth = service.buildAuthorizationHeader(
        'GET',
        '/v3/certificates',
        '',
        cfg,
      );
      expect(auth.startsWith('WECHATPAY2-SHA256-RSA2048 ')).toBe(true);
      expect(auth).toContain('mchid="1745394334"');
      expect(auth).toContain('serial_no="5297EF1F"');
      expect(auth).toMatch(/signature="[A-Za-z0-9+/=]+"/);
      expect(auth).toMatch(/timestamp="\d+"/);
      expect(auth).toMatch(/nonce_str="[a-f0-9]+"/);
    });

    it('不同请求生成不同 nonce / timestamp（随机性）', () => {
      const cfg = {
        mchid: '1745394334',
        serialNo: '5297EF1F',
        privateKeyPem: fs.readFileSync(privateKeyPath, 'utf8'),
      };
      const a = service.buildAuthorizationHeader('GET', '/v3/x', '', cfg);
      const b = service.buildAuthorizationHeader('GET', '/v3/x', '', cfg);
      // 提取 nonce_str
      const nonceA = a.match(/nonce_str="([^"]+)"/)?.[1];
      const nonceB = b.match(/nonce_str="([^"]+)"/)?.[1];
      expect(nonceA).not.toBe(nonceB);
    });
  });

  describe('cache helpers', () => {
    it('injectCert / getPublicKey / clearCache 工作正常', async () => {
      service.injectCert({
        serialNo: 'TEST_SERIAL',
        publicKey: FAKE_PUB_PEM,
        effectiveTime: new Date(Date.now() - 86400000),
        expireTime: new Date(Date.now() + 86400000),
      });
      expect(service.getCacheSize()).toBe(1);
      const pk = await service.getPublicKey('TEST_SERIAL');
      expect(pk).toBe(FAKE_PUB_PEM);
      service.clearCache();
      expect(service.getCacheSize()).toBe(0);
    });

    it('cache 内 cert 已过期 → getPublicKey 触发 refresh（mock fetch 失败 → null）', async () => {
      service.injectCert({
        serialNo: 'EXPIRED',
        publicKey: FAKE_PUB_PEM,
        effectiveTime: new Date(Date.now() - 365 * 86400000),
        expireTime: new Date(Date.now() - 86400000), // 已过期
      });
      // fetch 不可用 → refresh throw → getPublicKey 返 null
      const origFetch = global.fetch;
      global.fetch = jest
        .fn()
        .mockRejectedValueOnce(new Error('network')) as unknown as typeof fetch;
      try {
        const pk = await service.getPublicKey('EXPIRED');
        expect(pk).toBeNull();
      } finally {
        global.fetch = origFetch;
      }
    });
  });

  describe('refreshCertificates', () => {
    it('成功拉取 + 解密 → cache 新公钥', async () => {
      const enc = buildEncryptedFakeCert(
        TEST_API_V3_KEY,
        FAKE_PUB_PEM,
        'NEW_SERIAL_001',
      );
      const origFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [enc] }),
      }) as unknown as typeof fetch;
      try {
        await service.refreshCertificates();
        expect(service.getCacheSize()).toBe(1);
        const pk = await service.getPublicKey('NEW_SERIAL_001');
        expect(pk).toBe(FAKE_PUB_PEM);
      } finally {
        global.fetch = origFetch;
      }
    });

    it('微信返 errcode → 抛错', async () => {
      const origFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          code: 'INVALID_REQUEST',
          message: '签名错误',
        }),
      }) as unknown as typeof fetch;
      try {
        await expect(service.refreshCertificates()).rejects.toThrow(
          /no certificates/,
        );
      } finally {
        global.fetch = origFetch;
      }
    });

    it('网络异常 → 抛错（caller fail-open 兜底）', async () => {
      const origFetch = global.fetch;
      global.fetch = jest
        .fn()
        .mockRejectedValueOnce(new Error('ECONNREFUSED')) as unknown as typeof fetch;
      try {
        await expect(service.refreshCertificates()).rejects.toThrow(
          /fetch.*failed/,
        );
      } finally {
        global.fetch = origFetch;
      }
    });

    it('HTTP 非 200 → 抛错', async () => {
      const origFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => '{"code":"INVALID_AUTH"}',
      }) as unknown as typeof fetch;
      try {
        await expect(service.refreshCertificates()).rejects.toThrow(/HTTP 401/);
      } finally {
        global.fetch = origFetch;
      }
    });

    it('部分 cert 解密失败 → 跳过失败项，cache 仅成功项', async () => {
      const good = buildEncryptedFakeCert(TEST_API_V3_KEY, FAKE_PUB_PEM, 'GOOD');
      const bad = buildEncryptedFakeCert(TEST_API_V3_KEY, FAKE_PUB_PEM, 'BAD');
      // 篡改 bad 的 ciphertext 使其 authTag 校验失败
      bad.encrypt_certificate.ciphertext = Buffer.alloc(32)
        .fill(0xff)
        .toString('base64');

      const origFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [good, bad] }),
      }) as unknown as typeof fetch;
      try {
        await service.refreshCertificates();
        expect(service.getCacheSize()).toBe(1);
        expect(await service.getPublicKey('GOOD')).toBe(FAKE_PUB_PEM);
        expect(await service.getPublicKey('BAD')).toBeNull();
      } finally {
        global.fetch = origFetch;
      }
    });
  });

  describe('onModuleInit', () => {
    it('WXPAY_MODE=mock → 跳过 init（不调 fetch）', async () => {
      const fetchSpy = jest.fn();
      const origFetch = global.fetch;
      global.fetch = fetchSpy as unknown as typeof fetch;
      try {
        await service.onModuleInit();
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        global.fetch = origFetch;
      }
    });

    it('WXPAY_MODE=real + fetch 失败 → fail-open（不抛错）', async () => {
      config.get.mockImplementation((k: string) => {
        const map: Record<string, string> = {
          WXPAY_MODE: 'real',
          WXPAY_MCHID: '1745394334',
          WXPAY_API_V3_KEY: TEST_API_V3_KEY,
          WXPAY_SERIAL_NO: '5297EF1F',
          WXPAY_PRIVATE_KEY_PATH: privateKeyPath,
        };
        return map[k];
      });
      const origFetch = global.fetch;
      global.fetch = jest
        .fn()
        .mockRejectedValue(new Error('boot net error')) as unknown as typeof fetch;
      try {
        await expect(service.onModuleInit()).resolves.not.toThrow();
      } finally {
        global.fetch = origFetch;
      }
    });
  });
});
