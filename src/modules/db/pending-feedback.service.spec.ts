import { PgPoolService } from './pg-pool.service';
import { FeedbackRuleConfigRepository } from './feedback-rule-config.repository';
import { PendingFeedbackService } from './pending-feedback.service';

/**
 * PendingFeedbackService (V66 Phase 5 教务待反馈学员计算) 单测
 *
 * 来源：SSOT §5.3.3（OR 任一命中；时间维度 reminder_days / 次数维度 every_n_lessons；
 *   从未反馈 fallback 首次消课；全关空列表）。
 *
 * 覆盖：
 *   - 静态 evaluateReasons：时间命中 / 次数命中 / OR 双命中 / 各维度关 / 从未反馈 fallback
 *   - 静态 ruleHasAnyDimension：全关 / 单开 / 双开
 *   - listPendingForAcademic 集成：规则全关短路空（不查库）/ 命中筛选 / owner-scope=academicId
 *     / limit 上限 200 / 未命中学员剔除
 */
describe('PendingFeedbackService (V66 Phase 5)', () => {
  const TENANT = 'tenant_073e69d6aa5ac5b7e38496d3f57e7cdb';
  const CAMPUS = 'campus0000000000000000000000C001';
  const ACADEMIC = 'academicA0000000000000000000A001';

  let pg: { tenantQuery: jest.Mock };
  let ruleRepo: { get: jest.Mock };
  let service: PendingFeedbackService;

  beforeEach(() => {
    pg = { tenantQuery: jest.fn() };
    ruleRepo = { get: jest.fn() };
    service = new PendingFeedbackService(
      pg as unknown as PgPoolService,
      ruleRepo as unknown as FeedbackRuleConfigRepository,
    );
  });

  const rule = (
    reminderDays: number | null,
    everyNLessons: number | null,
  ) => ({
    campusId: CAMPUS,
    reminderDays,
    everyNLessons,
    updatedBy: null,
    updatedAt: new Date().toISOString(),
  });

  // ============================================================
  // 静态 ruleHasAnyDimension
  // ============================================================
  describe('ruleHasAnyDimension', () => {
    it('null 配置（无行）→ false（全关）', () => {
      expect(PendingFeedbackService.ruleHasAnyDimension(null)).toBe(false);
    });
    it('两维度皆 null → false（全关）', () => {
      expect(
        PendingFeedbackService.ruleHasAnyDimension(rule(null, null)),
      ).toBe(false);
    });
    it('仅时间维度 → true', () => {
      expect(
        PendingFeedbackService.ruleHasAnyDimension(rule(7, null)),
      ).toBe(true);
    });
    it('仅次数维度 → true', () => {
      expect(
        PendingFeedbackService.ruleHasAnyDimension(rule(null, 3)),
      ).toBe(true);
    });
    it('双维度 → true', () => {
      expect(PendingFeedbackService.ruleHasAnyDimension(rule(7, 3))).toBe(
        true,
      );
    });
  });

  // ============================================================
  // 静态 evaluateReasons（OR 规则）
  // ============================================================
  describe('evaluateReasons', () => {
    const agg = (
      daysSinceLast: number | null,
      lessonsSinceLast: number,
      lastFeedbackAt: string | null = null,
    ) => ({
      studentId: 'stu',
      studentName: '小明',
      lastFeedbackAt,
      daysSinceLast,
      lessonsSinceLast,
    });

    it('时间维度命中（daysSinceLast > reminderDays）', () => {
      const r = PendingFeedbackService.evaluateReasons(
        agg(10, 0, '2026-05-20T00:00:00.000Z'),
        rule(7, null),
      );
      expect(r).toEqual(['overdue_days']);
    });

    it('时间维度等于阈值不命中（严格 >，10 天 == 阈值 10 不催）', () => {
      const r = PendingFeedbackService.evaluateReasons(
        agg(10, 0),
        rule(10, null),
      );
      expect(r).toEqual([]);
    });

    it('次数维度命中（lessonsSinceLast >= everyNLessons）', () => {
      const r = PendingFeedbackService.evaluateReasons(
        agg(2, 5),
        rule(null, 5),
      );
      expect(r).toEqual(['overdue_lessons']);
    });

    it('次数维度等于阈值命中（>= 含等于，第 N 节即提醒）', () => {
      const r = PendingFeedbackService.evaluateReasons(
        agg(2, 3),
        rule(null, 3),
      );
      expect(r).toEqual(['overdue_lessons']);
    });

    it('OR 双命中 → reasons 含两者', () => {
      const r = PendingFeedbackService.evaluateReasons(
        agg(10, 5),
        rule(7, 3),
      );
      expect(r).toEqual(['overdue_days', 'overdue_lessons']);
    });

    it('双开但只时间命中 → 仅 overdue_days', () => {
      const r = PendingFeedbackService.evaluateReasons(
        agg(10, 1),
        rule(7, 3),
      );
      expect(r).toEqual(['overdue_days']);
    });

    it('从未反馈 + 有消课基准（daysSinceLast 非 null）→ 时间维度可命中', () => {
      // lastFeedbackAt=null 但 daysSinceLast=15（以首次消课算）
      const r = PendingFeedbackService.evaluateReasons(
        agg(15, 4, null),
        rule(7, null),
      );
      expect(r).toEqual(['overdue_days']);
    });

    it('无消课无反馈（daysSinceLast=null）→ 时间维度不命中（未开课不催）', () => {
      const r = PendingFeedbackService.evaluateReasons(
        agg(null, 0, null),
        rule(7, null),
      );
      expect(r).toEqual([]);
    });

    it('时间维度未启用（reminderDays=null）→ 不论 daysSinceLast 都不出 overdue_days', () => {
      const r = PendingFeedbackService.evaluateReasons(
        agg(999, 0),
        rule(null, 5),
      );
      expect(r).toEqual([]);
    });

    it('次数维度未启用（everyNLessons=null）→ 不论 lessonsSinceLast 都不出 overdue_lessons', () => {
      const r = PendingFeedbackService.evaluateReasons(
        agg(2, 999),
        rule(5, null),
      );
      expect(r).toEqual([]);
    });
  });

  // ============================================================
  // listPendingForAcademic（集成）
  // ============================================================
  describe('listPendingForAcademic', () => {
    it('规则全关（无行）→ 空列表，且不查库（短路）', async () => {
      ruleRepo.get.mockResolvedValueOnce(null);
      const r = await service.listPendingForAcademic(
        TENANT,
        CAMPUS,
        ACADEMIC,
      );
      expect(r.items).toEqual([]);
      expect(pg.tenantQuery).not.toHaveBeenCalled();
    });

    it('规则两维度皆 null → 空列表，不查库', async () => {
      ruleRepo.get.mockResolvedValueOnce(rule(null, null));
      const r = await service.listPendingForAcademic(
        TENANT,
        CAMPUS,
        ACADEMIC,
      );
      expect(r.items).toEqual([]);
      expect(pg.tenantQuery).not.toHaveBeenCalled();
    });

    it('owner-scope：SQL 用 academicId（=JWT.sub）作 assigned_academic_id 过滤参数', async () => {
      ruleRepo.get.mockResolvedValueOnce(rule(7, null));
      pg.tenantQuery.mockResolvedValueOnce([]);
      await service.listPendingForAcademic(TENANT, CAMPUS, ACADEMIC);
      const [schema, sql, params] = pg.tenantQuery.mock.calls[0];
      expect(schema).toBe(TENANT);
      expect(sql).toContain('assigned_academic_id = $1');
      expect(params[0]).toBe(ACADEMIC);
    });

    it('命中筛选：仅 reasons 非空学员进 items（未命中剔除）', async () => {
      ruleRepo.get.mockResolvedValueOnce(rule(7, null));
      pg.tenantQuery.mockResolvedValueOnce([
        // 命中：10 天 > 7
        {
          id: 'stu1',
          student_name: '小明',
          last_fb: '2026-05-20T00:00:00.000Z',
          lessons_since_last: '2',
          days_since_last: '10',
        },
        // 不命中：3 天 <= 7
        {
          id: 'stu2',
          student_name: '小红',
          last_fb: '2026-05-29T00:00:00.000Z',
          lessons_since_last: '1',
          days_since_last: '3',
        },
      ]);
      const r = await service.listPendingForAcademic(
        TENANT,
        CAMPUS,
        ACADEMIC,
      );
      expect(r.items).toHaveLength(1);
      expect(r.items[0].studentId).toBe('stu1');
      expect(r.items[0].reasons).toEqual(['overdue_days']);
      expect(r.items[0].daysSinceLast).toBe(10);
      expect(r.items[0].lessonsSinceLast).toBe(2);
      expect(r.items[0].lastFeedbackAt).toBe('2026-05-20T00:00:00.000Z');
    });

    it('从未反馈学员（last_fb=null）+ 次数维度命中 → 进 items，lastFeedbackAt=null', async () => {
      ruleRepo.get.mockResolvedValueOnce(rule(null, 3));
      pg.tenantQuery.mockResolvedValueOnce([
        {
          id: 'stu3',
          student_name: '小刚',
          last_fb: null,
          lessons_since_last: '4', // >= 3 命中
          days_since_last: '20', // 以首次消课算（但时间维度未启用）
        },
      ]);
      const r = await service.listPendingForAcademic(
        TENANT,
        CAMPUS,
        ACADEMIC,
      );
      expect(r.items).toHaveLength(1);
      expect(r.items[0].lastFeedbackAt).toBeNull();
      expect(r.items[0].reasons).toEqual(['overdue_lessons']);
      expect(r.items[0].lessonsSinceLast).toBe(4);
    });

    it('limit 上限 200（传 9999 截断）', async () => {
      ruleRepo.get.mockResolvedValueOnce(rule(7, null));
      pg.tenantQuery.mockResolvedValueOnce([]);
      await service.listPendingForAcademic(TENANT, CAMPUS, ACADEMIC, {
        limit: 9999,
      });
      const params = pg.tenantQuery.mock.calls[0][2];
      expect(params[1]).toBe(200); // limit param
    });

    it('limit 默认 100 / offset 默认 0', async () => {
      ruleRepo.get.mockResolvedValueOnce(rule(7, null));
      pg.tenantQuery.mockResolvedValueOnce([]);
      await service.listPendingForAcademic(TENANT, CAMPUS, ACADEMIC);
      const params = pg.tenantQuery.mock.calls[0][2];
      expect(params[1]).toBe(100);
      expect(params[2]).toBe(0);
    });

    it('days_since_last 为 null（无消课无反馈）+ 仅时间维度 → 不进 items', async () => {
      ruleRepo.get.mockResolvedValueOnce(rule(7, null));
      pg.tenantQuery.mockResolvedValueOnce([
        {
          id: 'stu4',
          student_name: '小美',
          last_fb: null,
          lessons_since_last: '0',
          days_since_last: null,
        },
      ]);
      const r = await service.listPendingForAcademic(
        TENANT,
        CAMPUS,
        ACADEMIC,
      );
      expect(r.items).toEqual([]);
    });
  });

  // ============================================================
  // listPendingForCampus（academic_admin 督导视图，2026-06-02 拍板）
  // ============================================================
  describe('listPendingForCampus', () => {
    it('规则全关 → 空列表，不查库（短路，同 academic）', async () => {
      ruleRepo.get.mockResolvedValueOnce(null);
      const r = await service.listPendingForCampus(TENANT, CAMPUS);
      expect(r.items).toEqual([]);
      expect(pg.tenantQuery).not.toHaveBeenCalled();
    });

    it('campus-scope：SQL 用 campusId 作本校教务池子查询（不按单个 sub）', async () => {
      ruleRepo.get.mockResolvedValueOnce(rule(7, null));
      pg.tenantQuery.mockResolvedValueOnce([]);
      await service.listPendingForCampus(TENANT, CAMPUS);
      const [schema, sql, params] = pg.tenantQuery.mock.calls[0];
      expect(schema).toBe(TENANT);
      // 本校全部教务名下：assigned_academic_id IN (本校教务池子查询)，而非 = 单个 sub
      expect(sql).toContain('assigned_academic_id IN');
      expect(sql).toContain('u.campus_id = $1');
      expect(sql).not.toContain('assigned_academic_id = $1');
      expect(params[0]).toBe(CAMPUS);
    });

    it('命中筛选复用同一 OR 判定（assembleItems 共用）', async () => {
      ruleRepo.get.mockResolvedValueOnce(rule(7, null));
      pg.tenantQuery.mockResolvedValueOnce([
        { id: 'stuA', student_name: '甲', last_fb: '2026-05-20T00:00:00.000Z', lessons_since_last: '1', days_since_last: '12' },
        { id: 'stuB', student_name: '乙', last_fb: '2026-05-30T00:00:00.000Z', lessons_since_last: '0', days_since_last: '2' },
      ]);
      const r = await service.listPendingForCampus(TENANT, CAMPUS);
      expect(r.items).toHaveLength(1);
      expect(r.items[0].studentId).toBe('stuA');
      expect(r.items[0].reasons).toEqual(['overdue_days']);
    });
  });
});
