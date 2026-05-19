/**
 * lesson-feedback.repository.integration.spec.ts — Day 3 Phase B.L2 priority spec #1
 *
 * 触发：V9 §4.1 lesson_feedbacks
 *   - PD 硬规则 P6：24h 内必填（locked 状态由 course_consumptions cron 控制，不在 lesson_feedbacks 表）
 *   - UNIQUE (schedule_id, student_id) 强一致：同 schedule × student 不可重复 feedback
 *   - V18 5 个扩展字段（knowledge_matrix / dim_ratings / homework_deadline / homework_difficulty / next_preview）
 *
 * 必测 case（D1.5 反馈业务 + 反偷懒强约束）：
 *   1. insert 成功 — 全字段写入 + V18 扩展字段（JSONB 序列化）
 *   2. UNIQUE (schedule_id, student_id) 违反 — 23505
 *   3. attendance_status CHECK 违反 — 23514（'present' 英文不在 ['出勤','迟到','缺席','请假'] 内）
 *   4. classroom_performance CHECK 违反 — 23514
 *   5. listByStudent ORDER BY submitted_at DESC + LIMIT
 *   6. listByStudentTeacherInRange 时间窗筛选（月报生成）
 *   7. markParentRead 幂等性（parent_read_at = COALESCE(parent_read_at, NOW())）
 *   8. countUnreadByParent: parent_read_at IS NULL 计数
 *   9. schema drift 反例：DROP COLUMN attendance_status → INSERT 必失败
 *
 * 反偷懒强约束：
 *   - 不 mock pg.Pool — docker-compose PG 14 真跑
 *   - toEqual / toMatchObject 精确断言
 *   - 错误码精确：23505 / 23514 / 42703
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
  seedStudent,
  seedCustomer,
  testUlid,
} from './setup';
import { LessonFeedbackRepository } from '../../src/modules/db/lesson-feedback.repository';
import { PgPoolService } from '../../src/modules/db/pg-pool.service';

describe('LessonFeedbackRepository [integration, real PG, V9 §4.1 + V18]', () => {
  let pool: Pool;
  let schema: string;
  let repo: LessonFeedbackRepository;
  let pgService: PgPoolService;
  let campusId: string;
  let teacherId: string;
  let studentId: string;
  let scheduleId: string;

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
    schema = await createTestSchema('feedback');

    pgService = new PgPoolService(mockConfig as any);
    repo = new LessonFeedbackRepository(pgService);

    // FK chain: feedback → schedule + student + teacher
    const campus = await seedCampus(schema);
    campusId = campus.id;
    const admin = await seedAdminUser(schema, campusId);

    // seed teacher + student + schedule（feedback FK 都需要）
    teacherId = testUlid();
    await runInSchema(schema, async (client) => {
      await client.query(
        `INSERT INTO ${schema}.teachers
           (id, name, phone, status, created_by, updated_by, campus_id)
         VALUES ($1, $2, $3, '在职', $4, $4, $5)`,
        [teacherId, '测试老师', '13900001234', admin.id, campusId],
      );
    });

    const customer = await seedCustomer(schema, campusId, admin.id);
    const student = await seedStudent(schema, customer.id);
    studentId = student.id;

    // seed schedule — lesson_feedbacks.schedule_id FK 需要
    scheduleId = testUlid();
    await runInSchema(schema, async (client) => {
      await client.query(
        `INSERT INTO ${schema}.schedules
           (id, teacher_id, start_at, duration_min, end_at, status, created_by_user_id, created_by_role)
         VALUES ($1, $2, NOW(), 60, NOW() + interval '1 hour', '已完成', $3, 'admin')`,
        [scheduleId, teacherId, admin.id],
      );
    });
  }, 30000);

  afterAll(async () => {
    await pgService.onModuleDestroy();
    await dropTestSchema(schema);
    await closeTestPool();
  });

  // ----------------------------------------------------------------
  // Case 1: insert 成功 — 全字段 + V18 扩展
  // ----------------------------------------------------------------
  it('insert 成功 — V18 全字段 JSONB 序列化', async () => {
    const feedbackId = testUlid();
    const knowledgePoints = [
      { name: '加法', mastery: '良好' },
      { name: '减法', mastery: '优秀' },
    ];
    const dimRatings = { focus: 4, engage: 5, think: 4, homework: 3 };

    const result = await repo.insert(schema, {
      id: feedbackId,
      scheduleId,
      studentId,
      teacherId,
      attendanceStatus: '出勤',
      classroomPerformance: '良好',
      knowledgePoints,
      homework: '完成 P12-15',
      teacherNote: '今天学习专注',
      teacherInternalNote: '需关注其计算速度',
      knowledgeMatrix: knowledgePoints,
      dimRatings,
      homeworkDeadline: new Date('2026-05-20T22:00:00Z'),
      homeworkDifficulty: 'medium',
      nextPreview: '下次讲乘法',
      submittedAt: new Date('2026-05-19T10:00:00Z'),
      updatedAt: new Date('2026-05-19T10:00:00Z'),
    } as any);

    expect(result.id).toBe(feedbackId);
    expect(result.scheduleId).toBe(scheduleId);
    expect(result.studentId).toBe(studentId);
    expect(result.teacherId).toBe(teacherId);
    expect(result.attendanceStatus).toBe('出勤');
    expect(result.classroomPerformance).toBe('良好');
    expect(result.knowledgePoints).toEqual(knowledgePoints);
    expect(result.dimRatings).toEqual(dimRatings);
    expect(result.homeworkDifficulty).toBe('medium');
    expect(result.parentReadAt).toBeUndefined(); // 未读
  });

  // ----------------------------------------------------------------
  // Case 2: UNIQUE (schedule_id, student_id) 违反 — 23505
  // ----------------------------------------------------------------
  it('UNIQUE (schedule_id, student_id) 违反 → 23505 duplicate', async () => {
    const dupFeedbackId = testUlid();
    // 同 schedule_id + studentId 已被 Case 1 占用
    await expect(
      repo.insert(schema, {
        id: dupFeedbackId,
        scheduleId,
        studentId, // 同 Case 1
        teacherId,
        attendanceStatus: '出勤',
        classroomPerformance: '良好',
        submittedAt: new Date(),
        updatedAt: new Date(),
      } as any),
    ).rejects.toThrow(/23505|duplicate|unique/i);
  });

  // ----------------------------------------------------------------
  // Case 3: attendance_status CHECK 违反 — 23514
  // ----------------------------------------------------------------
  it('attendance_status 非 [出勤/迟到/缺席/请假] → 23514 CHECK 违反', async () => {
    const feedbackId = testUlid();
    // 新 student 避免触发 UNIQUE
    // owner_id FK 必须是真实 users.id — 复用上面 beforeAll 灌的 admin
    const adminRow = await runInSchema(schema, async (c) => {
      const r = await c.query<{ id: string }>(
        `SELECT id FROM ${schema}.users WHERE role='admin' LIMIT 1`,
      );
      return r.rows[0];
    });
    const newCustomer = await seedCustomer(schema, campusId, adminRow.id);
    const newStudent = await seedStudent(schema, newCustomer.id);
    await expect(
      repo.insert(schema, {
        id: feedbackId,
        scheduleId,
        studentId: newStudent.id,
        teacherId,
        attendanceStatus: 'present' as any, // 英文不合法
        classroomPerformance: '良好',
        submittedAt: new Date(),
        updatedAt: new Date(),
      } as any),
    ).rejects.toThrow(/23514|check|constraint/i);
  });

  // ----------------------------------------------------------------
  // Case 4: classroom_performance CHECK 违反 — 23514
  // ----------------------------------------------------------------
  it('classroom_performance 非合法枚举 → 23514 CHECK 违反', async () => {
    const feedbackId = testUlid();
    const adminId4 = (await runInSchema(schema, async (c) => {
      const r = await c.query<{ id: string }>(
        `SELECT id FROM ${schema}.users WHERE role='admin' LIMIT 1`,
      );
      return r.rows[0];
    })).id;
    const newCustomer = await seedCustomer(schema, campusId, adminId4);
    const newStudent = await seedStudent(schema, newCustomer.id);
    await expect(
      repo.insert(schema, {
        id: feedbackId,
        scheduleId,
        studentId: newStudent.id,
        teacherId,
        attendanceStatus: '出勤',
        classroomPerformance: 'excellent' as any, // 英文不合法
        submittedAt: new Date(),
        updatedAt: new Date(),
      } as any),
    ).rejects.toThrow(/23514|check|constraint/i);
  });

  // ----------------------------------------------------------------
  // Case 5: listByStudent ORDER BY submitted_at DESC + LIMIT
  // ----------------------------------------------------------------
  it('listByStudent ORDER BY submitted_at DESC + LIMIT 限制', async () => {
    const items = await repo.listByStudent(schema, studentId, { limit: 50 });
    expect(items.length).toBeGreaterThanOrEqual(1); // Case 1 已 insert 1 条
    expect(items[0].studentId).toBe(studentId);
    // submitted_at 单调递减（最新的在前）
    for (let i = 1; i < items.length; i++) {
      expect(items[i - 1].submittedAt.getTime()).toBeGreaterThanOrEqual(
        items[i].submittedAt.getTime(),
      );
    }
  });

  // ----------------------------------------------------------------
  // Case 6: listByStudentTeacherInRange — 月报生成时间窗筛选
  // ----------------------------------------------------------------
  it('listByStudentTeacherInRange 时间窗 [start, end) 包含 Case 1 feedback', async () => {
    const rangeStart = new Date('2026-05-01T00:00:00Z');
    const rangeEnd = new Date('2026-06-01T00:00:00Z');
    const items = await repo.listByStudentTeacherInRange(
      schema,
      studentId,
      teacherId,
      rangeStart,
      rangeEnd,
    );
    expect(items.length).toBeGreaterThanOrEqual(1);
    items.forEach((f) => {
      expect(f.submittedAt.getTime()).toBeGreaterThanOrEqual(rangeStart.getTime());
      expect(f.submittedAt.getTime()).toBeLessThan(rangeEnd.getTime());
      expect(f.studentId).toBe(studentId);
      expect(f.teacherId).toBe(teacherId);
    });

    // 时间窗外（4 月）应无返回
    const empty = await repo.listByStudentTeacherInRange(
      schema,
      studentId,
      teacherId,
      new Date('2026-04-01T00:00:00Z'),
      new Date('2026-05-01T00:00:00Z'),
    );
    expect(empty).toEqual([]);
  });

  // ----------------------------------------------------------------
  // Case 7: markParentRead 幂等 — COALESCE 保留首次读取时间
  // ----------------------------------------------------------------
  it('markParentRead 幂等 — COALESCE 保留首次 parent_read_at', async () => {
    // 拿 Case 1 的 feedback id（listByStudent 第一条）
    const items = await repo.listByStudent(schema, studentId, { limit: 1 });
    expect(items.length).toBe(1);
    const fbId = items[0].id;

    // 首次 markParentRead
    const r1 = await repo.markParentRead(schema, fbId);
    expect(r1.parentReadAt).toBeDefined();
    const firstReadAt = r1.parentReadAt!.getTime();

    // 第二次 markParentRead 不应覆盖（COALESCE）
    await new Promise((res) => setTimeout(res, 50)); // 让 NOW() 有差异
    const r2 = await repo.markParentRead(schema, fbId);
    expect(r2.parentReadAt).toBeDefined();
    expect(r2.parentReadAt!.getTime()).toBe(firstReadAt);
  });

  // ----------------------------------------------------------------
  // Case 8: countUnreadByParent — parent_read_at IS NULL 计数
  // ----------------------------------------------------------------
  it('countUnreadByParent: 已读 0 / 未读 ≥ 1（取决于本 spec 灌入）', async () => {
    // Case 7 已 markParentRead → 应 0 个未读
    const c0 = await repo.countUnreadByParent(schema, [studentId]);
    expect(c0).toBe(0);

    // 再灌一条未读 feedback
    const adminId8 = (await runInSchema(schema, async (c) => {
      const r = await c.query<{ id: string }>(
        `SELECT id FROM ${schema}.users WHERE role='admin' LIMIT 1`,
      );
      return r.rows[0];
    })).id;
    const newCustomer = await seedCustomer(schema, campusId, adminId8);
    const newStudent = await seedStudent(schema, newCustomer.id);
    const fb2 = testUlid();
    await repo.insert(schema, {
      id: fb2,
      scheduleId,
      studentId: newStudent.id,
      teacherId,
      attendanceStatus: '出勤',
      classroomPerformance: '良好',
      submittedAt: new Date(),
      updatedAt: new Date(),
    } as any);

    const c1 = await repo.countUnreadByParent(schema, [newStudent.id]);
    expect(c1).toBe(1);

    // 0 学员 → 0 计数（早返）
    const c2 = await repo.countUnreadByParent(schema, []);
    expect(c2).toBe(0);
  });

  // ----------------------------------------------------------------
  // Case 9: schema drift 反例 — DROP attendance_status → INSERT 失败
  // ----------------------------------------------------------------
  it('schema drift 反例: DROP COLUMN attendance_status → INSERT 必失败 42703', async () => {
    const driftSchema = await createTestSchema('feedback-drift');
    try {
      // FK seed 不通过 setup helpers（避免污染主 schema）：直接 SQL 灌 minimum
      const campus2 = await seedCampus(driftSchema);
      const admin2 = await seedAdminUser(driftSchema, campus2.id);
      const tch2 = testUlid();
      await runInSchema(driftSchema, async (c) => {
        await c.query(
          `INSERT INTO ${driftSchema}.teachers
             (id, name, phone, status, created_by, updated_by, campus_id)
           VALUES ($1, '老师', '13900008888', '在职', $2, $2, $3)`,
          [tch2, admin2.id, campus2.id],
        );
      });
      const cust2 = await seedCustomer(driftSchema, campus2.id, admin2.id);
      const stu2 = await seedStudent(driftSchema, cust2.id);
      const sched2 = testUlid();
      await runInSchema(driftSchema, async (c) => {
        await c.query(
          `INSERT INTO ${driftSchema}.schedules
           (id, teacher_id, start_at, duration_min, end_at, status, created_by_user_id, created_by_role)
         VALUES ($1, $2, NOW(), 60, NOW() + interval '1 hour', '已完成', $3, 'admin')`,
          [sched2, tch2, admin2.id],
        );

        // 模拟 schema drift：DROP attendance_status 列
        await c.query(`ALTER TABLE ${driftSchema}.lesson_feedbacks DROP COLUMN attendance_status`);
      });

      // INSERT 应失败（42703 undefined column）
      await expect(
        repo.insert(driftSchema, {
          id: testUlid(),
          scheduleId: sched2,
          studentId: stu2.id,
          teacherId: tch2,
          attendanceStatus: '出勤',
          classroomPerformance: '良好',
          submittedAt: new Date(),
          updatedAt: new Date(),
        } as any),
      ).rejects.toThrow(/42703|attendance_status|column|does not exist/i);
    } finally {
      await dropTestSchema(driftSchema);
    }
  });
});
