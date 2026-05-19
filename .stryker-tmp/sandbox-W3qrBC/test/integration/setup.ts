/**
 * test/integration/setup.ts — Day 2 Phase B.L2 integration test 共享 setup / teardown
 *
 * 职责：
 *   1. 跑 TENANT_MIGRATIONS（V2 → V50 全 28 个）建独立 schema（每个 spec 自己的 schema 防污染）
 *   2. 跑 public schema V1 / V3 / V6 / V10 / V19 / V20 / V21 / V23 / V43 / V45 / V47 / V49
 *      （非 tenant-scoped，公共表 — 给 customers.campus_id FK 引用、给 platform 测试用）
 *   3. 提供 createTestSchema(label) / dropTestSchema(name) / setupTestDb / teardownTestDb 工具
 *   4. 提供 makeTestEncryptor / makeTestHasher（与 jest.setup.ts 同 key 即 32B 全 0 / 全 4）
 *
 * 不做：
 *   - 不灌「最小测试数据」到全局 schema — 每个 spec 自己控数据状态（防 spec 间隐式依赖）
 *   - 不启 NestJS 应用容器 — 整合用 *.e2e-spec.ts；本层只测 repository PG 真行为
 *
 * 来源：
 *   - 用户 5/19 拍板 v2.0 §3.L2
 *   - Day 2 plan sprightly-inventing-star.md
 *   - 反偷懒强约束：每个 spec 必含 schema drift 反例（ALTER DROP COLUMN 后期望 INSERT 失败）
 */

import { Pool, PoolClient } from 'pg';
import Redis from 'ioredis';
import * as fs from 'fs';
import * as path from 'path';

// ----------------------------------------------------------------
// 测试 PG / Redis 连接配置（docker-compose.test.yml 暴露）
// ----------------------------------------------------------------
export const TEST_DB_CONFIG = {
  host: process.env.PG_TEST_HOST || 'localhost',
  port: parseInt(process.env.PG_TEST_PORT || '5433', 10),
  user: process.env.PG_TEST_USER || 'eduapp',
  password: process.env.PG_TEST_PASSWORD || 'testpassword',
  database: process.env.PG_TEST_DB || 'edu_test',
  // 测试用短超时（5s 内拉起 / 失败抛错，不要 hang）
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
  max: 5,
};

export const REDIS_TEST_CONFIG = {
  host: process.env.REDIS_TEST_HOST || 'localhost',
  port: parseInt(process.env.REDIS_TEST_PORT || '6380', 10),
};

// ----------------------------------------------------------------
// migrations 路径与列表
//
// 注意：与 src/modules/db/tenant-provision.service.ts TENANT_MIGRATIONS 严格保持同步
// 任何新 migration 加入 prod TENANT_MIGRATIONS 后必须同步加入下方
// 此处「显式列出」而不是「读 service 文件 import」原因：
//   1. setup.ts 不该依赖应用层文件路径
//   2. 测试要能跑「列不存在」反例，需精确控制每行 migration 跑 / 不跑
// ----------------------------------------------------------------
const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

/**
 * Public schema migrations — 非 tenant-scoped，跑 1 次即可（不含 __TENANT_SCHEMA__ 占位符）
 *
 * 顺序敏感：V1 → V3 → V6 → V10 → V19 → V20 → V21 → V23 → V43 → V45 → V47 → V49
 *
 * 注意 V49 后无 V51+；V50 是 tenant-scoped（DROP teachers.hourly_price_yuan）属下方 TENANT
 */
export const PUBLIC_MIGRATIONS = [
  'V1__init_public_schema.sql',
  'V3__pd_01_02_03_public_schema_alter.sql',
  'V6__price_table_and_lifecycle_jobs.sql',
  'V10__parents_subscriptions_in_public.sql',
  'V19__campuses_and_plan.sql',
  'V20__promotions_in_public_schema.sql',
  'V21__promotion_audit_quota_expire_action.sql',
  'V23__c_side_quarterly_and_free_slots.sql',
  'V43__create_refresh_tokens.sql',
  'V45__add_subscription_status_to_tenants.sql',
  'V47__parents_status_chinese.sql',
  'V49__expand_subscription_status_check.sql',
];

