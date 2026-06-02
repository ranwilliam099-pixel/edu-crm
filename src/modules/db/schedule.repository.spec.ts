import { Test } from '@nestjs/testing';
import { ScheduleRepository } from './schedule.repository';
import { PgPoolService } from './pg-pool.service';

describe('ScheduleRepository — V8 周期展开 bulkUpsertFromRecurring', () => {
  let repo: ScheduleRepository;
  let pg: { tenantQuery: jest.Mock; query: jest.Mock; withClient: jest.Mock; transaction: jest.Mock };

  const TENANT = 'tenant_v8test_aaaa';

  beforeEach(async () => {
    pg = { tenantQuery: jest.fn(), query: jest.fn(), withClient: jest.fn(), transaction: jest.fn() };
    const m = await Test.createTestingModule({
      providers: [ScheduleRepository, { provide: PgPoolService, useValue: pg }],
    }).compile();
    repo = m.get(ScheduleRepository);
  });

  it('空 candidates → no-op', async () => {
    const r = await repo.bulkUpsertFromRecurring(
      TENANT,
      {
        id: 'rec00000000000000000000000000R01',
        teacherId: 'tch00000000000000000000000000T01',
        studentId: 'stu00000000000000000000000000S01',
        durationMin: 60,
        createdByUserId: 'usr00000000000000000000000000U01',
        createdByRole: 'sales',
      },
      [],
      () => 'sch00000000000000000000000000S01',
    );
    expect(r).toEqual({ inserted: 0, skipped: 0 });
    expect(pg.transaction).not.toHaveBeenCalled();
  });

  it('插入 + 幂等跳过混合', async () => {
    const client = {
      query: jest.fn().mockImplementation((sql: string) => {
        if (sql.includes('INSERT INTO schedules')) {
          // 第一次 RETURNING 1 行；第二次 0 行（CONFLICT 跳过）
          const callIdx = client.query.mock.calls.filter((c) =>
            c[0].includes('INSERT INTO schedules'),
          ).length;
          return Promise.resolve(
            callIdx === 1
              ? { rows: [{ id: 'sch1' }], rowCount: 1 }
              : { rows: [], rowCount: 0 },
          );
        }
        if (sql.includes('schedule_students')) {
          return Promise.resolve({ rows: [], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
    };
    pg.transaction.mockImplementationOnce(async (fn: any) => fn(client));

    const r = await repo.bulkUpsertFromRecurring(
      TENANT,
      {
        id: 'rec00000000000000000000000000R01',
        teacherId: 'tch00000000000000000000000000T01',
        studentId: 'stu00000000000000000000000000S01',
        durationMin: 60,
        createdByUserId: 'usr00000000000000000000000000U01',
        createdByRole: 'sales',
      },
      [
        { startAt: new Date('2026-05-12T18:00:00Z'), endAt: new Date('2026-05-12T19:00:00Z') },
        { startAt: new Date('2026-05-19T18:00:00Z'), endAt: new Date('2026-05-19T19:00:00Z') },
      ],
      (i) => `sch00000000000000000000000000S0${i + 1}`,
    );
    expect(r.inserted).toBe(1);
    expect(r.skipped).toBe(1);
  });

  it('只在 inserted 时绑定 schedule_students', async () => {
    let scheduleInserts = 0;
    let bindingInserts = 0;
    const client = {
      query: jest.fn().mockImplementation((sql: string) => {
        if (sql.includes('INSERT INTO schedules')) {
          scheduleInserts++;
          return Promise.resolve({ rows: [], rowCount: 0 }); // 全 conflict
        }
        if (sql.includes('schedule_students')) {
          bindingInserts++;
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
    };
    pg.transaction.mockImplementationOnce(async (fn: any) => fn(client));
    await repo.bulkUpsertFromRecurring(
      TENANT,
      {
        id: 'rec1',
        teacherId: 'tch1',
        studentId: 'stu1',
        durationMin: 60,
        createdByUserId: 'usr1',
        createdByRole: 'sales',
      },
      [
        { startAt: new Date(), endAt: new Date() },
        { startAt: new Date(), endAt: new Date() },
      ],
      (i) => `sch${i}`,
    );
    expect(scheduleInserts).toBe(2);
    expect(bindingInserts).toBe(0); // 全跳过 → 不绑定
  });
});

describe('ScheduleRepository — V32 insertWithStudents class_type + max_students', () => {
  let repo: ScheduleRepository;
  let pg: { tenantQuery: jest.Mock; query: jest.Mock; withClient: jest.Mock; transaction: jest.Mock };

  const TENANT = 'tenant_v32test_zzzz';

  function makeSchedule(overrides: any = {}) {
    return {
      id: 'sch00000000000000000000000000S99',
      teacherId: 'tch00000000000000000000000000T01',
      startAt: new Date('2026-05-08T10:00:00Z'),
      durationMin: 60,
      endAt: new Date('2026-05-08T11:00:00Z'),
      status: '已排课' as const,
      source: 'one_off' as const,
      createdByUserId: 'usr00000000000000000000000000U01',
      createdByRole: 'teacher' as const,
      ...overrides,
    };
  }

  beforeEach(async () => {
    pg = { tenantQuery: jest.fn(), query: jest.fn(), withClient: jest.fn(), transaction: jest.fn() };
    const m = await Test.createTestingModule({
      providers: [ScheduleRepository, { provide: PgPoolService, useValue: pg }],
    }).compile();
    repo = m.get(ScheduleRepository);
  });

  it('成功 INSERT：class_type + max_students 写入', async () => {
    const client: any = {
      query: jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
    };
    pg.transaction.mockImplementation(async (fn: any) => fn(client));

    await repo.insertWithStudents(
      TENANT,
      makeSchedule({ classType: '小班', maxStudents: 5 }),
      ['stu1', 'stu2', 'stu3'],
    );

    const insertCall = client.query.mock.calls.find((c: any) =>
      typeof c[0] === 'string' && c[0].includes('INSERT INTO schedules'),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall[0]).toContain('class_type');
    expect(insertCall[0]).toContain('max_students');
    expect(insertCall[1][12]).toBe('小班');     // class_type
    expect(insertCall[1][13]).toBe(5);           // max_students
  });

  it('柔性兜底：studentIds.length > maxStudents → throw', async () => {
    await expect(
      repo.insertWithStudents(
        TENANT,
        makeSchedule({ classType: '一对一', maxStudents: 1 }),
        ['stu1', 'stu2'],
      ),
    ).rejects.toThrow(/exceeds maxStudents/);
  });

  it('studentIds 为空 → throw', async () => {
    await expect(
      repo.insertWithStudents(TENANT, makeSchedule(), []),
    ).rejects.toThrow(/at least 1 student/);
  });

  it('maxStudents 未提供 → 仅校验至少 1 个，写 NULL（柔性）', async () => {
    const client: any = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };
    pg.transaction.mockImplementation(async (fn: any) => fn(client));
    await repo.insertWithStudents(
      TENANT,
      makeSchedule(),
      Array.from({ length: 100 }, (_, i) => `stu${i}`),
    );
    const insertCall = client.query.mock.calls.find((c: any) =>
      typeof c[0] === 'string' && c[0].includes('INSERT INTO schedules'),
    );
    expect(insertCall[1][13]).toBeNull();
  });

  it('classType 未提供 → 写 NULL（兼容旧代码）', async () => {
    const client: any = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };
    pg.transaction.mockImplementation(async (fn: any) => fn(client));
    await repo.insertWithStudents(TENANT, makeSchedule(), ['stu1']);
    const insertCall = client.query.mock.calls.find((c: any) =>
      typeof c[0] === 'string' && c[0].includes('INSERT INTO schedules'),
    );
    expect(insertCall[1][12]).toBeNull();
  });

  describe('V29 R14.6 contractClassType 兜底校验', () => {
    it('classType 提供 + 所有学员 contract_class_type 一致 → 通过 INSERT', async () => {
      const client: any = {
        query: jest.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM students')) {
            return Promise.resolve({
              rows: [
                { student_id: 'stu1', contract_class_type: '小班' },
                { student_id: 'stu2', contract_class_type: '小班' },
              ],
              rowCount: 2,
            });
          }
          return Promise.resolve({ rows: [], rowCount: 1 });
        }),
      };
      pg.transaction.mockImplementation(async (fn: any) => fn(client));

      await expect(
        repo.insertWithStudents(
          TENANT,
          makeSchedule({ classType: '小班', maxStudents: 5 }),
          ['stu1', 'stu2'],
        ),
      ).resolves.toBeDefined();

      const insertCall = client.query.mock.calls.find(
        (c: any) => typeof c[0] === 'string' && c[0].includes('INSERT INTO schedules'),
      );
      expect(insertCall).toBeDefined();
    });

    it('classType 提供 + 1 个学员 contract_class_type 不一致 → throw 拒 INSERT', async () => {
      let scheduleInserted = false;
      const client: any = {
        query: jest.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM students')) {
            return Promise.resolve({
              rows: [
                { student_id: 'stu1', contract_class_type: '小班' },
                { student_id: 'stu2', contract_class_type: '一对一' },
              ],
              rowCount: 2,
            });
          }
          if (sql.includes('INSERT INTO schedules')) scheduleInserted = true;
          return Promise.resolve({ rows: [], rowCount: 1 });
        }),
      };
      pg.transaction.mockImplementation(async (fn: any) => fn(client));

      await expect(
        repo.insertWithStudents(
          TENANT,
          makeSchedule({ classType: '小班', maxStudents: 5 }),
          ['stu1', 'stu2'],
        ),
      ).rejects.toThrow(/contractClassType mismatch.*小班/);
      expect(scheduleInserted).toBe(false);
    });

    it('classType 提供 + 学员无 active 合同（contract_class_type=null）→ 柔性放行', async () => {
      const client: any = {
        query: jest.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM students')) {
            return Promise.resolve({
              rows: [
                { student_id: 'stu1', contract_class_type: null },
                { student_id: 'stu2', contract_class_type: '小班' },
              ],
              rowCount: 2,
            });
          }
          return Promise.resolve({ rows: [], rowCount: 1 });
        }),
      };
      pg.transaction.mockImplementation(async (fn: any) => fn(client));

      await expect(
        repo.insertWithStudents(
          TENANT,
          makeSchedule({ classType: '小班', maxStudents: 5 }),
          ['stu1', 'stu2'],
        ),
      ).resolves.toBeDefined();
    });

    it('classType 未提供 → 完全跳过 contractClassType 查询', async () => {
      let studentsQueried = false;
      const client: any = {
        query: jest.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM students')) studentsQueried = true;
          return Promise.resolve({ rows: [], rowCount: 1 });
        }),
      };
      pg.transaction.mockImplementation(async (fn: any) => fn(client));
      await repo.insertWithStudents(TENANT, makeSchedule(), ['stu1', 'stu2']);
      expect(studentsQueried).toBe(false);
    });

    it('错误信息含所有不一致学员 ID', async () => {
      const client: any = {
        query: jest.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM students')) {
            return Promise.resolve({
              rows: [
                { student_id: 'stuA', contract_class_type: '一对一' },
                { student_id: 'stuB', contract_class_type: '大班' },
                { student_id: 'stuC', contract_class_type: '小班' },
              ],
              rowCount: 3,
            });
          }
          return Promise.resolve({ rows: [], rowCount: 1 });
        }),
      };
      pg.transaction.mockImplementation(async (fn: any) => fn(client));

      await expect(
        repo.insertWithStudents(
          TENANT,
          makeSchedule({ classType: '小班', maxStudents: 10 }),
          ['stuA', 'stuB', 'stuC'],
        ),
      ).rejects.toThrow(/stuA,stuB/);
    });
  });
});

