import { Injectable, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PgPoolService, PgRow } from './pg-pool.service';

/**
 * CourseProductRepository — 课程产品管理（V2 course_products）
 *
 * 来源：用户 2026-05-07 Phase 5「全做」— 校长/老板可补课程产品库
 *
 * 注：V29 销售签约可自填 courseProductName 不强制选既有产品；本表仍作为
 * 「机构标准产品库」给校长/老板预设常用产品（销售可选择性使用）。
 */

export interface CourseProduct {
  id: string;
  productName: string;
  courseLine: string;
  classType: string;
  lessonPackage: string | null;
  standardPrice: number;
  campusScope: string | null;
  status: '上架' | '下架';
  createdAt: string;
  updatedAt: string;
  /**
   * 2026-06-02 SSOT §3.-2 B「课程产品列表加销量」
   *   累计 COUNT(contracts) WHERE course_product_id=该产品 AND status ∉ {cancelled,refunded}
   *   AND deleted_at IS NULL（tenant-wide 目录视图，不限 campus）。
   *   仅 list() 计算并填充；findById/create/setStatus 路径不带销量（默认 0）。
   */
  salesCount: number;
}

/**
 * 5/15 拍板：course-product 升级为 OOUX 中心对象，detail 聚合学员/老师/本周消课
 *
 * 来源：feedback_教培业务架构-2026-05-10.md §六 + 用户口头 2026-05-15
 *
 * 返回字段（与前端 boss/products/detail 对齐）：
 *   - productId / productName 基础
 *   - studentCount / teacherCount / weeklyConsumedYuan 顶部 KPI
 *   - students[]：关联此课程「live」合同的学员（status IN active/pending）
 *   - teachers[]：本周此课程实际上课的老师（schedule 关联，仅在职）
 *
 * PII 注意：
 *   - 不返回 students.phone / id_number / 家庭住址
 *   - 不返回 teachers.phone / hourly_price_yuan
 *   - 仅返回 id / name / 业务必需字段（contractStatus / remainingHours / weeklyLessonCount）
 */
export interface CourseProductStatsStudent {
  /** student.id */
  id: string;
  /** student.student_name（admin/boss/academic 矩阵均可见） */
  name: string;
  /** contract.status — 'active' | 'pending' （pending 但学员已建即视为在册） */
  contractStatus: 'active' | 'pending';
  /** SUM(student_course_packages.remaining_lessons) WHERE student_id + 同 course_product */
  remainingHours: number;
}

export interface CourseProductStatsTeacher {
  /** teacher.id（用于 audit/back-trace） */
  id: string;
  /** teacher.user_id（前端 schedule/calendar?teacherId=userId 用） */
  userId: string | null;
  /** teacher.name（admin/boss/academic 矩阵均可见，不返回 phone/hourly_price） */
  name: string;
  /** 本周（date_trunc('week', NOW())） 这位老师在此 course_product 的课时数 */
  weeklyLessonCount: number;
}

export interface CourseProductStats {
  productId: string;
  productName: string;
  // P0 真机 bug 修 (5/20)：前端 wxml 需要这 5 字段渲染（在售/课程线/课程类型/课时包/标准价），
  // 之前 stats SQL 仅 select id+product_name，前端无法填充顶部基础信息 → fallback MOCK 假数据
  courseLine: string;
  classType: string;
  lessonPackage: string | null;
  standardPrice: number;
  status: '上架' | '下架';
  studentCount: number;
  teacherCount: number;
  /** 本周消课金额（course_consumptions.amount_yuan 在 status IN confirmed/locked 内 SUM） */
  weeklyConsumedYuan: number;
  students: CourseProductStatsStudent[];
  teachers: CourseProductStatsTeacher[];
}

@Injectable()
export class CourseProductRepository {
  constructor(private readonly pg: PgPoolService) {}

