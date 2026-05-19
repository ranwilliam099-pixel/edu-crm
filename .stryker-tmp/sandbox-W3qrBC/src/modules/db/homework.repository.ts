import { Injectable, NotFoundException } from '@nestjs/common';
import { PgPoolService, PgRow } from './pg-pool.service';
import {
  HomeworkAssignment,
  HomeworkSubmission,
  Grade,
  AssignmentStatus,
  SubmissionStatus,
} from '../homework/homework.service';

/**
 * HomeworkRepository — V13 作业管理持久化层（tenant schema）
 *
 * 三表：
 *   homework_assignments（V13 §13.1）— 作业定义
 *   assignment_recipients（V13 §13.2）— 作业接收方
 *   homework_submissions（V13 §13.3）— 学员上交 + 老师批改
 */
@Injectable()
export class HomeworkRepository {
  constructor(private readonly pg: PgPoolService) {}

  // ===== assignments =====

  async insertAssignmentWithRecipients(
    tenantSchema: string,
    assignment: HomeworkAssignment,
  ): Promise<HomeworkAssignment> {
    return this.pg.transaction(async (client) => {
      await client.query(
        `INSERT INTO homework_assignments (
           id, schedule_id, teacher_id, title, content,
           attachments, due_at, difficulty, status, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          assignment.id,
          assignment.scheduleId || null,
          assignment.teacherId,
          assignment.title,
          assignment.content || null,
          assignment.attachments ? JSON.stringify(assignment.attachments) : null,
          assignment.dueAt || null,
          assignment.difficulty || null,
          assignment.status,
          assignment.createdAt,
        ],
      );

      for (const sid of assignment.recipientStudentIds) {
        await client.query(
          `INSERT INTO assignment_recipients (assignment_id, student_id) VALUES ($1, $2)`,
          [assignment.id, sid],
        );
      }
      return assignment;
    }, { tenantSchema });
  }

  async findAssignmentById(
    tenantSchema: string,
    id: string,
  ): Promise<HomeworkAssignment | null> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT a.id, a.schedule_id, a.teacher_id, a.title, a.content,
              a.attachments, a.due_at, a.difficulty, a.status, a.created_at,
              ARRAY(SELECT student_id FROM assignment_recipients WHERE assignment_id = a.id) AS recipients
       FROM homework_assignments a
       WHERE a.id = $1`,
      [id],
    );
    return rows.length === 0 ? null : this.mapAssignmentRow(rows[0]);
  }

  async listAssignmentsByTeacher(
    tenantSchema: string,
    teacherId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<HomeworkAssignment[]> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT a.id, a.schedule_id, a.teacher_id, a.title, a.content,
              a.attachments, a.due_at, a.difficulty, a.status, a.created_at,
              ARRAY(SELECT student_id FROM assignment_recipients WHERE assignment_id = a.id) AS recipients
       FROM homework_assignments a
       WHERE a.teacher_id = $1
       ORDER BY a.created_at DESC
       LIMIT $2 OFFSET $3`,
      [teacherId, limit, offset],
    );
    return rows.map((r) => this.mapAssignmentRow(r));
  }

  async listAssignmentsByStudent(
    tenantSchema: string,
    studentId: string,
  ): Promise<HomeworkAssignment[]> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT a.id, a.schedule_id, a.teacher_id, a.title, a.content,
              a.attachments, a.due_at, a.difficulty, a.status, a.created_at,
              ARRAY(SELECT student_id FROM assignment_recipients WHERE assignment_id = a.id) AS recipients
       FROM homework_assignments a
       JOIN assignment_recipients r ON r.assignment_id = a.id
       WHERE r.student_id = $1 AND a.status = 'published'
       ORDER BY a.created_at DESC`,
      [studentId],
    );
    return rows.map((r) => this.mapAssignmentRow(r));
  }

  async setAssignmentStatus(
    tenantSchema: string,
    id: string,
    status: AssignmentStatus,
  ): Promise<HomeworkAssignment> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `UPDATE homework_assignments
       SET status = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, schedule_id, teacher_id, title, content,
                 attachments, due_at, difficulty, status, created_at,
                 ARRAY(SELECT student_id FROM assignment_recipients WHERE assignment_id = homework_assignments.id) AS recipients`,
      [status, id],
    );
    if (rows.length === 0) throw new NotFoundException(`assignment ${id} not found`);
    return this.mapAssignmentRow(rows[0]);
  }

  // ===== submissions =====

  async insertSubmission(
    tenantSchema: string,
    submission: HomeworkSubmission,
  ): Promise<HomeworkSubmission> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `INSERT INTO homework_submissions (
         id, assignment_id, student_id, submitted_by_parent_id,
         content, attachments, status, submitted_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (assignment_id, student_id) DO UPDATE SET
         submitted_by_parent_id = EXCLUDED.submitted_by_parent_id,
         content = EXCLUDED.content,
         attachments = EXCLUDED.attachments,
         status = EXCLUDED.status,
         submitted_at = EXCLUDED.submitted_at,
         updated_at = NOW()
       RETURNING id, assignment_id, student_id, submitted_by_parent_id,
                 content, attachments, status, grade, teacher_comment,
                 graded_at, graded_by_user_id, submitted_at`,
      [
        submission.id,
        submission.assignmentId,
        submission.studentId,
        submission.submittedByParentId || null,
        submission.content || null,
        submission.attachments ? JSON.stringify(submission.attachments) : null,
        submission.status,
        submission.submittedAt,
      ],
    );
    return this.mapSubmissionRow(rows[0]);
  }

  async findSubmissionById(
    tenantSchema: string,
    id: string,
  ): Promise<HomeworkSubmission | null> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, assignment_id, student_id, submitted_by_parent_id,
              content, attachments, status, grade, teacher_comment,
              graded_at, graded_by_user_id, submitted_at
       FROM homework_submissions WHERE id = $1`,
      [id],
    );
    return rows.length === 0 ? null : this.mapSubmissionRow(rows[0]);
  }

  async findSubmissionByAssignmentStudent(
    tenantSchema: string,
    assignmentId: string,
    studentId: string,
  ): Promise<HomeworkSubmission | null> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, assignment_id, student_id, submitted_by_parent_id,
              content, attachments, status, grade, teacher_comment,
              graded_at, graded_by_user_id, submitted_at
       FROM homework_submissions
       WHERE assignment_id = $1 AND student_id = $2`,
      [assignmentId, studentId],
    );
    return rows.length === 0 ? null : this.mapSubmissionRow(rows[0]);
  }

  async listSubmissionsByStudent(
    tenantSchema: string,
    studentId: string,
  ): Promise<HomeworkSubmission[]> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, assignment_id, student_id, submitted_by_parent_id,
              content, attachments, status, grade, teacher_comment,
              graded_at, graded_by_user_id, submitted_at
       FROM homework_submissions
       WHERE student_id = $1
       ORDER BY submitted_at DESC`,
      [studentId],
    );
    return rows.map((r) => this.mapSubmissionRow(r));
  }

  /**
   * 老师"待批改"列表
   */
  async listPendingByTeacher(
    tenantSchema: string,
    teacherId: string,
  ): Promise<HomeworkSubmission[]> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT s.id, s.assignment_id, s.student_id, s.submitted_by_parent_id,
              s.content, s.attachments, s.status, s.grade, s.teacher_comment,
              s.graded_at, s.graded_by_user_id, s.submitted_at
       FROM homework_submissions s
       JOIN homework_assignments a ON a.id = s.assignment_id
       WHERE a.teacher_id = $1 AND s.status = 'submitted'
       ORDER BY s.submitted_at ASC`,
      [teacherId],
    );
    return rows.map((r) => this.mapSubmissionRow(r));
  }

  async grade(
    tenantSchema: string,
    id: string,
    grade: Grade,
    teacherComment: string | undefined,
    gradedByUserId: string,
  ): Promise<HomeworkSubmission> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `UPDATE homework_submissions
       SET status = 'graded', grade = $1, teacher_comment = $2,
           graded_at = NOW(), graded_by_user_id = $3, updated_at = NOW()
       WHERE id = $4 AND status != 'returned'
       RETURNING id, assignment_id, student_id, submitted_by_parent_id,
                 content, attachments, status, grade, teacher_comment,
                 graded_at, graded_by_user_id, submitted_at`,
      [grade, teacherComment || null, gradedByUserId, id],
    );
    if (rows.length === 0) throw new NotFoundException(`submission ${id} not found or returned`);
    return this.mapSubmissionRow(rows[0]);
  }

  async returnForRedo(
    tenantSchema: string,
    id: string,
    teacherComment: string,
  ): Promise<HomeworkSubmission> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `UPDATE homework_submissions
       SET status = 'returned', teacher_comment = $1,
           graded_at = NOW(), updated_at = NOW()
       WHERE id = $2
       RETURNING id, assignment_id, student_id, submitted_by_parent_id,
                 content, attachments, status, grade, teacher_comment,
                 graded_at, graded_by_user_id, submitted_at`,
      [teacherComment, id],
    );
    if (rows.length === 0) throw new NotFoundException(`submission ${id} not found`);
    return this.mapSubmissionRow(rows[0]);
  }

  async setSubmissionStatus(
    tenantSchema: string,
    id: string,
    status: SubmissionStatus,
  ): Promise<HomeworkSubmission> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `UPDATE homework_submissions
       SET status = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, assignment_id, student_id, submitted_by_parent_id,
                 content, attachments, status, grade, teacher_comment,
                 graded_at, graded_by_user_id, submitted_at`,
      [status, id],
    );
    if (rows.length === 0) throw new NotFoundException(`submission ${id} not found`);
    return this.mapSubmissionRow(rows[0]);
  }

  // ===== helpers =====

  private mapAssignmentRow(row: PgRow): HomeworkAssignment {
    return {
      id: row.id,
      scheduleId: row.schedule_id || undefined,
      teacherId: row.teacher_id,
      title: row.title,
      content: row.content || undefined,
      attachments:
        row.attachments
          ? typeof row.attachments === 'string'
            ? JSON.parse(row.attachments)
            : row.attachments
          : undefined,
      dueAt: row.due_at || undefined,
      difficulty: row.difficulty || undefined,
      status: row.status,
      recipientStudentIds: row.recipients || [],
      createdAt: row.created_at,
    };
  }

  private mapSubmissionRow(row: PgRow): HomeworkSubmission {
    return {
      id: row.id,
      assignmentId: row.assignment_id,
      studentId: row.student_id,
      submittedByParentId: row.submitted_by_parent_id || undefined,
      content: row.content || undefined,
      attachments:
        row.attachments
          ? typeof row.attachments === 'string'
            ? JSON.parse(row.attachments)
            : row.attachments
          : undefined,
      status: row.status,
      grade: row.grade || undefined,
      teacherComment: row.teacher_comment || undefined,
      gradedAt: row.graded_at || undefined,
      gradedByUserId: row.graded_by_user_id || undefined,
      submittedAt: row.submitted_at,
    };
  }
}
