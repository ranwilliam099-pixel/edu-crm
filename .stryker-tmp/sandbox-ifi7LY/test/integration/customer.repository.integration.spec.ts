/**
 * customer.repository.integration.spec.ts — Day 2 Phase B.L2 真 PG 集成
 *
 * 与 src/modules/db/customer.repository.spec.ts（mock 单测）严格分离：
 *   单测：mock pg.transaction，校 createWithOpportunity 函数签名 / 入参校验
 *   集成（本文件）：docker-compose PG 14 真跑 INSERT，校 V41 三写 schema drift
 *
 * 触发：今日 V41 schema drift 事故（50 tenant 缺 customers.primary_mobile_hash 列）
 *   单测全过 + e2e 全过，生产仍炸 — 因为 mock 不知道列不存在
 *
 * 必测 case（reflects 用户拍板 anti-laziness 强约束 §3.L2）：
 *   1. createWithOpportunity 成功 — 三写明文 + hash + encrypted 三列同事务
 *   2. schema drift 反例：ALTER TABLE DROP COLUMN primary_mobile_hash → INSERT 期望失败
 *   3. NULL 处理：旧数据 hash IS NULL → INSERT 仍成功（新写入双写，旧行 hash=NULL）
 *   4. CHECK constraint：primary_mobile NOT NULL 违反 → 23502 抛错
 *   5. FK violation：campus_id 不存在 → 23503 抛错
 *
 * 反偷懒强约束：
 *   - 禁用 mock pg.Pool — 必须真连 docker-compose
 *   - 禁用 expect(x).toBeDefined()
 *   - 每个 case 必含精确断言：toEqual / toMatchObject / toHaveLength / 列值校验
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
  seedStudent,
  seedCustomer,
  FieldEncryptor,
  HmacHasher,
  makeTestConfigService,
} from './setup';
import { CustomerRepository } from '../../src/modules/db/customer.repository';
import { PgPoolService } from '../../src/modules/db/pg-pool.service';

describe('CustomerRepository [integration, real PG]', () => {
  let pool: Pool;
  let schema: string;
  let repo: CustomerRepository;
  let encryptor: FieldEncryptor;
  let hasher: HmacHasher;
  let pgService: PgPoolService;

  // 测试场景共享 fixtures（每个 describe block beforeAll 灌 + afterAll drop schema）
  let campusId: string;
  let adminUserId: string;

  beforeAll(async () => {
    pool = getTestPool();
    schema = await createTestSchema('customer');

    // 用 ConfigService 注入测试 key（jest.setup.ts 已注 process.env）
    const config = makeTestConfigService() as any;
    encryptor = new FieldEncryptor();
    hasher = new HmacHasher();

    // PgPoolService 真用测试 pool — 但需要 mock ConfigService 让其连测试 DB
    // 改造路径：把 PgPoolService 构造器需要的 ConfigService 改成测试 config
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
    repo = new CustomerRepository(pgService, encryptor, hasher);

    // seed campus + admin user（customers.campus_id NOT NULL FK + users 表）
    const campus = await seedCampus(schema);
    campusId = campus.id;
    const adminUser = await seedAdminUser(schema, campusId);
    adminUserId = adminUser.id;
  }, 30000);

  afterAll(async () => {
    await pgService.onModuleDestroy();
    await dropTestSchema(schema);
    await closeTestPool();
  });

  // ----------------------------------------------------------------
  // Case 1: createWithOpportunity 成功 — 三写明文 + hash + encrypted
  // ----------------------------------------------------------------
  it('createWithOpportunity 成功 — V41 三写 customers.primary_mobile + hash + encrypted', async () => {
    const customerId = '01HXY' + 'A'.repeat(27);
    const opportunityId = '01HXY' + 'B'.repeat(27);
    const studentId = '01HXY' + 'C'.repeat(27);

    const result = await repo.createWithOpportunity(schema, {
      customerId,
      opportunityId,
      parentName: '张三',
      primaryMobile: '13900001111',
      campusId,
      ownerSalesId: adminUserId,
      studentId,
      studentName: '小明',
      gradeOrAge: '初一',
      intendedSubject: '数学',
    });

    expect(result).toEqual({
      customerId,
      opportunityId,
      studentId,
    });

    // 校真 PG 三列写入（明文 + hash 32B + encrypted 28+11=39B）
    const rows = await runInSchema(schema, async (client) => {
      const q = await client.query<{
        primary_mobile: string;
        primary_mobile_hash: Buffer | null;
        primary_mobile_encrypted: Buffer | null;
      }>(
        `SELECT primary_mobile, primary_mobile_hash, primary_mobile_encrypted
           FROM customers WHERE id = $1`,
        [customerId],
      );
      return q.rows;
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].primary_mobile).toBe('13900001111');
    expect(rows[0].primary_mobile_hash).toBeInstanceOf(Buffer);
    expect(rows[0].primary_mobile_hash!.length).toBe(32); // HMAC-SHA256 固定 32 字节
    expect(rows[0].primary_mobile_encrypted).toBeInstanceOf(Buffer);
    // AES-GCM = [IV 12 + Tag 16 + Cipher(plaintext.length)] = 28 + 11 = 39 字节
    expect(rows[0].primary_mobile_encrypted!.length).toBe(39);

    // 解密校验 — encrypted 列能解回明文
    const decrypted = encryptor.decrypt(rows[0].primary_mobile_encrypted);
    expect(decrypted).toBe('13900001111');

    // hash 校验 — 相同明文相同 hash
    const expectedHash = hasher.hash('13900001111');
    expect(rows[0].primary_mobile_hash!.equals(expectedHash!)).toBe(true);
  });

  // ----------------------------------------------------------------
  // Case 2: schema drift 反例 — DROP COLUMN primary_mobile_hash 后 INSERT 必失败
  //
  // 这是今天 V41 事故核心：单测 mock 永远抓不到「列不存在」
  // 真 PG 必须报 column "primary_mobile_hash" of relation "customers" does not exist
  // ----------------------------------------------------------------
  it('schema drift 反例：DROP COLUMN primary_mobile_hash 后 createWithOpportunity 必失败 (V41 5/19 真实事故)', async () => {
    const driftSchema = await createTestSchema('drift_hash_missing');
    try {
      // 灌 fixtures
      const c = await seedCampus(driftSchema);
      const u = await seedAdminUser(driftSchema, c.id);

      // 模拟 V41 未跑（或 backfill 漏） — DROP 列 + 索引（hash 列先 DROP 索引再 DROP 列）
      await runInSchema(driftSchema, async (client) => {
        await client.query(`DROP INDEX IF EXISTS idx_customers_primary_mobile_hash`);
        await client.query(`ALTER TABLE customers DROP COLUMN IF EXISTS primary_mobile_hash`);
      });

      // 校 schema 确实少了列
      const cols = await runInSchema(driftSchema, async (client) => {
        const q = await client.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = 'customers'`,
          [driftSchema],
        );
        return q.rows.map((r) => r.column_name);
      });
      expect(cols).not.toContain('primary_mobile_hash');
      expect(cols).toContain('primary_mobile'); // 明文列还在
      expect(cols).toContain('primary_mobile_encrypted'); // encrypted 列还在

      // 现在 INSERT 必须报「列不存在」错（V41 5/19 真实生产事故还原）
      const driftRepo = new CustomerRepository(pgService, encryptor, hasher);
      await expect(
        driftRepo.createWithOpportunity(driftSchema, {
          customerId: '01ZZZ' + 'A'.repeat(27),
          opportunityId: '01ZZZ' + 'B'.repeat(27),
          parentName: '李四',
          primaryMobile: '13800002222',
          campusId: c.id,
          ownerSalesId: u.id,
        }),
      ).rejects.toThrow(/primary_mobile_hash|column.*does not exist/);
    } finally {
      await dropTestSchema(driftSchema);
    }
  });

  // ----------------------------------------------------------------
  // Case 3: NULL 处理 — V41 backfill 前的旧行 hash/encrypted=NULL
  //   应用层 mapCustomerRow.decryptPhone fallback 走明文（不应 throw）
  // ----------------------------------------------------------------
  it('NULL 处理：旧 customers 行 hash/encrypted=NULL 应能 SELECT 不报错（V41 backfill 前兼容）', async () => {
    // 灌一行 hash=NULL / encrypted=NULL 的「旧数据」customer
    const oldCustomer = await seedCustomer(schema, campusId, adminUserId, {
      primaryMobile: '13700003333',
      mobileHash: null,
      mobileEncrypted: null,
    });

    // 真 SELECT 校实际行（应用层 CustomerRepository.findById 操作 opportunities 表
    // 不操作 customers — 所以本 case 直接 SQL 校 customers 表）
    const rows = await runInSchema(schema, async (client) => {
      const q = await client.query<{
        primary_mobile: string;
        primary_mobile_hash: Buffer | null;
        primary_mobile_encrypted: Buffer | null;
      }>(
        `SELECT primary_mobile, primary_mobile_hash, primary_mobile_encrypted
           FROM customers WHERE id = $1`,
        [oldCustomer.id],
      );
      return q.rows;
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].primary_mobile).toBe('13700003333');
    expect(rows[0].primary_mobile_hash).toBeNull();
    expect(rows[0].primary_mobile_encrypted).toBeNull();
    // 应用层应能从明文 fallback（虽 CustomerRepository.decryptPrimaryMobile 当前无调用方
    // 但 helper 必须能 graceful 处理 NULL）
    const fallback = (repo as any).decryptPrimaryMobile(oldCustomer.id, null, '13700003333');
    expect(fallback).toBe('13700003333');
  });

  // ----------------------------------------------------------------
  // Case 4: NOT NULL constraint violation — primary_mobile 是 NOT NULL VARCHAR(16)
  //   payload 必填校验在 service 层（BadRequestException）但 schema 层也必须守住
  // ----------------------------------------------------------------
  it('schema NOT NULL constraint：直接 SQL INSERT primary_mobile=NULL 必报 23502', async () => {
    // 直接绕过应用层 SQL — 验证 PG schema 真的有 NOT NULL 约束
    // （应用层 BadRequestException 是第一道防御，schema NOT NULL 是兜底）
    const customerId = '01XX1' + 'A'.repeat(27);
    await expect(
      runInSchema(schema, async (client) => {
        await client.query(
          `INSERT INTO customers (id, parent_name, primary_mobile, campus_id, owner_id, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, 'test', 'test')`,
          [customerId, '王五', null, campusId, adminUserId],
        );
      }),
    ).rejects.toThrow(/null value in column "primary_mobile"|23502/);
  });

  // ----------------------------------------------------------------
  // Case 5: FK violation — campus_id 不存在必报 23503
  // ----------------------------------------------------------------
  it('FK constraint：campus_id 不存在 createWithOpportunity 必报 23503', async () => {
    const nonExistentCampusId = '99999' + '9'.repeat(27);
    await expect(
      repo.createWithOpportunity(schema, {
        customerId: '01XX2' + 'A'.repeat(27),
        opportunityId: '01XX2' + 'B'.repeat(27),
        parentName: '赵六',
        primaryMobile: '13600004444',
        campusId: nonExistentCampusId,
        ownerSalesId: adminUserId,
      }),
    ).rejects.toThrow(/campus_id|foreign key|23503/);
  });

  // ----------------------------------------------------------------
  // Case 6: 应用层校验保住 — invalid primaryMobile 必报 400 BadRequest
  // ----------------------------------------------------------------
  it('应用层校验：primaryMobile 非 11 位中国手机号必抛 BadRequestException（不到 PG）', async () => {
    await expect(
      repo.createWithOpportunity(schema, {
        customerId: '01XX3' + 'A'.repeat(27),
        opportunityId: '01XX3' + 'B'.repeat(27),
        parentName: '错误用例',
        primaryMobile: '123', // 非法
        campusId,
        ownerSalesId: adminUserId,
      }),
    ).rejects.toThrow('primaryMobile must be 11-digit Chinese mobile');
  });
});
