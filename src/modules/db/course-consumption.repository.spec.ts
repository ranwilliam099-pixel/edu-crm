import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { CourseConsumptionRepository } from './course-consumption.repository';
import { PgPoolService } from './pg-pool.service';
import { CourseConsumption } from '../feedback/course-consumption.service';

describe('CourseConsumptionRepository', () => {
  let repo: CourseConsumptionRepository;
  let pg: { tenantQuery: jest.Mock; query: jest.Mock; withClient: jest.Mock };

  const TENANT = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const SAMPLE: CourseConsumption = {
    id: 'cc0000000000000000000000000000A1',
    scheduleId: 'sched00000000000000000000000000A',
    studentId: 'stu00000000000000000000000000A001',
    teacherId: 'teach000000000000000000000000A001',
    status: 'pending_feedback',
    amountYuan: 200,
    feedbackDueAt: new Date('2026-05-03T10:00:00Z'),
    createdAt: new Date('2026-05-02T10:00:00Z'),
  };
  const ROW = {
    id: SAMPLE.id,
    schedule_id: SAMPLE.scheduleId,
    student_id: SAMPLE.studentId,
    teacher_id: SAMPLE.teacherId,
    status: SAMPLE.status,
    amount_yuan: '200.00',
    feedback_id: null,
    feedback_due_at: SAMPLE.feedbackDueAt,
    confirmed_at: null,
    locked_at: null,
    created_at: SAMPLE.createdAt,
  };

  beforeEach(async () => {
    pg = { tenantQuery: jest.fn(), query: jest.fn(), withClient: jest.fn() };
    const m = await Test.createTestingModule({
      providers: [
        CourseConsumptionRepository,
        { provide: PgPoolService, useValue: pg },
      ],
    }).compile();
    repo = m.get(CourseConsumptionRepository);
  });

  it('insert maps row + parses numeric amount', async () => {
    pg.tenantQuery.mockResolvedValueOnce([ROW]);
    const r = await repo.insert(TENANT, SAMPLE);
    expect(r.amountYuan).toBe(200);
    expect(typeof r.amountYuan).toBe('number');
  });

  it('findOverdueForLock filters by pending_feedback + due time', async () => {
    pg.tenantQuery.mockResolvedValueOnce([ROW]);
    const now = new Date('2026-05-04');
    await repo.findOverdueForLock(TENANT, now);
    const sql = pg.tenantQuery.mock.calls[0][1] as string;
    expect(sql).toContain("status = 'pending_feedback'");
    expect(sql).toContain('feedback_due_at < $1');
    expect(pg.tenantQuery.mock.calls[0][2]).toEqual([now]);
  });

  it('confirmByFeedback rejects cancelled', async () => {
    pg.tenantQuery.mockResolvedValueOnce([]);
    await expect(
      repo.confirmByFeedback(TENANT, SAMPLE.id, 'fb' + 'x'.repeat(30)),
    ).rejects.toThrow(NotFoundException);
  });

  it('lock only fires when status pending_feedback', async () => {
    pg.tenantQuery.mockResolvedValueOnce([{ ...ROW, status: 'locked', locked_at: new Date() }]);
    const r = await repo.lock(TENANT, SAMPLE.id);
    expect(r.status).toBe('locked');
  });

  it('cancel rejects already cancelled', async () => {
    pg.tenantQuery.mockResolvedValueOnce([]);
    await expect(repo.cancel(TENANT, SAMPLE.id)).rejects.toThrow(NotFoundException);
  });

  it('sumPayrollForTeacher returns total + count', async () => {
    pg.tenantQuery.mockResolvedValueOnce([{ total: '600.00', count: '3' }]);
    const r = await repo.sumPayrollForTeacher(
      TENANT,
      SAMPLE.teacherId,
      new Date('2026-05-01'),
      new Date('2026-06-01'),
    );
    expect(r.total).toBe(600);
    expect(r.count).toBe(3);
  });

  it('sumPayrollForTeacher handles 0 rows', async () => {
    pg.tenantQuery.mockResolvedValueOnce([{ total: '0', count: '0' }]);
    const r = await repo.sumPayrollForTeacher(
      TENANT,
      SAMPLE.teacherId,
      new Date(),
      new Date(),
    );
    expect(r).toEqual({ total: 0, count: 0 });
  });

  describe('findPendingFeedbackSummaryByTeacher (home-teacher 待办)', () => {
    it('返回 count + earliestDueAt（有待点评）', async () => {
      const due = new Date('2026-05-08T20:00:00Z');
      pg.tenantQuery.mockResolvedValueOnce([{ count: '3', earliest: due }]);
      const r = await repo.findPendingFeedbackSummaryByTeacher(TENANT, SAMPLE.teacherId);
      expect(r.count).toBe(3);
      expect(r.earliestDueAt).toEqual(due);
    });

    it('count=0 + earliest=null → 全无待点评', async () => {
      pg.tenantQuery.mockResolvedValueOnce([{ count: '0', earliest: null }]);
      const r = await repo.findPendingFeedbackSummaryByTeacher(TENANT, SAMPLE.teacherId);
      expect(r).toEqual({ count: 0, earliestDueAt: null });
    });

    it('SQL 含 teacher_id + status=pending_feedback 过滤 + MIN(feedback_due_at)', async () => {
      pg.tenantQuery.mockResolvedValueOnce([{ count: '0', earliest: null }]);
      await repo.findPendingFeedbackSummaryByTeacher(TENANT, SAMPLE.teacherId);
      const sql = pg.tenantQuery.mock.calls[0][1];
      expect(sql).toContain('teacher_id = $1');
      expect(sql).toContain("status = 'pending_feedback'");
      expect(sql).toContain('MIN(feedback_due_at)');
      expect(pg.tenantQuery.mock.calls[0][2]).toEqual([SAMPLE.teacherId]);
    });
  });

  it('listByStatus uses default pagination', async () => {
    pg.tenantQuery.mockResolvedValueOnce([]);
    await repo.listByStatus(TENANT, 'confirmed');
    expect(pg.tenantQuery.mock.calls[0][2]).toEqual(['confirmed', 50, 0]);
  });
});
