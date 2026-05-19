/**
 * OnboardingController — Sprint E.x F-08 server-side msgSecCheck 集成单测
 *
 * 范围（F-08）：
 *   - provisionTenant: 自由文本字段（name / campus.name / campus.address / campus.courseLines）
 *     全部走 SecurityService.serverSideCheckContent
 *   - 任一字段命中 87014 risky → BadRequest CONTENT_RISKY，不进 provision.provisionTenant
 *   - review / 网络异常 → fail-open，注册继续
 *   - 不返微信内部 errcode（A05 内部 ID 暴露规避）
 *
 * Day 2 BLOCKER 1 + 2 (2026-05-19): 生产门卫 + SQL injection 防御
 *   - DELETE /api/public/onboarding/tenants/:id 生产环境 403
 *   - GET /api/public/onboarding/tenants 生产环境 403
 *   - DELETE tenantId 字符集白名单（防 SQL injection）
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  OnboardingController,
  OnboardingDbController,
} from './onboarding.controller';
import { TenantProvisionService } from './tenant-provision.service';
import { PgPoolService } from './pg-pool.service';
import { SecurityService } from '../security/security.service';
import { AuditLogRepository } from './audit-log.repository';
import type { AuthenticatedRequest } from '../auth/jwt-payload.interface';

describe('OnboardingController (Sprint E.x F-08 msgSecCheck)', () => {
  let controller: OnboardingController;
  let provision: { provisionTenant: jest.Mock; listTenants: jest.Mock; deleteTenant: jest.Mock };
  let pg: { ping: jest.Mock };
  let security: { serverSideCheckContent: jest.Mock };

  const VALID_TENANT_ID = 'tenantE0000000000000000000000F08';
  const VALID_CAMPUS_ID = 'campusE0000000000000000000000F08';

  function makeBody(overrides: Partial<Parameters<OnboardingController['provisionTenant']>[0]> = {}) {
    return {
      tenantId: VALID_TENANT_ID,
      name: '阳光教育培训中心',
      sku: 'standard_1999' as const,
      campuses: [
        {
          id: VALID_CAMPUS_ID,
          name: '主校区',
          address: '北京市朝阳区某路 100 号',
          courseLines: '语文,数学,英语',
        },
      ],
      ...overrides,
    };
  }

  beforeEach(() => {
    provision = {
      provisionTenant: jest.fn().mockResolvedValue({
        tenantId: VALID_TENANT_ID,
        tenantSchema: `tenant_${VALID_TENANT_ID.toLowerCase()}`,
        ranMigrations: ['V2', 'V4'],
        campusIds: [VALID_CAMPUS_ID],
      }),
      listTenants: jest.fn(),
      deleteTenant: jest.fn(),
    };
    pg = { ping: jest.fn() };
    security = {
      // 默认所有 check 通过
      serverSideCheckContent: jest.fn().mockResolvedValue({
        ok: true,
        suggest: 'pass',
        errcode: 0,
      }),
    };

    controller = new OnboardingController(
      provision as unknown as TenantProvisionService,
      pg as unknown as PgPoolService,
      security as unknown as SecurityService,
    );
  });

  describe('provisionTenant 自由文本预检', () => {
    it('happy path 全部通过 → 调 provision 并返回结果', async () => {
      const body = makeBody();
      const res = await controller.provisionTenant(body);

      // 4 个文本字段全部 check（name + 1 campus.name + 1 address + 1 courseLines）
      expect(security.serverSideCheckContent).toHaveBeenCalledTimes(4);
      expect(security.serverSideCheckContent).toHaveBeenNthCalledWith(1, '阳光教育培训中心');
      expect(security.serverSideCheckContent).toHaveBeenNthCalledWith(2, '主校区');
      expect(security.serverSideCheckContent).toHaveBeenNthCalledWith(3, '北京市朝阳区某路 100 号');
      expect(security.serverSideCheckContent).toHaveBeenNthCalledWith(4, '语文,数学,英语');

      expect(provision.provisionTenant).toHaveBeenCalledWith(body);
      expect(res.tenantId).toBe(VALID_TENANT_ID);
    });

    it('body.name 违规 87014 → 400 CONTENT_RISKY，不进 provision', async () => {
      // 所有 4 个字段 check：mockResolvedValue（非 Once）让所有调用都返 risky
      // 由于 name 是第 1 个 check 字段，risky 抛错后短路，后续不再 check
      security.serverSideCheckContent.mockResolvedValueOnce({
        ok: false,
        suggest: 'risky',
        label: '内容含违法违规',
        errcode: 87014,
      });

      const body = makeBody({ name: '违规机构名示例' });

      let caught: BadRequestException | undefined;
      try {
        await controller.provisionTenant(body);
      } catch (err) {
        caught = err as BadRequestException;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      expect(caught?.getResponse()).toMatchObject({
        code: 'CONTENT_RISKY',
        suggest: 'risky',
      });
      // A05: 不返微信内部 errcode 给 client
      const response = caught?.getResponse() as { errcode?: number };
      expect(response.errcode).toBeUndefined();
      expect(provision.provisionTenant).not.toHaveBeenCalled();
    });

    it('campus.address 违规 → 400 CONTENT_RISKY，不进 provision', async () => {
      // 1: name pass, 2: campus.name pass, 3: campus.address risky
      security.serverSideCheckContent
        .mockResolvedValueOnce({ ok: true, suggest: 'pass' })
        .mockResolvedValueOnce({ ok: true, suggest: 'pass' })
        .mockResolvedValueOnce({
          ok: false,
          suggest: 'risky',
          label: '内容含违法违规',
          errcode: 87014,
        });

      const body = makeBody({
        campuses: [
          { id: VALID_CAMPUS_ID, name: '主校区', address: '违规地址' },
        ],
      });
      await expect(controller.provisionTenant(body)).rejects.toThrow(BadRequestException);
      expect(provision.provisionTenant).not.toHaveBeenCalled();
    });

    it('campus.name 违规 → 400 CONTENT_RISKY', async () => {
      // 1: name pass, 2: campus.name risky
      security.serverSideCheckContent
        .mockResolvedValueOnce({ ok: true, suggest: 'pass' })
        .mockResolvedValueOnce({
          ok: false,
          suggest: 'risky',
          errcode: 87014,
        });

      const body = makeBody({
        campuses: [{ id: VALID_CAMPUS_ID, name: '违规校区名' }],
      });
      await expect(controller.provisionTenant(body)).rejects.toThrow(BadRequestException);
      expect(provision.provisionTenant).not.toHaveBeenCalled();
    });

    it('suggest=review → fail-open，继续 provision', async () => {
      security.serverSideCheckContent.mockResolvedValue({
        ok: false,
        suggest: 'review',
        errcode: 40001,
      });

      const body = makeBody();
      const res = await controller.provisionTenant(body);

      expect(provision.provisionTenant).toHaveBeenCalledWith(body);
      expect(res.tenantId).toBe(VALID_TENANT_ID);
    });

    it('微信 access_token 失败抛 → fail-open，继续 provision', async () => {
      security.serverSideCheckContent.mockRejectedValueOnce(
        new Error('WX_TOKEN_FAILED'),
      );

      const body = makeBody();
      await expect(controller.provisionTenant(body)).resolves.toBeDefined();
      expect(provision.provisionTenant).toHaveBeenCalledWith(body);
    });

    it('campuses 缺省 → 仅 check body.name', async () => {
      const body = makeBody({ campuses: undefined });
      await controller.provisionTenant(body);

      expect(security.serverSideCheckContent).toHaveBeenCalledTimes(1);
      expect(security.serverSideCheckContent).toHaveBeenCalledWith('阳光教育培训中心');
      expect(provision.provisionTenant).toHaveBeenCalledWith(body);
    });

    it('campus.address / courseLines 空字符串 → 跳过（不调 security）', async () => {
      const body = makeBody({
        campuses: [{ id: VALID_CAMPUS_ID, name: '主校区', address: '', courseLines: '' }],
      });
      await controller.provisionTenant(body);

      // 2 calls: name + campus.name（address / courseLines 空字符串跳过）
      expect(security.serverSideCheckContent).toHaveBeenCalledTimes(2);
    });

    it('body.name 空白 trim → 不调 security 该字段', async () => {
      const body = makeBody({ name: '   ' });
      // name 空白被 trim 后跳过，campus 3 字段
      await controller.provisionTenant(body);
      expect(security.serverSideCheckContent).toHaveBeenCalledTimes(3);
    });

    it('多 campus 全部 check', async () => {
      const body = makeBody({
        campuses: [
          { id: VALID_CAMPUS_ID, name: '主校区', address: '北京', courseLines: '语数英' },
          { id: 'campusF0000000000000000000000F09', name: '分校区', address: '上海' },
        ],
      });
      await controller.provisionTenant(body);

      // 1 (name) + 3 (主校区 / 北京 / 语数英) + 2 (分校区 / 上海) = 6
      expect(security.serverSideCheckContent).toHaveBeenCalledTimes(6);
    });

    // F-08 round 2 (business validator P2): 补 body.name undefined null guard 覆盖
    it('body.name undefined → 跳过 name check，仅 check campus 字段', async () => {
      // 构造 body 但 name 为 undefined（绕过 makeBody 默认值，直接传 undefined）
      const body = {
        tenantId: 'mxedu_TEST_NO_NAME_00000000000001',
        // name 字段故意省略 → undefined
        sku: 'standard_1999' as const,
        campuses: [
          { id: VALID_CAMPUS_ID, name: '主校区', address: '北京', courseLines: '语数英' },
        ],
      };
      await controller.provisionTenant(body as never);

      // body.name undefined → 跳过 → 仅 check 主校区 3 字段 (name/address/courseLines)
      expect(security.serverSideCheckContent).toHaveBeenCalledTimes(3);
      expect(security.serverSideCheckContent).not.toHaveBeenCalledWith(
        expect.stringContaining('undefined'),
      );
    });

    // F-08 round 2 (business validator P1): 校验 @Throttle + campuses 上限
    it('campuses 超 20 → 400 TOO_MANY_CAMPUSES (DoS amplification 防护)', async () => {
      const tooManyCampuses = Array.from({ length: 21 }, (_, i) => ({
        id: `campus${String(i).padStart(28, '0')}`,
        name: `校区${i}`,
      }));
      const body = makeBody({ campuses: tooManyCampuses });

      await expect(controller.provisionTenant(body)).rejects.toThrow(BadRequestException);
      // 应在调 security 之前抛错（短路）
      expect(security.serverSideCheckContent).not.toHaveBeenCalled();
      expect(provision.provisionTenant).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // Day 2 BLOCKER 1 + 2 (2026-05-19): 生产门卫 + SQL injection 防御
  // ============================================================
  describe('listTenants() / deleteTenant() — 生产门卫 + 字符集校验', () => {
    // beforeEach/afterEach: restore NODE_ENV between tests (jest worker shared)
    const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
    afterEach(() => {
      if (ORIGINAL_NODE_ENV === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = ORIGINAL_NODE_ENV;
      }
    });

    it('listTenants 生产环境 → 403 ForbiddenException (Security C-1 + Prod P1-1)', async () => {
      process.env.NODE_ENV = 'production';
      await expect(controller.listTenants()).rejects.toThrow(ForbiddenException);
      // 真实 service 不应被调用
      expect(provision.listTenants).not.toHaveBeenCalled();
    });

    it('listTenants 测试环境 → 放行（CI / docker-compose 仍可用）', async () => {
      process.env.NODE_ENV = 'test';
      provision.listTenants.mockResolvedValueOnce([]);
      await expect(controller.listTenants()).resolves.toEqual([]);
      expect(provision.listTenants).toHaveBeenCalledTimes(1);
    });

    it('listTenants 开发环境 → 放行', async () => {
      process.env.NODE_ENV = 'development';
      provision.listTenants.mockResolvedValueOnce([]);
      await expect(controller.listTenants()).resolves.toEqual([]);
      expect(provision.listTenants).toHaveBeenCalledTimes(1);
    });

    it('deleteTenant 生产环境 → 403 ForbiddenException (Security C-1 + Prod P1-1)', async () => {
      process.env.NODE_ENV = 'production';
      await expect(controller.deleteTenant(VALID_TENANT_ID)).rejects.toThrow(
        ForbiddenException,
      );
      // 真实 service 不应被调用（绝不允许生产 DROP）
      expect(provision.deleteTenant).not.toHaveBeenCalled();
    });

    it('deleteTenant 测试环境 + 合法 tenantId → 调 service', async () => {
      process.env.NODE_ENV = 'test';
      provision.deleteTenant.mockResolvedValueOnce(undefined);
      const res = await controller.deleteTenant(VALID_TENANT_ID);
      expect(res).toEqual({ ok: true });
      expect(provision.deleteTenant).toHaveBeenCalledWith(VALID_TENANT_ID);
    });

    it('deleteTenant 非生产 + tenantId 含 SQL injection 字符 → 400 (Security C-2)', async () => {
      process.env.NODE_ENV = 'test';
      // 32-char 但含分号 + 空格（典型 multi-statement injection 载荷）
      const malicious = ";drop table public.tenants; --xx";
      expect(malicious.length).toBe(32); // 长度 32 但字符集非 alphanum
      await expect(controller.deleteTenant(malicious)).rejects.toThrow(
        BadRequestException,
      );
      expect(provision.deleteTenant).not.toHaveBeenCalled();
    });

    it('deleteTenant 非生产 + tenantId 长度不对 → 400 (Security C-2)', async () => {
      process.env.NODE_ENV = 'test';
      await expect(controller.deleteTenant('short')).rejects.toThrow(
        BadRequestException,
      );
      expect(provision.deleteTenant).not.toHaveBeenCalled();
    });

    it('deleteTenant 非生产 + tenantId 含特殊字符 -_ → 400 (Security C-2 严格 alphanum)', async () => {
      process.env.NODE_ENV = 'test';
      // 32 字符但含连字符（ULID 不应含 -）
      const withHyphen = 'tenantE000000000000000000000-F08';
      expect(withHyphen.length).toBe(32);
      await expect(controller.deleteTenant(withHyphen)).rejects.toThrow(
        BadRequestException,
      );
      expect(provision.deleteTenant).not.toHaveBeenCalled();
    });
  });
});

// ============================================================
// T9-EPIC(2026-05-16) §6.2：OnboardingDbController.startTrial
// ============================================================
describe('OnboardingDbController.startTrial (T9-EPIC §6.2)', () => {
  const VALID_TENANT_ID = 'tenantT9000000000000000000000001';
  const VALID_SCHEMA = `tenant_${VALID_TENANT_ID.toLowerCase()}`;
  const VALID_USER_ID = 'usrT900000000000000000000000ADM1';

  let controller: OnboardingDbController;
  let audit: { log: jest.Mock };

  function makeReq(): AuthenticatedRequest {
    return {
      user: {
        sub: VALID_USER_ID,
        role: 'admin',
        tenantId: VALID_TENANT_ID,
        campusId: null,
      },
      headers: { 'user-agent': 'jest-test', 'x-request-id': 'rid-T9-1' },
      ip: '1.2.3.4',
    } as AuthenticatedRequest;
  }

  beforeEach(() => {
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    controller = new OnboardingDbController(
      audit as unknown as AuditLogRepository,
    );
  });

  it('happy path → audit_log 写 trial.started + 返 { ok: true }', async () => {
    const req = makeReq();
    const res = await controller.startTrial(req, {
      tenantId: VALID_TENANT_ID,
      tenantSchema: VALID_SCHEMA,
    });
    expect(res).toEqual({ ok: true });
    expect(audit.log).toHaveBeenCalledWith(
      VALID_SCHEMA,
      expect.objectContaining({
        actorUserId: VALID_USER_ID,
        actorRole: 'admin',
        action: 'tenant.subscription.trial.started',
        targetType: 'tenant',
        targetId: VALID_TENANT_ID,
        before: null,
        after: { subscription_status: 'trial' },
        ip: '1.2.3.4',
        userAgent: 'jest-test',
        requestId: 'rid-T9-1',
      }),
    );
  });

  it('tenantId 非 32-char → 400', async () => {
    const req = makeReq();
    await expect(
      controller.startTrial(req, {
        tenantId: 'short',
        tenantSchema: VALID_SCHEMA,
      }),
    ).rejects.toThrow(BadRequestException);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('tenantSchema 不以 tenant_ 开头 → 400', async () => {
    const req = makeReq();
    await expect(
      controller.startTrial(req, {
        tenantId: VALID_TENANT_ID,
        tenantSchema: 'public',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('audit_log 内部 fail-open（log 抛错被 repository 内部 catch，本 endpoint 不感知）', async () => {
    // 真实 AuditLogRepository.log 内部 try/catch；spec 模拟 log resolve（即使内部失败）
    const req = makeReq();
    await expect(
      controller.startTrial(req, {
        tenantId: VALID_TENANT_ID,
        tenantSchema: VALID_SCHEMA,
      }),
    ).resolves.toEqual({ ok: true });
    expect(audit.log).toHaveBeenCalledTimes(1);
  });
});
