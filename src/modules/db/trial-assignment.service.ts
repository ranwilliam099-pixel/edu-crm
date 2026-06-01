import { Injectable, Logger, Optional } from '@nestjs/common';
import { PgPoolService, PgRow } from './pg-pool.service';
import { AuditLogRepository, ActorRole } from './audit-log.repository';
import {
  StudentAssignmentService,
  ASSIGNMENT_POOL_ROLES,
} from './student-assignment.service';

/**
 * TrialAssignmentService — V64 (Phase 4) 试听→教务分配机制
 *
 * 来源：../edu-mp-sandbox/docs/2026-06-01-业务链方案-试听激活分配反馈.md Phase 4（#9）
 *
 * 业务（用户拍板「试听同样走校长是否自动分配教务逻辑」）：
 *   销售发起试听后触发分配。**复用 Phase 3 的 campus_assignment_config**：
 *     同一开关 auto_assign_academic（校长开/关，与学员激活分配共用一个开关）；
 *     auto ON → round-robin 发牌给本校在职 academic + status='pending_teacher' + audit；
 *     auto OFF → 留 status='pending_assign'（校长手动派）。
 *
 * ★ 游标决策（V64 schema 权威 + prompt 拍板）：
 *   V64 **不含**独立试听游标列（campus_assignment_config 仅有 rr_last_academic_id 一列，
 *   且 prompt 明确「V64 不含该列 → 改为 trial 分配也用 rr_last_academic_id 同游标」）。
 *   故本服务**复用 Phase 3 同一行同一 rr_last_academic_id 游标** —— 学员分配与试听分配
 *   在同一校区共享一个 round-robin 指针，交替推进（A→B→C 跨两条业务线连续轮转）。
 *   语义：教务负载在「学员 + 试听」两类工作上整体轮转均衡，符合「同一池子轮流接活」。
 *   若未来要两线独立游标 → V64 加列 rr_last_trial_academic_id（本服务改读/写该列一处即可）。
 *
 * 复用 Phase 3 资产（避免复制）：
 *   - StudentAssignmentService.pickNext（static 纯函数，发牌顺序）
 *   - ASSIGNMENT_POOL_ROLES（默认仅 academic；改池一处生效两线）
 *
 * 设计要点（与 StudentAssignmentService 对齐）：
 *   - 幂等：试听已有 assigned_academic_id（非 NULL）→ 直接 return，不重分。
 *   - 并发安全：事务内 SELECT campus_assignment_config FOR UPDATE 锁配置行。
 *   - 池空：不报错，留 NULL + warn（试听落待分配，校长手动兜）。
 *   - 自动分配审计：action='trial.auto_assigned'。
 */

export interface TrialAssignmentResult {
  assigned: boolean;
  academicId?: string;
  reason?: 'already_assigned' | 'auto_off' | 'empty_pool';
}

@Injectable()
export class TrialAssignmentService {
  private readonly logger = new Logger(TrialAssignmentService.name);

  constructor(
    private readonly pg: PgPoolService,
    @Optional() private readonly auditLog?: AuditLogRepository,
  ) {}

  /**
   * 试听创建后触发：按校区配置决定是否 round-robin 发牌给本校教务。
   *
   * @param tenantSchema  租户 schema（tenant_xxx）
   * @param trialId       试听 id
   * @param campusId      试听校区（分配池/游标按校区隔离）
   * @param actor         触发者（发起销售；记入 audit + config.updated_by）
   *
   * 失败语义：内部逻辑不抛业务错（事务异常会抛 → 调用方包 try/catch fail-open）。
   */
  async assignTrialIfNeeded(
    tenantSchema: string,
    trialId: string,
    campusId: string | null,
    actor: { userId: string | null; role?: string | null },
  ): Promise<TrialAssignmentResult> {
    if (!campusId) {
      this.logger.warn(
        `assignTrialIfNeeded: trial has no campusId (trial=${trialId}) → skip, leave unassigned`,
      );
      return { assigned: false, reason: 'empty_pool' };
    }

    const result = await this.pg.transaction<TrialAssignmentResult>(
      async (client) => {
        // 1. 幂等：试听已有归属 → 直接 return（重复触发不重分）
        const trialRows = await client.query<PgRow>(
          `SELECT assigned_academic_id FROM trials WHERE id = $1`,
          [trialId],
        );
        if (trialRows.rows.length === 0) {
          this.logger.warn(
            `assignTrialIfNeeded: trial ${trialId} not found → skip`,
          );
          return { assigned: false, reason: 'empty_pool' };
        }
        if (trialRows.rows[0].assigned_academic_id) {
          return {
            assigned: false,
            reason: 'already_assigned',
            academicId: trialRows.rows[0].assigned_academic_id,
          };
        }

        // 2. 锁配置行（FOR UPDATE）→ 防同校并发分配双发同一 academic（学员/试听共享此锁）
        const cfgRows = await client.query<PgRow>(
          `SELECT auto_assign_academic, rr_last_academic_id
             FROM campus_assignment_config
            WHERE campus_id = $1
            FOR UPDATE`,
          [campusId],
        );
        const autoOn =
          cfgRows.rows.length > 0 &&
          cfgRows.rows[0].auto_assign_academic === true;
        if (!autoOn) {
          return { assigned: false, reason: 'auto_off' };
        }
        const rrLast: string | null =
          cfgRows.rows[0].rr_last_academic_id ?? null;

        // 3. 取本校在职教务池（ORDER BY id 稳定 round-robin 顺序）
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
          this.logger.warn(
            `assignTrialIfNeeded: empty academic pool for campus ${campusId} (trial=${trialId}) → leave unassigned`,
          );
          return { assigned: false, reason: 'empty_pool' };
        }

        // 4. round-robin（复用 Phase 3 同一纯函数）
        const nextId = StudentAssignmentService.pickNext(pool, rrLast);

        // 5. set trials.assigned_academic_id + status='pending_teacher' + 推进共享游标（同事务）
        await client.query(
          `UPDATE trials
              SET assigned_academic_id = $1, status = 'pending_teacher', updated_at = NOW()
            WHERE id = $2 AND status = 'pending_assign'`,
          [nextId, trialId],
        );
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

    // 审计（事务外，fail-open）：仅真分配写 trial.auto_assigned
    if (result.assigned && result.academicId) {
      await this.tryAudit(tenantSchema, {
        actorUserId: actor.userId,
        actorRole: TrialAssignmentService.normalizeRole(actor.role),
        action: 'trial.auto_assigned',
        targetType: 'trial',
        targetId: trialId,
        before: { assignedAcademicId: null },
        after: { assignedAcademicId: result.academicId, campusId },
      });
    }

    return result;
  }

  private static normalizeRole(role?: string | null): ActorRole {
    const r = (role ?? '').toLowerCase();
    const valid: ActorRole[] = [
      'admin', 'boss', 'sales', 'sales_manager', 'sales_director',
      'academic', 'academic_admin', 'edu_admin', 'ops',
      'teacher', 'finance', 'hr', 'parent', 'platform_admin', 'system',
    ];
    return (valid as string[]).includes(r) ? (r as ActorRole) : 'system';
  }

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
