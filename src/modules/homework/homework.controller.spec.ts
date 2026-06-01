/**
 * HomeworkController unit tests — 2026-06-01 同租户 by-student IDOR 修复
 *
 * 重点：listAssignmentsByStudentInDb owner-scope（POST /api/homework/db/students/:studentId/assignments）
 *   原仅 @Roles + TenantScopeGuard，缺学员归属校验 → teacher 可读非自己班、sales 可读非自己客户
 *   学员作业（同租户 by-student IDOR）。本 spec 覆盖 scope 放行/拒绝矩阵。
 *
 * 直接 new — 跳过 NestJS DI（避免 @UseInterceptors(IdempotencyInterceptor) 拉起 RedisService）。
 * RbacGuard / TenantScopeGuard / IdempotencyInterceptor 已有独立 spec 覆盖。
 */
import { ForbiddenException } from '@nestjs/common';
import { HomeworkController } from './homework.controller';
import { HomeworkService, HomeworkAssignment } from './homework.service';
import { TeacherRepository } from '../db/teacher.repository';
import { StudentRepository } from '../db/student.repository';
import { ParentRepository } from '../db/parent.repository';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';

describe('HomeworkController — by-student owner-scope（2026-06-01 IDOR 修复）', () => {
  let controller: HomeworkController;
  let service: { listAssignmentsByStudentInDb: jest.Mock };
  let teacherRepo: { findByUserId: jest.Mock };
  let studentRepo: { findBrief: jest.Mock };
  let parentRepo: { findChildrenByParent: jest.Mock };

  const TENANT = 'tenant_homework_idor_scope_xxxxx1';
  const STUDENT = 'stu00000000000000000000000000H001';
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

  const fixtureAssignments: HomeworkAssignment[] = [
    {
      id: 'hw000000000000000000000000000A01',
      teacherId: TEACHER_T1,
      title: '语文 Unit 3',
      status: 'published',
      recipientStudentIds: [STUDENT],
      createdAt: new Date('2026-06-01T00:00:00Z'),
    },
  ];

  beforeEach(() => {
    service = { listAssignmentsByStudentInDb: jest.fn().mockResolvedValue(fixtureAssignments) };
    teacherRepo = { findByUserId: jest.fn() };
    studentRepo = { findBrief: jest.fn() };
    parentRepo = { findChildrenByParent: jest.fn() };
    controller = new HomeworkController(
      service as unknown as HomeworkService,
      teacherRepo as unknown as TeacherRepository,
      studentRepo as unknown as StudentRepository,
      parentRepo as unknown as ParentRepository,
    );
  });

  const mkReq = (overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest =>
    ({
      user: { sub: USER_U1, role: 'teacher', tenantId: 't', campusId: 'c' },
      ip: '1.2.3.4',
      headers: { 'user-agent': 'WeChatMP/8.0', 'x-request-id': 'req-hw' },
      ...overrides,
    }) as AuthenticatedRequest;

  function mockStudent(
    overrides: Partial<{ ownerSalesId: string | null; assignedTeacherId: string | null }> = {},
  ) {
    studentRepo.findBrief.mockResolvedValueOnce({
      id: STUDENT,
      studentName: '小红',
      customerId: 'cust00000000000000000000000000H1',
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

  it('teacher 自己班学员 → 放行', async () => {
    mockStudent({ assignedTeacherId: TEACHER_T1 });
    teacherRepo.findByUserId.mockResolvedValueOnce(baseTeacherT1);
    const r = await controller.listAssignmentsByStudentInDb(STUDENT, body, mkReq());
    expect(r).toBe(fixtureAssignments);
    expect(service.listAssignmentsByStudentInDb).toHaveBeenCalledWith(STUDENT, TENANT);
  });

  it('teacher 非自己班学员 → 403，不查作业', async () => {
    mockStudent({ assignedTeacherId: TEACHER_T2 });
    teacherRepo.findByUserId.mockResolvedValueOnce(baseTeacherT1);
    await expect(
      controller.listAssignmentsByStudentInDb(STUDENT, body, mkReq()),
    ).rejects.toThrow(ForbiddenException);
    expect(service.listAssignmentsByStudentInDb).not.toHaveBeenCalled();
  });

  it('teacher 未绑 teachers 档案 → 403', async () => {
    mockStudent();
    teacherRepo.findByUserId.mockResolvedValueOnce(null);
    await expect(
      controller.listAssignmentsByStudentInDb(STUDENT, body, mkReq()),
    ).rejects.toThrow(ForbiddenException);
    expect(service.listAssignmentsByStudentInDb).not.toHaveBeenCalled();
  });

  it('sales 自己客户学员（ownerSalesId === me）→ 放行', async () => {
    mockStudent({ ownerSalesId: SALES_A });
    const r = await controller.listAssignmentsByStudentInDb(
      STUDENT,
      body,
      mkReq({ user: { sub: SALES_A, role: 'sales', tenantId: 't', campusId: 'c' } }),
    );
    expect(r).toBe(fixtureAssignments);
    // sales 不走 teacher 反查
    expect(teacherRepo.findByUserId).not.toHaveBeenCalled();
  });

  it('sales 他人客户学员（ownerSalesId !== me）→ 403，不查作业', async () => {
    mockStudent({ ownerSalesId: SALES_B });
    await expect(
      controller.listAssignmentsByStudentInDb(
        STUDENT,
        body,
        mkReq({ user: { sub: SALES_A, role: 'sales', tenantId: 't', campusId: 'c' } }),
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(service.listAssignmentsByStudentInDb).not.toHaveBeenCalled();
  });

  it('academic 本校任意学员 → 放行（不 owner 收口）', async () => {
    mockStudent({ ownerSalesId: SALES_B, assignedTeacherId: TEACHER_T2 });
    await controller.listAssignmentsByStudentInDb(
      STUDENT,
      body,
      mkReq({ user: { sub: 'acd000000000000000000000000A001', role: 'academic', tenantId: 't', campusId: 'c' } }),
    );
    expect(service.listAssignmentsByStudentInDb).toHaveBeenCalledTimes(1);
  });

  it('marketing 本校任意学员 → 放行（academic group）', async () => {
    mockStudent({ ownerSalesId: SALES_B });
    await controller.listAssignmentsByStudentInDb(
      STUDENT,
      body,
      mkReq({ user: { sub: 'mkt000000000000000000000000M001', role: 'marketing', tenantId: 't', campusId: 'c' } }),
    );
    expect(service.listAssignmentsByStudentInDb).toHaveBeenCalledTimes(1);
  });

  it('boss 任意学员 → 放行', async () => {
    mockStudent({ ownerSalesId: SALES_B, assignedTeacherId: TEACHER_T2 });
    await controller.listAssignmentsByStudentInDb(
      STUDENT,
      body,
      mkReq({ user: { sub: 'bos000000000000000000000000B001', role: 'boss', tenantId: 't', campusId: 'c' } }),
    );
    expect(service.listAssignmentsByStudentInDb).toHaveBeenCalledTimes(1);
  });

  // 2026-06-01 parent↔student 绑定 IDOR 修复：parent c 端流不再无条件 bypass
  //   TENANT = 'tenant_homework_idor_scope_xxxxx1' → 派生 tenantId = 'homework_idor_scope_xxxxx1'
  const PARENT_ID = 'parent000000000000000000000P001';
  const TENANT_ID_RAW = 'homework_idor_scope_xxxxx1';
  const parentReqOpts = {
    user: { sub: PARENT_ID, role: 'parent' as any, tenantId: 't', campusId: null },
    parent: { sub: PARENT_ID, parentId: PARENT_ID, role: 'parent' as const },
  };

  it('parent c 端流 自己孩子（studentId ∈ active 绑定）→ 放行', async () => {
    mockStudent({ ownerSalesId: SALES_B, assignedTeacherId: TEACHER_T2 });
    parentRepo.findChildrenByParent.mockResolvedValueOnce([
      { studentId: STUDENT, tenantId: TENANT_ID_RAW, bindingStatus: 'active' },
    ]);
    await controller.listAssignmentsByStudentInDb(STUDENT, body, mkReq(parentReqOpts));
    expect(parentRepo.findChildrenByParent).toHaveBeenCalledWith(PARENT_ID);
    expect(service.listAssignmentsByStudentInDb).toHaveBeenCalledTimes(1);
    // parent 自己孩子：不做 teacher own-class 反查
    expect(teacherRepo.findByUserId).not.toHaveBeenCalled();
  });

  it('parent c 端流 他人孩子（studentId ∉ active 绑定）→ 403，不查作业（同租户 IDOR 拦截）', async () => {
    mockStudent({ ownerSalesId: SALES_B, assignedTeacherId: TEACHER_T2 });
    parentRepo.findChildrenByParent.mockResolvedValueOnce([
      { studentId: 'otherChild00000000000000000O001', tenantId: TENANT_ID_RAW, bindingStatus: 'active' },
    ]);
    await expect(
      controller.listAssignmentsByStudentInDb(STUDENT, body, mkReq(parentReqOpts)),
    ).rejects.toThrow(ForbiddenException);
    expect(service.listAssignmentsByStudentInDb).not.toHaveBeenCalled();
  });

  it('parent 流但 parentRepo 未注入 → 保守拒绝（fail-safe）', async () => {
    const c = new HomeworkController(
      service as unknown as HomeworkService,
      teacherRepo as unknown as TeacherRepository,
      studentRepo as unknown as StudentRepository,
      // parentRepo 缺失
    );
    mockStudent({ ownerSalesId: SALES_B, assignedTeacherId: TEACHER_T2 });
    await expect(
      c.listAssignmentsByStudentInDb(STUDENT, body, mkReq(parentReqOpts)),
    ).rejects.toThrow(ForbiddenException);
    expect(service.listAssignmentsByStudentInDb).not.toHaveBeenCalled();
  });

  it('学员不存在（findBrief=null）→ 放行（避免 enumeration 侧信道）', async () => {
    studentRepo.findBrief.mockResolvedValueOnce(null);
    await controller.listAssignmentsByStudentInDb(
      STUDENT,
      body,
      mkReq({ user: { sub: SALES_A, role: 'sales', tenantId: 't', campusId: 'c' } }),
    );
    expect(service.listAssignmentsByStudentInDb).toHaveBeenCalledTimes(1);
  });

  it('studentRepo 未注入（isolated）→ fail-open 跳过 scope（仅 @Roles 兜底）', async () => {
    const c2 = new HomeworkController(
      service as unknown as HomeworkService,
      teacherRepo as unknown as TeacherRepository,
      undefined,
    );
    await c2.listAssignmentsByStudentInDb(
      STUDENT,
      body,
      mkReq({ user: { sub: SALES_A, role: 'sales', tenantId: 't', campusId: 'c' } }),
    );
    expect(service.listAssignmentsByStudentInDb).toHaveBeenCalledTimes(1);
    expect(studentRepo.findBrief).not.toHaveBeenCalled();
  });
});