  static mapRow(r: PgRow): CourseProduct {
    return {
      id: r.id,
      productName: r.product_name,
      courseLine: r.course_line,
      classType: r.class_type,
      lessonPackage: r.lesson_package,
      standardPrice: Number(r.standard_price),
      campusScope: r.campus_scope,
      status: r.status as '上架' | '下架',
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
      // 2026-06-02 §3.-2 B：仅 list() SELECT 带 sales_count；其他路径无该列 → 0
      salesCount: r.sales_count == null ? 0 : parseInt(String(r.sales_count), 10) || 0,
    };
  }

  /**
   * 列产品 — 默认仅上架（销售签约时下拉用）；admin 管理时可看下架
   */
  async list(
    tenantSchema: string,
    options: { includeOffShelf?: boolean; limit?: number; offset?: number } = {},
  ): Promise<CourseProduct[]> {
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    const where = options.includeOffShelf ? '' : `WHERE cp.status = '上架'`;
    // 2026-06-02 SSOT §3.-2 B：列表加「累计销量」+ 排序在售优先 → 销量降序 → 新建优先
    //   sales_count = COUNT(contracts) by course_product_id（status ∉ {cancelled,refunded}
    //   + deleted_at IS NULL；tenant-wide 目录视图不限 campus）。
    //   用 LEFT JOIN 预聚合子查询（GROUP BY course_product_id）避免相关子查询每行扫；
    //   无合同的产品 → sc.sales_count NULL → COALESCE 0。
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT cp.*, COALESCE(sc.sales_count, 0) AS sales_count
         FROM course_products cp
         LEFT JOIN (
           SELECT course_product_id, COUNT(*) AS sales_count
             FROM contracts
            WHERE status NOT IN ('cancelled','refunded')
              AND deleted_at IS NULL
              AND course_product_id IS NOT NULL
            GROUP BY course_product_id
         ) sc ON sc.course_product_id = cp.id
         ${where}
         ORDER BY (CASE WHEN cp.status = '上架' THEN 0 ELSE 1 END), COALESCE(sc.sales_count, 0) DESC, cp.created_at DESC
         LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return rows.map((r) => CourseProductRepository.mapRow(r));
  }

