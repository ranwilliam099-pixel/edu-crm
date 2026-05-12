/**
 * RecurringScheduleController unit tests — Sprint B.4-1 (2026-05-12)
 *
 * 重点：
 *   1. createBinding / createRecurring server 派生 callerRole + boundByUserId/createdByUserId
 *      （body 自报字段被覆盖）
 *   2. JWT.role ∉ {teacher, sales} → 403 ONLY_TEACHER_OR_SALES
 *   3. sales 路径：studentRepo.findBrief 反查 owner_sales_id
 *      - sales 创建自己学员的绑定/模板 → ✅
 *      - sales 创建他人学员的绑定 → 403 STUDENT_NOT_OWNED_BY_SALES
 *   4. teacher 路径：teacherRepo.findById 反查 user_id
 *      - teacher 给自己绑定的 teacherId → ✅
 *      - teacher user_id 与 JWT.sub 不一致 → 403 TEACHER_USER_NOT_BOUND
 */
import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { RecurringScheduleController } from './recurring-schedule.controller';
import {
  RecurringScheduleService,
  StudentTeacherBinding,
  RecurringSchedule,
} from './recurring-schedule.service';
import { TeacherRepository } from '../db/teacher.repository';
import { StudentRepository } from '../db/student.repository';
import { AuditLogRepository } from '../db/audit-log.repository';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';

