import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CampusRepository, Campus } from './campus.repository';
import { PgPoolService } from './pg-pool.service';

describe('CampusRepository', () => {
  let repo: CampusRepository;
  let pg: { tenantQuery: jest.Mock; query: jest.Mock; withClient: jest.Mock };

  const TENANT_ID = 't00000000000000000000000000000A01';
  const CAMPUS: Campus = {
    id: 'cam00000000000000000000000000A001',
    tenantId: TENANT_ID,
    name: '海淀校区',
    city: '北京',
    district: '海淀',
    address: '北四环 100 号',
    studentCount: 50,
    teacherCount: 6,
    status: 'active',
    isHq: false,
    createdAt: new Date('2026-05-04T10:00:00Z'),
  };
  const ROW = {
    id: CAMPUS.id,
    tenant_id: CAMPUS.tenantId,
    name: CAMPUS.name,
    city: CAMPUS.city,
    district: CAMPUS.district,
    address: CAMPUS.address,
    student_count: 50,
    teacher_count: 6,
    status: 'active',
    is_hq: false,
    created_at: CAMPUS.createdAt,
  };

  beforeEach(async () => {
    pg = { tenantQuery: jest.fn(), query: jest.fn(), withClient: jest.fn() };
    const m = await Test.createTestingModule({
      providers: [CampusRepository, { provide: PgPoolService, useValue: pg }],
    }).compile();
    repo = m.get(CampusRepository);
  });

  describe('list', () => {
    it('orders by is_hq DESC then created_at ASC', async () => {
      pg.query.mockResolvedValueOnce([ROW]);
      await repo.list(TENANT_ID);
      const sql = pg.query.mock.calls[0][0] as string;
      expect(sql).toContain('ORDER BY is_hq DESC, created_at ASC');
      expect(pg.query.mock.calls[0][1]).toEqual([TENANT_ID]);
    });
  });

  describe('create', () => {
    it('inserts when within max_campuses limit', async () => {
      // 1) get max_campuses
      pg.query.mockResolvedValueOnce([{ max_campuses: 3 }]);
      // 2) count current
      pg.query.mockResolvedValueOnce([{ count: '1' }]);
      // 3) insert
      pg.query.mockResolvedValueOnce([ROW]);
      const r = await repo.create(TENANT_ID, {
        id: CAMPUS.id,
        name: CAMPUS.name,
        city: CAMPUS.city,
        district: CAMPUS.district,
        address: CAMPUS.address,
      });
      expect(r.id).toBe(CAMPUS.id);
      expect(pg.query).toHaveBeenCalledTimes(3);
    });

    it('throws BadRequestException CAMPUS_LIMIT_REACHED when at max', async () => {
      pg.query.mockResolvedValueOnce([{ max_campuses: 1 }]);
      pg.query.mockResolvedValueOnce([{ count: '1' }]);
      let caught: Error | undefined;
      try {
        await repo.create(TENANT_ID, { id: 'x'.repeat(32), name: 'New' });
      } catch (e: any) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      expect(caught?.message).toContain('CAMPUS_LIMIT_REACHED');
    });

    it('throws NotFoundException when tenant not found', async () => {
      pg.query.mockResolvedValueOnce([]);
      await expect(
        repo.create(TENANT_ID, { id: 'x'.repeat(32), name: 'New' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('update (2026-05-30 #18 校区编辑)', () => {
    it('只更新非空字段 + tenant_id WHERE 隔离', async () => {
      pg.query.mockResolvedValueOnce([{ ...ROW, name: '新名字' }]);
      const r = await repo.update(TENANT_ID, CAMPUS.id, { name: '新名字' });
      const [sql, params] = pg.query.mock.calls[0];
      expect(sql).toContain('UPDATE public.campuses');
      expect(sql).toContain('name = $1');
      // tenant_id 必须在 WHERE（跨租户隔离）
      expect(sql).toContain('WHERE id = $2 AND tenant_id = $3');
      expect(params).toEqual(['新名字', CAMPUS.id, TENANT_ID]);
      expect(r.name).toBe('新名字');
    });

    it('多字段 patch — name/city/district/address 全更', async () => {
      pg.query.mockResolvedValueOnce([ROW]);
      await repo.update(TENANT_ID, CAMPUS.id, {
        name: 'N',
        city: 'C',
        district: 'D',
        address: 'A',
      });
      const [sql, params] = pg.query.mock.calls[0];
      expect(sql).toContain('name = $1');
      expect(sql).toContain('city = $2');
      expect(sql).toContain('district = $3');
      expect(sql).toContain('address = $4');
      // id=$5, tenant_id=$6
      expect(params).toEqual(['N', 'C', 'D', 'A', CAMPUS.id, TENANT_ID]);
    });

    it('未更字段不进 SET（仅 city patch → 只有 city = $1）', async () => {
      pg.query.mockResolvedValueOnce([ROW]);
      await repo.update(TENANT_ID, CAMPUS.id, { city: '上海' });
      const sql = pg.query.mock.calls[0][0] as string;
      expect(sql).toContain('city = $1');
      expect(sql).not.toContain('name =');
      expect(sql).not.toContain('district =');
      expect(sql).not.toContain('address =');
    });

    it('空 patch（无任何字段）→ BadRequestException 且不查 DB', async () => {
      await expect(repo.update(TENANT_ID, CAMPUS.id, {})).rejects.toThrow(
        BadRequestException,
      );
      expect(pg.query).not.toHaveBeenCalled();
    });

    it('目标不存在 / 不属于该 tenant（UPDATE 返 0 行）→ NotFoundException', async () => {
      pg.query.mockResolvedValueOnce([]);
      await expect(
        repo.update(TENANT_ID, CAMPUS.id, { name: 'X' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getStats30d', () => {
    it('aggregates total + per-campus', async () => {
      pg.query.mockResolvedValueOnce([
        { id: 'c1', name: 'A', student_count: 50, teacher_count: 5 },
        { id: 'c2', name: 'B', student_count: 30, teacher_count: 3 },
      ]);
      const stats = await repo.getStats30d(TENANT_ID);
      expect(stats.totalCampuses).toBe(2);
      expect(stats.totalStudents).toBe(80);
      expect(stats.totalTeachers).toBe(8);
      expect(stats.perCampus).toHaveLength(2);
      const sql = pg.query.mock.calls[0][0] as string;
      expect(sql).toContain("status = 'active'");
    });

    it('returns 0 when no campuses', async () => {
      pg.query.mockResolvedValueOnce([]);
      const stats = await repo.getStats30d(TENANT_ID);
      expect(stats.totalCampuses).toBe(0);
      expect(stats.totalStudents).toBe(0);
    });
  });
});
