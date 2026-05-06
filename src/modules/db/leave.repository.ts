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
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, student_id, lesson_id, type, reason, reason_note,
              new_date, new_start_at, status, reject_reason,
              created_at, decided_at
       FROM leaves
       WHERE student_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [studentId, limit],
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
    };
  }
}
