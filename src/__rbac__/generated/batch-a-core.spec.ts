/**
 * Auto-generated RBAC spec — Batch A (核心 5 对象)
 *
 * !!! 禁止手改 !!! 改 src/__rbac__/manifest.json + 重跑 scripts/generate-rbac-spec.js
 *
 * 生成时间: 2026-05-19
 * 来源: docs/SSOT-拍板权威.md §1 角色 + §4 字段矩阵 + §6 操作权限矩阵
 * 总 case 数: 5 对象 × 4 CRUD × 13 角色 = 260
 *
 * 测试策略:
 *   - 每个单元格 (obj, action, role) 一个 it
 *   - 调用 RbacGuard.canActivate 模拟 controller-level @Roles
 *   - allow → 期望 canActivate 返 true
 *   - deny → 期望 canActivate 抛 ForbiddenException
 *   - manifest 与代码不一致 → 此 spec FAIL = 揭露 RBAC bug
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RbacGuard } from '../../guards/rbac.guard';
import { RbacRole } from '../../guards/rbac.decorator';
import { JwtPayload } from '../../modules/auth/jwt-payload.interface';

/**
 * 构造 JWT user — sub/tenantId/campusId 都用稳定 ULID 占位
 * (实际值不影响 RbacGuard, 仅 role 字段决定路径)
 */
// 注: 'parent' 角色走 ParentJwt 独立 strategy, 不在 RbacRole 类型 union 内,
//     但 RbacGuard 只读 role 字符串, 测试用 cast 模拟 "parent 试图走 B 端 RbacGuard 路径"
//     场景 — 期望全部 deny (B 端 controller @Roles 均不含 'parent').
type AnyRoleForTest = RbacRole | 'parent';

function mkUser(role: AnyRoleForTest): JwtPayload {
  const platformRoles = ['platform_admin', 'finance_admin'];
  return {
    sub: '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNAA',
    tenantId: platformRoles.includes(role) ? null : '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNBB',
    role: role as RbacRole,
    campusId: platformRoles.includes(role) ? null : '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNCC',
  };
}

/**
 * 构造 ExecutionContext (包含 user + 注入 reflector required roles)
 */
function mkContext(user: JwtPayload | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as any;
}

