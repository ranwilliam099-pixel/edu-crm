/**
 * CSideRepository 单测 — 2026-06-01 §4.1 ② 家长 C 端孩子卡 currentGrade
 *
 * Scope: findChildrenByIds → mapChildRow → computeCurrentGrade（§4.1.1 computed-on-read）
 *
 * 业务覆盖（SSOT §4.1 ② + §4.1.1）:
 *   - currentGrade = advance(grade_or_age, 当前学年 − grade_base_year)，封顶高三
 *   - grade_base_year 缺失 → 用 created_at 学年兜底（与 B 端 student.repository 同口径）
 *   - 非阶梯值（如「5 岁」）原样返回不进级
 *   - 家长红线：ChildBrief 仅 姓名+主带老师+校区+currentGrade，无手机/合同/价格字段
 *
 * 时间确定性：jest fake timers 固定系统时间，使 academicYear(new Date()) 可预期。
 */
import { Test } from '@nestjs/testing';
import { CSideRepository } from './c-side.repository';
import { PgPoolService } from '../db/pg-pool.service';

describe('CSideRepository.findChildrenByIds — currentGrade（2026-06-01 §4.1 ②）', () => {
  let repo: CSideRepository;
  let pg: { tenantQuery: jest.Mock };

  const TENANT = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const STU_1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNS1';

  beforeEach(async () => {
    // 固定系统时间为 2026-06-15（学年 = 2025，因 month=6 < 8）。
    //   说明：grade_base_year=2023 → steps = 2025 − 2023 = 2；小学三年级 advance 2 → 小学五年级。
    jest.useFakeTimers().setSystemTime(new Date('2026-06-15T00:00:00.000Z'));
    pg = { tenantQuery: jest.fn() };
    const m = await Test.createTestingModule({
      providers: [
        CSideRepository,
        { provide: PgPoolService, useValue: pg },
      ],
    }).compile();
    repo = m.get(CSideRepository);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const childRow = (
    overrides: Partial<{
      grade_or_age: string | null;
      grade_base_year: number | null;
      created_at: string | null;
    }> = {},
  ) => ({
    id: STU_1,
    name: '小明',
    main_teacher_id: 'teacher000000000000000000000A001',
    main_teacher_name: '王老师',
    campus_id: 'campus0000000000000000000000A001',
    campus_name: '总校区',
    grade_or_age: 'grade_or_age' in overrides ? overrides.grade_or_age : '小学三年级',
    grade_base_year: 'grade_base_year' in overrides ? overrides.grade_base_year : 2023,
    created_at: 'created_at' in overrides ? overrides.created_at : '2023-09-01T00:00:00.000Z',
  });

  it('SELECT 带 grade_or_age / grade_base_year / created_at（补列验证）', async () => {
    pg.tenantQuery.mockResolvedValueOnce([childRow()]);
    await repo.findChildrenByIds(TENANT, [STU_1]);
    const sql = pg.tenantQuery.mock.calls[0][1] as string;
    expect(sql).toContain('grade_or_age');
    expect(sql).toContain('grade_base_year');
    expect(sql).toContain('s.created_at');
  });

  it('grade_base_year=2023 + 当前学年 2025 → 小学三年级 advance 2 → 小学五年级', async () => {
    pg.tenantQuery.mockResolvedValueOnce([childRow()]);
    const [child] = await repo.findChildrenByIds(TENANT, [STU_1]);
    expect(child.currentGrade).toBe('小学五年级');
    // 家长红线字段齐备
    expect(child.name).toBe('小明');
    expect(child.mainTeacherName).toBe('王老师');
    expect(child.campusName).toBe('总校区');
  });

  it('grade_base_year=null → 用 created_at 学年兜底（2023-09 → 学年 2023 → 同样推 2 级 = 小学五年级）', async () => {
    pg.tenantQuery.mockResolvedValueOnce([
      childRow({ grade_base_year: null, created_at: '2023-09-01T00:00:00.000Z' }),
    ]);
    const [child] = await repo.findChildrenByIds(TENANT, [STU_1]);
    expect(child.currentGrade).toBe('小学五年级');
  });

  it('同一学年录入（base=2025）→ steps=0 → 原样返回（不进级）', async () => {
    pg.tenantQuery.mockResolvedValueOnce([
      childRow({ grade_base_year: 2025, created_at: '2025-09-01T00:00:00.000Z' }),
    ]);
    const [child] = await repo.findChildrenByIds(TENANT, [STU_1]);
    expect(child.currentGrade).toBe('小学三年级');
  });

  it('封顶高三：base=2010（远早）→ 高三不溢出', async () => {
    pg.tenantQuery.mockResolvedValueOnce([
      childRow({ grade_or_age: '初三', grade_base_year: 2010 }),
    ]);
    const [child] = await repo.findChildrenByIds(TENANT, [STU_1]);
    expect(child.currentGrade).toBe('高三');
  });

  it('非阶梯值「5 岁」→ 原样返回不进级', async () => {
    pg.tenantQuery.mockResolvedValueOnce([
      childRow({ grade_or_age: '5 岁', grade_base_year: 2020 }),
    ]);
    const [child] = await repo.findChildrenByIds(TENANT, [STU_1]);
    expect(child.currentGrade).toBe('5 岁');
  });

  it('grade_or_age 为 null → currentGrade null（无年级原值）', async () => {
    pg.tenantQuery.mockResolvedValueOnce([
      childRow({ grade_or_age: null }),
    ]);
    const [child] = await repo.findChildrenByIds(TENANT, [STU_1]);
    expect(child.currentGrade).toBeNull();
  });

  it('grade_base_year + created_at 都缺 → 保守原样返回 grade_or_age', async () => {
    pg.tenantQuery.mockResolvedValueOnce([
      childRow({ grade_base_year: null, created_at: null }),
    ]);
    const [child] = await repo.findChildrenByIds(TENANT, [STU_1]);
    expect(child.currentGrade).toBe('小学三年级');
  });

  it('家长红线：ChildBrief 不含手机/合同/价格字段', async () => {
    pg.tenantQuery.mockResolvedValueOnce([childRow()]);
    const [child] = await repo.findChildrenByIds(TENANT, [STU_1]);
    const keys = Object.keys(child);
    // 仅允许：id/name/mainTeacherId/mainTeacherName/campusId/campusName/currentGrade
    expect(keys.sort()).toEqual(
      [
        'campusId',
        'campusName',
        'currentGrade',
        'id',
        'mainTeacherId',
        'mainTeacherName',
        'name',
      ].sort(),
    );
    // 防泄露：无 phone / contract / price 等
    const leak = child as unknown as Record<string, unknown>;
    expect(leak.phone).toBeUndefined();
    expect(leak.parentPhone).toBeUndefined();
    expect(leak.totalAmount).toBeUndefined();
  });
});
