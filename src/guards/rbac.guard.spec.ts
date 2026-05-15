/**
 * RbacGuard 单元测试 — W3-1 Phase 4.2 BE-W4-2
 *
 * PM-AUTH-7(2026-04-30): 角色 RBAC 按钮级权限
 *
 * 覆盖：
 *   - 没标 @Roles → 放行
 *   - 标 @Roles + role 命中 → 放行
 *   - 标 @Roles + role 不命中 → ForbiddenException
 *   - 没 user → UnauthorizedException
 *   - 多角色 OR 关系
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RbacGuard } from './rbac.guard';
import { ROLES_METADATA_KEY, RbacRole } from './rbac.decorator';
import { JwtPayload } from '../modules/auth/jwt-payload.interface';

const mkContext = (user: JwtPayload | undefined, requiredRoles: RbacRole[] | undefined): ExecutionContext => {
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(requiredRoles),
  };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  };
  return { ctx: ctx as any, reflector } as any;
};

describe('RbacGuard', () => {
  let guard: RbacGuard;
  let reflector: Reflector;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RbacGuard,
        { provide: Reflector, useValue: { getAllAndOverride: jest.fn() } },
      ],
    }).compile();
    guard = module.get<RbacGuard>(RbacGuard);
    reflector = module.get<Reflector>(Reflector);
  });

  const adminUser: JwtPayload = {
    sub: '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNOP',
    tenantId: null,
    role: 'platform_admin',
    campusId: null,
  };

  const salesUser: JwtPayload = {
    sub: '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNOQ',
    tenantId: '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNOR',
    role: 'sales',
    campusId: '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNOS',
  };

  const ctx = (user: JwtPayload | undefined): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      getHandler: () => undefined,
      getClass: () => undefined,
    }) as any;

  it('没标 @Roles → 放行', () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(undefined);
    expect(guard.canActivate(ctx(adminUser))).toBe(true);
  });

  it('@Roles 空数组 → 放行', () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue([]);
    expect(guard.canActivate(ctx(adminUser))).toBe(true);
  });

  it('@Roles(platform_admin) + user.role=platform_admin → 放行', () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(['platform_admin']);
    expect(guard.canActivate(ctx(adminUser))).toBe(true);
  });

  it('@Roles(platform_admin) + user.role=sales → ForbiddenException', () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(['platform_admin']);
    expect(() => guard.canActivate(ctx(salesUser))).toThrow(ForbiddenException);
  });

  it('@Roles(platform_admin, finance_admin) OR 关系 + user.role=finance_admin → 放行', () => {
    const financeUser: JwtPayload = { ...adminUser, role: 'finance_admin' };
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(['platform_admin', 'finance_admin']);
    expect(guard.canActivate(ctx(financeUser))).toBe(true);
  });

  it('@Roles(...) + 没 user → UnauthorizedException', () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(['platform_admin']);
    expect(() => guard.canActivate(ctx(undefined))).toThrow(UnauthorizedException);
  });

  it('@Roles(...) + user 没 role → UnauthorizedException', () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(['platform_admin']);
    expect(() => guard.canActivate(ctx({ ...adminUser, role: undefined as any }))).toThrow(
      UnauthorizedException,
    );
  });

  it('@Roles(hr) + user.role=sales → ForbiddenException', () => {
    // 5/15 A-2：原 sales_director 已删，改用 hr 测 role mismatch 语义（任一非匹配 role 等效）
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(['hr']);
    expect(() => guard.canActivate(ctx(salesUser))).toThrow(ForbiddenException);
  });
});
