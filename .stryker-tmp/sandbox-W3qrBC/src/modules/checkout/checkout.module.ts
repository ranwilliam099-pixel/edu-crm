import { Module } from '@nestjs/common';
import { WxPayModule } from './wxpay/wxpay.module';
import { CheckoutInvoiceService } from './invoice.service';
import { CheckoutService } from './checkout.service';
import { CheckoutController } from './checkout.controller';
import { WxPayController } from './wxpay.controller';

/**
 * Checkout 模块（W2 主链路骨架）
 *
 * 当前注册：
 *   - WxPayModule（W2-T1，导出 WX_PAY_CLIENT for DI；微信支付 V3 生产 live 2026-05-14）
 *   - CheckoutService / CheckoutInvoiceService（C 端自助开票 5-state FSM）
 *   - CheckoutController（4 SKU 价格表 + 订单 HTTP 暴露）
 *   - WxPayController（unified-order / callback / close-order / refund，4 endpoint）
 *
 * T-DEADCODE-CLEANUP (2026-05-17): 删除 3 个 dead service（3-agent triple-verify 共识）
 *   - PaymentOrderStateService：唯一调用者 LifecycleScheduler 整模块已删
 *   - RefundService：唯一调用者 PlatformReviewService 已删（传递性死）
 *   - PlatformReviewService：0 controller 暴露，admin 模块已用 AdminTenantService 替代
 *   详见 6 agent audit verdict + G1 三方共识矩阵
 *
 * Backlog（不本次做）：
 *   - W2-T4 RefundController（A04 §3 退款流程，admin 模块已实现部分）
 *   - W2-T5 InvoiceController（A04 §4，invoice/ B 端模块已实现 finance 域）
 *   - W2-T6 PlatformReviewController（A11 平台超管，admin 模块已实现部分）
 */
@Module({
  imports: [WxPayModule],
  controllers: [CheckoutController, WxPayController],
  providers: [CheckoutInvoiceService, CheckoutService],
  exports: [CheckoutInvoiceService, CheckoutService, WxPayModule],
})
export class CheckoutModule {}
