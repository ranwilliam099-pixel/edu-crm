import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { StudentRepository } from './student.repository';
import { PgPoolService } from './pg-pool.service';

describe('StudentRepository (V28)', () => {
  let repo: StudentRepository;
  let pg: { tenantQuery: jest.Mock; query: jest.Mock; withClient: jest.Mock };

  const TENANT = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const STUDENT_ID = 'student00000000000000000000A001S';
  const SALES_A = 'salesA00000000000000000000000A01';
  const SALES_B = 'salesB00000000000000000000000A02';
  const TEACHER_A = 'teacherA00000000000000000000A001';
  const TEACHER_B = 'teacherB00000000000000000000A002';

  const studentRow = (overrides: Partial<{ owner_sales_id: string | null; assigned_teacher_id: string | null }> = {}) => ({
    id: STUDENT_ID,
    student_name: '小明',
    customer_id: 'cust00000000000000000000000A001C',
    owner_sales_id: 'owner_sales_id' in overrides ? overrides.owner_sales_id : SALES_A,
    assigned_teacher_id: 'assigned_teacher_id' in overrides ? overrides.assigned_teacher_id : TEACHER_A,
    owner_changed_at: null,
    owner_change_reason: null,
  });

  beforeEach(async () => {
    pg = { tenantQuery: jest.fn(), query: jest.fn(), withClient: jest.fn() };
    const m = await Test.createTestingModule({
      providers: [StudentRepository, { provide: PgPoolService, useValue: pg }],
    }).compile();
    repo = m.get(StudentRepository);
  });

  describe('transferSales', () => {
    it('成功转给另一个销售 → owner_sales_id 改写 + reason 留痕', async () => {
      pg.tenantQuery.mockResolvedValueOnce([studentRow()]);
      pg.tenantQuery.mockResolvedValueOnce([{ id: STUDENT_ID, owner_sales_id: SALES_B }]);
      const r = await repo.transferSales(TENANT, STUDENT_ID, SALES_B, '校长再分配');
      expect(r.field).toBe('owner_sales_id');
      expect(r.fromUserId).toBe(SALES_A);
      expect(r.toUserId).toBe(SALES_B);
      // SQL 写入 owner_change_reason
      const updateCall = pg.tenantQuery.mock.calls[1];
      expect(updateCall[1]).toContain('owner_change_reason');
      expect(updateCall[2]).toEqual([STUDENT_ID, SALES_B, '校长再分配']);
    });

    it('toSalesId=null → 退回池', async () => {
      pg.tenantQuery.mockResolvedValueOnce([studentRow()]);
      pg.tenantQuery.mockResolvedValueOnce([{ id: STUDENT_ID, owner_sales_id: null }]);
      const r = await repo.transferSales(TENANT, STUDENT_ID, null, '校长再分配');
      expect(r.toUserId).toBeNull();
    });

    it('已是该销售归属 → BadRequestException', async () => {
      pg.tenantQuery.mockResolvedValueOnce([studentRow({ owner_sales_id: SALES_B })]);
      await expect(
        repo.transferSales(TENANT, STUDENT_ID, SALES_B, '校长再分配'),
      ).rejects.toThrow(/无须转交/);
    });

    it('reason 为空 → BadRequestException', async () => {
      await expect(repo.transferSales(TENANT, STUDENT_ID, SALES_B, '')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('学生不存在 → NotFoundException', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await expect(
        repo.transferSales(TENANT, STUDENT_ID, SALES_B, '校长再分配'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('transferTeacher', () => {
    it('成功转给另一个老师 → assigned_teacher_id 改写', async () => {
      pg.tenantQuery.mockResolvedValueOnce([studentRow()]);
      pg.tenantQuery.mockResolvedValueOnce([{ id: STUDENT_ID, assigned_teacher_id: TEACHER_B }]);
      const r = await repo.transferTeacher(TENANT, STUDENT_ID, TEACHER_B, '主带老师调整');
      expect(r.field).toBe('assigned_teacher_id');
      expect(r.fromUserId).toBe(TEACHER_A);
      expect(r.toUserId).toBe(TEACHER_B);
    });

    it('toTeacherId=null → 暂无主带老师', async () => {
      pg.tenantQuery.mockResolvedValueOnce([studentRow()]);
      pg.tenantQuery.mockResolvedValueOnce([{ id: STUDENT_ID, assigned_teacher_id: null }]);
      const r = await repo.transferTeacher(TENANT, STUDENT_ID, null, '老师离职');
      expect(r.toUserId).toBeNull();
    });

    it('已是该老师 → BadRequestException', async () => {
      pg.tenantQuery.mockResolvedValueOnce([studentRow({ assigned_teacher_id: TEACHER_B })]);
      await expect(
        repo.transferTeacher(TENANT, STUDENT_ID, TEACHER_B, '调整'),
      ).rejects.toThrow(/无须转交/);
    });
  });

  describe('findBrief', () => {
    it('返回 brief 含 V28 字段', async () => {
      pg.tenantQuery.mockResolvedValueOnce([studentRow()]);
      const r = await repo.findBrief(TENANT, STUDENT_ID);
      expect(r?.ownerSalesId).toBe(SALES_A);
      expect(r?.assignedTeacherId).toBe(TEACHER_A);
    });

    it('null when not found', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      expect(await repo.findBrief(TENANT, STUDENT_ID)).toBeNull();
    });
  });
});
