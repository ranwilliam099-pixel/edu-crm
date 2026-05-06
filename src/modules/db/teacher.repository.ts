import { Injectable, NotFoundException } from '@nestjs/common';
import { PgPoolService, PgRow } from './pg-pool.service';
import { Teacher } from '../teacher/teacher.service';

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
