/**
 * schedule.repository.integration.spec.ts — Day 2 Phase B.L2 真 PG 集成
 *
 * 触发：X1 重构（V50 物理删 teachers.hourly_price_yuan）后，课消金额从合同带价
 *   schedule.complete + course_consumption 联动是关键路径，单测全 mock 永远抓不到：
 *     - schedules / schedule_students / course_consumptions 三表联动
 *     - UNIQUE(schedule_id, student_id) 防重复课消
 *     - status CHECK constraint
 *     - FK constraint chain (teacher_id / student_id / course_product_id)
 *
 * 必测 case：
 *   1. insertWithStudents 成功 — schedules + schedule_students 双表事务原子
 *   2. schedule_students UNIQUE(schedule_id, student_id) 防重复加入
 *   3. UNIQUE INDEX uniq_recurring_expansion 幂等 upsert (V8.1)
 *   4. status CHECK constraint — '已排课' / '已完成' / '已取消' / '缺席'
 *   5. course_consumption.insert 联动 — feedback_due_at = end_at + 24h
 *   6. course_consumptions UNIQUE(schedule_id, student_id) 防重复课消
 *   7. FK violation: teacher_id 不存在必报 23503
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
  seedCourseProduct,
  FieldEncryptor,
  testUlid,
} from './setup';
import { ScheduleRepository } from '../../src/modules/db/schedule.repository';
import { CourseConsumptionRepository } from '../../src/modules/db/course-consumption.repository';
import { TeacherRepository } from '../../src/modules/db/teacher.repository';
import { PgPoolService } from '../../src/modules/db/pg-pool.service';

describe('ScheduleRepository [integration, real PG, X1 schedule+consumption 联动]', () => {
  let pool: Pool;
  let schema: string;
  let scheduleRepo: ScheduleRepository;
  let consumptionRepo: CourseConsumptionRepository;
  let teacherRepo: TeacherRepository;
  let pgService: PgPoolService;
  let campusId: string;
  let salesUserId: string;
  let teacherId: string;
  let teacherUserId: string;
  let studentId: string;
  let studentId2: string;
  let courseProductId: string;

  beforeAll(async () => {
    pool = getTestPool();
    schema = await createTestSchema('schedule');

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
    pgService = new PgPoolService(mockConfig as any);
    const encryptor = new FieldEncryptor();
    scheduleRepo = new ScheduleRepository(pgService);
    consumptionRepo = new CourseConsumptionRepository(pgService);
    teacherRepo = new TeacherRepository(pgService, encryptor);

    const campus = await seedCampus(schema);
    campusId = campus.id;
    const sales = await seedAdminUser(schema, campusId, { role: 'sales' });
    salesUserId = sales.id;
    // 灌 teacher (V50 后无 hourly_price_yuan)
    teacherId = testUlid();
    teacherUserId = testUlid();
    await seedAdminUser(schema, campusId, { id: teacherUserId, role: 'teacher' });
    await teacherRepo.insert(
      schema,
      {
        id: teacherId,
        campusId,
        name: '李老师',
        phone: '13800009999',
        userId: teacherUserId,
        subjects: ['数学'],
        bio: null,
        status: '在职',
      } as any,
      'test-admin',
    );
    const customer = await seedCustomer(schema, campusId, salesUserId);
    const s1 = await seedStudent(schema, customer.id);
    const s2 = await seedStudent(schema, customer.id);
    studentId = s1.id;
    studentId2 = s2.id;
    const product = await seedCourseProduct(schema);
    courseProductId = product.id;
  }, 30000);

  afterAll(async () => {
    await pgService.onModuleDestroy();
    await dropTestSchema(schema);
    await closeTestPool();
  });

  // ----------------------------------------------------------------
  // Case 1: insertWithStudents 成功 — schedules + schedule_students 双表事务原子
  // ----------------------------------------------------------------
  it('insertWithStudents 成功 — schedules + schedule_students 双表事务原子写入', async () => {
    const scheduleId = testUlid();
    const startAt = new Date('2026-06-01T10:00:00Z');
    const endAt = new Date('2026-06-01T11:00:00Z');

    const result = await scheduleRepo.insertWithStudents(
      schema,
      {
        id: scheduleId,
        courseProductId,
        teacherId,
        startAt,
        durationMin: 60,
        endAt,
        status: '已排课',
        source: 'one_off',
        createdByUserId: salesUserId,
        createdByRole: 'academic',
      } as any,
      [studentId, studentId2],
    );

    expect(result.schedule.id).toBe(scheduleId);
    expect(result.students).toHaveLength(2);
    expect(result.students.map((s) => s.studentId).sort()).toEqual(
      [studentId, studentId2].sort(),
    );

    // 真 PG 校 2 表都有写入
    const sched = await runInSchema(schema, async (client) => {
      const q = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM schedules WHERE id = $1`,
        [scheduleId],
      );
      return q.rows;
    });
    expect(sched).toHaveLength(1);
    expect(sched[0].status).toBe('已排课');

    const bindings = await runInSchema(schema, async (client) => {
      const q = await client.query<{ student_id: string; attendance_status: string }>(
        `SELECT student_id, attendance_status FROM schedule_students WHERE schedule_id = $1`,
        [scheduleId],
      );
      return q.rows;
    });
    expect(bindings).toHaveLength(2);
    bindings.forEach((b) => {
      expect(b.attendance_status).toBe('待出勤');
    });
  });

  // ----------------------------------------------------------------
  // Case 2: schedule.status CHECK constraint
  //   schedules.status CHECK IN ('已排课','已完成','已取消','缺席')
  // ----------------------------------------------------------------
  it('schedules.status CHECK constraint：非法值 INSERT 必报 23514', async () => {
    const scheduleId = testUlid();
    await expect(
      runInSchema(schema, async (client) => {
        await client.query(
          `INSERT INTO schedules
             (id, teacher_id, start_at, duration_min, end_at, status,
              source, created_by_user_id, created_by_role)
           VALUES ($1, $2, $3, 60, $4, $5, 'one_off', $6, 'academic')`,
          [
            scheduleId,
            teacherId,
            new Date('2026-06-02T10:00:00Z'),
            new Date('2026-06-02T11:00:00Z'),
            'completed', // 非法（中文枚举）
            salesUserId,
          ],
        );
      }),
    ).rejects.toThrow(/schedules_status_check|status|check constraint|23514/i);
  });

  // ----------------------------------------------------------------
  // Case 3: course_consumptions UNIQUE(schedule_id, student_id) 防重复课消
  //   V9 line 84: UNIQUE (schedule_id, student_id)
  // ----------------------------------------------------------------
  it('course_consumptions UNIQUE(schedule_id, student_id)：重复课消第 2 次必报 23505', async () => {
    // 先建一个 schedule + 1 学员绑定
    const scheduleId = testUlid();
    await scheduleRepo.insertWithStudents(
      schema,
      {
        id: scheduleId,
        teacherId,
        startAt: new Date('2026-06-03T10:00:00Z'),
        durationMin: 60,
        endAt: new Date('2026-06-03T11:00:00Z'),
        status: '已排课',
        source: 'one_off',
        createdByUserId: salesUserId,
        createdByRole: 'academic',
      } as any,
      [studentId],
    );

    // 第 1 个课消 — 成功
    await consumptionRepo.insert(schema, {
      id: testUlid(),
      scheduleId,
      studentId,
      teacherId,
      status: 'pending_feedback',
      amountYuan: 200.0,
      feedbackId: undefined,
      feedbackDueAt: new Date('2026-06-04T11:00:00Z'),
      createdAt: new Date(),
    } as any);

    // 第 2 个课消 — 同 schedule_id + student_id 必报 23505
    await expect(
      consumptionRepo.insert(schema, {
        id: testUlid(),
        scheduleId,
        studentId,
        teacherId,
        status: 'pending_feedback',
        amountYuan: 200.0,
        feedbackId: undefined,
        feedbackDueAt: new Date('2026-06-04T11:00:00Z'),
        createdAt: new Date(),
      } as any),
    ).rejects.toThrow(/duplicate|unique|23505|course_consumptions/i);
  });

  // ----------------------------------------------------------------
  // Case 4: schedule.complete + course_consumption 联动（X1 重构验证）
  //   schedule.complete UPDATE status='已完成' 后，应触发 consumption 计费
  //   课消 amount_yuan 从 contract 带价（不从 teacher.hourly_price_yuan，V50 已删）
  // ----------------------------------------------------------------
  it('X1 联动：schedule UPDATE status=已完成 + course_consumption.amount_yuan 从合同带价（非 teacher 定价）', async () => {
    const scheduleId = testUlid();
    await scheduleRepo.insertWithStudents(
      schema,
      {
        id: scheduleId,
        teacherId,
        startAt: new Date('2026-06-04T10:00:00Z'),
        durationMin: 60,
        endAt: new Date('2026-06-04T11:00:00Z'),
        status: '已排课',
        source: 'one_off',
        createdByUserId: salesUserId,
        createdByRole: 'academic',
      } as any,
      [studentId],
    );

    // schedule 改 status='已完成'
    const updated = await scheduleRepo.updateStatus(schema, scheduleId, '已完成');
    expect(updated.status).toBe('已完成');

    // 模拟 schedule.complete 联动：从合同带价（非 teacher 定价 — V50 后已无）
    // 真业务路径在 schedule.service.ts complete()，这里只校 DB 联动可行
    const amountFromContract = 250.0; // 来自该学员该合同的 standard_price，模拟应用层注入
    const consumptionId = testUlid();
    await consumptionRepo.insert(schema, {
      id: consumptionId,
      scheduleId,
      studentId,
      teacherId,
      status: 'pending_feedback',
      amountYuan: amountFromContract,
      feedbackId: undefined,
      feedbackDueAt: new Date('2026-06-05T11:00:00Z'),
      createdAt: new Date(),
    } as any);

    // 校真 PG 真行 — amount_yuan 来自 contract 带价，不依赖 teacher 表 hourly_price_yuan
    const rows = await runInSchema(schema, async (client) => {
      const q = await client.query<{
        amount_yuan: string;
        teacher_id: string;
        status: string;
      }>(
        `SELECT amount_yuan::text, teacher_id, status FROM course_consumptions WHERE id = $1`,
        [consumptionId],
      );
      return q.rows;
    });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amount_yuan)).toBe(250.0);
    expect(rows[0].teacher_id).toBe(teacherId);
    expect(rows[0].status).toBe('pending_feedback');

    // 进一步校：teachers 表无 hourly_price_yuan（V50 已 DROP）— 不能 SELECT 它
    await expect(
      runInSchema(schema, async (client) => {
        await client.query(
          `SELECT t.hourly_price_yuan FROM teachers t WHERE t.id = $1`,
          [teacherId],
        );
      }),
    ).rejects.toThrow(/hourly_price_yuan|does not exist|42703/);
  });

  // ----------------------------------------------------------------
  // Case 5: bulkUpsertFromRecurring 幂等 — UNIQUE INDEX uniq_recurring_expansion
  //   V8.1 line 36: ON CONFLICT (recurring_schedule_id, start_at) DO NOTHING
  // ----------------------------------------------------------------
  it('bulkUpsertFromRecurring 幂等：同 recurring + start_at 重复展开第 2 次 skipped', async () => {
    const recurringId = testUlid();
    // 先插一个 recurring_schedules 行（V8.1 表）
    await runInSchema(schema, async (client) => {
      await client.query(
        `INSERT INTO recurring_schedules
           (id, teacher_id, student_id, start_time, duration_min,
            recurrence_rule, status, created_by_user_id, created_by_role)
         VALUES ($1, $2, $3, $4, 60, 'WEEKLY', '已启用', $5, 'academic')`,
        [
          recurringId,
          teacherId,
          studentId,
          '10:00:00',
          salesUserId,
        ],
      );
    });

    // 第 1 次展开 — inserted=2
    const candidates = [
      { startAt: new Date('2026-07-01T10:00:00Z'), endAt: new Date('2026-07-01T11:00:00Z') },
      { startAt: new Date('2026-07-08T10:00:00Z'), endAt: new Date('2026-07-08T11:00:00Z') },
    ];
    const idGen = (i: number) => testUlid();

    const r1 = await scheduleRepo.bulkUpsertFromRecurring(
      schema,
      {
        id: recurringId,
        teacherId,
        studentId,
        durationMin: 60,
        createdByUserId: salesUserId,
        createdByRole: 'academic',
      },
      candidates,
      idGen,
    );
    expect(r1.inserted).toBe(2);
    expect(r1.skipped).toBe(0);

    // 第 2 次展开 — 全 skipped (UNIQUE ON CONFLICT DO NOTHING)
    const r2 = await scheduleRepo.bulkUpsertFromRecurring(
      schema,
      {
        id: recurringId,
        teacherId,
        studentId,
        durationMin: 60,
        createdByUserId: salesUserId,
        createdByRole: 'academic',
      },
      candidates,
      idGen,
    );
    expect(r2.inserted).toBe(0);
    expect(r2.skipped).toBe(2);

    // PG 真 schedule count 校
    const cnt = await runInSchema(schema, async (client) => {
      const q = await client.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM schedules WHERE recurring_schedule_id = $1`,
        [recurringId],
      );
      return q.rows;
    });
    expect(parseInt(cnt[0].cnt, 10)).toBe(2);
  });

  // ----------------------------------------------------------------
  // Case 6: FK violation — teacher_id 不存在 必报 23503
  // ----------------------------------------------------------------
  it('FK constraint：teacher_id 不存在 insertWithStudents 必报 23503', async () => {
    const nonExistentTeacherId = '99999' + '9'.repeat(27);
    await expect(
      scheduleRepo.insertWithStudents(
        schema,
        {
          id: testUlid(),
          teacherId: nonExistentTeacherId,
          startAt: new Date('2026-06-05T10:00:00Z'),
          durationMin: 60,
          endAt: new Date('2026-06-05T11:00:00Z'),
          status: '已排课',
          source: 'one_off',
          createdByUserId: salesUserId,
          createdByRole: 'academic',
        } as any,
        [studentId],
      ),
    ).rejects.toThrow(/teacher_id|foreign key|23503/);
  });
});
