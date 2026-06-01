import { Injectable, Logger, Optional } from '@nestjs/common';
import { PgPoolService, PgRow } from './pg-pool.service';
import { AuditLogRepository, ActorRole } from './audit-log.repository';

/**
 * StudentAssignmentService — V63 (Phase 3) 学员→教务分配机制
 *
 * 来源：../edu-mp-sandbox/docs/2026-06-01-业务链方案-试听激活分配反馈.md Phase 3（#8）
 *
 * 业务：新学员**合同激活后**触发分配教务。
 *   校长（boss）配 campus_assignment_config.auto_assign_academic：
 *     开 → round-robin 发牌给本校在职 academic（A→B→C→A 环绕，游标 rr_last_academic_id）
 *     关 → 不分配（students.assigned_academic_id 留 NULL）→ 自然进「待分配」列表
 *
 * 设计要点：
 *   - 幂等：学员已有 assigned_academic_id（非 NULL）→ 直接 return，不重分（重复激活安全）
 *   - 并发安全：事务内 SELECT campus_assignment_config FOR UPDATE 锁配置行 →
 *     同校并发激活串行推进游标，不会双发同一个 academic
 *   - 池空（本校无在职 academic）：不报错，留 NULL + warn（学员落待分配，校长手动兜）
 *   - 自动分配审计：action='student.auto_assigned'（手动分配在 controller 写 student.manual_assigned）
 *
 * round-robin 池（§五.2 待决策）：
 *   Phase 3 prompt 拍板「默认仅 academic」。pool = ASSIGNMENT_POOL_ROLES。
 *   ⚠️ 业务方案文档推荐 academic + academic_admin（教务主管也接学员），尚未最终拍板。
 *   若后续确认纳入主管 → 改 ASSIGNMENT_POOL_ROLES 一处即可（其余逻辑不变）。
 */

// 发牌池角色（默认仅普通教务 academic）。改这里一处即可纳入 academic_admin。
export const ASSIGNMENT_POOL_ROLES: readonly string[] = ['academic'] as const;

export interface AssignmentResult {
  assigned: boolean;
  academicId?: string;
  /**
   * 未分配原因（assigned=false 时）：
   *   'already_assigned' 已有归属（幂等）/ 'auto_off' 自动分配关 / 'empty_pool' 本校无在职教务
   */
  reason?: 'already_assigned' | 'auto_off' | 'empty_pool';
}

@Injectable()
export class StudentAssignmentService {
  private readonly logger = new Logger(StudentAssignmentService.name);

  constructor(
    private readonly pg: PgPoolService,
    @Optional() private readonly auditLog?: AuditLogRepository,
  ) {}

