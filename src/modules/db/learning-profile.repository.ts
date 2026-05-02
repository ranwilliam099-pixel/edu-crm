import { Injectable } from '@nestjs/common';
import { PgPoolService } from './pg-pool.service';
import { StudentLearningProfile } from '../learning-profile/student-learning-profile.service';

/**
 * LearningProfileRepository — V15 学员学情累计档案持久化层（tenant schema）
 *
 * 表：student_learning_profile（V15 §15.1，一学员一行）
 *   cron 每天 0:00 增量重算（PD §9 Q-T7 默认）
 */
@Injectable()
export class LearningProfileRepository {
  constructor(private readonly pg: PgPoolService) {}

  /**
   * UPSERT 学情档案（cron 每日重算用）
   */
  async upsert(
    tenantSchema: string,
    profile: StudentLearningProfile,
  ): Promise<StudentLearningProfile> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `INSERT INTO student_learning_profile (
         student_id, total_lessons, total_homeworks, total_assessments,
         attendance_rate, avg_homework_grade, avg_assessment_score,
         knowledge_mastery, weakness_points, strength_points, last_updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (student_id) DO UPDATE SET
         total_lessons = EXCLUDED.total_lessons,
         total_homeworks = EXCLUDED.total_homeworks,
         total_assessments = EXCLUDED.total_assessments,
         attendance_rate = EXCLUDED.attendance_rate,
         avg_homework_grade = EXCLUDED.avg_homework_grade,
         avg_assessment_score = EXCLUDED.avg_assessment_score,
         knowledge_mastery = EXCLUDED.knowledge_mastery,
         weakness_points = EXCLUDED.weakness_points,
         strength_points = EXCLUDED.strength_points,
         last_updated_at = EXCLUDED.last_updated_at
       RETURNING student_id, total_lessons, total_homeworks, total_assessments,
                 attendance_rate, avg_homework_grade, avg_assessment_score,
                 knowledge_mastery, weakness_points, strength_points, last_updated_at`,
      [
        profile.studentId,
        profile.totalLessons,
        profile.totalHomeworks,
        profile.totalAssessments,
        profile.attendanceRate,
        profile.avgHomeworkGrade ?? null,
        profile.avgAssessmentScore ?? null,
        JSON.stringify(profile.knowledgeMastery),
        JSON.stringify(profile.weaknessPoints),
        JSON.stringify(profile.strengthPoints),
        profile.lastUpdatedAt,
      ],
    );
    return this.mapRow(rows[0]);
  }

  async findByStudent(
    tenantSchema: string,
    studentId: string,
  ): Promise<StudentLearningProfile | null> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT student_id, total_lessons, total_homeworks, total_assessments,
              attendance_rate, avg_homework_grade, avg_assessment_score,
              knowledge_mastery, weakness_points, strength_points, last_updated_at
       FROM student_learning_profile WHERE student_id = $1`,
      [studentId],
    );
    return rows.length === 0 ? null : this.mapRow(rows[0]);
  }

  /**
   * cron 全量重算用：列出 N 天内有更新需要重算的学员
   * （这里返回所有学员 ID — 实际可以根据 last_seen 优化）
   */
  async listAllStudentIds(tenantSchema: string): Promise<string[]> {
    const rows = await this.pg.tenantQuery<{ id: string }>(
      tenantSchema,
      `SELECT id FROM students ORDER BY id`,
    );
    return rows.map((r) => r.id);
  }

  async listStale(
    tenantSchema: string,
    threshold: Date,
  ): Promise<StudentLearningProfile[]> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT student_id, total_lessons, total_homeworks, total_assessments,
              attendance_rate, avg_homework_grade, avg_assessment_score,
              knowledge_mastery, weakness_points, strength_points, last_updated_at
       FROM student_learning_profile
       WHERE last_updated_at < $1
       ORDER BY last_updated_at ASC`,
      [threshold],
    );
    return rows.map((r) => this.mapRow(r));
  }

  // ===== helpers =====
  private mapRow(row: any): StudentLearningProfile {
    return {
      studentId: row.student_id,
      totalLessons: row.total_lessons,
      totalHomeworks: row.total_homeworks,
      totalAssessments: row.total_assessments,
      attendanceRate: Number(row.attendance_rate),
      avgHomeworkGrade: row.avg_homework_grade || undefined,
      avgAssessmentScore:
        row.avg_assessment_score !== null
          ? Number(row.avg_assessment_score)
          : undefined,
      knowledgeMastery:
        typeof row.knowledge_mastery === 'string'
          ? JSON.parse(row.knowledge_mastery)
          : row.knowledge_mastery,
      weaknessPoints:
        typeof row.weakness_points === 'string'
          ? JSON.parse(row.weakness_points)
          : row.weakness_points,
      strengthPoints:
        typeof row.strength_points === 'string'
          ? JSON.parse(row.strength_points)
          : row.strength_points,
      lastUpdatedAt: row.last_updated_at,
    };
  }
}
