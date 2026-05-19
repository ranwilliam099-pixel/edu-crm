/**
 * WxPayCallbackService 单元测试 — W3-1 Phase 2.2 BE-W3-4
 *
 * PM-AUTH-2(2026-04-30): mock 全链路黄路径
 *
 * 覆盖：
 *   - 支付成功回调（验签通过 + 金额匹配 → 已支付）
 *   - 退款成功回调（验签通过 → 已退款）
 *   - 验签失败 → UnauthorizedException
 *   - 金额不匹配 → BadRequestException
 *   - trade_state 非 SUCCESS → BadRequestException
 *   - 字段缺失 → BadRequestException
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import {
  WxPayCallbackService,
  WxPayNotifyBody,
  RefundNotifyBody,
} from './wxpay-callback.service';
import { MockWxPayClient } from './wxpay-mock.client';
import { WX_PAY_CLIENT, CallbackHeaders } from './wxpay.types';

const ULID32_TRADE = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNOP';
const ULID32_REFUND = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNOQ';

const mockHeaders: CallbackHeaders = {
  'wechatpay-timestamp': '1714450000',
  'wechatpay-nonce': 'mock_nonce_abc',
  'wechatpay-serial': 'mock_serial_001',
  'wechatpay-signature': 'mock_sig',
};

const realHeaders: CallbackHeaders = {
  'wechatpay-timestamp': '1714450000',
  'wechatpay-nonce': 'real_nonce',
  'wechatpay-serial': 'real_serial_999',
  'wechatpay-signature': 'real_sig',
};

const validNotify: WxPayNotifyBody = {
  out_trade_no: ULID32_TRADE,
  trade_state: 'SUCCESS',
  amount: { total: 199900, payer_total: 199900, currency: 'CNY', payer_currency: 'CNY' },
  payer: { openid: 'oXyz123' },
  transaction_id: 'wx_txn_abc123',
};

const validRefundNotify: RefundNotifyBody = {
  out_trade_no: ULID32_TRADE,
  out_refund_no: ULID32_REFUND,
  refund_id: 'wx_refund_001',
  refund_status: 'SUCCESS',
  amount: { total: 199900, refund: 199900, payer_total: 199900, payer_refund: 199900 },
};

describe('WxPayCallbackService', () => {
  let service: WxPayCallbackService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WxPayCallbackService,
        { provide: WX_PAY_CLIENT, useClass: MockWxPayClient },
      ],
    }).compile();
    service = module.get<WxPayCallbackService>(WxPayCallbackService);
  });

  describe('handlePaymentNotify - PM-AUTH-2 黄路径', () => {
    it('mock 序列号 + 金额匹配 → 已支付', async () => {
      const result = await service.handlePaymentNotify(mockHeaders, '{}', validNotify, 199900);
      expect(result.shouldTransitTo).toBe('已支付');
      expect(result.outTradeNo).toBe(ULID32_TRADE);
      expect(result.amountCents).toBe(199900);
      expect(result.openid).toBe('oXyz123');
      expect(result.transactionId).toBe('wx_txn_abc123');
    });

    it('非 mock 序列号 → UnauthorizedException', async () => {
      await expect(
        service.handlePaymentNotify(realHeaders, '{}', validNotify, 199900),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('out_trade_no 长度非 32 → BadRequestException', async () => {
      const bad = { ...validNotify, out_trade_no: 'short' };
      await expect(
        service.handlePaymentNotify(mockHeaders, '{}', bad, 199900),
      ).rejects.toThrow(BadRequestException);
    });

    it('trade_state 非 SUCCESS → BadRequestException', async () => {
      const bad = { ...validNotify, trade_state: 'NOTPAY' as const };
      await expect(
        service.handlePaymentNotify(mockHeaders, '{}', bad, 199900),
      ).rejects.toThrow(BadRequestException);
    });

    it('amount.total 缺失 → BadRequestException', async () => {
      const bad = { ...validNotify, amount: undefined as any };
      await expect(
        service.handlePaymentNotify(mockHeaders, '{}', bad, 199900),
      ).rejects.toThrow(BadRequestException);
    });

    it('金额不匹配 → BadRequestException', async () => {
      await expect(
        service.handlePaymentNotify(mockHeaders, '{}', validNotify, 100000),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('handleRefundNotify - PM-AUTH-2 退款黄路径', () => {
    it('mock 序列号 + 退款成功 → 已退款', async () => {
      const result = await service.handleRefundNotify(mockHeaders, '{}', validRefundNotify);
      expect(result.shouldTransitTo).toBe('已退款');
      expect(result.outTradeNo).toBe(ULID32_TRADE);
      expect(result.outRefundNo).toBe(ULID32_REFUND);
      expect(result.refundAmountCents).toBe(199900);
    });

    it('非 mock 序列号 → UnauthorizedException', async () => {
      await expect(
        service.handleRefundNotify(realHeaders, '{}', validRefundNotify),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('out_refund_no 长度非 32 → BadRequestException', async () => {
      const bad = { ...validRefundNotify, out_refund_no: 'short' };
      await expect(
        service.handleRefundNotify(mockHeaders, '{}', bad),
      ).rejects.toThrow(BadRequestException);
    });

    it('refund_status 非 SUCCESS → BadRequestException', async () => {
      const bad = { ...validRefundNotify, refund_status: 'CLOSED' as const };
      await expect(
        service.handleRefundNotify(mockHeaders, '{}', bad),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
