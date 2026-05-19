import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { LeaveRepository, Leave } from './leave.repository';
import { PgPoolService } from './pg-pool.service';

describe('LeaveRepository', () => {
  let repo: LeaveRepository;
  let pg: { tenantQuery: jest.Mock; query: jest.Mock; withClient: jest.Mock };

  const TENANT = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const SAMPLE: Leave = {
    id: 'leave000000000000000000000000A001',
    studentId: 'stu00000000000000000000000000A001',
    lessonId: 'sched00000000000000000000000000A',
    type: 'leave',
    reason: '生病',
    reasonNote: '感冒发烧 38°',
    status: 'pending',
    createdAt: new Date('2026-05-04T10:00:00Z'),
  };
  const ROW = {
    id: SAMPLE.id,
    student_id: SAMPLE.studentId,
    lesson_id: SAMPLE.lessonId,
    type: SAMPLE.type,
    reason: SAMPLE.reason,
    reason_note: SAMPLE.reasonNote,
    new_date: null,
    new_start_at: null,
    status: SAMPLE.status,
    reject_reason: null,
    created_at: SAMPLE.createdAt,
    decided_at: null,
  };

  beforeEach(async () => {
    pg = { tenantQuery: jest.fn(), query: jest.fn(), withClient: jest.fn() };
    const m = await Test.createTestingModule({
      providers: [LeaveRepository, { provide: PgPoolService, useValue: pg }],
    }).compile();
    repo = m.get(LeaveRepository);
  });

  describe('create', () => {
    it('inserts and maps row back', async () => {
      pg.tenantQuery.mockResolvedValueOnce([ROW]);
      const r = await repo.create(TENANT, SAMPLE);
      expect(r.id).toBe(SAMPLE.id);
      expect(r.type).toBe('leave');
      expect(r.status).toBe('pending');
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain('INSERT INTO leaves');
    });

    it('reschedule type with new_start_at', async () => {
      const reschedule: Leave = {
        ...SAMPLE,
        type: 'reschedule',
        newDate: new Date('2026-05-10'),
        newStartAt: new Date('2026-05-10T15:00:00Z'),
      };
      pg.tenantQuery.mockResolvedValueOnce([
        {
          ...ROW,
          type: 'reschedule',
          new_date: reschedule.newDate,
          new_start_at: reschedule.newStartAt,
        },
      ]);
      const r = await repo.create(TENANT, reschedule);
      expect(r.type).toBe('reschedule');
      expect(r.newStartAt).toEqual(reschedule.newStartAt);
    });
  });

  describe('findByStudent', () => {
    it('orders by created_at DESC with limit', async () => {
      pg.tenantQuery.mockResolvedValueOnce([ROW, ROW]);
      const r = await repo.findByStudent(TENANT, SAMPLE.studentId, 30);
      expect(r).toHaveLength(2);
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain('ORDER BY created_at DESC');
      expect(pg.tenantQuery.mock.calls[0][2]).toEqual([SAMPLE.studentId, 30]);
    });

    it('uses default limit 50', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.findByStudent(TENANT, SAMPLE.studentId);
      expect(pg.tenantQuery.mock.calls[0][2]).toEqual([SAMPLE.studentId, 50]);
    });
  });

  describe('approve', () => {
    it('without new schedule sets status approved', async () => {
      pg.tenantQuery.mockResolvedValueOnce([{ ...ROW, status: 'approved', decided_at: new Date() }]);
      const r = await repo.approve(TENANT, SAMPLE.id);
      expect(r.status).toBe('approved');
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain("status = 'approved'");
      expect(sql).toContain('decided_at = NOW()');
    });

    it('with new schedule writes new_date / new_start_at', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        {
          ...ROW,
          status: 'approved',
          new_date: new Date('2026-05-10'),
          new_start_at: new Date('2026-05-10T15:00:00Z'),
          decided_at: new Date(),
        },
      ]);
      await repo.approve(TENANT, SAMPLE.id, {
        newDate: new Date('2026-05-10'),
        newStartAt: new Date('2026-05-10T15:00:00Z'),
      });
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain('new_date = $1');
      expect(sql).toContain('new_start_at = $2');
    });

    it('throws NotFoundException when 0 rows', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await expect(repo.approve(TENANT, 'nope')).rejects.toThrow(NotFoundException);
    });
  });

  describe('reject', () => {
    it('writes reject_reason + status=rejected', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        { ...ROW, status: 'rejected', reject_reason: '请假理由不充分', decided_at: new Date() },
      ]);
      const r = await repo.reject(TENANT, SAMPLE.id, '请假理由不充分');
      expect(r.status).toBe('rejected');
      expect(r.rejectReason).toBe('请假理由不充分');
    });

    it('throws NotFoundException when 0 rows', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await expect(repo.reject(TENANT, 'nope', 'x')).rejects.toThrow(NotFoundException);
    });
  });

  describe('findById', () => {
    it('returns null when not found', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      expect(await repo.findById(TENANT, 'nope')).toBeNull();
    });
  });
});
