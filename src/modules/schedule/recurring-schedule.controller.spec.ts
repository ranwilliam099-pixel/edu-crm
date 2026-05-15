/**
 * RecurringScheduleController unit tests
 *
 * Wave 11（2026-05-15）拍板反向修复 — 教务唯一创建：
 *   - 5/9 拍板 fields-by-role.md L82/L102/L133/L201：教务是 ✅ 创建主责
 *   - 5/12 Sprint B.4-1 round 2 误读拍板写成 {teacher, sales} 创建
 *   - Wave 11 修正：所有写 endpoint 限 academic
 *
 * 重点：
 *   1. createBinding / createRecurring server 派生 callerRole + boundByUserId/createdByUserId
 *      （body 自报字段被覆盖）
 *   2. JWT.role !== 'academic' → 403 ONLY_ACADEMIC_CAN_CREATE_SCHEDULE
 *   3. academic 路径：teacherRepo.findById 反查 teacher.campus_id
 *      - teacher 同校（campus_id === JWT.campusId）→ ✅
 *      - teacher 跨校 → 403 TEACHER_NOT_IN_ACADEMIC_CAMPUS
 *      - teacher 不存在 → 403 TEACHER_NOT_FOUND
 *   4. 学生 ownership 不校验（教务 ✅ 创建拍板矩阵 L201 无限定）
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

describe('RecurringScheduleController — Wave 11 academic 唯一', () => {
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
  let auditLog: { log: jest.Mock };

  const TENANT = 'tenant_w11_recur_xxxxxxxxxxxxxxxx';
  const BINDING_ID = 'bnd00000000000000000000000000B001';
  const REC_ID = 'rec00000000000000000000000000R001';
  const STUDENT_S1 = 'stu00000000000000000000000000S001';
  const TEACHER_T1 = 'tch00000000000000000000000000T001';
  const TEACHER_T2_OTHER_CAMPUS = 'tch00000000000000000000000000T002';
  const USER_ACADEMIC = 'usr_academic_00000000000000000U01';
  const USER_TEACHER = 'usr_teacher_000000000000000000U02';
  const USER_SALES = 'usr_sales_00000000000000000000U03';
  const CAMPUS_X = 'cmp_x00000000000000000000000000X1';
  const CAMPUS_Y = 'cmp_y00000000000000000000000000Y1';

  const teacherT1SameCampus = {
    id: TEACHER_T1,
    campusId: CAMPUS_X,
    name: 'T1',
    userId: USER_TEACHER,
    subjects: ['数学'],
    status: '在职' as const,
  };
  const teacherT2OtherCampus = {
    id: TEACHER_T2_OTHER_CAMPUS,
    campusId: CAMPUS_Y, // 跨校
    name: 'T2',
    userId: undefined,
    subjects: ['英语'],
    status: '在职' as const,
  };

  const mkReq = (overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest =>
    ({
      user: {
        sub: USER_ACADEMIC,
        role: 'academic',
        tenantId: 'tenant-x',
        campusId: CAMPUS_X,
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
  // createBinding — Wave 11 academic 唯一
  // ===========================================================
  describe('createBinding — Wave 11 RBAC server 派生', () => {
    it('academic 给同校老师创建绑定 → ✅，boundByUserId 派生为 JWT.sub', async () => {
      teacherRepo.findById.mockResolvedValueOnce(teacherT1SameCampus);
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
      expect(passed.boundByUserId).toBe(USER_ACADEMIC); // 派生覆盖
      const rbac = svc.createBinding.mock.calls[0][1];
      expect(rbac.callerRole).toBe('academic');
      expect(rbac.currentUserId).toBe(USER_ACADEMIC);
      expect(rbac.academicCampusId).toBe(CAMPUS_X);
      expect(rbac.teacherCampusId).toBe(CAMPUS_X);
    });

    it('academic 给跨校老师创建绑定 → rbac.teacherCampusId !== academicCampusId, service 抛 TEACHER_NOT_IN_ACADEMIC_CAMPUS', async () => {
      teacherRepo.findById.mockResolvedValueOnce(teacherT2OtherCampus);
      svc.createBinding.mockImplementationOnce(() => {
        throw new ForbiddenException('TEACHER_NOT_IN_ACADEMIC_CAMPUS');
      });

      await expect(
        controller.createBinding(
          {
            id: BINDING_ID,
            studentId: STUDENT_S1,
            teacherId: TEACHER_T2_OTHER_CAMPUS,
            tenantSchema: TENANT,
          },
          mkReq(),
        ),
      ).rejects.toThrow(/TEACHER_NOT_IN_ACADEMIC_CAMPUS/);
      const rbac = svc.createBinding.mock.calls[0][1];
      expect(rbac.academicCampusId).toBe(CAMPUS_X);
      expect(rbac.teacherCampusId).toBe(CAMPUS_Y);
    });

    it('academic 反查 teacher 不存在 → 403 TEACHER_NOT_FOUND', async () => {
      teacherRepo.findById.mockResolvedValueOnce(null);
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
      ).rejects.toThrow(/TEACHER_NOT_FOUND/);
      expect(svc.createBinding).not.toHaveBeenCalled();
    });

    it('JWT role=admin → 403 ONLY_ACADEMIC（早于 repo 查询）', async () => {
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
      ).rejects.toThrow(/ONLY_ACADEMIC/);
      expect(studentRepo.findBrief).not.toHaveBeenCalled();
      expect(teacherRepo.findById).not.toHaveBeenCalled();
    });

    it('JWT role=sales → 403 ONLY_ACADEMIC（5/12 反向修复）', async () => {
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
              sub: USER_SALES,
              role: 'sales',
              tenantId: 'tenant-x',
              campusId: CAMPUS_X,
            },
          }),
        ),
      ).rejects.toThrow(/ONLY_ACADEMIC/);
    });

    it('JWT role=teacher → 403 ONLY_ACADEMIC（拍板 L133 老师 home「不该有 + 排课」）', async () => {
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
              sub: USER_TEACHER,
              role: 'teacher',
              tenantId: 'tenant-x',
              campusId: CAMPUS_X,
            },
          }),
        ),
      ).rejects.toThrow(/ONLY_ACADEMIC/);
    });

    it('缺 tenantSchema → 400 TENANT_SCHEMA_REQUIRED', async () => {
      await expect(
        controller.createBinding(
          {
            id: BINDING_ID,
            studentId: STUDENT_S1,
            teacherId: TEACHER_T1,
          } as never,
          mkReq(),
        ),
      ).rejects.toThrow(/TENANT_SCHEMA_REQUIRED/);

      expect(svc.createBinding).not.toHaveBeenCalled();
      expect(studentRepo.findBrief).not.toHaveBeenCalled();
      expect(teacherRepo.findById).not.toHaveBeenCalled();
    });
  });

  // ===========================================================
  // createRecurring — Wave 11 academic 唯一
  // ===========================================================
  describe('createRecurring — Wave 11 RBAC server 派生', () => {
    const baseInputDto = {
      id: REC_ID,
      bindingId: BINDING_ID,
      studentId: STUDENT_S1,
      teacherId: TEACHER_T1,
      byDay: ['MO' as const],
      startMinutes: 18 * 60,
      durationMin: 60,
      startDate: '2026-05-04T00:00:00Z',
      createdByUserId: 'attacker',
      createdByRole: 'sales', // 攻击向量
    };

    it('academic 创建周期模板（同校老师）→ ✅，service 收到 server-derive 后的 input', async () => {
      teacherRepo.findById.mockResolvedValueOnce(teacherT1SameCampus);
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
      expect(passedInput.createdByUserId).toBe(USER_ACADEMIC); // server 派生
      expect(passedInput.createdByRole).toBe('academic'); // server 派生

      const rbac = svc.createRecurring.mock.calls[0][4]; // 第 5 参数
      expect(rbac.callerRole).toBe('academic');
      expect(rbac.academicCampusId).toBe(CAMPUS_X);
      expect(rbac.teacherCampusId).toBe(CAMPUS_X);
    });

    it('academic 跨校排课 → rbac.teacherCampusId=CAMPUS_Y，service 抛', async () => {
      teacherRepo.findById.mockResolvedValueOnce(teacherT2OtherCampus);
      svc.createRecurring.mockImplementationOnce(() => {
        throw new ForbiddenException('TEACHER_NOT_IN_ACADEMIC_CAMPUS');
      });

      await expect(
        controller.createRecurring(
          {
            input: { ...baseInputDto, teacherId: TEACHER_T2_OTHER_CAMPUS },
            expandRangeDays: 30,
            existingSchedules: [],
            tenantSchema: TENANT,
          },
          mkReq(),
        ),
      ).rejects.toThrow(/TEACHER_NOT_IN_ACADEMIC_CAMPUS/);
      const rbac = svc.createRecurring.mock.calls[0][4];
      expect(rbac.teacherCampusId).toBe(CAMPUS_Y);
    });

    it('JWT role=sales → 403 ONLY_ACADEMIC（早期挡）', async () => {
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
              sub: USER_SALES,
              role: 'sales',
              tenantId: 'tenant-x',
              campusId: CAMPUS_X,
            },
          }),
        ),
      ).rejects.toThrow(/ONLY_ACADEMIC/);
      expect(studentRepo.findBrief).not.toHaveBeenCalled();
      expect(teacherRepo.findById).not.toHaveBeenCalled();
    });

    it('JWT role=teacher → 403 ONLY_ACADEMIC（早期挡）', async () => {
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
              sub: USER_TEACHER,
              role: 'teacher',
              tenantId: 'tenant-x',
              campusId: CAMPUS_X,
            },
          }),
        ),
      ).rejects.toThrow(/ONLY_ACADEMIC/);
    });

    it('JWT role=admin → 403 ONLY_ACADEMIC', async () => {
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
              sub: 'admin_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
              role: 'admin',
              tenantId: null,
              campusId: null,
            },
          }),
        ),
      ).rejects.toThrow(/ONLY_ACADEMIC/);
    });

    it('缺 tenantSchema → 400 TENANT_SCHEMA_REQUIRED', async () => {
      await expect(
        controller.createRecurring(
          {
            input: baseInputDto,
            expandRangeDays: 30,
            existingSchedules: [],
          } as never,
          mkReq(),
        ),
      ).rejects.toThrow(/TENANT_SCHEMA_REQUIRED/);

      expect(svc.createRecurring).not.toHaveBeenCalled();
      expect(studentRepo.findBrief).not.toHaveBeenCalled();
      expect(teacherRepo.findById).not.toHaveBeenCalled();
    });
  });

  // ===========================================================
  // unbindBinding / archiveRecurring — Wave 11 早期 403 仅 academic
  // ===========================================================
  describe('unbindBinding — Wave 11 早期 403 仅 academic', () => {
    const dummyBinding: StudentTeacherBinding = {
      id: BINDING_ID,
      studentId: STUDENT_S1,
      teacherId: TEACHER_T1,
      status: 'active',
      boundAt: new Date('2026-05-01T00:00:00Z'),
      boundByUserId: USER_ACADEMIC,
    };

    it('JWT role=admin → 403 ONLY_ACADEMIC（早于 service）', async () => {
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
      ).rejects.toThrow(/ONLY_ACADEMIC/);
      expect(svc.unbindBinding).not.toHaveBeenCalled();
      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({
          action: 'recurring-binding.unbind.denied',
          targetType: 'student_teacher_binding',
          targetId: BINDING_ID,
        }),
      );
    });

    it('JWT role=sales → 403 ONLY_ACADEMIC（5/12 反向修复）', async () => {
      await expect(
        controller.unbindBinding(
          BINDING_ID,
          { binding: dummyBinding, tenantSchema: TENANT },
          mkReq({
            user: {
              sub: USER_SALES,
              role: 'sales',
              tenantId: 'tenant-x',
              campusId: CAMPUS_X,
            },
          }),
        ),
      ).rejects.toThrow(/ONLY_ACADEMIC/);
    });

    it('JWT role=teacher → 403 ONLY_ACADEMIC', async () => {
      await expect(
        controller.unbindBinding(
          BINDING_ID,
          { binding: dummyBinding, tenantSchema: TENANT },
          mkReq({
            user: {
              sub: USER_TEACHER,
              role: 'teacher',
              tenantId: 'tenant-x',
              campusId: CAMPUS_X,
            },
          }),
        ),
      ).rejects.toThrow(/ONLY_ACADEMIC/);
    });

    it('JWT role=finance → 403 ONLY_ACADEMIC', async () => {
      await expect(
        controller.unbindBinding(
          BINDING_ID,
          { binding: dummyBinding, tenantSchema: TENANT },
          mkReq({
            user: {
              sub: 'finance_ffffffffffffffffffffffffffffff1',
              role: 'finance',
              tenantId: 'tenant-x',
              campusId: CAMPUS_X,
            },
          }),
        ),
      ).rejects.toThrow(/ONLY_ACADEMIC/);
    });

    it('JWT role=academic → 调用 service + 成功 audit_log', async () => {
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
      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({
          action: 'recurring-binding.unbind',
          targetType: 'student_teacher_binding',
          targetId: BINDING_ID,
          actorRole: 'academic',
        }),
      );
    });
  });

  describe('archiveRecurring — Wave 11 早期 403 仅 academic', () => {
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
      createdByUserId: USER_ACADEMIC,
      createdByRole: 'academic',
      createdAt: new Date('2026-05-01T00:00:00Z'),
    };

    it('JWT role=admin → 403 ONLY_ACADEMIC（早于 service）', async () => {
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
      ).rejects.toThrow(/ONLY_ACADEMIC/);
      expect(svc.archiveRecurring).not.toHaveBeenCalled();
      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({
          action: 'recurring-schedule.archive.denied',
          targetType: 'recurring_schedule',
          targetId: REC_ID,
        }),
      );
    });

    it('JWT role=sales → 403 ONLY_ACADEMIC（5/12 反向修复）', async () => {
      await expect(
        controller.archiveRecurring(
          REC_ID,
          { recurring: dummyRecurring, tenantSchema: TENANT },
          mkReq({
            user: {
              sub: USER_SALES,
              role: 'sales',
              tenantId: 'tenant-x',
              campusId: CAMPUS_X,
            },
          }),
        ),
      ).rejects.toThrow(/ONLY_ACADEMIC/);
    });

    it('JWT role=sales_director → 403 ONLY_ACADEMIC', async () => {
      await expect(
        controller.archiveRecurring(
          REC_ID,
          { recurring: dummyRecurring, tenantSchema: TENANT },
          mkReq({
            user: {
              sub: 'sd_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1',
              role: 'sales_director',
              tenantId: 'tenant-x',
              campusId: null,
            },
          }),
        ),
      ).rejects.toThrow(/ONLY_ACADEMIC/);
    });

    it('JWT role=teacher → 403 ONLY_ACADEMIC', async () => {
      await expect(
        controller.archiveRecurring(
          REC_ID,
          { recurring: dummyRecurring, tenantSchema: TENANT },
          mkReq({
            user: {
              sub: USER_TEACHER,
              role: 'teacher',
              tenantId: 'tenant-x',
              campusId: CAMPUS_X,
            },
          }),
        ),
      ).rejects.toThrow(/ONLY_ACADEMIC/);
    });

    it('JWT role=academic → 调用 service + 成功 audit_log', async () => {
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
          actorRole: 'academic',
        }),
      );
    });
  });

  // ===========================================================
  // Sprint E backlog #3: createBinding / createRecurring 成功 audit_log
  // Wave 11 actorRole = 'academic'
  // ===========================================================
  describe('createBinding / createRecurring — 成功路径 audit_log', () => {
    it('createBinding 成功 → audit_log action=recurring-binding.create + actorRole=academic', async () => {
      teacherRepo.findById.mockResolvedValueOnce(teacherT1SameCampus);
      svc.createBinding.mockResolvedValueOnce({
        id: BINDING_ID,
        studentId: STUDENT_S1,
        teacherId: TEACHER_T1,
        status: 'active',
        boundAt: new Date('2026-05-13T00:00:00Z'),
        boundByUserId: USER_ACADEMIC,
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
          actorUserId: USER_ACADEMIC,
          actorRole: 'academic',
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
      ).rejects.toThrow(/ONLY_ACADEMIC/);
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
          } as never,
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
      teacherRepo.findById.mockResolvedValueOnce(teacherT1SameCampus);
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
        createdByUserId: USER_ACADEMIC,
        createdByRole: 'academic',
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
              sub: USER_SALES,
              role: 'sales',
              tenantId: 'tenant-x',
              campusId: CAMPUS_X,
            },
          }),
        ),
      ).rejects.toThrow(/ONLY_ACADEMIC/);
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
      teacherRepo.findById.mockResolvedValueOnce(teacherT1SameCampus);
      svc.createBinding.mockResolvedValueOnce({
        id: BINDING_ID,
        studentId: STUDENT_S1,
        teacherId: TEACHER_T1,
        status: 'active',
        boundAt: new Date(),
        boundByUserId: USER_ACADEMIC,
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
