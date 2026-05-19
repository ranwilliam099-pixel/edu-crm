import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { StudentRepository } from './student.repository';
import { PgPoolService } from './pg-pool.service';
import { ParentRepository } from './parent.repository';
import { AuditLogRepository } from './audit-log.repository';

describe('StudentRepository (V28 + V44 软删除)', () => {
  let repo: StudentRepository;
  let pg: {
    tenantQuery: jest.Mock;
    query: jest.Mock;
    withClient: jest.Mock;
    transaction: jest.Mock;
  };
  let txClient: { query: jest.Mock };
  let parentRepo: { expireBindingsForDeletedStudents: jest.Mock };
  let auditLog: { log: jest.Mock };

  const TENANT = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const TENANT_ID_RAW = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const STUDENT_ID = 'student00000000000000000000A001S';
  const SALES_A = 'salesA00000000000000000000000A01';
  const SALES_B = 'salesB00000000000000000000000A02';
  const TEACHER_A = 'teacherA00000000000000000000A001';
  const TEACHER_B = 'teacherB00000000000000000000A002';
  const OPERATOR_ID = 'opUserABC00000000000000000000A001';

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
    txClient = { query: jest.fn() };
    pg = {
      tenantQuery: jest.fn(),
      query: jest.fn(),
      withClient: jest.fn(),
      transaction: jest.fn().mockImplementation(async (fn: any) => fn(txClient)),
    };
    parentRepo = {
      expireBindingsForDeletedStudents: jest.fn().mockResolvedValue({ unbounded: 0 }),
    };
    auditLog = { log: jest.fn().mockResolvedValue(undefined) };
    const m = await Test.createTestingModule({
      providers: [
        StudentRepository,
        { provide: PgPoolService, useValue: pg },
        { provide: ParentRepository, useValue: parentRepo },
        { provide: AuditLogRepository, useValue: auditLog },
      ],
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
    it('SQL 包含 WHERE s.assigned_teacher_id = $1 + V44 deleted_at IS NULL + 默认 limit 100 + V29 R14.4 contract_class_type join', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.listByTeacher(TENANT, TEACHER_A);
      const [, sql, params] = pg.tenantQuery.mock.calls[0];
      expect(sql).toContain('s.assigned_teacher_id = $1');
      expect(sql).toContain('s.deleted_at IS NULL'); // V44 软删除排除
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

    it('V44: SQL 包含 deleted_at IS NULL（软删学员返回 null）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.findBrief(TENANT, STUDENT_ID);
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain('deleted_at IS NULL');
    });
  });

  describe('listAll (V44 软删除 filter)', () => {
    it('默认 SQL 包含 s.deleted_at IS NULL 即使无 owner/teacher 过滤', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.listAll(TENANT);
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain('s.deleted_at IS NULL');
      expect(sql).toContain('ORDER BY s.created_at DESC');
    });

    it('owner_sales_id 过滤时仍包含 deleted_at IS NULL', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.listAll(TENANT, { ownerSalesId: SALES_A });
      const [, sql, params] = pg.tenantQuery.mock.calls[0];
      expect(sql).toContain('s.deleted_at IS NULL');
      expect(sql).toContain('s.owner_sales_id = $1');
      expect(params[0]).toBe(SALES_A);
    });

    it('两个过滤联合 + V44 filter 三者并存', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.listAll(TENANT, { ownerSalesId: SALES_A, assignedTeacherId: TEACHER_A });
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain('s.deleted_at IS NULL');
      expect(sql).toContain('s.owner_sales_id = $1');
      expect(sql).toContain('s.assigned_teacher_id = $2');
    });
  });

  // ============================================================
  // V44 软删除 — softDelete()
  // 来源：2026-05-16 T12 spec / R1 audit P0-3
  // ============================================================
  describe('softDelete (V44 软删除)', () => {
    const DELETED_AT = '2026-05-16T10:00:00.000Z';

    it('成功软删 → UPDATE deleted_at + 同事务调 binding 解绑 + audit_log', async () => {
      // 事务内 client.query 顺序：
      //   1. UPDATE students RETURNING id, deleted_at
      txClient.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: STUDENT_ID, deleted_at: DELETED_AT }],
      });
      parentRepo.expireBindingsForDeletedStudents.mockResolvedValueOnce({ unbounded: 2 });

      const r = await repo.softDelete(TENANT, STUDENT_ID, TENANT_ID_RAW, {
        userId: OPERATOR_ID,
        role: 'admin',
      });

      expect(r.studentId).toBe(STUDENT_ID);
      expect(r.deletedAt).toBe(DELETED_AT);
      expect(r.bindingsExpired).toBe(2);

      // 事务执行
      expect(pg.transaction).toHaveBeenCalledTimes(1);
      // UPDATE SQL 含 WHERE id = $1 AND deleted_at IS NULL（幂等保护）
      const updateSql = txClient.query.mock.calls[0][0] as string;
      expect(updateSql).toContain('UPDATE students');
      expect(updateSql).toContain('SET deleted_at = NOW()');
      expect(updateSql).toContain('WHERE id = $1 AND deleted_at IS NULL');
      expect(txClient.query.mock.calls[0][1]).toEqual([STUDENT_ID]);

      // binding 解绑同事务调用（传 client）
      expect(parentRepo.expireBindingsForDeletedStudents).toHaveBeenCalledWith(
        TENANT_ID_RAW,
        [STUDENT_ID],
        txClient,
      );

      // audit_log 事务外（V33 设计：fail-open 避免审计失败回滚业务）
      expect(auditLog.log).toHaveBeenCalledTimes(1);
      const auditCall = auditLog.log.mock.calls[0];
      expect(auditCall[0]).toBe(TENANT);
      expect(auditCall[1]).toMatchObject({
        actorUserId: OPERATOR_ID,
        actorRole: 'admin',
        action: 'student.soft-delete',
        targetType: 'student',
        targetId: STUDENT_ID,
      });
      expect(auditCall[1].before).toEqual({ deletedAt: null });
      expect(auditCall[1].after).toEqual({
        deletedAt: DELETED_AT,
        bindingsExpired: 2,
      });
    });

    it('幂等：已软删的学员 → BadRequestException（probe 找到行但 deleted_at NOT NULL）', async () => {
      // UPDATE rowCount=0
      txClient.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
      // probe SELECT 找到行（表示存在，但已软删）
      txClient.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: STUDENT_ID, deleted_at: '2026-05-15T08:00:00Z' }],
      });

      await expect(
        repo.softDelete(TENANT, STUDENT_ID, TENANT_ID_RAW, {
          userId: OPERATOR_ID,
          role: 'admin',
        }),
      ).rejects.toThrow(/已软删除/);

      // 软删失败 → 不调 binding，不写 audit_log
      expect(parentRepo.expireBindingsForDeletedStudents).not.toHaveBeenCalled();
      expect(auditLog.log).not.toHaveBeenCalled();
    });

    it('不存在的学员 → NotFoundException', async () => {
      txClient.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
      txClient.query.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // probe 也找不到

      await expect(
        repo.softDelete(TENANT, STUDENT_ID, TENANT_ID_RAW, {
          userId: OPERATOR_ID,
          role: 'admin',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('studentId 非 32-char → BadRequest（不进事务）', async () => {
      await expect(
        repo.softDelete(TENANT, 'short', TENANT_ID_RAW, {
          userId: OPERATOR_ID,
          role: 'admin',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(pg.transaction).not.toHaveBeenCalled();
    });

    it('tenantId 空 → BadRequest', async () => {
      await expect(
        repo.softDelete(TENANT, STUDENT_ID, '', {
          userId: OPERATOR_ID,
          role: 'admin',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('FK 联动：bindingsExpired=0 也成功返回（学员无 binding）', async () => {
      txClient.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: STUDENT_ID, deleted_at: DELETED_AT }],
      });
      parentRepo.expireBindingsForDeletedStudents.mockResolvedValueOnce({ unbounded: 0 });

      const r = await repo.softDelete(TENANT, STUDENT_ID, TENANT_ID_RAW, {
        userId: OPERATOR_ID,
        role: 'boss',
      });
      expect(r.bindingsExpired).toBe(0);
      expect(auditLog.log).toHaveBeenCalledTimes(1);
    });

    it('audit_log fail-open：未注入 auditLog 也能完成软删（@Optional 占位）', async () => {
      const repoNoAudit = await Test.createTestingModule({
        providers: [
          StudentRepository,
          { provide: PgPoolService, useValue: pg },
          { provide: ParentRepository, useValue: parentRepo },
        ],
      }).compile().then((m) => m.get(StudentRepository));

      txClient.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: STUDENT_ID, deleted_at: DELETED_AT }],
      });
      parentRepo.expireBindingsForDeletedStudents.mockResolvedValueOnce({ unbounded: 1 });

      await expect(
        repoNoAudit.softDelete(TENANT, STUDENT_ID, TENANT_ID_RAW, {
          userId: OPERATOR_ID,
          role: 'admin',
        }),
      ).resolves.toMatchObject({ bindingsExpired: 1 });
    });

    it('actorRole 越界字符串 → normalize 到 system（V33 白名单兜底）', async () => {
      txClient.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: STUDENT_ID, deleted_at: DELETED_AT }],
      });
      parentRepo.expireBindingsForDeletedStudents.mockResolvedValueOnce({ unbounded: 0 });

      await repo.softDelete(TENANT, STUDENT_ID, TENANT_ID_RAW, {
        userId: OPERATOR_ID,
        role: 'unknown_role_xyz',
      });
      // normalizeActorRole 未命中白名单 → fallback 'system'
      expect(auditLog.log.mock.calls[0][1].actorRole).toBe('system');
    });
  });
});
