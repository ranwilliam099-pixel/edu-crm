/**
 * homework.repository.integration.spec.ts — Day 3 Phase B.L2 priority spec #7
 *
 * 触发：V13 作业管理 + C 端家长视角 img-sec-check
 *   - homework_assignments + assignment_recipients + homework_submissions 三表
 *   - 事务原子：insertAssignmentWithRecipients 必须 1 个事务（assignment + recipients）
 *   - ON CONFLICT (assignment_id, student_id) DO UPDATE — submission 重提覆盖
 *
 * 必测 case：
 *   1. insertAssignmentWithRecipients 事务原子（含 recipients 数组）
 *   2. findAssignmentById ARRAY 反查 recipients
 *   3. listAssignmentsByStudent — JOIN assignment_recipients + status='published'
 *   4. listAssignmentsByTeacher
 *   5. setAssignmentStatus 状态切换 + NotFound
 *   6. insertSubmission ON CONFLICT 重提覆盖
 *   7. findSubmissionByAssignmentStudent 反查
 *   8. attachments JSONB 序列化（含 img-sec-check 字段）
 *   9. schema drift 反例: DROP assignment_recipients 表 → INSERT 必失败
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
import { HomeworkRepository } from '../../src/modules/db/homework.repository';
import { PgPoolService } from '../../src/modules/db/pg-pool.service';

describe('HomeworkRepository [integration, real PG, V13]', () => {
  let pool: Pool;
  let schema: string;
  let repo: HomeworkRepository;
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
    schema = await createTestSchema('homework');
    pgService = new PgPoolService(mockConfig as any);
    repo = new HomeworkRepository(pgService);

    const campus = await seedCampus(schema);
    campusId = campus.id;
    const admin = await seedAdminUser(schema, campusId);
    adminId = admin.id;

    // teacher
    teacherId = testUlid();
    await runInSchema(schema, async (c) => {
      await c.query(
        `INSERT INTO ${schema}.teachers
           (id, name, phone, status, created_by, updated_by, campus_id)
         VALUES ($1, '作业老师', '13900001100', '在职', $2, $2, $3)`,
        [teacherId, adminId, campusId],
      );
    });

    // 2 students
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
  // Case 1: 事务原子 insertAssignmentWithRecipients
  // ----------------------------------------------------------------
  it('insertAssignmentWithRecipients 事务原子 — 同时 INSERT assignment + N recipients', async () => {
    const aid = testUlid();
    const created = await repo.insertAssignmentWithRecipients(schema, {
      id: aid,
      scheduleId: null,
      teacherId,
      title: '作业 P12-15',
      content: '完成 P12-15 习题',
      attachments: [
        { url: 'https://cos.com/a.jpg', type: 'image/jpeg', filename: 'a.jpg' },
      ],
      dueAt: new Date('2026-05-25T22:00:00Z'),
      difficulty: '中',
      status: 'published',
      recipientStudentIds: [studentA, studentB],
      createdAt: new Date(),
    } as any);
    expect(created.id).toBe(aid);

    // 验证 assignment_recipients 2 行
    const cnt = await runInSchema(schema, async (c) => {
      const r = await c.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM assignment_recipients WHERE assignment_id = $1`,
        [aid],
      );
      return parseInt(r.rows[0].count, 10);
    });
    expect(cnt).toBe(2);
  });

  // ----------------------------------------------------------------
  // Case 2: findAssignmentById ARRAY 反查
  // ----------------------------------------------------------------
  it('findAssignmentById — ARRAY 反查 recipients + attachments JSONB', async () => {
    const items = await repo.listAssignmentsByTeacher(schema, teacherId, { limit: 10 });
    expect(items.length).toBeGreaterThanOrEqual(1);
    const a = items[0];
    expect(a.teacherId).toBe(teacherId);
    expect(a.recipientStudentIds).toEqual(expect.arrayContaining([studentA, studentB]));
    expect(a.recipientStudentIds.length).toBe(2);
    expect(a.attachments).toEqual([
      { url: 'https://cos.com/a.jpg', type: 'image/jpeg', filename: 'a.jpg' },
    ]);

    // 通过 findAssignmentById 二次确认
    const f = await repo.findAssignmentById(schema, a.id);
    expect(f).not.toBeNull();
    expect(f!.title).toBe(a.title);
  });

  // ----------------------------------------------------------------
  // Case 3: listAssignmentsByStudent — JOIN + status='published'
  // ----------------------------------------------------------------
  it('listAssignmentsByStudent — JOIN assignment_recipients + 仅 status=published', async () => {
    // Case 1 中 published 作业 → A/B 都应见
    const a = await repo.listAssignmentsByStudent(schema, studentA);
    expect(a.length).toBeGreaterThanOrEqual(1);
    expect(a.every((x) => x.status === 'published')).toBe(true);

    // 灌一个 draft 状态作业 — 不应在 listByStudent 里
    const draftId = testUlid();
    await repo.insertAssignmentWithRecipients(schema, {
      id: draftId,
      scheduleId: null,
      teacherId,
      title: 'draft 作业',
      status: 'draft',
      recipientStudentIds: [studentA],
      createdAt: new Date(),
    } as any);

    const a2 = await repo.listAssignmentsByStudent(schema, studentA);
    expect(a2.find((x) => x.id === draftId)).toBeUndefined();
  });

  // ----------------------------------------------------------------
  // Case 4: listAssignmentsByTeacher
  // ----------------------------------------------------------------
  it('listAssignmentsByTeacher — 按 teacher_id 过滤 + ORDER created_at DESC', async () => {
    const items = await repo.listAssignmentsByTeacher(schema, teacherId, { limit: 50 });
    expect(items.length).toBeGreaterThanOrEqual(2); // Case 1 + Case 3 灌的 2 个
    items.forEach((a) => expect(a.teacherId).toBe(teacherId));
  });

  // ----------------------------------------------------------------
  // Case 5: setAssignmentStatus + NotFound
  // ----------------------------------------------------------------
  it('setAssignmentStatus draft→published / 不存在 id → NotFoundException', async () => {
    // 找一个 draft 作业
    const draftRows = await runInSchema(schema, async (c) => {
      const r = await c.query<{ id: string }>(
        `SELECT id FROM homework_assignments WHERE status = 'draft' LIMIT 1`,
      );
      return r.rows;
    });
    expect(draftRows.length).toBeGreaterThanOrEqual(1);

    const updated = await repo.setAssignmentStatus(schema, draftRows[0].id, 'published');
    expect(updated.status).toBe('published');

    // NotFound：不存在 id
    await expect(
      repo.setAssignmentStatus(schema, testUlid(), 'archived'),
    ).rejects.toThrow(/not.*found/i);
  });

  // ----------------------------------------------------------------
  // Case 6: insertSubmission ON CONFLICT 重提覆盖
  // ----------------------------------------------------------------
  it('insertSubmission ON CONFLICT (assignment_id, student_id) DO UPDATE 重提覆盖', async () => {
    // 找一个已 published 的 assignment
    const aid = (await repo.listAssignmentsByTeacher(schema, teacherId, { limit: 1 }))[0].id;

    // 第 1 次提交
    const sid = testUlid();
    const sub1 = await repo.insertSubmission(schema, {
      id: sid,
      assignmentId: aid,
      studentId: studentA,
      submittedByParentId: null,
      content: '第 1 版答案',
      attachments: [{ url: 'https://cos.com/v1.jpg', type: 'image/jpeg', filename: 'v1.jpg' }],
      status: 'submitted',
      submittedAt: new Date(),
    } as any);
    expect(sub1.id).toBe(sid);
    expect(sub1.content).toBe('第 1 版答案');

    // 重提（同 assignment_id + student_id） — content 应被覆盖
    const sub2 = await repo.insertSubmission(schema, {
      id: testUlid(), // 新 id（但 ON CONFLICT 会保留原 id？）
      assignmentId: aid,
      studentId: studentA,
      submittedByParentId: null,
      content: '第 2 版答案',
      attachments: null,
      status: 'submitted',
      submittedAt: new Date(),
    } as any);
    expect(sub2.content).toBe('第 2 版答案');
  });

  // ----------------------------------------------------------------
  // Case 7: findSubmissionByAssignmentStudent
  // ----------------------------------------------------------------
  it('findSubmissionByAssignmentStudent — 反查 unique 行', async () => {
    const aid = (await repo.listAssignmentsByTeacher(schema, teacherId, { limit: 1 }))[0].id;
    const found = await repo.findSubmissionByAssignmentStudent(schema, aid, studentA);
    expect(found).not.toBeNull();
    expect(found!.assignmentId).toBe(aid);
    expect(found!.studentId).toBe(studentA);
    expect(found!.content).toBe('第 2 版答案'); // Case 6 最后版本

    // 不存在 (assignment_id, student_id) 组合
    const notFound = await repo.findSubmissionByAssignmentStudent(schema, aid, studentB);
    expect(notFound).toBeNull();
  });

  // ----------------------------------------------------------------
  // Case 8: attachments JSONB 序列化（含 img-sec-check trace 字段）
  // ----------------------------------------------------------------
  it('attachments JSONB — 反序列化保结构（含 img-sec-check trace 字段）', async () => {
    const aid = testUlid();
    const richAttachments = [
      {
        url: 'https://cos.com/img1.jpg',
        type: 'image/jpeg',
        filename: 'img1.jpg',
        // img-sec-check 调用层加的字段（如 traceId）
        msgSecCheckTraceId: 'trace-001',
        msgSecCheckLabel: '100',
      },
    ];
    await repo.insertAssignmentWithRecipients(schema, {
      id: aid,
      scheduleId: null,
      teacherId,
      title: '含 img check 元数据',
      attachments: richAttachments,
      status: 'published',
      recipientStudentIds: [studentA],
      createdAt: new Date(),
    } as any);

    const got = await repo.findAssignmentById(schema, aid);
    expect(got).not.toBeNull();
    expect(got!.attachments).toEqual(richAttachments);
  });

  // ----------------------------------------------------------------
  // Case 9: schema drift — DROP assignment_recipients 表 → INSERT 必失败
  // ----------------------------------------------------------------
  it('schema drift 反例: DROP assignment_recipients 表 → 事务 INSERT 必失败', async () => {
    const driftSchema = await createTestSchema('homework-drift');
    try {
      // seed deps
      const cam = await seedCampus(driftSchema);
      const ad = await seedAdminUser(driftSchema, cam.id);
      const tch = testUlid();
      await runInSchema(driftSchema, async (c) => {
        await c.query(
          `INSERT INTO ${driftSchema}.teachers
             (id, name, phone, status, created_by, updated_by, campus_id)
           VALUES ($1, '老师', '13900008811', '在职', $2, $2, $3)`,
          [tch, ad.id, cam.id],
        );
      });
      const cust = await seedCustomer(driftSchema, cam.id, ad.id);
      const stu = await seedStudent(driftSchema, cust.id);

      // DROP recipients 表
      await runInSchema(driftSchema, async (c) => {
        await c.query(`DROP TABLE ${driftSchema}.assignment_recipients`);
      });

      await expect(
        repo.insertAssignmentWithRecipients(driftSchema, {
          id: testUlid(),
          teacherId: tch,
          title: 'drift',
          status: 'published',
          recipientStudentIds: [stu.id],
          createdAt: new Date(),
        } as any),
      ).rejects.toThrow(/42P01|relation.*does not exist|assignment_recipients/i);
    } finally {
      await dropTestSchema(driftSchema);
    }
  });
});
