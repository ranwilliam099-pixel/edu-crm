import { Test } from '@nestjs/testing';
import { FeedbackRuleConfigRepository } from './feedback-rule-config.repository';
import { PgPoolService } from './pg-pool.service';

/**
 * FeedbackRuleConfigRepository (V66 Phase 5) 单测
 *   - get：无行 → null（调用方兜默认 null/null = 规则全关）/ 有行映射两维度
 *   - upsert：INSERT ON CONFLICT(campus_id) DO UPDATE + 覆盖两维度 + null 清维度
 */
describe('FeedbackRuleConfigRepository (V66 Phase 5)', () => {
  let repo: FeedbackRuleConfigRepository;
  let pg: { tenantQuery: jest.Mock };

  const TENANT = 'tenant_073e69d6aa5ac5b7e38496d3f57e7cdb';
  const CAMPUS = 'campus0000000000000000000000C001';
  const USER = 'boss00000000000000000000000B001U';

  beforeEach(async () => {
    pg = { tenantQuery: jest.fn() };
    const m = await Test.createTestingModule({
      providers: [
        FeedbackRuleConfigRepository,
        { provide: PgPoolService, useValue: pg },
      ],
    }).compile();
    repo = m.get(FeedbackRuleConfigRepository);
  });

  describe('get', () => {
    it('无配置行 → null', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      const cfg = await repo.get(TENANT, CAMPUS);
      expect(cfg).toBeNull();
      // WHERE campus_id = $1
      const [, , params] = pg.tenantQuery.mock.calls[0];
      expect(params).toEqual([CAMPUS]);
    });

    it('有行 → 映射 reminderDays / everyNLessons（Number 化）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        {
          campus_id: CAMPUS,
          reminder_days: 7,
          every_n_lessons: 3,
          updated_by: USER,
          updated_at: '2026-06-01T00:00:00.000Z',
        },
      ]);
      const cfg = await repo.get(TENANT, CAMPUS);
      expect(cfg?.reminderDays).toBe(7);
      expect(cfg?.everyNLessons).toBe(3);
      expect(cfg?.updatedBy).toBe(USER);
    });

    it('维度为 NULL（不启用）→ 映射 null（非 0）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        {
          campus_id: CAMPUS,
          reminder_days: null,
          every_n_lessons: 5,
          updated_by: USER,
          updated_at: '2026-06-01T00:00:00.000Z',
        },
      ]);
      const cfg = await repo.get(TENANT, CAMPUS);
      expect(cfg?.reminderDays).toBeNull();
      expect(cfg?.everyNLessons).toBe(5);
    });
  });

  describe('upsert', () => {
    it('INSERT ... ON CONFLICT(campus_id) DO UPDATE 覆盖两维度 + 返回新值', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        {
          campus_id: CAMPUS,
          reminder_days: 14,
          every_n_lessons: 4,
          updated_by: USER,
          updated_at: '2026-06-01T01:00:00.000Z',
        },
      ]);
      const cfg = await repo.upsert(TENANT, CAMPUS, 14, 4, USER);
      expect(cfg.reminderDays).toBe(14);
      expect(cfg.everyNLessons).toBe(4);
      const [, sql, params] = pg.tenantQuery.mock.calls[0];
      expect(sql).toContain('ON CONFLICT (campus_id) DO UPDATE');
      expect(sql).toContain('reminder_days = EXCLUDED.reminder_days');
      expect(sql).toContain('every_n_lessons = EXCLUDED.every_n_lessons');
      expect(params).toEqual([CAMPUS, 14, 4, USER]);
    });

    it('null 维度透传（清维度）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        {
          campus_id: CAMPUS,
          reminder_days: null,
          every_n_lessons: 3,
          updated_by: USER,
          updated_at: '2026-06-01T01:00:00.000Z',
        },
      ]);
      const cfg = await repo.upsert(TENANT, CAMPUS, null, 3, USER);
      expect(cfg.reminderDays).toBeNull();
      const [, , params] = pg.tenantQuery.mock.calls[0];
      expect(params[1]).toBeNull();
      expect(params[2]).toBe(3);
    });
  });
});
