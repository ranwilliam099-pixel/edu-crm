import {
  Injectable,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PgPoolService, PgRow } from './pg-pool.service';
import { AuditLogRepository, ActorRole } from './audit-log.repository';

/**
 * TeacherShowcaseMetaRepository — V35 老师 showcase「美化」数据持久化层
 *
 * 来源：
 *   - V35__teacher_showcase_meta.sql 双轨数据基础设施
 *   - 用户 2026-05-10 全局规则 #3「老师业务展示卡双轨 — 老师可美化展示数据
 *     （家长/销售看的），但系统真实数据另存（用于业绩 KPI / 工资计算）」
 *   - C.2 Sprint 应用层落地（commit 01959d4 V35 后规划）
 *
 * 表：__TENANT_SCHEMA__.teacher_showcase_meta（V35 §35.1，一老师一行 1:1）
 *   teacher_id (PK FK→teachers.id) / avatar_url / bio
 *   video_urls (JSONB) / testimonials (JSONB)
 *   displayed_recommendations_count / trial_available
 *   created_at / updated_at / updated_by_user_id
 *
 * 双轨硬红线（绝不破例）：
 *   - KPI / leaderboard / 工资 → teachers 表 + teacher_ratings (V24)
 *   - showcase 展示 / 销售卡 / 家长选老师 → 本表（meta）
 *   - 严禁本表字段进入 KPI 统计
 *
 * 调用约束（C.2 server-backend-production-validator WARN 转 BLOCKER）：
 *   - upsertMeta 必须有 operatorUserId（否则 audit_log 链路断 → throw BadRequest）
 *   - 每次 upsert 走 audit_log（action='teacher.showcase-meta.update'，before/after diff）
 *   - audit_log 写失败不阻塞主流程（AuditLogRepository.log 内部 catch + Logger.error）
 */

export interface TeacherShowcaseMeta {
  teacherId: string;
  avatarUrl: string | null;
  bio: string | null;
  videoUrls: VideoUrlEntry[];
  testimonials: TestimonialEntry[];
  displayedRecommendationsCount: number;
  trialAvailable: boolean;
  createdAt: Date | string;
  updatedAt: Date | string;
  updatedByUserId: string | null;
}

export interface VideoUrlEntry {
  url: string;
  title?: string;
  duration_seconds?: number;
}

export interface TestimonialEntry {
  anon_name: string;
  content: string;
  stars: number;
  submitted_at?: string;
}

/**
 * upsert 入参 — 全部美化字段可选；未提供的字段视为「不变」（COALESCE）
 *
 * 注：JSONB 字段（videoUrls / testimonials）若客户端要清空，需显式传 []，
 * 而非 undefined（undefined 走 COALESCE 保留旧值）
 */
export interface UpsertShowcaseMetaPayload {
  avatarUrl?: string | null;
  bio?: string | null;
  videoUrls?: VideoUrlEntry[];
  testimonials?: TestimonialEntry[];
  displayedRecommendationsCount?: number;
  trialAvailable?: boolean;
}

/**
 * audit_log 审计上下文（controller 注入 → 进入 before/after diff 记录链路）
 */
export interface UpsertAuditContext {
  actorRole: ActorRole;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

@Injectable()
export class TeacherShowcaseMetaRepository {
  private readonly logger = new Logger(TeacherShowcaseMetaRepository.name);

  constructor(
    private readonly pg: PgPoolService,
    private readonly auditLog: AuditLogRepository,
  ) {}

