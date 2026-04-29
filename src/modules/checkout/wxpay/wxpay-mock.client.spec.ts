import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { MockWxPayClient } from './wxpay-mock.client';
import type { CreatePrepayParams, RefundParams } from './wxpay.types';

const ULID_32_A = '01HRX5Y3K2NQVWGT7ABCDEFGHJKMNP00';
const ULID_32_B = '01HRX5Y3K2NQVWGT7ABCDEFGHJKMNP01';

describe('MockWxPayClient (W2-T1)', () => {
  let client: MockWxPayClient;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MockWxPayClient],
    }).compile();
    client = module.get<MockWxPayClient>(MockWxPayClient);
  });

  describe('createPrepay()', () => {
    const valid: CreatePrepayParams = {
      outTradeNo: ULID_32_A,
      openid: 'oTest_xxxxxxxx',
      amountCents: 199900, // 1999 元 = 199900 分
      description: '教育培训行业销售 CRM 标准版年费',
      notifyUrl: 'https://api.example.com/api/checkout/callbacks/wxpay',
    };

    it('returns prepayId starting with mock_prepay_', async () => {
      const r = await client.createPrepay(valid);
      expect(r.prepayId.startsWith('mock_prepay_')).toBe(true);
    });

    it('returns 5 jsApiParams fields', async () => {
      const r = await client.createPrepay(valid);
      expect(r.jsApiParams).toMatchObject({
        timeStamp: expect.any(String),
        nonceStr: expect.any(String),
        package: expect.stringMatching(/^prepay_id=mock_prepay_/),
        signType: 'RSA',
        paySign: expect.any(String),
      });
    });

    it('rejects non-ULID outTradeNo', async () => {
      await expect(client.createPrepay({ ...valid, outTradeNo: 'short' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects negative amount', async () => {
      await expect(client.createPrepay({ ...valid, amountCents: -1 })).rejects.toThrow();
    });

    it('rejects non-integer amount', async () => {
      await expect(client.createPrepay({ ...valid, amountCents: 1.5 })).rejects.toThrow();
    });

    it('rejects non-http notifyUrl', async () => {
      await expect(client.createPrepay({ ...valid, notifyUrl: 'ftp://bad' })).rejects.toThrow();
    });
  });

  describe('verifyCallbackSignature()', () => {
    const baseHeaders = {
      'wechatpay-timestamp': '1700000000',
      'wechatpay-nonce': 'abc123',
      'wechatpay-signature': 'sig',
    };

    it('accepts mock_* serial', async () => {
      expect(
        await client.verifyCallbackSignature(
          { ...baseHeaders, 'wechatpay-serial': 'mock_serial_123' },
          '{"some":"body"}',
        ),
      ).toBe(true);
    });

    it('rejects non-mock serial (defense for W2 real path)', async () => {
      expect(
        await client.verifyCallbackSignature(
          { ...baseHeaders, 'wechatpay-serial': 'real_cert_xyz' },
          '{"some":"body"}',
        ),
      ).toBe(false);
    });
  });

  describe('requestRefund()', () => {
    const valid: RefundParams = {
      outTradeNo: ULID_32_A,
      outRefundNo: ULID_32_B,
      refundAmountCents: 50000,
      totalAmountCents: 199900,
      reason: '客户申请全额退款（A04 §3）',
    };

    it('returns PROCESSING status with mock refundId', async () => {
      const r = await client.requestRefund(valid);
      expect(r.status).toBe('PROCESSING');
      expect(r.refundId.startsWith('mock_refund_')).toBe(true);
    });

    it('rejects refund > total', async () => {
      await expect(
        client.requestRefund({ ...valid, refundAmountCents: 200000 }),
      ).rejects.toThrow();
    });

    it('rejects empty reason (A04 §3 required)', async () => {
      await expect(client.requestRefund({ ...valid, reason: '' })).rejects.toThrow(
        /reason.*A04/,
      );
    });
  });
});
