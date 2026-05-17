import { Injectable, Logger, BadRequestException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as fs from 'fs';
import * as path from 'path';
import { ulid } from 'ulid';
import { PgPoolService } from './pg-pool.service';
import {
  AUDIENCE_B_APP,
  JwtPayload,
  TenantRole,
} from '../auth/jwt-payload.interface';
// Sprint X.2 (D8 2026-05-17) — provision-tenant 同 Sprint 加 adminPhone + adminPassword
//   PasswordHasher bcrypt cost=12 写入 users.password_hash (V46 列)
import { PasswordHasher } from '../../common/crypto/password-hasher';
// Sprint X.2 (D8) — provision 前先跨表 phone 唯一性校验, 防 B/C 互斥违反
//   PhoneLookupService 是 @Global AuthModule export (auth.module.ts:48)
import { PhoneLookupService } from '../auth/phone-lookup.service';

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
  // T-DEPLOY-FIX-1 (2026-05-16 code-architect 部署前架构审 BLOCKER)：
  //   5/11-5/16 新增 4 个 tenant schema 占位符 migration 漏加，导致新 tenant
  //   通过 POST /api/public/onboarding/provision-tenant 创建后第一次业务调用
  //   就 PG error：column does not exist。
  //   V37 drop payroll / V39 rename hourly_rate / V42 invoices / V44 deleted_at
  //   全部含 __TENANT_SCHEMA__ 占位符（grep 验证），必须按 V36 之后顺序跑。
  //   V40/V41/V43/V45 不在此列（V40 单独 backfill，V41 customers 也单独 backfill,
  //   V43 refresh_tokens 在 public schema，V45 tenants subscription_status 也在 public）
  'V37__drop_monthly_aggregates_payroll.sql',
  'V39__rename_hourly_rate_to_hourly_price.sql',
  'V42__invoices_in_tenant_schema.sql',
  'V44__add_deleted_at_to_students_teachers_users.sql',
  // Sprint X.2 (2026-05-17) — V46 password_hash + password_updated_at
  //   新 tenant provision 必须包含 V46（admin 创建 user 时 V46 列已存在）
  //   V47 不在此列（public schema 单次执行, 不逐 tenant）
  'V46__add_password_to_users.sql',
];

@Injectable()
export class TenantProvisionService {
  private readonly logger = new Logger(TenantProvisionService.name);
  private readonly migrationsDir: string;