  /**
   * 查 teacher 的 showcase meta（1:1 → 返回单行或 null）
   *
   * @returns meta 行 / null（老师从未编辑过 showcase）
   */
  async getMeta(
    tenantSchema: string,
    teacherId: string,
  ): Promise<TeacherShowcaseMeta | null> {
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT teacher_id, avatar_url, bio, video_urls, testimonials,
              displayed_recommendations_count, trial_available,
              created_at, updated_at, updated_by_user_id
         FROM teacher_showcase_meta
        WHERE teacher_id = $1`,
      [teacherId],
    );
    if (rows.length === 0) return null;
    return this.mapRow(rows[0]);
  }

  /**
   * INSERT ON CONFLICT teacher_id DO UPDATE — 一老师一行（V35 1:1）
   *
   * 行为：
   *   - 第一次 upsert：INSERT 新行（已有字段 + 默认值 fill）
   *   - 后续 upsert：UPDATE COALESCE(EXCLUDED, table) — 未传字段保留旧值
   *   - JSONB 字段 video_urls / testimonials 显式传 [] 才会清空
   *   - 自动 audit_log 记 before（旧行 snapshot）→ after（新行 snapshot）
   *
   * 校验：
   *   - operatorUserId 必填 → 否则 audit_log 链路断
   *   - displayedRecommendationsCount ≥ 0（数据库 CHECK，但前置校验提早返回 400）
   *
   * @throws BadRequestException operatorUserId 缺失 / displayedRecommendationsCount < 0
   */
  async upsertMeta(
    tenantSchema: string,
    teacherId: string,
    payload: UpsertShowcaseMetaPayload,
    operatorUserId: string,
    auditCtx: UpsertAuditContext,
  ): Promise<TeacherShowcaseMeta> {
    // operator 校验（C.1 production-validator WARN 转 BLOCKER）
    if (!operatorUserId || typeof operatorUserId !== 'string') {
      throw new BadRequestException(
        'operatorUserId required for showcase-meta upsert (audit_log chain integrity)',
      );
    }
    if (
      payload.displayedRecommendationsCount !== undefined &&
      payload.displayedRecommendationsCount < 0
    ) {
      throw new BadRequestException(
        'displayedRecommendationsCount must be >= 0',
      );
    }

    // 1. 读取 before（用于 audit_log diff；null 表示首次创建）
    const before = await this.getMeta(tenantSchema, teacherId);

    // 2. 构造 INSERT 参数
    //    JSONB 字段：未传 → DEFAULT '[]'::jsonb（首次创建）/ COALESCE 旧值（更新）
    //    其他字段：null 表示首次创建走 NULL；COALESCE 保留旧值
    const videoUrlsParam = payload.videoUrls !== undefined
      ? JSON.stringify(payload.videoUrls)
      : null;
    const testimonialsParam = payload.testimonials !== undefined
      ? JSON.stringify(payload.testimonials)
      : null;

    const sql = `
      INSERT INTO teacher_showcase_meta (
        teacher_id, avatar_url, bio, video_urls, testimonials,
        displayed_recommendations_count, trial_available,
        created_at, updated_at, updated_by_user_id
      ) VALUES (
        $1,
        $2,
        $3,
        COALESCE($4::jsonb, '[]'::jsonb),
        COALESCE($5::jsonb, '[]'::jsonb),
        COALESCE($6, 0),
        COALESCE($7, FALSE),
        NOW(), NOW(), $8
      )
      ON CONFLICT (teacher_id) DO UPDATE SET
        avatar_url                      = COALESCE(EXCLUDED.avatar_url, teacher_showcase_meta.avatar_url),
        bio                             = COALESCE(EXCLUDED.bio, teacher_showcase_meta.bio),
        video_urls                      = COALESCE($4::jsonb, teacher_showcase_meta.video_urls),
        testimonials                    = COALESCE($5::jsonb, teacher_showcase_meta.testimonials),
        displayed_recommendations_count = COALESCE($6, teacher_showcase_meta.displayed_recommendations_count),
        trial_available                 = COALESCE($7, teacher_showcase_meta.trial_available),
        updated_at                      = NOW(),
        updated_by_user_id              = $8
      RETURNING teacher_id, avatar_url, bio, video_urls, testimonials,
                displayed_recommendations_count, trial_available,
                created_at, updated_at, updated_by_user_id
    `;

    const params = [
      teacherId,
      payload.avatarUrl ?? null,
      payload.bio ?? null,
      videoUrlsParam,
      testimonialsParam,
      payload.displayedRecommendationsCount ?? null,
      payload.trialAvailable ?? null,
      operatorUserId,
    ];

    const rows = await this.pg.tenantQuery<PgRow>(tenantSchema, sql, params);
    const after = this.mapRow(rows[0]);

    // 3. audit_log — 不阻塞主业务（AuditLogRepository.log 内部 catch）
    //    before=null → 首次 create；before≠null → update
    await this.auditLog.log(tenantSchema, {
      actorUserId: operatorUserId,
      actorRole: auditCtx.actorRole,
      action: 'teacher.showcase-meta.update',
      targetType: 'teacher_showcase_meta',
      targetId: teacherId,
      before: before ? this.snapshotForAudit(before) : null,
      after: this.snapshotForAudit(after),
      ip: auditCtx.ip ?? null,
      userAgent: auditCtx.userAgent ?? null,
      requestId: auditCtx.requestId ?? null,
    });

    return after;
  }

  // ====================================================================
  // helpers
  // ====================================================================

  /**
   * 序列化 before/after 进入 audit_log.before/after JSONB
   * 仅保留业务可视字段（teacher_id 不重复存 — audit 行 target_id 已含）
   */
  private snapshotForAudit(meta: TeacherShowcaseMeta): Record<string, unknown> {
    return {
      avatarUrl: meta.avatarUrl,
      bio: meta.bio,
      videoUrls: meta.videoUrls,
      testimonials: meta.testimonials,
      displayedRecommendationsCount: meta.displayedRecommendationsCount,
      trialAvailable: meta.trialAvailable,
    };
  }

  private mapRow(row: PgRow): TeacherShowcaseMeta {
    return {
      teacherId: row.teacher_id,
      avatarUrl: row.avatar_url ?? null,
      bio: row.bio ?? null,
      videoUrls: this.parseJsonbArray(row.video_urls) as VideoUrlEntry[],
      testimonials: this.parseJsonbArray(row.testimonials) as TestimonialEntry[],
      displayedRecommendationsCount: Number(row.displayed_recommendations_count ?? 0),
      trialAvailable: row.trial_available === true,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      updatedByUserId: row.updated_by_user_id ?? null,
    };
  }

  /**
   * pg 驱动可能把 JSONB 列返回为：
   *   - 已解析的 array（默认 pg.types parser）
   *   - 字符串（特定 pool 配置 / 客户端 mock）
   * 都归一化为 array
   */
  private parseJsonbArray(raw: unknown): unknown[] {
    if (raw === null || raw === undefined) return [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  }
}
