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

  // ============================================================
  // Sprint B (2026-05-11) — body.tenantSchema 校验（P0 CRITICAL 补漏）
  // ============================================================
  describe('Sprint B: body.tenantSchema 校验（核心安全修复）', () => {
    const baseUser = {
      sub: 'u1',
      tenantId: 'TENANTA00000000000000000000000A1',
      role: 'admin',
      campusId: 'C1',
    };
    const TENANT_A = 'TENANTA00000000000000000000000A1';
    const TENANT_B = 'TENANTB00000000000000000000000B1';
    const SCHEMA_A = `tenant_${TENANT_A.toLowerCase()}`;
    const SCHEMA_B = `tenant_${TENANT_B.toLowerCase()}`;

    it('admin_A + body.tenantSchema=tenant_B → 403 (核心审计案例)', () => {
      const req = {
        user: baseUser,
        body: { tenantSchema: SCHEMA_B },
        query: {},
        headers: {},
      };
      expect(() => guard.canActivate(ctx(req))).toThrow(ForbiddenException);
    });

    it('admin_A + body.tenantSchema=tenant_A (派生自 user.tenantId) → 放行', () => {
      const req = {
        user: baseUser,
        body: { tenantSchema: SCHEMA_A },
        query: {},
        headers: {},
      };
      expect(guard.canActivate(ctx(req))).toBe(true);
    });

    it('单 body.tenantId 无 tenantSchema → 走旧行为 (放行)', () => {
      const req = {
        user: baseUser,
        body: { tenantId: TENANT_A },
        query: {},
        headers: {},
      };
      expect(guard.canActivate(ctx(req))).toBe(true);
    });

    it('单 x-tenant-schema header (无 body.tenantSchema) → 走旧行为', () => {
      const req = {
        user: baseUser,
        body: {},
        query: {},
        headers: { 'x-tenant-schema': SCHEMA_A },
      };
      expect(guard.canActivate(ctx(req))).toBe(true);
    });

    it('body.tenantId 一致 + body.tenantSchema 不一致 → 403 (任一不一致就拒)', () => {
      const req = {
        user: baseUser,
        body: { tenantId: TENANT_A, tenantSchema: SCHEMA_B },
        query: {},
        headers: {},
      };
      expect(() => guard.canActivate(ctx(req))).toThrow(ForbiddenException);
    });

    it('body.tenantSchema 大写归一化 → 与 user.tenantId.toLowerCase() 比对', () => {
      // body 传大写 schema，应归一化后通过校验
      const req = {
        user: baseUser,
        body: { tenantSchema: `TENANT_${TENANT_A.toLowerCase()}` },
        query: {},
        headers: {},
      };
      expect(guard.canActivate(ctx(req))).toBe(true);
    });

    it('body.tenantSchema=null → 不参与校验 (兼容旧调用)', () => {
      const req = {
        user: baseUser,
        body: { tenantSchema: null },
        query: {},
        headers: {},
      };
      expect(guard.canActivate(ctx(req))).toBe(true);
    });

    it('query.tenantSchema 不一致 → 403 (与 body.tenantSchema 对称)', () => {
      const req = {
        user: baseUser,
        body: {},
        query: { tenantSchema: SCHEMA_B },
        headers: {},
      };
      expect(() => guard.canActivate(ctx(req))).toThrow(ForbiddenException);
    });

    it('query.tenantSchema 一致 → 放行', () => {
      const req = {
        user: baseUser,
        body: {},
        query: { tenantSchema: SCHEMA_A },
        headers: {},
      };
      expect(guard.canActivate(ctx(req))).toBe(true);
    });

    it('platform_admin + body.tenantSchema=tenant_B → 放行 (平台角色跨租户合法)', () => {
      const req = {
        user: { sub: 'u1', tenantId: null, role: 'platform_admin', campusId: null },
        body: { tenantSchema: SCHEMA_B },
        query: {},
        headers: {},
      };
      expect(guard.canActivate(ctx(req))).toBe(true);
    });

    it('body.tenantSchema + x-tenant-schema 都对 → 放行 (三重校验全过)', () => {
      const req = {
        user: baseUser,
        body: { tenantId: TENANT_A, tenantSchema: SCHEMA_A },
        query: {},
        headers: { 'x-tenant-schema': SCHEMA_A },
      };
      expect(guard.canActivate(ctx(req))).toBe(true);
    });
  });
});
