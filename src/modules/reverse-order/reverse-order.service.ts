import { Injectable, BadRequestException, ConflictException, Logger } from '@nestjs/common';

/**
 * ReverseOrderService — W3-1 Phase 4 BE-W5-1 A12 4 类逆向单状态机
 *
 * 来源：
 *   - 《全部人员-审核往来总台账.md》条目 14 §B Track CODE-4 BE-W5-1
 *   - AUTH-7 A12 §4.1 4 类型 + §4.2 5 状态字面 + paid 锁原则
 *   - 条目 21/25 cron `e3ab0738` 命名提请采纳方案 A：字面对齐 A12 §4.2 PD 已签字原文
 *
 * PM-AUTH-7(2026-04-30): A12 逆向单 4 类 + 5 状态字面（已签字）
 *
 * 4 类型（A12 §4.1）：
 *   - refund    （退款单）
 *   - transfer  （转班单）
 *   - extend    （扩科单 / 补班单）
 *   - cancel    （退课单）
 *
 * 5 状态字面（A12 §4.2 PD 签字原文）：
 *   - 待审核
 *   - 已批准
 *   - 已执行
 *   - 已拒绝
 *   - 已取消
 *
 * 通用状态机（每类共享）：
 *   待审核 → 已批准 → 已执行
 *   待审核 → 已拒绝（终态）
 *   待审核 → 已取消（终态）
 *
 * paid 锁原则（A12）：
 *   - 已执行的逆向单不可再改
 *   - 不直接修改原 payment_orders / contracts 已 paid 字段
 *   - 通过 reverse_orders 独立表保留对账与审计
 */

export type ReverseOrderType = 'refund' | 'transfer' | 'extend' | 'cancel';

export type ReverseOrderState = '待审核' | '已批准' | '已执行' | '已拒绝' | '已取消';

@Injectable()
export class ReverseOrderService {
  private readonly logger = new Logger(ReverseOrderService.name);

  static readonly TYPES: ReadonlyArray<ReverseOrderType> = ['refund', 'transfer', 'extend', 'cancel'];

  static readonly STATES: ReadonlyArray<ReverseOrderState> = [
    '待审核',
    '已批准',
    '已执行',
    '已拒绝',
    '已取消',
  ];

  static readonly TRANSITIONS: Readonly<
    Record<ReverseOrderState, ReadonlyArray<ReverseOrderState>>
  > = {
    待审核: ['已批准', '已拒绝', '已取消'],
    已批准: ['已执行'],
    已拒绝: [], // 终态
    已取消: [], // 终态
    已执行: [], // 终态（A12 paid 锁原则）
  };

  /**
   * 校验类型
   *
   * PM-AUTH-7(2026-04-30): A12 4 类
   */
  assertType(type: string): asserts type is ReverseOrderType {
    if (!ReverseOrderService.TYPES.includes(type as ReverseOrderType)) {
      throw new BadRequestException(
        `Unknown reverse order type: ${type} (allowed: [${ReverseOrderService.TYPES.join(', ')}])`,
      );
    }
  }

  /**
   * 校验状态转换
   *
   * PM-AUTH-7(2026-04-30): A12 paid 锁原则严守
   *
   * @throws ConflictException 不合法转换（含已生效后任何修改尝试）
   * @throws BadRequestException 未知状态值
   */
  assertTransition(from: ReverseOrderState, to: ReverseOrderState): void {
    if (!ReverseOrderService.STATES.includes(from)) {
      throw new BadRequestException(`Unknown source state: ${from}`);
    }
    if (!ReverseOrderService.STATES.includes(to)) {
      throw new BadRequestException(`Unknown target state: ${to}`);
    }
    const allowed = ReverseOrderService.TRANSITIONS[from];
    if (!allowed.includes(to)) {
      throw new ConflictException(
        `Illegal reverse_order state transition: ${from} → ${to} (allowed: [${allowed.join(', ') || 'TERMINAL (A12 paid 锁)'}])`,
      );
    }
  }

  /**
   * 终态判定
   */
  isTerminal(state: ReverseOrderState): boolean {
    return ReverseOrderService.TRANSITIONS[state].length === 0;
  }

  /**
   * paid 锁判定：已执行的不可再改（A12 §4.2 字面）
   */
  isPaidLocked(state: ReverseOrderState): boolean {
    return state === '已执行';
  }
}
