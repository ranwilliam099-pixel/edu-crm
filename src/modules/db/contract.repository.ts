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
  studentName?: string | null;
  // V29 NULLABLE — 销售可自填 courseProductName 而不绑既有 course_products
  courseProductId: string | null;
  courseProductName: string | null;
  ownerUserId: string | null;
  // #10a (2026-05-31): 签约销售显示名（JOIN users.name by owner_user_id）
  //   - 前端读 salesName 显示「签约销售」，替代原始 ULID（ownerUserId.slice(0,6)）
  //   - 同租户 schema 内 JOIN，无跨租户面；姓名非一级 PII（手机/身份证才是），可返回
  //   - owner 为 null（无归属/池）或 users 行不存在 → salesName=null（前端显「—」）
  salesName?: string | null;
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
      studentName: r.student_name ?? null,
      courseProductId: r.course_product_id,
      courseProductName: r.course_product_name,
      ownerUserId: r.owner_user_id,
      // #10a (2026-05-31): owner_name 来自 LEFT JOIN users.name（仅查询带 JOIN 时有值）
      //   plain SELECT *（无 JOIN）→ r.owner_name undefined → salesName=null（前端显「—」）
      salesName: r.owner_name ?? null,
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
        // #10a (2026-05-31): JOIN users 取签约销售名（owner_name）→ Contract.salesName
        `SELECT c.*,
                s.student_name AS student_name,
                u.name AS owner_name,
                COALESCE(c.course_product_name, cp.product_name) AS course_product_name
           FROM contracts c
           LEFT JOIN students s ON s.id = c.student_id AND s.deleted_at IS NULL
           LEFT JOIN course_products cp ON cp.id = c.course_product_id
           LEFT JOIN users u ON u.id = c.owner_user_id AND u.deleted_at IS NULL
          WHERE c.owner_user_id = $1 AND c.status = $2 AND c.deleted_at IS NULL
          ORDER BY COALESCE(c.signed_at, c.created_at) DESC
           LIMIT $3 OFFSET $4`,
        [ownerUserId, options.status, limit, offset],
      );
      return rows.map((r) => ContractRepository.mapRow(r));
    }
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      // #10a (2026-05-31): JOIN users 取签约销售名（owner_name）→ Contract.salesName
      `SELECT c.*,
              s.student_name AS student_name,
              u.name AS owner_name,
              COALESCE(c.course_product_name, cp.product_name) AS course_product_name
         FROM contracts c
         LEFT JOIN students s ON s.id = c.student_id AND s.deleted_at IS NULL
         LEFT JOIN course_products cp ON cp.id = c.course_product_id
         LEFT JOIN users u ON u.id = c.owner_user_id AND u.deleted_at IS NULL
        WHERE c.owner_user_id = $1 AND c.deleted_at IS NULL
        ORDER BY COALESCE(c.signed_at, c.created_at) DESC
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
    ownerName: string;
    totalCount: number;
    totalAmount: number;
    thisMonthCount: number;
    thisMonthAmount: number;
  }>> {
    // 5/30 #1：JOIN 租户内 users 表取销售名字（前端不再静态假数据；users 在同一 tenant schema）
    const where = [
      `c.owner_user_id IS NOT NULL`,
      `c.status IN ('pending', 'active')`,
      `c.deleted_at IS NULL`,
    ];
    const params: any[] = [];
    if (campusId) {
      params.push(campusId);
      where.push(`c.campus_id = $${params.length}`);
    }
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT
         c.owner_user_id,
         u.name AS owner_name,
         COUNT(*) AS total_count,
         COALESCE(SUM(c.total_amount), 0) AS total_amount,
         COUNT(*) FILTER (WHERE c.signed_at >= date_trunc('month', NOW())) AS this_month_count,
         COALESCE(SUM(c.total_amount) FILTER (WHERE c.signed_at >= date_trunc('month', NOW())), 0) AS this_month_amount
       FROM contracts c
       LEFT JOIN users u ON u.id = c.owner_user_id AND u.deleted_at IS NULL
       WHERE ${where.join(' AND ')}
       GROUP BY c.owner_user_id, u.name
       ORDER BY this_month_amount DESC, total_amount DESC`,
      params,
    );
    return rows.map((r) => ({
      ownerUserId: r.owner_user_id,
      ownerName: r.owner_name || '—',
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
      // V29: courseProductId 与 courseProductName 二选一（至少有一个）
      courseProductId?: string | null;
      courseProductName?: string | null;
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
    // 2026-05-21 用户拍板：签约课程必须从机构已创建产品选，禁止销售自填，价格强一致
    //   1. courseProductId 必填（禁止销售自填新产品）
    //   2. SELECT course_products WHERE id=$1 校验存在 + status='在售'
    //   3. payload.standardPrice 与 course_products.standard_price 强一致（防 client 改价）
    //   4. payload.lessonHours ≥ course_products.lesson_package（最小节数语义，可以买更多）
    //   5. courseProductName / classType 从产品表回填（不接受 client 传值）
    if (!payload.courseProductId || payload.courseProductId.length !== 32) {
      throw new BadRequestException(
        '必须从机构已创建课程产品中选择（courseProductId 32-char ULID 必填），不允许销售自填',
      );
    }
    const productRows = await this.pg.tenantQuery<{
      id: string;
      product_name: string;
      class_type: string | null;
      lesson_package: number;
      standard_price: number | string;
      status: string;
    }>(
      tenantSchema,
      `SELECT id, product_name, class_type, lesson_package, standard_price, status
       FROM course_products WHERE id = $1 LIMIT 1`,
      [payload.courseProductId],
    );
    if (productRows.length === 0) {
      throw new BadRequestException(`课程产品不存在：${payload.courseProductId}`);
    }
    const product = productRows[0];
    // 2026-05-21 真机 fix: status 真实枚举是 '上架'/'下架' (V2 migration CHECK 约束)
    //   之前写的 '在售'/'active' 是误识别，会让所有真实「上架」产品被拒
    //   接受 '上架' / 'active' (legacy) ；拒绝 '下架' / 其他
    if (product.status === '下架') {
      throw new BadRequestException(
        `课程产品已下架（${product.product_name}），不能签约`,
      );
    }
    if (product.status !== '上架' && product.status !== 'active') {
      throw new BadRequestException(
        `课程产品状态异常（${product.product_name} status=${product.status}），不能签约`,
      );
    }
    const productPrice = Number(product.standard_price);
    if (Math.abs(productPrice - payload.standardPrice) > 0.01) {
      throw new BadRequestException(
        `单价不一致：产品标价 ¥${productPrice.toFixed(2)} 与传入 ¥${payload.standardPrice.toFixed(2)}（防销售改价；前端请从产品下拉自动填）`,
      );
    }
    // 2026-05-21 拍板：「最小节数」语义 — 销售签约可以买更多但不能少于最小
    //   旧（错）实现：严格相等 lessonHours === lesson_package
    //   新（对）实现：lessonHours ≥ lesson_package
    if (payload.lessonHours < Number(product.lesson_package)) {
      throw new BadRequestException(
        `课时数低于最小节数：产品最小 ${product.lesson_package} 课时，签约填 ${payload.lessonHours} 课时（可填更多但不能更少）`,
      );
    }
    if (payload.lessonHours <= 0) {
      throw new BadRequestException('课时数必须 > 0');
    }
    // 用产品表 product_name / class_type 强制回填（client 传值忽略）
    const enforcedProductName = product.product_name;
    const enforcedClassType = product.class_type || payload.classType || null;
    // 2026-05-21 真机 P0 业务流修：合同创建同 transaction 自动推进 opportunity.stage = '已报名'
    //   旧行为：INSERT contracts 但 customer.stage 仍是「咨询中」(opportunity 未推进)
    //   新行为：同 transaction 内 UPDATE 该 student 所有 active opportunity stage → '已报名'
    //          customer 详情下次拉数据时（mapper 从 opportunity JOIN）自动显示「已签约」
    //   原子性：合同写入 + opportunity 推进必须同 transaction，任一失败全 rollback
    const result = await this.pg.transaction(
      async (client) => {
        // 1. INSERT contracts (原有)
        const insertRes = await client.query(
          `INSERT INTO contracts
             (id, student_id, course_product_id, course_product_name, owner_user_id, opportunity_id, campus_id,
              class_type, lesson_hours, standard_price, discount_amount, gift_hours,
              total_amount, order_type, status, signed_at, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending',$15,$5,$5)
           RETURNING *`,
          [
            payload.id,
            payload.studentId,
            payload.courseProductId,        // 已校验非空 32-char
            enforcedProductName,             // 用产品表 product_name 强制（不接受 client 传值）
            payload.ownerUserId,
            payload.opportunityId || null,
            payload.campusId || null,
            enforcedClassType,               // 用产品表 class_type 强制
            payload.lessonHours,             // 已校验 = product.lesson_package
            payload.standardPrice,           // 已校验 = product.standard_price
            payload.discountAmount ?? 0,
            payload.giftHours ?? 0,
            payload.totalAmount,
            payload.orderType || '新签',
            payload.signedAt || new Date().toISOString(),
          ],
        );
        // 2. UPDATE opportunity stage → '已报名'
        //    精确路径：payload.opportunityId 提供时 update 这条
        //    fallback：未提供时按 student_id 批量 update（销售可能未传 opportunityId）
        //    where stage NOT IN ('已报名','已失单') 防止覆盖已失单状态
        if (payload.opportunityId) {
          await client.query(
            `UPDATE opportunities SET stage = '已报名', updated_at = NOW(), updated_by = $1
             WHERE id = $2 AND stage NOT IN ('已报名','已失单')`,
            [payload.ownerUserId, payload.opportunityId],
          );
        } else {
          await client.query(
            `UPDATE opportunities SET stage = '已报名', updated_at = NOW(), updated_by = $1
             WHERE student_id = $2 AND stage NOT IN ('已报名','已失单')`,
            [payload.ownerUserId, payload.studentId],
          );
        }
        return insertRes.rows[0];
      },
      { tenantSchema },
    );
    return ContractRepository.mapRow(result);
  }

  /**
   * V29 R3 学员视角：列该学员所有合同（OOUX student → contracts[] 关系）
   *
   * 来源：用户 2026-05-07「合同也在学员里面」
   * 用于：学员详情页 Section 6「续费 / 购课记录」真接（替代 mock）
   *
   * 排序：signed_at DESC NULLS LAST + created_at DESC
   * 不过滤 status — 学员视角看全部历史合同（含 cancelled / expired）
   */
  async listByStudent(
    tenantSchema: string,
    studentId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<Contract[]> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    // #10a + #10c (2026-05-31): 与 listByOwner 一致 — JOIN users 取销售名（owner_name）
    //   + COALESCE(course_product_name, cp.product_name) 回填课程名
    //   旧 plain SELECT * 缺 owner_name → 前端显原始 ULID；缺 product fallback → 旧空快照行显「未命名课程」
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT c.*,
              u.name AS owner_name,
              COALESCE(c.course_product_name, cp.product_name) AS course_product_name
         FROM contracts c
         LEFT JOIN course_products cp ON cp.id = c.course_product_id
         LEFT JOIN users u ON u.id = c.owner_user_id AND u.deleted_at IS NULL
        WHERE c.student_id = $1 AND c.deleted_at IS NULL
        ORDER BY c.signed_at DESC NULLS LAST, c.created_at DESC
        LIMIT $2 OFFSET $3`,
      [studentId, limit, offset],
    );
    return rows.map((r) => ContractRepository.mapRow(r));
  }

  /**
   * Phase 2 财务激活重构 (2026-06-01)：本校待激活合同列表（财务激活数据源）
   *
   * 用途：财务「确认收款 → 激活」工作台列出本校 status='pending' 合同。
   *   激活动作走 POST /db/contracts/:contractId/activate（已存在，pending→active）。
   *   本方法只提供「待激活清单」，只读，不写 audit（与其他 list 一致）。
   *
   * 范围：本校（campus_id = JWT.campusId，controller 层强制 — 禁信前端传参）+ status='pending'。
   *   finance 是单校 role；controller 缺 campusId → 403（不查库）。
   *
   * 投影：仅返回激活清单所需字段（与前端对接约定）：
   *   id / studentName / productName(COALESCE) / totalAmount / signedAt / status。
   *   金额对 finance 可见（§4.5 作账可见；maskContract finance 分支不剥价格）。
   *
   * SQL：JOIN students 取学员名 + COALESCE(course_product_name, cp.product_name) 取课程名
   *   （参照 listByOwner JOIN 写法）。参数化（campus_id = $1）防注入。
   *   排序：signed_at 早的优先（NULLS LAST）→ 先签先激活，再按 created_at。
   */
  async listPendingActivationByCampus(
    tenantSchema: string,
    campusId: string,
  ): Promise<
    Array<{
      id: string;
      studentName: string | null;
      productName: string | null;
      totalAmount: number;
      signedAt: string | null;
      status: ContractStatus;
    }>
  > {
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT c.id,
              s.student_name AS student_name,
              COALESCE(c.course_product_name, cp.product_name) AS course_product_name,
              c.total_amount,
              c.signed_at,
              c.status
         FROM contracts c
         LEFT JOIN students s ON s.id = c.student_id AND s.deleted_at IS NULL
         LEFT JOIN course_products cp ON cp.id = c.course_product_id
        WHERE c.status = 'pending'
          AND c.campus_id = $1
          AND c.deleted_at IS NULL
        ORDER BY c.signed_at ASC NULLS LAST, c.created_at ASC`,
      [campusId],
    );
    return rows.map((r) => ({
      id: r.id,
      studentName: r.student_name ?? null,
      productName: r.course_product_name ?? null,
      totalAmount: Number(r.total_amount),
      signedAt: r.signed_at ? new Date(r.signed_at).toISOString() : null,
      status: r.status as ContractStatus,
    }));
  }

  async findById(tenantSchema: string, id: string): Promise<Contract | null> {
    // #10a + #10c (2026-05-31): 详情同样 JOIN users 取销售名 + COALESCE 课程名回填
    //   旧 plain SELECT * → 详情页「签约销售」显原始 ULID + 空快照显「未命名课程」
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT c.*,
              u.name AS owner_name,
              COALESCE(c.course_product_name, cp.product_name) AS course_product_name
         FROM contracts c
         LEFT JOIN course_products cp ON cp.id = c.course_product_id
         LEFT JOIN users u ON u.id = c.owner_user_id AND u.deleted_at IS NULL
        WHERE c.id = $1 AND c.deleted_at IS NULL`,
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
