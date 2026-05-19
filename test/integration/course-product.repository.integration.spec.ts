/**
 * course-product.repository.integration.spec.ts — Day 3 Phase B.L2 priority spec #6
 *
 * 触发：5/15 拍板课程产品聚合 stats（A-3 sales scope + A-4 campus filter）
 *   - course_products — 机构课程定义
 *   - findStats — 聚合 students/teachers/weeklyConsumedYuan（4 个 sub-query）
 *   - 字段权限 mask：sales 仅看自己客户 students；boss 仅看本校
 *
 * 必测 case：
 *   1. create + findById + list 上架过滤
 *   2. UNIQUE (product_name where status='上架') — 重复 → 23505 ConflictException
 *   3. setStatus 上架 ↔ 下架
 *   4. standardPrice CHECK ≥ 0
 *   5. findStats — null（product 不存在）
 *   6. findStats sales scope (callerOwnerSalesId) — 仅返该 sales 的 students
 *   7. findStats campus scope (callerCampusId) — 仅返该 campus 的 students
 *   8. findStats admin/boss 不传 scope → 看全
 *   9. schema drift 反例: DROP product_name → INSERT 必失败
 */

import { Pool } from 'pg';
import { ConflictException, BadRequestException } from '@nestjs/common';
import {
  createTestSchema,
  dropTestSchema,
  getTestPool,
  closeTestPool,
  runInSchema,
  seedCampus,
  seedAdminUser,
  seedCustomer,
  seedStudent,
  testUlid,
} from './setup';
import { CourseProductRepository } from '../../src/modules/db/course-product.repository';
import { PgPoolService } from '../../src/modules/db/pg-pool.service';

