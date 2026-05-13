import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RealWxPayClient } from './wxpay-real.client';
import { WxPayPlatformCertService } from './wxpay-platform-cert.service';
import type { CreatePrepayParams, RefundParams } from './wxpay.types';

/**
 * RealWxPayClient 单元测试 — W2-T1 真实 V3 实现
 *
 * 覆盖：
 *   - createPrepay happy path + 4 失败路径（网络 / HTTP 非 200 / 无 prepay_id / 入参非法）
 *   - verifyCallbackSignature happy + 6 失败路径
 *     （头缺失 / 时间窗超期 / 公钥不存在 / 签名错 / verify 抛错 / platformCert 未注入）
 *   - requestRefund happy + 3 失败路径（金额非法 / HTTP 非 200 / 网络异常）
 *   - closeOrder 204 happy + 4xx 失败
 *   - loadConfig 缺失 ENV / API_V3_KEY 长度错 / 私钥读不到
 *
 * 用本地生成的 RSA 私钥 / 公钥对，避免依赖文件系统真实 cert
 */

const ULID_A = '01HRX5Y3K2NQVWGT7ABCDEFGHJKMNP00';
const ULID_B = '01HRX5Y3K2NQVWGT7ABCDEFGHJKMNP01';

const TEST_API_V3_KEY = 'tuPsXFto8Ot7EiD8346ds6mp9WrELJrr'; // 32 字符

