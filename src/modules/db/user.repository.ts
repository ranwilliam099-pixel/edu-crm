import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PgPoolService, PgRow } from './pg-pool.service';

/**
 * UserRepository — V27 员工离职 + 数据交接
 *
 * 来源：用户 2026-05-07
 *   「员工离职，取消账户权限之后自动转到校长名下，校长可以一键将
 *    离职人员的数据包转到其他人员跟进，或者自己跟进」
 *   「跨校区也当作离职处理」
 *
 * 核心方法：
 *   - findById                  查 user
 *   - listInactiveWithPending   校长视角：哪些离职人员仍有 owner 是他们的客户/签约
 *   - findTransferTarget        V10 拍板的接棒人解析（5 分支）
 *   - deactivate                离职动作：UPDATE status + 自动转交 + 留痕（事务）
 *   - handover                  校长二次手动转交（批量 / 全量 / 单选）
 */

export interface User {
  id: string;
  name: string;
  mobile: string;
  role: TenantRole;
  campusId: string;
  status: '启用' | '停用';
  createdAt: string;
  updatedAt: string;
}

export type TenantRole =
  | 'sales' | 'sales_manager' | 'sales_director'
  | 'marketing' | 'finance' | 'boss' | 'admin' | 'hr';

export interface InactiveWithPending {
  user: User;
  pendingOpportunities: number;
  pendingContracts: number;
  pendingStudents: number;
}

export interface DeactivateResult {
  user: User;
  transferToUserId: string | null;
  transferToUserLabel: string;
  opportunitiesMoved: number;
  contractsMoved: number;
  studentsMoved: number;
  reason: '离职转交';
}

export interface HandoverResult {
  fromUserId: string;
  toUserId: string | null;
  opportunitiesMoved: number;
  contractsMoved: number;
  studentsMoved: number;
  reason: '校长再分配' | '主动认领';
}

const CROSS_CAMPUS_ROLES: ReadonlyArray<TenantRole> = ['admin', 'sales_director', 'hr'];

function isCrossCampus(role: TenantRole): boolean {
  return (CROSS_CAMPUS_ROLES as readonly string[]).includes(role);
}

/**
 * V28 R2 离职 RBAC 边界矩阵（用户 2026-05-07「老板也可以同样处理校长」+ 边界精化）
 *
 * | 操作者 | 可注销目标 |
 * |---|---|
 * | admin（老板）   | 任何 user（含 boss / 其他 admin / 跨校）|
 * | boss（校长）    | 同 campus 的 sales / sales_manager / marketing / finance |
 * | hr（人事）      | 同租户的 sales / sales_manager / marketing / finance / boss（不含 admin）|
 * | 其他 role      | 不能调用 deactivate（controller 层 RBAC 已挡，本层兜底）|
 *
 * 任何人不能离职自己（controller 层已校验，本层兜底）。
 *
 * @throws BadRequestException 当操作越权
 */
function assertCanDeactivate(
  operator: { userId: string; role: TenantRole | string; campusId: string | null },
  target: User,
): void {
  if (operator.userId === target.id) {
    throw new BadRequestException('不能自己离职自己');
  }
  switch (operator.role) {
    case 'admin':
      // 老板：任意目标
      return;
    case 'boss': {
      const allowedTargets: TenantRole[] = ['sales', 'sales_manager', 'marketing', 'finance'];
      if (!allowedTargets.includes(target.role)) {
        throw new BadRequestException(
          `校长（boss）仅能注销 sales/sales_manager/marketing/finance（target.role=${target.role}）`,
        );
      }
      if (operator.campusId && target.campusId !== operator.campusId) {
        throw new BadRequestException(
          `校长（boss）仅能注销同校区员工（operator=${operator.campusId} / target=${target.campusId}）`,
        );
      }
      return;
    }
    case 'hr': {
      const allowedTargets: TenantRole[] = [
        'sales', 'sales_manager', 'sales_director',
        'marketing', 'finance', 'boss',
      ];
      if (!allowedTargets.includes(target.role)) {
        throw new BadRequestException(
          `人事（hr）不能注销 ${target.role}（admin / hr 等高管由老板决策）`,
        );
      }
      return;
    }
    default:
      throw new BadRequestException(`role=${operator.role} 无离职操作权限`);
  }
}

