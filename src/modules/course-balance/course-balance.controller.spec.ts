/**
 * CourseBalanceController unit tests — 2026-06-02 走查 D 安全审修
 *
 * 重点：listActiveByStudentInDb owner-scope（POST /api/course-balance/db/students/:studentId/packages）
 *   原缺 @Roles → RbacGuard fail-open 任意租户角色（含 finance/hr）可读 StudentCoursePackage[]（同租户越权）。
 *   修法：by-student owner-scope helper 统一授权（角色级拒绝 finance/hr/unknown + 归属级收口 + parent 绑定）。
 *   本端点 B/C 共享（B 端学员档案课时余额 / C 端家长看孩子余额）；不用 @Roles 因 parent 不在 RbacRole。
 *
 * 直接 new — 跳过 NestJS DI（与 homework.controller.spec 同思路）。helper 自身另有独立 spec。
 */
import { ForbiddenException } from '@nestjs/common';
import { CourseBalanceController } from './course-balance.controller';
import { CourseBalanceService, StudentCoursePackage } from './course-balance.service';
import { TeacherRepository } from '../db/teacher.repository';
import { StudentRepository } from '../db/student.repository';
import { ParentRepository } from '../db/parent.repository';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';

describe('CourseBalanceController — by-student owner-scope（2026-06-02 走查 D 安全审修）', () => {
  let controller: CourseBalanceController;
  let service: { listActiveByStudentInDb: jest.Mock };
  let teacherRepo: { findByUserId: jest.Mock };
  let studentRepo: { findBrief: jest.Mock };
  let parentRepo: { findChildrenByParent: jest.Mock };

  const TENANT = 'tenant_coursebalance_scope_xxxxx1';
  const STUDENT = 'stu00000000000000000000000000C001';
  const TEACHER_T1 = 'tch00000000000000000000000000T001';
  const TEACHER_T2 = 'tch00000000000000000000000000T002';
  const USER_U1 = 'usr00000000000000000000000000U001'; // T1 绑定用户
  const SALES_A = 'salesA0000000000000000000000A001';
  const SALES_B = 'salesB0000000000000000000000B001';

  const baseTeacherT1 = {
    id: TEACHER_T1,
    campusId: 'campus_a_00000000000000000000A001',
    name: 'T1',
    phone: undefined,
    userId: USER_U1,
    subjects: ['数学'],
    status: '在职' as const,
  };

  const fixturePackages: StudentCoursePackage[] = [
    {
      id: 'scp00000000000000000000000000A01',
      studentId: STUDENT,
      coursePackageId: 'cp000000000000000000000000000A1',
      totalLessons: 60,
      usedLessons: 2,
      refundedLessons: 0,
      remainingLessons: 58,
      activatedAt: new Date('2026-06-01T00:00:00Z'),
      expiresAt: new Date('2027-06-01T00:00:00Z'),
      status: 'active',
      lowBalanceAlerted: false,
    },
  ];

  beforeEach(() => {
    service = { listActiveByStudentInDb: jest.fn().mockResolvedValue(fixturePackages) };
    teacherRepo = { findByUserId: jest.fn() };
    studentRepo = { findBrief: jest.fn() };
    parentRepo = { findChildrenByParent: jest.fn() };
    controller = new CourseBalanceController(
      service as unknown as CourseBalanceService,
      studentRepo as unknown as StudentRepository,
      teacherRepo as unknown as TeacherRepository,
      parentRepo as unknown as ParentRepository,
    );
  });

  const mkReq = (overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest =>
    ({
      user: { sub: USER_U1, role: 'teacher', tenantId: 't', campusId: 'c' },
      ip: '1.2.3.4',
      headers: { 'user-agent': 'WeChatMP/8.0', 'x-request-id': 'req-cb' },
      ...overrides,
    }) as AuthenticatedRequest;

  function mockStudent(
    overrides: Partial<{ ownerSalesId: string | null; assignedTeacherId: string | null }> = {},
  ) {
    studentRepo.findBrief.mockResolvedValueOnce({
      id: STUDENT,
      studentName: '小红',
      customerId: 'cust00000000000000000000000000C1',
      ownerSalesId: SALES_A,
      assignedTeacherId: TEACHER_T1,
      ownerChangedAt: null,
      ownerChangeReason: null,
      gradeOrAge: null,
      currentGrade: null,
      gradeBaseYear: null,
      intendedSubject: null,
      ...overrides,
    });
  }

  const body = { tenantSchema: TENANT };

  // ── 核心安全修：finance / hr 越权读被拒（原 fail-open 可读）──
  it('finance → 403，不查课时包（核心：原 fail-open 越权读已堵）', async () => {
    mockStudent();
    await expect(
      controller.listActiveByStudentInDb(
        STUDENT,
        body,
        mkReq({ user: { sub: 'fin000000000000000000000000F001', role: 'finance', tenantId: 't', campusId: 'c' } }),
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(service.listActiveByStudentInDb).not.toHaveBeenCalled();
  });

  it('hr → 403，不查课时包', async () => {
    mockStudent();
    await expect(
      controller.listActiveByStudentInDb(
        STUDENT,
        body,
        mkReq({ user: { sub: 'hr0000000000000000000000000H001', role: 'hr', tenantId: 't', campusId: 'c' } }),
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(service.listActiveByStudentInDb).not.toHaveBeenCalled();
  });

  // ── teacher own-class（走查 D：老师看自己班学员剩余课时）──
  it('teacher 自己班学员 → 放行', async () => {
    mockStudent({ assignedTeacherId: TEACHER_T1 });
    teacherRepo.findByUserId.mockResolvedValueOnce(baseTeacherT1);
    const r = await controller.listActiveByStudentInDb(STUDENT, body, mkReq());
    expect(r).toBe(fixturePackages);
    expect(service.listActiveByStudentInDb).toHaveBeenCalledWith(STUDENT, TENANT);
  });

  it('teacher 非自己班学员 → 403，不查课时包', async () => {
    mockStudent({ assignedTeacherId: TEACHER_T2 });
    teacherRepo.findByUserId.mockResolvedValueOnce(baseTeacherT1);
    await expect(
      controller.listActiveByStudentInDb(STUDENT, body, mkReq()),
    ).rejects.toThrow(ForbiddenException);
    expect(service.listActiveByStudentInDb).not.toHaveBeenCalled();
  });

  // ── sales own-customer ──
  it('sales 自己客户学员（ownerSalesId === me）→ 放行', async () => {
    mockStudent({ ownerSalesId: SALES_A });
    const r = await controller.listActiveByStudentInDb(
      STUDENT,
      body,
      mkReq({ user: { sub: SALES_A, role: 'sales', tenantId: 't', campusId: 'c' } }),
    );
    expect(r).toBe(fixturePackages);
    expect(teacherRepo.findByUserId).not.toHaveBeenCalled();
  });

  it('sales 他人客户学员（ownerSalesId !== me）→ 403', async () => {
    mockStudent({ ownerSalesId: SALES_B });
    await expect(
      controller.listActiveByStudentInDb(
        STUDENT,
        body,
        mkReq({ user: { sub: SALES_A, role: 'sales', tenantId: 't', campusId: 'c' } }),
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(service.listActiveByStudentInDb).not.toHaveBeenCalled();
  });

  // ── admin / academic group 本校放行 ──
  it('academic 本校任意学员 → 放行（不 owner 收口）', async () => {
    mockStudent({ ownerSalesId: SALES_B, assignedTeacherId: TEACHER_T2 });
    await controller.listActiveByStudentInDb(
      STUDENT,
      body,
      mkReq({ user: { sub: 'acd000000000000000000000000A001', role: 'academic', tenantId: 't', campusId: 'c' } }),
    );
    expect(service.listActiveByStudentInDb).toHaveBeenCalledTimes(1);
  });

  it('academic_admin 本校任意学员 → 放行（academic group）', async () => {
    mockStudent({ ownerSalesId: SALES_B });
    await controller.listActiveByStudentInDb(
      STUDENT,
      body,
      mkReq({ user: { sub: 'aca000000000000000000000000A001', role: 'academic_admin', tenantId: 't', campusId: 'c' } }),
    );
    expect(service.listActiveByStudentInDb).toHaveBeenCalledTimes(1);
  });

  it('sales_manager 本校任意学员 → 放行（admin group）', async () => {
    mockStudent({ ownerSalesId: SALES_B });
    await controller.listActiveByStudentInDb(
      STUDENT,
      body,
      mkReq({ user: { sub: 'smg000000000000000000000000M001', role: 'sales_manager', tenantId: 't', campusId: 'c' } }),
    );
    expect(service.listActiveByStudentInDb).toHaveBeenCalledTimes(1);
  });

  it('marketing 本校任意学员 → 放行（academic group）', async () => {
    mockStudent({ ownerSalesId: SALES_B });
    await controller.listActiveByStudentInDb(
      STUDENT,
      body,
      mkReq({ user: { sub: 'mkt000000000000000000000000M001', role: 'marketing', tenantId: 't', campusId: 'c' } }),
    );
    expect(service.listActiveByStudentInDb).toHaveBeenCalledTimes(1);
  });

  it('boss 任意学员 → 放行', async () => {
    mockStudent({ ownerSalesId: SALES_B, assignedTeacherId: TEACHER_T2 });
    await controller.listActiveByStudentInDb(
      STUDENT,
      body,
      mkReq({ user: { sub: 'bos000000000000000000000000B001', role: 'boss', tenantId: 't', campusId: 'c' } }),
    );
    expect(service.listActiveByStudentInDb).toHaveBeenCalledTimes(1);
  });

  // ── parent c 端流（C 端家长看孩子余额，绑定校验防跨家庭 IDOR）──
  // TENANT = 'tenant_coursebalance_scope_xxxxx1' → 派生 tenantId = 'coursebalance_scope_xxxxx1'
  const PARENT_ID = 'parent000000000000000000000P001';
  const TENANT_ID_RAW = 'coursebalance_scope_xxxxx1';
  const parentReqOpts = {
    user: { sub: PARENT_ID, role: 'parent' as any, tenantId: 't', campusId: null },
    parent: { sub: PARENT_ID, parentId: PARENT_ID, role: 'parent' as const },
  };

  it('parent c 端流 自己孩子（studentId ∈ active 绑定）→ 放行', async () => {
    mockStudent({ ownerSalesId: SALES_B, assignedTeacherId: TEACHER_T2 });
    parentRepo.findChildrenByParent.mockResolvedValueOnce([
      { studentId: STUDENT, tenantId: TENANT_ID_RAW, bindingStatus: 'active' },
    ]);
    await controller.listActiveByStudentInDb(STUDENT, body, mkReq(parentReqOpts));
    expect(parentRepo.findChildrenByParent).toHaveBeenCalledWith(PARENT_ID);
    expect(service.listActiveByStudentInDb).toHaveBeenCalledTimes(1);
    expect(teacherRepo.findByUserId).not.toHaveBeenCalled();
  });

  it('parent c 端流 他人孩子（studentId ∉ active 绑定）→ 403（同租户跨家庭 IDOR 拦截）', async () => {
    mockStudent({ ownerSalesId: SALES_B, assignedTeacherId: TEACHER_T2 });
    parentRepo.findChildrenByParent.mockResolvedValueOnce([
      { studentId: 'otherChild00000000000000000O001', tenantId: TENANT_ID_RAW, bindingStatus: 'active' },
    ]);
    await expect(
      controller.listActiveByStudentInDb(STUDENT, body, mkReq(parentReqOpts)),
    ).rejects.toThrow(ForbiddenException);
    expect(service.listActiveByStudentInDb).not.toHaveBeenCalled();
  });

  it('parent 流但 parentRepo 未注入 → 保守拒绝（fail-safe）', async () => {
    const c = new CourseBalanceController(
      service as unknown as CourseBalanceService,
      studentRepo as unknown as StudentRepository,
      teacherRepo as unknown as TeacherRepository,
      // parentRepo 缺失
    );
    mockStudent({ ownerSalesId: SALES_B, assignedTeacherId: TEACHER_T2 });
    await expect(
      c.listActiveByStudentInDb(STUDENT, body, mkReq(parentReqOpts)),
    ).rejects.toThrow(ForbiddenException);
    expect(service.listActiveByStudentInDb).not.toHaveBeenCalled();
  });

  // ── 兜底语义 ──
  it('学员不存在（findBrief=null）→ 放行（避免 enumeration 侧信道）', async () => {
    studentRepo.findBrief.mockResolvedValueOnce(null);
    await controller.listActiveByStudentInDb(
      STUDENT,
      body,
      mkReq({ user: { sub: SALES_A, role: 'sales', tenantId: 't', campusId: 'c' } }),
    );
    expect(service.listActiveByStudentInDb).toHaveBeenCalledTimes(1);
  });

  it('studentRepo 未注入（isolated）→ fail-open 跳过 scope', async () => {
    const c2 = new CourseBalanceController(
      service as unknown as CourseBalanceService,
      undefined,
    );
    await c2.listActiveByStudentInDb(
      STUDENT,
      body,
      mkReq({ user: { sub: SALES_A, role: 'sales', tenantId: 't', campusId: 'c' } }),
    );
    expect(service.listActiveByStudentInDb).toHaveBeenCalledTimes(1);
    expect(studentRepo.findBrief).not.toHaveBeenCalled();
  });
});
