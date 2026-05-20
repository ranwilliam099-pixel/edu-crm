import { Injectable, Logger } from '@nestjs/common';
import { PgPoolService, PgRow } from './pg-pool.service';

/**
 * TeacherRatingRepository — V53 老师评分明细表（家长 C 端评老师）
 *
 * 来源：P4-Y 任务 2026-05-20 — 4 个 C 端 endpoint 之一
 *
 * 表：teacher_rating_entries（V53 §53.1）
 *   PK = id；UNIQUE(parent_id, teacher_id, student_id) 三元组唯一
 *
 * 业务规则（应用层 + DB 双层）：
 *   - 同一 parent + teacher + student 仅 1 条记录
 *   - 重复评分 → upsert（PATCH 而非 INSERT）— 通过 ON CONFLICT DO UPDATE
 *   - content / tags 可空（用户可只打星不写文字）
 *   - stars CHECK 1-5（DB 兜底）
 *
 * 与 V24 teacher_ratings 区别：
 *   - V24 = 聚合表（每老师 1 行；avg_stars / rating_count）
 *   - V53 = 明细表（每对 parent×teacher×student 1 行）
 *   - V24 聚合维护留 Sprint Y（trigger 或 cron）
 */
export interface TeacherRatingEntry {
  id: string;
  parentId: string;
  teacherId: string;
  studentId: string;
  stars: number;
  content?: string | null;
  tags?: string[] | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface TeacherRatingUpsertInput {
  id: string;
  parentId: string;
  teacherId: string;
  studentId: string;
  stars: number;
  content?: string | null;
  tags?: string[] | null;
}

@Injectable()
export class TeacherRatingRepository {
  private readonly logger = new Logger(TeacherRatingRepository.name);

  constructor(private readonly pg: PgPoolService) {}

  /**
   * Upsert 一条评分（同三元组重复时 UPDATE 而非 INSERT）
   *
   * 返回值含 isInsert 标志：
   *   - true  → 新插入（首次评分）
   *   - false → 已存在 → 已 UPDATE（修改评分）
   *
   * UNIQUE(parent_id, teacher_id, student_id) 触发 ON CONFLICT DO UPDATE
   * RETURNING xmax = 0 PG 内部约定（xmax=0 = 新 INSERT；xmax!=0 = UPDATE）
   */
  async upsert(
    tenantSchema: string,
    input: TeacherRatingUpsertInput,
  ): Promise<{ entry: TeacherRatingEntry; isInsert: boolean }> {
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `INSERT INTO teacher_rating_entries
         (id, parent_id, teacher_id, student_id, stars, content, tags, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $2)
       ON CONFLICT (parent_id, teacher_id, student_id) DO UPDATE
         SET stars      = EXCLUDED.stars,
             content    = EXCLUDED.content,
             tags       = EXCLUDED.tags,
             updated_at = NOW()
       RETURNING id, parent_id, teacher_id, student_id, stars, content, tags,
                 created_at, updated_at, created_by, (xmax = 0) AS is_insert`,
      [
        input.id,
        input.parentId,
        input.teacherId,
        input.studentId,
        input.stars,
        input.content ?? null,
        input.tags ? JSON.stringify(input.tags) : null,
      ],
    );
    const row = rows[0];
    return {
      entry: this.mapRow(row),
      isInsert: row.is_insert === true,
    };
  }

  /**
   * 按 parent + teacher + student 三元组查（用户重复评分时前端可先查）
   */
  async findByTriple(
    tenantSchema: string,
    parentId: string,
    teacherId: string,
    studentId: string,
  ): Promise<TeacherRatingEntry | null> {
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT id, parent_id, teacher_id, student_id, stars, content, tags,
              created_at, updated_at, created_by
         FROM teacher_rating_entries
        WHERE parent_id = $1 AND teacher_id = $2 AND student_id = $3
        LIMIT 1`,
      [parentId, teacherId, studentId],
    );
    return rows.length === 0 ? null : this.mapRow(rows[0]);
  }

  /**
   * 检查 student × teacher 是否真实关系（OOUX 主带 / schedule 历史）
   * 用于 parent 评分前的合法性校验（防 parent 评跨学员/跨机构老师）
   *
   * 校验来源（OR 关系）：
   *   1. students.assigned_teacher_id = teacherId（主带关系）
   *   2. EXISTS schedules JOIN schedule_students（教过该学员的课）
   *   3. EXISTS student_teacher_bindings（V8.1 显式绑定）
   */
  async isTeacherForStudent(
    tenantSchema: string,
    teacherId: string,
    studentId: string,
  ): Promise<boolean> {
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT 1 AS hit
         FROM students s
        WHERE s.id = $2
          AND s.deleted_at IS NULL
          AND (
            s.assigned_teacher_id = $1
            OR EXISTS (
              SELECT 1 FROM schedules sc
                JOIN schedule_students ss ON ss.schedule_id = sc.id
               WHERE sc.teacher_id = $1
                 AND ss.student_id = $2
            )
            OR EXISTS (
              SELECT 1 FROM student_teacher_bindings stb
               WHERE stb.teacher_id = $1
                 AND stb.student_id = $2
            )
          )
        LIMIT 1`,
      [teacherId, studentId],
    );
    return rows.length > 0;
  }

  private mapRow(r: PgRow): TeacherRatingEntry {
    let tags: string[] | null = null;
    if (r.tags) {
      if (Array.isArray(r.tags)) {
        tags = r.tags;
      } else if (typeof r.tags === 'string') {
        try {
          tags = JSON.parse(r.tags);
        } catch {
          tags = null;
        }
      }
    }
    return {
      id: r.id,
      parentId: r.parent_id,
      teacherId: r.teacher_id,
      studentId: r.student_id,
      stars: Number(r.stars),
      content: r.content ?? null,
      tags,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
      updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
      createdBy: r.created_by,
    };
  }
}
