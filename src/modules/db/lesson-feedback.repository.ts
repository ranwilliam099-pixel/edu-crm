import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PgPoolService, PgRow } from './pg-pool.service';
import { LessonFeedback } from '../feedback/lesson-feedback.service';

/**
 * LessonFeedbackRepository — V9 教学反馈持久化层（tenant schema）
 *
 * 表：lesson_feedbacks（V9 §4.1）
 *   PD 硬规则 P6：24h 内必填，超期 → course_consumptions.status='locked'
 */
@Injectable()
export class LessonFeedbackRepository {
  constructor(private readonly pg: PgPoolService) {}

  async insert(
    tenantSchema: string,
    feedback: LessonFeedback,
  ): Promise<LessonFeedback> {
    try {
      return await this._doInsert(tenantSchema, feedback);
    } catch (e: any) {
      // 2026-05-22 V9 UNIQUE (schedule_id, student_id) 撞 → 23505
      // 业务上同 schedule 同学员只能填 1 条反馈, 重复 submit 应该是 ConflictException 409, 不是 500
      if (e?.code === '23505') {
        throw new ConflictException(
          `FEEDBACK_ALREADY_EXISTS: schedule=${feedback.scheduleId} student=${feedback.studentId} 已填过反馈`,
        );
      }
      throw e;
    }
  }

