import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PgPoolService, PgRow } from './pg-pool.service';

/**
 * ContractRepository — V25 签约管理（V2 contracts + V25 ALTER）
 *
 * 业绩归属：owner_user_id（销售 sub）+ signed_at
 * 业绩 KPI：SUM(total_amount) GROUP BY owner_user_id, date_trunc('month', signed_at)
 */

export type ContractStatus = 'pending' | 'active' | 'expired' | 'cancelled';
export type OrderType = '新签' | '续费' | '扩科' | '升班' | '转班';

export interface Contract {
  id: string;
  studentId: string;
  courseProductId: string;
  ownerUserId: string | null;
  opportunityId: string | null;
  campusId: string | null;
  classType: string | null;
  lessonHours: number;
  standardPrice: number;
  discountAmount: number;
  giftHours: number;
  totalAmount: number;
  orderType: OrderType;
  status: ContractStatus;
  paidLocked: boolean;
  signedAt: string | null;
  activatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SalesPerformance {
  totalCount: number;
  totalAmount: number;
  thisMonthCount: number;
  thisMonthAmount: number;
}

@Injectable()
export class ContractRepository {
  constructor(private readonly pg: PgPoolService) {}

  static mapRow(r: PgRow): Contract {
    return {
      id: r.id,
      studentId: r.student_id,
      courseProductId: r.course_product_id,
      ownerUserId: r.owner_user_id,
      opportunityId: r.opportunity_id,
      campusId: r.campus_id,
      classType: r.class_type,
      lessonHours: Number(r.lesson_hours),
      standardPrice: Number(r.standard_price),
      discountAmount: Number(r.discount_amount),
      giftHours: Number(r.gift_hours),
      totalAmount: Number(r.total_amount),
      orderType: r.order_type as OrderType,
      status: r.status as ContractStatus,
      paidLocked: !!r.paid_locked,
      signedAt: r.signed_at ? new Date(r.signed_at).toISOString() : null,
      activatedAt: r.activated_at ? new Date(r.activated_at).toISOString() : null,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
    };
  }

