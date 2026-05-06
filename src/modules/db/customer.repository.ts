import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PgPoolService, PgRow } from './pg-pool.service';

/**
 * CustomerRepository — V25 销售客户管理（基于 V2 opportunities + V25 ALTER）
 *
 * 业务流：
 *   1. 新线索（owner_user_id=NULL）入公共池
 *   2. 销售 claim → owner_user_id = me
 *   3. 销售跟进（addFollow 写 customer_follow_log）
 *   4. 销售 release → owner_user_id 回 NULL
 *   5. 30 天无跟进 cron → 自动回池
 */

export type CustomerStage =
  | '初步接触' | '需求诊断' | '已预约试听' | '已试听待转化'
  | '已出方案' | '谈单中' | '已报名' | '已失单';

export type FollowType =
  | 'lead' | 'consult' | 'trial_invited' | 'trial_done'
  | 'signed' | 'lost' | 'remark' | 'released' | 'claimed';

export interface Customer {
  id: string;
  studentId: string;
  // V25 JOIN students 真姓名 + 年级（mapCustomerRow 只在 SELECT 含 join 字段时填充）
  studentName: string | null;
  gradeOrAge: string | null;
  intendedSubject: string | null;
  ownerUserId: string | null;
  stage: CustomerStage;
  source: string | null;
  phone: string | null;
  wechat: string | null;
  intentLevel: '高' | '中' | '低' | null;
  urgent: boolean;
  note: string | null;
  enteredPoolAt: string | null;
  enterPoolReason: string | null;
  lastContactAt: string | null;
  signedAt: string | null;
  lostReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FollowEntry {
  id: string;
  opportunityId: string;
  followType: FollowType;
  label: string;
  byUserId: string | null;
  byLabel: string;
  occurredAt: string;
  extra: Record<string, unknown> | null;
}

const POOL_LIMIT_PER_SALES = 50;
const POOL_RESET_REASON = {
  newLead: 'new_lead',
  released: 'released_by_sales',
  cold: 'cold_30d',
  salesQuit: 'sales_quit',
};

/**
 * V29 R2 销售即时建客户结果（含 customer + opportunity + 可选 student）
 */
export interface CreateCustomerResult {
  customerId: string;
  opportunityId: string;
  studentId: string | null;
}

@Injectable()
export class CustomerRepository {
  constructor(private readonly pg: PgPoolService) {}