/**
 * Tenant-scoped migrations — 含 __TENANT_SCHEMA__ 占位符，按测试 schema sed 替换
 *
 * 与 prod TenantProvisionService.TENANT_MIGRATIONS 严格保持顺序一致（含 V41 / V50）
 * (5/18 P0 #12 修复：V41 加入 — 详见 service 文件 line 82-90 注释)
 */
export const TENANT_MIGRATIONS = [
  'V2__tenant_schema_template.sql',
  'V4__pd_05_06_07_tenant_schema_alter.sql',
  'V5__pd_signed_corrections.sql',
  'V7__teachers_in_tenant_schema.sql',
  'V8__schedules_in_tenant_schema.sql',
  'V8_1__student_teacher_bindings_and_recurring_schedules.sql',
  'V9__feedback_reports_consumption_in_tenant_schema.sql',
  'V12__course_packages_balance_in_tenant_schema.sql',
  'V13__homework_in_tenant_schema.sql',
  'V14__assessments_in_tenant_schema.sql',
  'V15__student_learning_profile_in_tenant_schema.sql',
  'V16__leaves_in_tenant_schema.sql',
  'V17__parent_recommendations_in_tenant_schema.sql',
  'V18__lesson_feedbacks_extended_fields.sql',
  'V22__parent_referrals_in_tenant_schema.sql',
  'V24__teacher_ratings_and_monthly_aggregates.sql',
  'V25__sales_customers_pool_and_followup.sql',
  'V26__opportunities_contracts_campus_id.sql',
  'V27__user_offboard_handover.sql',
  'V28__students_owner_and_teacher.sql',
  'V29__contracts_self_filled_fields.sql',
  'V30__opportunities_course_product_nullable.sql',
  'V31__campuses_address.sql',
  'V32__schedules_class_type_and_max_students.sql',
  'V33__audit_log_in_tenant_schema.sql',
  'V34__sensitive_fields_encrypted.sql',
  'V35__teacher_showcase_meta.sql',
  'V36__monthly_reports_audience_columns.sql',
  'V37__drop_monthly_aggregates_payroll.sql',
  'V39__rename_hourly_rate_to_hourly_price.sql',
  'V42__invoices_in_tenant_schema.sql',
  'V44__add_deleted_at_to_students_teachers_users.sql',
  'V46__add_password_to_users.sql',
  'V48__add_teacher_academic_roles_to_users_check.sql',
  'V41__customers_primary_mobile_hash_and_encrypted.sql',
  'V50__drop_teachers_hourly_price.sql',
];

// ----------------------------------------------------------------
// global pool — 跨 spec 共享（每个 spec 关闭自己的 client release，pool 在所有 spec 跑完后 end）
// ----------------------------------------------------------------
let _pool: Pool | null = null;
let _publicReady = false;

export function getTestPool(): Pool {
  if (!_pool) {
    _pool = new Pool(TEST_DB_CONFIG);
    _pool.on('error', (err) => {
      // 测试期 idle client 出错不能 silent — fail loud
      // eslint-disable-next-line no-console
      console.error('[integration setup] pool idle error:', err.message);
    });
  }
  return _pool;
}

/**
 * 跑一次 public schema migrations（idempotent — 重复跑只忽略 IF NOT EXISTS）
 */
