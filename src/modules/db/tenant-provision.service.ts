import { Injectable, Logger, BadRequestException, ConflictException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PgPoolService } from './pg-pool.service';

/**
 * TenantProvisionService — 租户 schema 自动创建
 *
 * 来源：
 *   - 用户 2026-05-02「做啊」（让真业务数据真存 PG）
 *   - 教学链路设计 + V2/V4/V5/V7/V8/V8.1/V9/V12/V13/V14/V15 schema 模板
 *
 * 流程：
 *   1. 接收 tenantId（32-char ULID）
 *   2. 查 public.tenants 是否已存在 → 已存在 → 409
 *   3. 创建 schema tenant_<tenantId>
 *   4. 顺序跑 V2 → V4 → V5 → V7 → V8 → V8.1 → V9 → V12 → V13 → V14 → V15
 *      （每个文件把 `__TENANT_SCHEMA__` 占位符替换为 tenant_<tenantId>）
 *   5. INSERT 一行到 public.tenants
 */
const TENANT_MIGRATIONS = [
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
];

@Injectable()
export class TenantProvisionService {
  private readonly logger = new Logger(TenantProvisionService.name);
  private readonly migrationsDir: string;

  constructor(private readonly pg: PgPoolService) {
    // dist/src/modules/db/* 反向到 dist 根目录，再到项目根 → migrations
    // 兼容 dev (src/modules/db/*) 和 prod (dist/src/modules/db/*)
    const candidates = [
      path.resolve(__dirname, '../../../migrations'),
      path.resolve(__dirname, '../../../../migrations'),
      path.resolve(process.cwd(), 'migrations'),
    ];
    this.migrationsDir = candidates.find((p) => fs.existsSync(p)) || candidates[0];
    this.logger.log(`[TenantProvision] migrations dir: ${this.migrationsDir}`);
  }

  /**
   * 完整开通租户
   *
   * @param tenantId 32-char ULID（前缀 'tenant_' 不需手加）
   */
  async provisionTenant(input: {
    tenantId: string;
    name: string;
    sku: 'trial' | 'standard_1999' | 'school_pro' | 'growth';
  }): Promise<{ tenantId: string; tenantSchema: string; ranMigrations: string[] }> {
    if (!input.tenantId || input.tenantId.length !== 32) {
      throw new BadRequestException('tenantId must be 32-char ULID');
    }
    if (!input.name) {
      throw new BadRequestException('name required');
    }
    if (!['trial', 'standard_1999', 'school_pro', 'growth'].includes(input.sku)) {
      throw new BadRequestException(`invalid sku: ${input.sku}`);
    }

    // 检查 tenants 表是否存在 + 是否已开通
    const existing = await this.pg.query<{ id: string }>(
      'SELECT id FROM public.tenants WHERE id = $1',
      [input.tenantId],
    );
    if (existing.length > 0) {
      throw new ConflictException(`tenant ${input.tenantId} already exists`);
    }

    const tenantSchema = `tenant_${input.tenantId.toLowerCase()}`;
    const ranMigrations: string[] = [];

    // 幂等保证：先 DROP 可能残留的半成品 schema（前一次失败遗留）
    await this.pg.query(`DROP SCHEMA IF EXISTS ${tenantSchema} CASCADE`);
    // 创建 schema
    await this.pg.query(`CREATE SCHEMA ${tenantSchema}`);
    this.logger.log(`[TenantProvision] schema ${tenantSchema} created (clean)`);

    // 顺序跑 11 个 migration
    for (const file of TENANT_MIGRATIONS) {
      const filePath = path.join(this.migrationsDir, file);
      if (!fs.existsSync(filePath)) {
        this.logger.warn(`[TenantProvision] migration not found: ${file}, SKIP`);
        continue;
      }
      const sqlTemplate = fs.readFileSync(filePath, 'utf-8');
      let sql = sqlTemplate.replace(/__TENANT_SCHEMA__/g, tenantSchema);

      // V4 完整版 referrals / renewals 与 V2 占位骨架字段不同 → 先 DROP V2 占位
      if (file.startsWith('V4__')) {
        sql =
          `SET search_path = ${tenantSchema}, public;\n` +
          `DROP TABLE IF EXISTS referrals CASCADE;\n` +
          `DROP TABLE IF EXISTS renewals CASCADE;\n` +
          sql;
      }

      try {
        await this.pg.withClient(async (client) => {
          await client.query(sql);
        });
        ranMigrations.push(file);
        this.logger.log(`[TenantProvision] ✓ ${file}`);
      } catch (e) {
        this.logger.error(`[TenantProvision] ✗ ${file}: ${(e as Error).message}`);
        throw new Error(`Migration ${file} failed: ${(e as Error).message}`);
      }
    }

    // sku → version 映射（V1 tenants 用 version 列：标准版/校区版/增长版）
    const versionMap: Record<string, string> = {
      trial: '标准版',
      standard_1999: '标准版',
      school_pro: '校区版',
      growth: '增长版',
    };
    const version = versionMap[input.sku] || '标准版';

    // INSERT 到 public.tenants（V1 schema：id/name/version/status/...）
    await this.pg.query(
      `INSERT INTO public.tenants (id, name, version, status, created_at)
       VALUES ($1, $2, $3, '试用中', NOW())
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, version = EXCLUDED.version`,
      [input.tenantId, input.name, version],
    );

    this.logger.log(`[TenantProvision] ✅ tenant ${input.tenantId} provisioned (${ranMigrations.length} migrations)`);

    return { tenantId: input.tenantId, tenantSchema, ranMigrations };
  }

  /**
   * 列出已开通的租户（V1 schema：id/name/version/status）
   */
  async listTenants(): Promise<Array<{ id: string; name: string; version: string; status: string }>> {
    return this.pg.query(
      `SELECT id, name, version, status FROM public.tenants ORDER BY created_at DESC LIMIT 100`,
    );
  }

  /**
   * 删除租户（仅测试用）
   */
  async deleteTenant(tenantId: string): Promise<void> {
    const tenantSchema = `tenant_${tenantId.toLowerCase()}`;
    await this.pg.query(`DROP SCHEMA IF EXISTS ${tenantSchema} CASCADE`);
    await this.pg.query(`DELETE FROM public.tenants WHERE id = $1`, [tenantId]);
    this.logger.log(`[TenantProvision] deleted tenant ${tenantId}`);
  }
}
