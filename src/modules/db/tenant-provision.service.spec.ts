/**
 * TenantProvisionService — Day 2 Phase A P0-1 修复单测
 *
 * 测试范围：
 *   1. createAdminUser INSERT 使用 fully-qualified `${tenantSchema}.users`（不依赖 search_path）
 *   2. campus INSERT 使用 fully-qualified `${tenantSchema}.campuses`
 *   3. course_products INSERT 使用 fully-qualified `${tenantSchema}.course_products`
 *   4. admin name > 32 char → 提前 400 BadRequest（防 VARCHAR(32) overflow）
 *   5. admin name 空字符串 → 400
 *   6. admin name 32 char 边界 → 通过
 *
 * 根因（5/19 reset 2 个 tenant 失败）：
 *   - PG `SET LOCAL search_path` outside BEGIN/COMMIT → WARNING 后忽略
 *   - reset-all-tenants.sh L612 `adminName: 'demo-admin-${LOGICAL_NAME}'` 对
 *     demo-admin-multi-campus (34) + demo-parent-multi-tenant (35) overflow VARCHAR(32)
 *   - 修复 1: tenant-provision.service.ts L294/401/441 改用 fully-qualified schema
 *   - 修复 2: tenant-provision.service.ts createAdminUser 前置 input.name <= 32 校验
 *   - 修复 3: scripts/reset-all-tenants.sh L612 adminName 改 ${LOGICAL_NAME} 直接（最长 24）
 */

import { JwtService } from '@nestjs/jwt';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { TenantProvisionService } from './tenant-provision.service';
import { PgPoolService } from './pg-pool.service';
import { PasswordHasher } from '../../common/crypto/password-hasher';
import { PhoneLookupService } from '../auth/phone-lookup.service';