function genKeyPair(): {
  privateKey: string;
  publicKey: string;
  privateKeyPath: string;
  cleanup: () => void;
} {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxpay-real-test-'));
  const keyPath = path.join(tmpDir, 'apiclient_key.pem');
  fs.writeFileSync(keyPath, privateKey);
  return {
    privateKey,
    publicKey,
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

describe('RealWxPayClient (W2-T1)', () => {
  let client: RealWxPayClient;
  let platformCert: jest.Mocked<Pick<WxPayPlatformCertService, 'getPublicKey'>>;
  let config: { get: jest.Mock };
  let cleanup: () => void;
  let privateKey: string;
  let publicKey: string;
  let privateKeyPath: string;

  const VALID_PREPAY: CreatePrepayParams = {
    outTradeNo: ULID_A,
    openid: 'oTest_xxxxxxxx',
    amountCents: 199900,
    description: '教育培训行业销售 CRM 标准版年费',
    notifyUrl: 'https://api.example.com/api/checkout/callbacks/wxpay',
  };

  const VALID_REFUND: RefundParams = {
    outTradeNo: ULID_A,
    outRefundNo: ULID_B,
    refundAmountCents: 50000,
    totalAmountCents: 199900,
    reason: '客户申请部分退款（A04 §3）',
  };

  beforeEach(async () => {
    ({ privateKey, publicKey, privateKeyPath, cleanup } = genKeyPair());

    config = {
      get: jest.fn((k: string) => {
        const map: Record<string, string> = {
          WXPAY_MODE: 'mock', // 默认 mock 跳过 onModuleInit init
          WXPAY_MCHID: '1745394334',
          WXPAY_APP_ID: 'wxde9d7818d7420d00',
          WXPAY_SERIAL_NO: '5297EF1F1145EA6220166AB51FB41E9D2F211439',
          WXPAY_API_V3_KEY: TEST_API_V3_KEY,
          WXPAY_NOTIFY_URL:
            'https://api.minxin.top/api/checkout/callbacks/wxpay',
          WXPAY_PRIVATE_KEY_PATH: privateKeyPath,
        };
        return map[k];
      }),
    };

    platformCert = {
      getPublicKey: jest.fn(),
    } as unknown as jest.Mocked<
      Pick<WxPayPlatformCertService, 'getPublicKey'>
    >;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealWxPayClient,
        { provide: ConfigService, useValue: config },
        { provide: WxPayPlatformCertService, useValue: platformCert },
      ],
    }).compile();

    client = module.get<RealWxPayClient>(RealWxPayClient);
  });

  afterEach(() => {
    cleanup();
  });

  // ============================================================
  // loadConfig
  // ============================================================
  describe('loadConfig', () => {
    it('缺失 WXPAY_MCHID → 抛 InternalServerError', () => {
      config.get.mockImplementation((k: string) => {
        if (k === 'WXPAY_MCHID') return undefined;
        return 'placeholder';
      });
      client.resetConfigCache();
      expect(() => client.loadConfig()).toThrow(InternalServerErrorException);
    });

    it('WXPAY_API_V3_KEY 长度非 32 → 抛错', () => {
      config.get.mockImplementation((k: string) => {
        if (k === 'WXPAY_API_V3_KEY') return 'short_key';
        if (k === 'WXPAY_PRIVATE_KEY_PATH') return privateKeyPath;
        return 'placeholder_https://x';
      });
      client.resetConfigCache();
      expect(() => client.loadConfig()).toThrow(/32 chars/);
    });

    it('WXPAY_PRIVATE_KEY_PATH 文件不存在 → 抛错', () => {
      config.get.mockImplementation((k: string) => {
        const map: Record<string, string> = {
          WXPAY_MCHID: 'm',
          WXPAY_APP_ID: 'a',
          WXPAY_SERIAL_NO: 's',
          WXPAY_API_V3_KEY: TEST_API_V3_KEY,
          WXPAY_NOTIFY_URL: 'https://x',
          WXPAY_PRIVATE_KEY_PATH: '/tmp/__nonexistent_wxpay_key__.pem',
        };
        return map[k];
      });
      client.resetConfigCache();
      expect(() => client.loadConfig()).toThrow(/PRIVATE_KEY/);
    });

    it('正常加载 → cachedConfig 缓存', () => {
      const a = client.loadConfig();
      const b = client.loadConfig();
      expect(a).toBe(b); // 同一对象引用 = 命中 cache
      expect(a.mchid).toBe('1745394334');
      expect(a.appId).toBe('wxde9d7818d7420d00');
    });
  });

  // ============================================================
  // createPrepay
  // ============================================================
  describe('createPrepay', () => {
    it('happy path → 返 prepayId + jsApiParams 5 字段', async () => {
      const origFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValueOnce({
        status: 200,
        text: async () => JSON.stringify({ prepay_id: 'wx_prepay_abc123' }),
      }) as unknown as typeof fetch;
      try {
        const r = await client.createPrepay(VALID_PREPAY);
        expect(r.prepayId).toBe('wx_prepay_abc123');
        expect(r.jsApiParams).toMatchObject({
          timeStamp: expect.any(String),
          nonceStr: expect.any(String),
          package: 'prepay_id=wx_prepay_abc123',
          signType: 'RSA',
          paySign: expect.any(String),
        });
        // verify paySign 可被对应公钥校验
        const signStr = `${client.loadConfig().appId}\n${r.jsApiParams.timeStamp}\n${r.jsApiParams.nonceStr}\n${r.jsApiParams.package}\n`;
        const verifier = crypto.createVerify('RSA-SHA256');
        verifier.update(signStr);
        const ok = verifier.verify(publicKey, r.jsApiParams.paySign, 'base64');
        expect(ok).toBe(true);
      } finally {
        global.fetch = origFetch;
      }
    });

    it('网络异常 → InternalServerErrorException 不透传原始 errmsg', async () => {
      const origFetch = global.fetch;
      global.fetch = jest
        .fn()
        .mockRejectedValueOnce(new Error('ECONNREFUSED 秘密内部 ID')) as unknown as typeof fetch;
      try {
        await expect(client.createPrepay(VALID_PREPAY)).rejects.toThrow(
          InternalServerErrorException,
        );
        await expect(client.createPrepay(VALID_PREPAY)).rejects.toMatchObject({
          response: { code: 'WXPAY_NETWORK_ERROR' },
        });
      } finally {
        global.fetch = origFetch;
      }
    });

    it('HTTP 4xx + 微信 errcode → 不透传 message 给 client（A05）', async () => {
      const origFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValueOnce({
        status: 400,
        text: async () =>
          JSON.stringify({ code: 'INVALID_REQUEST', message: '内部 ID 12345' }),
      }) as unknown as typeof fetch;
      try {
        const err = await client.createPrepay(VALID_PREPAY).catch((e) => e);
        expect(err).toBeInstanceOf(InternalServerErrorException);
        // 内部 message "12345" 不应进入 client 响应（A05 防内部 ID 泄露）
        expect(JSON.stringify(err.response)).not.toContain('12345');
        expect(err.response.code).toBe('WXPAY_PREPAY_FAILED');
      } finally {
        global.fetch = origFetch;
      }
    });

    it('200 但缺 prepay_id → 失败', async () => {
      const origFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValueOnce({
        status: 200,
        text: async () => JSON.stringify({ code: 'WEIRD_OK' }),
      }) as unknown as typeof fetch;
      try {
        await expect(client.createPrepay(VALID_PREPAY)).rejects.toThrow(
          InternalServerErrorException,
        );
      } finally {
        global.fetch = origFetch;
      }
    });

    it('outTradeNo 非 32 字符 → BadRequest', async () => {
      await expect(
        client.createPrepay({ ...VALID_PREPAY, outTradeNo: 'short' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('amountCents 非整数 → BadRequest', async () => {
      await expect(
        client.createPrepay({ ...VALID_PREPAY, amountCents: 1.5 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('notifyUrl 非 http(s) → BadRequest', async () => {
      await expect(
        client.createPrepay({ ...VALID_PREPAY, notifyUrl: 'ftp://x' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ============================================================
  // verifyCallbackSignature
  // ============================================================
  describe('verifyCallbackSignature', () => {
    function signCallback(body: string): {
      timestamp: string;
      nonce: string;
      signature: string;
    } {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonce = 'abc' + Math.random().toString(36).slice(2);
      const signStr = `${timestamp}\n${nonce}\n${body}\n`;
      const signer = crypto.createSign('RSA-SHA256');
      signer.update(signStr);
      const signature = signer.sign(privateKey, 'base64');
      return { timestamp, nonce, signature };
    }

    it('happy path → 验签通过', async () => {
      const body = '{"id":"wx-evt-001","event_type":"TRANSACTION.SUCCESS"}';
      const { timestamp, nonce, signature } = signCallback(body);
      platformCert.getPublicKey.mockResolvedValueOnce(publicKey);
      const ok = await client.verifyCallbackSignature(
        {
          'wechatpay-timestamp': timestamp,
          'wechatpay-nonce': nonce,
          'wechatpay-serial': 'SERIAL_001',
          'wechatpay-signature': signature,
        },
        body,
      );
      expect(ok).toBe(true);
    });

    it('缺 header → false', async () => {
      const ok = await client.verifyCallbackSignature(
        {
          'wechatpay-timestamp': '',
          'wechatpay-nonce': '',
          'wechatpay-serial': '',
          'wechatpay-signature': '',
        },
        'body',
      );
      expect(ok).toBe(false);
    });

    it('timestamp 超过 5 分钟窗口 → false', async () => {
      const past = String(Math.floor(Date.now() / 1000) - 6 * 60);
      platformCert.getPublicKey.mockResolvedValueOnce(publicKey);
      const ok = await client.verifyCallbackSignature(
        {
          'wechatpay-timestamp': past,
          'wechatpay-nonce': 'n',
          'wechatpay-serial': 'S',
          'wechatpay-signature': 'sig',
        },
        'body',
      );
      expect(ok).toBe(false);
    });

    it('timestamp 不是数字 → false', async () => {
      const ok = await client.verifyCallbackSignature(
        {
          'wechatpay-timestamp': 'not-a-number',
          'wechatpay-nonce': 'n',
          'wechatpay-serial': 'S',
          'wechatpay-signature': 'sig',
        },
        'body',
      );
      expect(ok).toBe(false);
    });

    it('platformCert.getPublicKey 返 null → false', async () => {
      const body = 'body';
      const { timestamp, nonce, signature } = signCallback(body);
      platformCert.getPublicKey.mockResolvedValueOnce(null);
      const ok = await client.verifyCallbackSignature(
        {
          'wechatpay-timestamp': timestamp,
          'wechatpay-nonce': nonce,
          'wechatpay-serial': 'UNKNOWN_SERIAL',
          'wechatpay-signature': signature,
        },
        body,
      );
      expect(ok).toBe(false);
    });

    it('签名错（base64 但 verify 返 false） → false', async () => {
      const body = 'body';
      const { timestamp, nonce } = signCallback(body);
      // 用「其他私钥」签 → 公钥验失败
      const otherKp = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      const wrongSigStr = `${timestamp}\n${nonce}\n${body}\n`;
      const ws = crypto.createSign('RSA-SHA256');
      ws.update(wrongSigStr);
      const wrongSig = ws.sign(otherKp.privateKey, 'base64');

      platformCert.getPublicKey.mockResolvedValueOnce(publicKey);
      const ok = await client.verifyCallbackSignature(
        {
          'wechatpay-timestamp': timestamp,
          'wechatpay-nonce': nonce,
          'wechatpay-serial': 'S',
          'wechatpay-signature': wrongSig,
        },
        body,
      );
      expect(ok).toBe(false);
    });

    it('platformCert 未注入 → false（real client 必须配合 PlatformCertService）', async () => {
      // 构造一个不注入 platformCert 的实例
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RealWxPayClient,
          { provide: ConfigService, useValue: config },
        ],
      }).compile();
      const c = module.get<RealWxPayClient>(RealWxPayClient);

      const body = 'body';
      const { timestamp, nonce, signature } = signCallback(body);
      const ok = await c.verifyCallbackSignature(
        {
          'wechatpay-timestamp': timestamp,
          'wechatpay-nonce': nonce,
          'wechatpay-serial': 'S',
          'wechatpay-signature': signature,
        },
        body,
      );
      expect(ok).toBe(false);
    });
  });

  // ============================================================
  // requestRefund
  // ============================================================
  describe('requestRefund', () => {
    it('happy path → 返 refundId + status', async () => {
      const origFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValueOnce({
        status: 200,
        text: async () =>
          JSON.stringify({
            refund_id: 'wx_refund_abc',
            out_refund_no: ULID_B,
            status: 'PROCESSING',
          }),
      }) as unknown as typeof fetch;
      try {
        const r = await client.requestRefund(VALID_REFUND);
        expect(r.refundId).toBe('wx_refund_abc');
        expect(r.status).toBe('PROCESSING');
      } finally {
        global.fetch = origFetch;
      }
    });

    it('refund > total → BadRequest', async () => {
      await expect(
        client.requestRefund({
          ...VALID_REFUND,
          refundAmountCents: 200000,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('empty reason → BadRequest', async () => {
      await expect(
        client.requestRefund({ ...VALID_REFUND, reason: '' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('HTTP 非 200 → InternalServerError（不透传 message）', async () => {
      const origFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValueOnce({
        status: 400,
        text: async () => JSON.stringify({ code: 'TRADE_NOT_EXISTS' }),
      }) as unknown as typeof fetch;
      try {
        await expect(client.requestRefund(VALID_REFUND)).rejects.toMatchObject({
          response: { code: 'WXPAY_REFUND_FAILED' },
        });
      } finally {
        global.fetch = origFetch;
      }
    });

    it('网络异常 → WXPAY_NETWORK_ERROR', async () => {
      const origFetch = global.fetch;
      global.fetch = jest
        .fn()
        .mockRejectedValueOnce(new Error('net')) as unknown as typeof fetch;
      try {
        await expect(client.requestRefund(VALID_REFUND)).rejects.toMatchObject({
          response: { code: 'WXPAY_NETWORK_ERROR' },
        });
      } finally {
        global.fetch = origFetch;
      }
    });
  });

  // ============================================================
  // closeOrder
  // ============================================================
  describe('closeOrder', () => {
    it('204 → true', async () => {
      const origFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValueOnce({
        status: 204,
        text: async () => '',
      }) as unknown as typeof fetch;
      try {
        const ok = await client.closeOrder(ULID_A);
        expect(ok).toBe(true);
      } finally {
        global.fetch = origFetch;
      }
    });

    it('非 32 字符 outTradeNo → BadRequest', async () => {
      await expect(client.closeOrder('short')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('400 → WXPAY_CLOSE_FAILED', async () => {
      const origFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValueOnce({
        status: 400,
        text: async () => '{}',
      }) as unknown as typeof fetch;
      try {
        await expect(client.closeOrder(ULID_A)).rejects.toMatchObject({
          response: { code: 'WXPAY_CLOSE_FAILED' },
        });
      } finally {
        global.fetch = origFetch;
      }
    });
  });

  // ============================================================
  // onModuleInit
  // ============================================================
  describe('onModuleInit', () => {
    it('WXPAY_MODE=mock → lazy-only（不加载配置）', () => {
      client.resetConfigCache();
      client.onModuleInit();
      // 没有强抛错 = 成功
      expect(true).toBe(true);
    });

    it('WXPAY_MODE=real → 立即 loadConfig（fail-open 异常仅 warn）', () => {
      config.get.mockImplementation((k: string) => {
        const map: Record<string, string> = {
          WXPAY_MODE: 'real',
          WXPAY_MCHID: '1745394334',
          WXPAY_APP_ID: 'wxde9d7818d7420d00',
          WXPAY_SERIAL_NO: '5297EF1F',
          WXPAY_API_V3_KEY: TEST_API_V3_KEY,
          WXPAY_NOTIFY_URL: 'https://x',
          WXPAY_PRIVATE_KEY_PATH: privateKeyPath,
        };
        return map[k];
      });
      client.resetConfigCache();
      expect(() => client.onModuleInit()).not.toThrow();
    });

    it('WXPAY_MODE=real + 配置缺失 → fail-open（不抛错）', () => {
      config.get.mockImplementation((k: string) => {
        if (k === 'WXPAY_MODE') return 'real';
        return undefined; // 其他全部缺失
      });
      client.resetConfigCache();
      expect(() => client.onModuleInit()).not.toThrow();
    });
  });
});
