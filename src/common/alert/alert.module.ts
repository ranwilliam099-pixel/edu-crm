import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AlertService } from './alert.service';

/**
 * AlertModule — 全局告警（生产架构 P0 第 8 项）
 *
 * 全局注入：
 *   constructor(private readonly alert: AlertService) {}
 *   await this.alert.error('Title', 'Body', { dedupKey: 'foo', context: { ... } });
 *
 * 配合：
 *   - GlobalExceptionFilter 5xx 自动响
 *   - cron 任务失败响
 *   - 业务监控（注册失败率 / 支付失败 / etc）
 *
 * 依赖：
 *   - RedisService（dedup 防 spam）→ 已是 @Global，自动可用
 *   - ConfigService（读 webhook URL）
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [AlertService],
  exports: [AlertService],
})
export class AlertModule {}