  async findById(tenantSchema: string, id: string): Promise<CourseProduct | null> {
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT * FROM course_products WHERE id = $1`,
      [id],
    );
    return rows.length === 0 ? null : CourseProductRepository.mapRow(rows[0]);
  }

  /**
   * 创建产品（校长/老板预设）
   *
   * 唯一性：product_name + status='上架'（已有 V2 unique index）— 重复 → 409
   */
  async create(
    tenantSchema: string,
    payload: {
      id: string;
      productName: string;
      courseLine: string;
      classType: string;
      lessonPackage?: string | null;
      standardPrice: number;
      campusScope?: string | null;
      operatorUserId: string;
    },
  ): Promise<CourseProduct> {
    if (!payload.id || payload.id.length !== 32) {
      throw new BadRequestException('id must be 32-char ULID');
    }
    if (!payload.productName) throw new BadRequestException('productName required');
    if (!payload.courseLine) throw new BadRequestException('courseLine required');
    if (!payload.classType) throw new BadRequestException('classType required');
    if (payload.standardPrice < 0) throw new BadRequestException('standardPrice must be ≥ 0');

    try {
      const rows = await this.pg.tenantQuery<PgRow>(
        tenantSchema,
        `INSERT INTO course_products
           (id, product_name, course_line, class_type, lesson_package,
            standard_price, campus_scope, status, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'上架',$8,$8)
         RETURNING *`,
        [
          payload.id,
          payload.productName,
          payload.courseLine,
          payload.classType,
          payload.lessonPackage || null,
          payload.standardPrice,
          payload.campusScope || null,
          payload.operatorUserId,
        ],
      );
      return CourseProductRepository.mapRow(rows[0]);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        throw new ConflictException(`产品名「${payload.productName}」上架重复`);
      }
      throw e;
    }
  }

  /**
   * 切换上架/下架
   */
  async setStatus(
    tenantSchema: string,
    id: string,
    status: '上架' | '下架',
    operatorUserId: string,
  ): Promise<CourseProduct> {
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `UPDATE course_products
          SET status = $1, updated_at = NOW(), updated_by = $2
        WHERE id = $3
      RETURNING *`,
      [status, operatorUserId, id],
    );
    if (rows.length === 0) throw new NotFoundException(`course_product ${id} not found`);
    return CourseProductRepository.mapRow(rows[0]);
  }

  /**
   * 5/15 拍板：聚合查询课程对应的学员/老师/本周消课
   *
   * 来源：feedback_教培业务架构-2026-05-10.md §六 + 用户口头 2026-05-15
   *
   * 实现策略（4 个独立 query，避免单条巨型 JOIN）：
   *   1. SELECT course_products WHERE id = $1 — 校验存在 + 拿 product_name
   *   2. students[]：contracts.course_product_id = $1 AND status IN ('active','pending')
   *      JOIN students 取 name / id
   *      LEFT JOIN student_course_packages 累加 remaining_lessons（同 product 下）
   *   3. teachers[]：本周 schedules.course_product_id = $1
   *      JOIN teachers (status='在职') 拿 user_id / name
   *      GROUP BY teacher_id 聚合本周课时数
   *   4. weeklyConsumedYuan：course_consumptions JOIN schedules
   *      WHERE schedules.course_product_id = $1 AND consumed at this week
   *      AND status IN ('confirmed','locked')
   *
   * @returns null = product 不存在；否则 CourseProductStats（含 students/teachers 数组）
   */
  /**
   * 5/15 r2 拍板：findStats 加 RBAC scope 参数（A-3 sales filter + A-4 campus filter）
   *
   * 来源：用户 2026-05-15「sales 角色调 stats 时仅返回自己客户的学员；boss/academic
   *   多校区时仅看本校 course-product 聚合」(fields-by-role.md L285「校长 ✅ 本校」)
   *
   * 参数（均可选 — admin/boss 不传则看全部）：
   *   - callerOwnerSalesId: 限制 students[] 列表为 contract.owner_user_id = $X 的学员
   *     - sales 角色 controller 强制传 jwt.sub（防伪造他人）
   *     - admin/boss/academic 不传 → 看全部
   *   - callerCampusId: 限制 contracts/schedules/consumptions 校区 = $X（OR campus_id IS NULL 兜底）
   *     - boss/academic 多校 controller 传 jwt.campusId
   *     - admin 不传 → 看全部
   *     - 注：course_products 表是机构标准库（无 campus_id），过滤发生在 contract/schedule 层
   */
  async findStats(
    tenantSchema: string,
    productId: string,
    options: {
      callerOwnerSalesId?: string | null;
      callerCampusId?: string | null;
    } = {},
  ): Promise<CourseProductStats | null> {
    const callerOwnerSalesId = options.callerOwnerSalesId ?? null;
    const callerCampusId = options.callerCampusId ?? null;

    // 1. 校验 product 存在 + 拿全字段（P0 真机 bug 修 5/20：前端 wxml 顶部基础信息需 5 字段）
    const productRows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT id, product_name, course_line, class_type, lesson_package, standard_price, status
         FROM course_products WHERE id = $1`,
      [productId],
    );
    if (productRows.length === 0) return null;
    const productRow = productRows[0];
    const productName = String(productRow.product_name);

