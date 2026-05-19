import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { WxPayModule } from './wxpay.module';
import { MockWxPayClient } from './wxpay-mock.client';
import { RealWxPayClient } from './wxpay-real.client';
import { WxPayPlatformCertService } from './wxpay-platform-cert.service';
import { WxPayCallbackService } from './wxpay-callback.service';
import { WxPayCertMonitorService } from './wxpay-cert-monitor.service';
import { WX_PAY_CLIENT, WxPayClient } from './wxpay.types';

/**
 * WxPayModule 单元测试 — W2-T1
 *
 * 覆盖：
 *   - WXPAY_MODE=mock → WX_PAY_CLIENT 注入 MockWxPayClient
 *   - WXPAY_MODE=real → WX_PAY_CLIENT 注入 RealWxPayClient
 *   - WXPAY_MODE 缺失（默认）→ MockWxPayClient
 *   - WxPayCallbackService 可注入
 *   - WxPayPlatformCertService 可注入
 *
 * 不覆盖：
 *   - 实际 WxPayClient 接口契约（在 mock / real spec 单独测）
 *   - onModuleInit 拉证书（在 platform-cert spec 单独测）
 */

async function buildModule(envMode?: string): Promise<TestingModule> {
  // 通过 ConfigModule.forRoot 直接传 env load 函数
  const envMap = envMode !== undefined ? { WXPAY_MODE: envMode } : {};
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        load: [() => envMap],
        ignoreEnvFile: true,
      }),
      WxPayModule,
    ],
  }).compile();
}

describe('WxPayModule (W2-T1)', () => {
  describe('WXPAY_MODE=mock', () => {
    it('WX_PAY_CLIENT === MockWxPayClient 实例', async () => {
      const module = await buildModule('mock');
      const client = module.get<WxPayClient>(WX_PAY_CLIENT);
      const mock = module.get(MockWxPayClient);
      expect(client).toBe(mock);
      await module.close();
    });

    it('未配置（缺失）→ 默认 mock', async () => {
      const module = await buildModule(undefined);
      const client = module.get<WxPayClient>(WX_PAY_CLIENT);
      const mock = module.get(MockWxPayClient);
      expect(client).toBe(mock);
      await module.close();
    });

    it('未知值（如 sandbox）→ fallback mock', async () => {
      const module = await buildModule('sandbox');
      const client = module.get<WxPayClient>(WX_PAY_CLIENT);
      const mock = module.get(MockWxPayClient);
      expect(client).toBe(mock);
      await module.close();
    });
  });

  describe('WXPAY_MODE=real', () => {
    it('WX_PAY_CLIENT === RealWxPayClient 实例', async () => {
      const module = await buildModule('real');
      const client = module.get<WxPayClient>(WX_PAY_CLIENT);
      const real = module.get(RealWxPayClient);
      expect(client).toBe(real);
      await module.close();
    });

    it('生产 ConfigService 缺凭据 → 启动期 fail-open 不抛错', async () => {
      // ConfigService 没配 WXPAY_MCHID 等 → RealWxPayClient.onModuleInit
      // 应仅 logger.warn 不抛
      // （NestJS init 阶段同步执行 onModuleInit，本测试通过 buildModule 不抛 = 通过）
      const module = await buildModule('real');
      expect(module.get(RealWxPayClient)).toBeDefined();
      await module.close();
    });
  });

  describe('common providers', () => {
    it('WxPayCallbackService 可注入', async () => {
      const module = await buildModule('mock');
      expect(module.get(WxPayCallbackService)).toBeDefined();
      await module.close();
    });

    it('WxPayPlatformCertService 可注入', async () => {
      const module = await buildModule('mock');
      expect(module.get(WxPayPlatformCertService)).toBeDefined();
      await module.close();
    });

    it('ConfigService 全局可用', async () => {
      const module = await buildModule('mock');
      const config = module.get(ConfigService);
      expect(config.get('WXPAY_MODE')).toBe('mock');
      await module.close();
    });

    // T14 §3：cert-monitor 注册校验（Runtime Wiring 防 A3 audit B8 死代码教训）
    it('WxPayCertMonitorService 注册并可注入', async () => {
      const module = await buildModule('mock');
      const monitor = module.get(WxPayCertMonitorService);
      expect(monitor).toBeDefined();
      expect(typeof monitor.checkMerchantCertExpiry).toBe('function');
      expect(typeof monitor.readCertExpiry).toBe('function');
      expect(typeof monitor.handleExpiry).toBe('function');
      await module.close();
    });
  });
});