describe('TenantProvisionService (Day 2 Phase A P0-1 fix)', () => {
  let service: TenantProvisionService;
  let pg: {
    query: jest.Mock;
    withClient: jest.Mock;
  };
  let jwt: { sign: jest.Mock };
  let passwordHasher: { hash: jest.Mock };
  let phoneLookup: { lookupByPhone: jest.Mock };

  const VALID_TENANT_ID = 'tx00000000000000000000000000abcd';
  const VALID_CAMPUS_ID = 'cx00000000000000000000000000abcd';
  const VALID_ADMIN_ID = 'ux00000000000000000000000000abcd';

  // 模拟 client.query 跟踪所有 SQL（用于断言 fully-qualified schema 名）
  const clientQueryCalls: Array<{ sql: string; params?: any[] }> = [];
  const mockClient = {
    query: jest.fn((sql: string, params?: any[]) => {
      clientQueryCalls.push({ sql, params });
      return Promise.resolve({ rows: [] });
    }),
  };

  beforeEach(() => {
    clientQueryCalls.length = 0;
    mockClient.query.mockClear();

    pg = {
      query: jest.fn().mockImplementation((sql: string) => {
        // SELECT existing tenants — 返回空（让 provision 继续）
        if (/SELECT id FROM public\.tenants/.test(sql)) {
          return Promise.resolve([]);
        }
        // INSERT public.tenants / DROP SCHEMA / CREATE SCHEMA / INSERT public.campuses
        return Promise.resolve([]);
      }),
      withClient: jest.fn(async (fn: any) => {
        // 用 mockClient 让 fn 跑且记录所有 client.query
        return fn(mockClient);
      }),
    };
    jwt = {
      sign: jest.fn().mockReturnValue('mock.jwt.token'),
    };
    passwordHasher = {
      hash: jest.fn().mockResolvedValue('$2b$12$mockbcrypthashvalueofexactly60characterslong000000000000000'),
    };
    phoneLookup = {
      lookupByPhone: jest.fn().mockResolvedValue({
        bUsers: [],
        parent: null,
      }),
    };

    service = new TenantProvisionService(
      pg as unknown as PgPoolService,
      jwt as unknown as JwtService,
      passwordHasher as unknown as PasswordHasher,
      phoneLookup as unknown as PhoneLookupService,
    );
  });

  // ===== P0-1 修复验证 =====
  describe('P0-1 fully-qualified schema 名（不依赖 search_path）', () => {
    it('happy path: campus / admin user / course_products INSERT 全部 fully-qualified', async () => {
      const result = await service.provisionTenant({
        tenantId: VALID_TENANT_ID,
        name: 'demo-test',
        sku: 'standard_1999',
        campuses: [{ id: VALID_CAMPUS_ID, name: '主校区', address: '北京市朝阳区' }],
        admin: { id: VALID_ADMIN_ID, name: 'demo-admin', phone: '13800000001' },
        products: [
          {
            name: '语文培优',
            classes: [{ type: '一对一', enabled: true, price: 200 }],
          },
        ],
      });

      // 验证 1: campus INSERT 用 `${tenantSchema}.campuses`，不是 unqualified `campuses`
      const expectedSchema = `tenant_${VALID_TENANT_ID.toLowerCase()}`;
      const campusInsert = clientQueryCalls.find(
        (c) => c.sql.includes('INSERT INTO') && c.sql.includes('.campuses'),
      );
      expect(campusInsert).toBeDefined();
      expect(campusInsert!.sql).toContain(`INSERT INTO ${expectedSchema}.campuses`);

      // 验证 2: admin user INSERT 用 `${tenantSchema}.users`
      const userInsert = clientQueryCalls.find(
        (c) => c.sql.includes('INSERT INTO') && c.sql.includes('.users'),
      );
      expect(userInsert).toBeDefined();
      expect(userInsert!.sql).toContain(`INSERT INTO ${expectedSchema}.users`);

      // 验证 3: course_products INSERT 用 `${tenantSchema}.course_products`
      const cpInsert = clientQueryCalls.find(
        (c) => c.sql.includes('INSERT INTO') && c.sql.includes('.course_products'),
      );
      expect(cpInsert).toBeDefined();
      expect(cpInsert!.sql).toContain(`INSERT INTO ${expectedSchema}.course_products`);

      // 验证 4: 不再有「前置」`SET LOCAL search_path` 调用替代 fully-qualified schema
      //   注意：migration SQL 内本身含 BEGIN/COMMIT + SET LOCAL（合法用法），不计入
      //   只验证业务 INSERT 前的「裸 SET LOCAL」（即非整段 migration 的小调用）
      //   migration SQL 通常很长（>500 char）+ 含 ALTER TABLE / CREATE INDEX 等关键字
      //   只看 INSERT 这类 short SQL 是否还前置 SET LOCAL
      const bareSetLocalCalls = clientQueryCalls.filter(
        (c) =>
          c.sql.includes('SET LOCAL search_path') &&
          c.sql.length < 200 && // migration 通常很长
          !c.sql.includes('ALTER TABLE') &&
          !c.sql.includes('CREATE INDEX') &&
          !c.sql.includes('CREATE TABLE'),
      );
      expect(bareSetLocalCalls).toEqual([]);

      // 验证 5: 返回值包含 expected schema + admin id + campus
      expect(result.tenantId).toBe(VALID_TENANT_ID);
      expect(result.tenantSchema).toBe(expectedSchema);
      expect(result.adminUserId).toBe(VALID_ADMIN_ID);
      expect(result.campusIds).toEqual([VALID_CAMPUS_ID]);
      expect(result.courseProductIds).toHaveLength(1);
      expect(result.accessToken).toBe('mock.jwt.token');
    });

    it('多 campus: 每个 campus 都用 fully-qualified schema 名', async () => {
      const campusId2 = 'cx00000000000000000000000000xxxx';
      const campusId3 = 'cx00000000000000000000000000yyyy';
      await service.provisionTenant({
        tenantId: VALID_TENANT_ID,
        name: 'demo-multi',
        sku: 'school_pro',
        campuses: [
          { id: VALID_CAMPUS_ID, name: '北校区', address: '北街 1 号' },
          { id: campusId2, name: '南校区', address: '南街 2 号' },
          { id: campusId3, name: '东校区', address: '东街 3 号' },
        ],
        admin: { id: VALID_ADMIN_ID, name: 'demo-admin', phone: '13800000002' },
      });

      const expectedSchema = `tenant_${VALID_TENANT_ID.toLowerCase()}`;
      const campusInserts = clientQueryCalls.filter(
        (c) => c.sql.includes('INSERT INTO') && c.sql.includes('.campuses'),
      );
      // 3 个 campus → 3 个 INSERT，全部 fully-qualified
      expect(campusInserts).toHaveLength(3);
      for (const insert of campusInserts) {
        expect(insert.sql).toContain(`INSERT INTO ${expectedSchema}.campuses`);
      }
      // 参数与 campus 数据匹配（id / name / address）
      expect(campusInserts[0].params?.slice(0, 3)).toEqual([
        VALID_CAMPUS_ID,
        '北校区',
        '北街 1 号',
      ]);
      expect(campusInserts[1].params?.slice(0, 3)).toEqual([
        campusId2,
        '南校区',
        '南街 2 号',
      ]);
      expect(campusInserts[2].params?.slice(0, 3)).toEqual([
        campusId3,
        '东校区',
        '东街 3 号',
      ]);
    });
  });

  // ===== P0-1 修复 2: admin name VARCHAR(32) 边界校验 =====
  describe('P0-1 admin name VARCHAR(32) 边界校验', () => {
    it('adminName > 32 char → 400 BadRequest（fail-fast, 不建 schema 不跑 migration 不插入）', async () => {
      // demo-admin-demo-admin-multi-campus = 34 char (重现 5/19 reset 失败场景)
      const tooLongName = 'demo-admin-demo-admin-multi-campus';
      expect(tooLongName.length).toBe(34);

      await expect(
        service.provisionTenant({
          tenantId: VALID_TENANT_ID,
          name: 'demo-x',
          sku: 'standard_1999',
          campuses: [{ id: VALID_CAMPUS_ID, name: '主校区' }],
          adminName: tooLongName,
          adminPhone: '13800000003',
          adminPassword: 'TestPwd123',
        }),
      ).rejects.toThrow(BadRequestException);

      // 确保不调用任何业务 INSERT（fail fast 前置）
      const userInsertCalls = clientQueryCalls.filter(
        (c) => c.sql.includes('INSERT INTO') && c.sql.includes('.users'),
      );
      expect(userInsertCalls).toEqual([]);
      const campusInsertCalls = clientQueryCalls.filter(
        (c) => c.sql.includes('INSERT INTO') && c.sql.includes('.campuses'),
      );
      expect(campusInsertCalls).toEqual([]);

      // fail-fast 关键断言：不应触发任何 pg.query 写操作
      //   验证 P0-1 修复彻底（schema 不建 + migration 不跑 + 不留 orphan schema）
      const schemaWrites = pg.query.mock.calls.filter((c: any[]) => {
        const sql = String(c[0] || '');
        return (
          sql.includes('CREATE SCHEMA') ||
          sql.includes('DROP SCHEMA') ||
          (sql.includes('INSERT INTO public.tenants') && !sql.includes('SELECT'))
        );
      });
      expect(schemaWrites).toEqual([]);
    });

    it('adminName 35 char（demo-parent-multi-tenant 场景）→ 400 BadRequest', async () => {
      const tooLongName = 'demo-admin-demo-parent-multi-tenant';
      expect(tooLongName.length).toBe(35);

      let caught: BadRequestException | undefined;
      try {
        await service.provisionTenant({
          tenantId: VALID_TENANT_ID,
          name: 'demo-y',
          sku: 'trial',
          campuses: [{ id: VALID_CAMPUS_ID, name: '主校区' }],
          adminName: tooLongName,
          adminPhone: '13800000004',
        });
      } catch (e) {
        caught = e as BadRequestException;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      // 错误消息必须包含明确长度（便于运维定位）
      expect(caught!.message).toContain('32');
      expect(caught!.message).toContain('35');
    });

    it('adminName 32 char 边界 → 通过', async () => {
      const exactLengthName = 'a'.repeat(32);
      expect(exactLengthName.length).toBe(32);

      await service.provisionTenant({
        tenantId: VALID_TENANT_ID,
        name: 'demo-z',
        sku: 'standard_1999',
        campuses: [{ id: VALID_CAMPUS_ID, name: '主校区' }],
        adminName: exactLengthName,
        adminPhone: '13800000005',
      });

      // INSERT users 一定被调用且 name 参数 === 32 char input
      const userInsert = clientQueryCalls.find(
        (c) => c.sql.includes('INSERT INTO') && c.sql.includes('.users'),
      );
      expect(userInsert).toBeDefined();
      expect(userInsert!.params?.[1]).toBe(exactLengthName);
    });

    it('adminName 未传 + input.admin 未传 → fallback default name (老板)', async () => {
      // input.admin.name 也未传，fallback default '老板' (3 char) 通过
      await service.provisionTenant({
        tenantId: VALID_TENANT_ID,
        name: 'demo-empty-name',
        sku: 'standard_1999',
        campuses: [{ id: VALID_CAMPUS_ID, name: '主校区' }],
        adminPhone: '13800000006',
        // adminName 不传 + input.admin 不传 → fallback '老板'
      });

      const userInsert = clientQueryCalls.find(
        (c) => c.sql.includes('INSERT INTO') && c.sql.includes('.users'),
      );
      expect(userInsert).toBeDefined();
      expect(userInsert!.params?.[1]).toBe('老板');
    });

    it('input.admin.name 33 char → 400 BadRequest', async () => {
      // 走 input.admin.name fallback 路径也校验长度
      const longName = 'b'.repeat(33);
      expect(longName.length).toBe(33);

      await expect(
        service.provisionTenant({
          tenantId: VALID_TENANT_ID,
          name: 'demo-long-admin',
          sku: 'standard_1999',
          campuses: [{ id: VALID_CAMPUS_ID, name: '主校区' }],
          admin: { id: VALID_ADMIN_ID, name: longName, phone: '13800000007' },
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ===== 既有错误路径覆盖（regression）=====
  describe('既有错误路径（regression）', () => {
    it('tenantId 长度 != 32 → 400', async () => {
      await expect(
        service.provisionTenant({
          tenantId: 'short',
          name: 'x',
          sku: 'trial',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    // Day 2 BLOCKER 2 (2026-05-19): tenantId SQL injection 防御 — 字符集白名单
    it('tenantId 长度=32 但含 SQL injection 字符 → 400 (Security C-2)', async () => {
      // 典型 multi-statement injection 载荷: `;drop table ...` (32 chars)
      const malicious = ';drop table public.tenants; --xx';
      expect(malicious.length).toBe(32);
      await expect(
        service.provisionTenant({
          tenantId: malicious,
          name: 'demo-x',
          sku: 'trial',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('tenantId 长度=32 含连字符 → 400 (Security C-2 严格 alphanum)', async () => {
      const withHyphen = 'tenantE000000000000000000000-F08';
      expect(withHyphen.length).toBe(32);
      await expect(
        service.provisionTenant({
          tenantId: withHyphen,
          name: 'demo-x',
          sku: 'trial',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('deleteTenant tenantId 含 SQL injection 字符 → 400 (Security C-2)', async () => {
      const malicious = ';drop table public.tenants; --xx';
      expect(malicious.length).toBe(32);
      await expect(service.deleteTenant(malicious)).rejects.toThrow(
        BadRequestException,
      );
      // 危险路径 DROP SCHEMA 不应执行
      const dropCall = pg.query.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('DROP SCHEMA'),
      );
      expect(dropCall).toBeUndefined();
    });

    it('deleteTenant tenantId 长度不对 → 400 (Security C-2)', async () => {
      await expect(service.deleteTenant('short')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('name 缺 → 400', async () => {
      await expect(
        service.provisionTenant({
          tenantId: VALID_TENANT_ID,
          name: '',
          sku: 'trial',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('sku 无效 → 400', async () => {
      await expect(
        service.provisionTenant({
          tenantId: VALID_TENANT_ID,
          name: 'demo-x',
          sku: 'invalid_sku' as any,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('tenant 已存在 → 409 Conflict', async () => {
      // mock pg.query 返回 existing
      pg.query.mockImplementationOnce(() =>
        Promise.resolve([{ id: VALID_TENANT_ID }]),
      );

      await expect(
        service.provisionTenant({
          tenantId: VALID_TENANT_ID,
          name: 'demo-dup',
          sku: 'trial',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('campus id 长度 != 32 → 400（不会调 INSERT）', async () => {
      await expect(
        service.provisionTenant({
          tenantId: VALID_TENANT_ID,
          name: 'demo-x',
          sku: 'trial',
          campuses: [{ id: 'short_id', name: '主校区' }],
        }),
      ).rejects.toThrow(BadRequestException);

      const campusInsert = clientQueryCalls.find(
        (c) => c.sql.includes('INSERT INTO') && c.sql.includes('.campuses'),
      );
      expect(campusInsert).toBeUndefined();
    });

    it('adminPhone 已注册 → 409 PHONE_ALREADY_REGISTERED', async () => {
      phoneLookup.lookupByPhone.mockResolvedValueOnce({
        bUsers: [
          { tenantId: 'other-tenant', userId: 'other-user', status: '启用', deletedAt: null },
        ],
        parent: null,
      });

      let caught: ConflictException | undefined;
      try {
        await service.provisionTenant({
          tenantId: VALID_TENANT_ID,
          name: 'demo-conflict',
          sku: 'trial',
          campuses: [{ id: VALID_CAMPUS_ID, name: '主校区' }],
          adminPhone: '13900000001',
          adminPassword: 'TestPwd123',
        });
      } catch (e) {
        caught = e as ConflictException;
      }
      expect(caught).toBeInstanceOf(ConflictException);
      expect(caught!.message).toContain('PHONE_ALREADY_REGISTERED');
    });

    it('adminPassword 长度 < 8 → 400', async () => {
      await expect(
        service.provisionTenant({
          tenantId: VALID_TENANT_ID,
          name: 'demo-pwd-short',
          sku: 'trial',
          campuses: [{ id: VALID_CAMPUS_ID, name: '主校区' }],
          adminPhone: '13900000002',
          adminPassword: 'short', // 5 char
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('adminPhone 格式无效 → 400', async () => {
      await expect(
        service.provisionTenant({
          tenantId: VALID_TENANT_ID,
          name: 'demo-phone-bad',
          sku: 'trial',
          campuses: [{ id: VALID_CAMPUS_ID, name: '主校区' }],
          adminPhone: '12345', // 非 1[3-9]\d{9}
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