  constructor(
    private readonly pg: PgPoolService,
    // T9-EPIC(2026-05-16) §11 NEW：provision-tenant 响应签 access_token
    //   plan-select 页需 JWT 调 POST /api/db/onboarding/start-trial
    //   admin user 已在 createAdminUser 创建 → 直接签 b-app token
    private readonly jwt: JwtService,
    // Sprint X.2 (D8 2026-05-17) — adminPassword bcrypt 写 password_hash
    private readonly passwordHasher: PasswordHasher,
    // Sprint X.2 (D8) — provision 前跨表 phone 唯一性校验 (互斥红线 SSOT §12.1)
    private readonly phoneLookup: PhoneLookupService,
  ) {
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
    // V29 R5 多校区开通（OOUX：Tenant 1:N Campus）
    // 每个 campus 包含 id（前端生成 32-char ULID）+ name + 可选 address / courseLines
    campuses?: Array<{
      id: string;
      name: string;
      address?: string;
      courseLines?: string;  // 逗号分隔，用于 wizard 用户首签课程线
    }>;
    admin?: {
      id: string;
      name: string;
      phone: string;
      email?: string;
    };
    // Sprint X.2 (D8 2026-05-17) — adminPhone + adminPassword 同 Sprint 加
    //   SSOT §12.4 admin 是机构注册者 + 唯一创建 B 端子账户权
    //   未传则 fallback input.admin.phone (向前兼容历史调用方)
    adminPhone?: string;
    adminPassword?: string;
    products?: Array<{
      name: string;
      classes?: Array<{
        type: string;
        enabled?: boolean;
        price?: string | number;
      }>;
    }>;
  }): Promise<{
    tenantId: string;
    tenantSchema: string;
    ranMigrations: string[];
    campusIds?: string[];
    adminUserId?: string;
    courseProductIds?: string[];
    // T9-EPIC(2026-05-16) §11 NEW：plan-select 页跳转所需的 admin JWT
    accessToken?: string;
  }> {
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

    // Sprint X.2 (D8 2026-05-17) — 跨表 phone 唯一性校验 (SSOT §12.1 B/C 互斥红线)
    //   仅在显式传 input.adminPhone (新参) 时校验；旧调用方未传 → 跳过
    //   (向前兼容 onboarding 旧路径 / 既有单测 / wizard mock 路径)
    //   - 若 phone 已在 parents 表 / 任意 tenant.users 表存在 → 409 拒绝注册
    //   - phone 格式失败 → 400
    if (input.adminPhone) {
      if (!/^1[3-9]\d{9}$/.test(input.adminPhone)) {
        throw new BadRequestException('adminPhone must be valid 11-digit Chinese mobile');
      }
      const lookup = await this.phoneLookup.lookupByPhone(input.adminPhone);
      const activeBUsers = lookup.bUsers.filter(
        (u) => u.status === '启用' && u.deletedAt === null,
      );
      const activeParent =
        lookup.parent && lookup.parent.status === '启用' ? lookup.parent : null;
      if (activeBUsers.length > 0 || activeParent) {
        throw new ConflictException(
          'PHONE_ALREADY_REGISTERED: 该手机号已注册 (B 端员工或 C 端家长)',
        );
      }
    }
    // adminPassword (D8) 必须存在才能 bcrypt 写 password_hash；
    //   未传 → V46 password_hash='' 兜底, 首次 login 必须走密码重置流程 (backlog)
    if (input.adminPassword !== undefined) {
      if (typeof input.adminPassword !== 'string' || input.adminPassword.length < 8) {
        throw new BadRequestException('adminPassword must be string, min 8 chars');
      }
      if (input.adminPassword.length > 128) {
        throw new BadRequestException('adminPassword too long (max 128 chars)');
      }
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

    // INSERT 到 public.tenants（V1 中文 status + V45 订阅状态机双轨）
    //   - V1 status='试用中'：lifecycle/admin/cron 用（中文 enum）
    //   - V45 subscription_status='trial' / trial_ends_at=NOW+14d：
    //     T9-EPIC 拍板 3 — 14d 写死（不 ENV 化），TenantSubscriptionGuard 据此判 expired
    //   - subscribed_until=NULL：付款回调时 SET 为 NOW+365d
    await this.pg.query(
      `INSERT INTO public.tenants
         (id, name, version, status,
          subscription_status, trial_ends_at, subscribed_until, created_at)
       VALUES ($1, $2, $3, '试用中',
               'trial', NOW() + INTERVAL '14 days', NULL, NOW())
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, version = EXCLUDED.version`,
      [input.tenantId, input.name, version],
    );

    // V29 R5 多校区开通：INSERT 每个 campus 到 tenant schema 的 campuses 表
    // 至少建 1 个「主校区」（默认用 input.name）；如 input.campuses 提供则全建
    const campuses = (input.campuses && input.campuses.length > 0)
      ? input.campuses
      : [{ id: this.simpleUlid(), name: input.name + ' 主校区', address: '', courseLines: '' }];
    const campusIds: string[] = [];
    for (const [index, c] of campuses.entries()) {
      if (!c.id || c.id.length !== 32) {
        throw new BadRequestException(`campus id must be 32-char ULID（got ${c.id}）`);
      }
      if (!c.name) {
        throw new BadRequestException('campus name required');
      }
      // V2 campuses 仅有 id/name/address/status/created_at/updated_at/created_by/updated_by
      await this.pg.withClient(async (client) => {
        await client.query(`SET LOCAL search_path TO ${tenantSchema}, public`);
        await client.query(
          `INSERT INTO campuses (id, name, address, status, created_by, updated_by)
           VALUES ($1, $2, $3, '启用', 'wizard', 'wizard')
           ON CONFLICT (id) DO NOTHING`,
          [c.id, c.name, c.address || null],
        );
      });
      await this.pg.query(
        `INSERT INTO public.campuses (
           id, tenant_id, name, city, district, address, is_hq
         ) VALUES ($1, $2, $3, NULL, NULL, $4, $5)
         ON CONFLICT (id) DO UPDATE
           SET name = EXCLUDED.name,
               address = EXCLUDED.address,
               is_hq = EXCLUDED.is_hq`,
        [c.id, input.tenantId, c.name, c.address || null, index === 0],
      );
      campusIds.push(c.id);
    }
    this.logger.log(`[TenantProvision] ✅ ${campusIds.length} campuses created for ${input.tenantId}`);

    // Sprint X.2 (D8) — adminPhone 优先 (新参), fallback admin.phone (向前兼容)
    //   adminPassword 未传则 password_hash='' (V46 DEFAULT), 首次 login 401 兜底走重置
    const adminUserId = await this.createAdminUser(tenantSchema, {
      id: input.admin?.id || this.simpleUlid(),
      name: input.admin?.name || '老板',
      phone: input.adminPhone || input.admin?.phone || '13800001111',
      campusId: campusIds[0],
      password: input.adminPassword,
    });
    const courseProductIds = await this.createCourseProducts(
      tenantSchema,
      input.products || [],
      campusIds,
      adminUserId,
    );
    this.logger.log(
      `[TenantProvision] ✅ admin=${adminUserId}, courseProducts=${courseProductIds.length} created`,
    );

    this.logger.log(`[TenantProvision] ✅ tenant ${input.tenantId} provisioned (${ranMigrations.length} migrations)`);

    // T9-EPIC(2026-05-16) §11 NEW：签 admin access_token 让前端跳 plan-select
    //   - plan-select 调 POST /api/db/onboarding/start-trial 需 JWT（@UseGuards(TenantScopeGuard)）
    //   - 与 auth.controller.ts L134-142 同模式：jwtid (jti) + audience 'b-app' + B 端 role
    //   - campusId 取第一个 campus（admin 本 V10 拍板是跨校组，CROSS_CAMPUS_ROLES 允许 null；
    //     这里给 campusId 是为了首页业务卡能渲染，TenantScopeGuard 不基于此字段做隔离）
    const jti = ulid();
    const signPayload: Omit<JwtPayload, 'jti' | 'aud'> = {
      sub: adminUserId,
      tenantId: input.tenantId,
      role: 'admin' as TenantRole,
      campusId: campusIds[0] ?? null,
    };
    const accessToken = this.jwt.sign(signPayload, {
      jwtid: jti,
      audience: AUDIENCE_B_APP,
    });

    return {
      tenantId: input.tenantId,
      tenantSchema,
      ranMigrations,
      campusIds,
      adminUserId,
      courseProductIds,
      accessToken,
    };
  }

  /** V29 R5 后端兜底 ULID 生成（前端不传 campus.id 时） */
  private simpleUlid(): string {
    const t = Date.now().toString(36).padStart(10, '0');
    let rand = '';
    while (rand.length < 22) rand += Math.random().toString(36).slice(2);
    return (t + rand).slice(0, 32);
  }

  private async createAdminUser(
    tenantSchema: string,
    input: {
      id: string;
      name: string;
      phone: string;
      campusId: string;
      // Sprint X.2 (D8 2026-05-17) — admin 首次密码 bcrypt hash
      //   未传则 password_hash='' (V46 DEFAULT), 首次 login 401 兜底
      password?: string;
    },
  ): Promise<string> {
    if (!input.id || input.id.length !== 32) {
      throw new BadRequestException('admin id must be 32-char ULID');
    }
    // Sprint X.2 (D8) — 计算 bcrypt hash (若传 password); 未传走 DB DEFAULT ''
    const passwordHash = input.password
      ? await this.passwordHasher.hash(input.password)
      : '';
    await this.pg.withClient(async (client) => {
      await client.query(`SET LOCAL search_path TO ${tenantSchema}, public`);
      await client.query(
        `INSERT INTO users
           (id, name, mobile, role, campus_id, status, password_hash, password_updated_at, created_by, updated_by)
         VALUES ($1, $2, $3, 'admin', $4, '启用', $5, CASE WHEN $5 = '' THEN NULL ELSE NOW() END, $1, $1)
         ON CONFLICT (id) DO UPDATE
           SET name = EXCLUDED.name,
               mobile = EXCLUDED.mobile,
               role = 'admin',
               campus_id = EXCLUDED.campus_id,
               status = '启用',
               password_hash = EXCLUDED.password_hash,
               password_updated_at = EXCLUDED.password_updated_at,
               updated_at = NOW(),
               updated_by = EXCLUDED.updated_by`,
        [input.id, input.name, input.phone, input.campusId, passwordHash],
      );
    });
    return input.id;
  }

  private async createCourseProducts(
    tenantSchema: string,
    products: Array<{
      name: string;
      classes?: Array<{ type: string; enabled?: boolean; price?: string | number }>;
    }>,
    campusIds: string[],
    operatorUserId: string,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const product of products) {
      const name = product.name && product.name.trim();
      if (!name) continue;
      const enabledClasses = (product.classes || []).filter((c) => c.enabled);
      for (const cls of enabledClasses) {
        const id = this.simpleUlid();
        const classType = cls.type || '一对一';
        const price = Number(cls.price || 0);
        await this.pg.withClient(async (client) => {
          await client.query(`SET LOCAL search_path TO ${tenantSchema}, public`);
          await client.query(
            `INSERT INTO course_products
               (id, product_name, course_line, class_type, lesson_package,
                standard_price, campus_scope, status, created_by, updated_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, '上架', $8, $8)
             ON CONFLICT (id) DO NOTHING`,
            [
              id,
              `${name} · ${classType}`,
              this.inferCourseLine(name),
              classType,
              name,
              Number.isFinite(price) && price > 0 ? price : 0,
              campusIds.join(','),
              operatorUserId,
            ],
          );
        });
        ids.push(id);
      }
    }
    return ids;
  }

  private inferCourseLine(name: string): string {
    const match = name.match(/(语文|数学|英语|物理|化学|生物|历史|地理|政治)/);
    return match ? match[1] : '综合';
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
