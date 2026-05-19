/**
 * learning-profile.repository.integration.spec.ts — Day 3 Phase B.L2 priority spec #9
 *
 * 触发：V15 学情累计档案（cron 每日 0:00 增量重算）
 *   - student_learning_profile — 一学员一行 PRIMARY KEY (student_id)
 *   - UPSERT ON CONFLICT (student_id) DO UPDATE
 *   - knowledge_mastery / weakness_points / strength_points JSONB 数组
 *   - V44 软删联动：listAllStudentIds 仅返 deleted_at IS NULL
 *
 * 必测 case：
 *   1. upsert 首次 INSERT — JSONB 数组序列化
 *   2. upsert 第 2 次 — ON CONFLICT (student_id) DO UPDATE 覆盖
 *   3. findByStudent — 反序列化 JSONB 数组
 *   4. listAllStudentIds — V44 deleted_at IS NULL 过滤
 *   5. listStale — last_updated_at < threshold 用于 cron 增量重算
 *   6. avg_homework_grade / avg_assessment_score 可 NULL
 *   7. 跨 student 隔离 — A 的 profile 不影响 B
 *   8. schema drift 反例: DROP knowledge_mastery → INSERT 必失败
 */

import { Pool } from 'pg';
import {
  createTestSchema,
  dropTestSchema,
  getTestPool,
  closeTestPool,
  runInSchema,
  seedCampus,
  seedAdminUser,
  seedCustomer,
  seedStudent,
  testUlid,
} from './setup';
import { LearningProfileRepository } from '../../src/modules/db/learning-profile.repository';
import { PgPoolService } from '../../src/modules/db/pg-pool.service';

