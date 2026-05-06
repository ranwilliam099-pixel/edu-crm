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