  /**
   * 激活后触发：按校区配置决定是否 round-robin 发牌给本校教务。
   *
   * @param tenantSchema  租户 schema（tenant_xxx）
   * @param studentId     学员 id
   * @param campusId      学员所在校区（合同 campus_id；分配池/游标按校区隔离）
   * @param actor         触发者（激活合同的 finance；记入 audit + config.updated_by）
   *
   * 失败语义：本方法内部逻辑不抛业务错（事务异常仍会抛 → 调用方包 try/catch fail-open）。
   */
  async assignStudentIfNeeded(
    tenantSchema: string,
    studentId: string,
    campusId: string | null,
    actor: { userId: string | null; role?: string | null },
  ): Promise<AssignmentResult> {
    // campusId 缺失（异常合同）→ 无法按校区发牌，留待分配
    if (!campusId) {
      this.logger.warn(
        `assignStudentIfNeeded: contract has no campusId (student=${studentId}) → skip, leave unassigned`,
      );
      return { assigned: false, reason: 'empty_pool' };
    }

    // 事务内：锁配置行 + 读学员当前归属 + round-robin 推进
    const result = await this.pg.transaction<AssignmentResult>(
      async (client) => {
        // 1. 幂等：学员已有归属 → 直接 return（重复激活不重分）
        const stuRows = await client.query<PgRow>(
          `SELECT assigned_academic_id FROM students
            WHERE id = $1 AND deleted_at IS NULL`,
          [studentId],
        );
        if (stuRows.rows.length === 0) {
          // 学员不存在（异常）→ 不分配，不报错（激活是主流程，分配是 side-effect）
          this.logger.warn(
            `assignStudentIfNeeded: student ${studentId} not found → skip`,
          );
          return { assigned: false, reason: 'empty_pool' };
        }
        if (stuRows.rows[0].assigned_academic_id) {
          return {
            assigned: false,
            reason: 'already_assigned',
            academicId: stuRows.rows[0].assigned_academic_id,
          };
        }

        // 2. 锁配置行（FOR UPDATE）→ 防同校并发激活双发同一 academic
        //    无行 → auto=false（校长未开 → 不分配）
        const cfgRows = await client.query<PgRow>(
          `SELECT auto_assign_academic, rr_last_academic_id
             FROM campus_assignment_config
            WHERE campus_id = $1
            FOR UPDATE`,
          [campusId],
        );
        const autoOn =
          cfgRows.rows.length > 0 && cfgRows.rows[0].auto_assign_academic === true;
        if (!autoOn) {
          // 自动分配关 → 不分配，学员落待分配列表（校长手动派）
          return { assigned: false, reason: 'auto_off' };
        }
        const rrLast: string | null = cfgRows.rows[0].rr_last_academic_id ?? null;

        // 3. 取本校在职教务池（稳定排序 ORDER BY id 保证 round-robin 顺序确定）
        //    users.status 枚举为中文 '启用'/'停用'（V2 schema），不是 'active'
        const poolRows = await client.query<PgRow>(
          `SELECT id FROM users
            WHERE role = ANY($1::varchar[])
              AND campus_id = $2
              AND status = '启用'
              AND deleted_at IS NULL
            ORDER BY id ASC`,
          [ASSIGNMENT_POOL_ROLES as string[], campusId],
        );
        const pool: string[] = poolRows.rows.map((r) => r.id as string);
        if (pool.length === 0) {
          // 池空 → 留 NULL + warn 不报错（学员落待分配，校长手动兜）
          this.logger.warn(
            `assignStudentIfNeeded: empty academic pool for campus ${campusId} (student=${studentId}) → leave unassigned`,
          );
          return { assigned: false, reason: 'empty_pool' };
        }

        // 4. round-robin：找当前游标在池中的位置 → 取下一个（环绕）
        //    rrLast 为空 / 已不在池（离职）→ 从第一个开始
        const nextId = StudentAssignmentService.pickNext(pool, rrLast);

        // 5. set students.assigned_academic_id + 推进 config 游标（同事务）
        await client.query(
          `UPDATE students
              SET assigned_academic_id = $1, updated_at = NOW()
            WHERE id = $2 AND deleted_at IS NULL`,
          [nextId, studentId],
        );
        // upsert 游标（若 cfg 行已存在则只动游标 + updated_at；不改 auto 开关）
        await client.query(
          `INSERT INTO campus_assignment_config
             (campus_id, auto_assign_academic, rr_last_academic_id, updated_by, updated_at)
           VALUES ($1, true, $2, $3, NOW())
           ON CONFLICT (campus_id) DO UPDATE
             SET rr_last_academic_id = EXCLUDED.rr_last_academic_id,
                 updated_at = NOW()`,
          [campusId, nextId, actor.userId],
        );

        return { assigned: true, academicId: nextId };
      },
      { tenantSchema },
    );

    // 审计（事务外，fail-open）：仅在真分配时写 student.auto_assigned
    if (result.assigned && result.academicId) {
      await this.tryAudit(tenantSchema, {
        actorUserId: actor.userId,
        actorRole: StudentAssignmentService.normalizeRole(actor.role),
        action: 'student.auto_assigned',
        targetType: 'student',
        targetId: studentId,
        before: { assignedAcademicId: null },
        after: { assignedAcademicId: result.academicId, campusId },
      });
    }

    return result;
  }

  /**
   * round-robin 选下一个：找 rrLast 在 pool 中的索引 → (idx+1) % len 环绕。
   *   rrLast 为 null / 不在 pool（离职被移出池）→ 返回 pool[0]（从头）。
   *   pool 非空由调用方保证。
   *
   * static 纯函数 — 便于单测直接验证发牌顺序，不依赖 DB。
   */
  static pickNext(pool: string[], rrLast: string | null): string {
    if (!rrLast) return pool[0];
    const idx = pool.indexOf(rrLast);
    if (idx === -1) return pool[0]; // 游标指向已离职教务 → 从头
    return pool[(idx + 1) % pool.length];
  }

  /**
   * role → ActorRole（audit_log CHECK 白名单）。
   *   未知 role 兜 'system'（激活通常由 finance 触发；保守不抛）。
   */
  private static normalizeRole(role?: string | null): ActorRole {
    const r = (role ?? '').toLowerCase();
    const valid: ActorRole[] = [
      'admin', 'boss', 'sales', 'sales_manager', 'sales_director',
      'academic', 'academic_admin', 'edu_admin', 'ops',
      'teacher', 'finance', 'hr', 'parent', 'platform_admin', 'system',
    ];
    return (valid as string[]).includes(r) ? (r as ActorRole) : 'system';
  }

  /**
   * 写 audit_log，fail-open（不阻塞主业务；@Global 恒注入，undefined 仅单测/错配）。
   */
  private async tryAudit(
    tenantSchema: string,
    entry: {
      actorUserId: string | null;
      actorRole: ActorRole;
      action: string;
      targetType: string;
      targetId: string | null;
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
    },
  ): Promise<void> {
    if (!this.auditLog) {
      this.logger.warn(
        `audit log repo not injected, skipping audit for ${entry.action} (target=${entry.targetId})`,
      );
      return;
    }
    try {
      await this.auditLog.log(tenantSchema, entry);
    } catch {
      // fail-open
    }
  }
}
