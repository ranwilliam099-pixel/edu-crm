import { Module } from '@nestjs/common';
import { ScheduleModule as NestScheduleModule } from '@nestjs/schedule';
import { CronJobsService } from './cron-jobs.service';
import { CronController } from './cron.controller';
import { FeedbackModule } from '../feedback/feedback.module';
import { ParentModule } from '../parent/parent.module';
import { ScheduleModule } from '../schedule/schedule.module';

/**
 * Cron 模块（W3-1 收尾 — 全局定时任务编排）
 *
 * USER-AUTH(2026-05-02): 接 V9/V10/V8.1 的所有 cron 任务（PD 设计稿 §3.6.4 / §4.2 / §4.3 / §5.5）
 *
 * T7 (2026-05-16) 选项 1：装 @nestjs/schedule + NestScheduleModule.forRoot()
 *   - 别名 import 避免与 ../schedule/schedule.module.ts 业务 ScheduleModule 命名冲突
 *   - T-DEPLOY-FIX-1 round 2 (2026-05-16 comment-analyzer)：原 "当前未加 @Cron 装饰器" 已 stale
 *     T9-EPIC commit e06a33d 装了 @Cron('30 3 * * *', { name: 'trial-expiry' }) 在 cron-jobs.service.ts:332
 *     RefreshTokenService @Cron('0 3 * * *') cleanupExpired
 *     WxPayCertMonitorService @Cron('0 8 * * 1', { name: 'wxpay-cert-check' })
 *     forRoot() 注册的 SchedulerOrchestrator 全局扫描所有 provider @Cron 装饰器
 *   - 其余 cron 方法仍 HTTP 触发（CronController 3 endpoint：expire-promotions/expire-pending-referrals/expire-free-slots）
 *   - T7-b backlog：剩余 5 个方法装 @Cron 装饰器 + listActive repo + listAllSchemas
 */
@Module({
  imports: [NestScheduleModule.forRoot(), FeedbackModule, ParentModule, ScheduleModule],
  controllers: [CronController],
  providers: [CronJobsService],
  exports: [CronJobsService],
})
export class CronModule {}
