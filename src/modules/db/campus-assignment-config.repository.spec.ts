import { Test } from '@nestjs/testing';
import { CampusAssignmentConfigRepository } from './campus-assignment-config.repository';
import { PgPoolService } from './pg-pool.service';

describe('CampusAssignmentConfigRepository (V63 Phase 3)', () => {
  let repo: CampusAssignmentConfigRepository;
  let pg: { tenantQuery: jest.Mock };

  const TENANT = 'tenant_073e69d6aa5ac5b7e38496d3f57e7cdb';
  const CAMPUS = 'campus0000000000000000000000C001';
  const USER = 'boss00000000000000000000000B001U';

  beforeEach(async () => {
    pg = { tenantQuery: jest.fn() };
    const m = await Test.createTestingModule({
      providers: [
        CampusAssignmentConfigRepository,
        { provide: PgPoolService, useValue: pg },
      ],
    }).compile();
    repo = m.get(CampusAssignmentConfigRepository);
  });

  describe('get', () => {
    it('无配置行 → null', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      const cfg = await repo.get(TENANT, CAMPUS);
      expect(cfg).toBeNull();
    });

    it('有行 → 映射字段（autoAssignAcademic / rrLastAcademicId）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        {
          campus_id: CAMPUS,
          auto_assign_academic: true,
          rr_last_academic_id: 'acad000000000000000000000000A01',
          updated_by: USER,
          updated_at: '2026-06-01T00:00:00.000Z',
        },
      ]);
      const cfg = await repo.get(TENANT, CAMPUS);
      expect(cfg?.autoAssignAcademic).toBe(true);
      expect(cfg?.rrLastAcademicId).toBe('acad000000000000000000000000A01');
      // WHERE campus_id = $1
      const [, , params] = pg.tenantQuery.mock.calls[0];
      expect(params).toEqual([CAMPUS]);
    });

    it('auto_assign_academic 非 true 值 → 归一为 false', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        { campus_id: CAMPUS, auto_assign_academic: false, rr_last_academic_id: null },
      ]);
      const cfg = await repo.get(TENANT, CAMPUS);
      expect(cfg?.autoAssignAcademic).toBe(false);
      expect(cfg?.rrLastAcademicId).toBeNull();
    });
  });

  describe('upsertAutoAssign', () => {
    it('INSERT ... ON CONFLICT DO UPDATE（不动游标）+ 返回新值', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        {
          campus_id: CAMPUS,
          auto_assign_academic: true,
          rr_last_academic_id: null,
          updated_by: USER,
          updated_at: '2026-06-01T01:00:00.000Z',
        },
      ]);
      const cfg = await repo.upsertAutoAssign(TENANT, CAMPUS, true, USER);
      expect(cfg.autoAssignAcademic).toBe(true);
      const [, sql, params] = pg.tenantQuery.mock.calls[0];
      expect(sql).toContain('ON CONFLICT (campus_id) DO UPDATE');
      // 不在 SET 子句更新 rr_last_academic_id（保留游标连续性）
      expect(sql).not.toContain('SET rr_last_academic_id');
      expect(params).toEqual([CAMPUS, true, USER]);
    });

    it('关开关 false → 透传 false', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        { campus_id: CAMPUS, auto_assign_academic: false, rr_last_academic_id: null },
      ]);
      const cfg = await repo.upsertAutoAssign(TENANT, CAMPUS, false, USER);
      expect(cfg.autoAssignAcademic).toBe(false);
      const [, , params] = pg.tenantQuery.mock.calls[0];
      expect(params[1]).toBe(false);
    });
  });
});
