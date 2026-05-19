/**
 * contract.repository.integration.spec.ts — Day 2 Phase B.L2 真 PG 集成
 *
 * 触发：Day 2 Phase A.P0-3 事故 — seed contracts.status 用了无效枚举值，
 *   demo-sales-active failed: ERROR violates check constraint "contracts_status_check"
 *   单测 mock pg.tenantQuery 永远抓不到「CHECK constraint violation」
 *
 * 必测 case：
 *   1. CHECK constraint：contracts.status 合法枚举 pending/active/expired/cancelled
 *   2. CHECK constraint 反例：非法值（如 'signed'）必报 23514
 *   3. INSERT 成功 + 字段映射 mapRow 校字段
 *   4. FK violation：student_id 不存在必报 23503
 *   5. paid_locked = true 时禁修业务规则（应用层逻辑 + schema 列存在校）
 *   6. NUMERIC NON-NEG CHECK：total_amount < 0 必报 23514
 */

import { Pool } from 'pg';
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
  seedCourseProduct,
  testUlid,
} from './setup';
import { ContractRepository } from '../../src/modules/db/contract.repository';
import { PgPoolService } from '../../src/modules/db/pg-pool.service';

describe('ContractRepository [integration, real PG, P0-3 status CHECK 事故同类]', () => {
  let pool: Pool;
  let schema: string;
  let repo: ContractRepository;
  let pgService: PgPoolService;
  let campusId: string;
  let salesUserId: string;
  let studentId: string;
  let customerId: string;
  let courseProductId: string;

  beforeAll(async () => {
    pool = getTestPool();
    schema = await createTestSchema('contract');

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
    pgService = new PgPoolService(mockConfig as any);
    repo = new ContractRepository(pgService);

    const campus = await seedCampus(schema);
    campusId = campus.id;
    const adminUser = await seedAdminUser(schema, campusId, { role: 'sales' });
    salesUserId = adminUser.id;
    const customer = await seedCustomer(schema, campusId, salesUserId);
    customerId = customer.id;
    const student = await seedStudent(schema, customerId);
    studentId = student.id;
    const product = await seedCourseProduct(schema);
    courseProductId = product.id;
  }, 30000);

  afterAll(async () => {
    await pgService.onModuleDestroy();
    await dropTestSchema(schema);
    await closeTestPool();
  });

  // ----------------------------------------------------------------
  // Case 1: CHECK constraint 合法枚举 pending/active/expired/cancelled
  //   先校 schema 真的有 CHECK constraint 定义
  // ----------------------------------------------------------------
  it('contracts.status CHECK constraint：schema 应有 pending/active/expired/cancelled 枚举', async () => {
    const checkDef = await runInSchema(schema, async (client) => {
      const q = await client.query<{ check_clause: string }>(
        `SELECT cc.check_clause
           FROM information_schema.check_constraints cc
           JOIN information_schema.constraint_column_usage ccu
             ON cc.constraint_name = ccu.constraint_name
            AND cc.constraint_schema = ccu.constraint_schema
          WHERE ccu.table_schema = $1
            AND ccu.table_name = 'contracts'
            AND ccu.column_name = 'status'`,
        [schema],
      );
      return q.rows;
    });
    expect(checkDef.length).toBeGreaterThan(0);
    // CHECK clause 含 pending / active / expired / cancelled 四个枚举值
    const clauseStr = checkDef.map((r) => r.check_clause).join('|');
    expect(clauseStr).toMatch(/pending/);
    expect(clauseStr).toMatch(/active/);
    expect(clauseStr).toMatch(/expired/);
    expect(clauseStr).toMatch(/cancelled/);
  });

  // ----------------------------------------------------------------
  // Case 2: P0-3 事故反例 — INSERT contracts.status='signed' / 'invalid' 必报 23514
  //   重现 demo-sales-active failed 场景（generate-seed-sql.js 用了无效枚举）
  // ----------------------------------------------------------------
  it('P0-3 事故反例：INSERT contracts.status=signed (非法值) 必报 23514 check_violation', async () => {
    const contractId = testUlid();
    await expect(
      runInSchema(schema, async (client) => {
        await client.query(
          `INSERT INTO contracts
             (id, student_id, course_product_id, lesson_hours, standard_price, total_amount,
              order_type, status, signed_at, created_by, updated_by)
           VALUES ($1, $2, $3, 20, 200.0, 4000.0, '新签', $4, NOW(), 'test', 'test')`,
          [contractId, studentId, courseProductId, 'signed'],
        );
      }),
    ).rejects.toThrow(/contracts_status_check|status|23514|check constraint/i);

    // 同样 'paid' / 'completed' / '已签约' 等中文都应报错（确认 schema 是英文枚举）
    await expect(
      runInSchema(schema, async (client) => {
        await client.query(
          `INSERT INTO contracts
             (id, student_id, course_product_id, lesson_hours, standard_price, total_amount,
              order_type, status, signed_at, created_by, updated_by)
           VALUES ($1, $2, $3, 20, 200.0, 4000.0, '新签', $4, NOW(), 'test', 'test')`,
          [testUlid(), studentId, courseProductId, '已签约'],
        );
      }),
    ).rejects.toThrow(/contracts_status_check|23514|check constraint/i);
  });

  // ----------------------------------------------------------------
  // Case 3: ContractRepository.create 成功 — 默认 status='pending'
  // ----------------------------------------------------------------
  it('ContractRepository.create 成功 — 默认 status=pending 写入 + mapRow 反序列化', async () => {
    const contractId = testUlid();
    const contract = await repo.create(schema, {
      id: contractId,
      studentId,
      courseProductId,
      ownerUserId: salesUserId,
      campusId,
      classType: '一对一',
      lessonHours: 30,
      standardPrice: 250.0,
      discountAmount: 0,
      giftHours: 0,
      totalAmount: 7500.0,
      orderType: '新签',
    });

    expect(contract.id).toBe(contractId);
    expect(contract.status).toBe('pending'); // V25 ALTER 默认值
    expect(contract.totalAmount).toBe(7500.0);
    expect(contract.lessonHours).toBe(30);
    expect(contract.studentId).toBe(studentId);
    expect(contract.ownerUserId).toBe(salesUserId);

    // 真 PG 校 status 字段
    const rows = await runInSchema(schema, async (client) => {
      const q = await client.query<{ status: string; paid_locked: boolean }>(
        `SELECT status, paid_locked FROM contracts WHERE id = $1`,
        [contractId],
      );
      return q.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].paid_locked).toBe(false);
  });

  // ----------------------------------------------------------------
  // Case 4: FK violation — student_id 不存在必报 23503
  // ----------------------------------------------------------------
  it('FK constraint：student_id 不存在 ContractRepository.create 必报 23503', async () => {
    const nonExistentStudentId = '99999' + '9'.repeat(27);
    await expect(
      repo.create(schema, {
        id: testUlid(),
        studentId: nonExistentStudentId,
        courseProductId,
        ownerUserId: salesUserId,
        campusId,
        lessonHours: 10,
        standardPrice: 200.0,
        totalAmount: 2000.0,
      }),
    ).rejects.toThrow(/student_id|foreign key|23503/);
  });

  // ----------------------------------------------------------------
  // Case 5: NUMERIC NON-NEG CHECK — total_amount 负数必报 23514
  //   V2 line 234: total_amount NUMERIC(12,2) NOT NULL CHECK (total_amount >= 0)
  // ----------------------------------------------------------------
  it('NUMERIC CHECK：total_amount < 0 INSERT 必报 23514 (V2 CHECK total_amount >= 0)', async () => {
    // 应用层先校：repo.create 自己 BadRequest
    await expect(
      repo.create(schema, {
        id: testUlid(),
        studentId,
        courseProductId,
        ownerUserId: salesUserId,
        campusId,
        lessonHours: 10,
        standardPrice: 200.0,
        totalAmount: -100.0,
      }),
    ).rejects.toThrow('totalAmount must be ≥ 0');

    // 绕过应用层 — 直接 SQL 校 schema CHECK 真的兜住
    await expect(
      runInSchema(schema, async (client) => {
        await client.query(
          `INSERT INTO contracts
             (id, student_id, course_product_id, lesson_hours, standard_price, total_amount,
              order_type, status, signed_at, created_by, updated_by)
           VALUES ($1, $2, $3, 10, 200.0, $4, '新签', 'pending', NOW(), 'test', 'test')`,
          [testUlid(), studentId, courseProductId, -100.0],
        );
      }),
    ).rejects.toThrow(/total_amount|check constraint|23514/i);
  });

  // ----------------------------------------------------------------
  // Case 6: V29 应用层校验 — courseProductId / Name 至少传一个
  // ----------------------------------------------------------------
  it('V29 应用层校验：courseProductId 与 courseProductName 至少传一个', async () => {
    await expect(
      repo.create(schema, {
        id: testUlid(),
        studentId,
        // 两个都不传
        courseProductId: null,
        courseProductName: null,
        ownerUserId: salesUserId,
        campusId,
        lessonHours: 10,
        standardPrice: 200.0,
        totalAmount: 2000.0,
      }),
    ).rejects.toThrow('至少传一个');
  });
});
