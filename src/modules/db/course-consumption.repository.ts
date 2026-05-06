import { Injectable, NotFoundException } from '@nestjs/common';
import { PgPoolService, PgRow } from './pg-pool.service';
import {
  CourseConsumption,
  ConsumptionStatus,
} from '../feedback/course-consumption.service';

/**
 * CourseConsumptionRepository — V9 课消候补持久化层（tenant schema）
 *
 * 表：course_consumptions（V9 §4.2）
 *   24h 锁定：feedback_due_at < NOW() AND status='pending_feedback' → locked
 *   confirmed 才计入老师工资
 */
@Injectable()
export class CourseConsumptionRepository {
  constructor(private readonly pg: PgPoolService) {}

  async insert(
    tenantSchema: string,
    consumption: CourseConsumption,
  ): Promise<CourseConsumption> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `INSERT INTO course_consumptions (
         id, schedule_id, student_id, teacher_id, status,
         amount_yuan, feedback_id, feedback_due_at, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, schedule_id, student_id, teacher_id, status, amount_yuan,
                 feedback_id, feedback_due_at, confirmed_at, locked_at, created_at`,
      [
        consumption.id,
        consumption.scheduleId,
        consumption.studentId,
        consumption.teacherId,
        consumption.status,
        consumption.amountYuan ?? null,
        consumption.feedbackId || null,
        consumption.feedbackDueAt,
        consumption.createdAt,
      ],
    );
    return this.mapRow(rows[0]);
  }

  async findById(
    tenantSchema: string,
    id: string,
  ): Promise<CourseConsumption | null> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, schedule_id, student_id, teacher_id, status, amount_yuan,
              feedback_id, feedback_due_at, confirmed_at, locked_at, created_at
       FROM course_consumptions WHERE id = $1`,
      [id],
    );
    return rows.length === 0 ? null : this.mapRow(rows[0]);
  }

  async findByScheduleStudent(
    tenantSchema: string,
    scheduleId: string,
    studentId: string,
  ): Promise<CourseConsumption | null> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, schedule_id, student_id, teacher_id, status, amount_yuan,
              feedback_id, feedback_due_at, confirmed_at, locked_at, created_at
       FROM course_consumptions
       WHERE schedule_id = $1 AND student_id = $2`,
      [scheduleId, studentId],
    );
    return rows.length === 0 ? null : this.mapRow(rows[0]);
  }

  /**
   * cron 用：扫超期未填反馈的待锁条目
   */
  async findOverdueForLock(
    tenantSchema: string,
    now: Date,
  ): Promise<CourseConsumption[]> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, schedule_id, student_id, teacher_id, status, amount_yuan,
              feedback_id, feedback_due_at, confirmed_at, locked_at, created_at
       FROM course_consumptions
       WHERE status = 'pending_feedback' AND feedback_due_at < $1
       ORDER BY feedback_due_at ASC`,
      [now],
    );
    return rows.map((r) => this.mapRow(r));
  }

  async confirmByFeedback(
    tenantSchema: string,
    id: string,
    feedbackId: string,
  ): Promise<CourseConsumption> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `UPDATE course_consumptions
       SET status = 'confirmed', feedback_id = $1, confirmed_at = NOW(), locked_at = NULL
       WHERE id = $2 AND status != 'cancelled'
       RETURNING id, schedule_id, student_id, teacher_id, status, amount_yuan,
                 feedback_id, feedback_due_at, confirmed_at, locked_at, created_at`,
      [feedbackId, id],
    );
    if (rows.length === 0) throw new NotFoundException(`consumption ${id} not found or cancelled`);
    return this.mapRow(rows[0]);
  }

  async lock(tenantSchema: string, id: string): Promise<CourseConsumption> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `UPDATE course_consumptions
       SET status = 'locked', locked_at = NOW()
       WHERE id = $1 AND status = 'pending_feedback'
       RETURNING id, schedule_id, student_id, teacher_id, status, amount_yuan,
                 feedback_id, feedback_due_at, confirmed_at, locked_at, created_at`,
      [id],
    );
    if (rows.length === 0) throw new NotFoundException(`consumption ${id} not found or not pending_feedback`);
    return this.mapRow(rows[0]);
  }

  async cancel(tenantSchema: string, id: string): Promise<CourseConsumption> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `UPDATE course_consumptions
       SET status = 'cancelled'
       WHERE id = $1 AND status != 'cancelled'
       RETURNING id, schedule_id, student_id, teacher_id, status, amount_yuan,
                 feedback_id, feedback_due_at, confirmed_at, locked_at, created_at`,
      [id],
    );
    if (rows.length === 0) throw new NotFoundException(`consumption ${id} not found or already cancelled`);
    return this.mapRow(rows[0]);
  }

  /**
   * 工资计算用：teacher 在区间内 confirmed 课消的金额合计
   */
  async sumPayrollForTeacher(
    tenantSchema: string,
    teacherId: string,
    rangeStart: Date,
    rangeEnd: Date,
  ): Promise<{ total: number; count: number }> {
    const rows = await this.pg.tenantQuery<{ total: string; count: string }>(
      tenantSchema,
      `SELECT COALESCE(SUM(amount_yuan), 0) AS total, COUNT(*) AS count
       FROM course_consumptions
       WHERE teacher_id = $1 AND status = 'confirmed'
         AND confirmed_at >= $2 AND confirmed_at < $3`,
      [teacherId, rangeStart, rangeEnd],
    );
    return {
      total: Number(rows[0]?.total || 0),
      count: parseInt(rows[0]?.count || '0', 10),
    };
  }

  async listByStatus(
    tenantSchema: string,
    status: ConsumptionStatus,
    options: { limit?: number; offset?: number } = {},
  ): Promise<CourseConsumption[]> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, schedule_id, student_id, teacher_id, status, amount_yuan,
              feedback_id, feedback_due_at, confirmed_at, locked_at, created_at
       FROM course_consumptions
       WHERE status = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [status, limit, offset],
    );
    return rows.map((r) => this.mapRow(r));
  }

  // ===== helpers =====
  private mapRow(row: PgRow): CourseConsumption {
    return {
      id: row.id,
      scheduleId: row.schedule_id,
      studentId: row.student_id,
      teacherId: row.teacher_id,
      status: row.status,
      amountYuan: row.amount_yuan !== null ? Number(row.amount_yuan) : undefined,
      feedbackId: row.feedback_id || undefined,
      feedbackDueAt: row.feedback_due_at,
      confirmedAt: row.confirmed_at || undefined,
      lockedAt: row.locked_at || undefined,
      createdAt: row.created_at,
    };
  }
}
