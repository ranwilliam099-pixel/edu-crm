import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PgPoolService } from './pg-pool.service';

/**
 * RecommendationRepository — V17 家长推荐持久化层（tenant schema）
 *
 * 来源：用户 2026-05-04 endpoint #2（pages/b/teacher/recommendations/list）
 *
 * 表：parent_recommendations（V17 §17.1）
 *
 * 业务约束：只有 parent_authorized=true 的才允许 toggle displayed=true
 */

export interface ParentRecommendation {
  id: string;
  teacherId: string;
  parentId: string;
  studentId: string;
  stars: number;
  content?: string;
  tags?: string[];
  parentAuthorized: boolean;
  displayed: boolean;
  submittedAt: Date;
  createdAt: Date;
}

@Injectable()
export class RecommendationRepository {
  constructor(private readonly pg: PgPoolService) {}

  async insert(
    tenantSchema: string,
    rec: ParentRecommendation,
  ): Promise<ParentRecommendation> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `INSERT INTO parent_recommendations (
         id, teacher_id, parent_id, student_id, stars, content,
         tags, parent_authorized, displayed, submitted_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, teacher_id, parent_id, student_id, stars, content,
                 tags, parent_authorized, displayed, submitted_at, created_at`,
      [
        rec.id,
        rec.teacherId,
        rec.parentId,
        rec.studentId,
        rec.stars,
        rec.content || null,
        JSON.stringify(rec.tags || []),
        rec.parentAuthorized,
        rec.displayed,
        rec.submittedAt,
      ],
    );
    return this.mapRow(rows[0]);
  }

  async listByTeacher(
    tenantSchema: string,
    teacherId: string,
  ): Promise<ParentRecommendation[]> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, teacher_id, parent_id, student_id, stars, content,
              tags, parent_authorized, displayed, submitted_at, created_at
       FROM parent_recommendations
       WHERE teacher_id = $1
       ORDER BY submitted_at DESC`,
      [teacherId],
    );
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * 老师切换 displayed
   * 业务约束：只有 parent_authorized=true 才允许 displayed=true
   *   - WHERE 加守护：parent_authorized = TRUE OR $1 = FALSE
   *   - 不满足 → 0 行 → BadRequestException
   */
  async toggleDisplayed(
    tenantSchema: string,
    id: string,
    displayed: boolean,
  ): Promise<ParentRecommendation> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `UPDATE parent_recommendations
       SET displayed = $1
       WHERE id = $2
         AND (parent_authorized = TRUE OR $1 = FALSE)
       RETURNING id, teacher_id, parent_id, student_id, stars, content,
                 tags, parent_authorized, displayed, submitted_at, created_at`,
      [displayed, id],
    );
    if (rows.length === 0) {
      // 区分两种情况：不存在 vs parent_authorized=false 时尝试 displayed=true
      const exists = await this.pg.tenantQuery<{ parent_authorized: boolean }>(
        tenantSchema,
        `SELECT parent_authorized FROM parent_recommendations WHERE id = $1`,
        [id],
      );
      if (exists.length === 0) {
        throw new NotFoundException(`recommendation ${id} not found`);
      }
      throw new BadRequestException(
        `cannot display recommendation ${id} without parent authorization`,
      );
    }
    return this.mapRow(rows[0]);
  }

  async countDisplayed(
    tenantSchema: string,
    teacherId: string,
  ): Promise<number> {
    const rows = await this.pg.tenantQuery<{ count: string }>(
      tenantSchema,
      `SELECT COUNT(*) as count
       FROM parent_recommendations
       WHERE teacher_id = $1 AND displayed = TRUE`,
      [teacherId],
    );
    return parseInt(rows[0]?.count || '0', 10);
  }

  /**
   * 邀请家长留推荐 — 真实业务接外部消息（微信通知/SMS）
   * MOCK：返回 ok 占位（EXT-02 待真接入）
   */
  // TODO(EXT-02): 接微信订阅消息 / SMS
  async inviteParent(
    _tenantSchema: string,
    _teacherId: string,
    _studentId: string,
  ): Promise<{ ok: true; msg: string }> {
    return { ok: true, msg: 'invite-sent (mock)' };
  }

  // ===== helpers =====
  private mapRow(row: any): ParentRecommendation {
    return {
      id: row.id,
      teacherId: row.teacher_id,
      parentId: row.parent_id,
      studentId: row.student_id,
      stars: row.stars,
      content: row.content || undefined,
      tags: row.tags
        ? typeof row.tags === 'string'
          ? JSON.parse(row.tags)
          : row.tags
        : [],
      parentAuthorized: row.parent_authorized,
      displayed: row.displayed,
      submittedAt: row.submitted_at,
      createdAt: row.created_at,
    };
  }
}
