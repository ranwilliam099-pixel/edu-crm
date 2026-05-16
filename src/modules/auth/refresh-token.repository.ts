import { Injectable, Logger } from '@nestjs/common';
import { PgPoolService } from '../db/pg-pool.service';

/**
 * RefreshTokenRepository — V43 public.refresh_tokens 持久化层
 *
 * 来源：
 *   - 2026-05-16 T11 architect spec §5 / §6
 *   - R1 audit P0-2 修复：文档承诺 / 0 实现
 *
 * 设计：
 *   - public schema（不切 tenant，跨 B/C 端共享）
 *   - 软引用 subject_id 无 FK（避免 cascade 删除丢历史审计）
 *   - token_hash BYTEA UNIQUE（HMAC-SHA256 输出 32 bytes）
 *   - rotation 模式：旧 row revoke + 新 row insert，原子事务（spec §3.1 / §3.3）
 *
 * 不在本层：
 *   - 计算 HMAC（service 层用 HmacHasher）
 *   - 重放检测决策（service 层）
 *   - audit_log（service 层用 AuditLogRepository）
 */

/** subject_type — V43 CHECK 强制（'b-user' | 'parent'） */
export type RefreshTokenSubjectType = 'b-user' | 'parent';

export interface RefreshTokenRow {
  id: string;
  subjectType: RefreshTokenSubjectType;
  subjectId: string;
  tenantId: string | null;
  tokenHash: Buffer;
  jti: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  userAgent: string | null;
  ip: string | null;
}

export interface InsertRefreshTokenInput {
  id: string;
  subjectType: RefreshTokenSubjectType;
  subjectId: string;
  tenantId: string | null;
  tokenHash: Buffer;
  jti: string;
  expiresAt: Date;
  userAgent: string | null;
  ip: string | null;
}

@Injectable()
export class RefreshTokenRepository {
  private readonly logger = new Logger(RefreshTokenRepository.name);

  constructor(private readonly pg: PgPoolService) {}

  /**
   * 按 token_hash 点查（UNIQUE 索引 ~0.5ms）
   * spec §2.2 step 3
   */
  async findByHash(tokenHash: Buffer): Promise<RefreshTokenRow | null> {
    const rows = await this.pg.query<Record<string, unknown>>(
      `SELECT id, subject_type, subject_id, tenant_id,
              token_hash, jti, expires_at, revoked_at,
              created_at, last_used_at, user_agent, ip
         FROM public.refresh_tokens
         WHERE token_hash = $1
         LIMIT 1`,
      [tokenHash],
    );
    return rows[0] ? this.toRow(rows[0]) : null;
  }

  /**
   * INSERT 新 refresh token（login 或 rotation 后）
   * spec §2.2 step 5
   */
  async insert(input: InsertRefreshTokenInput): Promise<void> {
    await this.pg.query(
      `INSERT INTO public.refresh_tokens (
         id, subject_type, subject_id, tenant_id, token_hash, jti,
         expires_at, user_agent, ip
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        input.id,
        input.subjectType,
        input.subjectId,
        input.tenantId,
        input.tokenHash,
        input.jti,
        input.expiresAt,
        input.userAgent,
        input.ip,
      ],
    );
  }

  /**
   * 撤销单个 token（按 id；rotation 内 step 5a）
   * spec §3.1
   */
  async revoke(id: string): Promise<void> {
    await this.pg.query(
      `UPDATE public.refresh_tokens
          SET revoked_at = NOW(), last_used_at = NOW()
        WHERE id = $1 AND revoked_at IS NULL`,
      [id],
    );
  }

  /**
   * 撤销某 subject 全部 active refresh_tokens（重放检测触发）
   * spec §3.3
   */
  async revokeAllBySubject(
    subjectType: RefreshTokenSubjectType,
    subjectId: string,
  ): Promise<number> {
    const result = await this.pg.query<{ id: string }>(
      `UPDATE public.refresh_tokens
          SET revoked_at = NOW()
        WHERE subject_type = $1
          AND subject_id   = $2
          AND revoked_at  IS NULL
       RETURNING id`,
      [subjectType, subjectId],
    );
    return result.length;
  }

  /**
   * cleanupExpired — cron job 每日 03:00 调用
   * spec §7：DELETE expires_at < now - 30d（保留近期过期 row 30d 便于审计/排查）
   */
  async cleanupExpired(retentionDays = 30): Promise<number> {
    const result = await this.pg.query<{ id: string }>(
      `DELETE FROM public.refresh_tokens
        WHERE expires_at < NOW() - ($1 || ' days')::INTERVAL
       RETURNING id`,
      [String(retentionDays)],
    );
    return result.length;
  }

  /** PG row → domain row（snake_case → camelCase） */
  private toRow(r: Record<string, unknown>): RefreshTokenRow {
    return {
      id: r.id as string,
      subjectType: r.subject_type as RefreshTokenSubjectType,
      subjectId: r.subject_id as string,
      tenantId: (r.tenant_id as string | null) ?? null,
      tokenHash: r.token_hash as Buffer,
      jti: r.jti as string,
      expiresAt: r.expires_at as Date,
      revokedAt: (r.revoked_at as Date | null) ?? null,
      createdAt: r.created_at as Date,
      lastUsedAt: (r.last_used_at as Date | null) ?? null,
      userAgent: (r.user_agent as string | null) ?? null,
      ip: (r.ip as string | null) ?? null,
    };
  }
}
