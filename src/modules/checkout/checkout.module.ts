import { Module } from '@nestjs/common';
import { WxPayModule } from './wxpay/wxpay.module';
import { PaymentOrderStateService } from './payment-order-state.service';
import { RefundService } from './refund.service';
import { InvoiceService } from './invoice.service';
import { PlatformReviewService } from './platform-review.service';
import { CheckoutService } from './checkout.service';
import { CheckoutController } from './checkout.controller';
import { WxPayController } from './wxpay.controller';

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
  // PM-AUTH-6(2026-04-30): CheckoutController W3-1 Phase 1.3 — 4 SKU 价格表 / 订单 HTTP 暴露
  // W2-T1(2026-05-14): WxPayController 4 endpoint（unified-order / callback / close-order / refund）
  controllers: [CheckoutController, WxPayController],
  // PM-AUTH-6(2026-04-30): CheckoutService W3-1 Phase 1.3 — 4 SKU 价格表 + 订单生成（条目 14 BE-W3-3）
  providers: [PaymentOrderStateService, RefundService, InvoiceService, PlatformReviewService, CheckoutService],
  exports: [
    PaymentOrderStateService,
    RefundService,
    InvoiceService,
    PlatformReviewService,
    CheckoutService,
    WxPayModule,
  ],
})
export class CheckoutModule {}
