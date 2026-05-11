/**
 * StudentController — Sprint B.3 范围过滤 controller 单测
 *
 * 范围：
 *   - POST /db/students/list：scope filter
 *     - sales（个人）→ ownerSalesId 强制 = req.user.sub
 *     - teacher → assignedTeacherId 强制 = ownTeacherId（反查 teachers.user_id）
 *     - admin/boss/academic/sales_manager/sales_director → 按 body 传
 *
 * 红线（fields-by-role.md #1）：
 *   - 销售只看 owner=me 学生（拍板「sales ✅ 自己客户」）
 *   - 老师只看 assigned=me 学生（拍板「teacher ✅ 主带」）
 *   - student brief 字段（无 PII 现 schema），不做 field mask
 */

import { StudentController } from './student.controller';
import { StudentBrief, StudentRepository, StudentTransferResult } from './student.repository';
import { TeacherRepository } from './teacher.repository';
import { ContractRepository } from './contract.repository';
import { AuthenticatedRequest, JwtPayload, TenantRole } from '../auth/jwt-payload.interface';
import { AuditLogRepository } from './audit-log.repository';

describe('StudentController (Sprint B.3 范围过滤)', () => {
  let controller: StudentController;
  let repo: { listAll: jest.Mock; listByTeacher: jest.Mock };
  let teacherRepo: { findByUserId: jest.Mock };
  let contractRepo: { create: jest.Mock };

  const TENANT_A = 'TENANTA00000000000000000000000A1';
  const TENANT_SCHEMA = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const CAMPUS_A = 'campus_A0000000000000000000000A01';
  const SALES_A = 'salesA00000000000000000000000A01';
  const SALES_B = 'salesB00000000000000000000000A02';
  const TEACHER_USER_A = 'teacherUser00000000000000000A01';
  const TEACHER_ID_A = 'teacherID000000000000000000000A1';

  function jwt(role: TenantRole, sub = SALES_A): JwtPayload {
    return { sub, tenantId: TENANT_A, role, campusId: CAMPUS_A };
  }

  function req(user?: JwtPayload): AuthenticatedRequest {
    return { user, headers: {}, body: {}, query: {}, params: {} };
  }

  function studentBriefFixture(overrides: Partial<StudentBrief> = {}): StudentBrief {
    return {
      id: 'student00000000000000000000000A1',
      studentName: '小明',
      customerId: 'cust000000000000000000000000A01',
      ownerSalesId: SALES_A,
      assignedTeacherId: TEACHER_ID_A,
      ownerChangedAt: null,
      ownerChangeReason: null,
      gradeOrAge: '三年级',
      intendedSubject: '英语',
      contractClassType: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    repo = { listAll: jest.fn(), listByTeacher: jest.fn() };
    teacherRepo = { findByUserId: jest.fn() };
    contractRepo = { create: jest.fn() };
    controller = new StudentController(
      repo as unknown as StudentRepository,
      teacherRepo as unknown as TeacherRepository,
      contractRepo as unknown as ContractRepository,
    );
  });

  // ============================================================
  // listAll() POST /db/students/list
  // ============================================================
  describe('listAll() — 范围过滤', () => {
    it('sales 个人 → ownerSalesId 强制 = req.user.sub（覆盖 body 传值）', async () => {
      repo.listAll.mockResolvedValueOnce([studentBriefFixture({ ownerSalesId: SALES_A })]);
      await controller.listAll(
        {
          tenantSchema: TENANT_SCHEMA,
          // 即便 body 传别人 sales 也强制覆盖
          ownerSalesId: SALES_B,
        },
        req(jwt('sales', SALES_A)),
      );
      // 验 repo.listAll 收到的 ownerSalesId = req.user.sub = SALES_A
      expect(repo.listAll).toHaveBeenCalledWith(TENANT_SCHEMA, {
        limit: 100,
        offset: 0,
        ownerSalesId: SALES_A, // 覆盖了 body.ownerSalesId
        assignedTeacherId: undefined,
      });
    });

    it('teacher → assignedTeacherId 强制 = ownTeacherId（反查 teachers）', async () => {
      teacherRepo.findByUserId.mockResolvedValueOnce({
        id: TEACHER_ID_A,
        userId: TEACHER_USER_A,
        campusId: CAMPUS_A,
        name: '王老师',
      });
      repo.listAll.mockResolvedValueOnce([studentBriefFixture()]);
      await controller.listAll(
        { tenantSchema: TENANT_SCHEMA },
        req(jwt('teacher', TEACHER_USER_A)),
      );
      expect(teacherRepo.findByUserId).toHaveBeenCalledWith(TENANT_SCHEMA, TEACHER_USER_A);
      expect(repo.listAll).toHaveBeenCalledWith(TENANT_SCHEMA, {
        limit: 100,
        offset: 0,
        ownerSalesId: undefined,
        assignedTeacherId: TEACHER_ID_A,
      });
    });

    it('teacher 未绑定 teachers.user_id → 空列表（fail-safe）', async () => {
      teacherRepo.findByUserId.mockResolvedValueOnce(null);
      const r = await controller.listAll(
        { tenantSchema: TENANT_SCHEMA },
        req(jwt('teacher', TEACHER_USER_A)),
      );
      expect(r.items).toEqual([]);
      // repo.listAll 不应被调（未绑定时直接返空）
      expect(repo.listAll).not.toHaveBeenCalled();
    });

    it('admin → 按 body 传值过滤（不强制覆盖）', async () => {
      repo.listAll.mockResolvedValueOnce([studentBriefFixture()]);
      await controller.listAll(
        {
          tenantSchema: TENANT_SCHEMA,
          ownerSalesId: SALES_B,
          assignedTeacherId: 'OTHER_TEACHER_0000000000000A01',
        },
        req(jwt('admin')),
      );
      expect(repo.listAll).toHaveBeenCalledWith(TENANT_SCHEMA, {
        limit: 100,
        offset: 0,
        ownerSalesId: SALES_B, // admin 不被强制覆盖
        assignedTeacherId: 'OTHER_TEACHER_0000000000000A01',
      });
    });

    it('boss → 按 body 传值过滤', async () => {
      repo.listAll.mockResolvedValueOnce([]);
      await controller.listAll(
        { tenantSchema: TENANT_SCHEMA, ownerSalesId: SALES_B },
        req(jwt('boss')),
      );
      expect(repo.listAll).toHaveBeenCalledWith(TENANT_SCHEMA, {
        limit: 100,
        offset: 0,
        ownerSalesId: SALES_B,
        assignedTeacherId: undefined,
      });
    });

    it('academic → 按 body 传值过滤（全本校学生）', async () => {
      repo.listAll.mockResolvedValueOnce([studentBriefFixture()]);
      await controller.listAll(
        { tenantSchema: TENANT_SCHEMA },
        req(jwt('academic')),
      );
      expect(repo.listAll).toHaveBeenCalledWith(TENANT_SCHEMA, {
        limit: 100,
        offset: 0,
        ownerSalesId: undefined,
        assignedTeacherId: undefined,
      });
    });

    it('sales_director → admin group 不强制覆盖（跨销售可看）', async () => {
      repo.listAll.mockResolvedValueOnce([studentBriefFixture()]);
      await controller.listAll(
        { tenantSchema: TENANT_SCHEMA, ownerSalesId: SALES_B },
        req(jwt('sales_director', SALES_A)),
      );
      expect(repo.listAll).toHaveBeenCalledWith(TENANT_SCHEMA, {
        limit: 100,
        offset: 0,
        ownerSalesId: SALES_B, // sales_director 是 admin group，不覆盖
        assignedTeacherId: undefined,
      });
    });

    it('sales_manager → admin group 不强制覆盖', async () => {
      repo.listAll.mockResolvedValueOnce([studentBriefFixture()]);
      await controller.listAll(
        { tenantSchema: TENANT_SCHEMA, ownerSalesId: SALES_B },
        req(jwt('sales_manager', SALES_A)),
      );
      expect(repo.listAll).toHaveBeenCalledWith(TENANT_SCHEMA, {
        limit: 100,
        offset: 0,
        ownerSalesId: SALES_B,
        assignedTeacherId: undefined,
      });
    });

    it('marketing → sales group 强制覆盖 ownerSalesId = req.user.sub', async () => {
      repo.listAll.mockResolvedValueOnce([]);
      await controller.listAll(
        { tenantSchema: TENANT_SCHEMA, ownerSalesId: SALES_B },
        req(jwt('marketing', SALES_A)),
      );
      // marketing 走 sales group → 强制 owner=me
      expect(repo.listAll).toHaveBeenCalledWith(TENANT_SCHEMA, {
        limit: 100,
        offset: 0,
        ownerSalesId: SALES_A,
        assignedTeacherId: undefined,
      });
    });
  });

  // ============================================================
  // listByTeacher() GET /db/students/by-teacher/:teacherId
  // Sprint B.3 复审 修 1：RBAC + teacher self-cover
  // ============================================================
  describe('listByTeacher() — 修 1 RBAC + teacher self-cover', () => {
    const OTHER_TEACHER_ID = 'OTHER_TEACHER_0000000000000000A1';

    it('admin → 按 path teacherId 查（不强制覆盖）', async () => {
      repo.listByTeacher.mockResolvedValueOnce([studentBriefFixture()]);
      await controller.listByTeacher(
        OTHER_TEACHER_ID,
        TENANT_SCHEMA,
        req(jwt('admin')),
        undefined,
        undefined,
      );
      // teacherRepo.findByUserId 不应被调（admin 不走 self-cover）
      expect(teacherRepo.findByUserId).not.toHaveBeenCalled();
      expect(repo.listByTeacher).toHaveBeenCalledWith(TENANT_SCHEMA, OTHER_TEACHER_ID, {
        limit: 100,
        offset: 0,
      });
    });

    it('boss → 按 path teacherId 查（不强制覆盖）', async () => {
      repo.listByTeacher.mockResolvedValueOnce([studentBriefFixture()]);
      await controller.listByTeacher(
        OTHER_TEACHER_ID,
        TENANT_SCHEMA,
        req(jwt('boss')),
        undefined,
        undefined,
      );
      expect(repo.listByTeacher).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        OTHER_TEACHER_ID,
        expect.anything(),
      );
    });

    it('academic → 按 path teacherId 查', async () => {
      repo.listByTeacher.mockResolvedValueOnce([]);
      await controller.listByTeacher(
        OTHER_TEACHER_ID,
        TENANT_SCHEMA,
        req(jwt('academic')),
        undefined,
        undefined,
      );
      expect(repo.listByTeacher).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        OTHER_TEACHER_ID,
        expect.anything(),
      );
    });

    it('sales → 按 path teacherId 查（拍板「sales 看老师推荐」需可看主带学生）', async () => {
      repo.listByTeacher.mockResolvedValueOnce([]);
      await controller.listByTeacher(
        OTHER_TEACHER_ID,
        TENANT_SCHEMA,
        req(jwt('sales', SALES_A)),
        undefined,
        undefined,
      );
      expect(teacherRepo.findByUserId).not.toHaveBeenCalled();
      expect(repo.listByTeacher).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        OTHER_TEACHER_ID,
        expect.anything(),
      );
    });

    it('teacher → 强制覆盖 path teacherId 为 ownTeacherId（self-cover）', async () => {
      teacherRepo.findByUserId.mockResolvedValueOnce({
        id: TEACHER_ID_A,
        userId: TEACHER_USER_A,
        campusId: CAMPUS_A,
        name: '王老师',
      });
      repo.listByTeacher.mockResolvedValueOnce([studentBriefFixture()]);
      await controller.listByTeacher(
        OTHER_TEACHER_ID, // path 传别人，应被覆盖
        TENANT_SCHEMA,
        req(jwt('teacher', TEACHER_USER_A)),
        undefined,
        undefined,
      );
      expect(teacherRepo.findByUserId).toHaveBeenCalledWith(TENANT_SCHEMA, TEACHER_USER_A);
      // path 是 OTHER，repo 收到的是 TEACHER_ID_A（自己）
      expect(repo.listByTeacher).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        TEACHER_ID_A,
        expect.anything(),
      );
    });

    it('teacher 未绑定 teachers.user_id → 空列表（fail-safe，不抛 403）', async () => {
      teacherRepo.findByUserId.mockResolvedValueOnce(null);
      const r = await controller.listByTeacher(
        OTHER_TEACHER_ID,
        TENANT_SCHEMA,
        req(jwt('teacher', TEACHER_USER_A)),
        undefined,
        undefined,
      );
      expect(r.items).toEqual([]);
      expect(repo.listByTeacher).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // createContract() POST /db/students/:id/contracts
  // Sprint B.3 复审 修 4 OOUX：contract 是 student 子对象
  // ============================================================
  describe('createContract() — 修 4 OOUX POST :id/contracts', () => {
    const CONTRACT_ID = 'contract00000000000000000000000A';
    const STUDENT_ID = 'student00000000000000000000000A1';

    function contractBody(overrides: any = {}) {
      return {
        tenantId: TENANT_A,
        tenantSchema: TENANT_SCHEMA,
        id: CONTRACT_ID,
        courseProductName: '一对一英语',
        lessonHours: 60,
        standardPrice: 9999,
        totalAmount: 9000,
        ...overrides,
      };
    }

    it('sales 签约 → 新 endpoint 复用 contractRepo.create，studentId 来自 path', async () => {
      contractRepo.create.mockResolvedValueOnce({
        id: CONTRACT_ID,
        studentId: STUDENT_ID,
        ownerUserId: SALES_A,
        totalAmount: 9000,
      });
      await controller.createContract(
        STUDENT_ID,
        contractBody(),
        req(jwt('sales', SALES_A)),
      );
      expect(contractRepo.create).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        expect.objectContaining({
          id: CONTRACT_ID,
          studentId: STUDENT_ID, // 来自 path
          ownerUserId: SALES_A, // 自动 = req.user.sub
          totalAmount: 9000,
          campusId: CAMPUS_A, // 从 jwt.campusId 自动填
        }),
      );
    });

    it('admin 签约 → ownerUserId = admin.sub', async () => {
      contractRepo.create.mockResolvedValueOnce({ id: CONTRACT_ID });
      await controller.createContract(
        STUDENT_ID,
        contractBody(),
        req(jwt('admin', 'admin_sub_000000000000000000000A1')),
      );
      expect(contractRepo.create).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        expect.objectContaining({
          ownerUserId: 'admin_sub_000000000000000000000A1',
          studentId: STUDENT_ID,
        }),
      );
    });

    it('totalAmount 缺失 → BadRequest', async () => {
      const { BadRequestException } = await import('@nestjs/common');
      const body = contractBody() as any;
      delete body.totalAmount;
      await expect(
        controller.createContract(STUDENT_ID, body, req(jwt('sales', SALES_A))),
      ).rejects.toThrow(BadRequestException);
    });

    it('courseProductId 与 courseProductName 都缺失 → BadRequest', async () => {
      const { BadRequestException } = await import('@nestjs/common');
      const body = contractBody() as any;
      delete body.courseProductName;
      await expect(
        controller.createContract(STUDENT_ID, body, req(jwt('sales', SALES_A))),
      ).rejects.toThrow(BadRequestException);
    });

    it('studentId 不是 32-char → BadRequest', async () => {
      const { BadRequestException } = await import('@nestjs/common');
      await expect(
        controller.createContract('shortid', contractBody(), req(jwt('sales', SALES_A))),
      ).rejects.toThrow(BadRequestException);
    });

    it('tenantSchema 缺失 → BadRequest', async () => {
      const { BadRequestException } = await import('@nestjs/common');
      await expect(
        controller.createContract(
          STUDENT_ID,
          contractBody({ tenantSchema: '' }),
          req(jwt('sales', SALES_A)),
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });
});

// ============================================================
// Sprint B.5 (2026-05-11): audit_log 业务写
// ============================================================
describe('StudentController (Sprint B.5 audit_log)', () => {
  let controller: StudentController;
  let repo: {
    create: jest.Mock;
    transferSales: jest.Mock;
    transferTeacher: jest.Mock;
    listAll: jest.Mock;
    listByTeacher: jest.Mock;
  };
  let teacherRepo: { findByUserId: jest.Mock };
  let contractRepo: { create: jest.Mock };
  let auditLog: { log: jest.Mock };

  const TENANT_A = 'TENANTA00000000000000000000000A1';
  const TENANT_SCHEMA = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const CAMPUS_A = 'campus_A0000000000000000000000A01';
  const SALES_A = 'salesA00000000000000000000000A01';
  const SALES_B = 'salesB00000000000000000000000A02';
  const STUDENT_ID = 'student00000000000000000000000A1';
  const CUSTOMER_ID = 'cust00000000000000000000000000A1';
  const CONTRACT_ID = 'contract00000000000000000000000A';
  const TEACHER_ID_A = 'teacherID000000000000000000000A1';
  const TEACHER_ID_B = 'teacherID000000000000000000000B1';

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

  function studentBriefFixture(overrides: Partial<StudentBrief> = {}): StudentBrief {
    return {
      id: STUDENT_ID,
      studentName: '小明',
      customerId: CUSTOMER_ID,
      ownerSalesId: SALES_A,
      assignedTeacherId: TEACHER_ID_A,
      ownerChangedAt: null,
      ownerChangeReason: null,
      gradeOrAge: '三年级',
      intendedSubject: '英语',
      contractClassType: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    repo = {
      create: jest.fn(),
      transferSales: jest.fn(),
      transferTeacher: jest.fn(),
      listAll: jest.fn(),
      listByTeacher: jest.fn(),
    } as any;
    teacherRepo = { findByUserId: jest.fn() };
    contractRepo = { create: jest.fn() };
    auditLog = { log: jest.fn().mockResolvedValue(undefined) };
    controller = new StudentController(
      repo as unknown as StudentRepository,
      teacherRepo as unknown as TeacherRepository,
      contractRepo as unknown as ContractRepository,
      auditLog as unknown as AuditLogRepository,
    );
  });

  // ============================================================
  // create() → audit_log 'student.create'
  // ============================================================
  describe('create() — audit student.create', () => {
    it('销售即时建学生 → audit_log 调 1 次, action="student.create"', async () => {
      repo.create.mockResolvedValueOnce(
        studentBriefFixture({ ownerSalesId: SALES_A }),
      );
      await controller.create(
        {
          tenantId: TENANT_A,
          tenantSchema: TENANT_SCHEMA,
          id: STUDENT_ID,
          studentName: '小明',
          customerId: CUSTOMER_ID,
          gradeOrAge: '三年级',
          intendedSubject: '英语',
        },
        req(jwt('sales', SALES_A)),
      );
      expect(auditLog.log).toHaveBeenCalledTimes(1);
      const [schema, entry] = auditLog.log.mock.calls[0];
      expect(schema).toBe(TENANT_SCHEMA);
      expect(entry.action).toBe('student.create');
      expect(entry.targetType).toBe('student');
      expect(entry.targetId).toBe(STUDENT_ID);
      expect(entry.before).toBeNull();
      expect(entry.actorUserId).toBe(SALES_A);
      expect(entry.actorRole).toBe('sales');
      expect(entry.after.studentName).toBe('小明');
      expect(entry.after.customerId).toBe(CUSTOMER_ID);
      expect(entry.after.ownerSalesId).toBe(SALES_A); // 销售自建归自己
    });

    it('audit_log.log 抛错 → 不阻塞主业务（fail-open）', async () => {
      repo.create.mockResolvedValueOnce(studentBriefFixture());
      auditLog.log.mockRejectedValueOnce(new Error('audit fail'));
      const r = await controller.create(
        {
          tenantId: TENANT_A,
          tenantSchema: TENANT_SCHEMA,
          id: STUDENT_ID,
          studentName: '小明',
          customerId: CUSTOMER_ID,
        },
        req(jwt('sales', SALES_A)),
      );
      expect(r.id).toBe(STUDENT_ID);
      expect(auditLog.log).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // transferSales() → audit_log 'student.transfer-sales'
  // ============================================================
  describe('transferSales() — audit student.transfer-sales', () => {
    it('校长把学生从 SALES_A 转到 SALES_B → audit before/after 完整', async () => {
      const transferResult: StudentTransferResult = {
        studentId: STUDENT_ID,
        fromUserId: SALES_A,
        toUserId: SALES_B,
        field: 'owner_sales_id',
        reason: '校长再分配',
      };
      repo.transferSales.mockResolvedValueOnce(transferResult);

      await controller.transferSales(
        STUDENT_ID,
        {
          tenantId: TENANT_A,
          tenantSchema: TENANT_SCHEMA,
          toSalesId: SALES_B,
        },
        req(jwt('admin')),
      );

      expect(auditLog.log).toHaveBeenCalledTimes(1);
      const entry = auditLog.log.mock.calls[0][1];
      expect(entry.action).toBe('student.transfer-sales');
      expect(entry.targetType).toBe('student');
      expect(entry.targetId).toBe(STUDENT_ID);
      expect(entry.before).toEqual({ ownerSalesId: SALES_A });
      expect(entry.after).toEqual({
        ownerSalesId: SALES_B,
        field: 'owner_sales_id',
        reason: '校长再分配',
      });
      expect(entry.actorRole).toBe('admin');
    });

    it('销售主动转交（reason 默认）', async () => {
      const transferResult: StudentTransferResult = {
        studentId: STUDENT_ID,
        fromUserId: SALES_A,
        toUserId: SALES_B,
        field: 'owner_sales_id',
        reason: '销售主动转交',
      };
      repo.transferSales.mockResolvedValueOnce(transferResult);
      await controller.transferSales(
        STUDENT_ID,
        { tenantId: TENANT_A, tenantSchema: TENANT_SCHEMA, toSalesId: SALES_B },
        req(jwt('sales', SALES_A)),
      );
      const entry = auditLog.log.mock.calls[0][1];
      expect(entry.after.reason).toBe('销售主动转交');
      expect(entry.actorRole).toBe('sales');
    });
  });

  // ============================================================
  // transferTeacher() → audit_log 'student.transfer-teacher'
  // ============================================================
  describe('transferTeacher() — audit student.transfer-teacher', () => {
    it('hr 把学生主带老师转给 TEACHER_B → audit before/after', async () => {
      const transferResult: StudentTransferResult = {
        studentId: STUDENT_ID,
        fromUserId: TEACHER_ID_A,
        toUserId: TEACHER_ID_B,
        field: 'assigned_teacher_id',
        reason: '校长再分配',
      };
      repo.transferTeacher.mockResolvedValueOnce(transferResult);

      await controller.transferTeacher(
        STUDENT_ID,
        {
          tenantId: TENANT_A,
          tenantSchema: TENANT_SCHEMA,
          toTeacherId: TEACHER_ID_B,
        },
        req(jwt('hr')),
      );

      expect(auditLog.log).toHaveBeenCalledTimes(1);
      const entry = auditLog.log.mock.calls[0][1];
      expect(entry.action).toBe('student.transfer-teacher');
      expect(entry.before).toEqual({ assignedTeacherId: TEACHER_ID_A });
      expect(entry.after.assignedTeacherId).toBe(TEACHER_ID_B);
      expect(entry.after.field).toBe('assigned_teacher_id');
      expect(entry.actorRole).toBe('hr');
    });
  });

  // ============================================================
  // createContract() → audit_log 'contract.create' (OOUX 子对象)
  // ============================================================
  describe('createContract() OOUX — audit contract.create', () => {
    it('OOUX 子对象路径建合同 → audit action="contract.create" + sourceEndpoint="student-children"', async () => {
      const created = {
        id: CONTRACT_ID,
        studentId: STUDENT_ID,
        ownerUserId: SALES_A,
        opportunityId: null,
        campusId: CAMPUS_A,
        courseProductId: null,
        courseProductName: '一对一英语',
        classType: '一对一',
        lessonHours: 60,
        standardPrice: 9999,
        discountAmount: 999,
        giftHours: 5,
        totalAmount: 9000,
        orderType: '新签',
        status: 'pending',
        signedAt: '2026-05-08T00:00:00.000Z',
      };
      contractRepo.create.mockResolvedValueOnce(created);

      await controller.createContract(
        STUDENT_ID,
        {
          tenantId: TENANT_A,
          tenantSchema: TENANT_SCHEMA,
          id: CONTRACT_ID,
          courseProductName: '一对一英语',
          lessonHours: 60,
          standardPrice: 9999,
          totalAmount: 9000,
        },
        req(jwt('sales', SALES_A)),
      );

      expect(auditLog.log).toHaveBeenCalledTimes(1);
      const entry = auditLog.log.mock.calls[0][1];
      expect(entry.action).toBe('contract.create');
      expect(entry.targetType).toBe('contract');
      expect(entry.targetId).toBe(CONTRACT_ID);
      expect(entry.after.totalAmount).toBe(9000);
      expect(entry.after.studentId).toBe(STUDENT_ID);
      // 区分 OOUX 子对象路径
      expect(entry.after.sourceEndpoint).toBe('student-children');
    });
  });
});
