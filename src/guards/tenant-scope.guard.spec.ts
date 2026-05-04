import { ForbiddenException, UnauthorizedException, ExecutionContext } from '@nestjs/common';
import { TenantScopeGuard } from './tenant-scope.guard';

describe('TenantScopeGuard', () => {
  let guard: TenantScopeGuard;

  beforeEach(() => {
    guard = new TenantScopeGuard();
  });

  /** 构造模拟 ExecutionContext */
  const ctx = (req: any): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => req }),
    }) as ExecutionContext;

  describe('user 缺失', () => {
    it('throws Unauthorized when req.user is missing', () => {
      expect(() => guard.canActivate(ctx({ headers: {} }))).toThrow(UnauthorizedException);
    });
  });

  describe('platform role 越权', () => {
    it('platform_admin 可跨 tenant', () => {
      const req = {
        user: { sub: 'u1', tenantId: null, role: 'platform_admin', campusId: null },
        body: { tenantId: 'OTHER_TENANT_ID_XXXXXXXXXXXXXXXX' },
        query: {},
        headers: {},
      };
      expect(guard.canActivate(ctx(req))).toBe(true);
    });

    it('finance_admin 可跨 tenant', () => {
      const req = {
        user: { sub: 'u1', tenantId: null, role: 'finance_admin', campusId: null },
        body: { tenantId: 'A' },
        query: {},
        headers: {},
      };
      expect(guard.canActivate(ctx(req))).toBe(true);
    });
  });

  describe('普通租户角色 · tenantId 一致性', () => {
    const baseUser = {
      sub: 'u1',
      tenantId: 'TENANTA00000000000000000000000A1',
      role: 'admin',
      campusId: 'C1',
    };
    const TENANT_A = 'TENANTA00000000000000000000000A1';
    const TENANT_B = 'TENANTB00000000000000000000000B1';

    it('body.tenantId 与 JWT 一致 → 放行', () => {
      const req = {
        user: baseUser,
        body: { tenantId: TENANT_A },
        query: {},
        headers: {},
      };
      expect(guard.canActivate(ctx(req))).toBe(true);
    });

    it('body.tenantId 不一致 → 403', () => {
      const req = {
        user: baseUser,
        body: { tenantId: TENANT_B },
        query: {},
        headers: {},
      };
      expect(() => guard.canActivate(ctx(req))).toThrow(ForbiddenException);
    });

    it('query.tenantId 不一致 → 403', () => {
      const req = {
        user: baseUser,
        body: {},
        query: { tenantId: TENANT_B },
        headers: {},
      };
      expect(() => guard.canActivate(ctx(req))).toThrow(ForbiddenException);
    });

    it('x-tenant-schema 与 user.tenantId 派生一致 → 放行', () => {
      const req = {
        user: baseUser,
        body: {},
        query: {},
        headers: { 'x-tenant-schema': `tenant_${TENANT_A.toLowerCase()}` },
      };
      expect(guard.canActivate(ctx(req))).toBe(true);
    });

    it('x-tenant-schema 不一致 → 403', () => {
      const req = {
        user: baseUser,
        body: {},
        query: {},
        headers: { 'x-tenant-schema': `tenant_${TENANT_B.toLowerCase()}` },
      };
      expect(() => guard.canActivate(ctx(req))).toThrow(ForbiddenException);
    });

    it('什么 tenantId 都没传 → 放行（controller 自处理）', () => {
      const req = {
        user: baseUser,
        body: {},
        query: {},
        headers: {},
      };
      expect(guard.canActivate(ctx(req))).toBe(true);
    });

    it('普通角色 tenantId=null → 403', () => {
      const req = {
        user: { ...baseUser, tenantId: null },
        body: {},
        query: {},
        headers: {},
      };
      expect(() => guard.canActivate(ctx(req))).toThrow(ForbiddenException);
    });

    it('attempt 同时传 body+header 都对 → 放行', () => {
      const req = {
        user: baseUser,
        body: { tenantId: TENANT_A },
        query: {},
        headers: { 'x-tenant-schema': `tenant_${TENANT_A.toLowerCase()}` },
      };
      expect(guard.canActivate(ctx(req))).toBe(true);
    });

    it('body 对但 header 错 → 403（任一不一致就拒）', () => {
      const req = {
        user: baseUser,
        body: { tenantId: TENANT_A },
        query: {},
        headers: { 'x-tenant-schema': `tenant_${TENANT_B.toLowerCase()}` },
      };
      expect(() => guard.canActivate(ctx(req))).toThrow(ForbiddenException);
    });
  });
});
