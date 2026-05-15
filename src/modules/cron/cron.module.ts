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
 *   - 当前未加 @Cron 装饰器（拆 T7-b：包装方法 + listActive repo + listAllSchemas）
 *   - 外部触发仍走 HTTP（CronController 3 endpoint：expire-promotions/expire-pending-referrals/expire-free-slots）
 *   - doc-code-drift R3 仍 fail（预期）→ T7-b 完成后自然消除
 */
@Module({
  imports: [NestScheduleModule.forRoot(), FeedbackModule, ParentModule, ScheduleModule],
  controllers: [CronController],
  providers: [CronJobsService],
  exports: [CronJobsService],
})
export class CronModule {}
