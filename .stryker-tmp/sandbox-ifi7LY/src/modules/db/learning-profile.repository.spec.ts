import { Test } from '@nestjs/testing';
import { LearningProfileRepository } from './learning-profile.repository';
import { PgPoolService } from './pg-pool.service';
import { StudentLearningProfile } from '../learning-profile/student-learning-profile.service';

describe('LearningProfileRepository', () => {
  let repo: LearningProfileRepository;
  let pg: { tenantQuery: jest.Mock; query: jest.Mock; withClient: jest.Mock };

  const TENANT = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const PROFILE: StudentLearningProfile = {
    studentId: 'stu00000000000000000000000000A001',
    totalLessons: 12,
    totalHomeworks: 6,
    totalAssessments: 2,
    attendanceRate: 91.67,
    avgHomeworkGrade: 'A',
    avgAssessmentScore: 88.5,
    knowledgeMastery: [
      { name: '函数', mastery: '良好', lessonCount: 4, lastSeenAt: new Date('2026-05-01') },
    ],
    weaknessPoints: [],
    strengthPoints: [
      { name: '函数', mastery: '良好', lessonCount: 4, lastSeenAt: new Date('2026-05-01') },
    ],
    lastUpdatedAt: new Date('2026-05-02T00:00:00Z'),
  };
  const ROW = {
    student_id: PROFILE.studentId,
    total_lessons: 12,
    total_homeworks: 6,
    total_assessments: 2,
    attendance_rate: '91.67',
    avg_homework_grade: 'A',
    avg_assessment_score: '88.50',
    knowledge_mastery: JSON.stringify(PROFILE.knowledgeMastery),
    weakness_points: JSON.stringify(PROFILE.weaknessPoints),
    strength_points: JSON.stringify(PROFILE.strengthPoints),
    last_updated_at: PROFILE.lastUpdatedAt,
  };

  beforeEach(async () => {
    pg = { tenantQuery: jest.fn(), query: jest.fn(), withClient: jest.fn() };
    const m = await Test.createTestingModule({
      providers: [
        LearningProfileRepository,
        { provide: PgPoolService, useValue: pg },
      ],
    }).compile();
    repo = m.get(LearningProfileRepository);
  });

  it('upsert serializes JSONB arrays + uses ON CONFLICT', async () => {
    pg.tenantQuery.mockResolvedValueOnce([ROW]);
    await repo.upsert(TENANT, PROFILE);
    const sql = pg.tenantQuery.mock.calls[0][1] as string;
    const params = pg.tenantQuery.mock.calls[0][2];
    expect(sql).toContain('ON CONFLICT (student_id) DO UPDATE');
    expect(params[7]).toBe(JSON.stringify(PROFILE.knowledgeMastery));
    expect(params[8]).toBe(JSON.stringify(PROFILE.weaknessPoints));
    expect(params[9]).toBe(JSON.stringify(PROFILE.strengthPoints));
  });

  it('upsert returns parsed profile', async () => {
    pg.tenantQuery.mockResolvedValueOnce([ROW]);
    const r = await repo.upsert(TENANT, PROFILE);
    expect(r.totalLessons).toBe(12);
    expect(r.attendanceRate).toBe(91.67);
    expect(r.avgAssessmentScore).toBe(88.5);
    expect(r.knowledgeMastery).toHaveLength(1);
  });

  it('findByStudent returns null when missing', async () => {
    pg.tenantQuery.mockResolvedValueOnce([]);
    expect(await repo.findByStudent(TENANT, 'nope')).toBeNull();
  });

  it('findByStudent handles already-parsed JSONB (object form)', async () => {
    pg.tenantQuery.mockResolvedValueOnce([
      {
        ...ROW,
        knowledge_mastery: PROFILE.knowledgeMastery,
        weakness_points: PROFILE.weaknessPoints,
        strength_points: PROFILE.strengthPoints,
      },
    ]);
    const r = await repo.findByStudent(TENANT, PROFILE.studentId);
    expect(r?.knowledgeMastery).toEqual(PROFILE.knowledgeMastery);
  });

  it('findByStudent maps null avg fields to undefined', async () => {
    pg.tenantQuery.mockResolvedValueOnce([
      { ...ROW, avg_homework_grade: null, avg_assessment_score: null },
    ]);
    const r = await repo.findByStudent(TENANT, PROFILE.studentId);
    expect(r?.avgHomeworkGrade).toBeUndefined();
    expect(r?.avgAssessmentScore).toBeUndefined();
  });

  it('listAllStudentIds returns ID array', async () => {
    pg.tenantQuery.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);
    const ids = await repo.listAllStudentIds(TENANT);
    expect(ids).toEqual(['a', 'b']);
  });

  it('listStale filters by last_updated_at threshold', async () => {
    pg.tenantQuery.mockResolvedValueOnce([ROW]);
    const t = new Date('2026-05-01');
    await repo.listStale(TENANT, t);
    const sql = pg.tenantQuery.mock.calls[0][1] as string;
    expect(sql).toContain('last_updated_at < $1');
    expect(pg.tenantQuery.mock.calls[0][2]).toEqual([t]);
  });
});
