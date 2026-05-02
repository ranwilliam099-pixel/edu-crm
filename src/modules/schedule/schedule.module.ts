import { Module } from '@nestjs/common';
import { ScheduleService } from './schedule.service';
import { RecurringScheduleService } from './recurring-schedule.service';
import { ScheduleController } from './schedule.controller';
import { RecurringScheduleController } from './recurring-schedule.controller';

/**
 * Schedule 模块（V8 排课核心 + V8.1 周期性课表）
 *
 * USER-AUTH(2026-05-02): 排课冲突硬阻塞 + 销售只能跟进学员 + 老师跨校豁免
 *   + 学员-老师固定绑定 + 周期性课表模板（P12）
 */
@Module({
  controllers: [ScheduleController, RecurringScheduleController],
  providers: [ScheduleService, RecurringScheduleService],
  exports: [ScheduleService, RecurringScheduleService],
})
export class ScheduleModule {}
