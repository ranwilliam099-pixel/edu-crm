import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MockWxPayClient } from './wxpay-mock.client';
import { WX_PAY_CLIENT } from './wxpay.types';

/**
 * 微信支付 V3 模块（W2-T1）
 *
 * 提供 WxPayClient（注入 token = WX_PAY_CLIENT）：
 *   - WXPAY_MODE=mock：返回 MockWxPayClient（默认，EXT-01 商户号到位前）
 *   - WXPAY_MODE=real：返回 RealWxPayClient（待 W2-T1 后续 commit 落地）
 *
 * §0 不猜测严守：
 *   - WXPAY_MODE 默认 mock；产品经理 / 项目经理在 EXT-01 解除后显式切 real
 *   - real 实现的私钥 / 证书 / 商户号读取逻辑等 EXT-01 凭据到位后再写
 */
@Module({
  providers: [
    MockWxPayClient,
    {
      provide: WX_PAY_CLIENT,
      inject: [ConfigService, MockWxPayClient],
      useFactory: (config: ConfigService, mock: MockWxPayClient) => {
        const mode = config.get<string>('WXPAY_MODE', 'mock');
        if (mode === 'mock') return mock;
        // real 模式：throw 直到 EXT-01 解除
        throw new Error(
          `WXPAY_MODE=${mode} but RealWxPayClient not yet implemented (EXT-01 商户号待解除)`,
        );
      },
    },
  ],
  exports: [WX_PAY_CLIENT],
})
export class WxPayModule {}
