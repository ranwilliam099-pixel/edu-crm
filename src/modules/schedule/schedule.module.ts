import { Module } from '@nestjs/common';
import { ScheduleService } from './schedule.service';

/**
 * Schedule 模块（V8 排课核心）
 *
 * USER-AUTH(2026-05-02): 排课冲突硬阻塞 + 销售只能跟进学员 + 老师跨校豁免
 */
@Module({
  providers: [ScheduleService],
  exports: [ScheduleService],
})
export class ScheduleModule {}
