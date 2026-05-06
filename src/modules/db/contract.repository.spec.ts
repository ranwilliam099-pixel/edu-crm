import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ContractRepository } from './contract.repository';
import { PgPoolService } from './pg-pool.service';

describe('ContractRepository', () => {
  let repo: ContractRepository;
  let pg: { tenantQuery: jest.Mock; query: jest.Mock; withClient: jest.Mock };

  const TENANT = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const CONTRACT_ID = 'contract00000000000000000000A001';
  const STUDENT_ID = 'student000000000000000000000A001';
  const COURSE_ID = 'course0000000000000000000000A001';
  const OWNER_ID = 'sales00000000000000000000000A001';
  const CAMPUS_ID = 'campus0000000000000000000000A001';
  const ROW = {
    id: CONTRACT_ID,
    student_id: STUDENT_ID,
    course_product_id: COURSE_ID,
    owner_user_id: OWNER_ID,
    opportunity_id: null,
    campus_id: CAMPUS_ID,
    class_type: null,
    lesson_hours: 30,
    standard_price: 1999,
    discount_amount: 0,
    gift_hours: 0,
    total_amount: 1999,
    order_type: '新签',
    status: 'pending',
    paid_locked: false,
    signed_at: new Date('2026-05-07T10:00:00Z'),
    activated_at: null,
    created_at: new Date('2026-05-07T10:00:00Z'),
    updated_at: new Date('2026-05-07T10:00:00Z'),
  };

  beforeEach(async () => {
    pg = { tenantQuery: jest.fn(), query: jest.fn(), withClient: jest.fn() };
    const m = await Test.createTestingModule({
      providers: [ContractRepository, { provide: PgPoolService, useValue: pg }],
    }).compile();
    repo = m.get(ContractRepository);
  });

  describe('create', () => {
    it('writes campus_id into INSERT (V26)', async () => {
      pg.tenantQuery.mockResolvedValueOnce([ROW]);
      const r = await repo.create(TENANT, {
        id: CONTRACT_ID,
        studentId: STUDENT_ID,
        courseProductId: COURSE_ID,
        ownerUserId: OWNER_ID,
        campusId: CAMPUS_ID,
        lessonHours: 30,
        standardPrice: 1999,
        totalAmount: 1999,
      });
      expect(r.campusId).toBe(CAMPUS_ID);
      const [, sql, params] = pg.tenantQuery.mock.calls[0];
      expect(sql).toContain('campus_id');
      // params order: id, student_id, course_product_id, owner_user_id, opportunity_id, campus_id, ...
      expect(params[5]).toBe(CAMPUS_ID);
    });

    it('null campus_id when admin / cross-campus role does not pass it', async () => {
      pg.tenantQuery.mockResolvedValueOnce([{ ...ROW, campus_id: null }]);
      const r = await repo.create(TENANT, {
        id: CONTRACT_ID,
        studentId: STUDENT_ID,
        courseProductId: COURSE_ID,
        ownerUserId: OWNER_ID,
        lessonHours: 30,
        standardPrice: 1999,
        totalAmount: 1999,
      });
      expect(r.campusId).toBeNull();
      const params = pg.tenantQuery.mock.calls[0][2];
      expect(params[5]).toBeNull();
    });

    it('rejects 32-char ULID id check', async () => {
      await expect(
        repo.create(TENANT, {
          id: 'short',
          studentId: STUDENT_ID,
          courseProductId: COURSE_ID,
          ownerUserId: OWNER_ID,
          lessonHours: 30,
          standardPrice: 1999,
          totalAmount: 1999,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects negative totalAmount', async () => {
      await expect(
        repo.create(TENANT, {
          id: CONTRACT_ID,
          studentId: STUDENT_ID,
          courseProductId: COURSE_ID,
          ownerUserId: OWNER_ID,
          lessonHours: 30,
          standardPrice: 1999,
          totalAmount: -1,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('mapRow', () => {
    it('maps campus_id field', () => {
      const r = ContractRepository.mapRow(ROW);
      expect(r.campusId).toBe(CAMPUS_ID);
      expect(r.id).toBe(CONTRACT_ID);
      expect(r.totalAmount).toBe(1999);
    });

    it('maps null campus_id', () => {
      const r = ContractRepository.mapRow({ ...ROW, campus_id: null });
      expect(r.campusId).toBeNull();
    });
  });

  describe('getTeamPerformance', () => {
    it('filters by campus_id when provided (V26)', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.getTeamPerformance(TENANT, CAMPUS_ID);
      const [, sql, params] = pg.tenantQuery.mock.calls[0];
      expect(sql).toContain('campus_id = $1');
      expect(params[0]).toBe(CAMPUS_ID);
    });

    it('omits campus_id filter when not provided (admin 跨校全量)', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.getTeamPerformance(TENANT);
      const [, sql, params] = pg.tenantQuery.mock.calls[0];
      expect(sql).not.toContain('campus_id =');
      expect(params).toEqual([]);
    });
  });

  describe('listByOwner', () => {
    it('with status filter', async () => {
      pg.tenantQuery.mockResolvedValueOnce([ROW]);
      const r = await repo.listByOwner(TENANT, OWNER_ID, { status: 'active' });
      expect(r).toHaveLength(1);
      const [, sql, params] = pg.tenantQuery.mock.calls[0];
      expect(sql).toContain('owner_user_id');
      expect(sql).toContain('status');
      expect(params[1]).toBe('active');
    });

    it('without status filter', async () => {
      pg.tenantQuery.mockResolvedValueOnce([ROW]);
      const r = await repo.listByOwner(TENANT, OWNER_ID);
      expect(r).toHaveLength(1);
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).not.toMatch(/status\s*=\s*\$/);
    });
  });

  describe('setStatus', () => {
    it('active triggers activated_at = NOW()', async () => {
      pg.tenantQuery.mockResolvedValueOnce([{ ...ROW, status: 'active', activated_at: new Date() }]);
      const r = await repo.setStatus(TENANT, CONTRACT_ID, 'active', OWNER_ID);
      expect(r.status).toBe('active');
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain('activated_at = NOW()');
    });

    it('cancelled does not touch activated_at', async () => {
      pg.tenantQuery.mockResolvedValueOnce([{ ...ROW, status: 'cancelled' }]);
      await repo.setStatus(TENANT, CONTRACT_ID, 'cancelled', OWNER_ID);
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).not.toContain('activated_at = NOW()');
    });
  });
});
