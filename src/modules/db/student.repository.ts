import { Injectable, Logger, Optional, BadRequestException, NotFoundException } from '@nestjs/common';
import { PgPoolService, PgRow } from './pg-pool.service';
import { AuditLogRepository, normalizeActorRole } from './audit-log.repository';
import { ParentRepository } from './parent.repository';
import {
  academicYear,
  computeCurrentGrade,
  gradeBaseYearForWrite,
} from '../../common/grade-ladder';

/**
 * StudentRepository — V28 学生归属字段读写 + 单条学生归属转移
 *
 * 来源：用户 2026-05-07「学生也可以切换给别的老师和销售」
 *
 * 字段（V28 加）：
 *   owner_sales_id        销售归属（FK users）
 *   assigned_teacher_id   主带老师（FK teachers）
 *   owner_changed_at      最近一次归属变更时间
 *   owner_change_reason   变更原因（'老师手动转交' / '销售手动转交' / '老师归档' / ...）
 *
 * V44 软删除（2026-05-16 T12）：
 *   deleted_at TIMESTAMPTZ NULL — NULL=active；NOT NULL=已软删
 *   所有 SELECT 默认加 WHERE s.deleted_at IS NULL（排除已删学员）
 *   softDelete(id, operator) 事务内 UPDATE deleted_at=NOW() + 联动 binding 解绑 + audit_log
 */

export interface StudentBrief {
  id: string;
  studentName: string;
  customerId: string;
  ownerSalesId: string | null;
  assignedTeacherId: string | null;
  ownerChangedAt: string | null;
  ownerChangeReason: string | null;
  // V29 R12 追加常用展示字段（OOUX 老师/销售排课时学生卡需要）
  gradeOrAge: string | null;
  // SSOT §4.1.1 学员年级自动升级（computed-on-read）：
  //   gradeOrAge = 录入原值（库存不改）；currentGrade = 按当前学年推算（封顶高三，非阶梯豁免）
  //   gradeBaseYear = V62 录入时学年（null=老数据未 backfill，读时用 createdAt 学年兜底）
  currentGrade: string | null;
  gradeBaseYear: number | null;
  intendedSubject: string | null;
  // V29 R14.4 学员最新 active 合同的班型（用于排课时一致性校验）
  contractClassType?: string | null;
  // 2026-05-30 #18: 校区看师生 — listAll 一并返回校区归属（来自 customers.campus_id JOIN）
  //   students 表无 campus_id 列，学员随家庭主档归校区；仅 listAll 路径 JOIN 后有值，
  //   其他路径（listByTeacher / findBrief 等无 JOIN）为 null
  campusId?: string | null;
}

/**
 * 2026-05-21 新增：完整学员详情（学员档案 page b/student/detail 用）
 *   GET /db/students/:id 返回，JOIN customer 拿主家长 + JOIN campus 拿校区名 + JOIN users 拿 owner/teacher 名
 *   字段 mask 由 controller 层 RoleFieldFilter 处理（finance 不展示 parent_phone）
 */
export interface StudentDetail {
  id: string;
  studentName: string;
  gradeOrAge: string | null;
  // SSOT §4.1.1 computed-on-read 推算年级（封顶高三，非阶梯豁免；gradeOrAge 保留原值）
  currentGrade: string | null;
  gradeBaseYear: number | null;
  intendedSubject: string | null;
  customerId: string;
  parentName: string | null;       // customer.parent_name
  parentPhone: string | null;      // customer.primary_mobile (前端 maskPhone)
  parentGender: string | null;     // V55 家长性别
  campusId: string | null;
  campusName: string | null;       // JOIN campuses
  ownerSalesId: string | null;
  ownerSalesName: string | null;   // JOIN users
  assignedTeacherId: string | null;
  assignedTeacherName: string | null; // JOIN teachers
  notes: string | null;             // students.notes（如 V25 后添加）/ opportunity.note fallback
  // V55 新字段
  gender: string | null;            // 学员性别
  school: string | null;            // 就读学校
  phone: string | null;             // 学员本人电话
  availableTime: string[] | null;   // 上课时间 21 slot
  createdAt: string;
}

export interface StudentTransferResult {
  studentId: string;
  fromUserId: string | null;
  toUserId: string | null;
  field: 'owner_sales_id' | 'assigned_teacher_id';
  reason: string;
}

