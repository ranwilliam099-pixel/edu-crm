import { Module } from '@nestjs/common';
import { WxPayModule } from './wxpay/wxpay.module';
import { PaymentOrderStateService } from './payment-order-state.service';
import { RefundService } from './refund.service';
import { InvoiceService } from './invoice.service';
import { PlatformReviewService } from './platform-review.service';

/**
 * Checkout 模块（W2 主链路骨架）
 *
 * 当前注册：
 *   - WxPayModule（W2-T1，导出 WX_PAY_CLIENT for DI）
 *   - PaymentOrderStateService（W2-T2，状态机守护）
 *
 * 待 W2 后续 commit 落地：
 *   - W2-T3 PrepayController（创建预支付订单 → 调 WxPayClient.createPrepay）
 *   - W2-T3 WxPayCallbackController（回调签名校验 + payment_orders 状态机推进）
 *   - W2-T4 RefundController + RefundService（退款申请，A04 §3）
 *   - W2-T5 InvoiceController + InvoiceService（发票申请，A04 §4）
 *   - W2-T6 PlatformReviewController（平台超管手工审批退款/发票，A11）
 *
 * §0 不猜测严守：以上 controller / service 待产品 + 项目经理对 W2 业务流程
 * 完整规约后再补；当前仅暴露状态机与 wxpay client，避免业务路径假设错配。
 */
@Module({
  imports: [WxPayModule],
  providers: [PaymentOrderStateService, RefundService, InvoiceService, PlatformReviewService],
  exports: [
    PaymentOrderStateService,
    RefundService,
    InvoiceService,
    PlatformReviewService,
    WxPayModule,
  ],
})
export class CheckoutModule {}
