/**
 * Auto-generated RBAC spec — Batch C (跨 tenant 强制 403)
 *
 * !!! 禁止手改 !!! 改 src/__rbac__/manifest.json + 重跑 scripts/generate-rbac-spec.js
 *
 * 生成时间: 2026-05-19
 * 来源: docs/SSOT-拍板权威.md §1 角色 + §4 字段矩阵 + §6 操作权限矩阵
 * 对象: 18 = 5 核心 (Batch A) + 13 外围 (Batch B)
 * 总 case 数: 18 对象 × 13 角色 = 234
 *
 * 与 prompt 数字差异:
 *   prompt 任务 B 说 "9 角色 × 18 对象 = 162"，本 spec 实际 13 × 18 = 234
 *   多 72 case 覆盖 2 平台 + 4 auxiliary 角色 = 6 × 18 = 108
 *   - 平台角色 (platform_admin / finance_admin)：期望 canActivate 返 true (isPlatformRole 豁免)
 *   - auxiliary 角色 (marketing/hr/finance_admin/academic_admin)：期望 ForbiddenException (mismatch tenantSchema)
 *
 * 攻击场景:
 *   body.tenantSchema='tenant_OTHER' + JWT.tenantId='SELF' → TenantScopeGuard 抛 ForbiddenException
 *
 * 测试策略:
 *   - 每个 (obj, role) 单元格 1 个 it
 *   - 构造 JWT.tenantId='TENANT_SELF' + body.tenantSchema='tenant_other' 不一致
 *   - 普通角色 → 期望 TenantScopeGuard 抛 ForbiddenException
 *   - 平台角色 → 期望 canActivate 返 true (isPlatformRole 豁免)
 *
 * 边界说明:
 *   - TenantScopeGuard 在 controller class-level，与具体 obj 解耦；本 spec 按 obj 分组只为生成可读性
 *   - 即同一 (role, mismatch) case 对所有 obj 行为完全一致（guard 不读 obj 信息）
 *   - audit_log 不在 guard 边界（middleware 层）；本 spec 不断言 audit_log
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';
import { RbacRole } from '../../guards/rbac.decorator';
import { JwtPayload } from '../../modules/auth/jwt-payload.interface';

type AnyRoleForTest = RbacRole | 'parent';

/**
 * 攻击场景构造：JWT.tenantId='TENANT_SELF' + body.tenantSchema='tenant_other'
 *   - mkSelfUser 返 SELF tenant 的 JWT
 *   - mkMismatchRequest 构造 body.tenantSchema='tenant_other' (与 SELF 不一致)
 *   - TenantScopeGuard 应抛 ForbiddenException (普通角色) 或放行 (平台角色)
 */
const TENANT_SELF = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNBB';
const TENANT_OTHER_SCHEMA = 'tenant_01hx7y6p5k9n3m2qabcdefghijklmnxx'; // 与 SELF 完全不同

function mkSelfUser(role: AnyRoleForTest): JwtPayload {
  const platformRoles = ['platform_admin', 'finance_admin'];
  return {
    sub: '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNAA',
    tenantId: platformRoles.includes(role) ? null : TENANT_SELF,
    role: role as RbacRole,
    campusId: platformRoles.includes(role) ? null : '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNCC',
  };
}

function mkMismatchRequest(user: JwtPayload | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        user,
        body: { tenantSchema: TENANT_OTHER_SCHEMA },
        query: {},
        headers: {},
        method: 'POST',
        url: '/api/db/test-endpoint',
      }),
    }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as any;
}

