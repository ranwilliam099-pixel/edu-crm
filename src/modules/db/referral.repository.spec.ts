import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ReferralRepository } from './referral.repository';
import { PgPoolService } from './pg-pool.service';

describe('ReferralRepository — V22 推荐机制', () => {
  let repo: ReferralRepository;
  let pg: { tenantQuery: jest.Mock; query: jest.Mock; withClient: jest.Mock; transaction: jest.Mock };

  const TENANT = 'tenant_v22test_aaaa';
  const TEACHER = 'tch00000000000000000000000000T01';
  const PARENT_A = 'par00000000000000000000000000P0A';
  const STUDENT_A = 'stu00000000000000000000000000S0A';
  const PARENT_B = 'par00000000000000000000000000P0B';
  const STUDENT_B = 'stu00000000000000000000000000S0B';
  const SCHEDULE = 'sch00000000000000000000000000SC1';
  const REF_ID = 'ref00000000000000000000000000R01';

  const mkClient = (responses: Record<string, any[]> = {}) => ({
    query: jest.fn().mockImplementation((sql: string) => {
      for (const [pat, rows] of Object.entries(responses)) {
        if (sql.includes(pat)) return Promise.resolve({ rows });
      }
      return Promise.resolve({ rows: [] });
    }),
  });

  beforeEach(async () => {
    pg = { tenantQuery: jest.fn(), query: jest.fn(), withClient: jest.fn(), transaction: jest.fn() };
    const m = await Test.createTestingModule({
      providers: [ReferralRepository, { provide: PgPoolService, useValue: pg }],
    }).compile();
    repo = m.get(ReferralRepository);
  });

  describe('create', () => {
    it('rejects short ulid', async () => {
      await expect(
        repo.create(TENANT, {
          id: 'short',
          teacherId: TEACHER,
          referrerParentId: PARENT_A,
          referrerStudentId: STUDENT_A,
          referralCode: 'ABC1234',
        }),
      ).rejects.toThrow(BadRequestException);
    });
    it('rejects short code', async () => {
      await expect(
        repo.create(TENANT, {
          id: REF_ID,
          teacherId: TEACHER,
          referrerParentId: PARENT_A,
          referrerStudentId: STUDENT_A,
          referralCode: 'X',
        }),
      ).rejects.toThrow(BadRequestException);
    });
    it('inserts row', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        {
          id: REF_ID, teacher_id: TEACHER, referrer_parent_id: PARENT_A,
          referrer_student_id: STUDENT_A, referee_parent_id: null, referee_student_id: null,
          referral_code: 'CODEXY12', status: 'created', trial_schedule_id: null,
          rating_id: null, rating_id_source: null, created_at: new Date(),
          trialed_at: null, rated_at: null, expires_at: new Date(), note: null,
        },
      ]);
      const r = await repo.create(TENANT, {
        id: REF_ID, teacherId: TEACHER, referrerParentId: PARENT_A,
        referrerStudentId: STUDENT_A, referralCode: 'CODEXY12',
      });
      expect(r.status).toBe('created');
      expect(r.referralCode).toBe('CODEXY12');
    });
  });

  describe('markTrialed', () => {
    const baseRow = {
      id: REF_ID, teacher_id: TEACHER, referrer_parent_id: PARENT_A,
      referrer_student_id: STUDENT_A, referee_parent_id: null, referee_student_id: null,
      referral_code: 'CODEXY12', status: 'created', trial_schedule_id: null,
      rating_id: null, rating_id_source: null,
      created_at: new Date(), trialed_at: null, rated_at: null,
      expires_at: new Date(Date.now() + 86400000), note: null,
    };

    it('created → trialed', async () => {
      const trialedRow = {
        ...baseRow, status: 'trialed', referee_parent_id: PARENT_B,
        referee_student_id: STUDENT_B, trial_schedule_id: SCHEDULE,
        trialed_at: new Date(),
      };
      const client = mkClient({
        'FOR UPDATE': [baseRow],
        "status = 'trialed'": [trialedRow],
      });
      pg.transaction.mockImplementationOnce(async (fn: any) => fn(client));
      const r = await repo.markTrialed(TENANT, 'CODEXY12', {
        refereeParentId: PARENT_B, refereeStudentId: STUDENT_B, trialScheduleId: SCHEDULE,
      });
      expect(r.status).toBe('trialed');
      expect(r.refereeParentId).toBe(PARENT_B);
    });

    it('not found → NotFound', async () => {
      const client = mkClient({ 'FOR UPDATE': [] });
      pg.transaction.mockImplementationOnce(async (fn: any) => fn(client));
      await expect(
        repo.markTrialed(TENANT, 'X', {
          refereeParentId: PARENT_B, refereeStudentId: STUDENT_B, trialScheduleId: SCHEDULE,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('expired → Conflict', async () => {
      const expiredRow = { ...baseRow, expires_at: new Date(Date.now() - 86400000) };
      const client = mkClient({ 'FOR UPDATE': [expiredRow] });
      pg.transaction.mockImplementationOnce(async (fn: any) => fn(client));
      await expect(
        repo.markTrialed(TENANT, 'CODEXY12', {
          refereeParentId: PARENT_B, refereeStudentId: STUDENT_B, trialScheduleId: SCHEDULE,
        }),
      ).rejects.toThrow(/REFERRAL_EXPIRED/);
    });

    it('referrer == referee → BadRequest（self-referral）', async () => {
      const client = mkClient({ 'FOR UPDATE': [baseRow] });
      pg.transaction.mockImplementationOnce(async (fn: any) => fn(client));
      await expect(
        repo.markTrialed(TENANT, 'CODEXY12', {
          refereeParentId: PARENT_A, refereeStudentId: STUDENT_B, trialScheduleId: SCHEDULE,
        }),
      ).rejects.toThrow(/REFEREE_CANNOT_BE_REFERRER/);
    });

    it('referee 已被推荐 → REFEREE_ALREADY_REFERRED', async () => {
      const client = {
        query: jest.fn().mockImplementation((sql: string) => {
          if (sql.includes('FOR UPDATE')) return Promise.resolve({ rows: [baseRow] });
          if (sql.includes("status = 'trialed'")) {
            const e: any = new Error('duplicate key uq_pr_referee_parent');
            e.code = '23505';
            return Promise.reject(e);
          }
          return Promise.resolve({ rows: [] });
        }),
      };
      pg.transaction.mockImplementationOnce(async (fn: any) => fn(client));
      await expect(
        repo.markTrialed(TENANT, 'CODEXY12', {
          refereeParentId: PARENT_B, refereeStudentId: STUDENT_B, trialScheduleId: SCHEDULE,
        }),
      ).rejects.toThrow(/REFEREE_ALREADY_REFERRED/);
    });
  });

  describe('markRated', () => {
    it('trialed → rated 计数 +1', async () => {
      const trialedRow = {
        id: REF_ID, teacher_id: TEACHER, referrer_parent_id: PARENT_A,
        referrer_student_id: STUDENT_A, referee_parent_id: PARENT_B,
        referee_student_id: STUDENT_B, referral_code: 'CODEXY12', status: 'trialed',
        trial_schedule_id: SCHEDULE, rating_id: null, rating_id_source: null,
        created_at: new Date(), trialed_at: new Date(), rated_at: null,
        expires_at: new Date(), note: null,
      };
      const client = mkClient({
        "status = 'trialed'": [trialedRow],
        "status = 'rated'": [{ ...trialedRow, status: 'rated', rating_id: 'feedback123', rating_id_source: 'lesson_feedback', rated_at: new Date() }],
      });
      pg.transaction.mockImplementationOnce(async (fn: any) => fn(client));
      const r = await repo.markRated(TENANT, PARENT_B, TEACHER, {
        id: 'feedback123', source: 'lesson_feedback',
      });
      expect(r?.status).toBe('rated');
    });

    it('未 trialed → null（not throw）', async () => {
      const client = mkClient({ "status = 'trialed'": [] });
      pg.transaction.mockImplementationOnce(async (fn: any) => fn(client));
      const r = await repo.markRated(TENANT, PARENT_B, TEACHER, {
        id: 'fb', source: 'lesson_feedback',
      });
      expect(r).toBeNull();
    });
  });

  describe('getTeacherStats', () => {
    it('aggregates by status', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        { status: 'rated', count: '8' },
        { status: 'trialed', count: '3' },
        { status: 'created', count: '5' },
        { status: 'expired', count: '2' },
      ]);
      const s = await repo.getTeacherStats(TENANT, TEACHER);
      expect(s).toEqual({ rated: 8, trialed: 3, pending: 5, expired: 2 });
    });
    it('empty stats', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      const s = await repo.getTeacherStats(TENANT, TEACHER);
      expect(s).toEqual({ rated: 0, trialed: 0, pending: 0, expired: 0 });
    });
  });

  describe('assertReferrerIsTeacherStudentParent', () => {
    it('binding 不存在 → BadRequest', async () => {
      pg.tenantQuery.mockResolvedValueOnce([{ count: '0' }]);
      await expect(
        repo.assertReferrerIsTeacherStudentParent(TENANT, TEACHER, PARENT_A, STUDENT_A),
      ).rejects.toThrow(/REFERRER_NOT_TEACHER_STUDENT_PARENT/);
    });
    it('parent 不绑学员 → BadRequest', async () => {
      pg.tenantQuery.mockResolvedValueOnce([{ count: '1' }]);
      pg.query.mockResolvedValueOnce([{ count: '0' }]);
      await expect(
        repo.assertReferrerIsTeacherStudentParent(TENANT, TEACHER, PARENT_A, STUDENT_A),
      ).rejects.toThrow(/REFERRER_NOT_TEACHER_STUDENT_PARENT/);
    });
    it('全通过 → 不抛错', async () => {
      pg.tenantQuery.mockResolvedValueOnce([{ count: '1' }]);
      pg.query.mockResolvedValueOnce([{ count: '1' }]);
      await expect(
        repo.assertReferrerIsTeacherStudentParent(TENANT, TEACHER, PARENT_A, STUDENT_A),
      ).resolves.toBeUndefined();
    });
  });

  describe('expirePending', () => {
    it('returns expired count', async () => {
      pg.tenantQuery.mockResolvedValueOnce([{ id: 'r1' }, { id: 'r2' }]);
      const n = await repo.expirePending(TENANT);
      expect(n).toBe(2);
    });
  });
});
