import { Test } from '@nestjs/testing';
import { DashboardRepository } from './dashboard.repository';
import { PgPoolService } from './pg-pool.service';

describe('DashboardRepository', () => {
  let repo: DashboardRepository;
  let pg: { tenantQuery: jest.Mock; query: jest.Mock; withClient: jest.Mock };

  const TENANT = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

  beforeEach(async () => {
    pg = { tenantQuery: jest.fn(), query: jest.fn(), withClient: jest.fn() };
    const m = await Test.createTestingModule({
      providers: [DashboardRepository, { provide: PgPoolService, useValue: pg }],
    }).compile();
    repo = m.get(DashboardRepository);
  });

  describe('getAdminKpi', () => {
    it('aggregates new signups + revenue + active students', async () => {
      pg.tenantQuery
        .mockResolvedValueOnce([{ new_signups: '12', revenue_cents: '88000' }])
        .mockResolvedValueOnce([{ active: '32' }])
        .mockResolvedValueOnce([{ count: '120' }]);
      const k = await repo.getAdminKpi(TENANT);
      expect(k.thisMonth.newSignups).toBe(12);
      expect(k.thisMonth.revenueYuan).toBe(88000);
      expect(k.thisMonth.activeStudents).toBe(32);
      expect(k.studentsTotal).toBe(120);
      // conversionRate = active / total = 32/120 ≈ 27%
      expect(k.thisMonth.conversionRate).toBeGreaterThan(20);
      expect(k.thisMonth.conversionRate).toBeLessThan(35);
      // mock todoCount/lowBalanceCount
      expect(k.todoCount).toBe(0);
      expect(k.lowBalanceCount).toBe(0);
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

  describe('getSalesFunnel', () => {
    it('aggregates 5 stages from opportunities table', async () => {
      // opportunities by stage
      pg.tenantQuery.mockResolvedValueOnce([
        { stage: '初步接触', count: '50' },
        { stage: '需求诊断', count: '20' },
        { stage: '已预约试听', count: '40' },
        { stage: '已试听待转化', count: '25' },
        { stage: '已出方案', count: '12' },
        { stage: '谈单中', count: '8' },
        { stage: '已报名', count: '15' },
      ]);
      // loss reasons
      pg.tenantQuery.mockResolvedValueOnce([
        { reason: '价格高', count: '10' },
        { reason: '时间不合适', count: '6' },
      ]);
      const f = await repo.getSalesFunnel(TENANT);
      expect(f.stages).toHaveLength(5);
      expect(f.stages[0].key).toBe('consult');
      expect(f.stages[0].count).toBe(70); // 50+20
      expect(f.stages[4].key).toBe('paid');
      expect(f.stages[4].count).toBe(15);
      expect(f.overallConversion).toBeGreaterThan(0);
      expect(f.lossReasons).toHaveLength(2);
      expect(f.lossReasons[0].reason).toBe('价格高');
    });

    it('falls back to mock when opportunities table missing', async () => {
      pg.tenantQuery.mockRejectedValue(new Error('no table'));
      const f = await repo.getSalesFunnel(TENANT);
      expect(f.stages).toHaveLength(5);
      expect(f.stages.every((s) => s.count === 0)).toBe(true);
      expect(f.lossReasons.length).toBeGreaterThan(0); // mock 硬编码 3 条
    });
  });

  describe('getTeacherLeaderboard', () => {
    it('returns sorted by payroll DESC by default', async () => {
      pg.tenantQuery
        .mockResolvedValueOnce([
          { id: 't1', name: '张老师', subject: '英语', avatar: null, lessons: '20', payroll: '8000' },
          { id: 't2', name: '李老师', subject: '数学', avatar: null, lessons: '15', payroll: '6000' },
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
      expect(lb.teachers[0].payroll).toBe(8000);
      expect(lb.teachers[0].feedbackRate).toBe(90);
      expect(lb.teachers[1].feedbackRate).toBe(100);
      expect(lb.summary.count).toBe(2);
      expect(lb.summary.total).toBe(14000);
    });

    it('sorts by feedbackRate when requested', async () => {
      pg.tenantQuery
        .mockResolvedValueOnce([
          { id: 't1', name: '张老师', subject: '英语', avatar: null, lessons: '20', payroll: '8000' },
          { id: 't2', name: '李老师', subject: '数学', avatar: null, lessons: '15', payroll: '6000' },
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
      expect(lb.summary.total).toBe(0);
    });
  });
});
