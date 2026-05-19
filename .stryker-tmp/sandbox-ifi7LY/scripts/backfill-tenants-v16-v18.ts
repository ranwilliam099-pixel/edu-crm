/**
 * backfill-tenants-v16-v18.ts
 *
 * 一次性脚本：对所有"已开通"的现有租户 schema 跑 V16/V17/V18 三个 migration
 *
 * 来源：用户 2026-05-05 部署 V16-V19 缺口补齐
 *
 * 三个 migration 都用 IF NOT EXISTS / ADD COLUMN IF NOT EXISTS，**幂等**安全
 * （重复跑不会出错，已存在的列/表会被跳过）
 *
 * 用法：
 *   # dry-run（默认）：列出会跑哪些 schema 但不真执行
 *   pnpm tsx scripts/backfill-tenants-v16-v18.ts
 *
 *   # 真执行：
 *   pnpm tsx scripts/backfill-tenants-v16-v18.ts --apply
 *
 *   # 只跑特定 tenant（通过 id）
 *   pnpm tsx scripts/backfill-tenants-v16-v18.ts --apply --tenant-id=01abcd...
 *
 *   # 同时跑 V19（public migration，慎用，会改 public.tenants + 创 public.campuses）
 *   pnpm tsx scripts/backfill-tenants-v16-v18.ts --apply --include-v19
 *
 * 环境变量：从 .env 读 DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME
 *
 * 注意：
 *   - V16/V17/V18 是 tenant schema migration（每个 tenant_xxx schema 都要跑一次）
 *   - V19 是 public schema migration（整个 DB 跑一次）
 *   - 单个 schema 失败不阻塞其他 schema（错误隔离）
 *   - exit code: 0 全成功 / 1 部分失败
 */
import { Pool, PoolClient } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

// ===== 加载 .env =====
function loadEnv(): void {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) {
    console.warn(`[warn] .env not found at ${envPath}, using process.env only`);
    return;
  }
  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

// ===== 参数解析 =====
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const INCLUDE_V19 = args.includes('--include-v19');
const tenantIdArg = args.find((a) => a.startsWith('--tenant-id='));
const ONLY_TENANT_ID = tenantIdArg ? tenantIdArg.split('=')[1] : null;

const TENANT_MIGRATIONS = [
  'V16__leaves_in_tenant_schema.sql',
  'V17__parent_recommendations_in_tenant_schema.sql',
  'V18__lesson_feedbacks_extended_fields.sql',
];

const PUBLIC_MIGRATIONS = [
  'V19__campuses_and_plan.sql',
];

// ===== 颜色日志 =====
const C = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
};

function log(msg: string): void {
  console.log(msg);
}
function ok(msg: string): void {
  console.log(`${C.green}✓${C.reset} ${msg}`);
}
function fail(msg: string): void {
  console.log(`${C.red}✗${C.reset} ${msg}`);
}
function warn(msg: string): void {
  console.log(`${C.yellow}⚠${C.reset} ${msg}`);
}
function info(msg: string): void {
  console.log(`${C.cyan}ℹ${C.reset} ${msg}`);
}

