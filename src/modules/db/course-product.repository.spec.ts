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
});