describe('LearningProfileRepository [integration, real PG, V15]', () => {
  let pool: Pool;
  let schema: string;
  let repo: LearningProfileRepository;
  let pgService: PgPoolService;
  let campusId: string;
  let adminId: string;
  let studentA: string;
  let studentB: string;
  let studentDeleted: string;

  const mockConfig = {
    get: (key: string, def?: any) => {
      const map: Record<string, any> = {
        DB_HOST: 'localhost',
        DB_PORT: '5433',
        DB_USER: 'eduapp',
        DB_PASSWORD: 'testpassword',
        DB_NAME: 'edu_test',
        DB_POOL_MAX: '5',
        DB_STATEMENT_TIMEOUT_MS: '10000',
      };
      return map[key] ?? def;
    },
  };

  beforeAll(async () => {
    pool = getTestPool();
    schema = await createTestSchema('learn-profile');
    pgService = new PgPoolService(mockConfig as any);
    repo = new LearningProfileRepository(pgService);

    const campus = await seedCampus(schema);
    campusId = campus.id;
    const admin = await seedAdminUser(schema, campusId);
    adminId = admin.id;

    const custA = await seedCustomer(schema, campusId, adminId);
    studentA = (await seedStudent(schema, custA.id)).id;
    const custB = await seedCustomer(schema, campusId, adminId);
    studentB = (await seedStudent(schema, custB.id)).id;
    const custD = await seedCustomer(schema, campusId, adminId);
    studentDeleted = (await seedStudent(schema, custD.id)).id;
    // 软删 studentDeleted（V44）
    await runInSchema(schema, async (c) => {
      await c.query(
        `UPDATE ${schema}.students SET deleted_at = NOW() WHERE id = $1`,
        [studentDeleted],
      );
    });
  }, 30000);

  afterAll(async () => {
    await pgService.onModuleDestroy();
    await dropTestSchema(schema);
    await closeTestPool();
  });

  // ----------------------------------------------------------------
  // Case 1: upsert 首次 INSERT
  // ----------------------------------------------------------------
  it('upsert 首次 INSERT — JSONB 数组序列化', async () => {
    const km = [
      { topic: '加法', mastery: 0.9 },
      { topic: '减法', mastery: 0.8 },
    ];
    const wp = ['乘法不够熟练'];
    const sp = ['加法运算非常熟练'];
    const result = await repo.upsert(schema, {
      studentId: studentA,
      totalLessons: 10,
      totalHomeworks: 5,
      totalAssessments: 2,
      attendanceRate: 0.95,
      avgHomeworkGrade: 'B+',
      avgAssessmentScore: 85.5,
      knowledgeMastery: km,
      weaknessPoints: wp,
      strengthPoints: sp,
      lastUpdatedAt: new Date('2026-05-19T00:00:00Z'),
    } as any);
    expect(result.studentId).toBe(studentA);
    expect(result.totalLessons).toBe(10);
    expect(result.attendanceRate).toBe(0.95);
    expect(result.avgAssessmentScore).toBe(85.5);
    expect(result.knowledgeMastery).toEqual(km);
    expect(result.weaknessPoints).toEqual(wp);
    expect(result.strengthPoints).toEqual(sp);
  });

  // ----------------------------------------------------------------
  // Case 2: upsert 第 2 次 — ON CONFLICT DO UPDATE
  // ----------------------------------------------------------------
  it('upsert 第 2 次 — ON CONFLICT (student_id) DO UPDATE 覆盖', async () => {
    const km2 = [{ topic: '乘法', mastery: 0.95 }];
    const r2 = await repo.upsert(schema, {
      studentId: studentA, // 同 Case 1
      totalLessons: 15, // 增量
      totalHomeworks: 8,
      totalAssessments: 3,
      attendanceRate: 0.98,
      avgHomeworkGrade: 'A',
      avgAssessmentScore: 92,
      knowledgeMastery: km2,
      weaknessPoints: [],
      strengthPoints: ['乘法、加法'],
      lastUpdatedAt: new Date('2026-05-20T00:00:00Z'),
    } as any);
    expect(r2.totalLessons).toBe(15);
    expect(r2.attendanceRate).toBe(0.98);
    expect(r2.avgAssessmentScore).toBe(92);
    expect(r2.knowledgeMastery).toEqual(km2);
    expect(r2.weaknessPoints).toEqual([]);
  });

  // ----------------------------------------------------------------
  // Case 3: findByStudent
  // ----------------------------------------------------------------
  it('findByStudent — 反序列化 JSONB + 不存在返 null', async () => {
    const found = await repo.findByStudent(schema, studentA);
    expect(found).not.toBeNull();
    expect(found!.totalLessons).toBe(15); // Case 2 后

    const fakeStudent = testUlid();
    const notFound = await repo.findByStudent(schema, fakeStudent);
    expect(notFound).toBeNull();
  });

  // ----------------------------------------------------------------
  // Case 4: listAllStudentIds — V44 软删过滤
  // ----------------------------------------------------------------
  it('listAllStudentIds — V44 deleted_at IS NULL 过滤', async () => {
    const ids = await repo.listAllStudentIds(schema);
    expect(ids).toContain(studentA);
    expect(ids).toContain(studentB);
    expect(ids).not.toContain(studentDeleted); // 软删的不返
  });

  // ----------------------------------------------------------------
  // Case 5: listStale — last_updated_at < threshold
  // ----------------------------------------------------------------
  it('listStale — last_updated_at < threshold 用于 cron 增量重算', async () => {
    // 灌一个 studentB 的 profile（last_updated_at 在过去）
    await repo.upsert(schema, {
      studentId: studentB,
      totalLessons: 5,
      totalHomeworks: 2,
      totalAssessments: 1,
      attendanceRate: 0.9,
      knowledgeMastery: [],
      weaknessPoints: [],
      strengthPoints: [],
      lastUpdatedAt: new Date('2026-04-01T00:00:00Z'), // 旧
    } as any);

    // listStale threshold = 2026-05-01 → 应返 studentB（4 月）但不返 studentA（5 月 Case 2 后）
    const stale = await repo.listStale(schema, new Date('2026-05-01T00:00:00Z'));
    expect(stale.find((p) => p.studentId === studentB)).toBeDefined();
    expect(stale.find((p) => p.studentId === studentA)).toBeUndefined();
  });

  // ----------------------------------------------------------------
  // Case 6: avg_homework_grade / avg_assessment_score NULL
  // ----------------------------------------------------------------
  it('avg_homework_grade / avg_assessment_score 可 NULL（新生还没作业 / 测评）', async () => {
    const custC = await seedCustomer(schema, campusId, adminId);
    const stuC = (await seedStudent(schema, custC.id)).id;
    const result = await repo.upsert(schema, {
      studentId: stuC,
      totalLessons: 1,
      totalHomeworks: 0,
      totalAssessments: 0,
      attendanceRate: 1.0,
      avgHomeworkGrade: null,
      avgAssessmentScore: null,
      knowledgeMastery: [],
      weaknessPoints: [],
      strengthPoints: [],
      lastUpdatedAt: new Date(),
    } as any);
    expect(result.avgHomeworkGrade).toBeUndefined();
    expect(result.avgAssessmentScore).toBeUndefined();
  });

  // ----------------------------------------------------------------
  // Case 7: 跨 student 隔离
  // ----------------------------------------------------------------
  it('跨 student 隔离 — A profile 更新不影响 B', async () => {
    // 拿 B profile 当前状态
    const bBefore = await repo.findByStudent(schema, studentB);
    expect(bBefore).not.toBeNull();

    // 更新 A
    await repo.upsert(schema, {
      studentId: studentA,
      totalLessons: 99,
      totalHomeworks: 99,
      totalAssessments: 99,
      attendanceRate: 0.99,
      knowledgeMastery: [],
      weaknessPoints: [],
      strengthPoints: [],
      lastUpdatedAt: new Date(),
    } as any);

    // B 应未变
    const bAfter = await repo.findByStudent(schema, studentB);
    expect(bAfter!.totalLessons).toBe(bBefore!.totalLessons);
  });

  // ----------------------------------------------------------------
  // Case 8: schema drift — DROP knowledge_mastery → INSERT 必失败
  // ----------------------------------------------------------------
  it('schema drift 反例: DROP knowledge_mastery → INSERT 必失败 42703', async () => {
    const driftSchema = await createTestSchema('learn-drift');
    try {
      const cam = await seedCampus(driftSchema);
      const ad = await seedAdminUser(driftSchema, cam.id);
      const cust = await seedCustomer(driftSchema, cam.id, ad.id);
      const stu = await seedStudent(driftSchema, cust.id);

      await runInSchema(driftSchema, async (c) => {
        await c.query(
          `ALTER TABLE ${driftSchema}.student_learning_profile DROP COLUMN knowledge_mastery`,
        );
      });

      await expect(
        repo.upsert(driftSchema, {
          studentId: stu.id,
          totalLessons: 1,
          totalHomeworks: 0,
          totalAssessments: 0,
          attendanceRate: 1,
          knowledgeMastery: [],
          weaknessPoints: [],
          strengthPoints: [],
          lastUpdatedAt: new Date(),
        } as any),
      ).rejects.toThrow(/42703|knowledge_mastery|column|does not exist/i);
    } finally {
      await dropTestSchema(driftSchema);
    }
  });
});
