import { Injectable, BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';

/**
 * invoice_requests 发票服务（W2-T5）— A04 §4 发票责任链 + V1 SQL §2.4
 *
 * 5 状态：待审核 / 已批准 / 已开具 / 已拒绝 / 红冲处理中
 *
 * 合法转换：
 *   待审核     → 已批准         (finance_admin/platform_admin 审批通过)
 *   待审核     → 已拒绝         (审批拒绝)
 *   已批准     → 已开具         (财务实际开票完成)
 *   已批准     → 已拒绝         (开票失败回滚)
 *   已开具     → 红冲处理中     (A04 §4.3.4 已开具后退款触发红冲)
 *   红冲处理中 → 已拒绝         (红冲完成等同发票作废，进入终态)
 *
 * 终态：已拒绝
 *   - 已开具 是"业务成功终态"但可被红冲；不视为不可改终态
 *   - 已拒绝 是"业务失败终态"
 *   - 红冲处理中 → 已拒绝 表示作废完成
 *
 * 业务规则（A04 §4 + V1 SQL）：
 *   1. invoice_title 非空（NOT NULL）
 *   2. tax_number 可选但若提供必须 ≤32 字符（V1 SQL VARCHAR(32)）
 *   3. contact_email 可选但若提供必须含 @（基础格式校验，§0 不做完整 RFC5322）
 *   4. remark 可选 ≤256 chars
 *   5. 审核操作必须由 finance_admin / platform_admin（A11 §3.1）
 *   6. 红冲触发由 RefundService.requiresRedBlue() 决定（已开具+退款）
 *
 * §0 不猜测严守：
 *   - 真实开票接口（开票系统集成）等财务确认开票通道后接入
 *   - 红冲完整业务流程（关联 reverse_orders 等）等产品+财务规约
 *
 * 项目隔离（追加 #8）：本类不引用企业管理系统主项目任何发票逻辑
 */
@Injectable()
export class InvoiceService {
  static readonly INVOICE_STATES = ['待审核', '已批准', '已开具', '已拒绝', '红冲处理中'] as const;

  static readonly INVOICE_TRANSITIONS: Readonly<Record<InvoiceState, readonly InvoiceState[]>> = {
    待审核: ['已批准', '已拒绝'],
    已批准: ['已开具', '已拒绝'],
    已开具: ['红冲处理中'],
    红冲处理中: ['已拒绝'],
    已拒绝: [], // 终态
  };

  static readonly REVIEW_ROLES = ['finance_admin', 'platform_admin'] as const;

  /**
   * 校验发票申请输入（A04 §4 + V1 SQL CHECK 约束）
   * @throws BadRequestException
   */
  validateInvoiceRequest(input: InvoiceRequestInput): void {
    if (!input.orderId || input.orderId.length !== 32) {
      throw new BadRequestException('orderId must be 32-char ULID');
    }
    if (!input.invoiceTitle || input.invoiceTitle.trim().length === 0) {
      throw new BadRequestException('invoiceTitle required (V1 SQL NOT NULL)');
    }
    if (input.invoiceTitle.length > 128) {
      throw new BadRequestException('invoiceTitle exceeds 128 chars (V1 SQL VARCHAR(128))');
    }
    if (input.taxNumber !== undefined && input.taxNumber !== null) {
      if (input.taxNumber.length > 32) {
        throw new BadRequestException('taxNumber exceeds 32 chars (V1 SQL VARCHAR(32))');
      }
    }
    if (input.contactEmail !== undefined && input.contactEmail !== null && input.contactEmail !== '') {
      // §0 不做完整 RFC5322；要求含 @ + 长度 ≤ 128
      if (!input.contactEmail.includes('@')) {
        throw new BadRequestException('contactEmail must contain @');
      }
      if (input.contactEmail.length > 128) {
        throw new BadRequestException('contactEmail exceeds 128 chars (V1 SQL VARCHAR(128))');
      }
    }
    if (input.remark !== undefined && input.remark !== null && input.remark.length > 256) {
      throw new BadRequestException('remark exceeds 256 chars (V1 SQL VARCHAR(256))');
    }
  }

  /**
   * 校验状态转换合法性
   * @throws ConflictException 不合法转换
   */
  assertTransition(from: InvoiceState, to: InvoiceState): void {
    if (!InvoiceService.INVOICE_STATES.includes(from)) {
      throw new BadRequestException(`Unknown source invoice state: ${from}`);
    }
    if (!InvoiceService.INVOICE_STATES.includes(to)) {
      throw new BadRequestException(`Unknown target invoice state: ${to}`);
    }
    const allowed = InvoiceService.INVOICE_TRANSITIONS[from];
    if (!allowed.includes(to)) {
      throw new ConflictException(
        `Illegal invoice state transition: ${from} → ${to} (allowed: [${allowed.join(', ') || 'TERMINAL'}])`,
      );
    }
  }

  /**
   * 校验审核操作角色（A11 §3.1）
   * @throws ForbiddenException
   */
  assertReviewerRole(role: string): void {
    if (!(InvoiceService.REVIEW_ROLES as readonly string[]).includes(role)) {
      throw new ForbiddenException(
        `Invoice review requires role in [${InvoiceService.REVIEW_ROLES.join(', ')}], got: ${role}`,
      );
    }
  }

  isTerminal(state: InvoiceState): boolean {
    return InvoiceService.INVOICE_TRANSITIONS[state].length === 0;
  }
}

export type InvoiceState = '待审核' | '已批准' | '已开具' | '已拒绝' | '红冲处理中';

export interface InvoiceRequestInput {
  /** 原 payment_orders.id (ULID 32-char) */
  orderId: string;
  /** 发票抬头（NOT NULL, ≤128 chars，脱敏：finance/admin FULL）*/
  invoiceTitle: string;
  /** 税号（≤32 chars 可选）*/
  taxNumber?: string | null;
  /** 联系邮箱（≤128 chars 可选）*/
  contactEmail?: string | null;
  /** 备注（≤256 chars 可选）*/
  remark?: string | null;
}
