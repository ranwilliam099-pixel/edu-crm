import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { HomeworkRepository } from './homework.repository';
import { PgPoolService } from './pg-pool.service';
import {
  HomeworkAssignment,
  HomeworkSubmission,
} from '../homework/homework.service';

describe('HomeworkRepository', () => {
  let repo: HomeworkRepository;
  let pg: { tenantQuery: jest.Mock; query: jest.Mock; withClient: jest.Mock };

  const TENANT = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const ASSIGNMENT: HomeworkAssignment = {
    id: 'asg00000000000000000000000000A001',
    teacherId: 'teach000000000000000000000000A001',
    title: '英语阅读',
    content: '完成 P10-P15',
    attachments: [{ url: 'a.pdf', type: 'pdf', filename: 'a.pdf' }],
    difficulty: '中',
    status: 'published',
    recipientStudentIds: [
      'stu00000000000000000000000000A001',
      'stu00000000000000000000000000A002',
    ],
    createdAt: new Date('2026-05-02T10:00:00Z'),
  };
  const ASG_ROW = {
    id: ASSIGNMENT.id,
    schedule_id: null,
    teacher_id: ASSIGNMENT.teacherId,
    title: ASSIGNMENT.title,
    content: ASSIGNMENT.content,
    attachments: JSON.stringify(ASSIGNMENT.attachments),
    due_at: null,
    difficulty: ASSIGNMENT.difficulty,
    status: ASSIGNMENT.status,
    created_at: ASSIGNMENT.createdAt,
    recipients: ASSIGNMENT.recipientStudentIds,
  };
  const SUBMISSION: HomeworkSubmission = {
    id: 'sub00000000000000000000000000A001',
    assignmentId: ASSIGNMENT.id,
    studentId: 'stu00000000000000000000000000A001',
    content: '我做完了',
    status: 'submitted',
    submittedAt: new Date('2026-05-03T10:00:00Z'),
  };
  const SUB_ROW = {
    id: SUBMISSION.id,
    assignment_id: SUBMISSION.assignmentId,
    student_id: SUBMISSION.studentId,
    submitted_by_parent_id: null,
    content: SUBMISSION.content,
    attachments: null,
    status: 'submitted',
    grade: null,
    teacher_comment: null,
    graded_at: null,
    graded_by_user_id: null,
    submitted_at: SUBMISSION.submittedAt,
  };

  beforeEach(async () => {
    pg = { tenantQuery: jest.fn(), query: jest.fn(), withClient: jest.fn() };
    const m = await Test.createTestingModule({
      providers: [HomeworkRepository, { provide: PgPoolService, useValue: pg }],
    }).compile();
    repo = m.get(HomeworkRepository);
  });

  describe('insertAssignmentWithRecipients', () => {
    it('runs in transaction with INSERT + N recipients', async () => {
      const calls: { sql: string; params?: any[] }[] = [];
      pg.withClient.mockImplementationOnce(async (fn: any) => {
        const client = {
          query: jest.fn(async (sql: string, params?: any[]) => {
            calls.push({ sql, params });
            return { rows: [], rowCount: 1 };
          }),
        };
        return fn(client);
      });
      const r = await repo.insertAssignmentWithRecipients(TENANT, ASSIGNMENT);
      expect(r.id).toBe(ASSIGNMENT.id);
      expect(calls.some((c) => c.sql.startsWith('BEGIN'))).toBe(true);
      expect(calls.some((c) => c.sql.startsWith('COMMIT'))).toBe(true);
      expect(calls.filter((c) => c.sql.includes('INSERT INTO assignment_recipients'))).toHaveLength(2);
    });

    it('rolls back on error', async () => {
      let rolledBack = false;
      pg.withClient.mockImplementationOnce(async (fn: any) => {
        const client = {
          query: jest.fn(async (sql: string) => {
            if (sql.includes('INSERT INTO homework_assignments')) throw new Error('boom');
            if (sql === 'ROLLBACK') rolledBack = true;
            return { rows: [], rowCount: 1 };
          }),
        };
        return fn(client);
      });
      await expect(
        repo.insertAssignmentWithRecipients(TENANT, ASSIGNMENT),
      ).rejects.toThrow('boom');
      expect(rolledBack).toBe(true);
    });
  });

  describe('findAssignmentById', () => {
    it('returns null when not found', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      expect(await repo.findAssignmentById(TENANT, 'nope')).toBeNull();
    });
    it('maps recipients array from PG', async () => {
      pg.tenantQuery.mockResolvedValueOnce([ASG_ROW]);
      const r = await repo.findAssignmentById(TENANT, ASSIGNMENT.id);
      expect(r?.recipientStudentIds).toEqual(ASSIGNMENT.recipientStudentIds);
    });
  });

  describe('listAssignmentsByStudent', () => {
    it('joins assignment_recipients and filters published', async () => {
      pg.tenantQuery.mockResolvedValueOnce([ASG_ROW]);
      await repo.listAssignmentsByStudent(TENANT, 'stu00000000000000000000000000A001');
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain('JOIN assignment_recipients');
      expect(sql).toContain("a.status = 'published'");
    });
  });

  describe('setAssignmentStatus', () => {
    it('NotFoundException on 0 rows', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await expect(
        repo.setAssignmentStatus(TENANT, 'nope', 'archived'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('insertSubmission', () => {
    it('UPSERTs (allows resubmit after returned)', async () => {
      pg.tenantQuery.mockResolvedValueOnce([SUB_ROW]);
      await repo.insertSubmission(TENANT, SUBMISSION);
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain('ON CONFLICT (assignment_id, student_id) DO UPDATE');
    });
  });

  describe('listPendingByTeacher', () => {
    it('joins homework_assignments + filters submitted', async () => {
      pg.tenantQuery.mockResolvedValueOnce([SUB_ROW]);
      await repo.listPendingByTeacher(TENANT, ASSIGNMENT.teacherId);
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain('JOIN homework_assignments');
      expect(sql).toContain("s.status = 'submitted'");
    });
  });

  describe('grade', () => {
    it('rejects returned submissions', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await expect(
        repo.grade(TENANT, SUBMISSION.id, 'A', '不错', 't' + 'x'.repeat(31)),
      ).rejects.toThrow(NotFoundException);
    });
    it('sets graded fields atomically', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        {
          ...SUB_ROW,
          status: 'graded',
          grade: 'A',
          teacher_comment: '不错',
          graded_at: new Date(),
          graded_by_user_id: 't' + 'x'.repeat(31),
        },
      ]);
      const r = await repo.grade(TENANT, SUBMISSION.id, 'A', '不错', 't' + 'x'.repeat(31));
      expect(r.status).toBe('graded');
      expect(r.grade).toBe('A');
    });
  });

  describe('returnForRedo', () => {
    it('NotFoundException on missing', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await expect(
        repo.returnForRedo(TENANT, 'nope', '重做'),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
