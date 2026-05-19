import { Module } from '@nestjs/common';
import { ReverseOrderService } from './reverse-order.service';
import { RevenueAdjustmentService } from './revenue-adjustment.service';
import { ReverseOrderController } from './reverse-order.controller';

/**
 * ReverseOrder 模块（W3-1 Phase 4 BE-W5-1）
 *
 * 来源：
 *   - 《全部人员-审核往来总台账.md》条目 14 §B Track CODE-4 BE-W5-1
 *   - AUTH-7 A12 4 类逆向单 + paid 锁原则
 *
 * PM-AUTH-7(2026-04-30): A12 逆向单 4 类状态机守护
 */
@Module({
  // PM-AUTH-7(2026-04-30): ReverseOrderController W3-1 Phase 4 — HTTP 暴露
  controllers: [ReverseOrderController],
  // PM-AUTH-7(2026-04-30): RevenueAdjustmentService W3-1 Phase 4 — A12 §4.5 GMV 报表口径（条目 14 BE-W5-2）
  providers: [ReverseOrderService, RevenueAdjustmentService],
  exports: [ReverseOrderService, RevenueAdjustmentService],
})
export class ReverseOrderModule {}
