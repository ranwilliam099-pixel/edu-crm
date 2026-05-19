import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { AssessmentRepository } from './assessment.repository';
import { PgPoolService } from './pg-pool.service';
import {
  Assessment,
  StudentAssessmentResult,
} from '../assessment/assessment.service';

describe('AssessmentRepository', () => {
  let repo: AssessmentRepository;
  let pg: { tenantQuery: jest.Mock; query: jest.Mock; withClient: jest.Mock; transaction: jest.Mock };

  const TENANT = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const ASMT: Assessment = {
    id: 'as000000000000000000000000000A01',
    teacherId: 'teach000000000000000000000000A001',
    title: '5 月月考',
    subject: '英语',
    assessmentType: '月考',
    totalScore: 100,
    status: 'draft',
    createdAt: new Date('2026-05-02'),
  };
  const ASMT_ROW = {
    id: ASMT.id,
    teacher_id: ASMT.teacherId,
    title: ASMT.title,
    subject: ASMT.subject,
    assessment_type: ASMT.assessmentType,
    total_score: '100.00',
    scheduled_at: null,
    status: 'draft',
    created_at: ASMT.createdAt,
  };
  const RESULT: StudentAssessmentResult = {
    id: 'sar00000000000000000000000000A01',
    assessmentId: ASMT.id,
    studentId: 'stu00000000000000000000000000A001',
    score: 92,
    knowledgeBreakdown: [{ name: '阅读', score: 38, total: 40 }],
    recordedAt: new Date('2026-05-03'),
    recordedByUserId: 'u' + 'x'.repeat(31),
  };
  const RESULT_ROW = {
    id: RESULT.id,
    assessment_id: RESULT.assessmentId,
    student_id: RESULT.studentId,
    score: '92.00',
    rank_in_class: null,
    knowledge_breakdown: JSON.stringify(RESULT.knowledgeBreakdown),
    teacher_comment: null,
    recorded_at: RESULT.recordedAt,
    recorded_by_user_id: RESULT.recordedByUserId,
  };

  beforeEach(async () => {
    pg = { tenantQuery: jest.fn(), query: jest.fn(), withClient: jest.fn(), transaction: jest.fn() };
    const m = await Test.createTestingModule({
      providers: [AssessmentRepository, { provide: PgPoolService, useValue: pg }],
    }).compile();
    repo = m.get(AssessmentRepository);
  });

  it('insertAssessment maps numeric totalScore', async () => {
    pg.tenantQuery.mockResolvedValueOnce([ASMT_ROW]);
    const r = await repo.insertAssessment(TENANT, ASMT);
    expect(r.totalScore).toBe(100);
    expect(typeof r.totalScore).toBe('number');
  });

  it('listAssessmentsByTeacher orders by scheduled_at then created_at', async () => {
    pg.tenantQuery.mockResolvedValueOnce([ASMT_ROW]);
    await repo.listAssessmentsByTeacher(TENANT, ASMT.teacherId);
    const sql = pg.tenantQuery.mock.calls[0][1] as string;
    expect(sql).toContain('ORDER BY COALESCE(scheduled_at, created_at) DESC');
  });

  it('setAssessmentStatus NotFoundException on missing', async () => {
    pg.tenantQuery.mockResolvedValueOnce([]);
    await expect(
      repo.setAssessmentStatus(TENANT, 'nope', 'published'),
    ).rejects.toThrow(NotFoundException);
  });

  it('insertResult serializes JSONB knowledge_breakdown', async () => {
    pg.tenantQuery.mockResolvedValueOnce([RESULT_ROW]);
    await repo.insertResult(TENANT, RESULT);
    const params = pg.tenantQuery.mock.calls[0][2];
    expect(params[5]).toBe(JSON.stringify(RESULT.knowledgeBreakdown));
  });

  it('findResultByAssessmentStudent parses score as number', async () => {
    pg.tenantQuery.mockResolvedValueOnce([RESULT_ROW]);
    const r = await repo.findResultByAssessmentStudent(
      TENANT,
      ASMT.id,
      RESULT.studentId,
    );
    expect(r?.score).toBe(92);
    expect(typeof r?.score).toBe('number');
  });

  it('listResultsByAssessment orders by score desc', async () => {
    pg.tenantQuery.mockResolvedValueOnce([RESULT_ROW]);
    await repo.listResultsByAssessment(TENANT, ASMT.id);
    const sql = pg.tenantQuery.mock.calls[0][1] as string;
    expect(sql).toContain('ORDER BY score DESC NULLS LAST');
  });

  it('updateRankings runs in transaction; counts updated rows', async () => {
    let updateCount = 0;
    pg.transaction.mockImplementationOnce(async (fn: any) => {
      const client = {
        query: jest.fn(async (sql: string) => {
          if (sql.includes('UPDATE student_assessment_results')) {
            updateCount += 1;
            return { rows: [], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
      };
      return fn(client);
    });
    const c = await repo.updateRankings(TENANT, [
      { id: 'a', rankInClass: 1 },
      { id: 'b', rankInClass: 2 },
    ]);
    expect(c).toBe(2);
    expect(updateCount).toBe(2);
  });

  it('updateRankings returns 0 for empty input without DB call', async () => {
    const c = await repo.updateRankings(TENANT, []);
    expect(c).toBe(0);
    expect(pg.transaction).not.toHaveBeenCalled();
  });

  it('updateRankings propagates error so transaction helper rolls back', async () => {
    pg.transaction.mockImplementationOnce(async (fn: any) => {
      const client = {
        query: jest.fn(async (sql: string) => {
          if (sql.includes('UPDATE student_assessment_results')) throw new Error('boom');
          return { rows: [], rowCount: 0 };
        }),
      };
      return fn(client);
    });
    await expect(
      repo.updateRankings(TENANT, [{ id: 'a', rankInClass: 1 }]),
    ).rejects.toThrow('boom');
  });
});
