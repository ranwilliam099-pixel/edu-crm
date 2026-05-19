/**
 * invoice.repository.integration.spec.ts — Day 2 Phase B.L2 真 PG 集成
 *
 * 触发：Day 2 Phase A.P0-3 事故 — demo-finance-invoice failed:
 *   "duplicate key violates unique constraint idx_invoices_contract_unique_active"
 *   （seed generator 给一个 contract 开多个 active invoice，违反 partial UNIQUE）
 *
 *   单测 mock pg.transaction 永远抓不到「partial UNIQUE 冲突」类 schema drift
 *
 * 必测 case：
 *   1. partial UNIQUE 验证：idx_invoices_contract_unique_active 必须存在 + 是 partial
 *   2. P0-3 事故重现：同一 contract 开 2 个 pending invoice 第 2 个必失败
 *   3. cancelled invoice 允许多次重开 (partial UNIQUE WHERE status IN pending/issued)
 *   4. createInvoiceAndMarkContract 成功 — 三写 invoice_title / tax_id / receive_phone PII 加密
 *   5. status CHECK constraint 反例：非法值 必报 23514
 *   6. contract.invoice_issued = TRUE 时第 2 次开票必 409 ConflictException
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
  seedContract,
  FieldEncryptor,
  HmacHasher,
  testUlid,
} from './setup';
import { InvoiceRepository } from '../../src/modules/invoice/invoice.repository';
import { PgPoolService } from '../../src/modules/db/pg-pool.service';

describe('InvoiceRepository [integration, real PG, P0-3 partial UNIQUE 事故同类]', () => {
  let pool: Pool;
  let schema: string;
  let repo: InvoiceRepository;
  let pgService: PgPoolService;
  let encryptor: FieldEncryptor;
  let hasher: HmacHasher;
  let campusId: string;
  let salesUserId: string;
  let studentId: string;
  let customerId: string;
  let courseProductId: string;

  beforeAll(async () => {
    pool = getTestPool();
    schema = await createTestSchema('invoice');

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
    encryptor = new FieldEncryptor();
    hasher = new HmacHasher();
    repo = new InvoiceRepository(pgService, encryptor, hasher);

    const campus = await seedCampus(schema);
    campusId = campus.id;
    const adminUser = await seedAdminUser(schema, campusId, { role: 'admin' });
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
  // Case 1: schema 验证 — partial UNIQUE idx_invoices_contract_unique_active 必存在
  // ----------------------------------------------------------------
  it('schema 验证：idx_invoices_contract_unique_active 必须是 partial UNIQUE (WHERE status IN pending/issued)', async () => {
    const indexDef = await runInSchema(schema, async (client) => {
      const q = await client.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
          WHERE schemaname = $1
            AND tablename = 'invoices'
            AND indexname = 'idx_invoices_contract_unique_active'`,
        [schema],
      );
      return q.rows;
    });
    expect(indexDef).toHaveLength(1);
    const def = indexDef[0].indexdef;
    expect(def).toMatch(/CREATE UNIQUE INDEX/);
    expect(def).toMatch(/\(contract_id\)/);
    expect(def).toMatch(/WHERE.*status.*=.*'pending'/);
    expect(def).toMatch(/WHERE.*status.*=.*'issued'|status.*IN.*\('pending',\s*'issued'\)/);
  });

  // ----------------------------------------------------------------
  // Case 2: P0-3 事故重现 — 同一 contract 开 2 个 active invoice 第 2 个必失败
  //   应用层路径：createInvoiceAndMarkContract 会校 invoice_issued = TRUE → 409
  //   直接 SQL 路径（绕开应用层）：partial UNIQUE 索引兜底 → 23505
  // ----------------------------------------------------------------
  it('P0-3 事故重现：同一 contract 开 2 个 pending invoice 第 2 个必报 23505 unique_violation', async () => {
    const c1 = await seedContract(schema, studentId, courseProductId, { campusId });

    // 第 1 个 invoice — INSERT 成功
    const invoice1Id = testUlid();
    await runInSchema(schema, async (client) => {
      await client.query(
        `INSERT INTO invoices
           (id, contract_id, title_type, invoice_title, amount, status, created_by_user_id)
         VALUES ($1, $2, '个人', '张三', 4000.0, 'pending', $3)`,
        [invoice1Id, c1.id, salesUserId],
      );
    });

    // 第 2 个 invoice — 同 contract_id + status=pending 必报 23505
    const invoice2Id = testUlid();
    await expect(
      runInSchema(schema, async (client) => {
        await client.query(
          `INSERT INTO invoices
             (id, contract_id, title_type, invoice_title, amount, status, created_by_user_id)
           VALUES ($1, $2, '个人', '张三', 4000.0, 'pending', $3)`,
          [invoice2Id, c1.id, salesUserId],
        );
      }),
    ).rejects.toThrow(/idx_invoices_contract_unique_active|unique|23505/i);
  });

  // ----------------------------------------------------------------
  // Case 3: partial UNIQUE WHERE — cancelled 不参与 UNIQUE，允许多次重开（红冲场景）
  // ----------------------------------------------------------------
  it('partial UNIQUE 设计：cancelled invoice 不参与 UNIQUE，允许多次「红冲 + 新开」', async () => {
    const c2 = await seedContract(schema, studentId, courseProductId, { campusId });

    // 第 1 个 invoice cancelled
    const invoice1Id = testUlid();
    await runInSchema(schema, async (client) => {
      await client.query(
        `INSERT INTO invoices
           (id, contract_id, title_type, invoice_title, amount, status, created_by_user_id, cancelled_at)
         VALUES ($1, $2, '个人', '张三', 4000.0, 'cancelled', $3, NOW())`,
        [invoice1Id, c2.id, salesUserId],
      );
    });

    // 第 2 个 invoice cancelled — 允许（红冲多次）
    const invoice2Id = testUlid();
    await runInSchema(schema, async (client) => {
      await client.query(
        `INSERT INTO invoices
           (id, contract_id, title_type, invoice_title, amount, status, created_by_user_id, cancelled_at)
         VALUES ($1, $2, '个人', '李四', 4000.0, 'cancelled', $3, NOW())`,
        [invoice2Id, c2.id, salesUserId],
      );
    });

    // 第 3 个 invoice pending — 也允许（cancelled 不占 partial unique 位）
    const invoice3Id = testUlid();
    await runInSchema(schema, async (client) => {
      await client.query(
        `INSERT INTO invoices
           (id, contract_id, title_type, invoice_title, amount, status, created_by_user_id)
         VALUES ($1, $2, '个人', '王五', 4000.0, 'pending', $3)`,
        [invoice3Id, c2.id, salesUserId],
      );
    });

    const cnt = await runInSchema(schema, async (client) => {
      const q = await client.query<{ status: string; cnt: string }>(
        `SELECT status, COUNT(*) AS cnt FROM invoices WHERE contract_id = $1 GROUP BY status`,
        [c2.id],
      );
      return q.rows;
    });
    const byStatus = Object.fromEntries(cnt.map((r) => [r.status, parseInt(r.cnt, 10)]));
    expect(byStatus['cancelled']).toBe(2);
    expect(byStatus['pending']).toBe(1);
  });

  // ----------------------------------------------------------------
  // Case 4: createInvoiceAndMarkContract 成功 — PII 三写 + contract.invoice_issued 同事务更新
  // ----------------------------------------------------------------
  it('createInvoiceAndMarkContract 成功 — PII 加密 + contract.invoice_issued = TRUE 同事务原子', async () => {
    const c3 = await seedContract(schema, studentId, courseProductId, { campusId });
    const invoiceId = testUlid();

    const invoice = await repo.createInvoiceAndMarkContract(schema, {
      invoiceId,
      contractId: c3.id,
      titleType: '个人',
      invoiceTitle: '张三',
      receiveEmail: 'zhangsan@example.com',
      receivePhone: '13555556666',
      createdByUserId: salesUserId,
    });

    expect(invoice.id).toBe(invoiceId);
    expect(invoice.contractId).toBe(c3.id);
    expect(invoice.status).toBe('pending');

    // 校 PG 真行 — invoice_title_encrypted / receive_phone_hash / receive_phone_encrypted 三列写入
    const rows = await runInSchema(schema, async (client) => {
      const q = await client.query<{
        invoice_title: string;
        invoice_title_encrypted: Buffer | null;
        tax_id_encrypted: Buffer | null;
        receive_phone: string | null;
        receive_phone_hash: Buffer | null;
        receive_phone_encrypted: Buffer | null;
      }>(
        `SELECT invoice_title, invoice_title_encrypted,
                tax_id_encrypted, receive_phone, receive_phone_hash, receive_phone_encrypted
           FROM invoices WHERE id = $1`,
        [invoiceId],
      );
      return q.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].invoice_title).toBe('张三');
    expect(rows[0].invoice_title_encrypted).toBeInstanceOf(Buffer);
    // '张三' 是 2 char × 3 byte (utf8) = 6 byte，密文 28+6 = 34 字节
    expect(rows[0].invoice_title_encrypted!.length).toBe(34);
    expect(encryptor.decrypt(rows[0].invoice_title_encrypted)).toBe('张三');
    // phone 三写
    expect(rows[0].receive_phone).toBe('13555556666');
    expect(rows[0].receive_phone_hash).toBeInstanceOf(Buffer);
    expect(rows[0].receive_phone_hash!.length).toBe(32);
    expect(encryptor.decrypt(rows[0].receive_phone_encrypted)).toBe('13555556666');

    // contract.invoice_issued = TRUE 同事务更新
    const contract = await runInSchema(schema, async (client) => {
      const q = await client.query<{ invoice_issued: boolean }>(
        `SELECT invoice_issued FROM contracts WHERE id = $1`,
        [c3.id],
      );
      return q.rows;
    });
    expect(contract).toHaveLength(1);
    expect(contract[0].invoice_issued).toBe(true);
  });

  // ----------------------------------------------------------------
  // Case 5: status CHECK constraint — V42 invoices_status_chk
  // ----------------------------------------------------------------
  it('invoices.status CHECK：非法值 必报 23514 invoices_status_chk', async () => {
    const c4 = await seedContract(schema, studentId, courseProductId, { campusId });
    await expect(
      runInSchema(schema, async (client) => {
        await client.query(
          `INSERT INTO invoices
             (id, contract_id, title_type, invoice_title, amount, status, created_by_user_id)
           VALUES ($1, $2, '个人', '张三', 4000.0, $3, $4)`,
          [testUlid(), c4.id, 'paid', salesUserId],
        );
      }),
    ).rejects.toThrow(/invoices_status_chk|status|check constraint|23514/i);
  });

  // ----------------------------------------------------------------
  // Case 6: 应用层重复开票 409 — contract.invoice_issued = TRUE 时 2 次调 createInvoiceAndMarkContract
  // ----------------------------------------------------------------
  it('应用层 409 防重复开票：contract.invoice_issued=TRUE 后第 2 次开票必抛 ConflictException', async () => {
    const c5 = await seedContract(schema, studentId, courseProductId, { campusId });

    // 第 1 次 — 成功
    await repo.createInvoiceAndMarkContract(schema, {
      invoiceId: testUlid(),
      contractId: c5.id,
      titleType: '个人',
      invoiceTitle: '首次开票',
      receiveEmail: 'first@example.com',
      createdByUserId: salesUserId,
    });

    // 第 2 次 — 应用层 ConflictException（早于 partial UNIQUE 兜底）
    await expect(
      repo.createInvoiceAndMarkContract(schema, {
        invoiceId: testUlid(),
        contractId: c5.id,
        titleType: '个人',
        invoiceTitle: '重复开票',
        receiveEmail: 'dup@example.com',
        createdByUserId: salesUserId,
      }),
    ).rejects.toThrow(/INVOICE_ALREADY_ISSUED|Conflict/i);
  });
});
