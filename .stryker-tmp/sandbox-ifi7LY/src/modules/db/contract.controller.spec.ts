/**
 * ContractController — Sprint B.3 字段级权限过滤 controller 单测
 *
 * 范围：
 *   - GET /db/contracts/:id：scope filter + field mask
 *   - GET /db/contracts/mine：listByOwner 已 SQL 过滤 + mask
 *   - GET /db/contracts/by-student/:studentId：教学/家长视角字段裁剪
 *
 * 红线（fields-by-role.md #4）：
 *   - 教学人员（teacher/academic）不看合同金额细节（standardPrice/discountAmount/giftHours 全 0）
 *   - sales 别人合同 → 403（scope filter）
 *   - parent 自己孩子 → totalAmount ✅ + discountAmount/giftHours 0
 */

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ContractController } from './contract.controller';
import { Contract, ContractRepository } from './contract.repository';
import { StudentRepository } from './student.repository';
import { TeacherRepository } from './teacher.repository';
import { AuthenticatedRequest, JwtPayload, TenantRole } from '../auth/jwt-payload.interface';
import { AuditLogRepository } from './audit-log.repository';

describe('ContractController (Sprint B.3 字段级权限)', () => {
  let controller: ContractController;
  let repo: {
    findById: jest.Mock;
    listByOwner: jest.Mock;
    listByStudent: jest.Mock;
  };
  let studentRepo: { findBrief: jest.Mock };
  let teacherRepo: { findByUserId: jest.Mock };

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
    teacherRepo = { findByUserId: jest.fn() };
    controller = new ContractController(
      repo as unknown as ContractRepository,
      studentRepo as unknown as StudentRepository,
      teacherRepo as unknown as TeacherRepository,
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

    it('teacher → 金额全 0，仅 status/classType/lessonHours', async () => {
      repo.findById.mockResolvedValueOnce(contractFixture());
      const r = (await controller.detail(
        CONTRACT_ID,
        TENANT_SCHEMA,
        req(jwt('teacher')),
      )) as Contract;
      expect(r.standardPrice).toBe(0);
      expect(r.discountAmount).toBe(0);
      expect(r.totalAmount).toBe(0);
      expect(r.giftHours).toBe(0);
      expect(r.lessonHours).toBe(60); // 教学执行需要
      expect(r.classType).toBe('一对一');
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
        assignedTeacherId: TEACHER_ID_A,
        ownerChangedAt: null,
        ownerChangeReason: null,
        gradeOrAge: null,
        intendedSubject: null,
        contractClassType: null,
        ...overrides,
      });
    }

    it('teacher 主带学生（assignedTeacherId === ownTeacherId）→ 金额全 0', async () => {
      mockStudent({ assignedTeacherId: TEACHER_ID_A });
      teacherRepo.findByUserId.mockResolvedValueOnce({
        id: TEACHER_ID_A,
        userId: TEACHER_USER_A,
      });
      repo.listByStudent.mockResolvedValueOnce([
        contractFixture({ ownerUserId: SALES_A }),
        contractFixture({ id: 'c2', ownerUserId: SALES_B }),
      ]);
      const r = await controller.listByStudent(
        STUDENT_ID,
        TENANT_SCHEMA,
        undefined,
        undefined,
        req(jwt('teacher', TEACHER_USER_A)),
      );
      expect(r.items[0].totalAmount).toBe(0);
      expect(r.items[1].totalAmount).toBe(0);
      expect(r.items[0].classType).toBe('一对一');
      expect(r.items[0].lessonHours).toBe(60);
    });

    it('teacher 非主带学生 → 403（scope filter 拒绝）', async () => {
      mockStudent({ assignedTeacherId: 'OTHER_TEACHER_0000000000000000A1' });
      teacherRepo.findByUserId.mockResolvedValueOnce({
        id: TEACHER_ID_A,
        userId: TEACHER_USER_A,
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

    it('teacher 未绑定 teachers.user_id → 403（fail-safe，不抛 500）', async () => {
      mockStudent();
      teacherRepo.findByUserId.mockResolvedValueOnce(null);
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
  let teacherRepo: { findByUserId: jest.Mock };
  let auditLog: { log: jest.Mock };

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
    teacherRepo = { findByUserId: jest.fn() };
    auditLog = { log: jest.fn().mockResolvedValue(undefined) };
    controller = new ContractController(
      repo as unknown as ContractRepository,
      studentRepo as unknown as StudentRepository,
      teacherRepo as unknown as TeacherRepository,
      auditLog as unknown as AuditLogRepository,
    );
  });

  // ============================================================
  // create() → audit_log 'contract.create'
  // ============================================================
  describe('create() — audit contract.create', () => {
    it('销售签约 → audit_log 调 1 次, action="contract.create", 金额完整入 audit', async () => {
      const created = contractFixture({ ownerUserId: SALES_A });
      repo.create.mockResolvedValueOnce(created);

      await controller.create(
        {
          tenantId: TENANT_A,
          tenantSchema: TENANT_SCHEMA,
          id: CONTRACT_ID,
          studentId: STUDENT_ID,
          courseProductName: '一对一英语',
          lessonHours: 60,
          standardPrice: 9999,
          discountAmount: 999,
          giftHours: 5,
          totalAmount: 9000,
        },
        req(jwt('sales', SALES_A)),
      );

      expect(auditLog.log).toHaveBeenCalledTimes(1);
      const [schema, entry] = auditLog.log.mock.calls[0];
      expect(schema).toBe(TENANT_SCHEMA);
      expect(entry.action).toBe('contract.create');
      expect(entry.targetType).toBe('contract');
      expect(entry.targetId).toBe(CONTRACT_ID);
      expect(entry.before).toBeNull();
      expect(entry.actorUserId).toBe(SALES_A);
      expect(entry.actorRole).toBe('sales');
      // 金额详情入 audit（财务/审计场景必需，不脱敏）
      expect(entry.after.totalAmount).toBe(9000);
      expect(entry.after.standardPrice).toBe(9999);
      expect(entry.after.discountAmount).toBe(999);
      expect(entry.after.giftHours).toBe(5);
      expect(entry.after.studentId).toBe(STUDENT_ID);
      expect(entry.after.ownerUserId).toBe(SALES_A);
    });

    it('audit_log.log 抛错 → 不阻塞主业务（fail-open）', async () => {
      repo.create.mockResolvedValueOnce(contractFixture());
      auditLog.log.mockRejectedValueOnce(new Error('audit fail'));

      const r = await controller.create(
        {
          tenantId: TENANT_A,
          tenantSchema: TENANT_SCHEMA,
          id: CONTRACT_ID,
          studentId: STUDENT_ID,
          courseProductName: '一对一英语',
          lessonHours: 60,
          standardPrice: 9999,
          totalAmount: 9000,
        },
        req(jwt('sales', SALES_A)),
      );
      expect(r.id).toBe(CONTRACT_ID);
      expect(auditLog.log).toHaveBeenCalledTimes(1);
    });
  });

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
        assignedTeacherId: TEACHER_ID_A,
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

    it('teacher 非主带学生 → audit access-denied + 403', async () => {
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
      teacherRepo.findByUserId.mockResolvedValueOnce({
        id: TEACHER_ID_A,
        userId: TEACHER_USER_A,
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
});