// ===== 主流程 =====
async function main(): Promise<void> {
  loadEnv();

  // 模式 banner
  log('');
  log(`${C.bold}═══════════════════════════════════════════════════════${C.reset}`);
  log(`${C.bold}  Backfill V16/V17/V18 to existing tenants${C.reset}`);
  log(`${C.bold}═══════════════════════════════════════════════════════${C.reset}`);
  log('');
  if (!APPLY) {
    warn(`DRY-RUN mode (default). 加 ${C.bold}--apply${C.reset} 才会真执行。`);
  } else {
    info(`APPLY mode. 真执行模式。`);
  }
  if (INCLUDE_V19) {
    info(`同时执行 V19__campuses_and_plan.sql（public schema migration）`);
  }
  if (ONLY_TENANT_ID) {
    info(`只跑 tenant: ${ONLY_TENANT_ID}`);
  }
  log('');

  // 创建 pool
  const pool = new Pool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'eduapp',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'edu',
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  info(`Connecting to ${process.env.DB_HOST}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME}...`);
  try {
    const ping = await pool.query('SELECT NOW() as ts');
    ok(`Connected. Server time: ${ping.rows[0].ts}`);
  } catch (e) {
    fail(`Connection failed: ${(e as Error).message}`);
    process.exit(1);
  }
  log('');

  // 读 migration SQL
  const migrationsDir = path.resolve(__dirname, '..', 'migrations');
  const migrationSql = new Map<string, string>();
  for (const file of [...TENANT_MIGRATIONS, ...PUBLIC_MIGRATIONS]) {
    const filePath = path.join(migrationsDir, file);
    if (!fs.existsSync(filePath)) {
      fail(`Migration file not found: ${file}`);
      process.exit(1);
    }
    migrationSql.set(file, fs.readFileSync(filePath, 'utf-8'));
  }
  ok(`Loaded ${migrationSql.size} migration files from ${migrationsDir}`);
  log('');

  // ===== Step 1: V19（public）=====
  if (INCLUDE_V19) {
    log(`${C.bold}─── Public schema: V19 ───${C.reset}`);
    const sql = migrationSql.get('V19__campuses_and_plan.sql')!;
    if (!APPLY) {
      info(`[dry-run] would run V19 on public schema (${sql.length} bytes SQL)`);
    } else {
      try {
        await pool.query(sql);
        ok(`V19 applied to public schema`);
      } catch (e) {
        fail(`V19 failed: ${(e as Error).message}`);
        process.exit(1);
      }
    }
    log('');
  }

  // ===== Step 2: 列出现有 tenants =====
  log(`${C.bold}─── Tenant schemas: V16/V17/V18 ───${C.reset}`);
  let tenants: Array<{ id: string; name: string }>;
  try {
    let q = 'SELECT id, name FROM public.tenants ORDER BY created_at ASC';
    let p: any[] = [];
    if (ONLY_TENANT_ID) {
      q = 'SELECT id, name FROM public.tenants WHERE id = $1';
      p = [ONLY_TENANT_ID];
    }
    const result = await pool.query<{ id: string; name: string }>(q, p);
    tenants = result.rows;
  } catch (e) {
    fail(`Query tenants failed: ${(e as Error).message}`);
    process.exit(1);
  }

  if (tenants.length === 0) {
    warn('No tenants found in public.tenants');
    await pool.end();
    return;
  }
  info(`Found ${tenants.length} tenant(s) to migrate`);
  log('');

  // ===== Step 3: 对每个 tenant schema 跑 V16/V17/V18 =====
  const summary: Array<{ tenantId: string; name: string; ran: string[]; failed: string[] }> = [];

  for (const tenant of tenants) {
    const tenantSchema = `tenant_${tenant.id.toLowerCase()}`;
    log(`${C.gray}─── ${tenant.name} (${tenant.id.slice(0, 8)}...)${C.reset}`);

    // 验证 schema 存在
    const schemaCheck = await pool.query(
      `SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`,
      [tenantSchema],
    );
    if (schemaCheck.rowCount === 0) {
      warn(`  schema ${tenantSchema} not found, SKIP`);
      summary.push({ tenantId: tenant.id, name: tenant.name, ran: [], failed: ['schema-missing'] });
      continue;
    }

    const tenantSummary = { tenantId: tenant.id, name: tenant.name, ran: [] as string[], failed: [] as string[] };

    for (const file of TENANT_MIGRATIONS) {
      const sqlTemplate = migrationSql.get(file)!;
      const sql = sqlTemplate.replace(/__TENANT_SCHEMA__/g, tenantSchema);

      if (!APPLY) {
        info(`  [dry-run] would run ${file}`);
        tenantSummary.ran.push(file);
        continue;
      }

      let client: PoolClient | null = null;
      try {
        client = await pool.connect();
        await client.query(sql);
        ok(`  ${file}`);
        tenantSummary.ran.push(file);
      } catch (e) {
        fail(`  ${file}: ${(e as Error).message}`);
        tenantSummary.failed.push(file);
        // 不 break — 继续下一个 migration 文件（V16 失败不影响 V17）
      } finally {
        if (client) client.release();
      }
    }

    summary.push(tenantSummary);
    log('');
  }

  // ===== Step 4: 总结 =====
  log(`${C.bold}═══════════════════════════════════════════════════════${C.reset}`);
  log(`${C.bold}  Summary${C.reset}`);
  log(`${C.bold}═══════════════════════════════════════════════════════${C.reset}`);

  let totalSuccess = 0;
  let totalFailed = 0;
  for (const s of summary) {
    totalSuccess += s.ran.length;
    totalFailed += s.failed.length;
    if (s.failed.length === 0) {
      log(`  ${C.green}✓${C.reset} ${s.name}: ${s.ran.length}/${TENANT_MIGRATIONS.length} migrations`);
    } else {
      log(`  ${C.red}✗${C.reset} ${s.name}: ${s.ran.length} ok / ${s.failed.length} failed (${s.failed.join(', ')})`);
    }
  }

  log('');
  if (!APPLY) {
    info(`Total: ${tenants.length} tenants × 3 migrations = ${tenants.length * 3} would-run`);
    info(`This was DRY-RUN. 加 ${C.bold}--apply${C.reset} 真执行。`);
  } else {
    info(`Total: ${totalSuccess} success / ${totalFailed} failed`);
    if (totalFailed > 0) {
      warn(`Some migrations failed. Check logs above. Migrations are idempotent — you can re-run safely.`);
    } else {
      ok(`All migrations applied successfully.`);
    }
  }

  log('');
  if (!INCLUDE_V19) {
    warn(`V19__campuses_and_plan.sql (public schema) NOT applied.`);
    warn(`手动跑：${C.bold}psql ... -f migrations/V19__campuses_and_plan.sql${C.reset}`);
    warn(`或加 ${C.bold}--include-v19${C.reset} 让本脚本跑（注意会改 public.tenants）`);
  }

  await pool.end();
  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(`\n${C.red}FATAL${C.reset}: ${(e as Error).message}`);
  console.error((e as Error).stack);
  process.exit(2);
});
