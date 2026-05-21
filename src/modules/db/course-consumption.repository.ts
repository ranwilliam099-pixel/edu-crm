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
   * P1 S3 (2026-05-21)：feedback 提交时合并 consumption confirm 用
   *
   * 找该 schedule 下所有 status='pending_feedback' 的 consumption
   *
   * 5/21 round 2 (security BLOCKER-2 修复)：
   *   旧版 LIMIT 1 假设 schedule:consumption 1:1，但 V9 schema 是
   *   `UNIQUE (schedule_id, student_id)` 不是 `UNIQUE (schedule_id)`
   *   → 小班课多学生时同 schedule 多条 consumption 共存
   *   → LIMIT 1 无 ORDER BY 任意选行，其他学生 consumption 静默丢失 + fail-open 无错
   *   → 改为返回 array，service 循环 confirm 全部 pending（多学生小班课正确语义）
   *
   * @returns 该 schedule 所有 pending_feedback consumption 列表（已 confirmed/locked/cancelled
   *          天然排除；空 schedule 或全部已处理 → 返回 []）
   */
  async findAllPendingByScheduleId(
    tenantSchema: string,
    scheduleId: string,
  ): Promise<CourseConsumption[]> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, schedule_id, student_id, teacher_id, status, amount_yuan,
              feedback_id, feedback_due_at, confirmed_at, locked_at, created_at
       FROM course_consumptions
       WHERE schedule_id = $1 AND status = 'pending_feedback'`,
      [scheduleId],
    );
    return rows.map((r) => this.mapRow(r));
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

  /**
   * home-teacher 待办 banner 用：聚合该老师所有 pending_feedback 课消
   *
   * 返回 { count, earliestDueAt }：
   *   count           pending_feedback 总数（含已超期但未 cron 锁的）
   *   earliestDueAt   最早到期时间（若 < now 即已超期；UI 据此显示「剩 X 小时」或「已超期」）
   */
  async findPendingFeedbackSummaryByTeacher(
    tenantSchema: string,
    teacherId: string,
  ): Promise<{ count: number; earliestDueAt: Date | null }> {
    const rows = await this.pg.tenantQuery<{ count: string; earliest: Date | null }>(
      tenantSchema,
      `SELECT COUNT(*) AS count, MIN(feedback_due_at) AS earliest
         FROM course_consumptions
        WHERE teacher_id = $1 AND status = 'pending_feedback'`,
      [teacherId],
    );
    return {
      count: parseInt(rows[0]?.count || '0', 10),
      earliestDueAt: rows[0]?.earliest ? new Date(rows[0].earliest) : null,
    };
  }

  async confirmByFeedback(
    tenantSchema: string,
    id: string,
    feedbackId: string,
  ): Promise<CourseConsumption> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      // 2026-05-21 Sprint Y P1-3 修：WHERE 收紧 status='pending_feedback'
      //   旧 status != 'cancelled' 允许已 confirmed/locked 行被覆盖（误更新风险）
      //   新仅 pending_feedback 状态可推进，confirmed/locked/cancelled 全拒绝
      `UPDATE course_consumptions
       SET status = 'confirmed', feedback_id = $1, confirmed_at = NOW(), locked_at = NULL
       WHERE id = $2 AND status = 'pending_feedback'
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

  // V38: 删 sumPayrollForTeacher（薪资业务下线，5/10 拍板"薪资全删"硬红线）
  //   原 SQL: SELECT SUM(amount_yuan) FROM course_consumptions WHERE teacher_id ...
  //   删除范围：repository 层方法体 + 2 个对应 spec it 块
  //   保留依据：course_consumptions.amount_yuan 字段本身是业务流水（续费/退费/财务对账依赖），不删
  //   仅删除"以工资语义聚合"的 method

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