export async function ensurePublicSchemaReady(): Promise<void> {
  if (_publicReady) return;
  const pool = getTestPool();
  for (const f of PUBLIC_MIGRATIONS) {
    const p = path.join(MIGRATIONS_DIR, f);
    if (!fs.existsSync(p)) {
      throw new Error(`[integration setup] public migration not found: ${p}`);
    }
    const sql = fs.readFileSync(p, 'utf-8');
    try {
      await pool.query(sql);
    } catch (e) {
      // 容错：部分 public migration 含 DDL ALTER 已生效后再跑会报 duplicate column / already exists
      // 这些是预期幂等错误 — 用 IF NOT EXISTS 写的会自动跳过；少数没写的需个例放行
      const msg = (e as Error).message;
      if (/already exists|duplicate column|duplicate key/.test(msg)) {
        // ignore — 重跑场景
      } else {
        throw new Error(`[integration setup] public migration ${f} failed: ${msg}`);
      }
    }
  }
  _publicReady = true;
}

/**
 * 建独立测试 schema（每个 spec / 每个 describe 自己持有）
 *
 * @param label 短标签（如 'customer'、'teacher'）— 用于 schema 名标识便于调试
 * @returns 32-char tenant schema 名（tenant_<label>_<random>，符合 PG 命名 + service 校验）
 */
export async function createTestSchema(label: string): Promise<string> {
  await ensurePublicSchemaReady();
  const random = Math.random().toString(36).slice(2, 10);
  // 强制 tenant_ 前缀 + 全小写 + 仅 a-z0-9_ — 与 pg-pool.service.ts:70 white-list 一致
  const schema = `tenant_${label.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${random}`;
  if (!/^tenant_[a-z0-9_]+$/.test(schema)) {
    throw new Error(`[integration setup] invalid schema name: ${schema}`);
  }
  const pool = getTestPool();
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.query(`CREATE SCHEMA ${schema}`);

  // 顺序跑 TENANT_MIGRATIONS（与 service 一致）
  for (const f of TENANT_MIGRATIONS) {
    const p = path.join(MIGRATIONS_DIR, f);
    if (!fs.existsSync(p)) {
      throw new Error(`[integration setup] tenant migration not found: ${p}`);
    }
    const sqlTemplate = fs.readFileSync(p, 'utf-8');
    let sql = sqlTemplate.replace(/__TENANT_SCHEMA__/g, schema);

    // V4 完整版会与 V2 占位 referrals/renewals 冲突 — 应用层先 DROP（与 service line 254-260 一致）
    if (f.startsWith('V4__')) {
      sql =
        `SET search_path = ${schema}, public;\n` +
        `DROP TABLE IF EXISTS referrals CASCADE;\n` +
        `DROP TABLE IF EXISTS renewals CASCADE;\n` +
        sql;
    }

    try {
      await pool.query(sql);
    } catch (e) {
      throw new Error(
        `[integration setup] tenant migration ${f} failed in ${schema}: ${(e as Error).message}`,
      );
    }
  }

  return schema;
}

/**
 * 删测试 schema（teardown 用）
 */
export async function dropTestSchema(schema: string): Promise<void> {
  if (!schema || !/^tenant_[a-z0-9_]+$/.test(schema)) return;
  const pool = getTestPool();
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
}

/**
 * 关闭全局 pool（jest globalTeardown 用 — 但当前先用 afterAll 在 spec 内 cleanup）
 */
export async function closeTestPool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
    _publicReady = false;
  }
}

// ----------------------------------------------------------------
// Redis test client（spec 内用 — 与 PG 同 lifecycle）
// 项目已有 ioredis dep，用 ioredis 不引入新包
// ----------------------------------------------------------------
export function makeTestRedisClient(): Redis {
  return new Redis({
    host: REDIS_TEST_CONFIG.host,
    port: REDIS_TEST_CONFIG.port,
    lazyConnect: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
  });
}

// ----------------------------------------------------------------
// Crypto helpers — 与 jest.setup.ts 同 32B 全 0 / 全 4 测试 key
// 真 FieldEncryptor / HmacHasher 走 process.env，已被 jest.setup.ts 注入
// ----------------------------------------------------------------
export { FieldEncryptor } from '../../src/common/crypto/field-encryptor';
export { HmacHasher } from '../../src/common/crypto/hmac-hasher';