  private async _doInsert(
    tenantSchema: string,
    feedback: LessonFeedback,
  ): Promise<LessonFeedback> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `INSERT INTO lesson_feedbacks (
         id, schedule_id, student_id, teacher_id,
         attendance_status, classroom_performance,
         knowledge_points, homework, homework_attachments,
         teacher_note, teacher_internal_note,
         knowledge_matrix, dim_ratings, homework_deadline, homework_difficulty, next_preview,
         submitted_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING id, schedule_id, student_id, teacher_id, attendance_status,
                 classroom_performance, knowledge_points, homework,
                 homework_attachments, teacher_note, teacher_internal_note,
                 knowledge_matrix, dim_ratings, homework_deadline, homework_difficulty, next_preview,
                 parent_read_at, submitted_at, updated_at`,
      [
        feedback.id,
        feedback.scheduleId,
        feedback.studentId,
        feedback.teacherId,
        feedback.attendanceStatus,
        feedback.classroomPerformance,
        feedback.knowledgePoints ? JSON.stringify(feedback.knowledgePoints) : null,
        feedback.homework || null,
        feedback.homeworkAttachments ? JSON.stringify(feedback.homeworkAttachments) : null,
        feedback.teacherNote || null,
        feedback.teacherInternalNote || null,
        feedback.knowledgeMatrix ? JSON.stringify(feedback.knowledgeMatrix) : null,
        feedback.dimRatings ? JSON.stringify(feedback.dimRatings) : null,
        feedback.homeworkDeadline || null,
        feedback.homeworkDifficulty || null,
        feedback.nextPreview || null,
        feedback.submittedAt,
        feedback.updatedAt,
      ],
    );
    return this.mapRow(rows[0]);
  }

  async findById(
    tenantSchema: string,
    id: string,
  ): Promise<LessonFeedback | null> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, schedule_id, student_id, teacher_id, attendance_status,
              classroom_performance, knowledge_points, homework,
              homework_attachments, teacher_note, teacher_internal_note,
              knowledge_matrix, dim_ratings, homework_deadline, homework_difficulty, next_preview,
              parent_read_at, submitted_at, updated_at
       FROM lesson_feedbacks WHERE id = $1`,
      [id],
    );
    return rows.length === 0 ? null : this.mapRow(rows[0]);
  }

  /**
   * 2026-05-22 Wave A: B 端反馈详情 page 需 JOIN students + teachers + course_products
   *   返扩展 LessonFeedback + studentName / teacherName / subject (course_product_name)
   *   detail page 不需重新调多 endpoint 就能渲染头部上下文
   */
  async findByIdWithMeta(
    tenantSchema: string,
    id: string,
  ): Promise<(LessonFeedback & {
    studentName: string | null;
    teacherName: string | null;
    subject: string | null;
  }) | null> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT lf.id, lf.schedule_id, lf.student_id, lf.teacher_id, lf.attendance_status,
              lf.classroom_performance, lf.knowledge_points, lf.homework,
              lf.homework_attachments, lf.teacher_note, lf.teacher_internal_note,
              lf.knowledge_matrix, lf.dim_ratings, lf.homework_deadline, lf.homework_difficulty, lf.next_preview,
              lf.parent_read_at, lf.submitted_at, lf.updated_at,
              s.student_name AS student_name,
              t.name         AS teacher_name,
              cp.product_name AS course_product_name
         FROM lesson_feedbacks lf
         LEFT JOIN students s       ON s.id  = lf.student_id
         LEFT JOIN teachers t       ON t.id  = lf.teacher_id
         LEFT JOIN schedules sc     ON sc.id = lf.schedule_id
         LEFT JOIN course_products cp ON cp.id = sc.course_product_id
        WHERE lf.id = $1`,
      [id],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      ...this.mapRow(row),
      studentName: row.student_name || null,
      teacherName: row.teacher_name || null,
      subject: row.course_product_name || null,
    };
  }

  async findByScheduleStudent(
    tenantSchema: string,
    scheduleId: string,
    studentId: string,
  ): Promise<LessonFeedback | null> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, schedule_id, student_id, teacher_id, attendance_status,
              classroom_performance, knowledge_points, homework,
              homework_attachments, teacher_note, teacher_internal_note,
              knowledge_matrix, dim_ratings, homework_deadline, homework_difficulty, next_preview,
              parent_read_at, submitted_at, updated_at
       FROM lesson_feedbacks
       WHERE schedule_id = $1 AND student_id = $2`,
      [scheduleId, studentId],
    );
    return rows.length === 0 ? null : this.mapRow(rows[0]);
  }

  async listByStudent(
    tenantSchema: string,
    studentId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<LessonFeedback[]> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, schedule_id, student_id, teacher_id, attendance_status,
              classroom_performance, knowledge_points, homework,
              homework_attachments, teacher_note, teacher_internal_note,
              knowledge_matrix, dim_ratings, homework_deadline, homework_difficulty, next_preview,
              parent_read_at, submitted_at, updated_at
       FROM lesson_feedbacks
       WHERE student_id = $1
       ORDER BY submitted_at DESC
       LIMIT $2 OFFSET $3`,
      [studentId, limit, offset],
    );
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * 月报生成用：按 student × teacher × month 范围拉反馈
   */
  async listByStudentTeacherInRange(
    tenantSchema: string,
    studentId: string,
    teacherId: string,
    rangeStart: Date,
    rangeEnd: Date,
  ): Promise<LessonFeedback[]> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, schedule_id, student_id, teacher_id, attendance_status,
              classroom_performance, knowledge_points, homework,
              homework_attachments, teacher_note, teacher_internal_note,
              knowledge_matrix, dim_ratings, homework_deadline, homework_difficulty, next_preview,
              parent_read_at, submitted_at, updated_at
       FROM lesson_feedbacks
       WHERE student_id = $1 AND teacher_id = $2
         AND submitted_at >= $3 AND submitted_at < $4
       ORDER BY submitted_at ASC`,
      [studentId, teacherId, rangeStart, rangeEnd],
    );
    return rows.map((r) => this.mapRow(r));
  }

  async update(
    tenantSchema: string,
    id: string,
    patch: {
      attendanceStatus?: string;
      classroomPerformance?: string;
      knowledgePoints?: ReadonlyArray<{ name: string; mastery: string }>;
      homework?: string;
      teacherNote?: string;
      teacherInternalNote?: string;
      // V18 5 fields
      knowledgeMatrix?: ReadonlyArray<{ name: string; mastery: string }>;
      dimRatings?: { focus?: number; engage?: number; think?: number; homework?: number };
      homeworkDeadline?: Date;
      homeworkDifficulty?: string;
      nextPreview?: string;
    },
  ): Promise<LessonFeedback> {
    const sets: string[] = [];
    const params: any[] = [];
    let idx = 1;
    if (patch.attendanceStatus !== undefined) {
      sets.push(`attendance_status = $${idx++}`);
      params.push(patch.attendanceStatus);
    }
    if (patch.classroomPerformance !== undefined) {
      sets.push(`classroom_performance = $${idx++}`);
      params.push(patch.classroomPerformance);
    }
    if (patch.knowledgePoints !== undefined) {
      sets.push(`knowledge_points = $${idx++}`);
      params.push(JSON.stringify(patch.knowledgePoints));
    }
    if (patch.homework !== undefined) {
      sets.push(`homework = $${idx++}`);
      params.push(patch.homework);
    }
    if (patch.teacherNote !== undefined) {
      sets.push(`teacher_note = $${idx++}`);
      params.push(patch.teacherNote);
    }
    if (patch.teacherInternalNote !== undefined) {
      sets.push(`teacher_internal_note = $${idx++}`);
      params.push(patch.teacherInternalNote);
    }
    if (patch.knowledgeMatrix !== undefined) {
      sets.push(`knowledge_matrix = $${idx++}`);
      params.push(JSON.stringify(patch.knowledgeMatrix));
    }
    if (patch.dimRatings !== undefined) {
      sets.push(`dim_ratings = $${idx++}`);
      params.push(JSON.stringify(patch.dimRatings));
    }
    if (patch.homeworkDeadline !== undefined) {
      sets.push(`homework_deadline = $${idx++}`);
      params.push(patch.homeworkDeadline);
    }
    if (patch.homeworkDifficulty !== undefined) {
      sets.push(`homework_difficulty = $${idx++}`);
      params.push(patch.homeworkDifficulty);
    }
    if (patch.nextPreview !== undefined) {
      sets.push(`next_preview = $${idx++}`);
      params.push(patch.nextPreview);
    }
    sets.push(`updated_at = NOW()`);
    params.push(id);
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `UPDATE lesson_feedbacks SET ${sets.join(', ')} WHERE id = $${idx}
       RETURNING id, schedule_id, student_id, teacher_id, attendance_status,
                 classroom_performance, knowledge_points, homework,
                 homework_attachments, teacher_note, teacher_internal_note,
                 knowledge_matrix, dim_ratings, homework_deadline, homework_difficulty, next_preview,
                 parent_read_at, submitted_at, updated_at`,
      params,
    );
    if (rows.length === 0) throw new NotFoundException(`feedback ${id} not found`);
    return this.mapRow(rows[0]);
  }

  async markParentRead(
    tenantSchema: string,
    id: string,
  ): Promise<LessonFeedback> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `UPDATE lesson_feedbacks
       SET parent_read_at = COALESCE(parent_read_at, NOW())
       WHERE id = $1
       RETURNING id, schedule_id, student_id, teacher_id, attendance_status,
                 classroom_performance, knowledge_points, homework,
                 homework_attachments, teacher_note, teacher_internal_note,
                 knowledge_matrix, dim_ratings, homework_deadline, homework_difficulty, next_preview,
                 parent_read_at, submitted_at, updated_at`,
      [id],
    );
    if (rows.length === 0) throw new NotFoundException(`feedback ${id} not found`);
    return this.mapRow(rows[0]);
  }

  async countUnreadByParent(
    tenantSchema: string,
    studentIds: ReadonlyArray<string>,
  ): Promise<number> {
    if (studentIds.length === 0) return 0;
    const rows = await this.pg.tenantQuery<{ count: string }>(
      tenantSchema,
      `SELECT COUNT(*) as count FROM lesson_feedbacks
       WHERE student_id = ANY($1) AND parent_read_at IS NULL`,
      [studentIds as string[]],
    );
    return parseInt(rows[0]?.count || '0', 10);
  }

  // ===== helpers =====
  private mapRow(row: PgRow): LessonFeedback {
    return {
      id: row.id,
      scheduleId: row.schedule_id,
      studentId: row.student_id,
      teacherId: row.teacher_id,
      attendanceStatus: row.attendance_status,
      classroomPerformance: row.classroom_performance,
      knowledgePoints:
        row.knowledge_points
          ? typeof row.knowledge_points === 'string'
            ? JSON.parse(row.knowledge_points)
            : row.knowledge_points
          : undefined,
      homework: row.homework || undefined,
      homeworkAttachments:
        row.homework_attachments
          ? typeof row.homework_attachments === 'string'
            ? JSON.parse(row.homework_attachments)
            : row.homework_attachments
          : undefined,
      teacherNote: row.teacher_note || undefined,
      teacherInternalNote: row.teacher_internal_note || undefined,
      knowledgeMatrix:
        row.knowledge_matrix
          ? typeof row.knowledge_matrix === 'string'
            ? JSON.parse(row.knowledge_matrix)
            : row.knowledge_matrix
          : undefined,
      dimRatings:
        row.dim_ratings
          ? typeof row.dim_ratings === 'string'
            ? JSON.parse(row.dim_ratings)
            : row.dim_ratings
          : undefined,
      homeworkDeadline: row.homework_deadline || undefined,
      homeworkDifficulty: row.homework_difficulty || undefined,
      nextPreview: row.next_preview || undefined,
      parentReadAt: row.parent_read_at || undefined,
      submittedAt: row.submitted_at,
      updatedAt: row.updated_at,
    };
  }
}
