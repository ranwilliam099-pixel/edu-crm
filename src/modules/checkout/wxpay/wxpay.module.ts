import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MockWxPayClient } from './wxpay-mock.client';
import { WxPayCallbackService } from './wxpay-callback.service';
import { RealWxPayClient } from './wxpay-real.client';
import { WxPayPlatformCertService } from './wxpay-platform-cert.service';
import { WX_PAY_CLIENT } from './wxpay.types';

/**
 * 微信支付 V3 模块（W2-T1 + 2026-05-14 Real 实现落地）
 *
 * 提供 WxPayClient（注入 token = WX_PAY_CLIENT）：
 *   - WXPAY_MODE=mock：返回 MockWxPayClient（单测 + EXT-01 商户号到位前用）
 *   - WXPAY_MODE=real：返回 RealWxPayClient（生产；2026-05-14 凭据已到位）
 *
 * 同时注册：
 *   - WxPayPlatformCertService — 微信平台公钥获取（real 模式 verifyCallbackSignature 依赖）
 *   - WxPayCallbackService — 回调签名校验 + 状态推进
 *
 * §0 不猜测严守：
 *   - WXPAY_MODE 默认 mock；生产 .env 显式切 real
 *   - real 模式 ConfigService 缺凭据 → 启动期 logger.warn（fail-open），首次调用时再尝试
 */
@Module({
  providers: [
    // mock + real 都注册，DI 工厂按 WXPAY_MODE 选
    MockWxPayClient,
    RealWxPayClient,
    WxPayPlatformCertService,
    {
      provide: WX_PAY_CLIENT,
      inject: [ConfigService, MockWxPayClient, RealWxPayClient],
      useFactory: (
        config: ConfigService,
        mock: MockWxPayClient,
        real: RealWxPayClient,
      ) => {
        const mode = config.get<string>('WXPAY_MODE', 'mock');
        if (mode === 'real') return real;
        // 默认 mock（单测 + 未配凭据场景 + 老接口）
        return mock;
      },
    },
    // PM-AUTH-2(2026-04-30): WxPayCallbackService W3-1 Phase 2.2 — 回调通知处理（条目 14 BE-W3-4）
    WxPayCallbackService,
  ],
  exports: [
    WX_PAY_CLIENT,
    WxPayCallbackService,
    // RealWxPayClient 直接 export 给 controller 调用 closeOrder（不在 WxPayClient 接口里）
    RealWxPayClient,
    WxPayPlatformCertService,
  ],
})
export class WxPayModule {}