  async listByOwner(
    tenantSchema: string,
    ownerUserId: string,
    options: { status?: ContractStatus; limit?: number; offset?: number } = {},
  ): Promise<Contract[]> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    if (options.status) {
      const rows = await this.pg.tenantQuery<PgRow>(
        tenantSchema,
        `SELECT * FROM contracts
           WHERE owner_user_id = $1 AND status = $2 AND deleted_at IS NULL
           ORDER BY COALESCE(signed_at, created_at) DESC
           LIMIT $3 OFFSET $4`,
        [ownerUserId, options.status, limit, offset],
      );
      return rows.map((r) => ContractRepository.mapRow(r));
    }
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT * FROM contracts
         WHERE owner_user_id = $1 AND deleted_at IS NULL
         ORDER BY COALESCE(signed_at, created_at) DESC
         LIMIT $2 OFFSET $3`,
      [ownerUserId, limit, offset],
    );
    return rows.map((r) => ContractRepository.mapRow(r));
  }

  async getOwnerPerformance(
    tenantSchema: string,
    ownerUserId: string,
  ): Promise<SalesPerformance> {
    const rows = await this.pg.tenantQuery<{
      total_count: string;
      total_amount: string;
      this_month_count: string;
      this_month_amount: string;
    }>(
      tenantSchema,
      `SELECT
         COUNT(*) AS total_count,
         COALESCE(SUM(total_amount), 0) AS total_amount,
         COUNT(*) FILTER (WHERE signed_at >= date_trunc('month', NOW())) AS this_month_count,
         COALESCE(SUM(total_amount) FILTER (WHERE signed_at >= date_trunc('month', NOW())), 0) AS this_month_amount
       FROM contracts
       WHERE owner_user_id = $1
         AND status IN ('pending', 'active')
         AND deleted_at IS NULL`,
      [ownerUserId],
    );
    const r = rows[0] || { total_count: '0', total_amount: '0', this_month_count: '0', this_month_amount: '0' };
    return {
      totalCount: parseInt(r.total_count, 10),
      totalAmount: Number(r.total_amount),
      thisMonthCount: parseInt(r.this_month_count, 10),
      thisMonthAmount: Number(r.this_month_amount),
    };
  }

  /**
   * 老板视角：团队业绩排行（按销售归属聚合，本月签约 + 累计）
   * @param campusId V26 校区切换过滤；undefined = 全部校区
   */
  async getTeamPerformance(
    tenantSchema: string,
    campusId?: string,
  ): Promise<Array<{
    ownerUserId: string;
    totalCount: number;
    totalAmount: number;
    thisMonthCount: number;
    thisMonthAmount: number;
  }>> {
    const where = [
      `owner_user_id IS NOT NULL`,
      `status IN ('pending', 'active')`,
      `deleted_at IS NULL`,
    ];
    const params: any[] = [];
    if (campusId) {
      params.push(campusId);
      where.push(`campus_id = $${params.length}`);
    }
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT
         owner_user_id,
         COUNT(*) AS total_count,
         COALESCE(SUM(total_amount), 0) AS total_amount,
         COUNT(*) FILTER (WHERE signed_at >= date_trunc('month', NOW())) AS this_month_count,
         COALESCE(SUM(total_amount) FILTER (WHERE signed_at >= date_trunc('month', NOW())), 0) AS this_month_amount
       FROM contracts
       WHERE ${where.join(' AND ')}
       GROUP BY owner_user_id
       ORDER BY this_month_amount DESC, total_amount DESC`,
      params,
    );
    return rows.map((r) => ({
      ownerUserId: r.owner_user_id,
      totalCount: parseInt(r.total_count, 10),
      totalAmount: Number(r.total_amount),
      thisMonthCount: parseInt(r.this_month_count, 10),
      thisMonthAmount: Number(r.this_month_amount),
    }));
  }

  async create(
    tenantSchema: string,
    payload: {
      id: string;
      studentId: string;
      courseProductId: string;
      ownerUserId: string;
      opportunityId?: string | null;
      campusId?: string | null;
      classType?: string | null;
      lessonHours: number;
      standardPrice: number;
      discountAmount?: number;
      giftHours?: number;
      totalAmount: number;
      orderType?: OrderType;
      signedAt?: string | null;
      note?: string;
    },
  ): Promise<Contract> {
    if (!payload.id || payload.id.length !== 32) {
      throw new BadRequestException('contract id must be 32-char ULID');
    }
    if (payload.totalAmount < 0) {
      throw new BadRequestException('totalAmount must be ≥ 0');
    }
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `INSERT INTO contracts
         (id, student_id, course_product_id, owner_user_id, opportunity_id, campus_id,
          class_type, lesson_hours, standard_price, discount_amount, gift_hours,
          total_amount, order_type, status, signed_at, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending',$14,$4,$4)
       RETURNING *`,
      [
        payload.id,
        payload.studentId,
        payload.courseProductId,
        payload.ownerUserId,
        payload.opportunityId || null,
        payload.campusId || null,
        payload.classType || null,
        payload.lessonHours,
        payload.standardPrice,
        payload.discountAmount ?? 0,
        payload.giftHours ?? 0,
        payload.totalAmount,
        payload.orderType || '新签',
        payload.signedAt || new Date().toISOString(),
      ],
    );
    return ContractRepository.mapRow(rows[0]);
  }

  async findById(tenantSchema: string, id: string): Promise<Contract | null> {
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT * FROM contracts WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return rows.length === 0 ? null : ContractRepository.mapRow(rows[0]);
  }

  async setStatus(
    tenantSchema: string,
    id: string,
    status: ContractStatus,
    operator: string,
  ): Promise<Contract> {
    const activatedAtClause = status === 'active' ? ', activated_at = NOW()' : '';
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `UPDATE contracts
          SET status = $1, updated_at = NOW(), updated_by = $2 ${activatedAtClause}
        WHERE id = $3 AND deleted_at IS NULL
      RETURNING *`,
      [status, operator, id],
    );
    if (rows.length === 0) throw new NotFoundException(`contract ${id} not found`);
    return ContractRepository.mapRow(rows[0]);
  }
}