/**
 * V44 软删除结果（softDelete 返回值）
 */
export interface StudentSoftDeleteResult {
  studentId: string;
  deletedAt: string;
  bindingsExpired: number;
}

@Injectable()
export class StudentRepository {
  private readonly logger = new Logger(StudentRepository.name);

  constructor(
    private readonly pg: PgPoolService,
    private readonly parentRepo: ParentRepository,
    @Optional() private readonly auditLog?: AuditLogRepository,
  ) {}

  /**
   * SSOT §4.1.1 computed-on-read 时钟（可注入测试）。
   *   生产 = () => new Date()（服务器本地 = 北京时间）。
   *   单测可临时覆盖 StudentRepository.now = () => new Date(2026, 8, 1) 模拟当前学年。
   *   static 不影响 DI；mapBrief 是 static 工具方法，故 clock 也设 static。
   */
  static now: () => Date = () => new Date();

  /**
   * SSOT §4.1.1：把 grade_or_age 录入原值 + grade_base_year 按当前学年推算 currentGrade。
   *   - grade_base_year 缺失（老数据未 backfill）→ 用 created_at 学年兜底。
   *   - 缺 created_at 且缺 grade_base_year → computeCurrentGrade 内保守原样返回。
   * 纯 helper，供 mapBrief / findFullDetail 复用，保证两路口径一致。
   */
  private static computeGrade(
    gradeOrAge: string | null,
    gradeBaseYearRaw: unknown,
    createdAtRaw: unknown,
  ): { currentGrade: string | null; gradeBaseYear: number | null } {
    let gradeBaseYear: number | null =
      gradeBaseYearRaw === null || gradeBaseYearRaw === undefined
        ? null
        : Number(gradeBaseYearRaw);
    if (gradeBaseYear !== null && !Number.isFinite(gradeBaseYear)) gradeBaseYear = null;
    // 兜底：grade_base_year 为 null 时用 created_at 学年（老数据未 backfill 路径）
    const effectiveBaseYear =
      gradeBaseYear ??
      (createdAtRaw ? academicYear(new Date(createdAtRaw as string | number | Date)) : null);
    const currentGrade =
      (computeCurrentGrade(gradeOrAge, effectiveBaseYear, StudentRepository.now()) as
        | string
        | null) ?? null;
    return { currentGrade, gradeBaseYear };
  }

  static mapBrief(r: PgRow): StudentBrief {
    const gradeOrAge = r.grade_or_age || null;
    // SSOT §4.1.1 computed-on-read：SELECT 需带 grade_base_year（+ created_at 兜底）
    const { currentGrade, gradeBaseYear } = StudentRepository.computeGrade(
      gradeOrAge,
      r.grade_base_year,
      r.created_at,
    );
    return {
      id: r.id,
      studentName: r.student_name,
      customerId: r.customer_id,
      ownerSalesId: r.owner_sales_id,
      assignedTeacherId: r.assigned_teacher_id,
      ownerChangedAt: r.owner_changed_at ? new Date(r.owner_changed_at).toISOString() : null,
      ownerChangeReason: r.owner_change_reason,
      gradeOrAge,
      currentGrade,
      gradeBaseYear,
      intendedSubject: r.intended_subject || null,
      // V29 R14.4 contract_class_type 来自 join 子查询（仅 listByTeacher 用，其他 SELECT 没 join 时为 null）
      contractClassType: r.contract_class_type || null,
      // 2026-05-30 #18: campus_id 仅 listAll 路径 SELECT，其余路径无该列 → undefined → null
      campusId: r.campus_id ?? null,
    };
  }