    // 2. students[]：合同 active + pending 视为在册
    //    LEFT JOIN student_course_packages 求 remaining_lessons（同 course_product_id 关联），
    //    一个学员同 product 多个 contract 可能多个 package，全部累加
    //
    // 5/15 r2 A-3 sales scope：callerOwnerSalesId IS NOT NULL → contract.owner_user_id = $X
    //   仅返回此 sales 自己签约的学员（防 sales 看到他校/他人客户）
    //
    // 5/15 r2 A-4 campus scope：callerCampusId IS NOT NULL → contract.campus_id = $X
    //   仅返回本校签约的学员（boss/academic 多校）
    //   注：contract.campus_id 可能 NULL（V26 之前老合同）→ 用 IS NOT DISTINCT 兜底太宽松，
    //   保守要求严格匹配（NULL 校区合同视为「未指定」不计入 boss 本校 view，由 admin/平台清理）
    const studentParams: unknown[] = [productId];
    let studentScopeSql = '';
    if (callerOwnerSalesId) {
      studentParams.push(callerOwnerSalesId);
      studentScopeSql += ` AND c.owner_user_id = $${studentParams.length}`;
    }
    if (callerCampusId) {
      studentParams.push(callerCampusId);
      studentScopeSql += ` AND c.campus_id = $${studentParams.length}`;
    }

    const studentRows = await this.pg.tenantQuery<{
      id: string;
      student_name: string;
      contract_status: string;
      remaining_hours: string;
    }>(
      tenantSchema,
      `SELECT
         s.id              AS id,
         s.student_name    AS student_name,
         -- 一学员可能多个合同（新签 + 续费），取最新 / 优先 active
         (
           SELECT c2.status FROM contracts c2
             WHERE c2.student_id = s.id
               AND c2.course_product_id = $1
               AND c2.deleted_at IS NULL
               AND c2.status IN ('active','pending')
             ORDER BY (c2.status = 'active') DESC, c2.signed_at DESC NULLS LAST
             LIMIT 1
         )                                                       AS contract_status,
         -- S1 真生产 bug 修 (5/20): 合同 pending 时无 student_course_packages → 0
         --   修复: 优先 packages 余额（active 合同精确）→ 兜底 contract.lesson_hours - 已消课时
         --   语义: pending 合同已锁课时未付款，余额 = 合同总课时 - 已消课时
         COALESCE(
           -- 优先：active 合同精确 packages 累加
           NULLIF(
             (SELECT SUM(scp.remaining_lessons)
                FROM student_course_packages scp
                JOIN course_packages cp ON cp.id = scp.course_package_id
               WHERE scp.student_id = s.id
                 AND cp.course_product_id = $1
                 AND scp.status = 'active'),
             0
           ),
           -- 兜底：合同已锁课时 - 已 confirmed/locked 消课
           GREATEST(
             COALESCE(
               (SELECT SUM(c3.lesson_hours)
                  FROM contracts c3
                 WHERE c3.student_id = s.id
                   AND c3.course_product_id = $1
                   AND c3.deleted_at IS NULL
                   AND c3.status IN ('active','pending')),
               0
             ) - COALESCE(
               (SELECT COUNT(*)::int
                  FROM course_consumptions cc2
                  JOIN schedules sc2 ON sc2.id = cc2.schedule_id
                 WHERE cc2.student_id = s.id
                   AND sc2.course_product_id = $1
                   AND cc2.status IN ('confirmed','locked')),
               0
             ),
             0
           )
         )                                                       AS remaining_hours
       FROM students s
       WHERE s.deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM contracts c
            WHERE c.student_id = s.id
              AND c.course_product_id = $1
              AND c.deleted_at IS NULL
              AND c.status IN ('active','pending')${studentScopeSql}
         )
       ORDER BY s.created_at DESC
       LIMIT 500`,
      studentParams,
    );

    const students: CourseProductStatsStudent[] = studentRows.map((r) => ({
      id: r.id,
      name: r.student_name,
      contractStatus: (r.contract_status === 'pending' ? 'pending' : 'active'),
      remainingHours: Number(r.remaining_hours) || 0,
    }));

