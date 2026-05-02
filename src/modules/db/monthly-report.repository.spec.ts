import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { MonthlyReportRepository } from './monthly-report.repository';
import { PgPoolService } from './pg-pool.service';
import { MonthlyReport } from '../feedback/monthly-report.service';

describe('MonthlyReportRepository', () => {
  let repo: MonthlyReportRepository;
  let pg: { tenantQuery: jest.Mock; query: jest.Mock; withClient: jest.Mock };

  const TENANT = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const MONTH = new Date('2026-05-01');
  const SAMPLE: MonthlyReport = {
    id: 'report000000000000000000000000A',
    studentId: 'stu00000000000000000000000000A001',
    teacherId: 'teach000000000000000000000000A001',
    month: MONTH,
    attendanceSummary: { total: 8, '出勤': 7, '迟到': 1, '缺席': 0, '请假': 0 },
    performanceTrend: [{ date: '2026-05-01', performance: '良好' }],
    knowledgeSummary: [{ name: '函数', mastery: '良好', lessonCount: 4 }],
    status: 'auto_generated',
    generatedAt: new Date('2026-05-01T00:30:00Z'),
  };
  const ROW = {
    id: SAMPLE.id,
    student_id: SAMPLE.studentId,
    teacher_id: SAMPLE.teacherId,
    month: SAMPLE.month,
    attendance_summary: SAMPLE.attendanceSummary,
    performance_trend: SAMPLE.performanceTrend,
    knowledge_summary: SAMPLE.knowledgeSummary,
    teacher_blessing: null,
    renewal_suggestion: null,
    status: 'auto_generated',
    generated_at: SAMPLE.generatedAt,
    finalized_at: null,
    parent_read_at: null,
  };

  beforeEach(async () => {
    pg = { tenantQuery: jest.fn(), query: jest.fn(), withClient: jest.fn() };
    const m = await Test.createTestingModule({
      providers: [MonthlyReportRepository, { provide: PgPoolService, useValue: pg }],
    }).compile();
    repo = m.get(MonthlyReportRepository);
  });

  it('insert uses ON CONFLICT for monthly idempotency', async () => {
    pg.tenantQuery.mockResolvedValueOnce([ROW]);
    await repo.insert(TENANT, SAMPLE);
    const sql = pg.tenantQuery.mock.calls[0][1] as string;
    expect(sql).toContain('ON CONFLICT (student_id, month) DO UPDATE');
  });

  it('insert serializes JSONB summaries', async () => {
    pg.tenantQuery.mockResolvedValueOnce([ROW]);
    await repo.insert(TENANT, SAMPLE);
    const params = pg.tenantQuery.mock.calls[0][2];
    expect(params[4]).toBe(JSON.stringify(SAMPLE.attendanceSummary));
    expect(params[5]).toBe(JSON.stringify(SAMPLE.performanceTrend));
    expect(params[6]).toBe(JSON.stringify(SAMPLE.knowledgeSummary));
  });

  it('findByStudentMonth returns null when no row', async () => {
    pg.tenantQuery.mockResolvedValueOnce([]);
    const r = await repo.findByStudentMonth(TENANT, SAMPLE.studentId, MONTH);
    expect(r).toBeNull();
  });

  it('listByStudent maps rows', async () => {
    pg.tenantQuery.mockResolvedValueOnce([ROW, { ...ROW, id: 'r2' }]);
    const list = await repo.listByStudent(TENANT, SAMPLE.studentId);
    expect(list).toHaveLength(2);
  });

  it('listPendingFinalize without teacher returns global pending', async () => {
    pg.tenantQuery.mockResolvedValueOnce([]);
    await repo.listPendingFinalize(TENANT);
    const sql = pg.tenantQuery.mock.calls[0][1] as string;
    expect(sql).toContain("status = 'auto_generated'");
    expect(sql).not.toContain('teacher_id =');
  });

  it('listPendingFinalize with teacher filters', async () => {
    pg.tenantQuery.mockResolvedValueOnce([]);
    await repo.listPendingFinalize(TENANT, SAMPLE.teacherId);
    const sql = pg.tenantQuery.mock.calls[0][1] as string;
    expect(sql).toContain('teacher_id = $1');
  });

  it('finalize requires auto_generated state (NotFoundException on 0 rows)', async () => {
    pg.tenantQuery.mockResolvedValueOnce([]);
    await expect(
      repo.finalize(TENANT, SAMPLE.id, '加油', '续报建议'),
    ).rejects.toThrow(NotFoundException);
  });

  it('markParentRead is idempotent (COALESCE)', async () => {
    pg.tenantQuery.mockResolvedValueOnce([{ ...ROW, parent_read_at: new Date() }]);
    const r = await repo.markParentRead(TENANT, SAMPLE.id);
    expect(r.parentReadAt).toBeInstanceOf(Date);
  });

  it('parses attendance_summary string and object both', async () => {
    pg.tenantQuery.mockResolvedValueOnce([
      { ...ROW, attendance_summary: JSON.stringify(SAMPLE.attendanceSummary) },
    ]);
    const r = await repo.findById(TENANT, SAMPLE.id);
    expect(r?.attendanceSummary.total).toBe(8);
  });
});
