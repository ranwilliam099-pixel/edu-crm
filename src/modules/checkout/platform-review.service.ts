import { Injectable, BadRequestException, ForbiddenException } from '@nestjs/common';
import { RefundService, RefundState } from './refund.service';
import { InvoiceService, InvoiceState } from './invoice.service';

/**
 * 平台超管手工审批服务（W2-T6）— A11 §3.1 全面集成
 *
 * 职责：把 W2-T4 RefundService + W2-T5 InvoiceService 的状态转换合并为
 * 一组"管理员可执行的审批 Action"，每次操作产出待写入 platform_admin_logs
 * 的审计记录（V1 SQL §2.6 platform_admin_logs.action 10 项操作枚举）。
 *
 * 暴露 5 个 Action：
 *   1. approveRefund      → refund: 待审核 → 已批准
 *   2. rejectRefund       → refund: 待审核 → 已拒绝（或已批准 → 已拒绝）
 *   3. approveInvoice     → invoice: 待审核 → 已批准
 *   4. rejectInvoice      → invoice: 待审核 → 已拒绝（或已批准 → 已拒绝）
 *   5. triggerInvoiceRedBlue → invoice: 已开具 → 红冲处理中
 *
 * 每个 Action 都做：
 *   a. assertReviewerRole（finance_admin / platform_admin，A11 §3.1）
 *   b. 委托对应 service 的 assertTransition 校验状态转换合法
 *   c. 返回审计日志条目（待 BE-W1-1 接入 ORM 后真实写入 platform_admin_logs）
 *
 * §0 不猜测严守：
 *   - 真实写库由 BE-W1-1 TypeORM DataSource 接入后接通
 *   - 平台超管前端页面（A11 列表/详情）由 W3 前端任务承接
 *   - 操作幂等性 / 并发审批冲突解决待业务联调时再定
 *
 * 项目隔离（追加 #8）：本类不引用企业管理系统主项目任何审批逻辑
 */
@Injectable()
export class PlatformReviewService {
  constructor(
    private readonly refund: RefundService,
    private readonly invoice: InvoiceService,
  ) {}

  /**
   * 审批退款（A04 §3 + A11 §3.1）
   * @returns 待写入 platform_admin_logs 的审计条目
   */
  approveRefund(input: ReviewerInput & { fromState: RefundState }): AuditLogEntry {
    this.refund.assertReviewerRole(input.reviewerRole);
    this.refund.assertTransition(input.fromState, '已批准');
    return this.makeAuditEntry('批准退款', input);
  }

  rejectRefund(input: ReviewerInput & { fromState: RefundState }): AuditLogEntry {
    this.refund.assertReviewerRole(input.reviewerRole);
    this.refund.assertTransition(input.fromState, '已拒绝');
    return this.makeAuditEntry('拒绝退款', input);
  }

  approveInvoice(input: ReviewerInput & { fromState: InvoiceState }): AuditLogEntry {
    this.invoice.assertReviewerRole(input.reviewerRole);
    this.invoice.assertTransition(input.fromState, '已批准');
    return this.makeAuditEntry('批准开票', input);
  }

  rejectInvoice(input: ReviewerInput & { fromState: InvoiceState }): AuditLogEntry {
    this.invoice.assertReviewerRole(input.reviewerRole);
    this.invoice.assertTransition(input.fromState, '已拒绝');
    return this.makeAuditEntry('拒绝开票', input);
  }

  /**
   * 触发已开具发票的红冲流程（A04 §4.3.4）
   * 仅 platform_admin 可触发；finance_admin 走"批准红冲"分支（待后续细化）
   */
  triggerInvoiceRedBlue(input: ReviewerInput & { fromState: InvoiceState }): AuditLogEntry {
    if (input.reviewerRole !== 'platform_admin') {
      throw new ForbiddenException(
        `triggerInvoiceRedBlue requires platform_admin (got: ${input.reviewerRole})`,
      );
    }
    this.invoice.assertTransition(input.fromState, '红冲处理中');
    // platform_admin_logs.action 枚举不直接含"红冲"——按 V1 SQL 落到 meta JSONB
    const entry = this.makeAuditEntry('查看', input); // 占位 action（platform_admin_logs 限定枚举）
    entry.action = '查看'; // 等 platform_admin_logs.action 枚举扩容后切换
    entry.meta = { ...entry.meta, redBlueTriggered: true, fromState: input.fromState };
    return entry;
  }

  /**
   * 构造审计条目（V1 SQL §2.6 platform_admin_logs 字段）
   */
  private makeAuditEntry(action: PlatformAdminLogAction, input: ReviewerInput): AuditLogEntry {
    if (!input.operatorId || input.operatorId.length !== 32) {
      throw new BadRequestException('operatorId must be 32-char ULID');
    }
    if (input.targetTenantId !== null && input.targetTenantId !== undefined) {
      if (input.targetTenantId.length !== 32) {
        throw new BadRequestException('targetTenantId must be 32-char ULID or null');
      }
    }
    return {
      action,
      operatorId: input.operatorId,
      targetTenantId: input.targetTenantId ?? null,
      meta: input.meta ?? {},
    };
  }
}

export interface ReviewerInput {
  /** 操作者 ID（platform_admin 或 finance_admin 的 user.id, 32-char ULID）*/
  operatorId: string;
  /** 操作者角色（A11 §3.1）*/
  reviewerRole: string;
  /** 目标租户 ID（null 表示跨租户操作，A11 §3.1 platform_admin 范围）*/
  targetTenantId?: string | null;
  /** 业务上下文 meta（JSONB 写入 platform_admin_logs.meta）*/
  meta?: Record<string, unknown>;
}

/** V1 SQL §2.6 platform_admin_logs.action 枚举对应类型 */
export type PlatformAdminLogAction =
  | '查看'
  | '批准退款'
  | '拒绝退款'
  | '批准开票'
  | '拒绝开票'
  | '手工冻结'
  | '手工解冻'
  | '添加保留标记'
  | '移除保留标记'
  | '手工延长保留期';

export interface AuditLogEntry {
  action: PlatformAdminLogAction;
  operatorId: string;
  targetTenantId: string | null;
  meta: Record<string, unknown>;
}
