import { Injectable, BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';

/**
 * payment_refunds 退款服务（W2-T4）— A04 §3 退款责任链 + V1 SQL §2.3
 *
 * 4 状态：待审核 / 已批准 / 已退款 / 已拒绝
 *
 * 合法转换：
 *   待审核 → 已批准   (finance_admin/platform_admin 审批通过)
 *   待审核 → 已拒绝   (审批拒绝)
 *   已批准 → 已退款   (微信退款回调成功)
 *   已批准 → 已拒绝   (审批后退款失败回滚到拒绝)
 *
 * 终态：已退款 / 已拒绝
 *
 * 业务规则（A04 §3）：
 *   1. 申请退款金额必须 > 0
 *   2. 累计退款金额（含本次）不得超过原 payment_orders.amount
 *   3. 退款必须有原因（reason 非空，与 V1 SQL CHECK 对齐）
 *   4. 审核操作必须由 finance_admin 或 platform_admin（A11 §3.1 角色拆分）
 *   5. 已开票后退款进入红冲（A04 §4.3.4 错误码 4104，本服务不处理红冲流程，仅返回标记给上层）
 *
 * §0 不猜测严守：
 *   - 实际 wxpay refund 客户端调用由 W2-T4 后续 commit 接入（用 WX_PAY_CLIENT.requestRefund）
 *   - 财务 / 法务真实审核流的"链上签名"要求等 EXT-01 商户号到位后定
 *
 * 项目隔离（追加 #8）：本类不引用企业管理系统主项目任何退款逻辑
 */
@Injectable()
export class RefundService {
  static readonly REFUND_STATES = ['待审核', '已批准', '已退款', '已拒绝'] as const;

  static readonly REFUND_TRANSITIONS: Readonly<Record<RefundState, readonly RefundState[]>> = {
    待审核: ['已批准', '已拒绝'],
    已批准: ['已退款', '已拒绝'],
    已退款: [],
    已拒绝: [],
  };

  static readonly REVIEW_ROLES = ['finance_admin', 'platform_admin'] as const;

  /**
   * 校验退款申请输入（A04 §3 + V1 SQL CHECK 约束）
   * @throws BadRequestException
   */
  validateRefundRequest(input: RefundRequestInput): void {
    if (!input.orderId || input.orderId.length !== 32) {
      throw new BadRequestException('orderId must be 32-char ULID');
    }
    if (!Number.isInteger(input.refundAmountCents) || input.refundAmountCents <= 0) {
      throw new BadRequestException('refundAmountCents must be positive integer');
    }
    if (!input.reason || input.reason.trim().length === 0) {
      throw new BadRequestException('reason required (A04 §3, V1 SQL NOT NULL)');
    }
    if (input.reason.length > 256) {
      throw new BadRequestException('reason exceeds 256 chars (V1 SQL VARCHAR(256))');
    }
  }

  /**
   * 校验累计退款不超过原订单金额（A04 §3 业务规则 2）
   * @param totalAmountCents 原订单总额
   * @param alreadyRefundedCents 已退款总额（不含本次）
   * @param requestedCents 本次申请退款金额
   * @throws ConflictException 超额
   */
  assertWithinBudget(totalAmountCents: number, alreadyRefundedCents: number, requestedCents: number): void {
    if (alreadyRefundedCents < 0) {
      throw new BadRequestException('alreadyRefundedCents must be >= 0');
    }
    if (alreadyRefundedCents + requestedCents > totalAmountCents) {
      throw new ConflictException({
        code: 4030,
        message: `Refund exceeds budget: total=${totalAmountCents}, alreadyRefunded=${alreadyRefundedCents}, requested=${requestedCents} (A04 §3)`,
      });
    }
  }

  /**
   * 校验状态转换合法性
   * @throws ConflictException 不合法转换
   */
  assertTransition(from: RefundState, to: RefundState): void {
    if (!RefundService.REFUND_STATES.includes(from)) {
      throw new BadRequestException(`Unknown source refund state: ${from}`);
    }
    if (!RefundService.REFUND_STATES.includes(to)) {
      throw new BadRequestException(`Unknown target refund state: ${to}`);
    }
    const allowed = RefundService.REFUND_TRANSITIONS[from];
    if (!allowed.includes(to)) {
      throw new ConflictException(
        `Illegal refund state transition: ${from} → ${to} (allowed: [${allowed.join(', ') || 'TERMINAL'}])`,
      );
    }
  }

  /**
   * 校验审核操作角色（A11 §3.1）
   * @throws ForbiddenException 非审核角色
   */
  assertReviewerRole(role: string): void {
    if (!(RefundService.REVIEW_ROLES as readonly string[]).includes(role)) {
      throw new ForbiddenException(
        `Refund review requires role in [${RefundService.REVIEW_ROLES.join(', ')}], got: ${role}`,
      );
    }
  }

  /**
   * 是否需要红冲（已开票后退款）
   * A04 §4.3.4：已开票订单退款不自动闭环，需财务红冲
   */
  requiresRedBlue(invoiceStatus: string): boolean {
    return invoiceStatus === '已开具';
  }

  isTerminal(state: RefundState): boolean {
    return RefundService.REFUND_TRANSITIONS[state].length === 0;
  }
}

export type RefundState = '待审核' | '已批准' | '已退款' | '已拒绝';

export interface RefundRequestInput {
  /** 原 payment_orders.id (ULID 32-char) */
  orderId: string;
  /** 退款金额（分） */
  refundAmountCents: number;
  /** 退款原因（NOT NULL, ≤256 chars） */
  reason: string;
}
