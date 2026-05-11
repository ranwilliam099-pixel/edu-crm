import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { TenantMiddleware } from './tenant.middleware';
import { JwtStrategy } from './jwt.strategy';
import { ParentJwtStrategy } from './parent-jwt.strategy';
import { ParentRepository } from '../db/parent.repository';
import { AuditLogRepository } from '../db/audit-log.repository';

const TEST_SECRET = 'test-secret';

describe('TenantMiddleware (W1 BE-W1-4 routing分发)', () => {
  let middleware: TenantMiddleware;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: TEST_SECRET })],
      providers: [
        TenantMiddleware,
        JwtStrategy,
        ParentJwtStrategy,
        { provide: ConfigService, useValue: { get: (k: string) => (k === 'JWT_SECRET' ? TEST_SECRET : undefined) } },
      ],
    }).compile();
    middleware = module.get<TenantMiddleware>(TenantMiddleware);
  });

  function makeReq(originalUrl: string, headers: Record<string, string> = {}): any {
    return { originalUrl, url: originalUrl, path: originalUrl, headers };
  }

  describe('public path resolution (regression: 实测 2026-04-30 401 缺陷)', () => {
    it('passes /api/public/health without Authorization', async () => {
      const req = makeReq('/api/public/health');
      await new Promise<void>((resolve) => {
        middleware.use(req, {} as any, () => resolve());
      });
    });

    it('passes /api/public/health?ts=1 (strips query string)', async () => {
      const req = makeReq('/api/public/health?ts=1');
      await new Promise<void>((resolve) => {
        middleware.use(req, {} as any, () => resolve());
      });
    });

    it('passes /api/checkout/anything without Authorization', async () => {
      const req = makeReq('/api/checkout/orders');
      await new Promise<void>((resolve) => {
        middleware.use(req, {} as any, () => resolve());
      });
    });
  });

  describe('admin path enforcement', () => {
    // 2026-05-11: middleware.use 改为 async 后, 同步 throw → rejected Promise
    it('rejects /api/admin/* without Authorization', async () => {
      const req = makeReq('/api/admin/tenants');
      await expect(middleware.use(req, {} as any, () => {})).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('default path (business)', () => {
    it('rejects /api/leads without Authorization', async () => {
      const req = makeReq('/api/leads');
      await expect(middleware.use(req, {} as any, () => {})).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });
});

/**
 * SECURITY-FIX 2026-05-11 (A01-CRIT P0): Parent JWT 跨租户循环验证漏洞修复
 *
 * 攻击场景:
 *   家长 P 持合法 ParentJwt, 仅订阅 tenant A.
 *   P 调用 POST /api/db/monthly-reports/:id/find { tenantSchema: 'tenant_b' }
 *   旧逻辑: requireParentDbUser 信任 body.tenantSchema 派生 tenantId=B 挂 req.user,
 *          TenantScopeGuard 比对 body=B vs user=B 自循环验证通过 → 越权读 tenant B 数据.
 *
 * 修复后:
 *   - 查 public.parent_student_bindings WHERE parent_id=P AND binding_status='active'
 *     拿到 allowedTenantIds (= [A]).
 *   - body.tenantSchema=tenant_b 派生 requestedTenantId=B, 不在 allowedTenantIds → 403.
 *   - 写 audit_log action='parent.cross-tenant-denied'.
 */
describe('TenantMiddleware A01-CRIT P0 Parent x Tenant 绑定校验', () => {
  const PARENT_ID = 'p00000000000000000000000000000A1';
  const STUDENT_ID = 'stu000000000000000000000000000A1';
  const TENANT_A = 'tenanta00000000000000000000000a1';
  const TENANT_B = 'tenantb00000000000000000000000b1';

  let middleware: TenantMiddleware;
  let parentRepo: { findChildrenByParent: jest.Mock };
  let auditLog: { log: jest.Mock };
  let parentJwt: ParentJwtStrategy;

  beforeEach(async () => {
    parentRepo = { findChildrenByParent: jest.fn() };
    auditLog = { log: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: TEST_SECRET })],
      providers: [
        TenantMiddleware,
        JwtStrategy,
        ParentJwtStrategy,
        {
          provide: ConfigService,
          useValue: {
            get: (k: string) => (k === 'JWT_SECRET' ? TEST_SECRET : undefined),
          },
        },
        { provide: ParentRepository, useValue: parentRepo },
        { provide: AuditLogRepository, useValue: auditLog },
      ],
    }).compile();
    middleware = module.get<TenantMiddleware>(TenantMiddleware);
    parentJwt = module.get<ParentJwtStrategy>(ParentJwtStrategy);
  });

  function makeParentReq(
    originalUrl: string,
    parentToken: string,
    body: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ): any {
    return {
      originalUrl,
      url: originalUrl,
      path: originalUrl,
      method: 'POST',
      headers: {
        authorization: `Bearer ${parentToken}`,
        ...headers,
      },
      ip: '1.2.3.4',
      body,
    };
  }

  it('parent JWT + 绑定的 tenant → 放行 + req.user 挂上 parent 信息', async () => {
    parentRepo.findChildrenByParent.mockResolvedValueOnce([
      {
        id: 'bind000000000000000000000000A1',
        parentId: PARENT_ID,
        studentId: STUDENT_ID,
        tenantId: TENANT_A,
        isPrimary: true,
        relationship: 'mother',
        bindingStatus: 'active',
        boundAt: new Date(),
      },
    ]);

    const token = parentJwt.sign({ parentId: PARENT_ID });
    const req = makeParentReq(
      `/api/db/students/${STUDENT_ID}/monthly-reports`,
      token,
      { tenantSchema: `tenant_${TENANT_A}` },
    );

    await new Promise<void>((resolve, reject) => {
      middleware.use(req, {} as any, (err?: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });

    expect(parentRepo.findChildrenByParent).toHaveBeenCalledWith(PARENT_ID);
    expect(req.user).toEqual({
      sub: PARENT_ID,
      tenantId: TENANT_A,
      role: 'parent',
      campusId: null,
    });
    expect(req.parent).toMatchObject({ parentId: PARENT_ID, role: 'parent' });
    expect(req.tenantSchema).toBe(`tenant_${TENANT_A}`);
    // 合法路径不应写 cross-tenant-denied audit_log
    expect(auditLog.log).not.toHaveBeenCalled();
  });

  it('A01-CRIT: parent JWT + 错误 tenantSchema → ForbiddenException + 不挂 req.user.tenantId=B', async () => {
    // parent 只绑了 tenant A
    parentRepo.findChildrenByParent.mockResolvedValueOnce([
      {
        id: 'bind000000000000000000000000A1',
        parentId: PARENT_ID,
        studentId: STUDENT_ID,
        tenantId: TENANT_A,
        isPrimary: true,
        relationship: 'mother',
        bindingStatus: 'active',
        boundAt: new Date(),
      },
    ]);

    const token = parentJwt.sign({ parentId: PARENT_ID });
    const req = makeParentReq(
      `/api/db/students/${STUDENT_ID}/monthly-reports`,
      token,
      // 攻击: 客户端传 tenant B (不是 parent 绑定的 tenant A)
      { tenantSchema: `tenant_${TENANT_B}` },
    );

    await expect(
      middleware.use(req, {} as any, () => {}),
    ).rejects.toThrow(ForbiddenException);

    // req.user 不应被错误挂上 — 保证 controller 拿不到攻击者期望的 tenant 上下文
    expect(req.user).toBeUndefined();
    // audit_log 应记一条 cross-tenant-denied (写到 parent 已绑定的 tenant_a)
    expect(auditLog.log).toHaveBeenCalledTimes(1);
    const [schema, entry] = auditLog.log.mock.calls[0];
    expect(schema).toBe(`tenant_${TENANT_A}`);
    expect(entry.action).toBe('parent.cross-tenant-denied');
    expect(entry.actorUserId).toBe(PARENT_ID);
    expect(entry.actorRole).toBe('parent');
    expect(entry.targetType).toBe('tenant');
    expect(entry.targetId).toBe(TENANT_B);
    expect(entry.after).toMatchObject({
      requestedTenant: TENANT_B,
      allowedTenants: [TENANT_A],
    });
  });

  it('A01-CRIT: parent JWT + 无任何 active binding → ForbiddenException + 不写 audit_log (无合法 schema 可写)', async () => {
    parentRepo.findChildrenByParent.mockResolvedValueOnce([]);

    const token = parentJwt.sign({ parentId: PARENT_ID });
    const req = makeParentReq(
      `/api/db/students/${STUDENT_ID}/monthly-reports`,
      token,
      { tenantSchema: `tenant_${TENANT_A}` },
    );

    await expect(
      middleware.use(req, {} as any, () => {}),
    ).rejects.toThrow(ForbiddenException);

    // 没绑过任何 tenant → 没合法 schema 写 audit_log → 不写
    expect(auditLog.log).not.toHaveBeenCalled();
  });

  it('A01-CRIT: parent JWT + unbound 状态 binding (历史已解绑) → 视为未绑定 → 403', async () => {
    parentRepo.findChildrenByParent.mockResolvedValueOnce([
      {
        id: 'bind000000000000000000000000A1',
        parentId: PARENT_ID,
        studentId: STUDENT_ID,
        tenantId: TENANT_A,
        isPrimary: false,
        relationship: 'mother',
        bindingStatus: 'unbound', // 已解绑
        boundAt: new Date(),
        unboundAt: new Date(),
      },
    ]);

    const token = parentJwt.sign({ parentId: PARENT_ID });
    const req = makeParentReq(
      `/api/db/students/${STUDENT_ID}/monthly-reports`,
      token,
      { tenantSchema: `tenant_${TENANT_A}` },
    );

    await expect(
      middleware.use(req, {} as any, () => {}),
    ).rejects.toThrow(ForbiddenException);
  });

  it('A01-CRIT: parent JWT + 缺失 body.tenantSchema → UnauthorizedException (旧行为保留)', async () => {
    const token = parentJwt.sign({ parentId: PARENT_ID });
    const req = makeParentReq(
      `/api/db/students/${STUDENT_ID}/monthly-reports`,
      token,
      {}, // 无 tenantSchema
    );

    await expect(
      middleware.use(req, {} as any, () => {}),
    ).rejects.toThrow(UnauthorizedException);
    // 无 schema → 还没到 DB 校验 → parentRepo 不应被调用
    expect(parentRepo.findChildrenByParent).not.toHaveBeenCalled();
  });

  it('A01-CRIT: parent JWT + 多 tenant 绑定 (跨机构家长共享) → 任一 tenant 都放行', async () => {
    parentRepo.findChildrenByParent.mockResolvedValueOnce([
      {
        id: 'bind000000000000000000000000A1',
        parentId: PARENT_ID,
        studentId: STUDENT_ID,
        tenantId: TENANT_A,
        isPrimary: true,
        relationship: 'mother',
        bindingStatus: 'active',
        boundAt: new Date(),
      },
      {
        id: 'bind000000000000000000000000B1',
        parentId: PARENT_ID,
        studentId: 'stu000000000000000000000000000B1',
        tenantId: TENANT_B,
        isPrimary: false,
        relationship: 'mother',
        bindingStatus: 'active',
        boundAt: new Date(),
      },
    ]);

    const token = parentJwt.sign({ parentId: PARENT_ID });
    const req = makeParentReq(
      `/api/db/students/stu000000000000000000000000000B1/monthly-reports`,
      token,
      { tenantSchema: `tenant_${TENANT_B}` },
    );

    await new Promise<void>((resolve, reject) => {
      middleware.use(req, {} as any, (err?: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });

    expect(req.user.tenantId).toBe(TENANT_B);
    expect(req.tenantSchema).toBe(`tenant_${TENANT_B}`);
    expect(auditLog.log).not.toHaveBeenCalled();
  });

  it('A01-CRIT: parent JWT + parentRepo DB 抛异常 → fail-close ForbiddenException', async () => {
    parentRepo.findChildrenByParent.mockRejectedValueOnce(new Error('PG connection lost'));

    const token = parentJwt.sign({ parentId: PARENT_ID });
    const req = makeParentReq(
      `/api/db/students/${STUDENT_ID}/monthly-reports`,
      token,
      { tenantSchema: `tenant_${TENANT_A}` },
    );

    // 注意: 此处选择 fail-close (拒绝放行), 不是 fail-open
    // 因为这是跨租户隔离硬红线, DB 不可用时宁可拒绝合法请求, 也不放行可疑请求
    await expect(
      middleware.use(req, {} as any, () => {}),
    ).rejects.toThrow(ForbiddenException);
  });

  it('A01-CRIT: ParentRepository 未注入 (test legacy 模式) → fallback 旧行为 + WARN', async () => {
    // 模拟旧测试环境 (DbModule 未导入 — TenantMiddleware unit test 也走这个路径)
    const moduleNoRepo: TestingModule = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: TEST_SECRET })],
      providers: [
        TenantMiddleware,
        JwtStrategy,
        ParentJwtStrategy,
        {
          provide: ConfigService,
          useValue: {
            get: (k: string) => (k === 'JWT_SECRET' ? TEST_SECRET : undefined),
          },
        },
        // 故意不注入 ParentRepository / AuditLogRepository
      ],
    }).compile();
    const mw = moduleNoRepo.get<TenantMiddleware>(TenantMiddleware);
    const pj = moduleNoRepo.get<ParentJwtStrategy>(ParentJwtStrategy);

    const token = pj.sign({ parentId: PARENT_ID });
    const req = makeParentReq(
      `/api/db/students/${STUDENT_ID}/monthly-reports`,
      token,
      { tenantSchema: `tenant_${TENANT_A}` },
    );

    // fallback 旧行为放行 (避免破坏现有 unit test, 但生产 DbModule @Global 必注入)
    await new Promise<void>((resolve, reject) => {
      mw.use(req, {} as any, (err?: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });

    expect(req.user.tenantId).toBe(TENANT_A);
  });
});
