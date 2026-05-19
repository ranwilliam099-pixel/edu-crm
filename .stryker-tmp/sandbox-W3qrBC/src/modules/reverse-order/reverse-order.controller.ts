import { Body, Controller, Get, Param, Post, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import {
  ReverseOrderService,
  ReverseOrderType,
  ReverseOrderState,
} from './reverse-order.service';
import { RevenueAdjustmentService, RevenueAdjustmentInput } from './revenue-adjustment.service';
import { Roles } from '../../guards/rbac.decorator';
import { RbacGuard } from '../../guards/rbac.guard';

/**
 * ReverseOrderController — W3-1 Phase 4 BE-W5-1/2 HTTP 暴露
 *
 * 来源：
 *   - 《全部人员-审核往来总台账.md》条目 14 §B Track CODE-4 BE-W5-1/2
 *   - AUTH-7 A12 4 类逆向单 + paid 锁原则
 *
 * PM-AUTH-7(2026-04-30): 逆向单状态机校验 + GMV 报表口径
 *
 * 路由前缀：/api/reverse-orders
 * RBAC：状态校验 / 类型校验为公开（不动 DB）；revenue 计算可被任何已认证调用
 */
@Controller('reverse-orders')
export class ReverseOrderController {
  constructor(
    private readonly service: ReverseOrderService,
    private readonly revenue: RevenueAdjustmentService,
  ) {}

  /**
   * GET /api/reverse-orders/types — 4 类列表
   */
  @Get('types')
  listTypes(): { types: ReadonlyArray<ReverseOrderType> } {
    return { types: ReverseOrderService.TYPES };
  }

  /**
   * GET /api/reverse-orders/states — 5 状态列表
   */
  @Get('states')
  listStates(): { states: ReadonlyArray<ReverseOrderState> } {
    return { states: ReverseOrderService.STATES };
  }

  /**
   * POST /api/reverse-orders/transitions/check — 状态转换合法性校验（不动 DB）
   */
  @Post('transitions/check')
  @HttpCode(HttpStatus.OK)
  checkTransition(@Body() body: { from: ReverseOrderState; to: ReverseOrderState }): {
    legal: true;
    from: ReverseOrderState;
    to: ReverseOrderState;
  } {
    this.service.assertTransition(body.from, body.to);
    return { legal: true, from: body.from, to: body.to };
  }

  /**
   * POST /api/reverse-orders/revenue/calculate — 单笔 GMV 影响计算
   *
   * RBAC: platform_admin / finance_admin（财务报表场景）
   */
  @Post('revenue/calculate')
  @UseGuards(RbacGuard)
  @Roles('platform_admin', 'finance_admin')
  @HttpCode(HttpStatus.OK)
  calculateAdjustment(@Body() input: RevenueAdjustmentInput) {
    return this.revenue.calculate(input);
  }

  /**
   * POST /api/reverse-orders/revenue/calculate-batch — 多笔 GMV 累计
   */
  @Post('revenue/calculate-batch')
  @UseGuards(RbacGuard)
  @Roles('platform_admin', 'finance_admin')
  @HttpCode(HttpStatus.OK)
  calculateBatch(@Body() body: { inputs: RevenueAdjustmentInput[] }) {
    return this.revenue.calculateBatch(body.inputs);
  }
}
