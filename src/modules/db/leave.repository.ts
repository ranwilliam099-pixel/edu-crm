import { Injectable, NotFoundException } from '@nestjs/common';
import { PgPoolService, PgRow } from './pg-pool.service';

/**
 * LeaveRepository — V16 请假/调课申请持久化层（tenant schema）
 *
 * 来源：用户 2026-05-04 endpoint #1（pages/c/leave/apply）
 *
 * 表：leaves（V16 §16.1）
 *   type:   leave | reschedule
 *   status: pending | approved | rejected
 *
 * 业务规则：距上课 < 24h 时 status 自动 pending，controller 加 warning
 */

export type LeaveType = 'leave' | 'reschedule';
export type LeaveStatus = 'pending' | 'approved' | 'rejected';

export interface Leave {
  id: string;
  studentId: string;
  lessonId?: string;
  type: LeaveType;
  reason?: string;
  reasonNote?: string;
  newDate?: Date;
  newStartAt?: Date;
  status: LeaveStatus;
  rejectReason?: string;
  createdAt: Date;
  decidedAt?: Date;
  // 2026-05-25 #4 闭环: JOIN students + schedules + teachers + course_products 聚合字段
  //   仅 findByStudent / findByStudents 返回；create / approve / reject 不返
  studentName?: string;
  lessonDate?: string;       // YYYY-MM-DD（从 schedules.start_at 派生）
  lessonStartAt?: string;    // HH:MM（从 schedules.start_at 派生）
  subject?: string;          // course_products.product_name
  teacherName?: string;
}

@Injectable()
export class LeaveRepository {
  constructor(private readonly pg: PgPoolService) {}