/**
 * 与 ConfigService 行为一致的 mock — repository 构造器只 inject FieldEncryptor / HmacHasher
 * 不直接读 ConfigService（依赖注入 + 测试 setup 已自带 process.env.ENCRYPTION_KEY/HASH_KEY）
 */
export function makeTestConfigService(): {
  get: <T = string>(key: string, def?: T) => T;
  getOrThrow: <T = string>(key: string) => T;
} {
  return {
    get: <T = string>(key: string, def?: T): T => {
      const v = process.env[key];
      return (v as unknown as T) ?? (def as T);
    },
    getOrThrow: <T = string>(key: string): T => {
      const v = process.env[key];
      if (v === undefined) throw new Error(`config ${key} required`);
      return v as unknown as T;
    },
  };
}

/**
 * 应用层 client 跑 SQL（带 search_path 切换）— 便于 spec 自己 INSERT seed / 检查 SQL
 *
 * 不复用 PgPoolService — 测试要直跑 SQL 检查 schema 状态（如 \d 查列、ALTER 测漂移）
 */
export async function runInSchema<T>(
  schema: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!/^tenant_[a-z0-9_]+$/.test(schema)) {
    throw new Error(`runInSchema invalid schema: ${schema}`);
  }
  const pool = getTestPool();
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO ${schema}, public`);
    return await fn(client);
  } finally {
    await client.query(`SET search_path TO public`).catch(() => {});
    client.release();
  }
}

/**
 * 公共 schema 跑 SQL（spec 用于 INSERT public.tenants / public.campuses 等）
 */
export async function runInPublic<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = getTestPool();
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO public`);
    return await fn(client);
  } finally {
    client.release();
  }
}

// ----------------------------------------------------------------
// 32-char ULID-style id 生成器（与 repository genId 一致）
// 仅测试用 — 不依赖 ulid package
// ----------------------------------------------------------------
const ULID_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function testUlid(): string {
  let s = '';
  for (let i = 0; i < 32; i++) {
    s += ULID_CHARS[Math.floor(Math.random() * ULID_CHARS.length)];
  }
  return s;
}

// ----------------------------------------------------------------
// 灌最小 seed —— spec 自己挑用（不全 spec 都需要全套 seed）
//
// 提供 4 种 seed builder：
//   1. seedCampus(schema)           → 1 campus row
//   2. seedAdminUser(schema)         → 1 admin user row（campus_id 拿 seedCampus）
//   3. seedCustomer(schema)         → 1 customer row（含 V41 三写 mobile）
//   4. seedStudent(schema, customerId) → 1 student row
//   5. seedContract(schema, studentId) → 1 contract row（status=pending）
// ----------------------------------------------------------------

export interface SeedCampus {
  id: string;
  name: string;
}
export async function seedCampus(schema: string, overrides: Partial<SeedCampus> = {}): Promise<SeedCampus> {
  const id = overrides.id || testUlid();
  const name = overrides.name || `测试校区-${id.slice(0, 6)}`;
  await runInSchema(schema, async (client) => {
    await client.query(
      `INSERT INTO ${schema}.campuses (id, name, status, created_by, updated_by)
       VALUES ($1, $2, '启用', 'test', 'test')`,
      [id, name],
    );
  });
  return { id, name };
}

export interface SeedUser {
  id: string;
  name: string;
  mobile: string;
  role: string;
  campusId: string;
}
export async function seedAdminUser(
  schema: string,
  campusId: string,
  overrides: Partial<SeedUser> = {},
): Promise<SeedUser> {
  const id = overrides.id || testUlid();
  const mobile = overrides.mobile || `139${Math.floor(10000000 + Math.random() * 89999999)}`;
  const name = overrides.name || `admin-${id.slice(0, 6)}`;
  const role = overrides.role || 'admin';
  await runInSchema(schema, async (client) => {
    await client.query(
      `INSERT INTO ${schema}.users (id, name, mobile, role, campus_id, status, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, '启用', 'test', 'test')`,
      [id, name, mobile, role, campusId],
    );
  });
  return { id, name, mobile, role, campusId };
}

