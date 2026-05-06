import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TeacherRepository } from './teacher.repository';
import { PgPoolService } from './pg-pool.service';

describe('TeacherRepository (V28 archive)', () => {
  let repo: TeacherRepository;
  let pg: {
    tenantQuery: jest.Mock;
    query: jest.Mock;
    withClient: jest.Mock;
    transaction: jest.Mock;
  };
  let txClient: { query: jest.Mock };

  const TENANT = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const CAMPUS_A = 'campus_A_00000000000000000000A001';
  const TEACHER_A = 'teacherA00000000000000000000A001';
  const TEACHER_B = 'teacherB00000000000000000000A002';

  const teacherRow = (overrides: Partial<{ id: string; status: string; campus_id: string; name: string }> = {}) => ({
    id: overrides.id || TEACHER_A,
    campus_id: overrides.campus_id || CAMPUS_A,
    name: overrides.name || '王老师',
    phone: '13800000000',
    user_id: null,
    subjects: ['数学'],
    hourly_rate_yuan: 200,
    status: overrides.status || '在职',
  });

  beforeEach(async () => {
    txClient = { query: jest.fn() };
    pg = {
      tenantQuery: jest.fn(),
      query: jest.fn(),
      withClient: jest.fn(),
      transaction: jest.fn().mockImplementation(async (fn: any) => fn(txClient)),
    };
    const m = await Test.createTestingModule({
      providers: [TeacherRepository, { provide: PgPoolService, useValue: pg }],
    }).compile();
    repo = m.get(TeacherRepository);
  });

  describe('archive (V28)', () => {
    it('归档老师 + 转关联学生 assigned_teacher_id 给同 campus 接棒老师', async () => {
      // findById
      pg.tenantQuery.mockResolvedValueOnce([teacherRow({ id: TEACHER_A })]);
      // 找接棒人（同 campus 其他在职老师）
      pg.tenantQuery.mockResolvedValueOnce([{ id: TEACHER_B, name: '李老师' }]);
      // 事务：UPDATE teachers / UPDATE students
      txClient.query
        .mockResolvedValueOnce({ rowCount: 1, rows: [teacherRow({ id: TEACHER_A, status: '归档' })] })
        .mockResolvedValueOnce({ rowCount: 7, rows: [] });
      const r = await repo.archive(TENANT, TEACHER_A, 'admin01');
      expect(r.teacher.status).toBe('归档');
      expect(r.transferToTeacherId).toBe(TEACHER_B);
      expect(r.transferToTeacherName).toBe('李老师');
      expect(r.studentsReassigned).toBe(7);
      // 事务被调用
      expect(pg.transaction).toHaveBeenCalledTimes(1);
      // students UPDATE 调用并写入 reason='老师归档'
      const studentsCall = txClient.query.mock.calls.find((c) =>
        typeof c[0] === 'string' && c[0].includes('UPDATE students'),
      );
      expect(studentsCall).toBeDefined();
      expect(studentsCall[0]).toContain('owner_change_reason');
    });

    it('同 campus 无其他在职老师 → students.assigned_teacher_id = NULL', async () => {
      pg.tenantQuery.mockResolvedValueOnce([teacherRow({ id: TEACHER_A })]);
      pg.tenantQuery.mockResolvedValueOnce([]); // 无候选
      txClient.query
        .mockResolvedValueOnce({ rowCount: 1, rows: [teacherRow({ id: TEACHER_A, status: '归档' })] })
        .mockResolvedValueOnce({ rowCount: 3, rows: [] });
      const r = await repo.archive(TENANT, TEACHER_A, 'admin01');
      expect(r.transferToTeacherId).toBeNull();
      expect(r.transferToTeacherName).toContain('无接棒人');
      expect(r.studentsReassigned).toBe(3);
      // students UPDATE params 第 2 个应为 null
      const studentsCall = txClient.query.mock.calls.find((c) =>
        typeof c[0] === 'string' && c[0].includes('UPDATE students'),
      );
      expect(studentsCall[1][1]).toBeNull();
    });

    it('已归档老师 → BadRequestException', async () => {
      pg.tenantQuery.mockResolvedValueOnce([teacherRow({ id: TEACHER_A, status: '归档' })]);
      await expect(repo.archive(TENANT, TEACHER_A, 'admin01')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('老师不存在 → NotFoundException', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await expect(repo.archive(TENANT, TEACHER_A, 'admin01')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('接棒人查询排除自己（id <> $2）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([teacherRow({ id: TEACHER_A })]);
      pg.tenantQuery.mockResolvedValueOnce([]);
      txClient.query
        .mockResolvedValueOnce({ rowCount: 1, rows: [teacherRow({ id: TEACHER_A, status: '归档' })] })
        .mockResolvedValueOnce({ rowCount: 0, rows: [] });
      await repo.archive(TENANT, TEACHER_A, 'admin01');
      const candidateCall = pg.tenantQuery.mock.calls[1];
      expect(candidateCall[1]).toContain('id <> $2');
      expect(candidateCall[2]).toEqual([CAMPUS_A, TEACHER_A]);
    });
  });
});
