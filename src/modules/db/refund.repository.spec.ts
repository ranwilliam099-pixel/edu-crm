import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { RefundRepository } from './refund.repository';
import { PgPoolService } from './pg-pool.service';

/**
 * RefundRepository spec — V59 退费工单 + Phase 3 (2026-05-30 item #1) JOIN 可读名
 *
 * 重点覆盖：
 *   - listPendingInDb LEFT JOIN 返 studentName / parentName / courseName（财务列表可读性）
 *   - 列名正确性（students.student_name / customers.parent_name / course_products.product_name）
 *   - campus scope WHERE 仍以 ro. 别名限定（跨租户/跨校隔离不破）
 *   - 非 JOIN 路径（findByIdInDb / listInDb）不挂 *Name 字段（向后兼容）
 *   - PII 自查：SELECT 不含手机号 / 身份证列
 */
describe('RefundRepository (V59 + Phase3 item#1 JOIN 可读名)', () => {
  let repo: RefundRepository;
  let pg: { tenantQuery: jest.Mock };

  const TENANT = 'tenant_refundtest_aaaa';
  const CAMPUS = 'cmp00000000000000000000000000C01';
  const REFUND_ID = 'rfd00000000000000000000000000R01';
  const CONTRACT = 'ctr00000000000000000000000000T01';
  const STUDENT = 'stu00000000000000000000000000S01';
  const CUSTOMER = 'cus00000000000000000000000000C01';

  const baseRow = (overrides: Record<string, any> = {}) => ({
    id: REFUND_ID,
    contract_id: CONTRACT,
    student_id: STUDENT,
    customer_id: CUSTOMER,
    amount: '1200.00',
    reason: '学员搬家',
    applicant_user_id: 'usr00000000000000000000000000U01',
    applicant_role: 'sales',
    applied_at: new Date('2026-05-30T08:00:00Z'),
    status: 'pending',
    approver_user_id: null,
    approver_role: null,
    decided_at: null,
    decision_reason: null,
    campus_id: CAMPUS,
    ...overrides,
  });

  beforeEach(async () => {
    pg = { tenantQuery: jest.fn() };
    const m = await Test.createTestingModule({
      providers: [RefundRepository, { provide: PgPoolService, useValue: pg }],
    }).compile();
    repo = m.get(RefundRepository);
  });

  describe('listPendingInDb — JOIN 可读名', () => {
    it('返回 studentName / parentName / courseName（JOIN 列填充）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        baseRow({ student_name: '王小明', parent_name: '王爸爸', course_name: '初三数学一对一' }),
      ]);

      const result = await repo.listPendingInDb(TENANT, { campusId: CAMPUS });

      expect(result).toHaveLength(1);
      expect(result[0].studentName).toBe('王小明');
      expect(result[0].parentName).toBe('王爸爸');
      expect(result[0].courseName).toBe('初三数学一对一');
      // 基础字段仍正确
      expect(result[0].amount).toBe(1200);
      expect(result[0].status).toBe('pending');
    });

    it('SQL: LEFT JOIN students/customers/contracts/course_products 用真实列名', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);

      await repo.listPendingInDb(TENANT, {});

      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      // students.student_name（非 .name）
      expect(sql).toMatch(/LEFT JOIN students\s+s\s+ON s\.id\s+= ro\.student_id/);
      expect(sql).toMatch(/s\.student_name/);
      // customers.parent_name
      expect(sql).toMatch(/LEFT JOIN customers\s+c\s+ON c\.id\s+= ro\.customer_id/);
      expect(sql).toMatch(/c\.parent_name/);
      // contract → course_products.product_name
      expect(sql).toMatch(/LEFT JOIN contracts\s+ct\s+ON ct\.id\s+= ro\.contract_id/);
      expect(sql).toMatch(/LEFT JOIN course_products\s+cp\s+ON cp\.id\s+= ct\.course_product_id/);
      expect(sql).toMatch(/cp\.product_name/);
    });

    it('PII 自查: SELECT 不含手机号 / 身份证列', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.listPendingInDb(TENANT, {});
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).not.toMatch(/primary_mobile|phone|id_number|id_card/i);
    });

    it('campus scope: WHERE 以 ro. 别名限定 status + campus_id（隔离不破）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);

      await repo.listPendingInDb(TENANT, { campusId: CAMPUS });

      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      const params = pg.tenantQuery.mock.calls[0][2] as any[];
      expect(sql).toMatch(/ro\.status = 'pending'/);
      expect(sql).toMatch(/ro\.campus_id = \$3/);
      expect(params).toContain(CAMPUS);
      // tenantSchema 透传给 pg.tenantQuery（schema-per-tenant 隔离）
      expect(pg.tenantQuery.mock.calls[0][0]).toBe(TENANT);
    });

    it('无 campusId → 不加 campus 过滤（boss/admin 跨校）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.listPendingInDb(TENANT, {});
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).not.toMatch(/ro\.campus_id =/);
    });

    it('JOIN 列为 NULL（孤儿/历史数据）→ *Name = undefined 不报错', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        baseRow({ student_name: null, parent_name: null, course_name: null }),
      ]);

      const result = await repo.listPendingInDb(TENANT, {});

      expect(result[0].studentName).toBeUndefined();
      expect(result[0].parentName).toBeUndefined();
      expect(result[0].courseName).toBeUndefined();
    });
  });

  describe('非 JOIN 路径不挂 *Name（向后兼容）', () => {
    it('findByIdInDb: row 无 *_name 列 → studentName/parentName/courseName 均 undefined', async () => {
      pg.tenantQuery.mockResolvedValueOnce([baseRow()]);

      const result = await repo.findByIdInDb(TENANT, REFUND_ID);

      expect(result).not.toBeNull();
      expect(result!.studentName).toBeUndefined();
      expect(result!.parentName).toBeUndefined();
      expect(result!.courseName).toBeUndefined();
      // 基础字段正常
      expect(result!.studentId).toBe(STUDENT);
    });

    it('listInDb: 不 JOIN → *Name undefined', async () => {
      pg.tenantQuery.mockResolvedValueOnce([baseRow({ status: 'approved' })]);

      const result = await repo.listInDb(TENANT, { status: 'approved' });

      expect(result[0].studentName).toBeUndefined();
      expect(result[0].status).toBe('approved');
    });
  });

  describe('createInDb 仍校验 tenantSchema', () => {
    it('空 tenantSchema → BadRequestException', async () => {
      await expect(
        repo.createInDb('', {
          id: REFUND_ID,
          contractId: CONTRACT,
          studentId: STUDENT,
          customerId: CUSTOMER,
          amount: 100,
          applicantUserId: 'usr00000000000000000000000000U01',
          applicantRole: 'sales',
          campusId: CAMPUS,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
