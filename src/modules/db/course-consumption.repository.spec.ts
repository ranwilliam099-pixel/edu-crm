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

  // V38: 删 sumPayrollForTeacher 2 个单测（method 已从 repository.ts 删除，薪资业务下线）

  // P1 S3 (2026-05-21) — feedback 提交合并 consumption confirm 用
  //   5/21 round 2 (security BLOCKER-2)：单数版废弃；现 SQL 无 LIMIT 支持多学生小班课
  describe('findAllPendingByScheduleId (S3 feedback-confirm 合并 / 多学生小班课)', () => {
    it('SQL 含 schedule_id 过滤 + status=pending_feedback + 无 LIMIT（支持多学生）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([ROW]);
      const r = await repo.findAllPendingByScheduleId(TENANT, SAMPLE.scheduleId);
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain('schedule_id = $1');
      expect(sql).toContain("status = 'pending_feedback'");
      // BLOCKER-2 修复关键断言：无 LIMIT（旧版 LIMIT 1 在小班课静默丢失）
      expect(sql).not.toContain('LIMIT');
      expect(pg.tenantQuery.mock.calls[0][2]).toEqual([SAMPLE.scheduleId]);
      expect(r).toHaveLength(1);
      expect(r[0].id).toBe(SAMPLE.id);
      expect(r[0].status).toBe('pending_feedback');
    });

    it('schedule 无 pending consumption → 返回 []（已 confirmed/locked/cancelled 不返回）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      const r = await repo.findAllPendingByScheduleId(TENANT, SAMPLE.scheduleId);
      expect(r).toEqual([]);
    });

    it('多学生小班课：1 schedule + 2 student → 返回 2 条（不被 LIMIT 1 截断）', async () => {
      const ROW2 = { ...ROW, id: 'ccB' + '0'.repeat(29), student_id: 'stuB' + '0'.repeat(28) };
      pg.tenantQuery.mockResolvedValueOnce([ROW, ROW2]);
      const r = await repo.findAllPendingByScheduleId(TENANT, SAMPLE.scheduleId);
      expect(r).toHaveLength(2);
      expect(r[0].id).toBe(SAMPLE.id);
      expect(r[1].id).toBe(ROW2.id);
    });
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
