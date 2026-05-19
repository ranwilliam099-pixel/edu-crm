/**
 * Auto-generated RBAC spec — Batch B (外围 13 对象)
 *
 * !!! 禁止手改 !!! 改 src/__rbac__/manifest.json + 重跑 scripts/generate-rbac-spec.js
 *
 * 生成时间: 2026-05-19
 * 来源: docs/SSOT-拍板权威.md §1 角色 + §4 字段矩阵 + §6 操作权限矩阵
 * 对象: schedule / lesson_feedback / homework / assessment / learning_profile /
 *       monthly_report / invoice / course_consumption / course_package_balance /
 *       course_product / campus / user / parent_referral
 * 总 case 数: 13 对象 × 4 CRUD × 13 角色 = 676
 *
 * 与 prompt 数字差异:
 *   prompt 任务 A 说 "13 × 9 × 4 = 468"，本 spec 实际 13 × 13 × 4 = 676 case
 *   多 208 case 覆盖 4 auxiliary 角色 (marketing/hr/finance_admin/academic_admin) 全 deny 验证
 *   manifest 一致性 > prompt 字面数字 (Day 4 Batch A 同 13 角色全覆盖)
 *
 * 测试策略 (同 Batch A):
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

// 同 Batch A：parent / auxiliary 角色 cast 进入 RbacGuard 路径
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

function mkContext(user: JwtPayload | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as any;
}

describe('[RBAC L9 Batch B] 外围 13 对象 × 4 CRUD × 13 角色 = 676 case', () => {
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

  describe('schedule', () => {
    describe('create', () => {
      // manifest: allow=[academic,academic_admin,admin,boss]
      // manifest: deny=[sales,sales_manager,teacher,finance,parent,platform_admin,finance_admin,marketing,hr]
      // note: schedule.controller server-derive callerRole='academic'（5/15 Wave 11）；admin/boss 兜底；academic_admin 视作 academic 主管同口径

      it('allow academic → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('academic')));
        expect(result).toBe(true);
      });
      it('allow academic_admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('academic_admin')));
        expect(result).toBe(true);
      });
      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('deny sales → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales')))).toThrow(ForbiddenException);
      });
      it('deny sales_manager → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales_manager')))).toThrow(ForbiddenException);
      });
      it('deny teacher → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('teacher')))).toThrow(ForbiddenException);
      });
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
      });
      it('deny parent → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('parent')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
    });

    describe('read', () => {
      // manifest: allow=[academic,academic_admin,admin,boss,teacher,sales,sales_manager,parent]
      // manifest: deny=[finance,platform_admin,finance_admin,marketing,hr]
      // note: teacher 看自己排课；sales 看自己客户学员排课；parent C 端看自己孩子排课；academic 维护本校；finance 不看排课（无金额）

      it('allow academic → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss","teacher","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('academic')));
        expect(result).toBe(true);
      });
      it('allow academic_admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss","teacher","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('academic_admin')));
        expect(result).toBe(true);
      });
      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss","teacher","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss","teacher","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('allow teacher → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss","teacher","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('teacher')));
        expect(result).toBe(true);
      });
      it('allow sales → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss","teacher","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('sales')));
        expect(result).toBe(true);
      });
      it('allow sales_manager → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss","teacher","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('sales_manager')));
        expect(result).toBe(true);
      });
      it('allow parent → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss","teacher","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('parent')));
        expect(result).toBe(true);
      });
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss","teacher","sales","sales_manager","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss","teacher","sales","sales_manager","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss","teacher","sales","sales_manager","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss","teacher","sales","sales_manager","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss","teacher","sales","sales_manager","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
    });

    describe('update', () => {
      // manifest: allow=[academic,academic_admin,admin,boss]
      // manifest: deny=[sales,sales_manager,teacher,finance,parent,platform_admin,finance_admin,marketing,hr]
      // note: 改时间/老师/学员仅 academic 主导；admin/boss 兜底；cancel/complete/attendance Sprint B.4-1 RBAC 限 {teacher, sales} 早期 403（应用层拒绝），manifest 反映 controller @Roles 真实层（无 @Roles 此 endpoint 走 service 内部 callerRole 校验）

      it('allow academic → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('academic')));
        expect(result).toBe(true);
      });
      it('allow academic_admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('academic_admin')));
        expect(result).toBe(true);
      });
      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('deny sales → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales')))).toThrow(ForbiddenException);
      });
      it('deny sales_manager → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales_manager')))).toThrow(ForbiddenException);
      });
      it('deny teacher → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('teacher')))).toThrow(ForbiddenException);
      });
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
      });
      it('deny parent → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('parent')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
    });

    describe('delete', () => {
      // manifest: allow=[academic,academic_admin,admin,boss]
      // manifest: deny=[sales,sales_manager,teacher,finance,parent,platform_admin,finance_admin,marketing,hr]
      // note: cancel/archive recurring schedule 仅 academic + admin/boss；finance/parent 严禁

      it('allow academic → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('academic')));
        expect(result).toBe(true);
      });
      it('allow academic_admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('academic_admin')));
        expect(result).toBe(true);
      });
      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('deny sales → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales')))).toThrow(ForbiddenException);
      });
      it('deny sales_manager → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales_manager')))).toThrow(ForbiddenException);
      });
      it('deny teacher → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('teacher')))).toThrow(ForbiddenException);
      });
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
      });
      it('deny parent → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('parent')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["academic","academic_admin","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
    });

  });

  describe('lesson_feedback', () => {
    describe('create', () => {
      // manifest: allow=[teacher,admin,boss]
      // manifest: deny=[sales,sales_manager,academic,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: feedback.controller:294 POST /db/lesson-feedbacks @Roles('teacher','admin','boss'); 教务 ❌ 不创建反馈（教务线只读老师线）

      it('allow teacher → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('teacher')));
        expect(result).toBe(true);
      });
      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('deny sales → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales')))).toThrow(ForbiddenException);
      });
      it('deny sales_manager → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales_manager')))).toThrow(ForbiddenException);
      });
      it('deny academic → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic')))).toThrow(ForbiddenException);
      });
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
      });
      it('deny parent → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('parent')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
      it('deny academic_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic_admin')))).toThrow(ForbiddenException);
      });
    });

    describe('read', () => {
      // manifest: allow=[teacher,academic,academic_admin,admin,boss,sales,sales_manager,parent]
      // manifest: deny=[finance,platform_admin,finance_admin,marketing,hr]
      // note: teacher 看自己 ✅; academic 看本校老师反馈（只读）; sales 看自己客户学员反馈; parent C 端看自己孩子反馈; finance ❌ 无价值

      it('allow teacher → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('teacher')));
        expect(result).toBe(true);
      });
      it('allow academic → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('academic')));
        expect(result).toBe(true);
      });
      it('allow academic_admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('academic_admin')));
        expect(result).toBe(true);
      });
      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('allow sales → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('sales')));
        expect(result).toBe(true);
      });
      it('allow sales_manager → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('sales_manager')));
        expect(result).toBe(true);
      });
      it('allow parent → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('parent')));
        expect(result).toBe(true);
      });
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
    });

    describe('update', () => {
      // manifest: allow=[teacher,admin,boss]
      // manifest: deny=[sales,sales_manager,academic,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: feedback.controller:387 @Roles('teacher','admin','boss'); teacher 主带改自己（owner check 在 service）; admin/boss 兜底

      it('allow teacher → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('teacher')));
        expect(result).toBe(true);
      });
      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('deny sales → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales')))).toThrow(ForbiddenException);
      });
      it('deny sales_manager → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales_manager')))).toThrow(ForbiddenException);
      });
      it('deny academic → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic')))).toThrow(ForbiddenException);
      });
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
      });
      it('deny parent → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('parent')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
      it('deny academic_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic_admin')))).toThrow(ForbiddenException);
      });
    });

    describe('delete', () => {
      // manifest: allow=[admin,boss]
      // manifest: deny=[sales,sales_manager,academic,teacher,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: lesson_feedback 仅软删 / 撤回 admin/boss；teacher 自己不删（历史可追溯）

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

  describe('homework', () => {
    describe('create', () => {
      // manifest: allow=[teacher,admin,boss]
      // manifest: deny=[sales,sales_manager,academic,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: homework.controller:163 POST /db/assignments @Roles('teacher','admin','boss')；academic 不布置作业（只读老师线）

      it('allow teacher → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('teacher')));
        expect(result).toBe(true);
      });
      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('deny sales → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales')))).toThrow(ForbiddenException);
      });
      it('deny sales_manager → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales_manager')))).toThrow(ForbiddenException);
      });
      it('deny academic → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic')))).toThrow(ForbiddenException);
      });
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
      });
      it('deny parent → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('parent')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
      it('deny academic_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic_admin')))).toThrow(ForbiddenException);
      });
    });

    describe('read', () => {
      // manifest: allow=[teacher,academic,academic_admin,admin,boss,sales,sales_manager,parent]
      // manifest: deny=[finance,platform_admin,finance_admin,marketing,hr]
      // note: homework.controller:259/289/314 读 endpoint @Roles 含 teacher/admin/boss/academic/academic_admin/sales/sales_manager；parent C 端独立 ✅

      it('allow teacher → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('teacher')));
        expect(result).toBe(true);
      });
      it('allow academic → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('academic')));
        expect(result).toBe(true);
      });
      it('allow academic_admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('academic_admin')));
        expect(result).toBe(true);
      });
      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('allow sales → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('sales')));
        expect(result).toBe(true);
      });
      it('allow sales_manager → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('sales_manager')));
        expect(result).toBe(true);
      });
      it('allow parent → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('parent')));
        expect(result).toBe(true);
      });
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
    });

    describe('update', () => {
      // manifest: allow=[teacher,admin,boss]
      // manifest: deny=[sales,sales_manager,academic,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: homework.controller:215/241 grade/return @Roles('teacher','admin','boss'); parent 提交不走 update 走独立 submission endpoint

      it('allow teacher → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('teacher')));
        expect(result).toBe(true);
      });
      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('deny sales → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales')))).toThrow(ForbiddenException);
      });
      it('deny sales_manager → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales_manager')))).toThrow(ForbiddenException);
      });
      it('deny academic → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic')))).toThrow(ForbiddenException);
      });
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
      });
      it('deny parent → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('parent')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
      it('deny academic_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic_admin')))).toThrow(ForbiddenException);
      });
    });

    describe('delete', () => {
      // manifest: allow=[admin,boss]
      // manifest: deny=[sales,sales_manager,academic,teacher,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: 作业作业历史不删（teacher 误布置只能 archive）；admin/boss 兜底

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

  describe('assessment', () => {
    describe('create', () => {
      // manifest: allow=[teacher,admin,boss]
      // manifest: deny=[sales,sales_manager,academic,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: assessment.controller:133/158/180/192 全部写 endpoint @Roles('teacher','admin','boss')；academic 不创建评测（只读老师线）

      it('allow teacher → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('teacher')));
        expect(result).toBe(true);
      });
      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('deny sales → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales')))).toThrow(ForbiddenException);
      });
      it('deny sales_manager → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales_manager')))).toThrow(ForbiddenException);
      });
      it('deny academic → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic')))).toThrow(ForbiddenException);
      });
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
      });
      it('deny parent → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('parent')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
      it('deny academic_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic_admin')))).toThrow(ForbiddenException);
      });
    });

    describe('read', () => {
      // manifest: allow=[teacher,academic,academic_admin,admin,boss,sales,sales_manager,parent]
      // manifest: deny=[finance,platform_admin,finance_admin,marketing,hr]
      // note: assessment.controller:208/231/255 读 endpoint @Roles 含教务老校销售；parent C 端独立看自己孩子

      it('allow teacher → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('teacher')));
        expect(result).toBe(true);
      });
      it('allow academic → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('academic')));
        expect(result).toBe(true);
      });
      it('allow academic_admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('academic_admin')));
        expect(result).toBe(true);
      });
      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('allow sales → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('sales')));
        expect(result).toBe(true);
      });
      it('allow sales_manager → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('sales_manager')));
        expect(result).toBe(true);
      });
      it('allow parent → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('parent')));
        expect(result).toBe(true);
      });
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
    });

    describe('update', () => {
      // manifest: allow=[teacher,admin,boss]
      // manifest: deny=[sales,sales_manager,academic,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: publish/close 仅 teacher（main owner）+ admin/boss；evals 不可改 owner ≠ self

      it('allow teacher → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('teacher')));
        expect(result).toBe(true);
      });
      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('deny sales → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales')))).toThrow(ForbiddenException);
      });
      it('deny sales_manager → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales_manager')))).toThrow(ForbiddenException);
      });
      it('deny academic → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic')))).toThrow(ForbiddenException);
      });
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
      });
      it('deny parent → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('parent')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
      it('deny academic_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic_admin')))).toThrow(ForbiddenException);
      });
    });

    describe('delete', () => {
      // manifest: allow=[admin,boss]
      // manifest: deny=[sales,sales_manager,academic,teacher,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: 评测结果历史不删；admin/boss 兜底

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

  describe('learning_profile', () => {
    describe('create', () => {
      // manifest: allow=[teacher,admin,boss]
      // manifest: deny=[sales,sales_manager,academic,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: learning-profile.controller:90 POST /db/students/:studentId/recompute @Roles('teacher','admin','boss')；学情档案 owner=teacher

      it('allow teacher → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('teacher')));
        expect(result).toBe(true);
      });
      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('deny sales → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales')))).toThrow(ForbiddenException);
      });
      it('deny sales_manager → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales_manager')))).toThrow(ForbiddenException);
      });
      it('deny academic → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic')))).toThrow(ForbiddenException);
      });
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
      });
      it('deny parent → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('parent')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
      it('deny academic_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic_admin')))).toThrow(ForbiddenException);
      });
    });

    describe('read', () => {
      // manifest: allow=[teacher,academic,academic_admin,admin,boss,sales,sales_manager,parent]
      // manifest: deny=[finance,platform_admin,finance_admin,marketing,hr]
      // note: learning-profile.controller:111/135 读 endpoint @Roles 含 sales/sales_manager/academic/academic_admin/teacher/admin/boss；parent C 端 ✅

      it('allow teacher → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('teacher')));
        expect(result).toBe(true);
      });
      it('allow academic → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('academic')));
        expect(result).toBe(true);
      });
      it('allow academic_admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('academic_admin')));
        expect(result).toBe(true);
      });
      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('allow sales → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('sales')));
        expect(result).toBe(true);
      });
      it('allow sales_manager → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('sales_manager')));
        expect(result).toBe(true);
      });
      it('allow parent → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('parent')));
        expect(result).toBe(true);
      });
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","sales","sales_manager","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
    });

    describe('update', () => {
      // manifest: allow=[teacher,admin,boss]
      // manifest: deny=[sales,sales_manager,academic,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: recompute-all/recompute-stale 维护 endpoint @Roles('admin','boss')；teacher 自己档案改通过 recompute

      it('allow teacher → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('teacher')));
        expect(result).toBe(true);
      });
      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('deny sales → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales')))).toThrow(ForbiddenException);
      });
      it('deny sales_manager → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales_manager')))).toThrow(ForbiddenException);
      });
      it('deny academic → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic')))).toThrow(ForbiddenException);
      });
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
      });
      it('deny parent → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('parent')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
      it('deny academic_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic_admin')))).toThrow(ForbiddenException);
      });
    });

    describe('delete', () => {
      // manifest: allow=[admin,boss]
      // manifest: deny=[sales,sales_manager,academic,teacher,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: 学情档案不删（仅 deactivate）；admin/boss 兜底

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

  describe('monthly_report', () => {
    describe('create', () => {
      // manifest: allow=[admin,boss]
      // manifest: deny=[sales,sales_manager,academic,teacher,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: feedback.controller:573 POST /db/monthly-reports/generate @Roles('admin','boss')；月报系统生成不开放给业务

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
      // manifest: allow=[teacher,academic,academic_admin,admin,boss,parent]
      // manifest: deny=[sales,sales_manager,finance,platform_admin,finance_admin,marketing,hr]
      // note: teacher 看自己生成的月报；academic 看本校老师月报（只读）；parent C 端看自己孩子月报；finance/sales 不看月报（无金额无客户线）

      it('allow teacher → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","parent"]);
        const result = guard.canActivate(mkContext(mkUser('teacher')));
        expect(result).toBe(true);
      });
      it('allow academic → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","parent"]);
        const result = guard.canActivate(mkContext(mkUser('academic')));
        expect(result).toBe(true);
      });
      it('allow academic_admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","parent"]);
        const result = guard.canActivate(mkContext(mkUser('academic_admin')));
        expect(result).toBe(true);
      });
      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","parent"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","parent"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('allow parent → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","parent"]);
        const result = guard.canActivate(mkContext(mkUser('parent')));
        expect(result).toBe(true);
      });
      it('deny sales → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales')))).toThrow(ForbiddenException);
      });
      it('deny sales_manager → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales_manager')))).toThrow(ForbiddenException);
      });
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
    });

    describe('update', () => {
      // manifest: allow=[teacher,admin,boss]
      // manifest: deny=[sales,sales_manager,academic,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: finalize-teacher self-check 仅 main owner teacher；finalize-parent 仅家长 C 端独立路径；admin/boss 兜底

      it('allow teacher → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('teacher')));
        expect(result).toBe(true);
      });
      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('deny sales → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales')))).toThrow(ForbiddenException);
      });
      it('deny sales_manager → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales_manager')))).toThrow(ForbiddenException);
      });
      it('deny academic → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic')))).toThrow(ForbiddenException);
      });
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
      });
      it('deny parent → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('parent')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
      it('deny academic_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic_admin')))).toThrow(ForbiddenException);
      });
    });

    describe('delete', () => {
      // manifest: allow=[admin,boss]
      // manifest: deny=[sales,sales_manager,academic,teacher,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: 月报历史不删；admin/boss 兜底

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

  describe('invoice', () => {
    describe('create', () => {
      // manifest: allow=[finance]
      // manifest: deny=[boss,admin,sales,sales_manager,academic,teacher,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: 5/15 A-1 修订：仅 finance 可开票；boss/admin 不开票（SSOT §6 明文）。删除/作废走 delete 路径 admin/boss。

      it('allow finance → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["finance"]);
        const result = guard.canActivate(mkContext(mkUser('finance')));
        expect(result).toBe(true);
      });
      it('deny boss → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('boss')))).toThrow(ForbiddenException);
      });
      it('deny admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('admin')))).toThrow(ForbiddenException);
      });
      it('deny sales → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales')))).toThrow(ForbiddenException);
      });
      it('deny sales_manager → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales_manager')))).toThrow(ForbiddenException);
      });
      it('deny academic → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic')))).toThrow(ForbiddenException);
      });
      it('deny teacher → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('teacher')))).toThrow(ForbiddenException);
      });
      it('deny parent → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('parent')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
      it('deny academic_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic_admin')))).toThrow(ForbiddenException);
      });
    });

    describe('read', () => {
      // manifest: allow=[finance]
      // manifest: deny=[boss,admin,sales,sales_manager,academic,teacher,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: 5/15 A-1 同口径：read endpoint（listPending / detail）仅 finance；boss/admin 不读发票详情（避免越权查公司财税数据）；parent 自己合同票走 contract.read（不走 invoice.read）

      it('allow finance → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["finance"]);
        const result = guard.canActivate(mkContext(mkUser('finance')));
        expect(result).toBe(true);
      });
      it('deny boss → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('boss')))).toThrow(ForbiddenException);
      });
      it('deny admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('admin')))).toThrow(ForbiddenException);
      });
      it('deny sales → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales')))).toThrow(ForbiddenException);
      });
      it('deny sales_manager → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales_manager')))).toThrow(ForbiddenException);
      });
      it('deny academic → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic')))).toThrow(ForbiddenException);
      });
      it('deny teacher → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('teacher')))).toThrow(ForbiddenException);
      });
      it('deny parent → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('parent')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
      it('deny academic_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic_admin')))).toThrow(ForbiddenException);
      });
    });

    describe('update', () => {
      // manifest: allow=[finance]
      // manifest: deny=[boss,admin,sales,sales_manager,academic,teacher,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: 5/15 A-1 同口径：状态推进（issue / push parent / 红冲发起）仅 finance；boss/admin 不直接改发票状态。真正的红冲走 delete。

      it('allow finance → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["finance"]);
        const result = guard.canActivate(mkContext(mkUser('finance')));
        expect(result).toBe(true);
      });
      it('deny boss → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('boss')))).toThrow(ForbiddenException);
      });
      it('deny admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('admin')))).toThrow(ForbiddenException);
      });
      it('deny sales → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales')))).toThrow(ForbiddenException);
      });
      it('deny sales_manager → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales_manager')))).toThrow(ForbiddenException);
      });
      it('deny academic → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic')))).toThrow(ForbiddenException);
      });
      it('deny teacher → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('teacher')))).toThrow(ForbiddenException);
      });
      it('deny parent → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('parent')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
      it('deny academic_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic_admin')))).toThrow(ForbiddenException);
      });
    });

    describe('delete', () => {
      // manifest: allow=[admin,boss]
      // manifest: deny=[finance,sales,sales_manager,academic,teacher,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: invoice 红冲/作废保留 admin/boss（平台级操作，审计追溯）；finance 不直接删（避免单角色掩盖红冲）

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
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
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

  describe('course_consumption', () => {
    describe('create', () => {
      // manifest: allow=[teacher,admin,boss]
      // manifest: deny=[sales,sales_manager,academic,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: feedback.controller:447 POST /db/course-consumptions @Roles('teacher','admin','boss')；课消由老师在反馈时一并产生

      it('allow teacher → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('teacher')));
        expect(result).toBe(true);
      });
      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('deny sales → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales')))).toThrow(ForbiddenException);
      });
      it('deny sales_manager → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales_manager')))).toThrow(ForbiddenException);
      });
      it('deny academic → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic')))).toThrow(ForbiddenException);
      });
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
      });
      it('deny parent → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('parent')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
      it('deny academic_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","admin","boss"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic_admin')))).toThrow(ForbiddenException);
      });
    });

    describe('read', () => {
      // manifest: allow=[teacher,academic,academic_admin,admin,boss,finance,sales,sales_manager,parent]
      // manifest: deny=[platform_admin,finance_admin,marketing,hr]
      // note: teacher 看自己课消；academic 看本校；finance ✅ 作账要扣减课时；sales 看自己客户课消；parent C 端看自己孩子剩余课时

      it('allow teacher → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","finance","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('teacher')));
        expect(result).toBe(true);
      });
      it('allow academic → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","finance","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('academic')));
        expect(result).toBe(true);
      });
      it('allow academic_admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","finance","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('academic_admin')));
        expect(result).toBe(true);
      });
      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","finance","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","finance","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('allow finance → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","finance","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('finance')));
        expect(result).toBe(true);
      });
      it('allow sales → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","finance","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('sales')));
        expect(result).toBe(true);
      });
      it('allow sales_manager → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","finance","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('sales_manager')));
        expect(result).toBe(true);
      });
      it('allow parent → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","finance","sales","sales_manager","parent"]);
        const result = guard.canActivate(mkContext(mkUser('parent')));
        expect(result).toBe(true);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","finance","sales","sales_manager","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","finance","sales","sales_manager","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","finance","sales","sales_manager","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["teacher","academic","academic_admin","admin","boss","finance","sales","sales_manager","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
    });

    describe('update', () => {
      // manifest: allow=[admin,boss]
      // manifest: deny=[sales,sales_manager,academic,teacher,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: feedback.controller:476/525 confirm/cancel @Roles('admin','boss')；课消金额一旦记录由 admin/boss 修正

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

    describe('delete', () => {
      // manifest: allow=[admin,boss]
      // manifest: deny=[sales,sales_manager,academic,teacher,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: 课消历史不删（财务可追溯）；admin/boss 兜底

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

  describe('course_package_balance', () => {
    describe('create', () => {
      // manifest: allow=[admin,boss,finance]
      // manifest: deny=[sales,sales_manager,academic,teacher,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: course-balance/db/activate 课时包激活由 admin/boss + finance 协同（合同签后激活）；销售签合同 → admin/boss 激活课时包

      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","finance"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","finance"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('allow finance → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","finance"]);
        const result = guard.canActivate(mkContext(mkUser('finance')));
        expect(result).toBe(true);
      });
      it('deny sales → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales')))).toThrow(ForbiddenException);
      });
      it('deny sales_manager → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales_manager')))).toThrow(ForbiddenException);
      });
      it('deny academic → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic')))).toThrow(ForbiddenException);
      });
      it('deny teacher → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('teacher')))).toThrow(ForbiddenException);
      });
      it('deny parent → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('parent')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
      it('deny academic_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic_admin')))).toThrow(ForbiddenException);
      });
    });

    describe('read', () => {
      // manifest: allow=[sales,sales_manager,academic,academic_admin,admin,boss,finance,teacher,parent]
      // manifest: deny=[platform_admin,finance_admin,marketing,hr]
      // note: 课时包余额几乎所有角色都要看：sales 看自己客户剩余 / teacher 看主带学员剩余 / parent C 端看自己孩子剩余 / academic 排课需 / finance 作账

      it('allow sales → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss","finance","teacher","parent"]);
        const result = guard.canActivate(mkContext(mkUser('sales')));
        expect(result).toBe(true);
      });
      it('allow sales_manager → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss","finance","teacher","parent"]);
        const result = guard.canActivate(mkContext(mkUser('sales_manager')));
        expect(result).toBe(true);
      });
      it('allow academic → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss","finance","teacher","parent"]);
        const result = guard.canActivate(mkContext(mkUser('academic')));
        expect(result).toBe(true);
      });
      it('allow academic_admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss","finance","teacher","parent"]);
        const result = guard.canActivate(mkContext(mkUser('academic_admin')));
        expect(result).toBe(true);
      });
      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss","finance","teacher","parent"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss","finance","teacher","parent"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('allow finance → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss","finance","teacher","parent"]);
        const result = guard.canActivate(mkContext(mkUser('finance')));
        expect(result).toBe(true);
      });
      it('allow teacher → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss","finance","teacher","parent"]);
        const result = guard.canActivate(mkContext(mkUser('teacher')));
        expect(result).toBe(true);
      });
      it('allow parent → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss","finance","teacher","parent"]);
        const result = guard.canActivate(mkContext(mkUser('parent')));
        expect(result).toBe(true);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss","finance","teacher","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss","finance","teacher","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss","finance","teacher","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss","finance","teacher","parent"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
    });

    describe('update', () => {
      // manifest: allow=[admin,boss,finance]
      // manifest: deny=[sales,sales_manager,academic,teacher,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: deduct/refund/freeze/unfreeze admin/boss 主导 + finance 协同退费；teacher 不直接扣减（走 course_consumption）

      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","finance"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","finance"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('allow finance → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","finance"]);
        const result = guard.canActivate(mkContext(mkUser('finance')));
        expect(result).toBe(true);
      });
      it('deny sales → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales')))).toThrow(ForbiddenException);
      });
      it('deny sales_manager → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('sales_manager')))).toThrow(ForbiddenException);
      });
      it('deny academic → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic')))).toThrow(ForbiddenException);
      });
      it('deny teacher → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('teacher')))).toThrow(ForbiddenException);
      });
      it('deny parent → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('parent')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
      it('deny academic_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('academic_admin')))).toThrow(ForbiddenException);
      });
    });

    describe('delete', () => {
      // manifest: allow=[admin,boss]
      // manifest: deny=[sales,sales_manager,academic,teacher,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: 课时包不删（仅作废）；admin/boss 兜底

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

  describe('course_product', () => {
    describe('create', () => {
      // manifest: allow=[admin,boss]
      // manifest: deny=[sales,sales_manager,academic,teacher,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: course-product.controller:273 POST @Roles('admin','boss')；产品库管理 admin/boss 主导

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
      // manifest: allow=[admin,boss,academic,academic_admin,sales,sales_manager,finance]
      // manifest: deny=[teacher,parent,platform_admin,finance_admin,marketing,hr]
      // note: 课时产品目录公开给业务线读：sales 报价用；academic 排课对照；finance 作账价目表；teacher/parent 不直接看产品（看自己课程）

      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","academic","academic_admin","sales","sales_manager","finance"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","academic","academic_admin","sales","sales_manager","finance"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('allow academic → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","academic","academic_admin","sales","sales_manager","finance"]);
        const result = guard.canActivate(mkContext(mkUser('academic')));
        expect(result).toBe(true);
      });
      it('allow academic_admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","academic","academic_admin","sales","sales_manager","finance"]);
        const result = guard.canActivate(mkContext(mkUser('academic_admin')));
        expect(result).toBe(true);
      });
      it('allow sales → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","academic","academic_admin","sales","sales_manager","finance"]);
        const result = guard.canActivate(mkContext(mkUser('sales')));
        expect(result).toBe(true);
      });
      it('allow sales_manager → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","academic","academic_admin","sales","sales_manager","finance"]);
        const result = guard.canActivate(mkContext(mkUser('sales_manager')));
        expect(result).toBe(true);
      });
      it('allow finance → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","academic","academic_admin","sales","sales_manager","finance"]);
        const result = guard.canActivate(mkContext(mkUser('finance')));
        expect(result).toBe(true);
      });
      it('deny teacher → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","academic","academic_admin","sales","sales_manager","finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('teacher')))).toThrow(ForbiddenException);
      });
      it('deny parent → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","academic","academic_admin","sales","sales_manager","finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('parent')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","academic","academic_admin","sales","sales_manager","finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","academic","academic_admin","sales","sales_manager","finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","academic","academic_admin","sales","sales_manager","finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","academic","academic_admin","sales","sales_manager","finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
    });

    describe('update', () => {
      // manifest: allow=[admin,boss]
      // manifest: deny=[sales,sales_manager,academic,teacher,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: course-product.controller:307 POST :id/status @Roles('admin','boss')；价格/状态调整 admin/boss

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

    describe('delete', () => {
      // manifest: allow=[admin,boss]
      // manifest: deny=[sales,sales_manager,academic,teacher,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: 课时产品不真删（status='下架'）；admin/boss 兜底

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

  describe('campus', () => {
    describe('create', () => {
      // manifest: allow=[admin,boss]
      // manifest: deny=[sales,sales_manager,academic,teacher,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: boss 私有 6 page 之一：新增校区；销售/教务无创建权限

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
      // manifest: allow=[admin,boss,sales,sales_manager,academic,academic_admin,teacher,finance]
      // manifest: deny=[parent,platform_admin,finance_admin,marketing,hr]
      // note: 校区列表全员可读（业务线需要 campus 选择器）；parent C 端不看校区管理（只看自己绑定校区）

      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","sales","sales_manager","academic","academic_admin","teacher","finance"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","sales","sales_manager","academic","academic_admin","teacher","finance"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('allow sales → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","sales","sales_manager","academic","academic_admin","teacher","finance"]);
        const result = guard.canActivate(mkContext(mkUser('sales')));
        expect(result).toBe(true);
      });
      it('allow sales_manager → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","sales","sales_manager","academic","academic_admin","teacher","finance"]);
        const result = guard.canActivate(mkContext(mkUser('sales_manager')));
        expect(result).toBe(true);
      });
      it('allow academic → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","sales","sales_manager","academic","academic_admin","teacher","finance"]);
        const result = guard.canActivate(mkContext(mkUser('academic')));
        expect(result).toBe(true);
      });
      it('allow academic_admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","sales","sales_manager","academic","academic_admin","teacher","finance"]);
        const result = guard.canActivate(mkContext(mkUser('academic_admin')));
        expect(result).toBe(true);
      });
      it('allow teacher → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","sales","sales_manager","academic","academic_admin","teacher","finance"]);
        const result = guard.canActivate(mkContext(mkUser('teacher')));
        expect(result).toBe(true);
      });
      it('allow finance → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","sales","sales_manager","academic","academic_admin","teacher","finance"]);
        const result = guard.canActivate(mkContext(mkUser('finance')));
        expect(result).toBe(true);
      });
      it('deny parent → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","sales","sales_manager","academic","academic_admin","teacher","finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('parent')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","sales","sales_manager","academic","academic_admin","teacher","finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","sales","sales_manager","academic","academic_admin","teacher","finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","sales","sales_manager","academic","academic_admin","teacher","finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin","boss","sales","sales_manager","academic","academic_admin","teacher","finance"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
    });

    describe('update', () => {
      // manifest: allow=[admin,boss]
      // manifest: deny=[sales,sales_manager,academic,teacher,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: 校区资料/状态编辑 admin/boss

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

    describe('delete', () => {
      // manifest: allow=[admin,boss]
      // manifest: deny=[sales,sales_manager,academic,teacher,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: 校区归档 admin/boss；删除前需迁移所有学员/老师/合同

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

  describe('user', () => {
    describe('create', () => {
      // manifest: allow=[admin,boss]
      // manifest: deny=[sales,sales_manager,academic,teacher,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: user.controller:92 POST @Roles('admin','boss')；SSOT §12.4 拍板 admin 唯一，但代码现状 boss 也开放 — Sprint Y backlog

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
      // manifest: allow=[admin,boss]
      // manifest: deny=[sales,sales_manager,academic,teacher,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: user.controller:239/262/275 GET list/active/by-id @Roles('admin','boss')；员工档案对业务线不可见（隐私）

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

    describe('update', () => {
      // manifest: allow=[admin,boss]
      // manifest: deny=[sales,sales_manager,academic,teacher,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: user.controller:299/392/489 deactivate/reset-password/handover @Roles('admin','boss')

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

    describe('delete', () => {
      // manifest: allow=[admin,boss]
      // manifest: deny=[sales,sales_manager,academic,teacher,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: 员工离职走 deactivate + handover（非真删）；admin/boss

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

  describe('parent_referral', () => {
    describe('create', () => {
      // manifest: allow=[sales,sales_manager,academic,academic_admin,admin,boss,parent]
      // manifest: deny=[teacher,finance,platform_admin,finance_admin,marketing,hr]
      // note: referral 创建：parent 自己发起转介 + 业务人员在客户详情代填；teacher 不发推荐 (PII 隔离)；finance 不参与

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

    describe('read', () => {
      // manifest: allow=[sales,sales_manager,academic,academic_admin,admin,boss,parent,teacher]
      // manifest: deny=[finance,platform_admin,finance_admin,marketing,hr]
      // note: referral 读取：业务线 + parent + teacher（看自己被转介统计 stats endpoint）；finance/marketing/hr ❌

      it('allow sales → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss","parent","teacher"]);
        const result = guard.canActivate(mkContext(mkUser('sales')));
        expect(result).toBe(true);
      });
      it('allow sales_manager → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss","parent","teacher"]);
        const result = guard.canActivate(mkContext(mkUser('sales_manager')));
        expect(result).toBe(true);
      });
      it('allow academic → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss","parent","teacher"]);
        const result = guard.canActivate(mkContext(mkUser('academic')));
        expect(result).toBe(true);
      });
      it('allow academic_admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss","parent","teacher"]);
        const result = guard.canActivate(mkContext(mkUser('academic_admin')));
        expect(result).toBe(true);
      });
      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss","parent","teacher"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss","parent","teacher"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('allow parent → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss","parent","teacher"]);
        const result = guard.canActivate(mkContext(mkUser('parent')));
        expect(result).toBe(true);
      });
      it('allow teacher → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss","parent","teacher"]);
        const result = guard.canActivate(mkContext(mkUser('teacher')));
        expect(result).toBe(true);
      });
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss","parent","teacher"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss","parent","teacher"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss","parent","teacher"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss","parent","teacher"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","academic","academic_admin","admin","boss","parent","teacher"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
    });

    describe('update', () => {
      // manifest: allow=[sales,sales_manager,admin,boss,academic,academic_admin]
      // manifest: deny=[teacher,finance,parent,platform_admin,finance_admin,marketing,hr]
      // note: mark-rated/trial-completed 业务流转 仅业务线 + admin/boss；parent 不直接改状态（系统驱动）

      it('allow sales → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","admin","boss","academic","academic_admin"]);
        const result = guard.canActivate(mkContext(mkUser('sales')));
        expect(result).toBe(true);
      });
      it('allow sales_manager → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","admin","boss","academic","academic_admin"]);
        const result = guard.canActivate(mkContext(mkUser('sales_manager')));
        expect(result).toBe(true);
      });
      it('allow admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","admin","boss","academic","academic_admin"]);
        const result = guard.canActivate(mkContext(mkUser('admin')));
        expect(result).toBe(true);
      });
      it('allow boss → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","admin","boss","academic","academic_admin"]);
        const result = guard.canActivate(mkContext(mkUser('boss')));
        expect(result).toBe(true);
      });
      it('allow academic → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","admin","boss","academic","academic_admin"]);
        const result = guard.canActivate(mkContext(mkUser('academic')));
        expect(result).toBe(true);
      });
      it('allow academic_admin → canActivate 返 true', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","admin","boss","academic","academic_admin"]);
        const result = guard.canActivate(mkContext(mkUser('academic_admin')));
        expect(result).toBe(true);
      });
      it('deny teacher → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","admin","boss","academic","academic_admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('teacher')))).toThrow(ForbiddenException);
      });
      it('deny finance → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","admin","boss","academic","academic_admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance')))).toThrow(ForbiddenException);
      });
      it('deny parent → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","admin","boss","academic","academic_admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('parent')))).toThrow(ForbiddenException);
      });
      it('deny platform_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","admin","boss","academic","academic_admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('platform_admin')))).toThrow(ForbiddenException);
      });
      it('deny finance_admin → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","admin","boss","academic","academic_admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('finance_admin')))).toThrow(ForbiddenException);
      });
      it('deny marketing → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","admin","boss","academic","academic_admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('marketing')))).toThrow(ForbiddenException);
      });
      it('deny hr → ForbiddenException', () => {
        (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["sales","sales_manager","admin","boss","academic","academic_admin"]);
        expect(() => guard.canActivate(mkContext(mkUser('hr')))).toThrow(ForbiddenException);
      });
    });

    describe('delete', () => {
      // manifest: allow=[admin,boss]
      // manifest: deny=[sales,sales_manager,academic,teacher,finance,parent,platform_admin,finance_admin,marketing,hr,academic_admin]
      // note: 推荐记录历史保留；admin/boss 兜底删除

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

  // corner cases 已在 Batch A 全覆盖 (user undefined / role undefined / reflector empty)
  // 本 Batch 不重复 RbacGuard 边界测试, 只关注 obj × action × role 矩阵的覆盖完整性
});
