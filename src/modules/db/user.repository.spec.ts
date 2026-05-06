import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { UserRepository, User } from './user.repository';
import { PgPoolService } from './pg-pool.service';

describe('UserRepository (V27)', () => {
  let repo: UserRepository;
  let pg: {
    tenantQuery: jest.Mock;
    query: jest.Mock;
    withClient: jest.Mock;
    transaction: jest.Mock;
  };
  let txClient: { query: jest.Mock };

  const TENANT = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const CAMPUS_A = 'campus_A_00000000000000000000A001';
  const CAMPUS_B = 'campus_B_00000000000000000000B001';
  const SALES_ID = 'sales000000000000000000000000A001';
  const BOSS_A_ID = 'bossA000000000000000000000000A001';
  const BOSS_B_ID = 'bossB000000000000000000000000B001';
  const ADMIN_ID = 'admin000000000000000000000000A001';
  const HR_ID = 'hr00000000000000000000000000A001H';
  const DIRECTOR_ID = 'directors0000000000000000000A001';

  const userRow = (overrides: Partial<{ id: string; role: string; campus_id: string; status: string; name: string }> = {}) => ({
    id: overrides.id || SALES_ID,
    name: overrides.name || '张三',
    mobile: '13800000000',
    role: overrides.role || 'sales',
    campus_id: overrides.campus_id || CAMPUS_A,
    status: overrides.status || '启用',
    created_at: new Date('2026-05-01T00:00:00Z'),
    updated_at: new Date('2026-05-07T00:00:00Z'),
  });

  beforeEach(async () => {
    txClient = { query: jest.fn() };
    pg = {
      tenantQuery: jest.fn(),
      query: jest.fn(),
      withClient: jest.fn(),
      transaction: jest.fn().mockImplementation(async (fn: any) => fn(txClient)),
    };
    const m = await Test.createTestingModule({
      providers: [UserRepository, { provide: PgPoolService, useValue: pg }],
    }).compile();
    repo = m.get(UserRepository);
  });

  describe('findById', () => {
    it('returns user when row found', async () => {
      pg.tenantQuery.mockResolvedValueOnce([userRow()]);
      const u = await repo.findById(TENANT, SALES_ID);
      expect(u?.id).toBe(SALES_ID);
      expect(u?.role).toBe('sales');
      expect(u?.status).toBe('启用');
    });

    it('returns null when no row', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      const u = await repo.findById(TENANT, SALES_ID);
      expect(u).toBeNull();
    });
  });

  describe('findTransferTarget — V10 5 分支接棒人解析', () => {
    const leaver = (role: string, campusId: string = CAMPUS_A): User => ({
      id: SALES_ID,
      name: '离职者',
      mobile: '13800000000',
      role: role as any,
      campusId,
      status: '启用',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    it('分支 1：sales 离职 → 同 campus 的 active boss', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        userRow({ id: BOSS_A_ID, role: 'boss', campus_id: CAMPUS_A, name: 'A 校长' }),
      ]);
      const target = await repo.findTransferTarget(TENANT, leaver('sales', CAMPUS_A));
      expect(target?.id).toBe(BOSS_A_ID);
      expect(target?.role).toBe('boss');
      // SQL 应该是同 campus boss 查询
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain(`role = 'boss'`);
      expect(sql).toContain('campus_id = $1');
      expect(pg.tenantQuery.mock.calls[0][2]).toEqual([CAMPUS_A]);
    });

    it('分支 1 兜底：sales 离职但同 campus 无 boss → 退到 admin', async () => {
      pg.tenantQuery
        .mockResolvedValueOnce([])  // 同 campus boss 空
        .mockResolvedValueOnce([userRow({ id: ADMIN_ID, role: 'admin' })]);  // 兜底 admin
      const target = await repo.findTransferTarget(TENANT, leaver('sales', CAMPUS_A));
      expect(target?.id).toBe(ADMIN_ID);
      expect(target?.role).toBe('admin');
    });

    it('分支 2：boss 离职 → 任一 active admin', async () => {
      pg.tenantQuery.mockResolvedValueOnce([userRow({ id: ADMIN_ID, role: 'admin' })]);
      const target = await repo.findTransferTarget(TENANT, leaver('boss', CAMPUS_A));
      expect(target?.id).toBe(ADMIN_ID);
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain(`role = 'admin'`);
      expect(sql).not.toContain('campus_id');
    });

    it('分支 3a：sales_director 离职 → 任一 active admin', async () => {
      pg.tenantQuery.mockResolvedValueOnce([userRow({ id: ADMIN_ID, role: 'admin' })]);
      const target = await repo.findTransferTarget(TENANT, leaver('sales_director'));
      expect(target?.role).toBe('admin');
    });

    it('分支 3b：hr 离职 → 任一 active admin', async () => {
      pg.tenantQuery.mockResolvedValueOnce([userRow({ id: ADMIN_ID, role: 'admin' })]);
      const target = await repo.findTransferTarget(TENANT, leaver('hr'));
      expect(target?.role).toBe('admin');
    });

    it('分支 4：admin 离职 → 任一 active boss', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        userRow({ id: BOSS_A_ID, role: 'boss', campus_id: CAMPUS_A, name: 'A 校长' }),
      ]);
      const target = await repo.findTransferTarget(TENANT, leaver('admin'));
      expect(target?.id).toBe(BOSS_A_ID);
      expect(target?.role).toBe('boss');
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain(`role = 'boss'`);
      expect(sql).not.toContain('campus_id');
    });

    it('分支 5 兜底：admin 离职且无 boss → 退到 admin（其他 admin） / 否则 null', async () => {
      pg.tenantQuery
        .mockResolvedValueOnce([])  // boss 查空
        .mockResolvedValueOnce([]); // 兜底 admin 也空
      const target = await repo.findTransferTarget(TENANT, leaver('admin'));
      expect(target).toBeNull();
    });

    it('分支 5 兜底：sales 离职但全租户没有 boss/admin → null', async () => {
      pg.tenantQuery
        .mockResolvedValueOnce([])  // 同 campus boss 空
        .mockResolvedValueOnce([]); // 兜底 admin 空
      const target = await repo.findTransferTarget(TENANT, leaver('sales', CAMPUS_A));
      expect(target).toBeNull();
    });
  });

  describe('deactivate', () => {
    it('标 user 停用 + 转交 opportunities + contracts + 留痕（事务）', async () => {
      // findById 返回离职者
      pg.tenantQuery.mockResolvedValueOnce([userRow({ id: SALES_ID, role: 'sales' })]);
      // findTransferTarget 返回同 campus boss
      pg.tenantQuery.mockResolvedValueOnce([userRow({ id: BOSS_A_ID, role: 'boss', name: 'A 校长' })]);
      // 事务内：UPDATE users / UPDATE opportunities / UPDATE contracts / N × INSERT log
      txClient.query
        .mockResolvedValueOnce({ rowCount: 1, rows: [userRow({ id: SALES_ID, status: '停用' })] })
        .mockResolvedValueOnce({ rowCount: 3, rows: [{ id: 'opp1' }, { id: 'opp2' }, { id: 'opp3' }] })
        .mockResolvedValueOnce({ rowCount: 2, rows: [{ id: 'c1' }, { id: 'c2' }] })
        .mockResolvedValue({ rowCount: 1, rows: [] }); // 3 × INSERT log
      const r = await repo.deactivate(TENANT, SALES_ID, { userId: ADMIN_ID, label: '老板' });
      expect(r.user.status).toBe('停用');
      expect(r.transferToUserId).toBe(BOSS_A_ID);
      expect(r.opportunitiesMoved).toBe(3);
      expect(r.contractsMoved).toBe(2);
      expect(r.reason).toBe('离职转交');
      // 事务被调用
      expect(pg.transaction).toHaveBeenCalledTimes(1);
      // INSERT log 调了 3 次（每个 opp 一条）
      const insertLogCalls = txClient.query.mock.calls.filter((c) =>
        c[0].includes('customer_follow_log'),
      );
      expect(insertLogCalls).toHaveLength(3);
    });

    it('user 已 停用 → BadRequestException', async () => {
      pg.tenantQuery.mockResolvedValueOnce([userRow({ id: SALES_ID, status: '停用' })]);
      await expect(
        repo.deactivate(TENANT, SALES_ID, { userId: ADMIN_ID, label: '老板' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('user 不存在 → NotFoundException', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await expect(
        repo.deactivate(TENANT, SALES_ID, { userId: ADMIN_ID, label: '老板' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('找不到接棒人 → 仍标停用 + owner_user_id=NULL', async () => {
      pg.tenantQuery.mockResolvedValueOnce([userRow({ id: SALES_ID, role: 'sales' })]);
      pg.tenantQuery
        .mockResolvedValueOnce([])  // 同 campus boss 空
        .mockResolvedValueOnce([]); // 兜底 admin 也空
      txClient.query
        .mockResolvedValueOnce({ rowCount: 1, rows: [userRow({ id: SALES_ID, status: '停用' })] })
        .mockResolvedValueOnce({ rowCount: 0, rows: [] })
        .mockResolvedValueOnce({ rowCount: 0, rows: [] });
      const r = await repo.deactivate(TENANT, SALES_ID, { userId: ADMIN_ID, label: '老板' });
      expect(r.transferToUserId).toBeNull();
      expect(r.transferToUserLabel).toContain('无人接');
    });
  });

  describe('handover (校长二次手动转交)', () => {
    it('scope=all：转交 fromUser 全部数据给 toUser，reason=校长再分配', async () => {
      // findById toUser
      pg.tenantQuery.mockResolvedValueOnce([userRow({ id: BOSS_A_ID, role: 'boss', name: 'A 校长' })]);
      // 事务：UPDATE opps / UPDATE contracts / 留痕
      txClient.query
        .mockResolvedValueOnce({ rowCount: 5, rows: [{ id: 'opp1' }, { id: 'opp2' }, { id: 'opp3' }, { id: 'opp4' }, { id: 'opp5' }] })
        .mockResolvedValueOnce({ rowCount: 2, rows: [] })
        .mockResolvedValue({ rowCount: 1, rows: [] });
      const r = await repo.handover(TENANT, {
        fromUserId: SALES_ID,
        toUserId: BOSS_A_ID,
        scope: 'all',
        operator: { userId: ADMIN_ID, label: '老板' },
      });
      expect(r.opportunitiesMoved).toBe(5);
      expect(r.contractsMoved).toBe(2);
      expect(r.reason).toBe('校长再分配');
    });

    it('校长把数据转给自己 → reason=主动认领', async () => {
      pg.tenantQuery.mockResolvedValueOnce([userRow({ id: BOSS_A_ID, role: 'boss', name: 'A 校长' })]);
      txClient.query
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'opp1' }] })
        .mockResolvedValueOnce({ rowCount: 0, rows: [] })
        .mockResolvedValue({ rowCount: 1, rows: [] });
      const r = await repo.handover(TENANT, {
        fromUserId: SALES_ID,
        toUserId: BOSS_A_ID,
        scope: 'all',
        operator: { userId: BOSS_A_ID, label: 'A 校长' },
      });
      expect(r.reason).toBe('主动认领');
    });

    it('toUserId=null → 退回池（owner=NULL）', async () => {
      txClient.query
        .mockResolvedValueOnce({ rowCount: 2, rows: [{ id: 'opp1' }, { id: 'opp2' }] })
        .mockResolvedValueOnce({ rowCount: 0, rows: [] })
        .mockResolvedValue({ rowCount: 1, rows: [] });
      const r = await repo.handover(TENANT, {
        fromUserId: SALES_ID,
        toUserId: null,
        scope: 'all',
        operator: { userId: ADMIN_ID, label: '老板' },
      });
      expect(r.toUserId).toBeNull();
      expect(r.opportunitiesMoved).toBe(2);
    });

    it('toUser 已停用 → BadRequestException', async () => {
      pg.tenantQuery.mockResolvedValueOnce([userRow({ id: BOSS_A_ID, role: 'boss', status: '停用' })]);
      await expect(
        repo.handover(TENANT, {
          fromUserId: SALES_ID,
          toUserId: BOSS_A_ID,
          scope: 'all',
          operator: { userId: ADMIN_ID, label: '老板' },
        }),
      ).rejects.toThrow(/停用.*不能接棒/);
    });

    it('fromUserId === toUserId → BadRequestException', async () => {
      await expect(
        repo.handover(TENANT, {
          fromUserId: SALES_ID,
          toUserId: SALES_ID,
          scope: 'all',
          operator: { userId: ADMIN_ID, label: '老板' },
        }),
      ).rejects.toThrow(/无须转交/);
    });

    it('scope=select 但未传 ids → BadRequestException', async () => {
      pg.tenantQuery.mockResolvedValueOnce([userRow({ id: BOSS_A_ID, role: 'boss' })]);
      await expect(
        repo.handover(TENANT, {
          fromUserId: SALES_ID,
          toUserId: BOSS_A_ID,
          scope: 'select',
          operator: { userId: ADMIN_ID, label: '老板' },
        }),
      ).rejects.toThrow(/select.*opportunityIds.*contractIds/);
    });

    it('scope=select 精确转交：传 opportunityIds 仅 UPDATE 这些', async () => {
      pg.tenantQuery.mockResolvedValueOnce([userRow({ id: BOSS_A_ID, role: 'boss' })]);
      txClient.query
        .mockResolvedValueOnce({ rowCount: 2, rows: [{ id: 'opp1' }, { id: 'opp2' }] })
        .mockResolvedValue({ rowCount: 1, rows: [] });
      const r = await repo.handover(TENANT, {
        fromUserId: SALES_ID,
        toUserId: BOSS_A_ID,
        scope: 'select',
        opportunityIds: ['opp1', 'opp2'],
        operator: { userId: ADMIN_ID, label: '老板' },
      });
      expect(r.opportunitiesMoved).toBe(2);
      expect(r.contractsMoved).toBe(0);
      const oppsCall = txClient.query.mock.calls[0];
      expect(oppsCall[0]).toContain('id = ANY');
      expect(oppsCall[1][3]).toEqual(['opp1', 'opp2']);
    });

    it('支持转移在职员工的数据（fromUser 状态不限）— 用户 2026-05-07 拍板', async () => {
      // 校长主动从 active sales 转走数据（不是离职场景）
      pg.tenantQuery.mockResolvedValueOnce([userRow({ id: BOSS_A_ID, role: 'boss' })]);
      txClient.query
        .mockResolvedValueOnce({ rowCount: 3, rows: [{ id: 'opp1' }, { id: 'opp2' }, { id: 'opp3' }] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'c1' }] })
        .mockResolvedValue({ rowCount: 1, rows: [] });
      // 注意：repo.handover 不查 fromUser 状态 → 在职 sales 的数据也能转
      const r = await repo.handover(TENANT, {
        fromUserId: SALES_ID,
        toUserId: BOSS_A_ID,
        scope: 'all',
        operator: { userId: ADMIN_ID, label: '老板' },
      });
      expect(r.opportunitiesMoved).toBe(3);
      expect(r.contractsMoved).toBe(1);
    });
  });

  describe('listInactiveWithPending', () => {
    it('只返回 status=停用 且 (pendingOpps + pendingContracts) > 0 的用户', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        { ...userRow({ id: SALES_ID, status: '停用' }), pending_opps: '5', pending_contracts: '2' },
        { ...userRow({ id: BOSS_A_ID, status: '停用' }), pending_opps: '0', pending_contracts: '0' },
      ]);
      const items = await repo.listInactiveWithPending(TENANT);
      expect(items).toHaveLength(1);
      expect(items[0].user.id).toBe(SALES_ID);
      expect(items[0].pendingOpportunities).toBe(5);
      expect(items[0].pendingContracts).toBe(2);
    });
  });

  describe('listActive', () => {
    it('无过滤 → SQL where status=启用', async () => {
      pg.tenantQuery.mockResolvedValueOnce([userRow()]);
      await repo.listActive(TENANT);
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain(`status = '启用'`);
      expect(sql).not.toContain('role = ANY');
      expect(sql).not.toContain('campus_id');
    });

    it('roles 过滤 → SQL role = ANY 带参数', async () => {
      pg.tenantQuery.mockResolvedValueOnce([userRow({ role: 'boss' })]);
      await repo.listActive(TENANT, { roles: ['boss', 'sales'] });
      const [, sql, params] = pg.tenantQuery.mock.calls[0];
      expect(sql).toContain('role = ANY($1::varchar[])');
      expect(params[0]).toEqual(['boss', 'sales']);
    });

    it('campusId 过滤 → SQL campus_id = $N', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.listActive(TENANT, { campusId: CAMPUS_A });
      const [, sql, params] = pg.tenantQuery.mock.calls[0];
      expect(sql).toContain('campus_id = $1');
      expect(params[0]).toBe(CAMPUS_A);
    });

    it('roles + campusId 联合过滤', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.listActive(TENANT, { roles: ['boss'], campusId: CAMPUS_A });
      const [, sql, params] = pg.tenantQuery.mock.calls[0];
      expect(sql).toContain('role = ANY($1::varchar[])');
      expect(sql).toContain('campus_id = $2');
      expect(params).toEqual([['boss'], CAMPUS_A]);
    });
  });

  describe('listActiveWithData', () => {
    it('只返回 active 且名下有 opps/contracts > 0 的用户', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        { ...userRow({ id: SALES_ID, status: '启用' }), pending_opps: '8', pending_contracts: '1' },
        { ...userRow({ id: BOSS_A_ID, status: '启用' }), pending_opps: '0', pending_contracts: '0' },
      ]);
      const items = await repo.listActiveWithData(TENANT);
      expect(items).toHaveLength(1);
      expect(items[0].user.id).toBe(SALES_ID);
      expect(items[0].pendingOpportunities).toBe(8);
    });
  });
});
