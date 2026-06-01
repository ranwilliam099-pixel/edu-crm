import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
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

// 5/15 A-2 拍板：应用层 7 枚举（删 sales_director — 不在拍板权威角色清单）
//   注：V2 schema CHECK 仍 8 枚举（保留历史兼容），本地 TenantRole 仅用于应用层校验
//   findTransferTarget 仍保留 sales_director 分支以处理历史 row（如真有此类用户离职）
export type TenantRole =
  | 'sales' | 'sales_manager'
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

// 5/15 A-2：删 'sales_director'（与 jwt-payload.interface.ts CROSS_CAMPUS_ROLES 对齐）
const CROSS_CAMPUS_ROLES: ReadonlyArray<TenantRole> = ['admin', 'hr'];

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
      // 5/15 A-2：allowedTargets 删 sales_director
      const allowedTargets: TenantRole[] = [
        'sales', 'sales_manager',
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
   * V44: deleted_at IS NULL 排除已软删（status='启用' + 未软删 = 真正可选接棒人）
   */
  async listActive(
    tenantSchema: string,
    options: { roles?: TenantRole[]; campusId?: string } = {},
  ): Promise<User[]> {
    const where: string[] = [`status = '启用'`, `deleted_at IS NULL`];
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
   * V63 (Phase 3) 列本校在职「教务」（academic）— 校长手动分配学员的教务选择器。
   *   注：本地 listActive 的 TenantRole 是 7-enum（不含 academic），故单独裸 role 字符串查询。
   *   status='启用'（V2 schema 中文枚举）+ deleted_at IS NULL = 真正可分配的在职教务。
   *   ⚠️ 池角色（是否含 academic_admin）见 StudentAssignmentService.ASSIGNMENT_POOL_ROLES；
   *      此选择器与发牌池保持一致（默认仅 academic）。
   */
  async listActiveAcademicsInCampus(
    tenantSchema: string,
    campusId: string,
    roles: readonly string[] = ['academic'],
  ): Promise<Array<{ id: string; name: string; role: string }>> {
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT id, name, role FROM users
        WHERE role = ANY($1::varchar[])
          AND campus_id = $2
          AND status = '启用'
          AND deleted_at IS NULL
        ORDER BY id ASC`,
      [roles as string[], campusId],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, role: r.role }));
  }

  /**
   * V63 (Phase 3) 校验某 user 是本校在职 academic（手动分配前校验目标教务合法）。
   *   返回 true 仅当：存在 + role ∈ roles + campus_id=campusId + status='启用' + 未软删。
   */
  async isActiveAcademicInCampus(
    tenantSchema: string,
    userId: string,
    campusId: string,
    roles: readonly string[] = ['academic'],
  ): Promise<boolean> {
    const rows = await this.pg.tenantQuery<{ ok: number }>(
      tenantSchema,
      `SELECT 1 AS ok FROM users
        WHERE id = $1
          AND role = ANY($2::varchar[])
          AND campus_id = $3
          AND status = '启用'
          AND deleted_at IS NULL
        LIMIT 1`,
      [userId, roles as string[], campusId],
    );
    return rows.length > 0;
  }

  /**
   * 列出 active 但名下有 opportunities/contracts 的用户（校长「主动转交」起点选择器）
   * V44: u.deleted_at IS NULL + s.deleted_at IS NULL（学员子查询同步排除软删）
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
              (SELECT COUNT(*) FROM students s
                 WHERE s.owner_sales_id = u.id
                   AND s.deleted_at IS NULL) AS pending_students
         FROM users u
         WHERE u.status = '启用'
           AND u.deleted_at IS NULL
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

  /**
   * V44: deleted_at IS NULL 排除已软删
   * 已软删用户 findById 返回 null，等同于 NotFound（含 deactivate 路径的幂等保护）
   */
  async findById(tenantSchema: string, id: string): Promise<User | null> {
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return rows.length === 0 ? null : UserRepository.mapRow(rows[0]);
  }

  /**
   * 按 mobile 反查 user (Sprint X.2 — 同 tenant 内 phone 唯一性 pre-check)
   * V44: deleted_at IS NULL 排除已软删
   * V2 schema users.mobile UNIQUE → 最多 1 row
   */
  async findByMobile(tenantSchema: string, mobile: string): Promise<User | null> {
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT * FROM users WHERE mobile = $1 AND deleted_at IS NULL`,
      [mobile],
    );
    return rows.length === 0 ? null : UserRepository.mapRow(rows[0]);
  }

  /**
   * Sprint X.2 (2026-05-17) — admin 创建 B 端子账户
   *
   * 来源：
   *   - SSOT §12.4 admin 唯一创建权 + bcrypt cost=12 初始密码
   *   - 用户拍板 D2 admin 手动设密码 + modal 显示一次
   *
   * 入参 passwordHash 已由 controller 层 PasswordHasher.hash 算好（cost=12）
   *   service 层不算 hash，因 hash 计算 ~250ms 会延迟事务提交
   *
   * 校验：
   *   - 应用层 mobile UNIQUE pre-check 由 controller 跨表反查 (PhoneLookupService)
   *   - DB 层 mobile UNIQUE (V2 schema) 兜底; 命中 → throw ConflictException
   *
   * audit_log 在 controller 层写 (本 repo 仅返 INSERT 结果)
   */
  async createUser(
    tenantSchema: string,
    input: {
      id: string;
      name: string;
      mobile: string;
      // Sprint X.2: role 接受 10-enum B 端 role (jwt-payload.interface.ts TenantRole)
      //   本 repo 局部 TenantRole 是 7-enum (deactivate cohort), 拓宽为 string + DB CHECK 兜底
      role: string;
      campusId: string | null;
      passwordHash: string;
      createdBy: string;
    },
  ): Promise<User> {
    if (!input.id || input.id.length !== 32) {
      throw new BadRequestException('user id must be 32-char ULID');
    }
    if (!input.passwordHash || input.passwordHash.length !== 60) {
      throw new BadRequestException(
        'passwordHash must be 60-char bcrypt hash ($2b$12$...)',
      );
    }
    // V2 schema users.campus_id NOT NULL → 跨校 role 也必须填一个 campusId
    //   admin 创建 B-user 时, controller 兜底 (跨校 admin 用主校区 campusId)
    if (!input.campusId || input.campusId.length !== 32) {
      throw new BadRequestException('campusId must be 32-char ULID');
    }
    try {
      const rows = await this.pg.tenantQuery<PgRow>(
        tenantSchema,
        `INSERT INTO users
           (id, name, mobile, role, campus_id, status,
            password_hash, password_updated_at, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, '启用', $6, NOW(), $7, $7)
         RETURNING *`,
        [
          input.id,
          input.name,
          input.mobile,
          input.role,
          input.campusId,
          input.passwordHash,
          input.createdBy,
        ],
      );
      return UserRepository.mapRow(rows[0]);
    } catch (err) {
      // V2 schema users.mobile UNIQUE 兜底 (PG duplicate_key error 23505)
      const e = err as { code?: string; constraint?: string };
      if (e.code === '23505') {
        throw new ConflictException(
          `USER_MOBILE_DUPLICATE: 该手机号已在本机构注册`,
        );
      }
      throw err;
    }
  }

  /**
   * Sprint X.2 round 11 (2026-05-18) — 重置员工密码
   *   admin 在员工管理页点「重置密码」→ 把 password_hash 设为 bcrypt(默认密码)
   *   触发 JWT 黑名单让员工旧 token 立即失效
   *   返回 user 行让 controller audit_log
   */
  async resetPassword(
    tenantSchema: string,
    userId: string,
    passwordHash: string,
  ): Promise<User | null> {
    if (!userId || userId.length !== 32) {
      throw new BadRequestException('userId must be 32-char ULID');
    }
    if (!passwordHash || passwordHash.length !== 60) {
      throw new BadRequestException(
        'passwordHash must be 60-char bcrypt hash ($2b$12$...)',
      );
    }
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `UPDATE users
       SET password_hash = $1,
           password_updated_at = NOW(),
           updated_at = NOW()
       WHERE id = $2 AND deleted_at IS NULL
       RETURNING *`,
      [passwordHash, userId],
    );
    return rows[0] ? UserRepository.mapRow(rows[0]) : null;
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
   * 3. 跨校 role 离职 (hr / 历史 sales_director)         → 该租户任一 active admin
   * 4. admin 离职                                        → 该租户任一 active boss
   * 5. 全部分支兜底找不到 → null（owner 改 NULL，前端展示「待校长认领」）
   *
   * 5/15 A-2 历史兼容：分支 3 保留 `sales_director` 字符串比对（leaver.role 来自 DB 行，
   *   V2 schema CHECK 仍允许 sales_director 历史值；如生产真有此类用户被标记离职，仍能
   *   正确转交给 admin）。TenantRole TS 类型已删 sales_director，故用字符串比对 + 注释说明。
   */
  async findTransferTarget(
    tenantSchema: string,
    leaver: User,
  ): Promise<User | null> {
    // 分支 1：单校 role → 同校区 boss
    // V44: deleted_at IS NULL 排除已软删（不能转交给已删用户）
    if (
      leaver.role === 'sales' ||
      leaver.role === 'sales_manager' ||
      leaver.role === 'marketing' ||
      leaver.role === 'finance'
    ) {
      const rows = await this.pg.tenantQuery<PgRow>(
        tenantSchema,
        `SELECT * FROM users
           WHERE role = 'boss' AND campus_id = $1 AND status = '启用' AND deleted_at IS NULL
           ORDER BY created_at ASC LIMIT 1`,
        [leaver.campusId],
      );
      if (rows.length > 0) return UserRepository.mapRow(rows[0]);
      // 同校区无 boss → 走兜底（admin）
    }

    // 分支 2/3：boss 离职 / 跨校 role (hr / 历史 sales_director) 离职 → 任一 admin
    //   5/15 A-2：sales_director 应用层已删，但 schema 历史数据可能仍存在 → 字符串比对兜底
    if (
      leaver.role === 'boss' ||
      (leaver.role as string) === 'sales_director' ||
      leaver.role === 'hr'
    ) {
      const rows = await this.pg.tenantQuery<PgRow>(
        tenantSchema,
        `SELECT * FROM users
           WHERE role = 'admin' AND status = '启用' AND deleted_at IS NULL
           ORDER BY created_at ASC LIMIT 1`,
      );
      if (rows.length > 0) return UserRepository.mapRow(rows[0]);
    }

    // 分支 4：admin 离职 → 任一 active boss
    if (leaver.role === 'admin') {
      const rows = await this.pg.tenantQuery<PgRow>(
        tenantSchema,
        `SELECT * FROM users
           WHERE role = 'boss' AND status = '启用' AND deleted_at IS NULL
           ORDER BY created_at ASC LIMIT 1`,
      );
      if (rows.length > 0) return UserRepository.mapRow(rows[0]);
    }

    // 兜底：单校 role 同校无 boss 或上面所有分支都空 → 任一 active admin（再次尝试）
    {
      const rows = await this.pg.tenantQuery<PgRow>(
        tenantSchema,
        `SELECT * FROM users
           WHERE role = 'admin' AND status = '启用' AND deleted_at IS NULL
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
          // V44: handover 路径排除已软删学员（不必把已删数据再次转交）
          studentsRes = await client.query<{ id: string }>(
            `UPDATE students
                SET owner_sales_id = $2,
                    owner_changed_at = NOW(),
                    owner_change_reason = $3
              WHERE owner_sales_id = $1
                AND deleted_at IS NULL
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