  /**
   * V29 R2 销售即时建客户（家长） + opportunity + 可选 student（一并）
   *
   * 来源：用户 2026-05-07「全做」— 销售自己开拓的客户能即时录入，不必等公共池
   *
   * 事务内：
   *   1. INSERT customers（家长）
   *   2. INSERT students（如 studentName 提供）
   *   3. INSERT opportunities（owner_user_id = 销售自己，stage='初步接触'）
   *
   * RBAC：sales / sales_manager / sales_director / boss / admin（销售口可建）
   */
  async createWithOpportunity(
    tenantSchema: string,
    payload: {
      customerId: string;
      opportunityId: string;
      parentName: string;
      primaryMobile: string;
      campusId: string;
      ownerSalesId: string;
      // student 可选 — 提供则一并建学生（关联 customer + opportunity）
      studentId?: string;
      studentName?: string;
      gradeOrAge?: string;
      intendedSubject?: string;
      // opportunity 字段
      stage?: string;
      source?: string;
      note?: string;
    },
  ): Promise<CreateCustomerResult> {
    if (!payload.customerId || payload.customerId.length !== 32) {
      throw new BadRequestException('customerId must be 32-char ULID');
    }
    if (!payload.opportunityId || payload.opportunityId.length !== 32) {
      throw new BadRequestException('opportunityId must be 32-char ULID');
    }
    if (!payload.parentName) throw new BadRequestException('parentName required');
    if (!payload.primaryMobile || !/^1[3-9]\d{9}$/.test(payload.primaryMobile)) {
      throw new BadRequestException('primaryMobile must be 11-digit Chinese mobile');
    }
    if (!payload.campusId) throw new BadRequestException('campusId required');
    if (!payload.ownerSalesId) throw new BadRequestException('ownerSalesId required');
    if (payload.studentName && (!payload.studentId || payload.studentId.length !== 32)) {
      throw new BadRequestException('当传 studentName 时必须传 32-char studentId');
    }

    return this.pg.transaction(
      async (client) => {
        // 1. customer（家长）
        await client.query(
          `INSERT INTO customers (id, parent_name, primary_mobile, campus_id, owner_id, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $5, $5)`,
          [
            payload.customerId,
            payload.parentName,
            payload.primaryMobile,
            payload.campusId,
            payload.ownerSalesId,
          ],
        );

        // 2. student（可选）
        let createdStudentId: string | null = null;
        if (payload.studentName && payload.studentId) {
          await client.query(
            `INSERT INTO students
               (id, student_name, customer_id, grade_or_age, intended_subject,
                owner_sales_id, created_by, updated_by)
             VALUES ($1, $2, $3, $4, $5, $6, $6, $6)`,
            [
              payload.studentId,
              payload.studentName,
              payload.customerId,
              payload.gradeOrAge || null,
              payload.intendedSubject || null,
              payload.ownerSalesId,
            ],
          );
          createdStudentId = payload.studentId;
        }

        // 3. opportunity（销售线索 — 必须 student_id 已存在；如无 student 则跳过）
        if (createdStudentId) {
          await client.query(
            `INSERT INTO opportunities
               (id, student_id, course_product_id, stage, owner_user_id, campus_id,
                source, phone, last_contact_at, note, created_by, updated_by)
             VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, NOW(), $8, $4, $4)`,
            [
              payload.opportunityId,
              createdStudentId,
              payload.stage || '初步接触',
              payload.ownerSalesId,
              payload.campusId,
              payload.source || '销售自建',
              payload.primaryMobile,
              payload.note || null,
            ],
          );
        }

        return {
          customerId: payload.customerId,
          opportunityId: createdStudentId ? payload.opportunityId : '',
          studentId: createdStudentId,
        };
      },
      { tenantSchema },
    );
  }

  static mapCustomerRow(r: PgRow): Customer {
    return {
      id: r.id,
      studentId: r.student_id,
      // JOIN 字段（仅 listMine/listPool/findById 包含）
      studentName: r.student_name || null,
      gradeOrAge: r.grade_or_age || null,
      intendedSubject: r.intended_subject || null,
      ownerUserId: r.owner_user_id,
      stage: r.stage as CustomerStage,
      source: r.source,
      phone: r.phone,
      wechat: r.wechat,
      intentLevel: r.intent_level as Customer['intentLevel'],
      urgent: !!r.urgent,
      note: r.note,
      enteredPoolAt: r.entered_pool_at ? new Date(r.entered_pool_at).toISOString() : null,
      enterPoolReason: r.enter_pool_reason,
      lastContactAt: r.last_contact_at ? new Date(r.last_contact_at).toISOString() : null,
      signedAt: r.signed_at ? new Date(r.signed_at).toISOString() : null,
      lostReason: r.lost_reason,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
    };
  }

  static mapFollowRow(r: PgRow): FollowEntry {
    return {
      id: r.id,
      opportunityId: r.opportunity_id,
      followType: r.follow_type as FollowType,
      label: r.label,
      byUserId: r.by_user_id,
      byLabel: r.by_label,
      occurredAt: new Date(r.occurred_at).toISOString(),
      extra: r.extra_json || null,
    };
  }

  // ===== 列表查询 =====

