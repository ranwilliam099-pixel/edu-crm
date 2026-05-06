import { Injectable, NotFoundException } from '@nestjs/common';
import { PgPoolService, PgRow } from './pg-pool.service';
import { MonthlyReport } from '../feedback/monthly-report.service';

/**
 * MonthlyReportRepository — V9 月报持久化层（tenant schema）
 *
 * 表：monthly_reports（V9 §4.1）
 *   PD 硬规则 P7：cron 每月 1 号 00:30 自动汇总
 */
@Injectable()
export class MonthlyReportRepository {
  constructor(private readonly pg: PgPoolService) {}

  async insert(
    tenantSchema: string,
    report: MonthlyReport,
  ): Promise<MonthlyReport> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `INSERT INTO monthly_reports (
         id, student_id, teacher_id, month,
         attendance_summary, performance_trend, knowledge_summary,
         teacher_blessing, renewal_suggestion, status, generated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (student_id, month) DO UPDATE SET
         attendance_summary = EXCLUDED.attendance_summary,
         performance_trend = EXCLUDED.performance_trend,
         knowledge_summary = EXCLUDED.knowledge_summary,
         status = EXCLUDED.status,
         generated_at = EXCLUDED.generated_at
       RETURNING id, student_id, teacher_id, month, attendance_summary,
                 performance_trend, knowledge_summary, teacher_blessing,
                 renewal_suggestion, status, generated_at, finalized_at, parent_read_at`,
      [
        report.id,
        report.studentId,
        report.teacherId,
        report.month,
        JSON.stringify(report.attendanceSummary),
        JSON.stringify(report.performanceTrend),
        JSON.stringify(report.knowledgeSummary),
        report.teacherBlessing || null,
        report.renewalSuggestion || null,
        report.status,
        report.generatedAt,
      ],
    );
    return this.mapRow(rows[0]);
  }

  async findById(
    tenantSchema: string,
    id: string,
  ): Promise<MonthlyReport | null> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, student_id, teacher_id, month, attendance_summary,
              performance_trend, knowledge_summary, teacher_blessing,
              renewal_suggestion, status, generated_at, finalized_at, parent_read_at
       FROM monthly_reports WHERE id = $1`,
      [id],
    );
    return rows.length === 0 ? null : this.mapRow(rows[0]);
  }

  async findByStudentMonth(
    tenantSchema: string,
    studentId: string,
    month: Date,
  ): Promise<MonthlyReport | null> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, student_id, teacher_id, month, attendance_summary,
              performance_trend, knowledge_summary, teacher_blessing,
              renewal_suggestion, status, generated_at, finalized_at, parent_read_at
       FROM monthly_reports
       WHERE student_id = $1 AND month = $2`,
      [studentId, month],
    );
    return rows.length === 0 ? null : this.mapRow(rows[0]);
  }

  async listByStudent(
    tenantSchema: string,
    studentId: string,
  ): Promise<MonthlyReport[]> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, student_id, teacher_id, month, attendance_summary,
              performance_trend, knowledge_summary, teacher_blessing,
              renewal_suggestion, status, generated_at, finalized_at, parent_read_at
       FROM monthly_reports
       WHERE student_id = $1
       ORDER BY month DESC`,
      [studentId],
    );
    return rows.map((r) => this.mapRow(r));
  }

  async listPendingFinalize(
    tenantSchema: string,
    teacherId?: string,
  ): Promise<MonthlyReport[]> {
    if (teacherId) {
      const rows = await this.pg.tenantQuery<any>(
        tenantSchema,
        `SELECT id, student_id, teacher_id, month, attendance_summary,
                performance_trend, knowledge_summary, teacher_blessing,
                renewal_suggestion, status, generated_at, finalized_at, parent_read_at
         FROM monthly_reports
         WHERE status = 'auto_generated' AND teacher_id = $1
         ORDER BY generated_at ASC`,
        [teacherId],
      );
      return rows.map((r) => this.mapRow(r));
    }
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, student_id, teacher_id, month, attendance_summary,
              performance_trend, knowledge_summary, teacher_blessing,
              renewal_suggestion, status, generated_at, finalized_at, parent_read_at
       FROM monthly_reports
       WHERE status = 'auto_generated'
       ORDER BY generated_at ASC`,
    );
    return rows.map((r) => this.mapRow(r));
  }

  async finalize(
    tenantSchema: string,
    id: string,
    teacherBlessing: string,
    renewalSuggestion: string,
  ): Promise<MonthlyReport> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `UPDATE monthly_reports
       SET status = 'teacher_finalized',
           teacher_blessing = $1,
           renewal_suggestion = $2,
           finalized_at = NOW()
       WHERE id = $3 AND status = 'auto_generated'
       RETURNING id, student_id, teacher_id, month, attendance_summary,
                 performance_trend, knowledge_summary, teacher_blessing,
                 renewal_suggestion, status, generated_at, finalized_at, parent_read_at`,
      [teacherBlessing, renewalSuggestion, id],
    );
    if (rows.length === 0) throw new NotFoundException(`report ${id} not found or not in auto_generated state`);
    return this.mapRow(rows[0]);
  }

  async markParentRead(
    tenantSchema: string,
    id: string,
  ): Promise<MonthlyReport> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `UPDATE monthly_reports
       SET parent_read_at = COALESCE(parent_read_at, NOW())
       WHERE id = $1
       RETURNING id, student_id, teacher_id, month, attendance_summary,
                 performance_trend, knowledge_summary, teacher_blessing,
                 renewal_suggestion, status, generated_at, finalized_at, parent_read_at`,
      [id],
    );
    if (rows.length === 0) throw new NotFoundException(`report ${id} not found`);
    return this.mapRow(rows[0]);
  }

  // ===== helpers =====
  private mapRow(row: PgRow): MonthlyReport {
    return {
      id: row.id,
      studentId: row.student_id,
      teacherId: row.teacher_id,
      month: row.month,
      attendanceSummary:
        typeof row.attendance_summary === 'string'
          ? JSON.parse(row.attendance_summary)
          : row.attendance_summary,
      performanceTrend:
        typeof row.performance_trend === 'string'
          ? JSON.parse(row.performance_trend)
          : row.performance_trend,
      knowledgeSummary:
        typeof row.knowledge_summary === 'string'
          ? JSON.parse(row.knowledge_summary)
          : row.knowledge_summary,
      teacherBlessing: row.teacher_blessing || undefined,
      renewalSuggestion: row.renewal_suggestion || undefined,
      status: row.status,
      generatedAt: row.generated_at,
      finalizedAt: row.finalized_at || undefined,
      parentReadAt: row.parent_read_at || undefined,
    };
  }
}
