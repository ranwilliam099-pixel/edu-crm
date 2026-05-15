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
    const where = options.includeOffShelf ? '' : `WHERE status = '上架'`;
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT * FROM course_products
         ${where}
         ORDER BY status DESC, created_at DESC
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
  async findStats(
    tenantSchema: string,
    productId: string,
  ): Promise<CourseProductStats | null> {
    // 1. 校验 product 存在 + 拿 name
    const productRows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT id, product_name FROM course_products WHERE id = $1`,
      [productId],
    );
    if (productRows.length === 0) return null;
    const productName = String(productRows[0].product_name);

    // 2. students[]：合同 active + pending 视为在册
    //    LEFT JOIN student_course_packages 求 remaining_lessons（同 course_product_id 关联），
    //    一个学员同 product 多个 contract 可能多个 package，全部累加
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
         COALESCE(
           (SELECT SUM(scp.remaining_lessons)
              FROM student_course_packages scp
              JOIN course_packages cp ON cp.id = scp.course_package_id
             WHERE scp.student_id = s.id
               AND cp.course_product_id = $1
               AND scp.status = 'active'),
           0
         )                                                       AS remaining_hours
       FROM students s
       WHERE EXISTS (
         SELECT 1 FROM contracts c
          WHERE c.student_id = s.id
            AND c.course_product_id = $1
            AND c.deleted_at IS NULL
            AND c.status IN ('active','pending')
       )
       ORDER BY s.created_at DESC
       LIMIT 500`,
      [productId],
    );

    const students: CourseProductStatsStudent[] = studentRows.map((r) => ({
      id: r.id,
      name: r.student_name,
      contractStatus: (r.contract_status === 'pending' ? 'pending' : 'active'),
      remainingHours: Number(r.remaining_hours) || 0,
    }));

    // 3. teachers[]：本周此 product 实际排课的老师（仅 status='在职'）
    //    GROUP BY teacher_id 聚合 weeklyLessonCount
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
         AND t.status = '在职'
       GROUP BY t.id, t.user_id, t.name
       ORDER BY weekly_lesson_count DESC, t.name ASC
       LIMIT 200`,
      [productId],
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
    const consumedRows = await this.pg.tenantQuery<{ total: string }>(
      tenantSchema,
      `SELECT COALESCE(SUM(cc.amount_yuan), 0) AS total
         FROM course_consumptions cc
         JOIN schedules sc ON sc.id = cc.schedule_id
        WHERE sc.course_product_id = $1
          AND sc.start_at >= date_trunc('week', NOW())
          AND cc.status IN ('confirmed','locked')`,
      [productId],
    );
    const weeklyConsumedYuan = Number(consumedRows[0]?.total ?? 0) || 0;

    return {
      productId,
      productName,
      studentCount: students.length,
      teacherCount: teachers.length,
      weeklyConsumedYuan,
      students,
      teachers,
    };
  }
}