  async listMine(
    tenantSchema: string,
    ownerUserId: string,
    options: { stage?: CustomerStage; limit?: number; offset?: number } = {},
  ): Promise<Customer[]> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    if (options.stage) {
      const rows = await this.pg.tenantQuery<PgRow>(
        tenantSchema,
        `SELECT o.*, s.student_name, s.grade_or_age, s.intended_subject
           FROM opportunities o
           LEFT JOIN students s ON s.id = o.student_id
          WHERE o.owner_user_id = $1 AND o.stage = $2
          ORDER BY o.urgent DESC, COALESCE(o.last_contact_at, o.created_at) DESC
          LIMIT $3 OFFSET $4`,
        [ownerUserId, options.stage, limit, offset],
      );
      return rows.map((r) => CustomerRepository.mapCustomerRow(r));
    }
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT o.*, s.student_name, s.grade_or_age, s.intended_subject
         FROM opportunities o
         LEFT JOIN students s ON s.id = o.student_id
        WHERE o.owner_user_id = $1
          AND o.stage NOT IN ('已报名','已失单')
        ORDER BY o.urgent DESC, COALESCE(o.last_contact_at, o.created_at) DESC
        LIMIT $2 OFFSET $3`,
      [ownerUserId, limit, offset],
    );
    return rows.map((r) => CustomerRepository.mapCustomerRow(r));
  }

  /**
   * 老板视角（admin / sales_director）：跨校查看全部客户
   *
   * @param ownerFilter undefined = 所有；'unassigned' = 公共池；具体 sub = 某销售
   * @param campusId V26 校区切换过滤；undefined = 全部校区
   */
  async listAllForBoss(
    tenantSchema: string,
    options: {
      ownerFilter?: string;
      stage?: CustomerStage;
      campusId?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<Customer[]> {
    const limit = options.limit ?? 200;
    const offset = options.offset ?? 0;
    const where: string[] = [`o.stage NOT IN ('已报名','已失单')`];
    const params: any[] = [];
    if (options.stage) {
      params.push(options.stage);
      where.push(`o.stage = $${params.length}`);
    }
    if (options.ownerFilter === 'unassigned') {
      where.push(`o.owner_user_id IS NULL`);
    } else if (options.ownerFilter) {
      params.push(options.ownerFilter);
      where.push(`o.owner_user_id = $${params.length}`);
    }
    if (options.campusId) {
      params.push(options.campusId);
      where.push(`o.campus_id = $${params.length}`);
    }
    params.push(limit, offset);
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT o.*, s.student_name, s.grade_or_age, s.intended_subject
         FROM opportunities o
         LEFT JOIN students s ON s.id = o.student_id
        WHERE ${where.join(' AND ')}
        ORDER BY o.urgent DESC, COALESCE(o.last_contact_at, o.created_at) DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return rows.map((r) => CustomerRepository.mapCustomerRow(r));
  }

  async listPool(
    tenantSchema: string,
    options: { source?: string; limit?: number; offset?: number } = {},
  ): Promise<Customer[]> {
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    if (options.source) {
      const rows = await this.pg.tenantQuery<PgRow>(
        tenantSchema,
        `SELECT o.*, s.student_name, s.grade_or_age, s.intended_subject
           FROM opportunities o
           LEFT JOIN students s ON s.id = o.student_id
          WHERE o.owner_user_id IS NULL
            AND o.stage NOT IN ('已报名','已失单')
            AND o.source = $1
          ORDER BY o.urgent DESC, o.entered_pool_at ASC
          LIMIT $2 OFFSET $3`,
        [options.source, limit, offset],
      );
      return rows.map((r) => CustomerRepository.mapCustomerRow(r));
    }
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT o.*, s.student_name, s.grade_or_age, s.intended_subject
         FROM opportunities o
         LEFT JOIN students s ON s.id = o.student_id
        WHERE o.owner_user_id IS NULL
          AND o.stage NOT IN ('已报名','已失单')
        ORDER BY o.urgent DESC, o.entered_pool_at ASC
        LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return rows.map((r) => CustomerRepository.mapCustomerRow(r));
  }

  async findById(tenantSchema: string, id: string): Promise<Customer | null> {
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT o.*, s.student_name, s.grade_or_age, s.intended_subject
         FROM opportunities o
         LEFT JOIN students s ON s.id = o.student_id
        WHERE o.id = $1`,
      [id],
    );
    return rows.length === 0 ? null : CustomerRepository.mapCustomerRow(rows[0]);
  }

  // ===== 公共池操作 =====

  async claim(
    tenantSchema: string,
    customerId: string,
    userId: string,
    userLabel: string,
  ): Promise<Customer> {
    return this.pg.transaction(
      async (client) => {
        // 在跟客户上限校验
        const cntRows = await client.query(
          `SELECT COUNT(*) AS cnt FROM opportunities
             WHERE owner_user_id = $1 AND stage NOT IN ('已报名','已失单')`,
          [userId],
        );
        const myCount = parseInt(cntRows.rows[0]?.cnt || '0', 10);
        if (myCount >= POOL_LIMIT_PER_SALES) {
          throw new ConflictException(
            `POOL_LIMIT_REACHED: ${myCount}/${POOL_LIMIT_PER_SALES}`,
          );
        }

        // FCFS 抢占（必须 owner_user_id IS NULL）
        const upd = await client.query(
          `UPDATE opportunities
              SET owner_user_id = $1,
                  entered_pool_at = NULL,
                  enter_pool_reason = NULL,
                  last_contact_at = NOW(),
                  updated_at = NOW(),
                  updated_by = $1
            WHERE id = $2 AND owner_user_id IS NULL
          RETURNING *`,
          [userId, customerId],
        );
        if (upd.rows.length === 0) {
          // 区分原因
          const check = await client.query(
            `SELECT owner_user_id FROM opportunities WHERE id = $1`,
            [customerId],
          );
          if (check.rows.length === 0) {
            throw new NotFoundException(`customer ${customerId} not found`);
          }
          throw new ConflictException('CUSTOMER_ALREADY_OWNED');
        }

        await client.query(
          `INSERT INTO customer_follow_log
             (id, opportunity_id, follow_type, label, by_user_id, by_label)
           VALUES ($1, $2, 'claimed', $3, $4, $5)`,
          [
            this.genId(),
            customerId,
            `${userLabel} 从公共池捞客户`,
            userId,
            userLabel,
          ],
        );

        return CustomerRepository.mapCustomerRow(upd.rows[0]);
      },
      { tenantSchema },
    );
  }

  async release(
    tenantSchema: string,
    customerId: string,
    userId: string,
    userLabel: string,
    reason?: string,
  ): Promise<Customer> {
    return this.pg.transaction(
      async (client) => {
        const upd = await client.query(
          `UPDATE opportunities
              SET owner_user_id = NULL,
                  entered_pool_at = NOW(),
                  enter_pool_reason = $3,
                  updated_at = NOW(),
                  updated_by = $2
            WHERE id = $1 AND owner_user_id = $2
          RETURNING *`,
          [customerId, userId, reason || POOL_RESET_REASON.released],
        );
        if (upd.rows.length === 0) {
          throw new NotFoundException(`customer ${customerId} not owned by you`);
        }
        await client.query(
          `INSERT INTO customer_follow_log
             (id, opportunity_id, follow_type, label, by_user_id, by_label, extra_json)
           VALUES ($1, $2, 'released', $3, $4, $5, $6::jsonb)`,
          [
            this.genId(),
            customerId,
            `${userLabel} 退回公共池${reason ? ' · ' + reason : ''}`,
            userId,
            userLabel,
            JSON.stringify({ reason: reason || 'no_reason' }),
          ],
        );
        return CustomerRepository.mapCustomerRow(upd.rows[0]);
      },
      { tenantSchema },
    );
  }

  async markLost(
    tenantSchema: string,
    customerId: string,
    userId: string,
    userLabel: string,
    lostReason: string,
  ): Promise<Customer> {
    const validReasons = ['价格高', '时间不合适', '竞品成交', '无需求', '家长放弃'];
    if (!validReasons.includes(lostReason)) {
      throw new BadRequestException(
        `lost_reason must be one of: ${validReasons.join(',')}`,
      );
    }
    return this.pg.transaction(
      async (client) => {
        const upd = await client.query(
          `UPDATE opportunities
              SET stage = '已失单',
                  lost_reason = $3,
                  updated_at = NOW(),
                  updated_by = $2,
                  last_contact_at = NOW()
            WHERE id = $1 AND owner_user_id = $2
          RETURNING *`,
          [customerId, userId, lostReason],
        );
        if (upd.rows.length === 0) {
          throw new NotFoundException(`customer ${customerId} not owned by you`);
        }
        await client.query(
          `INSERT INTO customer_follow_log
             (id, opportunity_id, follow_type, label, by_user_id, by_label, extra_json)
           VALUES ($1, $2, 'lost', $3, $4, $5, $6::jsonb)`,
          [
            this.genId(),
            customerId,
            `标记失单：${lostReason}`,
            userId,
            userLabel,
            JSON.stringify({ lostReason }),
          ],
        );
        return CustomerRepository.mapCustomerRow(upd.rows[0]);
      },
      { tenantSchema },
    );
  }

  // ===== 跟进时间轴 =====

  async listFollowLog(
    tenantSchema: string,
    customerId: string,
    limit = 100,
  ): Promise<FollowEntry[]> {
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT * FROM customer_follow_log
         WHERE opportunity_id = $1
         ORDER BY occurred_at DESC LIMIT $2`,
      [customerId, limit],
    );
    return rows.map((r) => CustomerRepository.mapFollowRow(r));
  }

  async addFollow(
    tenantSchema: string,
    customerId: string,
    args: {
      followType: FollowType;
      label: string;
      byUserId: string;
      byLabel: string;
      extra?: Record<string, unknown>;
    },
  ): Promise<FollowEntry> {
    return this.pg.transaction(
      async (client) => {
        // 校验客户存在
        const cust = await client.query(
          `SELECT id FROM opportunities WHERE id = $1`,
          [customerId],
        );
        if (cust.rows.length === 0) {
          throw new NotFoundException(`customer ${customerId} not found`);
        }
        const ins = await client.query(
          `INSERT INTO customer_follow_log
             (id, opportunity_id, follow_type, label, by_user_id, by_label, extra_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
          RETURNING *`,
          [
            this.genId(),
            customerId,
            args.followType,
            args.label,
            args.byUserId,
            args.byLabel,
            args.extra ? JSON.stringify(args.extra) : null,
          ],
        );
        // 更新 last_contact_at
        await client.query(
          `UPDATE opportunities
              SET last_contact_at = NOW(),
                  updated_at = NOW(),
                  updated_by = $2
            WHERE id = $1`,
          [customerId, args.byUserId],
        );
        return CustomerRepository.mapFollowRow(ins.rows[0]);
      },
      { tenantSchema },
    );
  }

  /**
   * cron 巡检：在跟客户 30 天无 last_contact_at → 自动入池
   */
  async expireColdToPool(tenantSchema: string): Promise<number> {
    const rows = await this.pg.tenantQuery<{ id: string }>(
      tenantSchema,
      `UPDATE opportunities
          SET owner_user_id = NULL,
              entered_pool_at = NOW(),
              enter_pool_reason = $1,
              updated_at = NOW()
        WHERE owner_user_id IS NOT NULL
          AND stage NOT IN ('已报名','已失单')
          AND COALESCE(last_contact_at, created_at) < NOW() - INTERVAL '30 days'
      RETURNING id`,
      [POOL_RESET_REASON.cold],
    );
    return rows.length;
  }

  // ===== Helper =====
  private genId(): string {
    // 32-char ULID-style（与项目其他地方一致）
    const chars = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    let s = '';
    for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }
}
