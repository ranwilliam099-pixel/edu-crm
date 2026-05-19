/**
 * assessment.repository.integration.spec.ts — Day 3 Phase B.L2 priority spec #8
 *
 * 触发：V14 测评/考试两表
 *   - assessments — 测评定义（teacher 创建）
 *   - student_assessment_results — 学员成绩（含 knowledge_breakdown JSONB）
 *   - updateRankings — 事务批量 UPDATE rank_in_class
 *
 * 必测 case：
 *   1. insertAssessment + findAssessmentById
 *   2. listAssessmentsByTeacher — ORDER draft_at DESC + COALESCE created_at
 *   3. setAssessmentStatus + NotFound
 *   4. insertResult + findResultByAssessmentStudent
 *   5. listResultsByAssessment — ORDER score DESC NULLS LAST
 *   6. listResultsByStudent — ORDER recorded_at DESC NULLS LAST
 *   7. updateRankings — 事务批量 UPDATE rank_in_class
 *   8. updateRankings 0 输入 → 0 affected（早返）
 *   9. schema drift 反例: DROP score 列 → INSERT 必失败
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
import { AssessmentRepository } from '../../src/modules/db/assessment.repository';
import { PgPoolService } from '../../src/modules/db/pg-pool.service';

describe('AssessmentRepository [integration, real PG, V14]', () => {
  let pool: Pool;
  let schema: string;
  let repo: AssessmentRepository;
  let pgService: PgPoolService;
  let campusId: string;
  let adminId: string;
  let teacherId: string;
  let studentA: string;
  let studentB: string;

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
    schema = await createTestSchema('assessment');
    pgService = new PgPoolService(mockConfig as any);
    repo = new AssessmentRepository(pgService);

    const campus = await seedCampus(schema);
    campusId = campus.id;
    const admin = await seedAdminUser(schema, campusId);
    adminId = admin.id;

    teacherId = testUlid();
    await runInSchema(schema, async (c) => {
      await c.query(
        `INSERT INTO ${schema}.teachers
           (id, name, phone, status, created_by, updated_by, campus_id)
         VALUES ($1, '考试老师', '13900001200', '在职', $2, $2, $3)`,
        [teacherId, adminId, campusId],
      );
    });

    const custA = await seedCustomer(schema, campusId, adminId);
    studentA = (await seedStudent(schema, custA.id)).id;
    const custB = await seedCustomer(schema, campusId, adminId);
    studentB = (await seedStudent(schema, custB.id)).id;
  }, 30000);

  afterAll(async () => {
    await pgService.onModuleDestroy();
    await dropTestSchema(schema);
    await closeTestPool();
  });

  // ----------------------------------------------------------------
  // Case 1: insertAssessment + findAssessmentById
  // ----------------------------------------------------------------
  it('insertAssessment + findAssessmentById — RETURNING 全字段', async () => {
    const aid = testUlid();
    const created = await repo.insertAssessment(schema, {
      id: aid,
      teacherId,
      title: '期中测评',
      subject: '数学',
      assessmentType: '期中',
      totalScore: 100,
      draftAt: new Date('2026-05-25T09:00:00Z'),
      status: 'draft',
      createdAt: new Date(),
    } as any);
    expect(created.id).toBe(aid);
    expect(created.title).toBe('期中测评');
    expect(created.totalScore).toBe(100);

    const found = await repo.findAssessmentById(schema, aid);
    expect(found).not.toBeNull();
    expect(found!.title).toBe('期中测评');
  });

  // ----------------------------------------------------------------
  // Case 2: listAssessmentsByTeacher — COALESCE ORDER
  // ----------------------------------------------------------------
  it('listAssessmentsByTeacher — ORDER COALESCE(draft_at, created_at) DESC', async () => {
    // 灌 2 个 — 一个有 draft_at（远未来），一个无（用 created_at 近期）
    await repo.insertAssessment(schema, {
      id: testUlid(),
      teacherId,
      title: '远期测评',
      subject: '语文',
      assessmentType: '期末',
      totalScore: 100,
      draftAt: new Date('2026-12-01T00:00:00Z'),
      status: 'draft',
      createdAt: new Date('2026-05-01T00:00:00Z'),
    } as any);
    await repo.insertAssessment(schema, {
      id: testUlid(),
      teacherId,
      title: '无日期但近期创建',
      subject: '语文',
      assessmentType: '单元测',
      totalScore: 30,
      draftAt: null,
      status: 'draft',
      createdAt: new Date(),
    } as any);

    const items = await repo.listAssessmentsByTeacher(schema, teacherId);
    expect(items.length).toBeGreaterThanOrEqual(3);
    // 验证：第一项的 COALESCE(draft_at, created_at) 应是最远的（远期测评 2026-12-01）
    expect(items[0].title).toBe('远期测评');
  });

  // ----------------------------------------------------------------
  // Case 3: setAssessmentStatus
  // ----------------------------------------------------------------
  it('setAssessmentStatus + NotFound', async () => {
    const items = await repo.listAssessmentsByTeacher(schema, teacherId);
    const aid = items[0].id;
    const updated = await repo.setAssessmentStatus(schema, aid, 'closed');
    expect(updated.status).toBe('closed');

    await expect(repo.setAssessmentStatus(schema, testUlid(), 'closed')).rejects.toThrow(
      /not.*found/i,
    );
  });

  // ----------------------------------------------------------------
  // Case 4: insertResult + findResultByAssessmentStudent
  // ----------------------------------------------------------------
  it('insertResult + findResultByAssessmentStudent — knowledge_breakdown JSONB', async () => {
    const aid = testUlid();
    await repo.insertAssessment(schema, {
      id: aid,
      teacherId,
      title: '单元测验',
      subject: '数学',
      assessmentType: '单元测',
      totalScore: 100,
      draftAt: new Date(),
      status: 'draft',
      createdAt: new Date(),
    } as any);

    const rid = testUlid();
    const knowledgeBreakdown = { 加法: 18, 减法: 16, 乘法: 14, 除法: 12 };
    const result = await repo.insertResult(schema, {
      id: rid,
      assessmentId: aid,
      studentId: studentA,
      score: 60,
      rankInClass: null,
      knowledgeBreakdown,
      teacherComment: '基础需巩固',
      recordedAt: new Date(),
      recordedByUserId: teacherId,
    } as any);
    expect(result.id).toBe(rid);
    expect(result.score).toBe(60);

    const found = await repo.findResultByAssessmentStudent(schema, aid, studentA);
    expect(found).not.toBeNull();
    expect(found!.knowledgeBreakdown).toEqual(knowledgeBreakdown);
  });

  // ----------------------------------------------------------------
  // Case 5: listResultsByAssessment — ORDER score DESC NULLS LAST
  // ----------------------------------------------------------------
  it('listResultsByAssessment — ORDER score DESC NULLS LAST', async () => {
    const aid = testUlid();
    await repo.insertAssessment(schema, {
      id: aid,
      teacherId,
      title: 'rank test',
      subject: '数学',
      assessmentType: '单元测',
      totalScore: 100,
      draftAt: new Date(),
      status: 'closed',
      createdAt: new Date(),
    } as any);

    // 灌 3 results：80 / NULL / 60 — 期望顺序 80, 60, NULL
    await repo.insertResult(schema, {
      id: testUlid(),
      assessmentId: aid,
      studentId: studentA,
      score: 80,
      recordedAt: new Date(),
      recordedByUserId: teacherId,
    } as any);
    await repo.insertResult(schema, {
      id: testUlid(),
      assessmentId: aid,
      studentId: studentB,
      score: null, // 缺考
      recordedAt: new Date(),
      recordedByUserId: teacherId,
    } as any);

    // 第 3 个 — 灌一个新 student（避免 unique 冲突）
    const custC = await seedCustomer(schema, campusId, adminId);
    const stuC = (await seedStudent(schema, custC.id)).id;
    await repo.insertResult(schema, {
      id: testUlid(),
      assessmentId: aid,
      studentId: stuC,
      score: 60,
      recordedAt: new Date(),
      recordedByUserId: teacherId,
    } as any);

    const list = await repo.listResultsByAssessment(schema, aid);
    expect(list.length).toBe(3);
    expect(list[0].score).toBe(80);
    expect(list[1].score).toBe(60);
    expect(list[2].score).toBeUndefined(); // null
  });

  // ----------------------------------------------------------------
  // Case 6: listResultsByStudent — ORDER recorded_at DESC
  // ----------------------------------------------------------------
  it('listResultsByStudent — ORDER recorded_at DESC NULLS LAST', async () => {
    const list = await repo.listResultsByStudent(schema, studentA);
    expect(list.length).toBeGreaterThanOrEqual(1);
    // 单调递减 recorded_at
    for (let i = 1; i < list.length; i++) {
      if (list[i].recordedAt && list[i - 1].recordedAt) {
        expect(list[i - 1].recordedAt!.getTime()).toBeGreaterThanOrEqual(
          list[i].recordedAt!.getTime(),
        );
      }
    }
  });

  // ----------------------------------------------------------------
  // Case 7: updateRankings — 批量 UPDATE rank_in_class
  // ----------------------------------------------------------------
  it('updateRankings — 事务批量 UPDATE rank_in_class', async () => {
    // 用 Case 5 灌的 results
    const assessmentRows = await runInSchema(schema, async (c) => {
      const r = await c.query<{ id: string }>(
        `SELECT a.id FROM assessments a WHERE a.title = 'rank test' LIMIT 1`,
      );
      return r.rows;
    });
    const aid = assessmentRows[0].id;
    const results = await repo.listResultsByAssessment(schema, aid);
    expect(results.length).toBe(3);

    // 按 score 顺序 update rankings (1 = 80, 2 = 60, 3 = null)
    const rankings = results.map((r, idx) => ({ id: r.id, rankInClass: idx + 1 }));
    const affected = await repo.updateRankings(schema, rankings);
    expect(affected).toBe(3);

    // 验证 PG 状态
    const updated = await repo.listResultsByAssessment(schema, aid);
    expect(updated[0].rankInClass).toBe(1); // 80
    expect(updated[1].rankInClass).toBe(2); // 60
    expect(updated[2].rankInClass).toBe(3); // null
  });

  // ----------------------------------------------------------------
  // Case 8: updateRankings 0 输入 → 早返 0
  // ----------------------------------------------------------------
  it('updateRankings 空数组 → 0 affected (早返)', async () => {
    const affected = await repo.updateRankings(schema, []);
    expect(affected).toBe(0);
  });

  // ----------------------------------------------------------------
  // Case 9: schema drift — DROP score → INSERT 必失败
  // ----------------------------------------------------------------
  it('schema drift 反例: DROP score 列 → INSERT 必失败 42703', async () => {
    const driftSchema = await createTestSchema('assess-drift');
    try {
      // 灌 minimum deps
      const cam = await seedCampus(driftSchema);
      const ad = await seedAdminUser(driftSchema, cam.id);
      const tch = testUlid();
      await runInSchema(driftSchema, async (c) => {
        await c.query(
          `INSERT INTO ${driftSchema}.teachers
             (id, name, phone, status, created_by, updated_by, campus_id)
           VALUES ($1, '老师', '13900008812', '在职', $2, $2, $3)`,
          [tch, ad.id, cam.id],
        );
        await c.query(
          `ALTER TABLE ${driftSchema}.student_assessment_results DROP COLUMN score`,
        );
      });
      const cust = await seedCustomer(driftSchema, cam.id, ad.id);
      const stu = await seedStudent(driftSchema, cust.id);
      // 先 INSERT assessment
      const aid = testUlid();
      await repo.insertAssessment(driftSchema, {
        id: aid,
        teacherId: tch,
        title: 'drift',
        subject: '数学',
        assessmentType: '单元测',
        totalScore: 100,
        draftAt: new Date(),
        status: 'draft',
        createdAt: new Date(),
      } as any);

      // INSERT result 必失败（缺 score 列）
      await expect(
        repo.insertResult(driftSchema, {
          id: testUlid(),
          assessmentId: aid,
          studentId: stu.id,
          score: 80,
          recordedAt: new Date(),
          recordedByUserId: tch,
        } as any),
      ).rejects.toThrow(/42703|score|column|does not exist/i);
    } finally {
      await dropTestSchema(driftSchema);
    }
  });
});