    // 3. teachers[]：本周此 product 实际排课的老师（仅 status='在职'）
    //    GROUP BY teacher_id 聚合 weeklyLessonCount
    //
    // 5/15 r2 A-4 campus scope：sc.campus_id = callerCampusId（boss/academic 多校时）
    //   注：schedules.campus_id 是 V8 已有字段（V8 schema_template），单校 role 总传
    //
    // 5/15 r2 A-3 sales scope：sales 角色不调 boss/products/detail 不走 stats
    //   （fields-by-role.md L261「老板 ✅ / 校长 ✅ 本校 / 教务 👁」无 sales 视角）
    //   但 controller 层加 sales → 自动按学员所属 contract.owner_user_id 过滤
    //   teacher list 不强制按 sales 过滤（学员可能由其他销售签约共享同一老师）
    //   仅 callerCampusId 影响 teachers list
    const teacherParams: unknown[] = [productId];
    let teacherScopeSql = '';
    if (callerCampusId) {
      teacherParams.push(callerCampusId);
      teacherScopeSql += ` AND sc.campus_id = $${teacherParams.length}`;
    }

    const teacherRows = await this.pg.tenantQuery<{
      id: string;
      user_id: string | null;
      name: string;
      weekly_lesson_count: string;
    }>(
      tenantSchema,
      `SELECT
         t.id                                AS id,
         t.user_id                           AS user_id,
         t.name                              AS name,
         COUNT(sc.id)                        AS weekly_lesson_count
       FROM schedules sc
       JOIN teachers t ON t.id = sc.teacher_id
       WHERE sc.course_product_id = $1
         AND sc.start_at >= date_trunc('week', NOW())
         AND sc.status IN ('已排课','已完成','缺席')
         AND t.status = '在职'${teacherScopeSql}
       GROUP BY t.id, t.user_id, t.name
       ORDER BY weekly_lesson_count DESC, t.name ASC
       LIMIT 200`,
      teacherParams,
    );

    const teachers: CourseProductStatsTeacher[] = teacherRows.map((r) => ({
      id: r.id,
      userId: r.user_id || null,
      name: r.name,
      weeklyLessonCount: parseInt(r.weekly_lesson_count, 10) || 0,
    }));

    // 4. weeklyConsumedYuan：本周已确认/锁定 课消金额
    //    course_consumptions JOIN schedules WHERE schedules.course_product_id = $1
    //    本周 = consumption 对应 schedule.start_at >= date_trunc('week', NOW())
    //    status IN ('confirmed', 'locked')：confirmed=老师已填反馈；locked=24h 锁
    //
    // 5/15 r2 A-4 campus scope：sc.campus_id = callerCampusId（同 teachers query）
    const consumedParams: unknown[] = [productId];
    let consumedScopeSql = '';
    if (callerCampusId) {
      consumedParams.push(callerCampusId);
      consumedScopeSql += ` AND sc.campus_id = $${consumedParams.length}`;
    }

    const consumedRows = await this.pg.tenantQuery<{ total: string }>(
      tenantSchema,
      `SELECT COALESCE(SUM(cc.amount_yuan), 0) AS total
         FROM course_consumptions cc
         JOIN schedules sc ON sc.id = cc.schedule_id
        WHERE sc.course_product_id = $1
          AND sc.start_at >= date_trunc('week', NOW())
          AND cc.status IN ('confirmed','locked')${consumedScopeSql}`,
      consumedParams,
    );
    const weeklyConsumedYuan = Number(consumedRows[0]?.total ?? 0) || 0;

    return {
      productId,
      productName,
      // P0 真机 bug 修 (5/20)：前端 wxml 顶部基础信息需要这 5 字段渲染
      courseLine: String(productRow.course_line || ''),
      classType: String(productRow.class_type || ''),
      lessonPackage: productRow.lesson_package == null ? null : String(productRow.lesson_package),
      standardPrice: Number(productRow.standard_price ?? 0),
      status: (productRow.status as '上架' | '下架') || '上架',
      studentCount: students.length,
      teacherCount: teachers.length,
      weeklyConsumedYuan,
      students,
      teachers,
    };
  }
}