/**
 * 32-char ULID 简单生成（不引第三方依赖；与项目其他位置一致风格）
 */
function ulid32(): string {
  const t = Date.now().toString(36).padStart(10, '0');
  let rand = '';
  while (rand.length < 22) {
    rand += Math.random().toString(36).slice(2);
  }
  return (t + rand).slice(0, 32);
}

@Injectable()
export class UserRepository {
  constructor(private readonly pg: PgPoolService) {}

  static mapRow(r: PgRow): User {
    return {
      id: r.id,
      name: r.name,
      mobile: r.mobile,
      role: r.role as TenantRole,
      campusId: r.campus_id,
      status: r.status as '启用' | '停用',
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
    };
  }

  /**
   * 列出 active 用户（toUser 选择器用）
   * - 可选 role 过滤（如 ['boss','sales','sales_manager']）
   * - 可选 campusId 过滤（同校区）
   */
  async listActive(
    tenantSchema: string,
    options: { roles?: TenantRole[]; campusId?: string } = {},
  ): Promise<User[]> {
    const where: string[] = [`status = '启用'`];
    const params: any[] = [];
    if (options.roles && options.roles.length > 0) {
      params.push(options.roles);
      where.push(`role = ANY($${params.length}::varchar[])`);
    }
    if (options.campusId) {
      params.push(options.campusId);
      where.push(`campus_id = $${params.length}`);
    }
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT * FROM users
         WHERE ${where.join(' AND ')}
         ORDER BY role, name`,
      params,
    );
    return rows.map((r) => UserRepository.mapRow(r));
  }

  /**
   * 列出 active 但名下有 opportunities/contracts 的用户（校长「主动转交」起点选择器）
   */
  async listActiveWithData(tenantSchema: string): Promise<InactiveWithPending[]> {
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT u.*,
              (SELECT COUNT(*) FROM opportunities o WHERE o.owner_user_id = u.id) AS pending_opps,
              (SELECT COUNT(*) FROM contracts c
                 WHERE c.owner_user_id = u.id
                   AND c.status IN ('pending','active')
                   AND c.deleted_at IS NULL) AS pending_contracts,
              (SELECT COUNT(*) FROM students s WHERE s.owner_sales_id = u.id) AS pending_students
         FROM users u
         WHERE u.status = '启用'
         ORDER BY u.role, u.name`,
    );
    return rows
      .map((r) => ({
        user: UserRepository.mapRow(r),
        pendingOpportunities: parseInt(r.pending_opps || '0', 10),
        pendingContracts: parseInt(r.pending_contracts || '0', 10),
        pendingStudents: parseInt(r.pending_students || '0', 10),
      }))
      .filter((x) => x.pendingOpportunities + x.pendingContracts + x.pendingStudents > 0);
  }

  async findById(tenantSchema: string, id: string): Promise<User | null> {
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT * FROM users WHERE id = $1`,
      [id],
    );
    return rows.length === 0 ? null : UserRepository.mapRow(rows[0]);
  }

  /**
   * 校长视角：返回所有「停用」状态但 opportunities/contracts 中仍有 owner 是他们的用户。
   * 即「待交接」清单（自动转交后理论上 owner 已经不是他们了，所以这里应为空；
   * 但若兜底无人接 → owner=NULL，此查询用于校验是否有「孤儿数据」需要校长再分配）。
   *
   * 实际更有用的查询是「列出校长名下从离职人员转交来的数据包」 — 见 listHandoverInbox()
   */
  async listInactiveWithPending(tenantSchema: string): Promise<InactiveWithPending[]> {
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT u.*,
              (SELECT COUNT(*) FROM opportunities o WHERE o.owner_user_id = u.id) AS pending_opps,
              (SELECT COUNT(*) FROM contracts c
                 WHERE c.owner_user_id = u.id
                   AND c.status IN ('pending','active')
                   AND c.deleted_at IS NULL) AS pending_contracts,
              (SELECT COUNT(*) FROM students s WHERE s.owner_sales_id = u.id) AS pending_students
         FROM users u
         WHERE u.status = '停用'
         ORDER BY u.updated_at DESC`,
    );
    return rows
      .map((r) => ({
        user: UserRepository.mapRow(r),
        pendingOpportunities: parseInt(r.pending_opps || '0', 10),
        pendingContracts: parseInt(r.pending_contracts || '0', 10),
        pendingStudents: parseInt(r.pending_students || '0', 10),
      }))
      .filter((x) => x.pendingOpportunities + x.pendingContracts + x.pendingStudents > 0);
  }

  /**
   * V10 拍板的接棒人解析（5 分支）：
   *
   * 1. 单校 role（sales/sales_manager/marketing/finance）→ 同 campus 的 active boss
   * 2. boss 离职                                         → 该租户任一 active admin
   * 3. 跨校 role 离职 (sales_director / hr)              → 该租户任一 active admin
   * 4. admin 离职                                        → 该租户任一 active boss
   * 5. 全部分支兜底找不到 → null（owner 改 NULL，前端展示「待校长认领」）
   */
  async findTransferTarget(
    tenantSchema: string,
    leaver: User,
  ): Promise<User | null> {
    // 分支 1：单校 role → 同校区 boss
    if (
      leaver.role === 'sales' ||
      leaver.role === 'sales_manager' ||
      leaver.role === 'marketing' ||
      leaver.role === 'finance'
    ) {
      const rows = await this.pg.tenantQuery<PgRow>(
        tenantSchema,
        `SELECT * FROM users
           WHERE role = 'boss' AND campus_id = $1 AND status = '启用'
           ORDER BY created_at ASC LIMIT 1`,
        [leaver.campusId],
      );
      if (rows.length > 0) return UserRepository.mapRow(rows[0]);
      // 同校区无 boss → 走兜底（admin）
    }

    // 分支 2/3：boss 离职 / 跨校 role (sales_director, hr) 离职 → 任一 admin
    if (leaver.role === 'boss' || leaver.role === 'sales_director' || leaver.role === 'hr') {
      const rows = await this.pg.tenantQuery<PgRow>(
        tenantSchema,
        `SELECT * FROM users
           WHERE role = 'admin' AND status = '启用'
           ORDER BY created_at ASC LIMIT 1`,
      );
      if (rows.length > 0) return UserRepository.mapRow(rows[0]);
    }

    // 分支 4：admin 离职 → 任一 active boss
    if (leaver.role === 'admin') {
      const rows = await this.pg.tenantQuery<PgRow>(
        tenantSchema,
        `SELECT * FROM users
           WHERE role = 'boss' AND status = '启用'
           ORDER BY created_at ASC LIMIT 1`,
      );
      if (rows.length > 0) return UserRepository.mapRow(rows[0]);
    }

    // 兜底：单校 role 同校无 boss 或上面所有分支都空 → 任一 active admin（再次尝试）
    {
      const rows = await this.pg.tenantQuery<PgRow>(
        tenantSchema,
        `SELECT * FROM users
           WHERE role = 'admin' AND status = '启用'
           ORDER BY created_at ASC LIMIT 1`,
      );
      if (rows.length > 0) return UserRepository.mapRow(rows[0]);
    }

    // 分支 5：全部找不到 → null（数据 owner 改 NULL，前端「待认领」标记）
    return null;
  }

  /**
   * 离职动作：事务内 UPDATE users.status + 自动转交 owner_user_id + 留痕。
   *
   * 幂等性：若 user 已 '停用' → 抛 BadRequestException
   * 操作者审计：operatorUserId / operatorLabel 用于 follow_log 留痕
   */
  async deactivate(
    tenantSchema: string,
    leaverUserId: string,
    operator: { userId: string; label: string; role: TenantRole | string; campusId: string | null },
  ): Promise<DeactivateResult> {
    const leaver = await this.findById(tenantSchema, leaverUserId);
    if (!leaver) throw new NotFoundException(`user ${leaverUserId} not found`);
    if (leaver.status === '停用') {
      throw new BadRequestException(`user ${leaverUserId} 已离职 (status=停用)`);
    }
    // V28 R2 RBAC 边界（admin 任意 / boss 同校单校组 / hr 单校组+boss）
    assertCanDeactivate(operator, leaver);
    const target = await this.findTransferTarget(tenantSchema, leaver);
    const targetId = target ? target.id : null;
    const targetLabel = target ? `${target.name}（${target.role === 'boss' ? '校长' : target.role === 'admin' ? '老板' : target.role}）` : '无人接（待认领）';
    const reason = '离职转交';

    return this.pg.transaction(
      async (client) => {
        // 1. user 标停用
        const userRows = await client.query<PgRow>(
          `UPDATE users SET status = '停用', updated_at = NOW(), updated_by = $2
             WHERE id = $1 AND status = '启用'
           RETURNING *`,
          [leaverUserId, operator.userId],
        );
        if (userRows.rowCount === 0) {
          throw new BadRequestException(
            `user ${leaverUserId} 状态变更失败（可能并发已离职）`,
          );
        }

        // 2. opportunities owner 批量转交
        const oppsRes = await client.query<{ id: string }>(
          `UPDATE opportunities
              SET owner_user_id = $2,
                  owner_changed_at = NOW(),
                  owner_change_reason = $3
            WHERE owner_user_id = $1
            RETURNING id`,
          [leaverUserId, targetId, reason],
        );

        // 3. contracts owner 批量转交（仅 pending/active；cancelled/expired 不动，业绩归属冻结）
        const contractsRes = await client.query<{ id: string }>(
          `UPDATE contracts
              SET owner_user_id = $2,
                  owner_changed_at = NOW(),
                  owner_change_reason = $3
            WHERE owner_user_id = $1
              AND status IN ('pending','active')
              AND deleted_at IS NULL
            RETURNING id`,
          [leaverUserId, targetId, reason],
        );

        // 3b. V28 students.owner_sales_id 联动转交
        const studentsRes = await client.query<{ id: string }>(
          `UPDATE students
              SET owner_sales_id = $2,
                  owner_changed_at = NOW(),
                  owner_change_reason = $3
            WHERE owner_sales_id = $1
            RETURNING id`,
          [leaverUserId, targetId, reason],
        );

        // 4. 每个 opportunity 留痕（customer_follow_log）
        for (const row of oppsRes.rows) {
          await client.query(
            `INSERT INTO customer_follow_log
               (id, opportunity_id, follow_type, label, by_user_id, by_label, extra_json)
             VALUES ($1, $2, 'transferred', $3, $4, $5, $6::jsonb)`,
            [
              ulid32(),
              row.id,
              `离职转交：${leaver.name} → ${targetLabel}`,
              operator.userId,
              operator.label,
              JSON.stringify({
                fromUserId: leaverUserId,
                toUserId: targetId,
                reason,
              }),
            ],
          );
        }

        return {
          user: UserRepository.mapRow(userRows.rows[0]),
          transferToUserId: targetId,
          transferToUserLabel: targetLabel,
          opportunitiesMoved: oppsRes.rowCount || 0,
          contractsMoved: contractsRes.rowCount || 0,
          studentsMoved: studentsRes.rowCount || 0,
          reason,
        };
      },
      { tenantSchema },
    );
  }

  /**
   * 校长二次手动转交：
   *   - scope='all'              → 把 fromUser 名下所有 opportunities + contracts 转给 toUser
   *   - scope='select'           → 仅转 opportunityIds + contractIds 列出的（精确多选）
   *   - toUserId === operator.userId → reason='主动认领'，否则 '校长再分配'
   *   - toUserId === null        → 退回池（owner 改 NULL）
   */
  async handover(
    tenantSchema: string,
    payload: {
      fromUserId: string;
      toUserId: string | null;
      scope: 'all' | 'select';
      opportunityIds?: string[];
      contractIds?: string[];
      operator: {
        userId: string;
        label: string;
        role?: TenantRole | string;
        campusId?: string | null;
      };
    },
  ): Promise<HandoverResult> {
    const { fromUserId, toUserId, scope, operator } = payload;
    if (fromUserId === toUserId) {
      throw new BadRequestException('fromUserId 与 toUserId 相同（无须转交）');
    }
    if (scope === 'select') {
      if (
        (!payload.opportunityIds || payload.opportunityIds.length === 0) &&
        (!payload.contractIds || payload.contractIds.length === 0)
      ) {
        throw new BadRequestException('scope=select 必须至少传 opportunityIds 或 contractIds');
      }
    }
    let toUserLabel = '退回池（无 owner）';
    if (toUserId) {
      const toUser = await this.findById(tenantSchema, toUserId);
      if (!toUser) throw new NotFoundException(`toUserId ${toUserId} not found`);
      if (toUser.status !== '启用') {
        throw new BadRequestException(`toUserId ${toUserId} 已停用，不能接棒`);
      }
      toUserLabel = `${toUser.name}（${toUser.role === 'boss' ? '校长' : toUser.role === 'admin' ? '老板' : toUser.role}）`;
    }
    const reason: '校长再分配' | '主动认领' =
      toUserId === operator.userId ? '主动认领' : '校长再分配';

    return this.pg.transaction(
      async (client) => {
        let oppsRes: { rows: { id: string }[]; rowCount: number | null };
        let contractsRes: { rows: { id: string }[]; rowCount: number | null };
        let studentsRes: { rows: { id: string }[]; rowCount: number | null };
        if (scope === 'all') {
          oppsRes = await client.query<{ id: string }>(
            `UPDATE opportunities
                SET owner_user_id = $2,
                    owner_changed_at = NOW(),
                    owner_change_reason = $3
              WHERE owner_user_id = $1
              RETURNING id`,
            [fromUserId, toUserId, reason],
          );
          contractsRes = await client.query<{ id: string }>(
            `UPDATE contracts
                SET owner_user_id = $2,
                    owner_changed_at = NOW(),
                    owner_change_reason = $3
              WHERE owner_user_id = $1
                AND status IN ('pending','active')
                AND deleted_at IS NULL
              RETURNING id`,
            [fromUserId, toUserId, reason],
          );
          // V28 students.owner_sales_id 联动转交
          studentsRes = await client.query<{ id: string }>(
            `UPDATE students
                SET owner_sales_id = $2,
                    owner_changed_at = NOW(),
                    owner_change_reason = $3
              WHERE owner_sales_id = $1
              RETURNING id`,
            [fromUserId, toUserId, reason],
          );
        } else {
          // scope='select'
          const oppIds = payload.opportunityIds || [];
          const conIds = payload.contractIds || [];
          oppsRes = oppIds.length === 0
            ? { rows: [], rowCount: 0 }
            : await client.query<{ id: string }>(
                `UPDATE opportunities
                    SET owner_user_id = $2,
                        owner_changed_at = NOW(),
                        owner_change_reason = $3
                  WHERE owner_user_id = $1 AND id = ANY($4::varchar[])
                  RETURNING id`,
                [fromUserId, toUserId, reason, oppIds],
              );
          contractsRes = conIds.length === 0
            ? { rows: [], rowCount: 0 }
            : await client.query<{ id: string }>(
                `UPDATE contracts
                    SET owner_user_id = $2,
                        owner_changed_at = NOW(),
                        owner_change_reason = $3
                  WHERE owner_user_id = $1 AND id = ANY($4::varchar[])
                    AND status IN ('pending','active')
                    AND deleted_at IS NULL
                  RETURNING id`,
                [fromUserId, toUserId, reason, conIds],
              );
          // scope=select 不转 students（精确多选语义只针对 opp/contract；学生用 student-transfer endpoint 单独转）
          studentsRes = { rows: [], rowCount: 0 };
        }

        // 留痕
        for (const row of oppsRes.rows) {
          await client.query(
            `INSERT INTO customer_follow_log
               (id, opportunity_id, follow_type, label, by_user_id, by_label, extra_json)
             VALUES ($1, $2, 'transferred', $3, $4, $5, $6::jsonb)`,
            [
              ulid32(),
              row.id,
              `${reason}：${fromUserId.slice(0, 6)} → ${toUserLabel}`,
              operator.userId,
              operator.label,
              JSON.stringify({
                fromUserId,
                toUserId,
                reason,
                scope,
              }),
            ],
          );
        }

        return {
          fromUserId,
          toUserId,
          opportunitiesMoved: oppsRes.rowCount || 0,
          contractsMoved: contractsRes.rowCount || 0,
          studentsMoved: studentsRes.rowCount || 0,
          reason,
        };
      },
      { tenantSchema },
    );
  }
}