describe('[RBAC L9 Batch C] 跨 tenant 强制 403 — 18 对象 × 13 角色 = 234 case', () => {
  let guard: TenantScopeGuard;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TenantScopeGuard],
    }).compile();
    guard = module.get<TenantScopeGuard>(TenantScopeGuard);
  });

  describe('customer — cross-tenant body.tenantSchema mismatch', () => {
    it('admin → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('admin')))).toThrow(ForbiddenException);
    });
    it('boss → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('boss')))).toThrow(ForbiddenException);
    });
    it('sales → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('sales')))).toThrow(ForbiddenException);
    });
    it('sales_manager → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('sales_manager')))).toThrow(ForbiddenException);
    });
    it('academic → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('academic')))).toThrow(ForbiddenException);
    });
    it('teacher → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('teacher')))).toThrow(ForbiddenException);
    });
    it('finance → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('finance')))).toThrow(ForbiddenException);
    });
    it('parent → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('parent')))).toThrow(ForbiddenException);
    });
    it('platform_admin (平台角色) → canActivate 返 true (isPlatformRole 豁免)', () => {
      const result = guard.canActivate(mkMismatchRequest(mkSelfUser('platform_admin')));
      expect(result).toBe(true);
    });
    it('marketing → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('marketing')))).toThrow(ForbiddenException);
    });
    it('hr → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('hr')))).toThrow(ForbiddenException);
    });
    it('academic_admin → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('academic_admin')))).toThrow(ForbiddenException);
    });
    it('finance_admin (平台角色) → canActivate 返 true (isPlatformRole 豁免)', () => {
      const result = guard.canActivate(mkMismatchRequest(mkSelfUser('finance_admin')));
      expect(result).toBe(true);
    });
  });

  describe('student — cross-tenant body.tenantSchema mismatch', () => {
    it('admin → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('admin')))).toThrow(ForbiddenException);
    });
    it('boss → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('boss')))).toThrow(ForbiddenException);
    });
    it('sales → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('sales')))).toThrow(ForbiddenException);
    });
    it('sales_manager → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('sales_manager')))).toThrow(ForbiddenException);
    });
    it('academic → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('academic')))).toThrow(ForbiddenException);
    });
    it('teacher → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('teacher')))).toThrow(ForbiddenException);
    });
    it('finance → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('finance')))).toThrow(ForbiddenException);
    });
    it('parent → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('parent')))).toThrow(ForbiddenException);
    });
    it('platform_admin (平台角色) → canActivate 返 true (isPlatformRole 豁免)', () => {
      const result = guard.canActivate(mkMismatchRequest(mkSelfUser('platform_admin')));
      expect(result).toBe(true);
    });
    it('marketing → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('marketing')))).toThrow(ForbiddenException);
    });
    it('hr → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('hr')))).toThrow(ForbiddenException);
    });
    it('academic_admin → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('academic_admin')))).toThrow(ForbiddenException);
    });
    it('finance_admin (平台角色) → canActivate 返 true (isPlatformRole 豁免)', () => {
      const result = guard.canActivate(mkMismatchRequest(mkSelfUser('finance_admin')));
      expect(result).toBe(true);
    });
  });

  describe('contract — cross-tenant body.tenantSchema mismatch', () => {
    it('admin → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('admin')))).toThrow(ForbiddenException);
    });
    it('boss → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('boss')))).toThrow(ForbiddenException);
    });
    it('sales → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('sales')))).toThrow(ForbiddenException);
    });
    it('sales_manager → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('sales_manager')))).toThrow(ForbiddenException);
    });
    it('academic → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('academic')))).toThrow(ForbiddenException);
    });
    it('teacher → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('teacher')))).toThrow(ForbiddenException);
    });
    it('finance → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('finance')))).toThrow(ForbiddenException);
    });
    it('parent → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('parent')))).toThrow(ForbiddenException);
    });
    it('platform_admin (平台角色) → canActivate 返 true (isPlatformRole 豁免)', () => {
      const result = guard.canActivate(mkMismatchRequest(mkSelfUser('platform_admin')));
      expect(result).toBe(true);
    });
    it('marketing → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('marketing')))).toThrow(ForbiddenException);
    });
    it('hr → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('hr')))).toThrow(ForbiddenException);
    });
    it('academic_admin → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('academic_admin')))).toThrow(ForbiddenException);
    });
    it('finance_admin (平台角色) → canActivate 返 true (isPlatformRole 豁免)', () => {
      const result = guard.canActivate(mkMismatchRequest(mkSelfUser('finance_admin')));
      expect(result).toBe(true);
    });
  });

  describe('teacher — cross-tenant body.tenantSchema mismatch', () => {
    it('admin → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('admin')))).toThrow(ForbiddenException);
    });
    it('boss → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('boss')))).toThrow(ForbiddenException);
    });
    it('sales → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('sales')))).toThrow(ForbiddenException);
    });
    it('sales_manager → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('sales_manager')))).toThrow(ForbiddenException);
    });
    it('academic → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('academic')))).toThrow(ForbiddenException);
    });
    it('teacher → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('teacher')))).toThrow(ForbiddenException);
    });
    it('finance → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('finance')))).toThrow(ForbiddenException);
    });
    it('parent → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('parent')))).toThrow(ForbiddenException);
    });
    it('platform_admin (平台角色) → canActivate 返 true (isPlatformRole 豁免)', () => {
      const result = guard.canActivate(mkMismatchRequest(mkSelfUser('platform_admin')));
      expect(result).toBe(true);
    });
    it('marketing → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('marketing')))).toThrow(ForbiddenException);
    });
    it('hr → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('hr')))).toThrow(ForbiddenException);
    });
    it('academic_admin → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('academic_admin')))).toThrow(ForbiddenException);
    });
    it('finance_admin (平台角色) → canActivate 返 true (isPlatformRole 豁免)', () => {
      const result = guard.canActivate(mkMismatchRequest(mkSelfUser('finance_admin')));
      expect(result).toBe(true);
    });
  });

  describe('parent — cross-tenant body.tenantSchema mismatch', () => {
    it('admin → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('admin')))).toThrow(ForbiddenException);
    });
    it('boss → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('boss')))).toThrow(ForbiddenException);
    });
    it('sales → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('sales')))).toThrow(ForbiddenException);
    });
    it('sales_manager → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('sales_manager')))).toThrow(ForbiddenException);
    });
    it('academic → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('academic')))).toThrow(ForbiddenException);
    });
    it('teacher → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('teacher')))).toThrow(ForbiddenException);
    });
    it('finance → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('finance')))).toThrow(ForbiddenException);
    });
    it('parent → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('parent')))).toThrow(ForbiddenException);
    });
    it('platform_admin (平台角色) → canActivate 返 true (isPlatformRole 豁免)', () => {
      const result = guard.canActivate(mkMismatchRequest(mkSelfUser('platform_admin')));
      expect(result).toBe(true);
    });
    it('marketing → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('marketing')))).toThrow(ForbiddenException);
    });
    it('hr → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('hr')))).toThrow(ForbiddenException);
    });
    it('academic_admin → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('academic_admin')))).toThrow(ForbiddenException);
    });
    it('finance_admin (平台角色) → canActivate 返 true (isPlatformRole 豁免)', () => {
      const result = guard.canActivate(mkMismatchRequest(mkSelfUser('finance_admin')));
      expect(result).toBe(true);
    });
  });

  describe('schedule — cross-tenant body.tenantSchema mismatch', () => {
    it('admin → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('admin')))).toThrow(ForbiddenException);
    });
    it('boss → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('boss')))).toThrow(ForbiddenException);
    });
    it('sales → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('sales')))).toThrow(ForbiddenException);
    });
    it('sales_manager → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('sales_manager')))).toThrow(ForbiddenException);
    });
    it('academic → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('academic')))).toThrow(ForbiddenException);
    });
    it('teacher → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('teacher')))).toThrow(ForbiddenException);
    });
    it('finance → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('finance')))).toThrow(ForbiddenException);
    });
    it('parent → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('parent')))).toThrow(ForbiddenException);
    });
    it('platform_admin (平台角色) → canActivate 返 true (isPlatformRole 豁免)', () => {
      const result = guard.canActivate(mkMismatchRequest(mkSelfUser('platform_admin')));
      expect(result).toBe(true);
    });
    it('marketing → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('marketing')))).toThrow(ForbiddenException);
    });
    it('hr → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('hr')))).toThrow(ForbiddenException);
    });
    it('academic_admin → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('academic_admin')))).toThrow(ForbiddenException);
    });
    it('finance_admin (平台角色) → canActivate 返 true (isPlatformRole 豁免)', () => {
      const result = guard.canActivate(mkMismatchRequest(mkSelfUser('finance_admin')));
      expect(result).toBe(true);
    });
  });

  describe('lesson_feedback — cross-tenant body.tenantSchema mismatch', () => {
    it('admin → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('admin')))).toThrow(ForbiddenException);
    });
    it('boss → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('boss')))).toThrow(ForbiddenException);
    });
    it('sales → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('sales')))).toThrow(ForbiddenException);
    });
    it('sales_manager → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('sales_manager')))).toThrow(ForbiddenException);
    });
    it('academic → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('academic')))).toThrow(ForbiddenException);
    });
    it('teacher → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('teacher')))).toThrow(ForbiddenException);
    });
    it('finance → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('finance')))).toThrow(ForbiddenException);
    });
    it('parent → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('parent')))).toThrow(ForbiddenException);
    });
    it('platform_admin (平台角色) → canActivate 返 true (isPlatformRole 豁免)', () => {
      const result = guard.canActivate(mkMismatchRequest(mkSelfUser('platform_admin')));
      expect(result).toBe(true);
    });
    it('marketing → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('marketing')))).toThrow(ForbiddenException);
    });
    it('hr → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('hr')))).toThrow(ForbiddenException);
    });
    it('academic_admin → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('academic_admin')))).toThrow(ForbiddenException);
    });
    it('finance_admin (平台角色) → canActivate 返 true (isPlatformRole 豁免)', () => {
      const result = guard.canActivate(mkMismatchRequest(mkSelfUser('finance_admin')));
      expect(result).toBe(true);
    });
  });

  describe('homework — cross-tenant body.tenantSchema mismatch', () => {
    it('admin → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('admin')))).toThrow(ForbiddenException);
    });
    it('boss → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('boss')))).toThrow(ForbiddenException);
    });
    it('sales → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('sales')))).toThrow(ForbiddenException);
    });
    it('sales_manager → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('sales_manager')))).toThrow(ForbiddenException);
    });
    it('academic → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('academic')))).toThrow(ForbiddenException);
    });
    it('teacher → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('teacher')))).toThrow(ForbiddenException);
    });
    it('finance → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('finance')))).toThrow(ForbiddenException);
    });
    it('parent → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('parent')))).toThrow(ForbiddenException);
    });
    it('platform_admin (平台角色) → canActivate 返 true (isPlatformRole 豁免)', () => {
      const result = guard.canActivate(mkMismatchRequest(mkSelfUser('platform_admin')));
      expect(result).toBe(true);
    });
    it('marketing → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('marketing')))).toThrow(ForbiddenException);
    });
    it('hr → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('hr')))).toThrow(ForbiddenException);
    });
    it('academic_admin → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('academic_admin')))).toThrow(ForbiddenException);
    });
    it('finance_admin (平台角色) → canActivate 返 true (isPlatformRole 豁免)', () => {
      const result = guard.canActivate(mkMismatchRequest(mkSelfUser('finance_admin')));
      expect(result).toBe(true);
    });
  });

  describe('assessment — cross-tenant body.tenantSchema mismatch', () => {
    it('admin → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('admin')))).toThrow(ForbiddenException);
    });
    it('boss → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('boss')))).toThrow(ForbiddenException);
    });
    it('sales → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('sales')))).toThrow(ForbiddenException);
    });
    it('sales_manager → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('sales_manager')))).toThrow(ForbiddenException);
    });
    it('academic → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('academic')))).toThrow(ForbiddenException);
    });
    it('teacher → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('teacher')))).toThrow(ForbiddenException);
    });
    it('finance → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('finance')))).toThrow(ForbiddenException);
    });
    it('parent → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('parent')))).toThrow(ForbiddenException);
    });
    it('platform_admin (平台角色) → canActivate 返 true (isPlatformRole 豁免)', () => {
      const result = guard.canActivate(mkMismatchRequest(mkSelfUser('platform_admin')));
      expect(result).toBe(true);
    });
    it('marketing → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('marketing')))).toThrow(ForbiddenException);
    });
    it('hr → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('hr')))).toThrow(ForbiddenException);
    });
    it('academic_admin → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('academic_admin')))).toThrow(ForbiddenException);
    });
    it('finance_admin (平台角色) → canActivate 返 true (isPlatformRole 豁免)', () => {
      const result = guard.canActivate(mkMismatchRequest(mkSelfUser('finance_admin')));
      expect(result).toBe(true);
    });
  });

  describe('learning_profile — cross-tenant body.tenantSchema mismatch', () => {
    it('admin → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('admin')))).toThrow(ForbiddenException);
    });
    it('boss → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('boss')))).toThrow(ForbiddenException);
    });
    it('sales → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('sales')))).toThrow(ForbiddenException);
    });
    it('sales_manager → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('sales_manager')))).toThrow(ForbiddenException);
    });
    it('academic → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('academic')))).toThrow(ForbiddenException);
    });
    it('teacher → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('teacher')))).toThrow(ForbiddenException);
    });
    it('finance → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('finance')))).toThrow(ForbiddenException);
    });
    it('parent → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('parent')))).toThrow(ForbiddenException);
    });
    it('platform_admin (平台角色) → canActivate 返 true (isPlatformRole 豁免)', () => {
      const result = guard.canActivate(mkMismatchRequest(mkSelfUser('platform_admin')));
      expect(result).toBe(true);
    });
    it('marketing → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('marketing')))).toThrow(ForbiddenException);
    });
    it('hr → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('hr')))).toThrow(ForbiddenException);
    });
    it('academic_admin → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('academic_admin')))).toThrow(ForbiddenException);
    });
    it('finance_admin (平台角色) → canActivate 返 true (isPlatformRole 豁免)', () => {
      const result = guard.canActivate(mkMismatchRequest(mkSelfUser('finance_admin')));
      expect(result).toBe(true);
    });
  });

  describe('monthly_report — cross-tenant body.tenantSchema mismatch', () => {
    it('admin → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('admin')))).toThrow(ForbiddenException);
    });
    it('boss → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('boss')))).toThrow(ForbiddenException);
    });
    it('sales → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('sales')))).toThrow(ForbiddenException);
    });
    it('sales_manager → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('sales_manager')))).toThrow(ForbiddenException);
    });
    it('academic → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('academic')))).toThrow(ForbiddenException);
    });
    it('teacher → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('teacher')))).toThrow(ForbiddenException);
    });
    it('finance → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('finance')))).toThrow(ForbiddenException);
    });
    it('parent → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('parent')))).toThrow(ForbiddenException);
    });
    it('platform_admin (平台角色) → canActivate 返 true (isPlatformRole 豁免)', () => {
      const result = guard.canActivate(mkMismatchRequest(mkSelfUser('platform_admin')));
      expect(result).toBe(true);
    });
    it('marketing → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('marketing')))).toThrow(ForbiddenException);
    });
    it('hr → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('hr')))).toThrow(ForbiddenException);
    });
    it('academic_admin → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('academic_admin')))).toThrow(ForbiddenException);
    });
    it('finance_admin (平台角色) → canActivate 返 true (isPlatformRole 豁免)', () => {
      const result = guard.canActivate(mkMismatchRequest(mkSelfUser('finance_admin')));
      expect(result).toBe(true);
    });
  });

  describe('invoice — cross-tenant body.tenantSchema mismatch', () => {
    it('admin → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('admin')))).toThrow(ForbiddenException);
    });
    it('boss → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('boss')))).toThrow(ForbiddenException);
    });
    it('sales → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('sales')))).toThrow(ForbiddenException);
    });
    it('sales_manager → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('sales_manager')))).toThrow(ForbiddenException);
    });
    it('academic → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('academic')))).toThrow(ForbiddenException);
    });
    it('teacher → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('teacher')))).toThrow(ForbiddenException);
    });
    it('finance → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('finance')))).toThrow(ForbiddenException);
    });
    it('parent → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('parent')))).toThrow(ForbiddenException);
    });
    it('platform_admin (平台角色) → canActivate 返 true (isPlatformRole 豁免)', () => {
      const result = guard.canActivate(mkMismatchRequest(mkSelfUser('platform_admin')));
      expect(result).toBe(true);
    });
    it('marketing → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('marketing')))).toThrow(ForbiddenException);
    });
    it('hr → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('hr')))).toThrow(ForbiddenException);
    });
    it('academic_admin → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('academic_admin')))).toThrow(ForbiddenException);
    });
    it('finance_admin (平台角色) → canActivate 返 true (isPlatformRole 豁免)', () => {
      const result = guard.canActivate(mkMismatchRequest(mkSelfUser('finance_admin')));
      expect(result).toBe(true);
    });
  });

  describe('course_consumption — cross-tenant body.tenantSchema mismatch', () => {
    it('admin → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('admin')))).toThrow(ForbiddenException);
    });
    it('boss → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('boss')))).toThrow(ForbiddenException);
    });
    it('sales → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('sales')))).toThrow(ForbiddenException);
    });
    it('sales_manager → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('sales_manager')))).toThrow(ForbiddenException);
    });
    it('academic → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('academic')))).toThrow(ForbiddenException);
    });
    it('teacher → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('teacher')))).toThrow(ForbiddenException);
    });
    it('finance → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('finance')))).toThrow(ForbiddenException);
    });
    it('parent → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('parent')))).toThrow(ForbiddenException);
    });
    it('platform_admin (平台角色) → canActivate 返 true (isPlatformRole 豁免)', () => {
      const result = guard.canActivate(mkMismatchRequest(mkSelfUser('platform_admin')));
      expect(result).toBe(true);
    });
    it('marketing → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('marketing')))).toThrow(ForbiddenException);
    });
    it('hr → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('hr')))).toThrow(ForbiddenException);
    });
    it('academic_admin → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('academic_admin')))).toThrow(ForbiddenException);
    });
    it('finance_admin (平台角色) → canActivate 返 true (isPlatformRole 豁免)', () => {
      const result = guard.canActivate(mkMismatchRequest(mkSelfUser('finance_admin')));
      expect(result).toBe(true);
    });
  });

  describe('course_package_balance — cross-tenant body.tenantSchema mismatch', () => {
    it('admin → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('admin')))).toThrow(ForbiddenException);
    });
    it('boss → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('boss')))).toThrow(ForbiddenException);
    });
    it('sales → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('sales')))).toThrow(ForbiddenException);
    });
    it('sales_manager → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('sales_manager')))).toThrow(ForbiddenException);
    });
    it('academic → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('academic')))).toThrow(ForbiddenException);
    });
    it('teacher → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('teacher')))).toThrow(ForbiddenException);
    });
    it('finance → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('finance')))).toThrow(ForbiddenException);
    });
    it('parent → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('parent')))).toThrow(ForbiddenException);
    });
    it('platform_admin (平台角色) → canActivate 返 true (isPlatformRole 豁免)', () => {
      const result = guard.canActivate(mkMismatchRequest(mkSelfUser('platform_admin')));
      expect(result).toBe(true);
    });
    it('marketing → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('marketing')))).toThrow(ForbiddenException);
    });
    it('hr → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('hr')))).toThrow(ForbiddenException);
    });
    it('academic_admin → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('academic_admin')))).toThrow(ForbiddenException);
    });
    it('finance_admin (平台角色) → canActivate 返 true (isPlatformRole 豁免)', () => {
      const result = guard.canActivate(mkMismatchRequest(mkSelfUser('finance_admin')));
      expect(result).toBe(true);
    });
  });

  describe('course_product — cross-tenant body.tenantSchema mismatch', () => {
    it('admin → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('admin')))).toThrow(ForbiddenException);
    });
    it('boss → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('boss')))).toThrow(ForbiddenException);
    });
    it('sales → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('sales')))).toThrow(ForbiddenException);
    });
    it('sales_manager → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('sales_manager')))).toThrow(ForbiddenException);
    });
    it('academic → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('academic')))).toThrow(ForbiddenException);
    });
    it('teacher → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('teacher')))).toThrow(ForbiddenException);
    });
    it('finance → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('finance')))).toThrow(ForbiddenException);
    });
    it('parent → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('parent')))).toThrow(ForbiddenException);
    });
    it('platform_admin (平台角色) → canActivate 返 true (isPlatformRole 豁免)', () => {
      const result = guard.canActivate(mkMismatchRequest(mkSelfUser('platform_admin')));
      expect(result).toBe(true);
    });
    it('marketing → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('marketing')))).toThrow(ForbiddenException);
    });
    it('hr → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('hr')))).toThrow(ForbiddenException);
    });
    it('academic_admin → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('academic_admin')))).toThrow(ForbiddenException);
    });
    it('finance_admin (平台角色) → canActivate 返 true (isPlatformRole 豁免)', () => {
      const result = guard.canActivate(mkMismatchRequest(mkSelfUser('finance_admin')));
      expect(result).toBe(true);
    });
  });

  describe('campus — cross-tenant body.tenantSchema mismatch', () => {
    it('admin → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('admin')))).toThrow(ForbiddenException);
    });
    it('boss → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('boss')))).toThrow(ForbiddenException);
    });
    it('sales → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('sales')))).toThrow(ForbiddenException);
    });
    it('sales_manager → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('sales_manager')))).toThrow(ForbiddenException);
    });
    it('academic → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('academic')))).toThrow(ForbiddenException);
    });
    it('teacher → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('teacher')))).toThrow(ForbiddenException);
    });
    it('finance → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('finance')))).toThrow(ForbiddenException);
    });
    it('parent → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('parent')))).toThrow(ForbiddenException);
    });
    it('platform_admin (平台角色) → canActivate 返 true (isPlatformRole 豁免)', () => {
      const result = guard.canActivate(mkMismatchRequest(mkSelfUser('platform_admin')));
      expect(result).toBe(true);
    });
    it('marketing → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('marketing')))).toThrow(ForbiddenException);
    });
    it('hr → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('hr')))).toThrow(ForbiddenException);
    });
    it('academic_admin → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('academic_admin')))).toThrow(ForbiddenException);
    });
    it('finance_admin (平台角色) → canActivate 返 true (isPlatformRole 豁免)', () => {
      const result = guard.canActivate(mkMismatchRequest(mkSelfUser('finance_admin')));
      expect(result).toBe(true);
    });
  });

  describe('user — cross-tenant body.tenantSchema mismatch', () => {
    it('admin → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('admin')))).toThrow(ForbiddenException);
    });
    it('boss → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('boss')))).toThrow(ForbiddenException);
    });
    it('sales → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('sales')))).toThrow(ForbiddenException);
    });
    it('sales_manager → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('sales_manager')))).toThrow(ForbiddenException);
    });
    it('academic → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('academic')))).toThrow(ForbiddenException);
    });
    it('teacher → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('teacher')))).toThrow(ForbiddenException);
    });
    it('finance → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('finance')))).toThrow(ForbiddenException);
    });
    it('parent → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('parent')))).toThrow(ForbiddenException);
    });
    it('platform_admin (平台角色) → canActivate 返 true (isPlatformRole 豁免)', () => {
      const result = guard.canActivate(mkMismatchRequest(mkSelfUser('platform_admin')));
      expect(result).toBe(true);
    });
    it('marketing → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('marketing')))).toThrow(ForbiddenException);
    });
    it('hr → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('hr')))).toThrow(ForbiddenException);
    });
    it('academic_admin → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('academic_admin')))).toThrow(ForbiddenException);
    });
    it('finance_admin (平台角色) → canActivate 返 true (isPlatformRole 豁免)', () => {
      const result = guard.canActivate(mkMismatchRequest(mkSelfUser('finance_admin')));
      expect(result).toBe(true);
    });
  });

  describe('parent_referral — cross-tenant body.tenantSchema mismatch', () => {
    it('admin → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('admin')))).toThrow(ForbiddenException);
    });
    it('boss → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('boss')))).toThrow(ForbiddenException);
    });
    it('sales → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('sales')))).toThrow(ForbiddenException);
    });
    it('sales_manager → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('sales_manager')))).toThrow(ForbiddenException);
    });
    it('academic → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('academic')))).toThrow(ForbiddenException);
    });
    it('teacher → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('teacher')))).toThrow(ForbiddenException);
    });
    it('finance → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('finance')))).toThrow(ForbiddenException);
    });
    it('parent → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('parent')))).toThrow(ForbiddenException);
    });
    it('platform_admin (平台角色) → canActivate 返 true (isPlatformRole 豁免)', () => {
      const result = guard.canActivate(mkMismatchRequest(mkSelfUser('platform_admin')));
      expect(result).toBe(true);
    });
    it('marketing → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('marketing')))).toThrow(ForbiddenException);
    });
    it('hr → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('hr')))).toThrow(ForbiddenException);
    });
    it('academic_admin → ForbiddenException (cross-tenant denied)', () => {
      expect(() => guard.canActivate(mkMismatchRequest(mkSelfUser('academic_admin')))).toThrow(ForbiddenException);
    });
    it('finance_admin (平台角色) → canActivate 返 true (isPlatformRole 豁免)', () => {
      const result = guard.canActivate(mkMismatchRequest(mkSelfUser('finance_admin')));
      expect(result).toBe(true);
    });
  });

  describe('corner cases (TenantScopeGuard 边界)', () => {
    it('req.user undefined → UnauthorizedException', () => {
      expect(() => guard.canActivate(mkMismatchRequest(undefined))).toThrow(UnauthorizedException);
    });

    it('tenant role + tenantId null → ForbiddenException (JWT 不完整)', () => {
      const user = { sub: 'x', tenantId: null, role: 'admin' as RbacRole, campusId: null };
      expect(() => guard.canActivate(mkMismatchRequest(user))).toThrow(ForbiddenException);
    });

    it('body.tenantSchema 大小写不一致但等价 → 放行 (toLowerCase 归一化)', () => {
      // 构造一个与 SELF 大小写不同但等价的 schema
      const selfSchemaMixedCase = ('TENANT_' + TENANT_SELF.toLowerCase()).toUpperCase();
      const context = {
        switchToHttp: () => ({
          getRequest: () => ({
            user: mkSelfUser('admin'),
            body: { tenantSchema: selfSchemaMixedCase },
            query: {},
            headers: {},
            method: 'POST',
            url: '/api/db/test',
          }),
        }),
        getHandler: () => undefined,
        getClass: () => undefined,
      } as any;
      expect(guard.canActivate(context)).toBe(true);
    });
  });
});
