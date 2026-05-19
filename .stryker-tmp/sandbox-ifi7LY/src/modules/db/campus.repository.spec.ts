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
