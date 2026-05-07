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
    grade_or_age: '三年级',
    intended_subject: '英语',
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

  describe('create (V29 R2 — 销售即时建学生)', () => {
    it('成功创建：返回 brief + INSERT 写入 owner_sales_id', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        {
          id: STUDENT_ID,
          student_name: '王小明',
          customer_id: 'cust00000000000000000000000A001C',
          owner_sales_id: SALES_A,
          assigned_teacher_id: TEACHER_A,
          owner_changed_at: null,
          owner_change_reason: null,
        },
      ]);
      const r = await repo.create(TENANT, {
        id: STUDENT_ID,
        studentName: '王小明',
        customerId: 'cust00000000000000000000000A001C',
        ownerSalesId: SALES_A,
        assignedTeacherId: TEACHER_A,
        operatorUserId: SALES_A,
      });
      expect(r.studentName).toBe('王小明');
      expect(r.ownerSalesId).toBe(SALES_A);
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain('INSERT INTO students');
      expect(sql).toContain('owner_sales_id');
    });

    it('id 非 32 字符 → BadRequest', async () => {
      await expect(
        repo.create(TENANT, {
          id: 'short',
          studentName: '王小明',
          customerId: 'cust00000000000000000000000A001C',
          operatorUserId: SALES_A,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('customerId 非 32 字符 → BadRequest', async () => {
      await expect(
        repo.create(TENANT, {
          id: STUDENT_ID,
          studentName: '王小明',
          customerId: 'short',
          operatorUserId: SALES_A,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('studentName 空 → BadRequest', async () => {
      await expect(
        repo.create(TENANT, {
          id: STUDENT_ID,
          studentName: '',
          customerId: 'cust00000000000000000000000A001C',
          operatorUserId: SALES_A,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('listByTeacher (V29 R4 老师视角)', () => {
    it('SQL 包含 WHERE s.assigned_teacher_id = $1 + 默认 limit 100 + V29 R14.4 contract_class_type join', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.listByTeacher(TENANT, TEACHER_A);
      const [, sql, params] = pg.tenantQuery.mock.calls[0];
      expect(sql).toContain('s.assigned_teacher_id = $1');
      expect(sql).toContain('ORDER BY s.created_at DESC');
      expect(sql).toContain('contract_class_type');  // R14.4 join
      expect(params[0]).toBe(TEACHER_A);
      expect(params[1]).toBe(100);
      expect(params[2]).toBe(0);
    });

    it('limit/offset 可定制', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.listByTeacher(TENANT, TEACHER_A, { limit: 30, offset: 60 });
      const params = pg.tenantQuery.mock.calls[0][2];
      expect(params[1]).toBe(30);
      expect(params[2]).toBe(60);
    });

    it('返回 StudentBrief 数组', async () => {
      pg.tenantQuery.mockResolvedValueOnce([studentRow(), studentRow()]);
      const r = await repo.listByTeacher(TENANT, TEACHER_A);
      expect(r).toHaveLength(2);
      expect(r[0].assignedTeacherId).toBe(TEACHER_A);
    });

    it('V29 R14.4 mapBrief 透出 contract_class_type 列', async () => {
      pg.tenantQuery.mockResolvedValueOnce([{ ...studentRow(), contract_class_type: '小班' }]);
      const r = await repo.listByTeacher(TENANT, TEACHER_A);
      expect(r[0].contractClassType).toBe('小班');
    });

    it('V29 R14.4 学员无 active 合同 → contractClassType=null', async () => {
      pg.tenantQuery.mockResolvedValueOnce([{ ...studentRow(), contract_class_type: null }]);
      const r = await repo.listByTeacher(TENANT, TEACHER_A);
      expect(r[0].contractClassType).toBeNull();
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
