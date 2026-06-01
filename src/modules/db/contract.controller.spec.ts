/**
 * ContractController — Sprint B.3 字段级权限过滤 controller 单测
 *
 * 范围：
 *   - GET /db/contracts/:id：scope filter + field mask
 *   - GET /db/contracts/mine：listByOwner 已 SQL 过滤 + mask
 *   - GET /db/contracts/by-student/:studentId：学员视角合同列表 + 角色边界
 *
 * 红线（fields-by-role.md #4）：
 *   - teacher 不看合同相关信息，HTTP RBAC 不放行；academic 不看合同金额细节
 *   - sales 别人合同 → 403（scope filter）
 *   - parent 自己孩子 → totalAmount ✅ + discountAmount/giftHours 0
 */

import {
  BadRequestException,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ContractController } from './contract.controller';
import { Contract, ContractRepository } from './contract.repository';
import { StudentRepository } from './student.repository';
import { AuthenticatedRequest, JwtPayload, TenantRole } from '../auth/jwt-payload.interface';
import { AuditLogRepository } from './audit-log.repository';
import { RbacGuard } from '../../guards/rbac.guard';
import { StudentAssignmentService } from './student-assignment.service';

describe('ContractController (Sprint B.3 字段级权限)', () => {
  let controller: ContractController;
  let repo: {
    findById: jest.Mock;
    listByOwner: jest.Mock;
    listByStudent: jest.Mock;
  };
  let studentRepo: { findBrief: jest.Mock };

  const TENANT_A = 'TENANTA00000000000000000000000A1';
  const TENANT_SCHEMA = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const CAMPUS_A = 'campus_A0000000000000000000000A01';
  const SALES_A = 'salesA00000000000000000000000A01';
  const SALES_B = 'salesB00000000000000000000000A02';
  const CONTRACT_ID = 'contract000000000000000000000A01';
  const STUDENT_ID = 'student00000000000000000000000A1';
  const TEACHER_USER_A = 'teacherUser00000000000000000A01';
  const TEACHER_ID_A = 'teacherID000000000000000000000A1';

  function jwt(role: TenantRole, sub = SALES_A): JwtPayload {
    return { sub, tenantId: TENANT_A, role, campusId: CAMPUS_A };
  }

  function req(user?: JwtPayload): AuthenticatedRequest {
    return { user, headers: {}, body: {}, query: {}, params: {} };
  }

  function contractFixture(overrides: Partial<Contract> = {}): Contract {
    return {
      id: CONTRACT_ID,
      studentId: STUDENT_ID,
      courseProductId: null,
      courseProductName: '一对一英语',
      ownerUserId: SALES_A,
      opportunityId: 'oppor00000000000000000000000A01',
      campusId: CAMPUS_A,
      classType: '一对一',
      lessonHours: 60,
      standardPrice: 9999,
      discountAmount: 999,
      giftHours: 5,
      totalAmount: 9000,
      orderType: '新签',
      status: 'active',
      paidLocked: false,
      signedAt: '2026-05-08T00:00:00.000Z',
      activatedAt: '2026-05-08T00:00:00.000Z',
      createdAt: '2026-05-08T00:00:00.000Z',
      updatedAt: '2026-05-08T00:00:00.000Z',
      ...overrides,
    };
  }

  beforeEach(() => {
    repo = {
      findById: jest.fn(),
      listByOwner: jest.fn(),
      listByStudent: jest.fn(),
    };
    studentRepo = { findBrief: jest.fn() };
    controller = new ContractController(
      repo as unknown as ContractRepository,
      studentRepo as unknown as StudentRepository,
    );
  });

  // ============================================================
  // detail() GET /db/contracts/:id
  // ============================================================
  describe('detail() — scope + field', () => {
    it('admin → 全字段（standardPrice/discountAmount/totalAmount/giftHours）', async () => {
      repo.findById.mockResolvedValueOnce(contractFixture());
      const r = (await controller.detail(CONTRACT_ID, TENANT_SCHEMA, req(jwt('admin')))) as Contract;
      expect(r.standardPrice).toBe(9999);
      expect(r.discountAmount).toBe(999);
      expect(r.totalAmount).toBe(9000);
      expect(r.giftHours).toBe(5);
    });

    it('finance → 全字段（作账）', async () => {
      repo.findById.mockResolvedValueOnce(contractFixture());
      const r = (await controller.detail(CONTRACT_ID, TENANT_SCHEMA, req(jwt('finance')))) as Contract;
      expect(r.standardPrice).toBe(9999);
      expect(r.totalAmount).toBe(9000);
    });

    it('sales 自己合同 → 全字段', async () => {
      repo.findById.mockResolvedValueOnce(contractFixture({ ownerUserId: SALES_A }));
      const r = (await controller.detail(
        CONTRACT_ID,
        TENANT_SCHEMA,
        req(jwt('sales', SALES_A)),
      )) as Contract;
      expect(r.standardPrice).toBe(9999);
      expect(r.totalAmount).toBe(9000);
    });

    it('sales 别人合同 → 403 ForbiddenException', async () => {
      repo.findById.mockResolvedValueOnce(contractFixture({ ownerUserId: SALES_B }));
      await expect(
        controller.detail(CONTRACT_ID, TENANT_SCHEMA, req(jwt('sales', SALES_A))),
      ).rejects.toThrow(ForbiddenException);
    });

    // 5/15 A-2：sales_director 应用层已删（不在拍板角色清单）
    //   - 改测 sales_manager 仍生效（销售校内主管）
    //   - 加测 sales_director (legacy) → unknown group → canAccessContract 拒绝 → 403
    it('sales_manager 看任何合同 → 全字段（销售校内主管收口）', async () => {
      repo.findById.mockResolvedValueOnce(contractFixture({ ownerUserId: SALES_B }));
      const r = (await controller.detail(
        CONTRACT_ID,
        TENANT_SCHEMA,
        req(jwt('sales_manager', SALES_A)),
      )) as Contract;
      expect(r.standardPrice).toBe(9999);
    });

    it('sales_director (legacy, 5/15 A-2 已删) → unknown group → 403 ForbiddenException', async () => {
      // canAccessContract default 分支返 false → 抛 ForbiddenException
      repo.findById.mockResolvedValueOnce(contractFixture({ ownerUserId: SALES_B }));
      await expect(
        controller.detail(CONTRACT_ID, TENANT_SCHEMA, req(jwt('sales_director' as never, SALES_A))),
      ).rejects.toThrow(ForbiddenException);
    });

    it('academic → totalAmount 保留 + 价格细节全 0', async () => {
      repo.findById.mockResolvedValueOnce(contractFixture());
      const r = (await controller.detail(
        CONTRACT_ID,
        TENANT_SCHEMA,
        req(jwt('academic')),
      )) as Contract;
      expect(r.standardPrice).toBe(0); // ❌
      expect(r.discountAmount).toBe(0); // ❌
      expect(r.totalAmount).toBe(9000); // ✅ 续费话术
      expect(r.status).toBe('active');
      expect(r.classType).toBe('一对一');
    });

    it('teacher → 403（老师不看合同相关信息）', async () => {
      repo.findById.mockResolvedValueOnce(contractFixture());
      await expect(
        controller.detail(
          CONTRACT_ID,
          TENANT_SCHEMA,
          req(jwt('teacher')),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('parent → totalAmount + standardPrice ✅，discountAmount/giftHours 0', async () => {
      repo.findById.mockResolvedValueOnce(contractFixture());
      const r = (await controller.detail(
        CONTRACT_ID,
        TENANT_SCHEMA,
        req(jwt('parent' as TenantRole)),
      )) as Contract;
      expect(r.totalAmount).toBe(9000);
      expect(r.standardPrice).toBe(9999);
      expect(r.discountAmount).toBe(0);
      expect(r.giftHours).toBe(0);
    });

    it('hr → 403（不该看合同）', async () => {
      repo.findById.mockResolvedValueOnce(contractFixture());
      await expect(
        controller.detail(CONTRACT_ID, TENANT_SCHEMA, req(jwt('hr'))),
      ).rejects.toThrow(ForbiddenException);
    });

    it('合同不存在 → {found:false}', async () => {
      repo.findById.mockResolvedValueOnce(null);
      const r = await controller.detail(CONTRACT_ID, TENANT_SCHEMA, req(jwt('admin')));
      expect(r).toEqual({ found: false });
    });

    it('tenantSchema 缺失 → BadRequest', async () => {
      await expect(
        controller.detail(CONTRACT_ID, '', req(jwt('admin'))),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ============================================================
  // listMine() GET /db/contracts/mine
  // ============================================================
  describe('listMine() — owner=me SQL 过滤 + field mask', () => {
    it('sales 自己合同 → 全字段', async () => {
      repo.listByOwner.mockResolvedValueOnce([contractFixture({ ownerUserId: SALES_A })]);
      const r = await controller.listMine(
        TENANT_SCHEMA,
        undefined,
        undefined,
        undefined,
        req(jwt('sales', SALES_A)),
      );
      expect(r.items[0].standardPrice).toBe(9999);
      expect(r.items[0].totalAmount).toBe(9000);
    });

    it('admin 调 mine（实际 ownerUserId !== sub 的 corner case）→ admin 路径全字段', async () => {
      repo.listByOwner.mockResolvedValueOnce([contractFixture({ ownerUserId: SALES_A })]);
      const r = await controller.listMine(
        TENANT_SCHEMA,
        undefined,
        undefined,
        undefined,
        req(jwt('admin', 'adminUid000000000000000000000A01')),
      );
      // admin group 不依赖 isOwnerSelf，全字段
      expect(r.items[0].totalAmount).toBe(9000);
    });
  });

  // ============================================================
  // listByStudent() GET /db/contracts/by-student/:studentId
  // Sprint B.3 复审 修 3：scope filter（先查 student.ownerSalesId/assignedTeacherId）
  // ============================================================
  describe('listByStudent() — OOUX 学生详情合同列表 + scope filter (修 3)', () => {
    // Sprint B.3 复审 修 3 默认 mock：student 归属 SALES_A / TEACHER_ID_A
    function mockStudent(overrides: Partial<{ ownerSalesId: string | null; assignedTeacherId: string | null }> = {}) {
      studentRepo.findBrief.mockResolvedValueOnce({
        id: STUDENT_ID,
        studentName: '小明',
        customerId: 'cust00000000000000000000000000A1',
        ownerSalesId: SALES_A,
        assignedTeacherId: 'teacherID000000000000000000000A1',
        ownerChangedAt: null,
        ownerChangeReason: null,
        gradeOrAge: null,
        intendedSubject: null,
        contractClassType: null,
        ...overrides,
      });
    }

    it('teacher 即使是主带学生 → 403（老师不看合同相关信息）', async () => {
      mockStudent({ assignedTeacherId: TEACHER_ID_A });
      await expect(
        controller.listByStudent(
          STUDENT_ID,
          TENANT_SCHEMA,
          undefined,
          undefined,
          req(jwt('teacher', TEACHER_USER_A)),
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(repo.listByStudent).not.toHaveBeenCalled();
    });

    it('teacher 非主带学生 → 403（老师不看合同相关信息）', async () => {
      mockStudent({ assignedTeacherId: 'OTHER_TEACHER_0000000000000000A1' });
      await expect(
        controller.listByStudent(
          STUDENT_ID,
          TENANT_SCHEMA,
          undefined,
          undefined,
          req(jwt('teacher', TEACHER_USER_A)),
        ),
      ).rejects.toThrow(ForbiddenException);
      // 拒绝前 listByStudent 不应被调
      expect(repo.listByStudent).not.toHaveBeenCalled();
    });

    it('parent → 403（拍板：parent 走 c 端独立 endpoint，不走 B 端 by-student）', async () => {
      mockStudent();
      await expect(
        controller.listByStudent(
          STUDENT_ID,
          TENANT_SCHEMA,
          undefined,
          undefined,
          req(jwt('parent' as TenantRole)),
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(repo.listByStudent).not.toHaveBeenCalled();
    });

    it('hr → 403（拍板：hr 不参与教学/销售）', async () => {
      mockStudent();
      await expect(
        controller.listByStudent(
          STUDENT_ID,
          TENANT_SCHEMA,
          undefined,
          undefined,
          req(jwt('hr')),
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(repo.listByStudent).not.toHaveBeenCalled();
    });

    it('sales 自己客户的孩子（student.ownerSalesId === me）→ 自己合同全字段，他人金额 0', async () => {
      mockStudent({ ownerSalesId: SALES_A });
      repo.listByStudent.mockResolvedValueOnce([
        contractFixture({ ownerUserId: SALES_A }),
        contractFixture({ id: 'c2', ownerUserId: SALES_B }),
      ]);
      const r = await controller.listByStudent(
        STUDENT_ID,
        TENANT_SCHEMA,
        undefined,
        undefined,
        req(jwt('sales', SALES_A)),
      );
      expect(r.items[0].totalAmount).toBe(9000);
      expect(r.items[1].totalAmount).toBe(0);
    });

    it('sales 非自己客户的孩子（student.ownerSalesId !== me）→ 403', async () => {
      mockStudent({ ownerSalesId: SALES_B });
      await expect(
        controller.listByStudent(
          STUDENT_ID,
          TENANT_SCHEMA,
          undefined,
          undefined,
          req(jwt('sales', SALES_A)),
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(repo.listByStudent).not.toHaveBeenCalled();
    });

    it('sales_manager 看任意学生合同 → admin group 全放行（5/15 A-2 删 sales_director）', async () => {
      mockStudent({ ownerSalesId: SALES_B });
      repo.listByStudent.mockResolvedValueOnce([contractFixture({ ownerUserId: SALES_B })]);
      const r = await controller.listByStudent(
        STUDENT_ID,
        TENANT_SCHEMA,
        undefined,
        undefined,
        req(jwt('sales_manager', SALES_A)),
      );
      // sales_manager 走 admin group，全字段
      expect(r.items[0].totalAmount).toBe(9000);
    });

    it('admin 看 → 全字段（不论 student 归属）', async () => {
      mockStudent({ ownerSalesId: SALES_B, assignedTeacherId: 'OTHER_TEACHER_0000000000000000A1' });
      repo.listByStudent.mockResolvedValueOnce([contractFixture()]);
      const r = await controller.listByStudent(
        STUDENT_ID,
        TENANT_SCHEMA,
        undefined,
        undefined,
        req(jwt('admin')),
      );
      expect(r.items[0].totalAmount).toBe(9000);
    });

    it('academic → 放行（教务全可看本校学生合同），价格细节 0', async () => {
      mockStudent({ ownerSalesId: SALES_B });
      repo.listByStudent.mockResolvedValueOnce([contractFixture()]);
      const r = await controller.listByStudent(
        STUDENT_ID,
        TENANT_SCHEMA,
        undefined,
        undefined,
        req(jwt('academic')),
      );
      expect(r.items[0].totalAmount).toBe(9000); // 拍板续费话术依据
      expect(r.items[0].standardPrice).toBe(0);
    });

    it('finance → 放行（财务作账），全字段', async () => {
      mockStudent({ ownerSalesId: SALES_B });
      repo.listByStudent.mockResolvedValueOnce([contractFixture()]);
      const r = await controller.listByStudent(
        STUDENT_ID,
        TENANT_SCHEMA,
        undefined,
        undefined,
        req(jwt('finance')),
      );
      expect(r.items[0].totalAmount).toBe(9000);
      expect(r.items[0].standardPrice).toBe(9999);
    });

    it('teacher → 403（fail-safe，不抛 500）', async () => {
      mockStudent();
      await expect(
        controller.listByStudent(
          STUDENT_ID,
          TENANT_SCHEMA,
          undefined,
          undefined,
          req(jwt('teacher', TEACHER_USER_A)),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('student 不存在 → 空数组（侧信道防护）', async () => {
      studentRepo.findBrief.mockResolvedValueOnce(null);
      const r = await controller.listByStudent(
        STUDENT_ID,
        TENANT_SCHEMA,
        undefined,
        undefined,
        req(jwt('admin')),
      );
      expect(r.items).toEqual([]);
      expect(repo.listByStudent).not.toHaveBeenCalled();
    });
  });
});

// ============================================================
// Sprint B.5 (2026-05-11): audit_log 业务写 + 拒绝路径
// ============================================================
describe('ContractController (Sprint B.5 audit_log)', () => {
  let controller: ContractController;
  let repo: {
    findById: jest.Mock;
    listByOwner: jest.Mock;
    listByStudent: jest.Mock;
    create: jest.Mock;
    setStatus: jest.Mock;
    getOwnerPerformance: jest.Mock;
    getTeamPerformance: jest.Mock;
  };
  let studentRepo: { findBrief: jest.Mock };
  let auditLog: { log: jest.Mock };
  // Phase 3 (2026-06-01): 激活后触发学员→教务分配
  let assignmentService: { assignStudentIfNeeded: jest.Mock };

  const TENANT_A = 'TENANTA00000000000000000000000A1';
  const TENANT_SCHEMA = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const CAMPUS_A = 'campus_A0000000000000000000000A01';
  const SALES_A = 'salesA00000000000000000000000A01';
  const SALES_B = 'salesB00000000000000000000000A02';
  const CONTRACT_ID = 'contract000000000000000000000A01';
  const STUDENT_ID = 'student00000000000000000000000A1';
  const TEACHER_USER_A = 'teacherUser00000000000000000A01';

  function jwt(role: TenantRole, sub = SALES_A): JwtPayload {
    return { sub, tenantId: TENANT_A, role, campusId: CAMPUS_A };
  }

  function req(user?: JwtPayload): AuthenticatedRequest {
    return {
      user,
      headers: { 'user-agent': 'WeChatMP/8.x', 'x-request-id': 'req-test-001' },
      body: {},
      query: {},
      params: {},
      ip: '127.0.0.1',
    };
  }

  function contractFixture(overrides: Partial<Contract> = {}): Contract {
    return {
      id: CONTRACT_ID,
      studentId: STUDENT_ID,
      courseProductId: null,
      courseProductName: '一对一英语',
      ownerUserId: SALES_A,
      opportunityId: 'oppor00000000000000000000000A01',
      campusId: CAMPUS_A,
      classType: '一对一',
      lessonHours: 60,
      standardPrice: 9999,
      discountAmount: 999,
      giftHours: 5,
      totalAmount: 9000,
      orderType: '新签',
      status: 'pending',
      paidLocked: false,
      signedAt: '2026-05-08T00:00:00.000Z',
      activatedAt: null,
      createdAt: '2026-05-08T00:00:00.000Z',
      updatedAt: '2026-05-08T00:00:00.000Z',
      ...overrides,
    };
  }

  beforeEach(() => {
    repo = {
      findById: jest.fn(),
      listByOwner: jest.fn(),
      listByStudent: jest.fn(),
      create: jest.fn(),
      setStatus: jest.fn(),
      getOwnerPerformance: jest.fn(),
      getTeamPerformance: jest.fn(),
    } as any;
    studentRepo = { findBrief: jest.fn() };
    auditLog = { log: jest.fn().mockResolvedValue(undefined) };
    assignmentService = {
      assignStudentIfNeeded: jest
        .fn()
        .mockResolvedValue({ assigned: true, academicId: 'acad0001' }),
    };
    controller = new ContractController(
      repo as unknown as ContractRepository,
      studentRepo as unknown as StudentRepository,
      auditLog as unknown as AuditLogRepository,
      assignmentService as unknown as StudentAssignmentService,
    );
  });

  // Day 2 BLOCKER 5 (2026-05-19): 删 POST /api/db/contracts 独立端点
  //   SSOT §2 全局规则 1「OOUX 中心化：contract 是 student 的子对象」
  //   - 原 controller.create() endpoint 已删除（contract.controller.ts L329 @Post() 移除）
  //   - 唯一合法路径：POST /api/db/students/:id/contracts（student.controller.ts createContract）
  //   - 该路径的 audit_log + 金额完整入 audit 覆盖在 student.controller.spec.ts:
  //       describe('createContract() OOUX — audit contract.create') (~L657-)
  //   - 因此本 spec 移除 controller.create() 测试避免引用已删除方法（TS 编译错）

  // ============================================================
  // detail() 拒绝路径 → audit_log 'contract.access-denied'
  // ============================================================
  describe('detail() — 拒绝路径 audit contract.access-denied', () => {
    it('sales 越权看他人合同 → audit access-denied 调 1 次 + 403', async () => {
      repo.findById.mockResolvedValueOnce(
        contractFixture({ ownerUserId: SALES_B }),
      );
      await expect(
        controller.detail(CONTRACT_ID, TENANT_SCHEMA, req(jwt('sales', SALES_A))),
      ).rejects.toThrow(ForbiddenException);
      expect(auditLog.log).toHaveBeenCalledTimes(1);
      const entry = auditLog.log.mock.calls[0][1];
      expect(entry.action).toBe('contract.access-denied');
      expect(entry.targetType).toBe('contract');
      expect(entry.targetId).toBe(CONTRACT_ID);
      expect(entry.after.attempted_role).toBe('sales');
      expect(entry.after.attempted_owner).toBe(SALES_A);
      expect(entry.after.actual_owner).toBe(SALES_B);
      expect(entry.after.endpoint).toBe('detail');
    });

    it('hr 看合同 → audit access-denied + 403', async () => {
      repo.findById.mockResolvedValueOnce(contractFixture());
      await expect(
        controller.detail(CONTRACT_ID, TENANT_SCHEMA, req(jwt('hr'))),
      ).rejects.toThrow(ForbiddenException);
      expect(auditLog.log).toHaveBeenCalledTimes(1);
      expect(auditLog.log.mock.calls[0][1].after.attempted_role).toBe('hr');
    });
  });

  // ============================================================
  // listByStudent() 拒绝路径 → audit_log 'contract.access-denied'
  // ============================================================
  describe('listByStudent() — 拒绝路径 audit contract.access-denied', () => {
    it('sales 看他人客户的孩子合同 → audit access-denied + 403', async () => {
      studentRepo.findBrief.mockResolvedValueOnce({
        id: STUDENT_ID,
        studentName: '小明',
        customerId: 'cust00000000000000000000000000A1',
        ownerSalesId: SALES_B, // 他人客户
        assignedTeacherId: 'teacherID000000000000000000000A1',
        ownerChangedAt: null,
        ownerChangeReason: null,
        gradeOrAge: null,
        intendedSubject: null,
        contractClassType: null,
      });
      await expect(
        controller.listByStudent(
          STUDENT_ID,
          TENANT_SCHEMA,
          undefined,
          undefined,
          req(jwt('sales', SALES_A)),
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(auditLog.log).toHaveBeenCalledTimes(1);
      const entry = auditLog.log.mock.calls[0][1];
      expect(entry.action).toBe('contract.access-denied');
      expect(entry.targetType).toBe('student'); // by-student 路径 targetType=student
      expect(entry.targetId).toBe(STUDENT_ID);
      expect(entry.after.attempted_role).toBe('sales');
      expect(entry.after.actual_owner_sales).toBe(SALES_B);
      expect(entry.after.endpoint).toBe('by-student');
    });

    it('teacher → audit access-denied + 403（老师不看合同相关信息）', async () => {
      studentRepo.findBrief.mockResolvedValueOnce({
        id: STUDENT_ID,
        studentName: '小明',
        customerId: 'cust00000000000000000000000000A1',
        ownerSalesId: SALES_A,
        assignedTeacherId: 'OTHER_TEACHER_0000000000000000A1',
        ownerChangedAt: null,
        ownerChangeReason: null,
        gradeOrAge: null,
        intendedSubject: null,
        contractClassType: null,
      });
      await expect(
        controller.listByStudent(
          STUDENT_ID,
          TENANT_SCHEMA,
          undefined,
          undefined,
          req(jwt('teacher', TEACHER_USER_A)),
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(auditLog.log).toHaveBeenCalledTimes(1);
      expect(auditLog.log.mock.calls[0][1].after.attempted_role).toBe('teacher');
    });
  });

  // ============================================================
  // activate() — 2026-05-31 §6 收口 finance-only + audit contract.activate
  //   RBAC（@Roles）由 RbacGuard 在 HTTP 层强制；单测断言装饰器元数据 →
  //   sales/sales_manager/boss/admin 不在白名单（= 403 保证），仅 finance 通过。
  //   行为：setStatus 翻 active（不建课时包）+ audit before/after status。
  // ============================================================
  describe('activate() — finance-only 收口 + audit', () => {
    const ROLES_KEY = 'rbac_roles'; // guards/rbac.decorator.ts ROLES_METADATA_KEY

    it('@Roles 严格 = [finance]（收口前误含 sales/sales_manager/boss/admin）', () => {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        ContractController.prototype.activate,
      );
      expect(roles).toEqual(['finance']);
    });

    it('越权角色不在白名单（sales/sales_manager/boss/admin/teacher/academic/parent）→ RbacGuard 403', () => {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        ContractController.prototype.activate,
      ) as string[];
      for (const r of [
        'sales',
        'sales_manager',
        'boss',
        'admin',
        'teacher',
        'academic',
        'academic_admin',
        'parent',
        'hr',
        'marketing',
      ]) {
        expect(roles).not.toContain(r);
      }
    });

    // 真跑 RbacGuard（不只断言元数据）：构造指向 activate handler 的 ExecutionContext，
    // 用真实 Reflector 读 @Roles → 非 finance 调 → ForbiddenException（HTTP 层 403）。
    // e2e 需 live Postgres 跑不了，故在单测层用真 guard 复现 RBAC 拒绝判定。
    describe('RbacGuard.canActivate（真 guard 跑 activate 路由）', () => {
      const guard = new RbacGuard(new Reflector());

      function ctxForActivate(user?: Partial<JwtPayload>): ExecutionContext {
        return {
          getHandler: () => ContractController.prototype.activate,
          getClass: () => ContractController,
          switchToHttp: () => ({
            getRequest: () => ({ user }),
          }),
        } as unknown as ExecutionContext;
      }

      it('finance → 放行（canActivate 返 true）', () => {
        expect(guard.canActivate(ctxForActivate(jwt('finance', SALES_A)))).toBe(
          true,
        );
      });

      it.each([
        'sales',
        'sales_manager',
        'boss',
        'admin',
        'academic',
        'academic_admin',
        'teacher',
        'marketing',
        'hr',
      ] as const)('%s → ForbiddenException（非 finance 不能激活合同）', (role) => {
        expect(() =>
          guard.canActivate(ctxForActivate(jwt(role as TenantRole, SALES_A))),
        ).toThrow(ForbiddenException);
      });

      it('无 user（未认证）→ UnauthorizedException', () => {
        expect(() => guard.canActivate(ctxForActivate(undefined))).toThrow(
          UnauthorizedException,
        );
      });
    });

    it('finance 激活 → setStatus(active) + audit contract.activate（before/after status）', async () => {
      repo.findById.mockResolvedValueOnce(
        contractFixture({ status: 'pending' }),
      );
      repo.setStatus.mockResolvedValueOnce(
        contractFixture({ status: 'active', activatedAt: '2026-05-31T00:00:00.000Z' }),
      );

      const out = await controller.activate(
        CONTRACT_ID,
        { tenantId: TENANT_A, tenantSchema: TENANT_SCHEMA },
        req(jwt('finance', SALES_A)),
      );

      // 仅翻状态，不建课时包：调 setStatus active 1 次
      expect(repo.setStatus).toHaveBeenCalledTimes(1);
      expect(repo.setStatus).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        CONTRACT_ID,
        'active',
        SALES_A,
      );
      expect(out.status).toBe('active');

      // audit_log 写入 contract.activate（before pending → after active）
      expect(auditLog.log).toHaveBeenCalledTimes(1);
      const entry = auditLog.log.mock.calls[0][1];
      expect(entry.action).toBe('contract.activate');
      expect(entry.targetType).toBe('contract');
      expect(entry.targetId).toBe(CONTRACT_ID);
      expect(entry.actorUserId).toBe(SALES_A);
      expect(entry.before).toEqual({ status: 'pending' });
      expect(entry.after).toEqual({ status: 'active' });
    });

    it('before 取自 findById（先于 setStatus）；findById 返 null → before.status=null', async () => {
      repo.findById.mockResolvedValueOnce(null);
      repo.setStatus.mockResolvedValueOnce(
        contractFixture({ status: 'active' }),
      );

      await controller.activate(
        CONTRACT_ID,
        { tenantId: TENANT_A, tenantSchema: TENANT_SCHEMA },
        req(jwt('finance', SALES_A)),
      );
      expect(repo.findById).toHaveBeenCalledWith(TENANT_SCHEMA, CONTRACT_ID);
      expect(auditLog.log.mock.calls[0][1].before).toEqual({ status: null });
    });

    it('tenantSchema 缺失 → BadRequest（不查库）', async () => {
      await expect(
        controller.activate(
          CONTRACT_ID,
          { tenantId: TENANT_A, tenantSchema: '' },
          req(jwt('finance', SALES_A)),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(repo.setStatus).not.toHaveBeenCalled();
    });

    // ----- Phase 3 (2026-06-01)：激活后触发学员→教务分配 -----
    it('激活成功 → 触发 assignStudentIfNeeded(student, campus, finance)', async () => {
      repo.findById.mockResolvedValueOnce(contractFixture({ status: 'pending' }));
      repo.setStatus.mockResolvedValueOnce(
        contractFixture({ status: 'active', studentId: STUDENT_ID, campusId: CAMPUS_A }),
      );

      await controller.activate(
        CONTRACT_ID,
        { tenantId: TENANT_A, tenantSchema: TENANT_SCHEMA },
        req(jwt('finance', SALES_A)),
      );

      expect(assignmentService.assignStudentIfNeeded).toHaveBeenCalledTimes(1);
      expect(assignmentService.assignStudentIfNeeded).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        STUDENT_ID,
        CAMPUS_A,
        { userId: SALES_A, role: 'finance' },
      );
    });

    it('分配 side-effect 抛错 → 不影响激活（fail-open，激活仍返 active）', async () => {
      repo.findById.mockResolvedValueOnce(contractFixture({ status: 'pending' }));
      repo.setStatus.mockResolvedValueOnce(contractFixture({ status: 'active' }));
      assignmentService.assignStudentIfNeeded.mockRejectedValueOnce(
        new Error('boom'),
      );

      const out = await controller.activate(
        CONTRACT_ID,
        { tenantId: TENANT_A, tenantSchema: TENANT_SCHEMA },
        req(jwt('finance', SALES_A)),
      );
      // 激活主流程不受影响
      expect(out.status).toBe('active');
      expect(auditLog.log).toHaveBeenCalledTimes(1); // contract.activate 仍写
    });

    it('assignmentService 未注入（@Optional 缺失）→ 激活仍成功，不抛', async () => {
      const ctl = new ContractController(
        repo as unknown as ContractRepository,
        studentRepo as unknown as StudentRepository,
        auditLog as unknown as AuditLogRepository,
        // 不传 assignmentService
      );
      repo.findById.mockResolvedValueOnce(contractFixture({ status: 'pending' }));
      repo.setStatus.mockResolvedValueOnce(contractFixture({ status: 'active' }));
      const out = await ctl.activate(
        CONTRACT_ID,
        { tenantId: TENANT_A, tenantSchema: TENANT_SCHEMA },
        req(jwt('finance', SALES_A)),
      );
      expect(out.status).toBe('active');
    });
  });
});

// ============================================================
// Phase 2 财务激活重构 (2026-06-01):
//   POST /db/contracts/pending-activation — 本校待激活合同列表（财务激活数据源）
//   - @Roles('finance') 单校；campusId 取自 JWT（禁前端传）
//   - 缺 campusId → 403；只读端点（不写 audit）
// ============================================================
describe('ContractController (Phase 2 pending-activation 财务激活清单)', () => {
  let controller: ContractController;
  let repo: {
    findById: jest.Mock;
    listByOwner: jest.Mock;
    listByStudent: jest.Mock;
    listPendingActivationByCampus: jest.Mock;
  };
  let studentRepo: { findBrief: jest.Mock };

  const TENANT_A = 'TENANTA00000000000000000000000A1';
  const TENANT_SCHEMA = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const CAMPUS_A = 'campus_A0000000000000000000000A01';
  const FINANCE_A = 'financeA0000000000000000000000A1';
  const CONTRACT_ID = 'contract000000000000000000000A01';

  function jwt(
    role: TenantRole,
    sub = FINANCE_A,
    campusId: string | null = CAMPUS_A,
  ): JwtPayload {
    return { sub, tenantId: TENANT_A, role, campusId };
  }

  function req(user?: JwtPayload): AuthenticatedRequest {
    return { user, headers: {}, body: {}, query: {}, params: {} };
  }

  function pendingRow(overrides: Record<string, unknown> = {}) {
    return {
      id: CONTRACT_ID,
      studentName: '小明',
      productName: '一对一英语',
      totalAmount: 9000,
      signedAt: '2026-05-08T00:00:00.000Z',
      status: 'pending' as const,
      ...overrides,
    };
  }

  beforeEach(() => {
    repo = {
      findById: jest.fn(),
      listByOwner: jest.fn(),
      listByStudent: jest.fn(),
      listPendingActivationByCampus: jest.fn(),
    };
    studentRepo = { findBrief: jest.fn() };
    controller = new ContractController(
      repo as unknown as ContractRepository,
      studentRepo as unknown as StudentRepository,
    );
  });

  const ROLES_KEY = 'rbac_roles'; // guards/rbac.decorator.ts ROLES_METADATA_KEY

  it('@Roles 严格 = [finance]（仅财务可看待激活清单）', () => {
    const roles = Reflect.getMetadata(
      ROLES_KEY,
      ContractController.prototype.pendingActivation,
    );
    expect(roles).toEqual(['finance']);
  });

  it('非 finance 角色不在白名单（sales/academic/admin/boss/...）→ RbacGuard 403', () => {
    const roles = Reflect.getMetadata(
      ROLES_KEY,
      ContractController.prototype.pendingActivation,
    ) as string[];
    for (const r of [
      'sales',
      'sales_manager',
      'boss',
      'admin',
      'academic',
      'academic_admin',
      'teacher',
      'parent',
      'hr',
      'marketing',
    ]) {
      expect(roles).not.toContain(r);
    }
  });

  // 真跑 RbacGuard：非 finance 调本端点 → ForbiddenException（HTTP 层 403）
  describe('RbacGuard.canActivate（真 guard 跑 pending-activation 路由）', () => {
    const guard = new RbacGuard(new Reflector());

    function ctxForPending(user?: Partial<JwtPayload>): ExecutionContext {
      return {
        getHandler: () => ContractController.prototype.pendingActivation,
        getClass: () => ContractController,
        switchToHttp: () => ({ getRequest: () => ({ user }) }),
      } as unknown as ExecutionContext;
    }

    it('finance → 放行（canActivate 返 true）', () => {
      expect(guard.canActivate(ctxForPending(jwt('finance', FINANCE_A)))).toBe(true);
    });

    it.each([
      'sales',
      'sales_manager',
      'boss',
      'admin',
      'academic',
      'academic_admin',
      'teacher',
      'marketing',
      'hr',
    ] as const)('%s → ForbiddenException（非 finance 不能看待激活清单）', (role) => {
      expect(() =>
        guard.canActivate(ctxForPending(jwt(role as TenantRole, FINANCE_A))),
      ).toThrow(ForbiddenException);
    });

    it('无 user（未认证）→ UnauthorizedException', () => {
      expect(() => guard.canActivate(ctxForPending(undefined))).toThrow(
        UnauthorizedException,
      );
    });
  });

  it('finance → 本校 pending 列表（含 studentName + productName + totalAmount）', async () => {
    repo.listPendingActivationByCampus.mockResolvedValueOnce([
      pendingRow(),
      pendingRow({ id: 'c2', studentName: '小红', totalAmount: 12000 }),
    ]);
    const r = await controller.pendingActivation(
      { tenantSchema: TENANT_SCHEMA },
      req(jwt('finance', FINANCE_A)),
    );
    expect(r.items).toHaveLength(2);
    expect(r.items[0].studentName).toBe('小明');
    expect(r.items[0].productName).toBe('一对一英语');
    expect(r.items[0].totalAmount).toBe(9000);
    expect(r.items[0].status).toBe('pending');
    expect(r.items[1].totalAmount).toBe(12000);
  });

  it('campusId 一律取自 JWT（禁信前端传参）→ repo 用 JWT.campusId 调用', async () => {
    repo.listPendingActivationByCampus.mockResolvedValueOnce([]);
    await controller.pendingActivation(
      { tenantSchema: TENANT_SCHEMA },
      req(jwt('finance', FINANCE_A, CAMPUS_A)),
    );
    expect(repo.listPendingActivationByCampus).toHaveBeenCalledWith(
      TENANT_SCHEMA,
      CAMPUS_A,
    );
  });

  it('finance 缺 campusId → 403 ForbiddenException（不查库）', async () => {
    await expect(
      controller.pendingActivation(
        { tenantSchema: TENANT_SCHEMA },
        req(jwt('finance', FINANCE_A, null)),
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(repo.listPendingActivationByCampus).not.toHaveBeenCalled();
  });

  it('tenantSchema 缺失 → BadRequest（不查库）', async () => {
    await expect(
      controller.pendingActivation(
        { tenantSchema: '' },
        req(jwt('finance', FINANCE_A)),
      ),
    ).rejects.toThrow(BadRequestException);
    expect(repo.listPendingActivationByCampus).not.toHaveBeenCalled();
  });

  it('空结果 → items 为空数组', async () => {
    repo.listPendingActivationByCampus.mockResolvedValueOnce([]);
    const r = await controller.pendingActivation(
      { tenantSchema: TENANT_SCHEMA },
      req(jwt('finance', FINANCE_A)),
    );
    expect(r.items).toEqual([]);
  });
});
