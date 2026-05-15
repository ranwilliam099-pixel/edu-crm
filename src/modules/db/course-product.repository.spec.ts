import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { CourseProductRepository } from './course-product.repository';
import { PgPoolService } from './pg-pool.service';

describe('CourseProductRepository (V29 R6)', () => {
  let repo: CourseProductRepository;
  let pg: { tenantQuery: jest.Mock; query: jest.Mock; withClient: jest.Mock };

  const TENANT = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const PRODUCT_ID = 'product000000000000000000000P001';
  const OPERATOR = 'admin000000000000000000000000A001';
  const ROW = {
    id: PRODUCT_ID,
    product_name: '英语 1v1 30 课时',
    course_line: '英语',
    class_type: '一对一',
    lesson_package: '30 课时',
    standard_price: 6000,
    campus_scope: null,
    status: '上架',
    created_at: new Date('2026-05-07'),
    updated_at: new Date('2026-05-07'),
  };

  beforeEach(async () => {
    pg = { tenantQuery: jest.fn(), query: jest.fn(), withClient: jest.fn() };
    const m = await Test.createTestingModule({
      providers: [CourseProductRepository, { provide: PgPoolService, useValue: pg }],
    }).compile();
    repo = m.get(CourseProductRepository);
  });

  describe('list', () => {
    it('默认仅上架（销售下拉用）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([ROW]);
      await repo.list(TENANT);
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain(`WHERE status = '上架'`);
    });

    it('includeOffShelf 列全部含下架', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.list(TENANT, { includeOffShelf: true });
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).not.toContain('WHERE status');
    });

    it('mapRow 字段', async () => {
      pg.tenantQuery.mockResolvedValueOnce([ROW]);
      const r = await repo.list(TENANT);
      expect(r[0].productName).toBe('英语 1v1 30 课时');
      expect(r[0].standardPrice).toBe(6000);
      expect(r[0].status).toBe('上架');
    });
  });

  describe('create', () => {
    it('成功创建上架产品', async () => {
      pg.tenantQuery.mockResolvedValueOnce([ROW]);
      const r = await repo.create(TENANT, {
        id: PRODUCT_ID,
        productName: '英语 1v1 30 课时',
        courseLine: '英语',
        classType: '一对一',
        lessonPackage: '30 课时',
        standardPrice: 6000,
        operatorUserId: OPERATOR,
      });
      expect(r.id).toBe(PRODUCT_ID);
      expect(r.status).toBe('上架');
    });

    it('id 非 32 char → BadRequest', async () => {
      await expect(
        repo.create(TENANT, {
          id: 'short',
          productName: 'X',
          courseLine: '英语',
          classType: '一对一',
          standardPrice: 100,
          operatorUserId: OPERATOR,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('productName 空 → BadRequest', async () => {
      await expect(
        repo.create(TENANT, {
          id: PRODUCT_ID,
          productName: '',
          courseLine: '英语',
          classType: '一对一',
          standardPrice: 100,
          operatorUserId: OPERATOR,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('standardPrice 负 → BadRequest', async () => {
      await expect(
        repo.create(TENANT, {
          id: PRODUCT_ID,
          productName: '英语',
          courseLine: '英语',
          classType: '一对一',
          standardPrice: -1,
          operatorUserId: OPERATOR,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('PG 23505 重复 → ConflictException', async () => {
      const err: any = new Error('duplicate');
      err.code = '23505';
      pg.tenantQuery.mockRejectedValueOnce(err);
      await expect(
        repo.create(TENANT, {
          id: PRODUCT_ID,
          productName: '英语',
          courseLine: '英语',
          classType: '一对一',
          standardPrice: 100,
          operatorUserId: OPERATOR,
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('setStatus', () => {
    it('下架成功', async () => {
      pg.tenantQuery.mockResolvedValueOnce([{ ...ROW, status: '下架' }]);
      const r = await repo.setStatus(TENANT, PRODUCT_ID, '下架', OPERATOR);
      expect(r.status).toBe('下架');
    });

    it('id 不存在 → NotFound', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await expect(
        repo.setStatus(TENANT, PRODUCT_ID, '下架', OPERATOR),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ============================================================
  // 5/15 拍板：findStats — 聚合学员/老师/本周消课
  // ============================================================
  describe('findStats (5/15 拍板 OOUX 中心对象)', () => {
    const STUDENT_ID = 'studentX0000000000000000000000A1';
    const TEACHER_ID = 'teacherY0000000000000000000000B2';
    const TEACHER_USER_ID = 'userZ00000000000000000000000000C3';

    it('product 不存在 → 返回 null', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]); // 1st query: course_products
      const r = await repo.findStats(TENANT, PRODUCT_ID);
      expect(r).toBeNull();
      // 仅查 1 次（早退）
      expect(pg.tenantQuery).toHaveBeenCalledTimes(1);
    });

    it('product 存在但无学员无老师 → 全 0', async () => {
      pg.tenantQuery
        .mockResolvedValueOnce([{ id: PRODUCT_ID, product_name: '英语 1v1 30 课时' }]) // product
        .mockResolvedValueOnce([]) // students
        .mockResolvedValueOnce([]) // teachers
        .mockResolvedValueOnce([{ total: '0' }]); // weeklyConsumedYuan
      const r = await repo.findStats(TENANT, PRODUCT_ID);
      expect(r).not.toBeNull();
      expect(r!.productId).toBe(PRODUCT_ID);
      expect(r!.productName).toBe('英语 1v1 30 课时');
      expect(r!.studentCount).toBe(0);
      expect(r!.teacherCount).toBe(0);
      expect(r!.weeklyConsumedYuan).toBe(0);
      expect(r!.students).toEqual([]);
      expect(r!.teachers).toEqual([]);
    });

    it('学员 active + remainingHours SUM', async () => {
      pg.tenantQuery
        .mockResolvedValueOnce([{ id: PRODUCT_ID, product_name: '英语 1v1' }])
        .mockResolvedValueOnce([
          {
            id: STUDENT_ID,
            student_name: '小明',
            contract_status: 'active',
            remaining_hours: '12',
          },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: '0' }]);
      const r = await repo.findStats(TENANT, PRODUCT_ID);
      expect(r!.studentCount).toBe(1);
      expect(r!.students[0]).toEqual({
        id: STUDENT_ID,
        name: '小明',
        contractStatus: 'active',
        remainingHours: 12,
      });
    });

    it('学员 pending 也算（在册）', async () => {
      pg.tenantQuery
        .mockResolvedValueOnce([{ id: PRODUCT_ID, product_name: '英语 1v1' }])
        .mockResolvedValueOnce([
          {
            id: STUDENT_ID,
            student_name: '小红',
            contract_status: 'pending',
            remaining_hours: '0',
          },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: '0' }]);
      const r = await repo.findStats(TENANT, PRODUCT_ID);
      expect(r!.students[0].contractStatus).toBe('pending');
      expect(r!.students[0].remainingHours).toBe(0);
    });

    it('老师本周课时数 + 排序按 weeklyLessonCount DESC', async () => {
      pg.tenantQuery
        .mockResolvedValueOnce([{ id: PRODUCT_ID, product_name: '英语' }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            id: TEACHER_ID,
            user_id: TEACHER_USER_ID,
            name: '张老师',
            weekly_lesson_count: '5',
          },
        ])
        .mockResolvedValueOnce([{ total: '0' }]);
      const r = await repo.findStats(TENANT, PRODUCT_ID);
      expect(r!.teacherCount).toBe(1);
      expect(r!.teachers[0]).toEqual({
        id: TEACHER_ID,
        userId: TEACHER_USER_ID,
        name: '张老师',
        weeklyLessonCount: 5,
      });
    });

    it('老师 user_id 为 null（纯档案，无登录账号）→ teachers[].userId=null', async () => {
      pg.tenantQuery
        .mockResolvedValueOnce([{ id: PRODUCT_ID, product_name: '英语' }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            id: TEACHER_ID,
            user_id: null,
            name: '王老师',
            weekly_lesson_count: '3',
          },
        ])
        .mockResolvedValueOnce([{ total: '0' }]);
      const r = await repo.findStats(TENANT, PRODUCT_ID);
      expect(r!.teachers[0].userId).toBeNull();
    });

    it('本周消课金额 SUM', async () => {
      pg.tenantQuery
        .mockResolvedValueOnce([{ id: PRODUCT_ID, product_name: '英语' }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: '12345.67' }]);
      const r = await repo.findStats(TENANT, PRODUCT_ID);
      expect(r!.weeklyConsumedYuan).toBe(12345.67);
    });

    it('SQL 校验：students 子句过滤 active/pending 不含 expired/cancelled', async () => {
      pg.tenantQuery
        .mockResolvedValueOnce([{ id: PRODUCT_ID, product_name: '英语' }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: '0' }]);
      await repo.findStats(TENANT, PRODUCT_ID);
      const studentSql = pg.tenantQuery.mock.calls[1][1] as string;
      expect(studentSql).toMatch(/status IN \('active','pending'\)/);
      expect(studentSql).toMatch(/deleted_at IS NULL/);
    });

    it('SQL 校验：teachers 子句 status=在职 + start_at >= date_trunc week', async () => {
      pg.tenantQuery
        .mockResolvedValueOnce([{ id: PRODUCT_ID, product_name: '英语' }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: '0' }]);
      await repo.findStats(TENANT, PRODUCT_ID);
      const teacherSql = pg.tenantQuery.mock.calls[2][1] as string;
      expect(teacherSql).toContain(`t.status = '在职'`);
      expect(teacherSql).toContain(`date_trunc('week', NOW())`);
      expect(teacherSql).toMatch(/GROUP BY t\.id, t\.user_id, t\.name/);
    });

    it('SQL 校验：weeklyConsumedYuan 仅算 confirmed/locked', async () => {
      pg.tenantQuery
        .mockResolvedValueOnce([{ id: PRODUCT_ID, product_name: '英语' }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: '0' }]);
      await repo.findStats(TENANT, PRODUCT_ID);
      const consumedSql = pg.tenantQuery.mock.calls[3][1] as string;
      expect(consumedSql).toMatch(/status IN \('confirmed','locked'\)/);
      expect(consumedSql).toContain(`date_trunc('week', NOW())`);
    });

    it('每个 query 都用 productId 参数（tenant schema 隔离已由 pg.tenantQuery 保证）', async () => {
      pg.tenantQuery
        .mockResolvedValueOnce([{ id: PRODUCT_ID, product_name: '英语' }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: '0' }]);
      await repo.findStats(TENANT, PRODUCT_ID);
      // 4 个 query 都用相同 tenant + productId
      pg.tenantQuery.mock.calls.forEach((call) => {
        expect(call[0]).toBe(TENANT);
        expect(call[2]).toEqual([PRODUCT_ID]);
      });
    });
  });
});
