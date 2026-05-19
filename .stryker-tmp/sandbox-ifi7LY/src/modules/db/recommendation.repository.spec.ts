import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  RecommendationRepository,
  ParentRecommendation,
} from './recommendation.repository';
import { PgPoolService } from './pg-pool.service';

describe('RecommendationRepository', () => {
  let repo: RecommendationRepository;
  let pg: { tenantQuery: jest.Mock; query: jest.Mock; withClient: jest.Mock };

  const TENANT = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const REC: ParentRecommendation = {
    id: 'rec00000000000000000000000000A001',
    teacherId: 'teach000000000000000000000000A001',
    parentId: 'par00000000000000000000000000A001',
    studentId: 'stu00000000000000000000000000A001',
    stars: 5,
    content: '老师非常耐心',
    tags: ['耐心', '专业'],
    parentAuthorized: true,
    displayed: false,
    submittedAt: new Date('2026-05-04T10:00:00Z'),
    createdAt: new Date('2026-05-04T10:00:00Z'),
  };
  const ROW = {
    id: REC.id,
    teacher_id: REC.teacherId,
    parent_id: REC.parentId,
    student_id: REC.studentId,
    stars: REC.stars,
    content: REC.content,
    tags: JSON.stringify(REC.tags),
    parent_authorized: true,
    displayed: false,
    submitted_at: REC.submittedAt,
    created_at: REC.createdAt,
  };

  beforeEach(async () => {
    pg = { tenantQuery: jest.fn(), query: jest.fn(), withClient: jest.fn() };
    const m = await Test.createTestingModule({
      providers: [
        RecommendationRepository,
        { provide: PgPoolService, useValue: pg },
      ],
    }).compile();
    repo = m.get(RecommendationRepository);
  });

  describe('insert', () => {
    it('serializes tags JSON and maps row', async () => {
      pg.tenantQuery.mockResolvedValueOnce([ROW]);
      const r = await repo.insert(TENANT, REC);
      expect(r.id).toBe(REC.id);
      expect(r.tags).toEqual(['耐心', '专业']);
      expect(r.parentAuthorized).toBe(true);
      const params = pg.tenantQuery.mock.calls[0][2];
      expect(params[6]).toBe(JSON.stringify(REC.tags));
    });
  });

  describe('listByTeacher', () => {
    it('orders submitted_at DESC', async () => {
      pg.tenantQuery.mockResolvedValueOnce([ROW]);
      await repo.listByTeacher(TENANT, REC.teacherId);
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain('ORDER BY submitted_at DESC');
    });
  });

  describe('toggleDisplayed', () => {
    it('approves displayed=true when parent_authorized=true', async () => {
      pg.tenantQuery.mockResolvedValueOnce([{ ...ROW, displayed: true }]);
      const r = await repo.toggleDisplayed(TENANT, REC.id, true);
      expect(r.displayed).toBe(true);
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain('parent_authorized = TRUE OR $1 = FALSE');
    });

    it('always allows displayed=false (turn off)', async () => {
      pg.tenantQuery.mockResolvedValueOnce([{ ...ROW, displayed: false }]);
      const r = await repo.toggleDisplayed(TENANT, REC.id, false);
      expect(r.displayed).toBe(false);
    });

    it('throws BadRequestException when parent_authorized=false and trying displayed=true', async () => {
      // first UPDATE returns 0 rows
      pg.tenantQuery.mockResolvedValueOnce([]);
      // second SELECT confirms record exists with parent_authorized=false
      pg.tenantQuery.mockResolvedValueOnce([{ parent_authorized: false }]);
      await expect(repo.toggleDisplayed(TENANT, REC.id, true)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws NotFoundException when record missing', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      pg.tenantQuery.mockResolvedValueOnce([]);
      await expect(repo.toggleDisplayed(TENANT, 'nope', true)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('countDisplayed', () => {
    it('counts only displayed=true', async () => {
      pg.tenantQuery.mockResolvedValueOnce([{ count: '3' }]);
      const c = await repo.countDisplayed(TENANT, REC.teacherId);
      expect(c).toBe(3);
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain('displayed = TRUE');
    });

    it('returns 0 when no rows', async () => {
      pg.tenantQuery.mockResolvedValueOnce([{ count: '0' }]);
      const c = await repo.countDisplayed(TENANT, REC.teacherId);
      expect(c).toBe(0);
    });
  });

  describe('inviteParent', () => {
    it('returns mock ok msg', async () => {
      const r = await repo.inviteParent(TENANT, REC.teacherId, REC.studentId);
      expect(r.ok).toBe(true);
      expect(r.msg).toContain('mock');
    });
  });
});
