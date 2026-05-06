import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PgPoolService, PgRow } from './pg-pool.service';
import { Teacher } from '../teacher/teacher.service';

/**
 * V28 老师归档结果（注销老师 + 关联学生主带老师转移）
 */
export interface TeacherArchiveResult {
  teacher: Teacher;
  transferToTeacherId: string | null;
  transferToTeacherName: string;
  studentsReassigned: number;
}

/**
 * TeacherRepository — 教师档案 PG 持久化层
 *
 * 来源：用户 2026-05-02「做啊」（首个真接 PG 的 Repository）
 *
 * tenant schema 内的 teachers 表（V7 已建）：
 *   id / campus_id / name / phone / user_id / subjects(JSONB)
 *   bio / hourly_rate_yuan / status / created_at / updated_at / created_by / updated_by
 */
@Injectable()
export class TeacherRepository {
  constructor(private readonly pg: PgPoolService) {}

  /**
   * INSERT 一行 teacher 到 tenant_xxx.teachers
   */
  async insert(
    tenantSchema: string,
    teacher: Teacher,
    operator: string,
  ): Promise<Teacher> {
    const sql = `
      INSERT INTO teachers (
        id, campus_id, name, phone, user_id, subjects,
        hourly_rate_yuan, status, created_by, updated_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, campus_id, name, phone, user_id, subjects, hourly_rate_yuan, status
    `;
    const params = [
      teacher.id,
      teacher.campusId,
      teacher.name,
      teacher.phone || null,
      teacher.userId || null,
      JSON.stringify(teacher.subjects || []),
      teacher.hourlyRateYuan ?? null,
      teacher.status,
      operator,
      operator,
    ];
    const rows = await this.pg.tenantQuery<any>(tenantSchema, sql, params);
    return this.mapRow(rows[0]);
  }

  /**
   * 查询 tenant 内全部 active 教师（用于 V8 排课 schedulableTeachers）
   */
  async listActiveInTenant(tenantSchema: string): Promise<Teacher[]> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, campus_id, name, phone, user_id, subjects, hourly_rate_yuan, status
       FROM teachers
       WHERE status = '在职'
       ORDER BY created_at DESC`,
    );
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * 按 ID 取
   */
  async findById(tenantSchema: string, id: string): Promise<Teacher | null> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, campus_id, name, phone, user_id, subjects, hourly_rate_yuan, status
       FROM teachers WHERE id = $1`,
      [id],
    );
    return rows.length === 0 ? null : this.mapRow(rows[0]);
  }

  /**
   * 列表（分页）
   */
  async list(
    tenantSchema: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<Teacher[]> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, campus_id, name, phone, user_id, subjects, hourly_rate_yuan, status
       FROM teachers
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * 状态推进（状态机由 Service 校验，本层只 UPDATE）
   */
  async updateStatus(
    tenantSchema: string,
    id: string,
    newStatus: '在职' | '请假' | '归档',
    operator: string,
  ): Promise<Teacher> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `UPDATE teachers
       SET status = $1, updated_by = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING id, campus_id, name, phone, user_id, subjects, hourly_rate_yuan, status`,
      [newStatus, operator, id],
    );
    if (rows.length === 0) {
      throw new NotFoundException(`teacher ${id} not found`);
    }
    return this.mapRow(rows[0]);
  }

  /**
   * V28 老师归档（注销）+ 关联学生主带老师转移
   *
   * 来源：用户 2026-05-07「校长也应该可以注销老师和销售」
   *
   * 行为：
   *   1. teacher.status = '归档'
   *   2. 该老师 assigned_teacher_id 的所有学生 → 同 campus 其他在职老师
   *      - 找不到同 campus 在职老师 → 学生 assigned_teacher_id = NULL（待校长再分配）
   *   3. 全部在事务内
   *
   * 边界：
   *   - 已归档的老师 → BadRequestException
   *   - 老师不存在 → NotFoundException
   */
  async archive(
    tenantSchema: string,
    teacherId: string,
    operator: string,
    operatorContext?: { role?: string | null; campusId?: string | null },
  ): Promise<TeacherArchiveResult> {
    const target = await this.findById(tenantSchema, teacherId);
    if (!target) throw new NotFoundException(`teacher ${teacherId} not found`);
    if (target.status === '归档') {
      throw new BadRequestException(`teacher ${teacherId} 已归档`);
    }
    // V28 R2 RBAC 边界（用户 2026-05-07「老板也可以同样处理校长」+ 边界精化）
    // - admin / hr：任意校区老师
    // - boss：仅同校老师
    if (operatorContext) {
      const role = operatorContext.role;
      const campusId = operatorContext.campusId;
      if (role === 'boss' && campusId && target.campusId !== campusId) {
        throw new BadRequestException(
          `校长（boss）仅能归档同校区老师（operator=${campusId} / target=${target.campusId}）`,
        );
      }
      if (role && role !== 'admin' && role !== 'boss' && role !== 'hr') {
        throw new BadRequestException(`role=${role} 无老师归档权限`);
      }
    }

    // 找同 campus 其他 active 老师作接棒人（排除自己）
    const candidates = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT id, name FROM teachers
         WHERE campus_id = $1 AND id <> $2 AND status = '在职'
         ORDER BY created_at ASC LIMIT 1`,
      [target.campusId, teacherId],
    );
    const transferToId = candidates.length > 0 ? candidates[0].id : null;
    const transferToName = candidates.length > 0
      ? candidates[0].name
      : '无接棒人（待校长再分配）';

    return this.pg.transaction(
      async (client) => {
        const teacherRows = await client.query<PgRow>(
          `UPDATE teachers
              SET status = '归档', updated_by = $2, updated_at = NOW()
            WHERE id = $1 AND status <> '归档'
          RETURNING id, campus_id, name, phone, user_id, subjects, hourly_rate_yuan, status`,
          [teacherId, operator],
        );
        if (teacherRows.rowCount === 0) {
          throw new BadRequestException(
            `teacher ${teacherId} 状态变更失败（可能并发已归档）`,
          );
        }

        const studentsRes = await client.query<{ id: string }>(
          `UPDATE students
              SET assigned_teacher_id = $2,
                  owner_changed_at = NOW(),
                  owner_change_reason = '老师归档'
            WHERE assigned_teacher_id = $1
            RETURNING id`,
          [teacherId, transferToId],
        );

        return {
          teacher: this.mapRow(teacherRows.rows[0]),
          transferToTeacherId: transferToId,
          transferToTeacherName: transferToName,
          studentsReassigned: studentsRes.rowCount || 0,
        };
      },
      { tenantSchema },
    );
  }

  /**
   * 计数
   */
  async countInTenant(tenantSchema: string): Promise<number> {
    const rows = await this.pg.tenantQuery<{ count: string }>(
      tenantSchema,
      `SELECT COUNT(*) as count FROM teachers`,
    );
    return parseInt(rows[0]?.count || '0', 10);
  }

  // ---- helpers ----
  private mapRow(row: PgRow): Teacher {
    return {
      id: row.id,
      campusId: row.campus_id,
      name: row.name,
      phone: row.phone || undefined,
      userId: row.user_id || undefined,
      subjects: typeof row.subjects === 'string' ? JSON.parse(row.subjects) : row.subjects || [],
      hourlyRateYuan: row.hourly_rate_yuan !== null ? Number(row.hourly_rate_yuan) : undefined,
      status: row.status,
    };
  }
}