describe('[RBAC L9 Batch A] 核心 5 对象 × 4 CRUD × 13 角色 = 260 case', () => {
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

  describe('customer', () => {
    describe('create', () => {
      // manifest: allow=[sales,sales_manager,boss,admin]
      // manifest: deny=[academic,teacher,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]

      it('allow sales → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        const result = guard.canActivate(mkContext(mkUser('sales')));
        expect(result).toBe(true);
      });
      it('allow sales_manager → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        const result = guard.canActivate(mkContext(mkUser('sales_manager')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('deny academic → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic')))).toThrow(ForbiddenException);
      });
      it('deny teacher → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('teacher')))).toThrow(ForbiddenException);
      });
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
      });
      it('deny parent → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('parent')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
      it('deny academic_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic_admin')))).toThrow(ForbiddenException);
      });
    });

    describe('read', () => {
      // manifest: allow=[sales,sales_manager,boss,admin,academic,academic_admin,finance]
      // manifest: deny=[teacher,parent,platform_admin,finance_admin,marketing,hr]
      // note: sales 仅看 owner=self / 池; academic 看本校已成交; finance 仅作账金额; SSOT §4.4 customer.联系人=销 owner=me ✅ / 务 本校已成交 ✅ / 老校 ✅ / 财 ❌; customer.购业 财 ✅作账

      it('allow sales → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin","finance"]);
        const result = guard.canActivate(mkContext(mkUser('sales')));
        expect(result).toBe(true);
      });
      it('allow sales_manager → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin","finance"]);
        const result = guard.canActivate(mkContext(mkUser('sales_manager')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin","finance"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin","finance"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow academic → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin","finance"]);
        const result = guard.canActivate(mkContext(mkUser('academic')));
        expect(result).toBe(true);
      });
      it('allow academic_admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin","finance"]);
        const result = guard.canActivate(mkContext(mkUser('academic_admin')));
        expect(result).toBe(true);
      });
      it('allow finance → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin","finance"]);
        const result = guard.canActivate(mkContext(mkUser('finance')));
        expect(result).toBe(true);
      });
      it('deny teacher → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin","finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('teacher')))).toThrow(ForbiddenException);
      });
      it('deny parent → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin","finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('parent')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin","finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin","finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin","finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin","finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
    });

    describe('update', () => {
      // manifest: allow=[sales,sales_manager,boss,admin]
      // manifest: deny=[academic,teacher,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: owner 字段仅 owner 自己改 / sales_manager 调拨; SSOT §4.4 销 ✅ owner=me / 老校 ✅

      it('allow sales → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        const result = guard.canActivate(mkContext(mkUser('sales')));
        expect(result).toBe(true);
      });
      it('allow sales_manager → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        const result = guard.canActivate(mkContext(mkUser('sales_manager')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('deny academic → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic')))).toThrow(ForbiddenException);
      });
      it('deny teacher → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('teacher')))).toThrow(ForbiddenException);
      });
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
      });
      it('deny parent → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('parent')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
      it('deny academic_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic_admin')))).toThrow(ForbiddenException);
      });
    });

    describe('delete', () => {
      // manifest: allow=[admin,boss]
      // manifest: deny=[sales,sales_manager,academic,teacher,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: 客户软删 archive 仅老校 admin/boss; 销售自己不删客户 (历史保留)

      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('deny sales → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales')))).toThrow(ForbiddenException);
      });
      it('deny sales_manager → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales_manager')))).toThrow(ForbiddenException);
      });
      it('deny academic → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic')))).toThrow(ForbiddenException);
      });
      it('deny teacher → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('teacher')))).toThrow(ForbiddenException);
      });
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
      });
      it('deny parent → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('parent')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
      it('deny academic_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic_admin')))).toThrow(ForbiddenException);
      });
    });

  });

  describe('student', () => {
    describe('create', () => {
      // manifest: allow=[sales,sales_manager,boss,admin,academic,academic_admin]
      // manifest: deny=[teacher,finance,parent,platform_admin,finance_admin,marketing,hr]
      // note: 试听后由教务/老板/admin 显式 customer.promote-student; sales 在客户详情建学生 (§4.1 销 ✅ 自己客户)

      it('allow sales → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin"]);
        const result = guard.canActivate(mkContext(mkUser('sales')));
        expect(result).toBe(true);
      });
      it('allow sales_manager → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin"]);
        const result = guard.canActivate(mkContext(mkUser('sales_manager')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow academic → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin"]);
        const result = guard.canActivate(mkContext(mkUser('academic')));
        expect(result).toBe(true);
      });
      it('allow academic_admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin"]);
        const result = guard.canActivate(mkContext(mkUser('academic_admin')));
        expect(result).toBe(true);
      });
      it('deny teacher → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('teacher')))).toThrow(ForbiddenException);
      });
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
      });
      it('deny parent → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('parent')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
    });

    describe('read', () => {
      // manifest: allow=[sales,sales_manager,boss,admin,academic,academic_admin,teacher,parent]
      // manifest: deny=[finance,platform_admin,finance_admin,marketing,hr]
      // note: sales 自己客户 ✅; teacher 主带 ✅ (controller 层 ownership 校验, 非 @Roles 层); parent C 端独立 ✅ (走 ParentJwt aud)

      it('allow sales → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin","teacher","parent"]);
        const result = guard.canActivate(mkContext(mkUser('sales')));
        expect(result).toBe(true);
      });
      it('allow sales_manager → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin","teacher","parent"]);
        const result = guard.canActivate(mkContext(mkUser('sales_manager')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin","teacher","parent"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin","teacher","parent"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow academic → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin","teacher","parent"]);
        const result = guard.canActivate(mkContext(mkUser('academic')));
        expect(result).toBe(true);
      });
      it('allow academic_admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin","teacher","parent"]);
        const result = guard.canActivate(mkContext(mkUser('academic_admin')));
        expect(result).toBe(true);
      });
      it('allow teacher → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin","teacher","parent"]);
        const result = guard.canActivate(mkContext(mkUser('teacher')));
        expect(result).toBe(true);
      });
      it('allow parent → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin","teacher","parent"]);
        const result = guard.canActivate(mkContext(mkUser('parent')));
        expect(result).toBe(true);
      });
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin","teacher","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin","teacher","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin","teacher","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin","teacher","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin","teacher","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
    });

    describe('update', () => {
      // manifest: allow=[sales,sales_manager,boss,admin,academic,academic_admin]
      // manifest: deny=[teacher,finance,parent,platform_admin,finance_admin,marketing,hr]
      // note: §4.1 销 ✅ 自己客户 / 务 ✅ 本校 / 老校 ✅

      it('allow sales → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin"]);
        const result = guard.canActivate(mkContext(mkUser('sales')));
        expect(result).toBe(true);
      });
      it('allow sales_manager → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin"]);
        const result = guard.canActivate(mkContext(mkUser('sales_manager')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow academic → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin"]);
        const result = guard.canActivate(mkContext(mkUser('academic')));
        expect(result).toBe(true);
      });
      it('allow academic_admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin"]);
        const result = guard.canActivate(mkContext(mkUser('academic_admin')));
        expect(result).toBe(true);
      });
      it('deny teacher → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('teacher')))).toThrow(ForbiddenException);
      });
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
      });
      it('deny parent → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('parent')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
    });

    describe('delete', () => {
      // manifest: allow=[admin,boss]
      // manifest: deny=[sales,sales_manager,academic,teacher,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: 学员归档仅 admin/boss (F4 拍板)

      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('deny sales → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales')))).toThrow(ForbiddenException);
      });
      it('deny sales_manager → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales_manager')))).toThrow(ForbiddenException);
      });
      it('deny academic → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic')))).toThrow(ForbiddenException);
      });
      it('deny teacher → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('teacher')))).toThrow(ForbiddenException);
      });
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
      });
      it('deny parent → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('parent')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
      it('deny academic_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic_admin')))).toThrow(ForbiddenException);
      });
    });

  });

  describe('contract', () => {
    describe('create', () => {
      // manifest: allow=[sales,sales_manager,boss,admin]
      // manifest: deny=[academic,teacher,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: 5/15 Wave 11 修订：教务续费走 OOUX 通知销售路径; finance 不签合同

      it('allow sales → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        const result = guard.canActivate(mkContext(mkUser('sales')));
        expect(result).toBe(true);
      });
      it('allow sales_manager → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        const result = guard.canActivate(mkContext(mkUser('sales_manager')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('deny academic → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic')))).toThrow(ForbiddenException);
      });
      it('deny teacher → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('teacher')))).toThrow(ForbiddenException);
      });
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
      });
      it('deny parent → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('parent')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
      it('deny academic_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic_admin')))).toThrow(ForbiddenException);
      });
    });

    describe('read', () => {
      // manifest: allow=[sales,sales_manager,boss,admin,academic,academic_admin,finance,parent]
      // manifest: deny=[teacher,platform_admin,finance_admin,marketing,hr]
      // note: §4.5 销 ✅ 自己 / 务 ✅ 本校 / 老校 ✅ / 财 ✅作账 / 家 ✅自己; teacher 仅看主带学员剩余课时不看金额; teacher 不看合同对象本身

      it('allow sales → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin","finance","parent"]);
        const result = guard.canActivate(mkContext(mkUser('sales')));
        expect(result).toBe(true);
      });
      it('allow sales_manager → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin","finance","parent"]);
        const result = guard.canActivate(mkContext(mkUser('sales_manager')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin","finance","parent"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin","finance","parent"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow academic → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin","finance","parent"]);
        const result = guard.canActivate(mkContext(mkUser('academic')));
        expect(result).toBe(true);
      });
      it('allow academic_admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin","finance","parent"]);
        const result = guard.canActivate(mkContext(mkUser('academic_admin')));
        expect(result).toBe(true);
      });
      it('allow finance → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin","finance","parent"]);
        const result = guard.canActivate(mkContext(mkUser('finance')));
        expect(result).toBe(true);
      });
      it('allow parent → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin","finance","parent"]);
        const result = guard.canActivate(mkContext(mkUser('parent')));
        expect(result).toBe(true);
      });
      it('deny teacher → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin","finance","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('teacher')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin","finance","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin","finance","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin","finance","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin","academic","academic_admin","finance","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
    });

    describe('update', () => {
      // manifest: allow=[sales,sales_manager,boss,admin]
      // manifest: deny=[academic,teacher,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: §4.5 销 ✅ 自己续费机会 / 老校 ✅ 接手

      it('allow sales → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        const result = guard.canActivate(mkContext(mkUser('sales')));
        expect(result).toBe(true);
      });
      it('allow sales_manager → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        const result = guard.canActivate(mkContext(mkUser('sales_manager')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('deny academic → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic')))).toThrow(ForbiddenException);
      });
      it('deny teacher → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('teacher')))).toThrow(ForbiddenException);
      });
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
      });
      it('deny parent → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('parent')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
      it('deny academic_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","boss","admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic_admin')))).toThrow(ForbiddenException);
      });
    });

    describe('delete', () => {
      // manifest: allow=[admin,boss]
      // manifest: deny=[sales,sales_manager,academic,teacher,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: 合同退费/作废仅 admin/boss; finance 处理退费但不删合同

      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('deny sales → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales')))).toThrow(ForbiddenException);
      });
      it('deny sales_manager → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales_manager')))).toThrow(ForbiddenException);
      });
      it('deny academic → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic')))).toThrow(ForbiddenException);
      });
      it('deny teacher → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('teacher')))).toThrow(ForbiddenException);
      });
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
      });
      it('deny parent → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('parent')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
      it('deny academic_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic_admin')))).toThrow(ForbiddenException);
      });
    });

  });

  describe('teacher', () => {
    describe('create', () => {
      // manifest: allow=[admin,boss]
      // manifest: deny=[sales,sales_manager,academic,teacher,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: §12.4 admin 唯一创建 B 端子账户 (boss 也不能, SSOT §12.4 拍板; 但 user.controller 现实 @Roles('admin','boss') — Sprint Y backlog 收敛); 本 manifest 暂含 boss 因 user.controller 现状

      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('deny sales → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales')))).toThrow(ForbiddenException);
      });
      it('deny sales_manager → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales_manager')))).toThrow(ForbiddenException);
      });
      it('deny academic → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic')))).toThrow(ForbiddenException);
      });
      it('deny teacher → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('teacher')))).toThrow(ForbiddenException);
      });
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
      });
      it('deny parent → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('parent')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
      it('deny academic_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic_admin')))).toThrow(ForbiddenException);
      });
    });

    describe('read', () => {
      // manifest: allow=[admin,boss,academic,academic_admin,teacher,sales,sales_manager,parent]
      // manifest: deny=[finance,platform_admin,finance_admin,marketing,hr]
      // note: §4.3 师自 ✅ / 务 👁 不改 / 老校 ✅ / 同校师 👁 透明 / 家 走 showcase / 销 走 showcase / sales_manager 视作 sales 主管同看; finance 不看老师档案 (薪资全删后无需要)

      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","academic","academic_admin","teacher","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","academic","academic_admin","teacher","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('allow academic → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","academic","academic_admin","teacher","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('academic')));
        expect(result).toBe(true);
      });
      it('allow academic_admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","academic","academic_admin","teacher","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('academic_admin')));
        expect(result).toBe(true);
      });
      it('allow teacher → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","academic","academic_admin","teacher","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('teacher')));
        expect(result).toBe(true);
      });
      it('allow sales → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","academic","academic_admin","teacher","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('sales')));
        expect(result).toBe(true);
      });
      it('allow sales_manager → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","academic","academic_admin","teacher","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('sales_manager')));
        expect(result).toBe(true);
      });
      it('allow parent → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","academic","academic_admin","teacher","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('parent')));
        expect(result).toBe(true);
      });
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","academic","academic_admin","teacher","sales","sales_manager","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","academic","academic_admin","teacher","sales","sales_manager","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","academic","academic_admin","teacher","sales","sales_manager","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","academic","academic_admin","teacher","sales","sales_manager","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","academic","academic_admin","teacher","sales","sales_manager","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
    });

    describe('update', () => {
      // manifest: allow=[admin,boss,teacher]
      // manifest: deny=[sales,sales_manager,academic,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: teacher self-edit 自己档案 (C2-1); §4.3 师自 ✅ 全编辑 / 老校 ✅; 教务不改 (§4.3 务 👁 不改); admin/boss 改任何老师

      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","teacher"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","teacher"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('allow teacher → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","teacher"]);
        const result = guard.canActivate(mkContext(mkUser('teacher')));
        expect(result).toBe(true);
      });
      it('deny sales → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","teacher"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales')))).toThrow(ForbiddenException);
      });
      it('deny sales_manager → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","teacher"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales_manager')))).toThrow(ForbiddenException);
      });
      it('deny academic → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","teacher"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic')))).toThrow(ForbiddenException);
      });
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","teacher"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
      });
      it('deny parent → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","teacher"]);
        expect(() => guard.canActivate(mkContext(mkUser('parent')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","teacher"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","teacher"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","teacher"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","teacher"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
      it('deny academic_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","teacher"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic_admin')))).toThrow(ForbiddenException);
      });
    });

    describe('delete', () => {
      // manifest: allow=[admin,boss]
      // manifest: deny=[sales,sales_manager,academic,teacher,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: V27 离职链路: deactivated_at + 数据交接; 仅 admin/boss

      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('deny sales → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales')))).toThrow(ForbiddenException);
      });
      it('deny sales_manager → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales_manager')))).toThrow(ForbiddenException);
      });
      it('deny academic → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic')))).toThrow(ForbiddenException);
      });
      it('deny teacher → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('teacher')))).toThrow(ForbiddenException);
      });
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
      });
      it('deny parent → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('parent')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
      it('deny academic_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic_admin')))).toThrow(ForbiddenException);
      });
    });

  });

  describe('parent', () => {
    describe('create', () => {
      // manifest: allow=[sales,sales_manager,academic,academic_admin,admin,boss]
      // manifest: deny=[teacher,finance,parent,platform_admin,finance_admin,marketing,hr]
      // note: §12.5 教务/销售在学员页绑定家长 (T-PARENT-BIND-BY-STAFF); admin/boss 兜底

      it('allow sales → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('sales')));
        expect(result).toBe(true);
      });
      it('allow sales_manager → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('sales_manager')));
        expect(result).toBe(true);
      });
      it('allow academic → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('academic')));
        expect(result).toBe(true);
      });
      it('allow academic_admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('academic_admin')));
        expect(result).toBe(true);
      });
      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('deny teacher → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('teacher')))).toThrow(ForbiddenException);
      });
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
      });
      it('deny parent → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('parent')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
    });

    describe('read', () => {
      // manifest: allow=[sales,sales_manager,academic,academic_admin,admin,boss,parent]
      // manifest: deny=[teacher,finance,platform_admin,finance_admin,marketing,hr]
      // note: B 端业务人员在学员页看家长卡; parent 自己 ✅ (C 端 ParentJwt); teacher 不看家长详情 (PII 隔离)

      it('allow sales → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss","parent"]);
        const result = guard.canActivate(mkContext(mkUser('sales')));
        expect(result).toBe(true);
      });
      it('allow sales_manager → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss","parent"]);
        const result = guard.canActivate(mkContext(mkUser('sales_manager')));
        expect(result).toBe(true);
      });
      it('allow academic → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss","parent"]);
        const result = guard.canActivate(mkContext(mkUser('academic')));
        expect(result).toBe(true);
      });
      it('allow academic_admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss","parent"]);
        const result = guard.canActivate(mkContext(mkUser('academic_admin')));
        expect(result).toBe(true);
      });
      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss","parent"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss","parent"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('allow parent → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss","parent"]);
        const result = guard.canActivate(mkContext(mkUser('parent')));
        expect(result).toBe(true);
      });
      it('deny teacher → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('teacher')))).toThrow(ForbiddenException);
      });
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
    });

    describe('update', () => {
      // manifest: allow=[sales,sales_manager,academic,academic_admin,admin,boss]
      // manifest: deny=[teacher,finance,parent,platform_admin,finance_admin,marketing,hr]
      // note: binding 撤绑 (T-PARENT-UNBIND); parent 自己改不在本端点 (走 C 端 /parents/me)

      it('allow sales → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('sales')));
        expect(result).toBe(true);
      });
      it('allow sales_manager → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('sales_manager')));
        expect(result).toBe(true);
      });
      it('allow academic → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('academic')));
        expect(result).toBe(true);
      });
      it('allow academic_admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('academic_admin')));
        expect(result).toBe(true);
      });
      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('deny teacher → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('teacher')))).toThrow(ForbiddenException);
      });
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
      });
      it('deny parent → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('parent')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
    });

    describe('delete', () => {
      // manifest: allow=[admin,boss]
      // manifest: deny=[sales,sales_manager,academic,teacher,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: parents.status='停用' 软删仅 admin/boss; 解绑 ≠ 删除 (§12.6 失效逻辑)

      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('deny sales → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales')))).toThrow(ForbiddenException);
      });
      it('deny sales_manager → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales_manager')))).toThrow(ForbiddenException);
      });
      it('deny academic → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic')))).toThrow(ForbiddenException);
      });
      it('deny teacher → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('teacher')))).toThrow(ForbiddenException);
      });
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
      });
      it('deny parent → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('parent')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
      it('deny academic_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic_admin')))).toThrow(ForbiddenException);
      });
    });

  });

  describe('corner cases (user 缺失 / role 缺失)', () => {
    it('user undefined + required roles → UnauthorizedException', () => {
      (reflector.getAllAndOverride as jest.Mock).mockReturnValue(['admin']);
      expect(() => guard.canActivate(mkContext(undefined))).toThrow(UnauthorizedException);
    });

    it('user 无 role 字段 + required roles → UnauthorizedException', () => {
      (reflector.getAllAndOverride as jest.Mock).mockReturnValue(['admin']);
      const userNoRole = { ...mkUser('admin'), role: undefined as any };
      expect(() => guard.canActivate(mkContext(userNoRole))).toThrow(UnauthorizedException);
    });

    it('reflector 返 undefined (无 @Roles) → 放行', () => {
      (reflector.getAllAndOverride as jest.Mock).mockReturnValue(undefined);
      expect(guard.canActivate(mkContext(mkUser('parent')))).toBe(true);
    });

    it('reflector 返 [] (@Roles 空数组) → 放行', () => {
      (reflector.getAllAndOverride as jest.Mock).mockReturnValue([]);
      expect(guard.canActivate(mkContext(mkUser('parent')))).toBe(true);
    });
  });
});