export interface SeedCustomer {
  id: string;
  parentName: string;
  primaryMobile: string;
  campusId: string;
  ownerId: string;
}
/**
 * 灌 customer — 含 V41 primary_mobile 三写（明文 + hash + encrypted）
 * 默认 hash + encrypted=NULL（模拟 V41 backfill 之前的旧数据）
 * 如需新数据三写，传 overrides.tripleWrite=true（spec 用 hashFn / encryptFn 注入）
 */
export async function seedCustomer(
  schema: string,
  campusId: string,
  ownerId: string,
  overrides: Partial<SeedCustomer> & {
    mobileHash?: Buffer | null;
    mobileEncrypted?: Buffer | null;
  } = {},
): Promise<SeedCustomer> {
  const id = overrides.id || testUlid();
  const parentName = overrides.parentName || `家长-${id.slice(0, 6)}`;
  const primaryMobile =
    overrides.primaryMobile ||
    `138${Math.floor(10000000 + Math.random() * 89999999)}`;
  await runInSchema(schema, async (client) => {
    await client.query(
      `INSERT INTO ${schema}.customers
         (id, parent_name, primary_mobile, primary_mobile_hash, primary_mobile_encrypted,
          campus_id, owner_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'test', 'test')`,
      [
        id,
        parentName,
        primaryMobile,
        overrides.mobileHash ?? null,
        overrides.mobileEncrypted ?? null,
        campusId,
        ownerId,
      ],
    );
  });
  return { id, parentName, primaryMobile, campusId, ownerId };
}

export interface SeedStudent {
  id: string;
  studentName: string;
  customerId: string;
}
export async function seedStudent(
  schema: string,
  customerId: string,
  overrides: Partial<SeedStudent> = {},
): Promise<SeedStudent> {
  const id = overrides.id || testUlid();
  const studentName = overrides.studentName || `学员-${id.slice(0, 6)}`;
  await runInSchema(schema, async (client) => {
    await client.query(
      `INSERT INTO ${schema}.students (id, student_name, customer_id, created_by, updated_by)
       VALUES ($1, $2, $3, 'test', 'test')`,
      [id, studentName, customerId],
    );
  });
  return { id, studentName, customerId };
}

export interface SeedCourseProduct {
  id: string;
  productName: string;
  courseLine: string;
}
export async function seedCourseProduct(
  schema: string,
  overrides: Partial<SeedCourseProduct> = {},
): Promise<SeedCourseProduct> {
  const id = overrides.id || testUlid();
  const productName = overrides.productName || `课程产品-${id.slice(0, 6)}`;
  const courseLine = overrides.courseLine || '数学';
  await runInSchema(schema, async (client) => {
    await client.query(
      `INSERT INTO ${schema}.course_products
         (id, product_name, course_line, class_type, standard_price, status, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, '上架', 'test', 'test')`,
      [id, productName, courseLine, '一对一', 200.0],
    );
  });
  return { id, productName, courseLine };
}

export interface SeedContract {
  id: string;
  studentId: string;
  courseProductId: string;
  status: string;
}
export async function seedContract(
  schema: string,
  studentId: string,
  courseProductId: string,
  overrides: Partial<SeedContract> & { totalAmount?: number; campusId?: string } = {},
): Promise<SeedContract> {
  const id = overrides.id || testUlid();
  const status = overrides.status || 'pending';
  await runInSchema(schema, async (client) => {
    await client.query(
      `INSERT INTO ${schema}.contracts
         (id, student_id, course_product_id, lesson_hours,
          standard_price, total_amount, owner_user_id, signed_at,
          status, campus_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, $9, 'test', 'test')`,
      [
        id,
        studentId,
        courseProductId,
        overrides['lessonHours' as keyof typeof overrides] ?? 20,
        200.0,
        overrides.totalAmount ?? 4000.0,
        'test-owner-' + id.slice(0, 8),
        status,
        overrides.campusId ?? null,
      ],
    );
  });
  return { id, studentId, courseProductId, status };
}
