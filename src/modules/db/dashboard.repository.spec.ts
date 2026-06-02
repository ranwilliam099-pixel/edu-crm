import { Test } from '@nestjs/testing';
import { DashboardRepository } from './dashboard.repository';
import { PgPoolService } from './pg-pool.service';
import { UserRepository } from './user.repository';

describe('DashboardRepository', () => {
  let repo: DashboardRepository;
  let pg: { tenantQuery: jest.Mock; query: jest.Mock; withClient: jest.Mock };
  // Phase 3 item #4 — handover 复用 UserRepository.listInactiveWithPending
  let userRepo: { listInactiveWithPending: jest.Mock };

  const TENANT = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

  beforeEach(async () => {
    pg = { tenantQuery: jest.fn(), query: jest.fn(), withClient: jest.fn() };
    userRepo = { listInactiveWithPending: jest.fn() };
    const m = await Test.createTestingModule({
      providers: [
        DashboardRepository,
        { provide: PgPoolService, useValue: pg },
        { provide: UserRepository, useValue: userRepo },
      ],
    }).compile();
    repo = m.get(DashboardRepository);
  });

  describe('getAdminKpi', () => {
    it('aggregates new signups + revenue + active students + low balance', async () => {
      pg.tenantQuery
        .mockResolvedValueOnce([{ new_signups: '12', revenue_yuan: '88000' }])
        .mockResolvedValueOnce([{ active: '32' }])
        .mockResolvedValueOnce([{ count: '120' }])
        .mockResolvedValueOnce([{ count: '7' }]); // low balance count
      const k = await repo.getAdminKpi(TENANT);
      expect(k.thisMonth.newSignups).toBe(12);
      expect(k.thisMonth.revenueYuan).toBe(88000);
      expect(k.thisMonth.activeStudents).toBe(32);
      expect(k.studentsTotal).toBe(120);
      expect(k.thisMonth.conversionRate).toBeGreaterThan(20);
      expect(k.thisMonth.conversionRate).toBeLessThan(35);
      expect(k.lowBalanceCount).toBe(7);
      expect(k.todoCount).toBe(7);
    });

    it('returns 0s when tables missing (graceful)', async () => {
      pg.tenantQuery.mockRejectedValue(new Error('no table'));
      const k = await repo.getAdminKpi(TENANT);
      expect(k.thisMonth.newSignups).toBe(0);
      expect(k.thisMonth.activeStudents).toBe(0);
      expect(k.studentsTotal).toBe(0);
    });

    it('handles 0 students total without divide-by-zero', async () => {
      pg.tenantQuery
        .mockResolvedValueOnce([{ new_signups: '0', revenue_cents: '0' }])
        .mockResolvedValueOnce([{ active: '0' }])
        .mockResolvedValueOnce([{ count: '0' }]);
      const k = await repo.getAdminKpi(TENANT);
      expect(k.thisMonth.conversionRate).toBe(0);
    });
  });

  // ===================== Phase 3 item #4 — getHomeAlerts =====================
  describe('getHomeAlerts', () => {
    it('aggregates refundPending + lowBalance + handover (happy path)', async () => {
      pg.tenantQuery
        .mockResolvedValueOnce([{ count: '4' }]) // refundPending
        .mockResolvedValueOnce([{ count: '9' }]); // lowBalance (< 5)
      userRepo.listInactiveWithPending.mockResolvedValueOnce([
        { user: { id: 'u1' }, pendingOpportunities: 2, pendingContracts: 0, pendingStudents: 1 },
        { user: { id: 'u2' }, pendingOpportunities: 0, pendingContracts: 3, pendingStudents: 0 },
      ]);
      const a = await repo.getHomeAlerts(TENANT);
      expect(a.refundPending).toBe(4);
      expect(a.lowBalance).toBe(9);
      expect(a.handover).toBe(2);
    });

    it('lowBalance query uses remaining_lessons < 5 threshold + DISTINCT student_id', async () => {
      pg.tenantQuery
        .mockResolvedValueOnce([{ count: '0' }])
        .mockResolvedValueOnce([{ count: '0' }]);
      userRepo.listInactiveWithPending.mockResolvedValueOnce([]);
      await repo.getHomeAlerts(TENANT);
      const lowBalanceSql = pg.tenantQuery.mock.calls[1][1] as string;
      expect(lowBalanceSql).toContain('remaining_lessons < 5');
      expect(lowBalanceSql).toContain('COUNT(DISTINCT student_id)');
      expect(lowBalanceSql).toContain("status = 'active'");
    });

    it('refundPending query counts status=pending refund_orders', async () => {
      pg.tenantQuery
        .mockResolvedValueOnce([{ count: '0' }])
        .mockResolvedValueOnce([{ count: '0' }]);
      userRepo.listInactiveWithPending.mockResolvedValueOnce([]);
      await repo.getHomeAlerts(TENANT);
      const refundSql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(refundSql).toContain('refund_orders');
      expect(refundSql).toContain("status = 'pending'");
    });

    it('fail-open: refund_orders table missing → refundPending 0, others still computed', async () => {
      pg.tenantQuery
        .mockRejectedValueOnce(new Error('relation "refund_orders" does not exist'))
        .mockResolvedValueOnce([{ count: '6' }]); // lowBalance still works
      userRepo.listInactiveWithPending.mockResolvedValueOnce([{ user: { id: 'u1' } }]);
      const a = await repo.getHomeAlerts(TENANT);
      expect(a.refundPending).toBe(0);
      expect(a.lowBalance).toBe(6);
      expect(a.handover).toBe(1);
    });

    it('fail-open: handover (listInactiveWithPending) throws → handover 0, others intact', async () => {
      pg.tenantQuery
        .mockResolvedValueOnce([{ count: '3' }])
        .mockResolvedValueOnce([{ count: '2' }]);
      userRepo.listInactiveWithPending.mockRejectedValueOnce(new Error('boom'));
      const a = await repo.getHomeAlerts(TENANT);
      expect(a.refundPending).toBe(3);
      expect(a.lowBalance).toBe(2);
      expect(a.handover).toBe(0);
    });

    it('returns all 0 when every source fails (graceful)', async () => {
      pg.tenantQuery.mockRejectedValue(new Error('no table'));
      userRepo.listInactiveWithPending.mockRejectedValue(new Error('no table'));
      const a = await repo.getHomeAlerts(TENANT);
      expect(a).toEqual({ lowBalance: 0, refundPending: 0, handover: 0 });
    });
  });

  describe('getSalesFunnel', () => {
    // 2026-06-02 SSOT §3.-2 C — 漏斗重设计为 3 状态（following / trial / deal）
    //   following = 初步接触 + 需求诊断 + 已预约试听
    //   trial     = 已试听待转化 + 已出方案 + 谈单中
    //   deal      = 已报名
    //   已失单    = 流失终态，不计入 3 状态（仅入 lossReasons）
    it('aggregates 3 buckets from opportunities table (following/trial/deal)', async () => {
      // opportunities by stage（含已失单 — 验证不计入 3 状态）
      pg.tenantQuery.mockResolvedValueOnce([
        { stage: '初步接触', count: '50' },
        { stage: '需求诊断', count: '20' },
        { stage: '已预约试听', count: '40' },
        { stage: '已试听待转化', count: '25' },
        { stage: '已出方案', count: '12' },
        { stage: '谈单中', count: '8' },
        { stage: '已报名', count: '15' },
        { stage: '已失单', count: '99' }, // 终态流失，不入 3 状态
      ]);
      // loss reasons
      pg.tenantQuery.mockResolvedValueOnce([
        { reason: '价格高', count: '10' },
        { reason: '时间不合适', count: '6' },
      ]);
      const f = await repo.getSalesFunnel(TENANT);
      expect(f.stages).toHaveLength(3);
      expect(f.stages[0].key).toBe('following');
      expect(f.stages[0].label).toBe('跟进中');
      expect(f.stages[0].count).toBe(110); // 50+20+40
      expect(f.stages[1].key).toBe('trial');
      expect(f.stages[1].label).toBe('已试听');
      expect(f.stages[1].count).toBe(45); // 25+12+8
      expect(f.stages[2].key).toBe('deal');
      expect(f.stages[2].label).toBe('成交');
      expect(f.stages[2].count).toBe(15); // 已报名
      // 已失单(99) 未计入任一状态 → 3 桶合计 = 110+45+15 = 170（不含 99）
      expect(f.stages.reduce((s, st) => s + st.count, 0)).toBe(170);
      // conversionPct 相邻转化：following→trial = 45/110, trial→deal = 15/45
      expect(f.stages[1].conversionPct).toBe(Math.round((45 * 100) / 110));
      expect(f.stages[2].conversionPct).toBe(Math.round((15 * 100) / 45));
      expect(f.overallConversion).toBeGreaterThan(0);
      expect(f.lossReasons).toHaveLength(2);
      expect(f.lossReasons[0].reason).toBe('价格高');
    });

    it('returns 3 zero buckets + empty loss reasons when opportunities table missing', async () => {
      pg.tenantQuery.mockRejectedValue(new Error('no table'));
      const f = await repo.getSalesFunnel(TENANT);
      expect(f.stages).toHaveLength(3);
      expect(f.stages.map((s) => s.key)).toEqual(['following', 'trial', 'deal']);
      expect(f.stages.map((s) => s.label)).toEqual(['跟进中', '已试听', '成交']);
      expect(f.stages.every((s) => s.count === 0)).toBe(true);
      expect(f.lossReasons).toEqual([]);
    });

    it('V26 campusId 过滤 → SQL where campus_id = $1 + params 带 campusId（funnel + lossReasons 都过滤）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([{ stage: '已报名', count: '5' }]);
      pg.tenantQuery.mockResolvedValueOnce([{ reason: '价格', count: '2' }]);
      const CAMPUS = 'campus0000000000000000000000A001';
      await repo.getSalesFunnel(TENANT, { campusId: CAMPUS });
      // 第一次 query: stage 聚合
      const stageCall = pg.tenantQuery.mock.calls[0];
      expect(stageCall[1]).toContain('WHERE campus_id = $1');
      expect(stageCall[2]).toEqual([CAMPUS]);
      // 第二次 query: loss reasons
      const lossCall = pg.tenantQuery.mock.calls[1];
      expect(lossCall[1]).toContain('AND campus_id = $1');
      expect(lossCall[2]).toEqual([CAMPUS]);
    });

    it('V26 campusId 不传 → SQL 无 WHERE 校区子句 + params 空（admin 全机构视角）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([{ stage: '已报名', count: '5' }]);
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.getSalesFunnel(TENANT);
      const stageCall = pg.tenantQuery.mock.calls[0];
      expect(stageCall[1]).not.toContain('WHERE campus_id');
      expect(stageCall[2]).toEqual([]);
      const lossCall = pg.tenantQuery.mock.calls[1];
      expect(lossCall[1]).not.toContain('AND campus_id');
      expect(lossCall[2]).toEqual([]);
    });

    it('#3 ownerUserId 过滤 → SQL where owner_user_id = $1 + params 带 userId（销售看自己漏斗）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([{ stage: '已报名', count: '3' }]);
      pg.tenantQuery.mockResolvedValueOnce([{ reason: '价格', count: '2' }]);
      const OWNER = 'user000000000000000000000000U001';
      await repo.getSalesFunnel(TENANT, { ownerUserId: OWNER });
      const stageCall = pg.tenantQuery.mock.calls[0];
      expect(stageCall[1]).toContain('WHERE owner_user_id = $1');
      expect(stageCall[2]).toEqual([OWNER]);
      const lossCall = pg.tenantQuery.mock.calls[1];
      expect(lossCall[1]).toContain('AND owner_user_id = $1');
      expect(lossCall[2]).toEqual([OWNER]);
    });

    it('#3 campusId + ownerUserId 同传 → SQL where 两条件 AND，params 顺序对（销售经理看本校区自己团队）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([{ stage: '已报名', count: '2' }]);
      pg.tenantQuery.mockResolvedValueOnce([]);
      const CAMPUS = 'campus0000000000000000000000A001';
      const OWNER = 'user000000000000000000000000U001';
      await repo.getSalesFunnel(TENANT, { campusId: CAMPUS, ownerUserId: OWNER });
      const stageCall = pg.tenantQuery.mock.calls[0];
      expect(stageCall[1]).toContain('WHERE campus_id = $1 AND owner_user_id = $2');
      expect(stageCall[2]).toEqual([CAMPUS, OWNER]);
      const lossCall = pg.tenantQuery.mock.calls[1];
      expect(lossCall[1]).toContain('AND campus_id = $1 AND owner_user_id = $2');
      expect(lossCall[2]).toEqual([CAMPUS, OWNER]);
    });
  });

  describe('getTeacherLeaderboard', () => {
    it('returns sorted by lessons DESC by default (V37 payroll 下线)', async () => {
      pg.tenantQuery
        .mockResolvedValueOnce([
          { id: 't1', name: '张老师', subject: '英语', avatar: null, lessons: '20' },
          { id: 't2', name: '李老师', subject: '数学', avatar: null, lessons: '15' },
        ])
        .mockResolvedValueOnce([
          { teacher_id: 't1', fb_count: '18', cc_count: '20' },
          { teacher_id: 't2', fb_count: '15', cc_count: '15' },
        ]);
      const lb = await repo.getTeacherLeaderboard(TENANT, { month: '2026-05' });
      expect(lb.activeMonth).toBe('2026-05');
      expect(lb.teachers).toHaveLength(2);
      expect(lb.teachers[0].id).toBe('t1');
      expect(lb.teachers[0].rank).toBe(1);
      // V37: payroll 字段已删 → 验 lessons 排序
      expect(lb.teachers[0].lessons).toBe(20);
      expect(lb.teachers[1].lessons).toBe(15);
      expect(lb.teachers[0].feedbackRate).toBe(90);
      expect(lb.teachers[1].feedbackRate).toBe(100);
      expect(lb.summary.count).toBe(2);
      // V37: summary.total 已删（原 totalPayroll 别名）
    });

    it('sorts by feedbackRate when requested', async () => {
      pg.tenantQuery
        .mockResolvedValueOnce([
          { id: 't1', name: '张老师', subject: '英语', avatar: null, lessons: '20' },
          { id: 't2', name: '李老师', subject: '数学', avatar: null, lessons: '15' },
        ])
        .mockResolvedValueOnce([
          { teacher_id: 't1', fb_count: '15', cc_count: '20' },
          { teacher_id: 't2', fb_count: '15', cc_count: '15' },
        ]);
      const lb = await repo.getTeacherLeaderboard(TENANT, {
        month: '2026-05',
        sortBy: 'feedbackRate',
      });
      // t2 has 100% > t1 75%, so t2 ranks first
      expect(lb.teachers[0].id).toBe('t2');
      expect(lb.teachers[0].rank).toBe(1);
    });

    it('returns empty leaderboard when teachers table missing', async () => {
      pg.tenantQuery.mockRejectedValue(new Error('no teachers'));
      const lb = await repo.getTeacherLeaderboard(TENANT, { month: '2026-05' });
      expect(lb.teachers).toEqual([]);
      expect(lb.summary.count).toBe(0);
      // V37: summary.total 已删
      expect(lb.summary.avgRating).toBeNull();
    });
  });
});