// ============================================================
// 2026-06-02 listLessonsByStudent — 「从学员页写反馈」页中页数据源
//   - schedule_students JOIN schedules + LEFT JOIN lesson_feedbacks(hasFeedback/feedbackId)
//   - LEFT JOIN teachers(teacherName) + course_products(subject)
//   - ORDER BY start_at DESC / limit 默认 50 上限 200（controller 钳制，repo 默认 50）
// ============================================================
describe('ScheduleRepository — listLessonsByStudent (by-student 课次 + 反馈状态)', () => {
  let repo: ScheduleRepository;
  let pg: { tenantQuery: jest.Mock; query: jest.Mock; withClient: jest.Mock; transaction: jest.Mock };

  const TENANT = 'tenant_lessons_aaaa';
  const STUDENT = 'stu00000000000000000000000000S01';

  beforeEach(async () => {
    pg = { tenantQuery: jest.fn(), query: jest.fn(), withClient: jest.fn(), transaction: jest.fn() };
    const m = await Test.createTestingModule({
      providers: [ScheduleRepository, { provide: PgPoolService, useValue: pg }],
    }).compile();
    repo = m.get(ScheduleRepository);
  });

  it('映射 hasFeedback/feedbackId/subject/teacherName + SQL 含 LEFT JOIN lesson_feedbacks + ORDER BY start_at DESC', async () => {
    const start1 = new Date('2026-06-01T10:00:00Z');
    const start2 = new Date('2026-05-20T10:00:00Z');
    pg.tenantQuery.mockResolvedValueOnce([
      // 已写反馈 → feedback_id 非空 → hasFeedback true
      {
        id: 'sch00000000000000000000000000S01',
        start_at: start1,
        duration_min: 60,
        teacher_name: '周老师',
        subject: '小学数学一对一',
        feedback_id: 'lf000000000000000000000000000F01',
      },
      // 未写反馈 → feedback_id NULL → hasFeedback false；teacher/course 缺失 → null
      {
        id: 'sch00000000000000000000000000S02',
        start_at: start2,
        duration_min: 90,
        teacher_name: null,
        subject: null,
        feedback_id: null,
      },
    ]);

    const items = await repo.listLessonsByStudent(TENANT, STUDENT);

    expect(items).toEqual([
      {
        scheduleId: 'sch00000000000000000000000000S01',
        startAt: start1,
        subject: '小学数学一对一',
        teacherName: '周老师',
        durationMin: 60,
        hasFeedback: true,
        feedbackId: 'lf000000000000000000000000000F01',
      },
      {
        scheduleId: 'sch00000000000000000000000000S02',
        startAt: start2,
        subject: null,
        teacherName: null,
        durationMin: 90,
        hasFeedback: false,
        feedbackId: null,
      },
    ]);

    // SQL 形态校验：tenantSchema 透传 + 参数化 studentId/limit/offset + 关键 JOIN/ORDER
    expect(pg.tenantQuery).toHaveBeenCalledTimes(1);
    const [schemaArg, sql, params] = pg.tenantQuery.mock.calls[0];
    expect(schemaArg).toBe(TENANT);
    expect(sql).toMatch(/FROM schedule_students ss/);
    expect(sql).toMatch(/JOIN schedules s ON s\.id = ss\.schedule_id/);
    expect(sql).toMatch(/LEFT JOIN lesson_feedbacks lf/);
    expect(sql).toMatch(/lf\.schedule_id = ss\.schedule_id/);
    expect(sql).toMatch(/lf\.student_id = ss\.student_id/);
    expect(sql).toMatch(/LEFT JOIN teachers t ON t\.id = s\.teacher_id/);
    expect(sql).toMatch(/ORDER BY s\.start_at DESC/);
    expect(sql).toMatch(/WHERE ss\.student_id = \$1/);
    // 默认 limit 50 / offset 0
    expect(params).toEqual([STUDENT, 50, 0]);
  });

  it('limit/offset 透传到参数（controller 已钳制，repo 原样下发）', async () => {
    pg.tenantQuery.mockResolvedValueOnce([]);
    const items = await repo.listLessonsByStudent(TENANT, STUDENT, { limit: 200, offset: 40 });
    expect(items).toEqual([]);
    const [, , params] = pg.tenantQuery.mock.calls[0];
    expect(params).toEqual([STUDENT, 200, 40]);
  });
});