describe('RecurringScheduleController — Sprint B.4-1 server-derived RBAC', () => {
  let controller: RecurringScheduleController;
  let svc: {
    createBinding: jest.Mock;
    unbindBinding: jest.Mock;
    createRecurring: jest.Mock;
    archiveRecurring: jest.Mock;
    expandToCandidates: jest.Mock;
  };
  let teacherRepo: { findById: jest.Mock };
  let studentRepo: { findBrief: jest.Mock };
  // Sprint E backlog #3: audit_log mock
  let auditLog: { log: jest.Mock };

  const TENANT = 'tenant_b41_recur_xxxxxxxxxxxxxxxx';
  const BINDING_ID = 'bnd00000000000000000000000000B001';
  const REC_ID = 'rec00000000000000000000000000R001';
  const STUDENT_S1 = 'stu00000000000000000000000000S001';
  const TEACHER_T1 = 'tch00000000000000000000000000T001';
  const TEACHER_T2 = 'tch00000000000000000000000000T002';
  const USER_SALES_U1 = 'usr00000000000000000000000000U001';
  const USER_SALES_U2 = 'usr00000000000000000000000000U002';
  const USER_TEACHER_U3 = 'usr00000000000000000000000000U003'; // T1 bound
  const USER_TEACHER_U4 = 'usr00000000000000000000000000U004'; // not bound

  const teacherT1Row = {
    id: TEACHER_T1,
    campusId: 'cmp_x00000000000000000000000000X1',
    name: 'T1',
    userId: USER_TEACHER_U3,
    subjects: ['数学'],
    status: '在职' as const,
  };
  const teacherT2Row = {
    id: TEACHER_T2,
    campusId: 'cmp_x00000000000000000000000000X1',
    name: 'T2',
    userId: undefined, // 纯档案，没 bound user
    subjects: ['英语'],
    status: '在职' as const,
  };

  const studentS1OwnerU1 = {
    id: STUDENT_S1,
    ownerSalesId: USER_SALES_U1,
    studentName: '',
    customerId: '',
    assignedTeacherId: null,
    ownerChangedAt: null,
    ownerChangeReason: null,
    gradeOrAge: null,
    intendedSubject: null,
  };
  const studentS1OwnerU2 = { ...studentS1OwnerU1, ownerSalesId: USER_SALES_U2 };

  const mkReq = (overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest =>
    ({
      user: {
        sub: USER_SALES_U1,
        role: 'sales',
        tenantId: 'tenant-x',
        campusId: 'campus-x',
      },
      ip: '1.2.3.4',
      headers: { 'user-agent': 'WeChatMP/8.0' },
      ...overrides,
    }) as AuthenticatedRequest;

  beforeEach(() => {
    svc = {
      createBinding: jest.fn(),
      unbindBinding: jest.fn(),
      createRecurring: jest.fn(),
      archiveRecurring: jest.fn(),
      expandToCandidates: jest.fn(),
    };
    teacherRepo = { findById: jest.fn() };
    studentRepo = { findBrief: jest.fn() };
    auditLog = { log: jest.fn().mockResolvedValue(undefined) };
    controller = new RecurringScheduleController(
      svc as unknown as RecurringScheduleService,
      teacherRepo as unknown as TeacherRepository,
      studentRepo as unknown as StudentRepository,
      auditLog as unknown as AuditLogRepository,
    );
  });

  // ===========================================================
  // createBinding
  // ===========================================================
  describe('createBinding — RBAC server 派生', () => {
    it('sales 给自己学员创建绑定 → ✅，boundByUserId 派生为 JWT.sub', async () => {
      studentRepo.findBrief.mockResolvedValueOnce(studentS1OwnerU1);
      svc.createBinding.mockResolvedValueOnce({
        id: BINDING_ID,
        status: 'active',
      } as StudentTeacherBinding);

      await controller.createBinding(
        {
          id: BINDING_ID,
          studentId: STUDENT_S1,
          teacherId: TEACHER_T1,
          tenantSchema: TENANT,
          boundByUserId: 'attacker', // 攻击向量
        },
        mkReq(),
      );

      const passed = svc.createBinding.mock.calls[0][0];
      expect(passed.boundByUserId).toBe(USER_SALES_U1); // 派生覆盖
      const rbac = svc.createBinding.mock.calls[0][1];
      expect(rbac.callerRole).toBe('sales');
      expect(rbac.currentUserId).toBe(USER_SALES_U1);
      expect(rbac.studentResponsibleSalesId).toBe(USER_SALES_U1);
    });

    it('sales 给他人学员创建绑定 → 403 STUDENT_NOT_OWNED_BY_SALES（service 抛）', async () => {
      studentRepo.findBrief.mockResolvedValueOnce(studentS1OwnerU2);
      svc.createBinding.mockImplementationOnce(() => {
        throw new ForbiddenException(`STUDENT_NOT_OWNED_BY_SALES: studentId=${STUDENT_S1}`);
      });

      await expect(
        controller.createBinding(
          {
            id: BINDING_ID,
            studentId: STUDENT_S1,
            teacherId: TEACHER_T1,
            tenantSchema: TENANT,
          },
          mkReq(),
        ),
      ).rejects.toThrow(/STUDENT_NOT_OWNED_BY_SALES/);
    });

    it('teacher 给自己绑定的 teacherId 创建 → ✅', async () => {
      teacherRepo.findById.mockResolvedValueOnce(teacherT1Row);
      svc.createBinding.mockResolvedValueOnce({
        id: BINDING_ID,
        status: 'active',
      } as StudentTeacherBinding);

      await controller.createBinding(
        {
          id: BINDING_ID,
          studentId: STUDENT_S1,
          teacherId: TEACHER_T1,
          tenantSchema: TENANT,
        },
        mkReq({
          user: {
            sub: USER_TEACHER_U3,
            role: 'teacher',
            tenantId: 'tenant-x',
            campusId: 'campus-x',
          },
        }),
      );

      const passed = svc.createBinding.mock.calls[0][0];
      expect(passed.boundByUserId).toBe(USER_TEACHER_U3);
      const rbac = svc.createBinding.mock.calls[0][1];
      expect(rbac.callerRole).toBe('teacher');
      expect(rbac.teacherUserId).toBe(USER_TEACHER_U3);
    });

    it('teacher 给他人 teacherId（user_id 不匹配）→ 403（service 抛）', async () => {
      teacherRepo.findById.mockResolvedValueOnce(teacherT1Row); // T1 bound 到 U3
      svc.createBinding.mockImplementationOnce(() => {
        throw new ForbiddenException('TEACHER_USER_NOT_BOUND');
      });

      // U4 想给 T1 创建绑定，但 T1.userId = U3 ≠ U4
      await expect(
        controller.createBinding(
          {
            id: BINDING_ID,
            studentId: STUDENT_S1,
            teacherId: TEACHER_T1,
            tenantSchema: TENANT,
          },
          mkReq({
            user: {
              sub: USER_TEACHER_U4,
              role: 'teacher',
              tenantId: 'tenant-x',
              campusId: 'campus-x',
            },
          }),
        ),
      ).rejects.toThrow(/TEACHER_USER_NOT_BOUND/);
    });

    it('teacher 反查 teacher 表无 userId（纯档案）→ rbacContext.teacherUserId=null → service 抛', async () => {
      teacherRepo.findById.mockResolvedValueOnce(teacherT2Row); // T2 userId undefined
      svc.createBinding.mockImplementationOnce(() => {
        throw new ForbiddenException('TEACHER_USER_NOT_BOUND: teacherId=t2 反查不到 user_id');
      });

      await expect(
        controller.createBinding(
          {
            id: BINDING_ID,
            studentId: STUDENT_S1,
            teacherId: TEACHER_T2,
            tenantSchema: TENANT,
          },
          mkReq({
            user: {
              sub: USER_TEACHER_U3,
              role: 'teacher',
              tenantId: 'tenant-x',
              campusId: 'campus-x',
            },
          }),
        ),
      ).rejects.toThrow(/TEACHER_USER_NOT_BOUND/);
      const rbac = svc.createBinding.mock.calls[0][1];
      expect(rbac.teacherUserId).toBe(null);
    });

    it('sales 学员反查不到（不在该租户）→ 403 STUDENT_NOT_FOUND', async () => {
      studentRepo.findBrief.mockResolvedValueOnce(null);
      await expect(
        controller.createBinding(
          {
            id: BINDING_ID,
            studentId: STUDENT_S1,
            teacherId: TEACHER_T1,
            tenantSchema: TENANT,
          },
          mkReq(),
        ),
      ).rejects.toThrow(/STUDENT_NOT_FOUND/);
      expect(svc.createBinding).not.toHaveBeenCalled();
    });

    it('JWT role=admin → 403 ONLY_TEACHER_OR_SALES（早于 repo 查询）', async () => {
      await expect(
        controller.createBinding(
          {
            id: BINDING_ID,
            studentId: STUDENT_S1,
            teacherId: TEACHER_T1,
            tenantSchema: TENANT,
          },
          mkReq({
            user: {
              sub: 'admin_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
              role: 'admin',
              tenantId: null,
              campusId: null,
            },
          }),
        ),
      ).rejects.toThrow(/ONLY_TEACHER_OR_SALES/);
      expect(studentRepo.findBrief).not.toHaveBeenCalled();
      expect(teacherRepo.findById).not.toHaveBeenCalled();
    });

    it('Sprint B.4-1 round 2: 缺 tenantSchema → 400 TENANT_SCHEMA_REQUIRED（A04 修复，旧 fixture 模式删除）', async () => {
      await expect(
        controller.createBinding(
          {
            id: BINDING_ID,
            studentId: STUDENT_S1,
            teacherId: TEACHER_T1,
          } as any,
          mkReq(),
        ),
      ).rejects.toThrow(/TENANT_SCHEMA_REQUIRED/);

      // 不调 service，不查 repo
      expect(svc.createBinding).not.toHaveBeenCalled();
      expect(studentRepo.findBrief).not.toHaveBeenCalled();
      expect(teacherRepo.findById).not.toHaveBeenCalled();
    });
  });

  // ===========================================================
  // createRecurring
  // ===========================================================
  describe('createRecurring — RBAC server 派生', () => {
    const baseInputDto = {
      id: REC_ID,
      bindingId: BINDING_ID,
      studentId: STUDENT_S1,
      teacherId: TEACHER_T1,
      byDay: ['MO' as const],
      startMinutes: 18 * 60,
      durationMin: 60,
      startDate: '2026-05-04T00:00:00Z',
      createdByUserId: 'attacker', // 攻击向量
      createdByRole: 'teacher' as const, // 攻击向量（sales 自报为 teacher）
    };

    it('sales 自报 createdByRole=teacher + 自己学员 → service 收到的 input 是 sales/JWT.sub', async () => {
      studentRepo.findBrief.mockResolvedValueOnce(studentS1OwnerU1);
      svc.createRecurring.mockResolvedValueOnce({
        id: REC_ID,
        status: 'active',
      } as RecurringSchedule);

      await controller.createRecurring(
        {
          input: baseInputDto,
          expandRangeDays: 30,
          existingSchedules: [],
          tenantSchema: TENANT,
        },
        mkReq(),
      );

      const passedInput = svc.createRecurring.mock.calls[0][0];
      expect(passedInput.createdByUserId).toBe(USER_SALES_U1); // server 派生
      expect(passedInput.createdByRole).toBe('sales'); // server 派生

      const rbac = svc.createRecurring.mock.calls[0][4]; // 第 5 参数
      expect(rbac.callerRole).toBe('sales');
      expect(rbac.studentResponsibleSalesId).toBe(USER_SALES_U1);
    });

    it('sales 创建他人学员模板 → service 收到 rbac.studentResponsibleSalesId=U2，service 抛', async () => {
      studentRepo.findBrief.mockResolvedValueOnce(studentS1OwnerU2);
      svc.createRecurring.mockImplementationOnce(() => {
        throw new ForbiddenException(`STUDENT_NOT_OWNED_BY_SALES`);
      });

      await expect(
        controller.createRecurring(
          {
            input: baseInputDto,
            expandRangeDays: 30,
            existingSchedules: [],
            tenantSchema: TENANT,
          },
          mkReq(),
        ),
      ).rejects.toThrow(/STUDENT_NOT_OWNED_BY_SALES/);
      const rbac = svc.createRecurring.mock.calls[0][4];
      expect(rbac.studentResponsibleSalesId).toBe(USER_SALES_U2);
    });

    it('teacher 给自己绑定的 teacherId 创建模板 → ✅', async () => {
      teacherRepo.findById.mockResolvedValueOnce(teacherT1Row);
      svc.createRecurring.mockResolvedValueOnce({
        id: REC_ID,
        status: 'active',
      } as RecurringSchedule);

      await controller.createRecurring(
        {
          input: baseInputDto,
          expandRangeDays: 30,
          existingSchedules: [],
          tenantSchema: TENANT,
        },
        mkReq({
          user: {
            sub: USER_TEACHER_U3,
            role: 'teacher',
            tenantId: 'tenant-x',
            campusId: 'campus-x',
          },
        }),
      );

      const passedInput = svc.createRecurring.mock.calls[0][0];
      expect(passedInput.createdByUserId).toBe(USER_TEACHER_U3);
      expect(passedInput.createdByRole).toBe('teacher');
      const rbac = svc.createRecurring.mock.calls[0][4];
      expect(rbac.teacherUserId).toBe(USER_TEACHER_U3);
    });

    it('teacher 给他人 teacherId 创建模板 → rbac.teacherUserId 不匹配，service 抛', async () => {
      teacherRepo.findById.mockResolvedValueOnce(teacherT1Row); // T1 bound to U3
      svc.createRecurring.mockImplementationOnce(() => {
        throw new ForbiddenException('TEACHER_USER_NOT_BOUND');
      });

      await expect(
        controller.createRecurring(
          {
            input: baseInputDto,
            expandRangeDays: 30,
            existingSchedules: [],
            tenantSchema: TENANT,
          },
          mkReq({
            user: {
              sub: USER_TEACHER_U4, // 不是 T1 绑定的 U3
              role: 'teacher',
              tenantId: 'tenant-x',
              campusId: 'campus-x',
            },
          }),
        ),
      ).rejects.toThrow(/TEACHER_USER_NOT_BOUND/);
      const rbac = svc.createRecurring.mock.calls[0][4];
      expect(rbac.teacherUserId).toBe(USER_TEACHER_U3); // 派生的，不是 attacker U4
    });

    it('JWT role=academic → 403 早期挡', async () => {
      await expect(
        controller.createRecurring(
          {
            input: baseInputDto,
            expandRangeDays: 30,
            existingSchedules: [],
            tenantSchema: TENANT,
          },
          mkReq({
            user: {
              sub: 'acad_ccccccccccccccccccccccccccccccc1',
              role: 'academic',
              tenantId: 'tenant-x',
              campusId: 'campus-x',
            },
          }),
        ),
      ).rejects.toThrow(/ONLY_TEACHER_OR_SALES/);
      expect(studentRepo.findBrief).not.toHaveBeenCalled();
      expect(teacherRepo.findById).not.toHaveBeenCalled();
    });

    it('Sprint B.4-1 round 2: 缺 tenantSchema → 400 TENANT_SCHEMA_REQUIRED（A04 修复，旧 fixture 模式删除）', async () => {
      await expect(
        controller.createRecurring(
          {
            input: baseInputDto,
            expandRangeDays: 30,
            existingSchedules: [],
          } as any,
          mkReq(),
        ),
      ).rejects.toThrow(/TENANT_SCHEMA_REQUIRED/);

      // 不调 service，不查 repo
      expect(svc.createRecurring).not.toHaveBeenCalled();
      expect(studentRepo.findBrief).not.toHaveBeenCalled();
      expect(teacherRepo.findById).not.toHaveBeenCalled();
    });
  });

  // ===========================================================
  // Sprint B.4-1 round 2: 4 个写 endpoint 早期 403（business P1-A）
  // ===========================================================
  describe('unbindBinding — 早期 403 角色限制 (Sprint B.4-1 round 2 P1-A)', () => {
    const dummyBinding: StudentTeacherBinding = {
      id: BINDING_ID,
      studentId: STUDENT_S1,
      teacherId: TEACHER_T1,
      status: 'active',
      boundAt: new Date('2026-05-01T00:00:00Z'),
      boundByUserId: USER_SALES_U1,
    };

    it('JWT role=admin → 403 ONLY_TEACHER_OR_SALES（早于 service）', async () => {
      await expect(
        controller.unbindBinding(
          BINDING_ID,
          { binding: dummyBinding, tenantSchema: TENANT },
          mkReq({
            user: {
              sub: 'admin_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
              role: 'admin',
              tenantId: null,
              campusId: null,
            },
          }),
        ),
      ).rejects.toThrow(/ONLY_TEACHER_OR_SALES/);
      expect(svc.unbindBinding).not.toHaveBeenCalled();
      // Sprint E backlog #3: 拒绝路径 audit_log
      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({
          action: 'recurring-binding.unbind.denied',
          targetType: 'student_teacher_binding',
          targetId: BINDING_ID,
        }),
      );
    });

    it('JWT role=finance → 403 ONLY_TEACHER_OR_SALES', async () => {
      await expect(
        controller.unbindBinding(
          BINDING_ID,
          { binding: dummyBinding, tenantSchema: TENANT },
          mkReq({
            user: {
              sub: 'finance_ffffffffffffffffffffffffffffff1',
              role: 'finance',
              tenantId: 'tenant-x',
              campusId: 'campus-x',
            },
          }),
        ),
      ).rejects.toThrow(/ONLY_TEACHER_OR_SALES/);
    });

    it('JWT role=academic → 403 ONLY_TEACHER_OR_SALES', async () => {
      await expect(
        controller.unbindBinding(
          BINDING_ID,
          { binding: dummyBinding, tenantSchema: TENANT },
          mkReq({
            user: {
              sub: 'acad_ccccccccccccccccccccccccccccccc1',
              role: 'academic',
              tenantId: 'tenant-x',
              campusId: 'campus-x',
            },
          }),
        ),
      ).rejects.toThrow(/ONLY_TEACHER_OR_SALES/);
    });

    it('JWT role=sales → 调用 service + 成功 audit_log', async () => {
      svc.unbindBinding.mockReturnValueOnce({
        ...dummyBinding,
        status: 'unbound',
        unboundAt: new Date(),
      } as StudentTeacherBinding);
      await controller.unbindBinding(
        BINDING_ID,
        { binding: dummyBinding, tenantSchema: TENANT },
        mkReq(),
      );
      expect(svc.unbindBinding).toHaveBeenCalledTimes(1);
      // Sprint E backlog #3: 成功路径 audit_log
      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({
          action: 'recurring-binding.unbind',
          targetType: 'student_teacher_binding',
          targetId: BINDING_ID,
        }),
      );
    });

    it('JWT role=teacher → 调用 service', async () => {
      svc.unbindBinding.mockReturnValueOnce({
        ...dummyBinding,
        status: 'unbound',
        unboundAt: new Date(),
      } as StudentTeacherBinding);
      await controller.unbindBinding(
        BINDING_ID,
        { binding: dummyBinding, tenantSchema: TENANT },
        mkReq({
          user: {
            sub: USER_TEACHER_U3,
            role: 'teacher',
            tenantId: 'tenant-x',
            campusId: 'campus-x',
          },
        }),
      );
      expect(svc.unbindBinding).toHaveBeenCalledTimes(1);
    });
  });

  describe('archiveRecurring — 早期 403 角色限制 (Sprint B.4-1 round 2 P1-A)', () => {
    const dummyRecurring: RecurringSchedule = {
      id: REC_ID,
      bindingId: BINDING_ID,
      studentId: STUDENT_S1,
      teacherId: TEACHER_T1,
      byDay: ['MO'],
      startMinutes: 18 * 60,
      durationMin: 60,
      startDate: new Date('2026-05-04T00:00:00Z'),
      status: 'active',
      createdByUserId: USER_SALES_U1,
      createdByRole: 'sales',
      createdAt: new Date('2026-05-01T00:00:00Z'),
    };

    it('JWT role=admin → 403 ONLY_TEACHER_OR_SALES（早于 service）', async () => {
      await expect(
        controller.archiveRecurring(
          REC_ID,
          { recurring: dummyRecurring, tenantSchema: TENANT },
          mkReq({
            user: {
              sub: 'admin_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
              role: 'admin',
              tenantId: null,
              campusId: null,
            },
          }),
        ),
      ).rejects.toThrow(/ONLY_TEACHER_OR_SALES/);
      expect(svc.archiveRecurring).not.toHaveBeenCalled();
      // Sprint E backlog #3: 拒绝路径 audit_log
      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({
          action: 'recurring-schedule.archive.denied',
          targetType: 'recurring_schedule',
          targetId: REC_ID,
        }),
      );
    });

    it('JWT role=parent → 403 ONLY_TEACHER_OR_SALES', async () => {
      await expect(
        controller.archiveRecurring(
          REC_ID,
          { recurring: dummyRecurring, tenantSchema: TENANT },
          mkReq({
            user: {
              sub: 'parent_ppppppppppppppppppppppppppppp1',
              role: 'sales_director', // 取一个不在 {teacher,sales} 的合法角色
              tenantId: 'tenant-x',
              campusId: null,
            },
          }),
        ),
      ).rejects.toThrow(/ONLY_TEACHER_OR_SALES/);
    });

    it('JWT role=sales → 调用 service + 成功 audit_log', async () => {
      svc.archiveRecurring.mockReturnValueOnce({
        ...dummyRecurring,
        status: 'archived',
        archivedAt: new Date(),
      } as RecurringSchedule);
      await controller.archiveRecurring(
        REC_ID,
        { recurring: dummyRecurring, tenantSchema: TENANT },
        mkReq(),
      );
      expect(svc.archiveRecurring).toHaveBeenCalledTimes(1);
      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({
          action: 'recurring-schedule.archive',
          targetType: 'recurring_schedule',
          targetId: REC_ID,
        }),
      );
    });

    it('JWT role=teacher → 调用 service', async () => {
      svc.archiveRecurring.mockReturnValueOnce({
        ...dummyRecurring,
        status: 'archived',
        archivedAt: new Date(),
      } as RecurringSchedule);
      await controller.archiveRecurring(
        REC_ID,
        { recurring: dummyRecurring, tenantSchema: TENANT },
        mkReq({
          user: {
            sub: USER_TEACHER_U3,
            role: 'teacher',
            tenantId: 'tenant-x',
            campusId: 'campus-x',
          },
        }),
      );
      expect(svc.archiveRecurring).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================
  // Sprint E backlog #3: createBinding / createRecurring 成功 audit_log
  // ===========================================================
  describe('createBinding / createRecurring — 成功路径 audit_log (Sprint E #3)', () => {
    it('createBinding 成功 → audit_log action=recurring-binding.create + 含 studentId/teacherId', async () => {
      studentRepo.findBrief.mockResolvedValueOnce(studentS1OwnerU1);
      svc.createBinding.mockResolvedValueOnce({
        id: BINDING_ID,
        studentId: STUDENT_S1,
        teacherId: TEACHER_T1,
        status: 'active',
        boundAt: new Date('2026-05-13T00:00:00Z'),
        boundByUserId: USER_SALES_U1,
      } as StudentTeacherBinding);

      await controller.createBinding(
        {
          id: BINDING_ID,
          studentId: STUDENT_S1,
          teacherId: TEACHER_T1,
          tenantSchema: TENANT,
        },
        mkReq(),
      );

      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({
          action: 'recurring-binding.create',
          targetType: 'student_teacher_binding',
          targetId: BINDING_ID,
          actorUserId: USER_SALES_U1,
          actorRole: 'sales',
          before: null,
          after: expect.objectContaining({
            id: BINDING_ID,
            studentId: STUDENT_S1,
            teacherId: TEACHER_T1,
            status: 'active',
          }),
        }),
      );
    });

    it('createBinding 403 (admin) → audit_log action=recurring-binding.create.denied', async () => {
      await expect(
        controller.createBinding(
          {
            id: BINDING_ID,
            studentId: STUDENT_S1,
            teacherId: TEACHER_T1,
            tenantSchema: TENANT,
          },
          mkReq({
            user: {
              sub: 'admin_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
              role: 'admin',
              tenantId: null,
              campusId: null,
            },
          }),
        ),
      ).rejects.toThrow(/ONLY_TEACHER_OR_SALES/);
      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({
          action: 'recurring-binding.create.denied',
          targetType: 'student_teacher_binding',
          targetId: BINDING_ID,
        }),
      );
    });

    it('createBinding 缺 tenantSchema → audit_log denied + tenantSchema=unknown', async () => {
      await expect(
        controller.createBinding(
          {
            id: BINDING_ID,
            studentId: STUDENT_S1,
            teacherId: TEACHER_T1,
          } as any,
          mkReq(),
        ),
      ).rejects.toThrow(/TENANT_SCHEMA_REQUIRED/);
      expect(auditLog.log).toHaveBeenCalledWith(
        'unknown',
        expect.objectContaining({
          action: 'recurring-binding.create.denied',
          after: expect.objectContaining({
            reason: 'TENANT_SCHEMA_REQUIRED',
          }),
        }),
      );
    });

    it('createRecurring 成功 → audit_log action=recurring-schedule.create', async () => {
      studentRepo.findBrief.mockResolvedValueOnce(studentS1OwnerU1);
      svc.createRecurring.mockResolvedValueOnce({
        id: REC_ID,
        bindingId: BINDING_ID,
        studentId: STUDENT_S1,
        teacherId: TEACHER_T1,
        byDay: ['MO'],
        startMinutes: 18 * 60,
        durationMin: 60,
        startDate: new Date('2026-05-04T00:00:00Z'),
        status: 'active',
        createdByUserId: USER_SALES_U1,
        createdByRole: 'sales',
        createdAt: new Date('2026-05-13T00:00:00Z'),
      } as RecurringSchedule);

      await controller.createRecurring(
        {
          input: {
            id: REC_ID,
            bindingId: BINDING_ID,
            studentId: STUDENT_S1,
            teacherId: TEACHER_T1,
            byDay: ['MO' as const],
            startMinutes: 18 * 60,
            durationMin: 60,
            startDate: '2026-05-04T00:00:00Z',
          },
          expandRangeDays: 30,
          existingSchedules: [],
          tenantSchema: TENANT,
        },
        mkReq(),
      );

      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({
          action: 'recurring-schedule.create',
          targetType: 'recurring_schedule',
          targetId: REC_ID,
          before: null,
        }),
      );
    });

    it('createRecurring 403 → audit_log denied', async () => {
      await expect(
        controller.createRecurring(
          {
            input: {
              id: REC_ID,
              bindingId: BINDING_ID,
              studentId: STUDENT_S1,
              teacherId: TEACHER_T1,
              byDay: ['MO' as const],
              startMinutes: 18 * 60,
              durationMin: 60,
              startDate: '2026-05-04T00:00:00Z',
            },
            expandRangeDays: 30,
            existingSchedules: [],
            tenantSchema: TENANT,
          },
          mkReq({
            user: {
              sub: 'acad_ccccccccccccccccccccccccccccccc1',
              role: 'academic',
              tenantId: 'tenant-x',
              campusId: 'campus-x',
            },
          }),
        ),
      ).rejects.toThrow(/ONLY_TEACHER_OR_SALES/);
      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({
          action: 'recurring-schedule.create.denied',
          targetType: 'recurring_schedule',
          targetId: REC_ID,
        }),
      );
    });

    it('auditLog 不存在（@Optional 未注入）→ 主业务流不阻塞', async () => {
      const ctrlNoAudit = new RecurringScheduleController(
        svc as unknown as RecurringScheduleService,
        teacherRepo as unknown as TeacherRepository,
        studentRepo as unknown as StudentRepository,
        // auditLog 不传
      );
      studentRepo.findBrief.mockResolvedValueOnce(studentS1OwnerU1);
      svc.createBinding.mockResolvedValueOnce({
        id: BINDING_ID,
        studentId: STUDENT_S1,
        teacherId: TEACHER_T1,
        status: 'active',
        boundAt: new Date(),
        boundByUserId: USER_SALES_U1,
      } as StudentTeacherBinding);
      await ctrlNoAudit.createBinding(
        {
          id: BINDING_ID,
          studentId: STUDENT_S1,
          teacherId: TEACHER_T1,
          tenantSchema: TENANT,
        },
        mkReq(),
      );
      expect(svc.createBinding).toHaveBeenCalledTimes(1);
    });
  });
});
