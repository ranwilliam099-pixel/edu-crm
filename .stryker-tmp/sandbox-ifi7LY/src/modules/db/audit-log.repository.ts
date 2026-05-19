import { Injectable, Logger } from '@nestjs/common';
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
 *   5/15 A-2 拍板：应用层 jwt.role 已删 sales_director（不在拍板角色清单），
 *   但 V33 schema CHECK 仍允许 sales_director — 保留 ActorRole 枚举以兼容历史 audit_log
 *   row 的读取查询，不会再有新 INSERT（normalizeActorRole 路径走 JWT，JWT 不再含此 role）。
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

// 5/15 A-2：sales_director 保留（schema V33 CHECK 仍含 + 历史 audit_log row 读取需要）
//   应用层 JWT 不再发此 role → normalizeActorRole 不会再 fallback 到 sales_director
//   仅为读取 listRecent / listByTarget 返回的旧 row.actor_role 时类型不报错
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

/**
 * VALID_ACTOR_ROLES — Sprint E #3 round 5 (2026-05-13 A09 FINDING-1 修复)
 *
 * 与 V33 migration CHECK constraint 严格对齐的运行时白名单。
 *
 * 修复背景：B.4-1 actorRole helper 原用 `(req.user?.role as ActorRole) ?? 'system'`
 * 纯 TS 类型强转，无运行时校验。当 JWT role=marketing 或 finance_admin（不在 ActorRole
 * 枚举内）触发 audit_log INSERT 时，V33 CHECK constraint 违反 → INSERT 报错 →
 * AuditLogRepository.log 内部 catch fail-open → 拒绝路径 audit entry 静默丢失。
 *
 * 修法：normalizeActorRole(role) 在白名单内直接用，否则 fallback 'system'
 * （audit_log 写入 'system' 仍合规，与 cron job / 后台任务一致）。
 *
 * TenantRole 'marketing' / PlatformRole 'finance_admin' 不在 ActorRole 内是
 * 设计意图（marketing/finance_admin 是平台级，不应直接出现在租户 schema 的 audit_log
 * 写入流，应通过 normalizeActorRole 收口为 'system'）。
 */
export const VALID_ACTOR_ROLES: ReadonlySet<ActorRole> = new Set<ActorRole>([
  'admin',
  'boss',
  'sales',
  'sales_manager',
  'sales_director',
  'academic',
  'academic_admin',
  'edu_admin',
  'ops',
  'teacher',
  'finance',
  'hr',
  'parent',
  'platform_admin',
  'system',
]);

/**
 * normalizeActorRole — 运行时校验 + fallback 'system'
 * 用法：controller / service 写 audit 时统一通过此 helper 取 actorRole，
 * 避免越界 role（如 marketing/finance_admin/未知字符串）导致 V33 CHECK 违反。
 */
export function normalizeActorRole(role: string | undefined | null): ActorRole {
  if (role && (VALID_ACTOR_ROLES as ReadonlySet<string>).has(role)) {
    return role as ActorRole;
  }
  return 'system';
}

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
  // R1: NestJS Logger 取代 console.error（pino 日志链路 + PII redact 自动生效）
  // 注：Logger 不需要 DI（无依赖），实例化时绑定 context name 即可
  private readonly logger = new Logger(AuditLogRepository.name);

  constructor(private readonly pg: PgPoolService) {}

  /**
   * 写一条审计日志（不抛错；失败 this.logger.error 走 pino + PII redact，不阻塞主业务）
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
      // R1: 审计写失败不影响主业务流（fail-open）。改用 NestJS Logger →
      // 经由 nestjs-pino 进入 pino 流水线，自动应用 REDACT_PATHS PII 脱敏
      // （*.phone / *.id_number / *.token 等都会被 [REDACTED]；err 对象通常仅含
      // tenantSchema/action/message/stack 无业务字段，但通配规则提供额外保险）
      this.logger.error(
        '[AUDIT-LOG-FAILED]',
        {
          tenantSchema,
          action: entry.action,
          targetType: entry.targetType,
          targetId: entry.targetId ?? null,
          err: err instanceof Error
            ? { name: err.name, message: err.message, stack: err.stack }
            : err,
        },
      );
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
