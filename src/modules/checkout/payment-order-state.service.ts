import { Injectable, BadRequestException, ConflictException } from '@nestjs/common';

/**
 * payment_orders 状态机（W2-T2）— A04 §5.1 拍板
 *
 * 5 状态：待支付 → 已支付 / 退款处理中 / 已退款 / 已取消
 *
 * 合法转换图（只允许这些边，其余抛异常）：
 *   待支付      → 已支付       （微信支付回调成功 + 验签通过 + 金额匹配）
 *   待支付      → 已取消       （用户主动 / 超时 / 平台超管取消）
 *   已支付      → 退款处理中   （A04 §3 退款申请已批准）
 *   退款处理中  → 已退款       （微信退款回调成功）
 *   退款处理中  → 已支付       （退款失败回滚到已支付，A04 §5.2 ABNORMAL 兜底）
 *
 * 终态：已退款 / 已取消（不可再转）
 *
 * §0 不猜测严守：
 *   - 已退款 → 任何 不允许（A12 paid 锁原则：已支付记录不直接修改）
 *   - 已取消 → 任何 不允许
 *   - 未列出的转换路径全部默认不合法（防御深度）
 *
 * 项目隔离（追加 #8）：本类不引用企业管理系统主项目任何状态机
 */
@Injectable()
export class PaymentOrderStateService {
  static readonly STATES = ['待支付', '已支付', '退款处理中', '已退款', '已取消'] as const;

  static readonly TRANSITIONS: Readonly<Record<PaymentOrderState, readonly PaymentOrderState[]>> = {
    待支付: ['已支付', '已取消'],
    已支付: ['退款处理中'],
    退款处理中: ['已退款', '已支付'],
    已退款: [], // 终态
    已取消: [], // 终态
  };

  /**
   * 校验状态转换是否合法
   * @throws ConflictException 不合法转换
   * @throws BadRequestException 未知状态值
   */
  assertTransition(from: PaymentOrderState, to: PaymentOrderState): void {
    if (!PaymentOrderStateService.STATES.includes(from)) {
      throw new BadRequestException(`Unknown source state: ${from}`);
    }
    if (!PaymentOrderStateService.STATES.includes(to)) {
      throw new BadRequestException(`Unknown target state: ${to}`);
    }
    const allowed = PaymentOrderStateService.TRANSITIONS[from];
    if (!allowed.includes(to)) {
      throw new ConflictException(
        `Illegal payment_orders state transition: ${from} → ${to} (allowed: [${allowed.join(', ') || 'TERMINAL'}])`,
      );
    }
  }

  /**
   * 终态判定（A12 paid 锁规则：终态不可改）
   */
  isTerminal(state: PaymentOrderState): boolean {
    return PaymentOrderStateService.TRANSITIONS[state].length === 0;
  }

  /**
   * 给定起始状态，返回所有合法目标
   */
  legalTargets(from: PaymentOrderState): readonly PaymentOrderState[] {
    return PaymentOrderStateService.TRANSITIONS[from];
  }
}

export type PaymentOrderState = '待支付' | '已支付' | '退款处理中' | '已退款' | '已取消';
