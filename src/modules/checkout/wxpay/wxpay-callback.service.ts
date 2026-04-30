import { Injectable, Logger, Inject, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { WX_PAY_CLIENT, WxPayClient, CallbackHeaders } from './wxpay.types';

/**
 * WxPayCallbackService — W3-1 Phase 2.2 BE-W3-4 回调通知处理
 *
 * 来源：
 *   - 《全部人员-审核往来总台账.md》条目 14 §B Track CODE-1 BE-W3-4
 *   - AUTH-2 EXT-01 挂账期间 wxpay V3 全链路按 mock 实现
 *   - 微信 V3 协议：支付成功 / 退款成功 异步回调
 *
 * PM-AUTH-2(2026-04-30): EXT-01 商户号到位前的 mock 全链路
 *
 * 黄路径覆盖：
 *   1. 收到回调 → verifyCallbackSignature 验签
 *   2. 解析回调 body（JSON 含 trade_state / amount / out_trade_no / openid 等）
 *   3. 校验金额匹配
 *   4. 推进 payment_orders 状态机（待支付 → 已支付 / 退款处理中 → 已退款）
 *
 * 严守边界：
 *   1. 不真实 INSERT/UPDATE DB（由 W3-3 拓展期 + OrderRepository 落地）
 *   2. mock 模式下接受 mock_* 序列号；非 mock 序列号在 EXT-01 解除前一律拒绝
 *   3. 不假设业务路径之外的状态推进
 */

export interface WxPayNotifyBody {
  // 解密后的明文 resource（含支付状态）
  out_trade_no: string;
  trade_state: 'SUCCESS' | 'REFUND' | 'NOTPAY' | 'CLOSED' | 'REVOKED' | 'USERPAYING' | 'PAYERROR';
  amount: {
    total: number; // 分
    payer_total: number;
    currency: string;
    payer_currency: string;
  };
  payer?: {
    openid: string;
  };
  transaction_id?: string;
  bank_type?: string;
  success_time?: string;
}

export interface RefundNotifyBody {
  out_trade_no: string;
  out_refund_no: string;
  refund_id: string;
  refund_status: 'SUCCESS' | 'CLOSED' | 'ABNORMAL';
  amount: {
    total: number;
    refund: number;
    payer_total: number;
    payer_refund: number;
  };
  success_time?: string;
}

export interface PaymentNotifyResult {
  outTradeNo: string;
  shouldTransitTo: '已支付';
  amountCents: number;
  openid?: string;
  transactionId?: string;
}

export interface RefundNotifyResult {
  outTradeNo: string;
  outRefundNo: string;
  shouldTransitTo: '已退款';
  refundAmountCents: number;
}

@Injectable()
export class WxPayCallbackService {
  private readonly logger = new Logger(WxPayCallbackService.name);

  constructor(@Inject(WX_PAY_CLIENT) private readonly client: WxPayClient) {}

  /**
   * 处理支付成功回调（payment notify）
   *
   * PM-AUTH-2(2026-04-30): mock 模式黄路径
   *
   * @returns 应执行的状态推进动作（由调用方真实更新 payment_orders 表）
   * @throws UnauthorizedException 验签失败
   * @throws BadRequestException 金额不匹配 / 状态非 SUCCESS / body 缺字段
   */
  async handlePaymentNotify(
    headers: CallbackHeaders,
    rawBody: string,
    notifyBody: WxPayNotifyBody,
    expectedAmountCents: number,
  ): Promise<PaymentNotifyResult> {
    const valid = await this.client.verifyCallbackSignature(headers, rawBody);
    if (!valid) {
      this.logger.warn(`[BE-W3-4] verifyCallbackSignature failed serial=${headers['wechatpay-serial']}`);
      throw new UnauthorizedException('Invalid wxpay callback signature');
    }

    if (!notifyBody.out_trade_no || notifyBody.out_trade_no.length !== 32) {
      throw new BadRequestException('out_trade_no must be 32-char ULID');
    }

    if (notifyBody.trade_state !== 'SUCCESS') {
      throw new BadRequestException(
        `Only SUCCESS notify processed in handlePaymentNotify; got ${notifyBody.trade_state}`,
      );
    }

    if (!notifyBody.amount || typeof notifyBody.amount.total !== 'number') {
      throw new BadRequestException('amount.total missing in notify body');
    }

    if (notifyBody.amount.total !== expectedAmountCents) {
      throw new BadRequestException(
        `Amount mismatch: expected ${expectedAmountCents} cents, got ${notifyBody.amount.total}`,
      );
    }

    this.logger.log(
      `[BE-W3-4] handlePaymentNotify SUCCESS outTradeNo=${notifyBody.out_trade_no} amount=${notifyBody.amount.total}`,
    );

    return {
      outTradeNo: notifyBody.out_trade_no,
      shouldTransitTo: '已支付',
      amountCents: notifyBody.amount.total,
      openid: notifyBody.payer?.openid,
      transactionId: notifyBody.transaction_id,
    };
  }

  /**
   * 处理退款成功回调（refund notify）
   *
   * PM-AUTH-2(2026-04-30): mock 模式黄路径
   *
   * @returns 应执行的状态推进动作（由调用方真实更新 payment_refunds + payment_orders 表）
   * @throws UnauthorizedException 验签失败
   * @throws BadRequestException 状态非 SUCCESS / body 缺字段
   */
  async handleRefundNotify(
    headers: CallbackHeaders,
    rawBody: string,
    notifyBody: RefundNotifyBody,
  ): Promise<RefundNotifyResult> {
    const valid = await this.client.verifyCallbackSignature(headers, rawBody);
    if (!valid) {
      throw new UnauthorizedException('Invalid wxpay refund callback signature');
    }

    if (!notifyBody.out_trade_no || notifyBody.out_trade_no.length !== 32) {
      throw new BadRequestException('out_trade_no must be 32-char ULID');
    }

    if (!notifyBody.out_refund_no || notifyBody.out_refund_no.length !== 32) {
      throw new BadRequestException('out_refund_no must be 32-char ULID');
    }

    if (notifyBody.refund_status !== 'SUCCESS') {
      throw new BadRequestException(
        `Only SUCCESS refund notify processed; got ${notifyBody.refund_status}`,
      );
    }

    if (!notifyBody.amount || typeof notifyBody.amount.refund !== 'number') {
      throw new BadRequestException('amount.refund missing in refund notify body');
    }

    this.logger.log(
      `[BE-W3-4] handleRefundNotify SUCCESS outTradeNo=${notifyBody.out_trade_no} refundNo=${notifyBody.out_refund_no} amount=${notifyBody.amount.refund}`,
    );

    return {
      outTradeNo: notifyBody.out_trade_no,
      outRefundNo: notifyBody.out_refund_no,
      shouldTransitTo: '已退款',
      refundAmountCents: notifyBody.amount.refund,
    };
  }
}