  /**
   * V29 R2 销售即时建学生（替代仅 batch import 的限制）
   *
   * 来源：用户 2026-05-07「全做」— 销售签约前临时新增学员
   *
   * 必填：id（32-char ULID）/ studentName / customerId（FK customers，必须已存在）
   * 可选：gradeOrAge / intendedSubject / ownerSalesId / assignedTeacherId / studentInfo
   */
  async create(
    tenantSchema: string,
    payload: {
      id: string;
      studentName: string;
      customerId: string;
      gradeOrAge?: string;
      intendedSubject?: string;
      schoolName?: string;
      gender?: '男' | '女' | '未知';
      ownerSalesId?: string | null;
      assignedTeacherId?: string | null;
      operatorUserId: string;
    },
  ): Promise<StudentBrief> {
    if (!payload.id || payload.id.length !== 32) {
      throw new BadRequestException('student id must be 32-char ULID');
    }
    if (!payload.studentName || payload.studentName.length > 32) {
      throw new BadRequestException('studentName required and ≤ 32');
    }
    if (!payload.customerId || payload.customerId.length !== 32) {
      throw new BadRequestException('customerId must be 32-char ULID');
    }
    // SSOT §4.1.1 写路径：录入年级时同步写 grade_base_year = 当前学年
    const baseYear = gradeBaseYearForWrite(StudentRepository.now());
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `INSERT INTO students
         (id, student_name, customer_id, grade_or_age, grade_base_year, intended_subject, school_name, gender,
          owner_sales_id, assigned_teacher_id, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
       RETURNING id, student_name, customer_id, owner_sales_id, assigned_teacher_id,
                 owner_changed_at, owner_change_reason, grade_or_age, grade_base_year,
                 intended_subject, created_at`,
      [
        payload.id,
        payload.studentName,
        payload.customerId,
        payload.gradeOrAge || null,
        baseYear,
        payload.intendedSubject || null,
        payload.schoolName || null,
        payload.gender || null,
        payload.ownerSalesId || null,
        payload.assignedTeacherId || null,
        payload.operatorUserId,
      ],
    );
    return StudentRepository.mapBrief(rows[0]);
  }

  /**
   * V29 R4 老师视角：列该老师主带学生（OOUX teacher → students[] 关系）
   *
   * 来源：用户 2026-05-07 OOUX 哲学 — 老师详情一站式
   * 用于：老师详情页「主带学生」section
   */
  async listByTeacher(
    tenantSchema: string,
    teacherId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<StudentBrief[]> {
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    // V29 R14.4 join 子查询拿学员最新 active 合同 class_type（用于排课一致性校验）
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT s.id, s.student_name, s.customer_id, s.owner_sales_id, s.assigned_teacher_id,
              s.owner_changed_at, s.owner_change_reason, s.grade_or_age, s.grade_base_year,
              s.intended_subject, s.created_at,
              (SELECT c.class_type FROM contracts c
                 WHERE c.student_id = s.id
                   AND c.status IN ('pending', 'active')
                   AND c.deleted_at IS NULL
                 ORDER BY COALESCE(c.signed_at, c.created_at) DESC
                 LIMIT 1) AS contract_class_type
         FROM students s
         WHERE s.assigned_teacher_id = $1
           AND s.deleted_at IS NULL
         ORDER BY s.created_at DESC
         LIMIT $2 OFFSET $3`,
      [teacherId, limit, offset],
    );
    return rows.map((r) => StudentRepository.mapBrief(r));
  }

  async listAll(
    tenantSchema: string,
    options: {
      limit?: number;
      offset?: number;
      ownerSalesId?: string;
      assignedTeacherId?: string;
      // 2026-05-30 #18: 校区看师生 — 可选 campusId 过滤（不传保持全返，不破坏现有调用方）
      campusId?: string;
    } = {},
  ): Promise<StudentBrief[]> {
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    // V44: 默认排除已软删学员
    const where: string[] = ['s.deleted_at IS NULL'];
    const params: any[] = [];
    if (options.ownerSalesId) {
      params.push(options.ownerSalesId);
      where.push(`s.owner_sales_id = $${params.length}`);
    }
    if (options.assignedTeacherId) {
      params.push(options.assignedTeacherId);
      where.push(`s.assigned_teacher_id = $${params.length}`);
    }
    // 2026-05-30 #18: campusId 传了才加 WHERE，不传不加（向后兼容）
    //   注意：students 表无 campus_id 列（V2 schema 确认）；学员校区归属源 = 其家庭主档
    //   customers.campus_id（NOT NULL）。故按 customer 的 campus 过滤。
    if (options.campusId) {
      params.push(options.campusId);
      where.push(`cu.campus_id = $${params.length}`);
    }
    params.push(limit, offset);
    const limitIdx = params.length - 1;
    const offsetIdx = params.length;
    // LEFT JOIN customers 拿校区归属（cu.campus_id）：
    //   - campusId 过滤走 cu.campus_id（学员随家庭主档归校区）
    //   - SELECT cu.campus_id 一并返回 StudentBrief.campusId（前端校区视角展示）
    //   LEFT JOIN 保证即使 customer 异常缺失也不丢学员行（campusId → null）
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT s.id, s.student_name, s.customer_id, s.owner_sales_id, s.assigned_teacher_id,
              s.owner_changed_at, s.owner_change_reason, s.grade_or_age, s.grade_base_year,
              s.intended_subject, s.created_at,
              cu.campus_id,
              (SELECT c.class_type FROM contracts c
                 WHERE c.student_id = s.id
                   AND c.status IN ('pending', 'active')
                   AND c.deleted_at IS NULL
                 ORDER BY COALESCE(c.signed_at, c.created_at) DESC
                 LIMIT 1) AS contract_class_type
         FROM students s
         LEFT JOIN customers cu ON cu.id = s.customer_id
         WHERE ${where.join(' AND ')}
         ORDER BY s.created_at DESC
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    );
    return rows.map((r) => StudentRepository.mapBrief(r));
  }

  /**
   * 2026-05-21 销售可编辑学员字段（V55 新增 + 已有）
   *   仅 owner_sales_id = me 的销售可改（controller 层校验）
   *   admin/boss/academic 可改任意学员（同样 controller 校验）
   *   PATCH 模式：仅 patch 非 undefined 字段
   */
  async update(
    tenantSchema: string,
    studentId: string,
    operatorUserId: string,
    patch: {
      studentName?: string;
      gradeOrAge?: string | null;
      intendedSubject?: string | null;
      gender?: string | null;
      school?: string | null;
      phone?: string | null;
      availableTime?: string[] | null;
    },
  ): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, val: unknown) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };
    if (patch.studentName !== undefined) push('student_name', patch.studentName);
    if (patch.gradeOrAge !== undefined) {
      push('grade_or_age', patch.gradeOrAge);
      // SSOT §4.1.1 写路径：编辑年级时同步重置 grade_base_year = 当前学年
      //   （编辑年级 = 重新录入基准；前端回显的是推算 currentGrade，用户改后即新基准）
      push('grade_base_year', gradeBaseYearForWrite(StudentRepository.now()));
    }
    if (patch.intendedSubject !== undefined) push('intended_subject', patch.intendedSubject);
    if (patch.gender !== undefined) push('gender', patch.gender);
    if (patch.school !== undefined) push('school', patch.school);
    if (patch.phone !== undefined) push('phone', patch.phone);
    if (patch.availableTime !== undefined) push('available_time', patch.availableTime);

    if (sets.length === 0) {
      throw new BadRequestException('至少传一个 patch 字段');
    }

    params.push(operatorUserId);  // updated_by
    params.push(studentId);
    sets.push(`updated_at = NOW()`);
    sets.push(`updated_by = $${params.length - 1}`);

    const sql = `UPDATE students SET ${sets.join(', ')} WHERE id = $${params.length} AND deleted_at IS NULL`;
    const rows = await this.pg.tenantQuery<{ id: string }>(tenantSchema, sql, params);
    // tenantQuery 返回的是 rows 数组（PG UPDATE 默认不返），rowCount 校验略过
    // 如需校验影响行数 → 改 client.query 拿 result.rowCount
    void rows;
  }

  async findBrief(tenantSchema: string, id: string): Promise<StudentBrief | null> {
    // V44: 默认排除已软删学员（已删学员 findBrief 返回 null，等同 NotFound）
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT id, student_name, customer_id, owner_sales_id, assigned_teacher_id,
              owner_changed_at, owner_change_reason, grade_or_age, grade_base_year,
              intended_subject, created_at
         FROM students WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return rows.length === 0 ? null : StudentRepository.mapBrief(rows[0]);
  }

  /**
   * 2026-05-21 新增：学员档案完整详情
   *   GET /db/students/:id endpoint 用，b/student/detail page 拿基础信息
   *   JOIN: customers / public.campuses / public.users (owner_sales) / teachers (assigned)
   *   primary_mobile 直读明文列（V41 双写仍保留明文，前端 maskPhone 处理）
   *   注：finance role 完整 mask 由 controller 层 RoleFieldFilter 处理
   */
  async findFullDetail(tenantSchema: string, id: string): Promise<StudentDetail | null> {
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT s.id, s.student_name, s.grade_or_age, s.grade_base_year, s.intended_subject,
              s.customer_id, s.owner_sales_id, s.assigned_teacher_id, s.created_at,
              s.gender, s.school, s.phone, s.available_time,
              c.parent_name, c.primary_mobile, c.parent_gender,
              c.campus_id,
              cp.name AS campus_name,
              ou.name AS owner_sales_name,
              t.name AS assigned_teacher_name,
              (SELECT o.note FROM opportunities o
                 WHERE o.student_id = s.id ORDER BY o.created_at DESC LIMIT 1) AS notes
         FROM students s
         LEFT JOIN customers c ON c.id = s.customer_id
         LEFT JOIN public.campuses cp ON cp.id = c.campus_id
         LEFT JOIN users ou ON ou.id = s.owner_sales_id
         LEFT JOIN teachers t ON t.id = s.assigned_teacher_id
        WHERE s.id = $1 AND s.deleted_at IS NULL`,
      [id],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    // SSOT §4.1.1 computed-on-read：推算 currentGrade（gradeOrAge 保留原值；缺 base_year 用 created_at 兜底）
    const { currentGrade, gradeBaseYear } = StudentRepository.computeGrade(
      r.grade_or_age ?? null,
      r.grade_base_year,
      r.created_at,
    );
    return {
      id: r.id,
      studentName: r.student_name,
      gradeOrAge: r.grade_or_age,
      currentGrade,
      gradeBaseYear,
      intendedSubject: r.intended_subject,
      customerId: r.customer_id,
      parentName: r.parent_name,
      parentPhone: r.primary_mobile || null,
      parentGender: r.parent_gender || null,
      campusId: r.campus_id,
      campusName: r.campus_name,
      ownerSalesId: r.owner_sales_id,
      ownerSalesName: r.owner_sales_name,
      assignedTeacherId: r.assigned_teacher_id,
      assignedTeacherName: r.assigned_teacher_name,
      notes: r.notes,
      gender: r.gender || null,
      school: r.school || null,
      phone: r.phone || null,
      availableTime: Array.isArray(r.available_time) ? r.available_time : null,
      createdAt: new Date(r.created_at).toISOString(),
    };
  }

  /**
   * 把学生转给另一个销售（owner_sales_id 改写）
   *
   * @param toSalesId 接棒销售 user.id；null = 退回池（学生归属暂无）
   * @param reason    'sales 主动转交' / '校长再分配' 等可读原因（写 owner_change_reason）
   */
  async transferSales(
    tenantSchema: string,
    studentId: string,
    toSalesId: string | null,
    reason: string,
  ): Promise<StudentTransferResult> {
    if (!reason) throw new BadRequestException('reason required');
    const before = await this.findBrief(tenantSchema, studentId);
    if (!before) throw new NotFoundException(`student ${studentId} not found`);
    if (before.ownerSalesId === toSalesId) {
      throw new BadRequestException('已是该销售归属，无须转交');
    }
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `UPDATE students
          SET owner_sales_id = $2,
              owner_changed_at = NOW(),
              owner_change_reason = $3
        WHERE id = $1
      RETURNING id, owner_sales_id`,
      [studentId, toSalesId, reason],
    );
    return {
      studentId: rows[0].id,
      fromUserId: before.ownerSalesId,
      toUserId: rows[0].owner_sales_id,
      field: 'owner_sales_id',
      reason,
    };
  }

  /**
   * 把学生主带老师转给另一个老师（assigned_teacher_id 改写）
   *
   * @param toTeacherId 接棒老师 teacher.id；null = 暂无
   */
  async transferTeacher(
    tenantSchema: string,
    studentId: string,
    toTeacherId: string | null,
    reason: string,
  ): Promise<StudentTransferResult> {
    if (!reason) throw new BadRequestException('reason required');
    const before = await this.findBrief(tenantSchema, studentId);
    if (!before) throw new NotFoundException(`student ${studentId} not found`);
    if (before.assignedTeacherId === toTeacherId) {
      throw new BadRequestException('已是该老师主带，无须转交');
    }
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `UPDATE students
          SET assigned_teacher_id = $2,
              owner_changed_at = NOW(),
              owner_change_reason = $3
        WHERE id = $1
      RETURNING id, assigned_teacher_id`,
      [studentId, toTeacherId, reason],
    );
    return {
      studentId: rows[0].id,
      fromUserId: before.assignedTeacherId,
      toUserId: rows[0].assigned_teacher_id,
      field: 'assigned_teacher_id',
      reason,
    };
  }

  /**
   * V44 软删除（2026-05-16 T12）
   *
   * 来源：R1 audit P0-3 / doc 主键设计与唯一性保证.md §6.2 承诺
   *
   * 行为（事务内）：
   *   1. UPDATE students SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL
   *      - 幂等：已软删的学员（deleted_at NOT NULL）→ BadRequestException
   *      - 不存在的学员 → NotFoundException
   *   2. 联动调用 parent.expireBindingsForDeletedStudents 解绑 active 的 parent-student bindings
   *      （跨 schema：tenant.students → public.parent_student_bindings）
   *
   * 事务外（V33 设计）：
   *   3. audit_log action='student.soft-delete'（fail-open，写失败不阻塞主业务）
   *
   * 接口契约配套：
   *   - cron 兜底（每日扫 tenant.students.deleted_at NOT NULL → 同步 binding）
   *     由 T-CRON-BINDING-SYNC backlog 实施，复用 expireBindingsForDeletedStudents
   *
   * @param tenantSchema  tenant_xxx schema 名（pg-pool 自动 sanitize）
   * @param studentId     32-char ULID
   * @param tenantId      raw tenant id（用于 binding 跨 schema 解绑 WHERE tenant_id）
   * @param operator      操作者上下文（actorUserId + actorRole 写 audit_log）
   */
  async softDelete(
    tenantSchema: string,
    studentId: string,
    tenantId: string,
    operator: { userId: string; role?: string | null },
  ): Promise<StudentSoftDeleteResult> {
    if (!studentId || studentId.length !== 32) {
      throw new BadRequestException('studentId must be 32-char ULID');
    }
    if (!tenantId) {
      throw new BadRequestException('tenantId required');
    }

    const result = await this.pg.transaction(
      async (client) => {
        // 1. UPDATE students.deleted_at
        const updRes = await client.query<PgRow>(
          `UPDATE students
              SET deleted_at = NOW()
            WHERE id = $1 AND deleted_at IS NULL
          RETURNING id, deleted_at`,
          [studentId],
        );
        if (updRes.rowCount === 0) {
          // 区分「不存在」vs「已软删」: 再查一次原始行
          const probe = await client.query<PgRow>(
            `SELECT id, deleted_at FROM students WHERE id = $1`,
            [studentId],
          );
          if (probe.rowCount === 0) {
            throw new NotFoundException(`student ${studentId} not found`);
          }
          throw new BadRequestException(`student ${studentId} 已软删除（幂等保护）`);
        }

        // 2. 同事务联动解绑 binding
        const bindingResult = await this.parentRepo.expireBindingsForDeletedStudents(
          tenantId,
          [studentId],
          client,
        );

        return {
          studentId: updRes.rows[0].id,
          deletedAt: new Date(updRes.rows[0].deleted_at).toISOString(),
          bindingsExpired: bindingResult.unbounded,
        };
      },
      { tenantSchema },
    );

    // 3. audit_log（事务外，V33 fail-open；audit-log.repository.ts L34
    //   "主业务流应在事务外调用 log()，避免 audit_log 失败回滚业务"）
    if (this.auditLog) {
      await this.auditLog.log(tenantSchema, {
        actorUserId: operator.userId,
        actorRole: normalizeActorRole(operator.role),
        action: 'student.soft-delete',
        targetType: 'student',
        targetId: studentId,
        before: { deletedAt: null },
        after: {
          deletedAt: result.deletedAt,
          bindingsExpired: result.bindingsExpired,
        },
      });
    } else {
      // 2026-06-01 Sprint Y 可观测性：AuditLogRepository @Global 恒注入，
      // undefined 仅错误配线/单测脱钩 → warn 防学员软删审计静默丢失
      this.logger.warn(
        `audit log repo not injected, skipping audit for student.soft-delete (target=${studentId})`,
      );
    }

    return result;
  }
}