describe('CourseProductRepository [integration, real PG, V2 + 5/15 stats]', () => {
  let pool: Pool;
  let schema: string;
  let repo: CourseProductRepository;
  let pgService: PgPoolService;
  let campusA: string;
  let campusB: string;
  let adminId: string;
  let salesAId: string;
  let salesBId: string;

  const mockConfig = {
    get: (key: string, def?: any) => {
      const map: Record<string, any> = {
        DB_HOST: 'localhost',
        DB_PORT: '5433',
        DB_USER: 'eduapp',
        DB_PASSWORD: 'testpassword',
        DB_NAME: 'edu_test',
        DB_POOL_MAX: '5',
        DB_STATEMENT_TIMEOUT_MS: '10000',
      };
      return map[key] ?? def;
    },
  };

  beforeAll(async () => {
    pool = getTestPool();
    schema = await createTestSchema('courseproduct');
    pgService = new PgPoolService(mockConfig as any);
    repo = new CourseProductRepository(pgService);

    const cA = await seedCampus(schema);
    campusA = cA.id;
    const cB = await seedCampus(schema);
    campusB = cB.id;
    const admin = await seedAdminUser(schema, campusA);
    adminId = admin.id;
    // 灌 2 个 sales 用户用于 scope 测试
    const salesA = await seedAdminUser(schema, campusA, { role: 'sales' });
    salesAId = salesA.id;
    const salesB = await seedAdminUser(schema, campusB, { role: 'sales' });
    salesBId = salesB.id;
  }, 30000);

  afterAll(async () => {
    await pgService.onModuleDestroy();
    await dropTestSchema(schema);
    await closeTestPool();
  });

  // ----------------------------------------------------------------
  // Case 1: create + findById + list 上架过滤
  // ----------------------------------------------------------------
  it('create + findById + list — 默认仅上架', async () => {
    const id = testUlid();
    const product = await repo.create(schema, {
      id,
      productName: '数学一对一',
      courseLine: '数学',
      classType: '一对一',
      standardPrice: 200,
      operatorUserId: adminId,
    });
    expect(product.id).toBe(id);
    expect(product.productName).toBe('数学一对一');
    expect(product.standardPrice).toBe(200);
    expect(product.status).toBe('上架');

    const found = await repo.findById(schema, id);
    expect(found).toEqual(product);

    const list = await repo.list(schema);
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list.every((p) => p.status === '上架')).toBe(true);
  });

  // ----------------------------------------------------------------
  // Case 2: UNIQUE (product_name where status='上架')
  // ----------------------------------------------------------------
  it('UNIQUE (product_name where status=上架) 重复 → ConflictException', async () => {
    const id1 = testUlid();
    await repo.create(schema, {
      id: id1,
      productName: '物理一对一',
      courseLine: '物理',
      classType: '一对一',
      standardPrice: 300,
      operatorUserId: adminId,
    });

    // 同名 + 上架 → ConflictException 包装的 23505
    const id2 = testUlid();
    await expect(
      repo.create(schema, {
        id: id2,
        productName: '物理一对一',
        courseLine: '物理',
        classType: '一对一',
        standardPrice: 300,
        operatorUserId: adminId,
      }),
    ).rejects.toThrow(ConflictException);
  });

  // ----------------------------------------------------------------
  // Case 3: setStatus 上架 ↔ 下架
  // ----------------------------------------------------------------
  it('setStatus 上架→下架 → 不在 list 默认结果', async () => {
    const id = testUlid();
    await repo.create(schema, {
      id,
      productName: '英语一对一',
      courseLine: '英语',
      classType: '一对一',
      standardPrice: 250,
      operatorUserId: adminId,
    });

    const off = await repo.setStatus(schema, id, '下架', adminId);
    expect(off.status).toBe('下架');

    // 默认 list 不含
    const defaultList = await repo.list(schema);
    expect(defaultList.find((p) => p.id === id)).toBeUndefined();

    // includeOffShelf=true 包含
    const allList = await repo.list(schema, { includeOffShelf: true });
    expect(allList.find((p) => p.id === id)).toBeDefined();

    // 重新上架
    const on = await repo.setStatus(schema, id, '上架', adminId);
    expect(on.status).toBe('上架');
  });

  // ----------------------------------------------------------------
  // Case 4: standardPrice ≥ 0 + id 32-char 校验
  // ----------------------------------------------------------------
  it('payload 校验 — id 非 32-char / standardPrice < 0 → BadRequestException', async () => {
    await expect(
      repo.create(schema, {
        id: 'short-id',
        productName: 'invalid id',
        courseLine: '语文',
        classType: '一对一',
        standardPrice: 100,
        operatorUserId: adminId,
      }),
    ).rejects.toThrow(BadRequestException);

    await expect(
      repo.create(schema, {
        id: testUlid(),
        productName: 'neg price',
        courseLine: '语文',
        classType: '一对一',
        standardPrice: -1,
        operatorUserId: adminId,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  // ----------------------------------------------------------------
  // Case 5: findStats null (product 不存在)
  // ----------------------------------------------------------------
  it('findStats — product 不存在 → null', async () => {
    const fakeId = testUlid();
    const stats = await repo.findStats(schema, fakeId);
    expect(stats).toBeNull();
  });

  // ----------------------------------------------------------------
  // Case 6: findStats sales scope (callerOwnerSalesId)
  // ----------------------------------------------------------------
  it('findStats — sales scope 仅返该 sales 自己客户的 students', async () => {
    const pid = testUlid();
    await repo.create(schema, {
      id: pid,
      productName: 'stats-sales-scope',
      courseLine: '数学',
      classType: '一对一',
      standardPrice: 200,
      operatorUserId: adminId,
    });

    // 灌 sales A 的客户 + student + contract
    const custA = await seedCustomer(schema, campusA, salesAId);
    const stuA = await seedStudent(schema, custA.id);
    await runInSchema(schema, async (c) => {
      await c.query(
        `INSERT INTO ${schema}.contracts
           (id, student_id, course_product_id, lesson_hours, standard_price, total_amount,
            owner_user_id, signed_at, status, campus_id, created_by, updated_by)
         VALUES ($1, $2, $3, 20, 200, 4000, $4, NOW(), 'active', $5, $6, $6)`,
        [testUlid(), stuA.id, pid, salesAId, campusA, adminId],
      );
    });

    // 灌 sales B 的客户 + student + contract
    const custB = await seedCustomer(schema, campusB, salesBId);
    const stuB = await seedStudent(schema, custB.id);
    await runInSchema(schema, async (c) => {
      await c.query(
        `INSERT INTO ${schema}.contracts
           (id, student_id, course_product_id, lesson_hours, standard_price, total_amount,
            owner_user_id, signed_at, status, campus_id, created_by, updated_by)
         VALUES ($1, $2, $3, 20, 200, 4000, $4, NOW(), 'active', $5, $6, $6)`,
        [testUlid(), stuB.id, pid, salesBId, campusB, adminId],
      );
    });

    // admin 不传 scope → 看 2 个 student
    const statsAll = await repo.findStats(schema, pid);
    expect(statsAll).not.toBeNull();
    expect(statsAll!.students.length).toBe(2);

    // sales A 仅看自己 student A
    const statsA = await repo.findStats(schema, pid, { callerOwnerSalesId: salesAId });
    expect(statsA).not.toBeNull();
    expect(statsA!.students.length).toBe(1);
    expect(statsA!.students[0].id).toBe(stuA.id);

    // sales B 仅看自己 student B
    const statsB = await repo.findStats(schema, pid, { callerOwnerSalesId: salesBId });
    expect(statsB!.students.length).toBe(1);
    expect(statsB!.students[0].id).toBe(stuB.id);
  });

  // ----------------------------------------------------------------
  // Case 7: findStats campus scope (callerCampusId)
  // ----------------------------------------------------------------
  it('findStats — campus scope 仅返 contract.campus_id = $X 的 students', async () => {
    const pid = testUlid();
    await repo.create(schema, {
      id: pid,
      productName: 'stats-campus-scope',
      courseLine: '数学',
      classType: '一对一',
      standardPrice: 200,
      operatorUserId: adminId,
    });

    const custA = await seedCustomer(schema, campusA, salesAId);
    const stuA = await seedStudent(schema, custA.id);
    const custB = await seedCustomer(schema, campusB, salesBId);
    const stuB = await seedStudent(schema, custB.id);
    await runInSchema(schema, async (c) => {
      await c.query(
        `INSERT INTO ${schema}.contracts
           (id, student_id, course_product_id, lesson_hours, standard_price, total_amount,
            owner_user_id, signed_at, status, campus_id, created_by, updated_by)
         VALUES ($1, $2, $3, 20, 200, 4000, $4, NOW(), 'active', $5, $6, $6),
                ($7, $8, $3, 20, 200, 4000, $9, NOW(), 'active', $10, $6, $6)`,
        [testUlid(), stuA.id, pid, salesAId, campusA, adminId, testUlid(), stuB.id, salesBId, campusB],
      );
    });

    // 限 campusA — 仅看 stuA
    const stats = await repo.findStats(schema, pid, { callerCampusId: campusA });
    expect(stats!.students.length).toBe(1);
    expect(stats!.students[0].id).toBe(stuA.id);

    // 限 campusB — 仅看 stuB
    const statsB = await repo.findStats(schema, pid, { callerCampusId: campusB });
    expect(statsB!.students.length).toBe(1);
    expect(statsB!.students[0].id).toBe(stuB.id);

    // 同时 callerOwnerSalesId + callerCampusId → AND
    const statsAA = await repo.findStats(schema, pid, {
      callerOwnerSalesId: salesAId,
      callerCampusId: campusA,
    });
    expect(statsAA!.students.length).toBe(1);
    expect(statsAA!.students[0].id).toBe(stuA.id);

    // owner=salesA + campus=campusB 不应有结果（sales A 的 contract.campus_id=campusA）
    const statsAB = await repo.findStats(schema, pid, {
      callerOwnerSalesId: salesAId,
      callerCampusId: campusB,
    });
    expect(statsAB!.students.length).toBe(0);
  });

  // ----------------------------------------------------------------
  // Case 8: admin/boss 不传 scope → 看全
  // ----------------------------------------------------------------
  it('findStats — admin/boss 不传 scope → 全部 students', async () => {
    // 沿用 Case 7 数据：2 student 在不同 campus
    const productRows = await runInSchema(schema, async (c) => {
      const r = await c.query<{ id: string }>(
        `SELECT id FROM ${schema}.course_products WHERE product_name = 'stats-campus-scope'`,
      );
      return r.rows;
    });
    expect(productRows.length).toBe(1);

    const stats = await repo.findStats(schema, productRows[0].id);
    expect(stats!.students.length).toBe(2); // 全看
  });

  // ----------------------------------------------------------------
  // Case 9: schema drift — DROP product_name → INSERT 必失败
  // ----------------------------------------------------------------
  it('schema drift 反例: DROP product_name → INSERT 必失败 42703', async () => {
    const driftSchema = await createTestSchema('coursepro-drift');
    try {
      await runInSchema(driftSchema, async (c) => {
        await c.query(`ALTER TABLE ${driftSchema}.course_products DROP COLUMN product_name`);
      });
      await expect(
        repo.create(driftSchema, {
          id: testUlid(),
          productName: 'drift',
          courseLine: '数学',
          classType: '一对一',
          standardPrice: 100,
          operatorUserId: adminId,
        }),
      ).rejects.toThrow(/42703|column|does not exist/i);
    } finally {
      await dropTestSchema(driftSchema);
    }
  });
});
