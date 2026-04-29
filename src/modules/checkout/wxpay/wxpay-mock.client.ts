import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import {
  WxPayClient,
  CreatePrepayParams,
  CreatePrepayResult,
  CallbackHeaders,
  RefundParams,
  RefundResult,
} from './wxpay.types';

/**
 * Mock 实现（W2-T1）— EXT-01 商户号到位前的 sandbox 实现
 *
 * 用途：
 *   - W0-W1 阶段开发自测 + e2e 测试
 *   - 测试方在 EXT-01 解除前可用 mock 路径跑 W2-T1/T2/T3 主链路冒烟
 *
 * §0 不猜测严守：
 *   - 仅复现微信 V3 协议的字段结构，不模拟随机失败 / 网络抖动等"业务可能"行为
 *   - 真实签名算法 / 证书链 / 序列号比对在 RealWxPayClient 落地（EXT-01 解除后）
 *
 * 项目隔离（追加 #8）：本类不引用企业管理系统主项目任何支付逻辑
 */
@Injectable()
export class MockWxPayClient implements WxPayClient {
  private readonly logger = new Logger(MockWxPayClient.name);

  async createPrepay(params: CreatePrepayParams): Promise<CreatePrepayResult> {
    this.validatePrepay(params);
    const prepayId = `mock_prepay_${params.outTradeNo}_${Date.now()}`;
    this.logger.warn(
      `[W2-T1 MOCK] createPrepay outTradeNo=${params.outTradeNo} amount=${params.amountCents} → prepayId=${prepayId}`,
    );
    return {
      prepayId,
      jsApiParams: {
        timeStamp: String(Math.floor(Date.now() / 1000)),
        nonceStr: 'mock_' + Math.random().toString(36).substring(2, 18),
        package: `prepay_id=${prepayId}`,
        signType: 'RSA',
        paySign: 'mock_signature_real_signing_requires_EXT-01',
      },
    };
  }

  async verifyCallbackSignature(headers: CallbackHeaders, _rawBody: string): Promise<boolean> {
    // Mock：所有 mock_* 序列号通过，其他拒绝
    const isMock = headers['wechatpay-serial']?.startsWith('mock_');
    this.logger.warn(`[W2-T1 MOCK] verifyCallbackSignature serial=${headers['wechatpay-serial']} → ${isMock}`);
    return Boolean(isMock);
  }

  async requestRefund(params: RefundParams): Promise<RefundResult> {
    this.validateRefund(params);
    const refundId = `mock_refund_${params.outRefundNo}_${Date.now()}`;
    this.logger.warn(
      `[W2-T1 MOCK] requestRefund outRefundNo=${params.outRefundNo} amount=${params.refundAmountCents}/${params.totalAmountCents} → ${refundId}`,
    );
    return { refundId, status: 'PROCESSING' };
  }

  private validatePrepay(p: CreatePrepayParams): void {
    if (!p.outTradeNo || p.outTradeNo.length !== 32) {
      throw new BadRequestException('outTradeNo must be 32-char ULID');
    }
    if (!p.openid) throw new BadRequestException('openid required');
    if (!Number.isInteger(p.amountCents) || p.amountCents <= 0) {
      throw new BadRequestException('amountCents must be positive integer');
    }
    if (!p.description) throw new BadRequestException('description required');
    if (!p.notifyUrl?.startsWith('http')) throw new BadRequestException('notifyUrl must be http(s)');
  }

  private validateRefund(p: RefundParams): void {
    if (!p.outTradeNo || p.outTradeNo.length !== 32) {
      throw new BadRequestException('outTradeNo must be 32-char ULID');
    }
    if (!p.outRefundNo || p.outRefundNo.length !== 32) {
      throw new BadRequestException('outRefundNo must be 32-char ULID');
    }
    if (p.refundAmountCents <= 0 || p.refundAmountCents > p.totalAmountCents) {
      throw new BadRequestException('refundAmount must be in (0, totalAmount]');
    }
    if (!p.reason) throw new BadRequestException('reason required (A04 §3)');
  }
}
