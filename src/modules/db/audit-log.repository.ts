import { Injectable } from '@nestjs/common';
import { PgPoolService } from './pg-pool.service';

/**
 * AuditLogRepository — V33 审计日志持久化层（tenant schema）
 *
 * 来源：用户 2026-05-10 「可上架生产架构」P0 第 1 项
 *
 * 表：audit_log（V33 §33.1）
 *   actor_role: admin / boss / sales / sales_manager / sales_director /
 *               academic / academic_admin / edu_admin / ops /
 *               teacher / finance / hr / parent / platform_admin / system
 *
 * 用法：
 *   await auditLog.log(tenantSchema, {
 *     actorUserId: 'usr_xxx',
 *     actorRole: 'sales',
 *     action: 'student.transfer-sales',
 *     targetType: 'student',
 *     targetId: 'stu_xxx',
 *     before: { ownerSalesId: 'usr_a' },
 *     after:  { ownerSalesId: 'usr_b' },
 *     ip: '1.2.3.4',
 *     userAgent: 'WeChatMP/8.x.x',
 *     requestId: 'req-xxx',
 *   });
 *
 * 规则（不抛错策略）：
 *   - 审计写失败不应影响主业务流（log() 内部 catch 仅记 logger）
 *   - 主业务流应在事务外调用 log()，避免 audit_log 失败回滚业务
 */

export type ActorRole =
  | 'admin'
  | 'boss'
  | 'sales'
  | 'sales_manager'
  | 'sales_director'
  | 'academic'
  | 'academic_admin'
  | 'edu_admin'
  | 'ops'
  | 'teacher'
  | 'finance'
  | 'hr'
  | 'parent'
  | 'platform_admin'
  | 'system';

export interface AuditEntry {
  id?: number;
  actorUserId?: string | null;
  actorRole: ActorRole;
  action: string;
  targetType: string;
  targetId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  createdAt?: Date;
}

export interface AuditListFilter {
  actorUserId?: string;
  targetType?: string;
  targetId?: string;
  action?: string;
  limit?: number;
  offset?: number;
}

@Injectable()
export class AuditLogRepository {
  constructor(private readonly pg: PgPoolService) {}

  /**
   * 写一条审计日志（不抛错；失败仅 console.error，不阻塞主业务）
   */
  async log(tenantSchema: string, entry: AuditEntry): Promise<void> {
    try {
      await this.pg.tenantQuery(
        tenantSchema,
        `INSERT INTO audit_log (
           actor_user_id, actor_role, action, target_type, target_id,
           before, after, ip, user_agent, request_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          entry.actorUserId ?? null,
          entry.actorRole,
          entry.action,
          entry.targetType,
          entry.targetId ?? null,
          entry.before ? JSON.stringify(entry.before) : null,
          entry.after ? JSON.stringify(entry.after) : null,
          entry.ip ?? null,
          entry.userAgent ?? null,
          entry.requestId ?? null,
        ],
      );
    } catch (err) {
      // 审计写失败不影响主业务流
      // eslint-disable-next-line no-console
      console.error('[AUDIT-LOG-FAILED]', { tenantSchema, action: entry.action, err });
    }
  }

  /**
   * 查最近 N 条（时间倒序）
   */
  async listRecent(tenantSchema: string, limit = 50): Promise<AuditEntry[]> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, actor_user_id, actor_role, action, target_type, target_id,
              before, after, ip, user_agent, request_id, created_at
         FROM audit_log
         ORDER BY created_at DESC
         LIMIT $1`,
      [limit],
    );
    return rows.map((r) => this.toEntry(r));
  }

  /**
   * 查某用户操作历史
   */
  async listByActor(
    tenantSchema: string,
    actorUserId: string,
    limit = 50,
  ): Promise<AuditEntry[]> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, actor_user_id, actor_role, action, target_type, target_id,
              before, after, ip, user_agent, request_id, created_at
         FROM audit_log
         WHERE actor_user_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
      [actorUserId, limit],
    );
    return rows.map((r) => this.toEntry(r));
  }

  /**
   * 查某对象变更历史（OOUX：从 student/detail 调用）
   */
  async listByTarget(
    tenantSchema: string,
    targetType: string,
    targetId: string,
    limit = 50,
  ): Promise<AuditEntry[]> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, actor_user_id, actor_role, action, target_type, target_id,
              before, after, ip, user_agent, request_id, created_at
         FROM audit_log
         WHERE target_type = $1 AND target_id = $2
         ORDER BY created_at DESC
         LIMIT $3`,
      [targetType, targetId, limit],
    );
    return rows.map((r) => this.toEntry(r));
  }

  /**
   * 自由组合过滤
   */
  async list(
    tenantSchema: string,
    filter: AuditListFilter = {},
  ): Promise<AuditEntry[]> {
    const conds: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (filter.actorUserId) {
      conds.push(`actor_user_id = $${idx++}`);
      params.push(filter.actorUserId);
    }
    if (filter.targetType) {
      conds.push(`target_type = $${idx++}`);
      params.push(filter.targetType);
    }
    if (filter.targetId) {
      conds.push(`target_id = $${idx++}`);
      params.push(filter.targetId);
    }
    if (filter.action) {
      conds.push(`action = $${idx++}`);
      params.push(filter.action);
    }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;
    params.push(limit, offset);

    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, actor_user_id, actor_role, action, target_type, target_id,
              before, after, ip, user_agent, request_id, created_at
         FROM audit_log
         ${where}
         ORDER BY created_at DESC
         LIMIT $${idx++} OFFSET $${idx}`,
      params,
    );
    return rows.map((r) => this.toEntry(r));
  }

  /**
   * 统计（监控用：某动作发生频率 / 某用户操作量）
   */
  async count(tenantSchema: string, filter: AuditListFilter = {}): Promise<number> {
    const conds: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (filter.actorUserId) {
      conds.push(`actor_user_id = $${idx++}`);
      params.push(filter.actorUserId);
    }
    if (filter.targetType) {
      conds.push(`target_type = $${idx++}`);
      params.push(filter.targetType);
    }
    if (filter.targetId) {
      conds.push(`target_id = $${idx++}`);
      params.push(filter.targetId);
    }
    if (filter.action) {
      conds.push(`action = $${idx++}`);
      params.push(filter.action);
    }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const rows = await this.pg.tenantQuery<{ cnt: string }>(
      tenantSchema,
      `SELECT COUNT(*)::text AS cnt FROM audit_log ${where}`,
      params,
    );
    return Number(rows[0]?.cnt ?? 0);
  }

  private toEntry(row: any): AuditEntry {
    return {
      id: row.id,
      actorUserId: row.actor_user_id ?? null,
      actorRole: row.actor_role,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id ?? null,
      before: row.before ?? null,
      after: row.after ?? null,
      ip: row.ip ?? null,
      userAgent: row.user_agent ?? null,
      requestId: row.request_id ?? null,
      createdAt: row.created_at,
    };
  }
}
