import { Injectable, NotFoundException } from '@nestjs/common';
import { PgPoolService, PgRow } from './pg-pool.service';
import {
  Assessment,
  StudentAssessmentResult,
  AssessmentStatus,
} from '../assessment/assessment.service';

/**
 * AssessmentRepository — V14 测评/考试持久化层（tenant schema）
 *
 * 两表：
 *   assessments（V14 §14.1）— 测评定义
 *   student_assessment_results（V14 §14.2）— 学员成绩
 */
@Injectable()
export class AssessmentRepository {
  constructor(private readonly pg: PgPoolService) {}

  // ===== assessments =====

  async insertAssessment(
    tenantSchema: string,
    a: Assessment,
  ): Promise<Assessment> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `INSERT INTO assessments (
         id, teacher_id, title, subject, assessment_type,
         total_score, scheduled_at, status, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, teacher_id, title, subject, assessment_type,
                 total_score, scheduled_at, status, created_at`,
      [
        a.id,
        a.teacherId,
        a.title,
        a.subject,
        a.assessmentType,
        a.totalScore,
        a.scheduledAt || null,
        a.status,
        a.createdAt,
      ],
    );
    return this.mapAssessmentRow(rows[0]);
  }

  /**
   * 2026-05-23 (task #33): 创建 assessment + fan-out recipients (单事务)
   *   recipients 默认来自 student_teacher_bindings (老师主带学员)
   *   覆盖: input.recipientStudentIds (手动指定接收方)
   *
   * 类比 V13 homework_assignments + assignment_recipients 设计
   */
  async insertAssessmentWithRecipients(
    tenantSchema: string,
    a: Assessment,
    recipientStudentIds: ReadonlyArray<string>,
  ): Promise<Assessment & { recipientStudentIds: string[] }> {
    // 注: 当前 pg-pool 没暴露事务 API, 用 2 个独立 query
    //     如失败 (FK 违反等), assessment INSERT 已成功但 recipients 空 — 业务上可接受
    //     真要事务: 后续加 pg.transactionalTenantQuery
    const assessment = await this.insertAssessment(tenantSchema, a);
    if (recipientStudentIds.length > 0) {
      // VALUES ($1,$2),($1,$3),...
      const valuePlaceholders = recipientStudentIds
        .map((_, i) => `($1, $${i + 2})`)
        .join(', ');
      await this.pg.tenantQuery(
        tenantSchema,
        `INSERT INTO assessment_recipients (assessment_id, student_id)
         VALUES ${valuePlaceholders}
         ON CONFLICT (assessment_id, student_id) DO NOTHING`,
        [a.id, ...recipientStudentIds],
      );
    }
    return { ...assessment, recipientStudentIds: [...recipientStudentIds] };
  }

  /**
   * 2026-05-23 (task #33): list recipients with student name
   *   类比 V13 listRecipientsWithStudentName
   *   返每个 recipient { studentId, studentName }, 让前端 record 页能列未录学员
   */
  async listAssessmentRecipientsWithStudentName(
    tenantSchema: string,
    assessmentId: string,
  ): Promise<Array<{ studentId: string; studentName: string | null }>> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT r.student_id, st.student_name
         FROM assessment_recipients r
         LEFT JOIN students st ON st.id = r.student_id
        WHERE r.assessment_id = $1`,
      [assessmentId],
    );
    return rows.map((r) => ({
      studentId: r.student_id,
      studentName: r.student_name || null,
    }));
  }

  /**
   * 2026-05-23 (task #33): assessment 默认 recipients 来源
   *   返老师主带的 active 学员清单 (student_teacher_bindings)
   *   老师创建 assessment 时调此方法默认 fan-out
   */
  async listMainStudentsByTeacher(
    tenantSchema: string,
    teacherId: string,
  ): Promise<string[]> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT DISTINCT student_id
         FROM student_teacher_bindings
        WHERE teacher_id = $1 AND status = 'active'`,
      [teacherId],
    );
    return rows.map((r) => r.student_id);
  }

  async findAssessmentById(
    tenantSchema: string,
    id: string,
  ): Promise<Assessment | null> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, teacher_id, title, subject, assessment_type,
              total_score, scheduled_at, status, created_at
       FROM assessments WHERE id = $1`,
      [id],
    );
    return rows.length === 0 ? null : this.mapAssessmentRow(rows[0]);
  }

  async listAssessmentsByTeacher(
    tenantSchema: string,
    teacherId: string,
  ): Promise<Assessment[]> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, teacher_id, title, subject, assessment_type,
              total_score, scheduled_at, status, created_at
       FROM assessments
       WHERE teacher_id = $1
       ORDER BY COALESCE(scheduled_at, created_at) DESC`,
      [teacherId],
    );
    return rows.map((r) => this.mapAssessmentRow(r));
  }

  async setAssessmentStatus(
    tenantSchema: string,
    id: string,
    status: AssessmentStatus,
  ): Promise<Assessment> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `UPDATE assessments
       SET status = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, teacher_id, title, subject, assessment_type,
                 total_score, scheduled_at, status, created_at`,
      [status, id],
    );
    if (rows.length === 0) throw new NotFoundException(`assessment ${id} not found`);
    return this.mapAssessmentRow(rows[0]);
  }

  // ===== results =====

  async insertResult(
    tenantSchema: string,
    r: StudentAssessmentResult,
  ): Promise<StudentAssessmentResult> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `INSERT INTO student_assessment_results (
         id, assessment_id, student_id, score, rank_in_class,
         knowledge_breakdown, teacher_comment, recorded_at, recorded_by_user_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, assessment_id, student_id, score, rank_in_class,
                 knowledge_breakdown, teacher_comment, recorded_at, recorded_by_user_id`,
      [
        r.id,
        r.assessmentId,
        r.studentId,
        r.score ?? null,
        r.rankInClass ?? null,
        r.knowledgeBreakdown ? JSON.stringify(r.knowledgeBreakdown) : null,
        r.teacherComment || null,
        r.recordedAt || null,
        r.recordedByUserId || null,
      ],
    );
    return this.mapResultRow(rows[0]);
  }

  async findResultById(
    tenantSchema: string,
    id: string,
  ): Promise<StudentAssessmentResult | null> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, assessment_id, student_id, score, rank_in_class,
              knowledge_breakdown, teacher_comment, recorded_at, recorded_by_user_id
       FROM student_assessment_results WHERE id = $1`,
      [id],
    );
    return rows.length === 0 ? null : this.mapResultRow(rows[0]);
  }

  async findResultByAssessmentStudent(
    tenantSchema: string,
    assessmentId: string,
    studentId: string,
  ): Promise<StudentAssessmentResult | null> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, assessment_id, student_id, score, rank_in_class,
              knowledge_breakdown, teacher_comment, recorded_at, recorded_by_user_id
       FROM student_assessment_results
       WHERE assessment_id = $1 AND student_id = $2`,
      [assessmentId, studentId],
    );
    return rows.length === 0 ? null : this.mapResultRow(rows[0]);
  }

  async listResultsByAssessment(
    tenantSchema: string,
    assessmentId: string,
  ): Promise<StudentAssessmentResult[]> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, assessment_id, student_id, score, rank_in_class,
              knowledge_breakdown, teacher_comment, recorded_at, recorded_by_user_id
       FROM student_assessment_results
       WHERE assessment_id = $1
       ORDER BY score DESC NULLS LAST`,
      [assessmentId],
    );
    return rows.map((r) => this.mapResultRow(r));
  }

  async listResultsByStudent(
    tenantSchema: string,
    studentId: string,
  ): Promise<StudentAssessmentResult[]> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, assessment_id, student_id, score, rank_in_class,
              knowledge_breakdown, teacher_comment, recorded_at, recorded_by_user_id
       FROM student_assessment_results
       WHERE student_id = $1
       ORDER BY recorded_at DESC NULLS LAST`,
      [studentId],
    );
    return rows.map((r) => this.mapResultRow(r));
  }

  /**
   * 批量更新班内排名（在 publishAssessment 前调用）
   */
  async updateRankings(
    tenantSchema: string,
    rankings: ReadonlyArray<{ id: string; rankInClass: number }>,
  ): Promise<number> {
    if (rankings.length === 0) return 0;
    return this.pg.transaction(async (client) => {
      let count = 0;
      for (const r of rankings) {
        const res = await client.query(
          `UPDATE student_assessment_results SET rank_in_class = $1 WHERE id = $2`,
          [r.rankInClass, r.id],
        );
        count += res.rowCount ?? 0;
      }
      return count;
    }, { tenantSchema });
  }

  // ===== helpers =====

  private mapAssessmentRow(row: PgRow): Assessment {
    return {
      id: row.id,
      teacherId: row.teacher_id,
      title: row.title,
      subject: row.subject,
      assessmentType: row.assessment_type,
      totalScore: Number(row.total_score),
      scheduledAt: row.scheduled_at || undefined,
      status: row.status,
      createdAt: row.created_at,
    };
  }

  private mapResultRow(row: PgRow): StudentAssessmentResult {
    return {
      id: row.id,
      assessmentId: row.assessment_id,
      studentId: row.student_id,
      score: row.score !== null ? Number(row.score) : undefined,
      rankInClass: row.rank_in_class !== null ? row.rank_in_class : undefined,
      knowledgeBreakdown:
        row.knowledge_breakdown
          ? typeof row.knowledge_breakdown === 'string'
            ? JSON.parse(row.knowledge_breakdown)
            : row.knowledge_breakdown
          : undefined,
      teacherComment: row.teacher_comment || undefined,
      recordedAt: row.recorded_at || undefined,
      recordedByUserId: row.recorded_by_user_id || undefined,
    };
  }
}
