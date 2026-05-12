import { Module } from '@nestjs/common';
import { ScheduleService } from './schedule.service';
import { RecurringScheduleService } from './recurring-schedule.service';
import { ScheduleController } from './schedule.controller';
import { RecurringScheduleController } from './recurring-schedule.controller';
import { DbModule } from '../db/db.module';

/**
 * Schedule 模块（V8 排课核心 + V8.1 周期性课表）
 *
 * USER-AUTH(2026-05-02): 排课冲突硬阻塞 + 销售只能跟进学员 + 老师跨校豁免
 *   + 学员-老师固定绑定 + 周期性课表模板（P12）
 *
 * Sprint B.4-1（2026-05-12）：controller 注入 TeacherRepository + StudentRepository
 *   用于 server-derive callerRole / schedulableTeachers / studentResponsibleSalesPairs。
 *   DbModule 已 @Global，但 explicit import 让模块依赖图清晰。
 */
@Module({
  imports: [DbModule],
  controllers: [ScheduleController, RecurringScheduleController],
  providers: [ScheduleService, RecurringScheduleService],
  exports: [ScheduleService, RecurringScheduleService],
})
export class ScheduleModule {}