  async create(tenantSchema: string, leave: Leave): Promise<Leave> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `INSERT INTO leaves (
         id, student_id, lesson_id, type, reason, reason_note,
         new_date, new_start_at, status, reject_reason,
         created_at, decided_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id, student_id, lesson_id, type, reason, reason_note,
                 new_date, new_start_at, status, reject_reason,
                 created_at, decided_at`,
      [
        leave.id,
        leave.studentId,
        leave.lessonId || null,
        leave.type,
        leave.reason || null,
        leave.reasonNote || null,
        leave.newDate || null,
        leave.newStartAt || null,
        leave.status,
        leave.rejectReason || null,
        leave.createdAt,
        leave.decidedAt || null,
      ],
    );
    return this.mapRow(rows[0]);
  }

  async findById(tenantSchema: string, id: string): Promise<Leave | null> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, student_id, lesson_id, type, reason, reason_note,
              new_date, new_start_at, status, reject_reason,
              created_at, decided_at
       FROM leaves WHERE id = $1`,
      [id],
    );
    return rows.length === 0 ? null : this.mapRow(rows[0]);
  }

  async findByStudent(
    tenantSchema: string,
    studentId: string,
    limit: number = 50,
  ): Promise<Leave[]> {
    // 2026-05-25 #4 闭环：JOIN students + schedules + teachers + course_products 拿 UI 必要字段
    //   旧：仅 leaves 单表，前端 child/subject/teacher/date 全显「—」
    //   新：5 个 LEFT JOIN（lesson_id 可空，所以全用 LEFT 防丢行）
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT l.id, l.student_id, l.lesson_id, l.type, l.reason, l.reason_note,
              l.new_date, l.new_start_at, l.status, l.reject_reason,
              l.created_at, l.decided_at,
              st.student_name AS student_name,
              sc.start_at      AS lesson_start_at,
              cp.product_name  AS subject,
              t.name           AS teacher_name
         FROM leaves l
    LEFT JOIN students        st ON st.id = l.student_id
    LEFT JOIN schedules       sc ON sc.id = l.lesson_id
    LEFT JOIN teachers        t  ON t.id  = sc.teacher_id
    LEFT JOIN course_products cp ON cp.id = sc.course_product_id
        WHERE l.student_id = $1
        ORDER BY l.created_at DESC
        LIMIT $2`,
      [studentId, limit],
    );
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * 2026-05-25 #4 闭环：C 端家长「我的请假」多孩聚合
   *
   * c-side.controller GET /api/c/leaves 调本方法
   *   - studentIds 由 controller 从 parent_student_bindings 取（active + 当前 tenant）
   *   - 复用 findByStudent 同款 JOIN 字段，避免重复 mapper 逻辑
   */
  async findByStudents(
    tenantSchema: string,
    studentIds: string[],
    limit: number = 100,
  ): Promise<Leave[]> {
    if (studentIds.length === 0) return [];
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT l.id, l.student_id, l.lesson_id, l.type, l.reason, l.reason_note,
              l.new_date, l.new_start_at, l.status, l.reject_reason,
              l.created_at, l.decided_at,
              st.student_name AS student_name,
              sc.start_at      AS lesson_start_at,
              cp.product_name  AS subject,
              t.name           AS teacher_name
         FROM leaves l
    LEFT JOIN students        st ON st.id = l.student_id
    LEFT JOIN schedules       sc ON sc.id = l.lesson_id
    LEFT JOIN teachers        t  ON t.id  = sc.teacher_id
    LEFT JOIN course_products cp ON cp.id = sc.course_product_id
        WHERE l.student_id = ANY($1::varchar[])
        ORDER BY l.created_at DESC
        LIMIT $2`,
      [studentIds, limit],
    );
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * 批准（可选附带新课次时间）
   */
  async approve(
    tenantSchema: string,
    id: string,
    newSchedule?: { newDate?: Date; newStartAt?: Date },
  ): Promise<Leave> {
    const sets = [`status = 'approved'`, `decided_at = NOW()`];
    const params: any[] = [];
    let idx = 1;
    if (newSchedule?.newDate !== undefined) {
      sets.push(`new_date = $${idx++}`);
      params.push(newSchedule.newDate);
    }
    if (newSchedule?.newStartAt !== undefined) {
      sets.push(`new_start_at = $${idx++}`);
      params.push(newSchedule.newStartAt);
    }
    params.push(id);
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `UPDATE leaves SET ${sets.join(', ')} WHERE id = $${idx}
       RETURNING id, student_id, lesson_id, type, reason, reason_note,
                 new_date, new_start_at, status, reject_reason,
                 created_at, decided_at`,
      params,
    );
    if (rows.length === 0) throw new NotFoundException(`leave ${id} not found`);
    return this.mapRow(rows[0]);
  }

  async reject(
    tenantSchema: string,
    id: string,
    reason: string,
  ): Promise<Leave> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `UPDATE leaves
       SET status = 'rejected', reject_reason = $1, decided_at = NOW()
       WHERE id = $2
       RETURNING id, student_id, lesson_id, type, reason, reason_note,
                 new_date, new_start_at, status, reject_reason,
                 created_at, decided_at`,
      [reason, id],
    );
    if (rows.length === 0) throw new NotFoundException(`leave ${id} not found`);
    return this.mapRow(rows[0]);
  }

  // ===== helpers =====
  private mapRow(row: PgRow): Leave {
    // 2026-05-25 #4 闭环：lesson_start_at 派生 lessonDate (YYYY-MM-DD) + lessonStartAt (HH:MM)
    let lessonDate: string | undefined;
    let lessonStartAt: string | undefined;
    if (row.lesson_start_at) {
      const d = row.lesson_start_at instanceof Date
        ? row.lesson_start_at
        : new Date(row.lesson_start_at);
      if (!isNaN(d.getTime())) {
        const pad = (n: number) => (n < 10 ? '0' + n : String(n));
        lessonDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        lessonStartAt = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      }
    }
    return {
      id: row.id,
      studentId: row.student_id,
      lessonId: row.lesson_id || undefined,
      type: row.type,
      reason: row.reason || undefined,
      reasonNote: row.reason_note || undefined,
      newDate: row.new_date || undefined,
      newStartAt: row.new_start_at || undefined,
      status: row.status,
      rejectReason: row.reject_reason || undefined,
      createdAt: row.created_at,
      decidedAt: row.decided_at || undefined,
      // 2026-05-25 #4: JOIN 字段（如果 SQL 没 SELECT 这些就是 undefined，create / approve / reject 不返）
      studentName: row.student_name || undefined,
      lessonDate,
      lessonStartAt,
      subject: row.subject || undefined,
      teacherName: row.teacher_name || undefined,
    };
  }
}
