import { Module } from '@nestjs/common';
import { CronJobsService } from './cron-jobs.service';
import { FeedbackModule } from '../feedback/feedback.module';
import { ParentModule } from '../parent/parent.module';
import { ScheduleModule } from '../schedule/schedule.module';

/**
 * Cron 模块（W3-1 收尾 — 全局定时任务编排）
 *
 * USER-AUTH(2026-05-02): 接 V9/V10/V8.1 的所有 cron 任务（PD 设计稿 §3.6.4 / §4.2 / §4.3 / §5.5）
 *
 * 当前不引入 @nestjs/schedule（避免新依赖）；外部触发器通过 HTTP 调用
 *   或 k8s CronJob 调度 CronJobsService 方法。
 */
@Module({
  imports: [FeedbackModule, ParentModule, ScheduleModule],
  providers: [CronJobsService],
  exports: [CronJobsService],
})
export class CronModule {}
