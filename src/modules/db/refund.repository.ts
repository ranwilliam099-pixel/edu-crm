import { Injectable, BadRequestException } from '@nestjs/common';
import { PgPoolService } from './pg-pool.service';

/**
 * RefundRepository — V59 退费工单 PG 真持久化 (task #36)
 *
 * 来源:
 *   - SSOT §3.6 财务 home (本月退费总额+待审批 / 待办: 待审批退费)
 *   - SSOT §4.4 财务字段矩阵 (退费教学人员不看)
 *   - migrations/V59__refund_orders_in_tenant_schema.sql
 */
export type RefundStatus = 'pending' | 'approved' | 'rejected';

export interface RefundOrder {
  id: string;
  contractId: string;
  studentId: string;
  customerId: string;
  amount: number;
  reason: string | null;
  applicantUserId: string;
  applicantRole: string;
  appliedAt: Date;
  status: RefundStatus;
  approverUserId: string | null;
  approverRole: string | null;
  decidedAt: Date | null;
  decisionReason: string | null;
  campusId: string;
}

@Injectable()
export class RefundRepository {
  constructor(private readonly pg: PgPoolService) {}

  /**
   * 创建退费申请 (status='pending')
   *   - 申请人 / 角色 / 金额必填
   *   - applied_at / status 默认 NOW() / 'pending'
   */
  async createInDb(
    tenantSchema: string,
    input: {
      id: string;
      contractId: string;
      studentId: string;
      customerId: string;
      amount: number;
      reason?: string;
      applicantUserId: string;
      applicantRole: string;
      campusId: string;
    },
  ): Promise<RefundOrder> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `INSERT INTO refund_orders
         (id, contract_id, student_id, customer_id, amount, reason,
          applicant_user_id, applicant_role, campus_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, contract_id, student_id, customer_id, amount, reason,
                 applicant_user_id, applicant_role, applied_at, status,
                 approver_user_id, approver_role, decided_at, decision_reason, campus_id`,
      [
        input.id,
        input.contractId,
        input.studentId,
        input.customerId,
        input.amount,
        input.reason || null,
        input.applicantUserId,
        input.applicantRole,
        input.campusId,
      ],
    );
    return this.mapRow(rows[0]);
  }

  /**
   * 审批 (approve / reject)
   *   - status='pending' → 'approved'|'rejected'
   *   - 已审批的不可重复审批 (WHERE status='pending' 防并发)
   */
  async decideInDb(
    tenantSchema: string,
    input: {
      id: string;
      decision: 'approve' | 'reject';
      approverUserId: string;
      approverRole: string;
      decisionReason: string;
    },
  ): Promise<RefundOrder | null> {
    const newStatus: RefundStatus = input.decision === 'approve' ? 'approved' : 'rejected';
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `UPDATE refund_orders
          SET status = $1,
              approver_user_id = $2,
              approver_role = $3,
              decided_at = NOW(),
              decision_reason = $4,
              updated_at = NOW()
        WHERE id = $5 AND status = 'pending'
        RETURNING id, contract_id, student_id, customer_id, amount, reason,
                  applicant_user_id, applicant_role, applied_at, status,
                  approver_user_id, approver_role, decided_at, decision_reason, campus_id`,
      [newStatus, input.approverUserId, input.approverRole, input.decisionReason, input.id],
    );
    if (rows.length === 0) return null;
    return this.mapRow(rows[0]);
  }

  /**
   * list pending (财务工作台主入口)
   *   - 按 campus 过滤 (finance jwt.campusId scope)
   *   - 按 applied_at DESC 排序 (待审越久越靠前)
   */
  async listPendingInDb(
    tenantSchema: string,
    options: { campusId?: string; limit?: number; offset?: number } = {},
  ): Promise<RefundOrder[]> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const params: any[] = [limit, offset];
    let where = "status = 'pending'";
    if (options.campusId) {
      params.push(options.campusId);
      where += ` AND campus_id = $${params.length}`;
    }
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, contract_id, student_id, customer_id, amount, reason,
              applicant_user_id, applicant_role, applied_at, status,
              approver_user_id, approver_role, decided_at, decision_reason, campus_id
         FROM refund_orders
        WHERE ${where}
        ORDER BY applied_at ASC
        LIMIT $1 OFFSET $2`,
      params,
    );
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * list 全部 (含历史 — finance 月度统计 / boss 审计)
   *   - 按 status + applied_at 排序
   */
  async listInDb(
    tenantSchema: string,
    options: { campusId?: string; status?: RefundStatus; limit?: number } = {},
  ): Promise<RefundOrder[]> {
    const limit = options.limit ?? 100;
    const params: any[] = [limit];
    const conds: string[] = [];
    if (options.campusId) {
      params.push(options.campusId);
      conds.push(`campus_id = $${params.length}`);
    }
    if (options.status) {
      params.push(options.status);
      conds.push(`status = $${params.length}`);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, contract_id, student_id, customer_id, amount, reason,
              applicant_user_id, applicant_role, applied_at, status,
              approver_user_id, approver_role, decided_at, decision_reason, campus_id
         FROM refund_orders
         ${where}
        ORDER BY applied_at DESC
        LIMIT $1`,
      params,
    );
    return rows.map((r) => this.mapRow(r));
  }

  async findByIdInDb(tenantSchema: string, id: string): Promise<RefundOrder | null> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, contract_id, student_id, customer_id, amount, reason,
              applicant_user_id, applicant_role, applied_at, status,
              approver_user_id, approver_role, decided_at, decision_reason, campus_id
         FROM refund_orders
        WHERE id = $1`,
      [id],
    );
    return rows.length === 0 ? null : this.mapRow(rows[0]);
  }

  private mapRow(r: any): RefundOrder {
    return {
      id: r.id,
      contractId: r.contract_id,
      studentId: r.student_id,
      customerId: r.customer_id,
      amount: Number(r.amount),
      reason: r.reason || null,
      applicantUserId: r.applicant_user_id,
      applicantRole: r.applicant_role,
      appliedAt: new Date(r.applied_at),
      status: r.status,
      approverUserId: r.approver_user_id || null,
      approverRole: r.approver_role || null,
      decidedAt: r.decided_at ? new Date(r.decided_at) : null,
      decisionReason: r.decision_reason || null,
      campusId: r.campus_id,
    };
  }
}
