import { Module } from '@nestjs/common';
import { BusinessMetricsService } from './business-metrics.service';
import { BusinessMetricsInterceptor } from './business-metrics.interceptor';
import { RedisModule } from '../../modules/redis/redis.module';
import { AlertModule } from '../alert/alert.module';

/**
 * BusinessMetricsModule (L7 v2.0 §3.L7) — 业务关键路径成功率监控
 *
 * 用法：
 *   3 个关键路径 controller 内 @UseInterceptors(BusinessMetricsInterceptor)
 *   - customer.controller (POST /db/customers)
 *   - wxpay.controller (POST /checkout/wxpay/unified-order)
 *   - auth.controller (POST /public/auth/login)
 *
 * 不全局注册原因：
 *   - 避免影响所有 endpoint 性能
 *   - 测试复杂度（每个 spec 都要 mock interceptor）
 *   - 仅监控真业务关键路径
 *
 * cron 调用（cron-jobs.service 每 5min）：
 *   businessMetrics.checkErrorRateThresholds()
 *
 * 依赖：
 *   - RedisService (fail-open)
 *   - AlertService (fail-open)
 */
@Module({
  imports: [RedisModule, AlertModule],
  providers: [BusinessMetricsService, BusinessMetricsInterceptor],
  exports: [BusinessMetricsService, BusinessMetricsInterceptor],
})
export class BusinessMetricsModule {}
