/**
 * ScheduleController unit tests — Sprint B.4-1 (2026-05-12)
 *
 * 重点：
 *   1. server-derive callerRole / currentUser / schedulableTeachers / studentResponsibleSalesMap
 *      from JWT，body 上的同名字段被无视（防越权）
 *   2. JWT.role ∉ {teacher, sales} → 403 ONLY_TEACHER_OR_SALES_CAN_CREATE_SCHEDULE
 *   3. sales 排自己学员 → ✅；sales 排他人学员 → 403 SALES_ONLY_OWN_STUDENTS（service 抛）
 *   4. teacher JWT.sub 未绑定 teachers 行 → 403 TEACHER_USER_NOT_BOUND
 *
 * Sprint E backlog #3 (2026-05-13) audit_log 整体补齐：
 *   - 5 写 endpoint 全部成功 + 拒绝路径写 audit_log
 *   - cancel/complete/markAttendance 原同步 → 改 async（spec rejects.toThrow）
 *   - 新加 auditLog mock 注入 + 用例断言 action / targetType / targetId
 *
 * 直接 new — 跳过 NestJS DI（其他 Sprint B controller spec 都用此模式）
 */
import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { ScheduleController } from './schedule.controller';
import {
  ScheduleService,
  Schedule,
  ScheduleStudent,
  CreateScheduleInput,
  AttendanceStatus,
} from './schedule.service';
import { TeacherRepository } from '../db/teacher.repository';
import { StudentRepository } from '../db/student.repository';
import { AuditLogRepository } from '../db/audit-log.repository';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';

describe('ScheduleController — Sprint B.4-1 server-derived RBAC', () => {
  let controller: ScheduleController;
  let svc: {
    createSchedule: jest.Mock;
    createScheduleInDb: jest.Mock;
    cancelSchedule: jest.Mock;
    completeSchedule: jest.Mock;
    listByTeacherInDb: jest.Mock;
    markAttendance: jest.Mock;
  };
  let teacherRepo: { findByUserId: jest.Mock; listActiveInTenant: jest.Mock };
  let studentRepo: { findBrief: jest.Mock };
  // Sprint E backlog #3: audit_log mock
  let auditLog: { log: jest.Mock };

  const TENANT = 'tenant_b41_test_xxxxxxxxxxxxxxxx';
  const SCHEDULE_ID = 'sch00000000000000000000000000S001';
  const TEACHER_T1 = 'tch00000000000000000000000000T001';
  const TEACHER_T2 = 'tch00000000000000000000000000T002';
  const STUDENT_S1 = 'stu00000000000000000000000000S001';
  const STUDENT_S2 = 'stu00000000000000000000000000S002';
  const USER_SALES_U1 = 'usr00000000000000000000000000U001'; // sales user
  const USER_SALES_U2 = 'usr00000000000000000000000000U002'; // 另一个 sales
  const USER_TEACHER_U3 = 'usr00000000000000000000000000U003'; // teacher (T1 bound)
  const USER_TEACHER_U4 = 'usr00000000000000000000000000U004'; // 未绑 teacher 的 user

  const teacherT1Row = {
    id: TEACHER_T1,
    campusId: 'campus_x_00000000000000000000000X1',
    name: 'T1',
    userId: USER_TEACHER_U3,
    subjects: ['数学'],
    status: '在职' as const,
  };
  const teacherT2Row = {
    id: TEACHER_T2,
    campusId: 'campus_x_00000000000000000000000X1',
    name: 'T2',
    userId: undefined,
    subjects: ['英语'],
    status: '在职' as const,
  };

  const mkInput = (
    overrides: Partial<CreateScheduleInput> = {},
  ): CreateScheduleInput => ({
    id: SCHEDULE_ID,
    teacherId: TEACHER_T1,
    studentIds: [STUDENT_S1],
    startAt: new Date('2026-05-20T10:00:00Z'),
    durationMin: 60,
    // 旧字段保留 — controller 应忽略并覆盖
    currentUser: { id: 'fake', role: 'fake', tenantId: 'fake' },
    callerRole: 'sales',
    ...overrides,
  });

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
      createSchedule: jest.fn(),
      createScheduleInDb: jest.fn(),
      cancelSchedule: jest.fn(),
      completeSchedule: jest.fn(),
      listByTeacherInDb: jest.fn(),
      markAttendance: jest.fn(),
    };
    teacherRepo = { findByUserId: jest.fn(), listActiveInTenant: jest.fn() };
    studentRepo = { findBrief: jest.fn() };
    // Sprint E backlog #3: mockResolvedValue 永不抛（兼容 fail-open）
    auditLog = { log: jest.fn().mockResolvedValue(undefined) };
    controller = new ScheduleController(
      svc as unknown as ScheduleService,
      teacherRepo as unknown as TeacherRepository,
      studentRepo as unknown as StudentRepository,
      auditLog as unknown as AuditLogRepository,
    );
  });

  // =================================================================
  // POST /api/schedules/db — server-derive 关键路径
  // =================================================================
  describe('createScheduleInDb — server 派生覆盖 body 自报', () => {
    it('JWT role=sales + body 自报 callerRole=teacher → 仍按 sales 处理（body 字段忽略）', async () => {
      // sales 自报为 teacher 想越权 — server 派生路径应忽略 body.callerRole
      teacherRepo.listActiveInTenant.mockResolvedValueOnce([teacherT1Row, teacherT2Row]);
      studentRepo.findBrief.mockResolvedValueOnce({
        id: STUDENT_S1,
        studentName: 's1',
        customerId: 'cus',
        ownerSalesId: USER_SALES_U1, // 是自己的学员
        assignedTeacherId: null,
        ownerChangedAt: null,
        ownerChangeReason: null,
        gradeOrAge: null,
        intendedSubject: null,
      });
      svc.createScheduleInDb.mockResolvedValueOnce({
        schedule: { id: SCHEDULE_ID } as Schedule,
        students: [],
      });

      await controller.createScheduleInDb(
        {
          input: mkInput({ callerRole: 'teacher' as const }), // 攻击向量
          tenantSchema: TENANT,
          studentResponsibleSalesPairs: [[STUDENT_S1, 'attacker']], // 攻击向量
          schedulableTeachers: [{ id: TEACHER_T1, userId: 'attacker' }], // 攻击向量
        },
        mkReq(),
      );

      // service 收到的 input 应是 server 派生后的（sales / sales user）
      const callArgs = svc.createScheduleInDb.mock.calls[0];
      const passedInput = callArgs[0] as CreateScheduleInput;
      expect(passedInput.callerRole).toBe('sales');
      expect(passedInput.currentUser.id).toBe(USER_SALES_U1);
      expect(passedInput.currentUser.role).toBe('sales');

      // schedulableTeachers 应是 server 查的 listActive 结果（含 T1+T2），不是 body 的
      const passedTeachers = callArgs[3] as Array<{ id: string; userId?: string }>;
      expect(passedTeachers).toHaveLength(2);
      expect(passedTeachers[0].id).toBe(TEACHER_T1);

      // studentResponsibleSalesMap 应来自 studentRepo.findBrief（不是 body 的 'attacker'）
      const passedMap = callArgs[2] as Map<string, string>;
      expect(passedMap.get(STUDENT_S1)).toBe(USER_SALES_U1);

      // teacherRepo + studentRepo 都被 server 调用
      expect(teacherRepo.listActiveInTenant).toHaveBeenCalledWith(TENANT);
      expect(studentRepo.findBrief).toHaveBeenCalledWith(TENANT, STUDENT_S1);
    });

    it('JWT role=teacher + body 自报 callerRole=sales → 仍按 teacher 处理', async () => {
      teacherRepo.findByUserId.mockResolvedValueOnce(teacherT1Row);
      svc.createScheduleInDb.mockResolvedValueOnce({
        schedule: { id: SCHEDULE_ID } as Schedule,
        students: [],
      });

      await controller.createScheduleInDb(
        {
          input: mkInput({ callerRole: 'sales' as const }),
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

      const callArgs = svc.createScheduleInDb.mock.calls[0];
      const passedInput = callArgs[0] as CreateScheduleInput;
      expect(passedInput.callerRole).toBe('teacher');
      expect(passedInput.currentUser.id).toBe(USER_TEACHER_U3);

      // teacher 路径只查 findByUserId 自己（schedulableTeachers = [own]）
      const passedTeachers = callArgs[3] as Array<{ id: string; userId?: string }>;
      expect(passedTeachers).toHaveLength(1);
      expect(passedTeachers[0].id).toBe(TEACHER_T1);
      expect(passedTeachers[0].userId).toBe(USER_TEACHER_U3);

      // teacher 不查 studentResponsibleSalesMap（空 map）
      const passedMap = callArgs[2] as Map<string, string>;
      expect(passedMap.size).toBe(0);
      expect(studentRepo.findBrief).not.toHaveBeenCalled();
    });

    it('JWT role=admin → 403 ONLY_TEACHER_OR_SALES_CAN_CREATE_SCHEDULE（早于 service）', async () => {
      await expect(
        controller.createScheduleInDb(
          { input: mkInput(), tenantSchema: TENANT },
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
      expect(svc.createScheduleInDb).not.toHaveBeenCalled();
      // 早于 service：不查 repo
      expect(teacherRepo.listActiveInTenant).not.toHaveBeenCalled();
      expect(teacherRepo.findByUserId).not.toHaveBeenCalled();
    });

    it('JWT role=boss → 403（Q1 拍板：boss 不能排课）', async () => {
      await expect(
        controller.createScheduleInDb(
          { input: mkInput(), tenantSchema: TENANT },
          mkReq({
            user: {
              sub: 'boss_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1',
              role: 'boss',
              tenantId: 'tenant-x',
              campusId: 'campus-x',
            },
          }),
        ),
      ).rejects.toThrow(/ONLY_TEACHER_OR_SALES/);
    });

    it('JWT role=academic → 403（Q1 拍板：教务排课功能进 backlog）', async () => {
      await expect(
        controller.createScheduleInDb(
          { input: mkInput(), tenantSchema: TENANT },
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

    it('JWT 缺 sub → BadRequestException', async () => {
      await expect(
        controller.createScheduleInDb(
          { input: mkInput(), tenantSchema: TENANT },
          { user: { role: 'sales' } as any } as AuthenticatedRequest,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('JWT 缺 user → BadRequestException', async () => {
      await expect(
        controller.createScheduleInDb(
          { input: mkInput(), tenantSchema: TENANT },
          {} as AuthenticatedRequest,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('teacher 反查 findByUserId 返回 null → 403 TEACHER_USER_NOT_BOUND', async () => {
      teacherRepo.findByUserId.mockResolvedValueOnce(null);
      await expect(
        controller.createScheduleInDb(
          { input: mkInput(), tenantSchema: TENANT },
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
      expect(svc.createScheduleInDb).not.toHaveBeenCalled();
    });

    it('sales 排自己学员 → 通过（map 含 owner_sales_id = JWT.sub）', async () => {
      teacherRepo.listActiveInTenant.mockResolvedValueOnce([teacherT1Row]);
      studentRepo.findBrief.mockResolvedValueOnce({
        id: STUDENT_S1,
        ownerSalesId: USER_SALES_U1,
        studentName: '',
        customerId: '',
        assignedTeacherId: null,
        ownerChangedAt: null,
        ownerChangeReason: null,
        gradeOrAge: null,
        intendedSubject: null,
      });
      svc.createScheduleInDb.mockResolvedValueOnce({
        schedule: { id: SCHEDULE_ID } as Schedule,
        students: [],
      });

      await controller.createScheduleInDb(
        { input: mkInput(), tenantSchema: TENANT },
        mkReq(),
      );
      const passedMap = svc.createScheduleInDb.mock.calls[0][2] as Map<string, string>;
      expect(passedMap.get(STUDENT_S1)).toBe(USER_SALES_U1);
      expect(svc.createScheduleInDb).toHaveBeenCalledTimes(1);
    });

    it('sales 排他人学员 → 进入 service 后 service 抛 SALES_ONLY_OWN_STUDENTS', async () => {
      teacherRepo.listActiveInTenant.mockResolvedValueOnce([teacherT1Row]);
      studentRepo.findBrief.mockResolvedValueOnce({
        id: STUDENT_S1,
        ownerSalesId: USER_SALES_U2, // 学员归 U2，不归 U1
        studentName: '',
        customerId: '',
        assignedTeacherId: null,
        ownerChangedAt: null,
        ownerChangeReason: null,
        gradeOrAge: null,
        intendedSubject: null,
      });
      svc.createScheduleInDb.mockRejectedValueOnce(
        new ForbiddenException(`SALES_ONLY_OWN_STUDENTS: ${STUDENT_S1}`),
      );

      await expect(
        controller.createScheduleInDb(
          { input: mkInput(), tenantSchema: TENANT },
          mkReq(),
        ),
      ).rejects.toThrow(/SALES_ONLY_OWN_STUDENTS/);

      // 验证 controller 派生的 map 把 U2 传给了 service（不是 attacker U1）
      const passedMap = svc.createScheduleInDb.mock.calls[0][2] as Map<string, string>;
      expect(passedMap.get(STUDENT_S1)).toBe(USER_SALES_U2);
    });

    it('sales 多学员 batch — map 含全部学员归属', async () => {
      teacherRepo.listActiveInTenant.mockResolvedValueOnce([teacherT1Row]);
      studentRepo.findBrief
        .mockResolvedValueOnce({
          id: STUDENT_S1,
          ownerSalesId: USER_SALES_U1,
          studentName: '',
          customerId: '',
          assignedTeacherId: null,
          ownerChangedAt: null,
          ownerChangeReason: null,
          gradeOrAge: null,
          intendedSubject: null,
        })
        .mockResolvedValueOnce({
          id: STUDENT_S2,
          ownerSalesId: USER_SALES_U1,
          studentName: '',
          customerId: '',
          assignedTeacherId: null,
          ownerChangedAt: null,
          ownerChangeReason: null,
          gradeOrAge: null,
          intendedSubject: null,
        });
      svc.createScheduleInDb.mockResolvedValueOnce({
        schedule: { id: SCHEDULE_ID } as Schedule,
        students: [],
      });
      await controller.createScheduleInDb(
        {
          input: mkInput({ studentIds: [STUDENT_S1, STUDENT_S2] }),
          tenantSchema: TENANT,
        },
        mkReq(),
      );
      const passedMap = svc.createScheduleInDb.mock.calls[0][2] as Map<string, string>;
      expect(passedMap.size).toBe(2);
      expect(passedMap.get(STUDENT_S1)).toBe(USER_SALES_U1);
      expect(passedMap.get(STUDENT_S2)).toBe(USER_SALES_U1);
      expect(studentRepo.findBrief).toHaveBeenCalledTimes(2);
    });

    it('缺 tenantSchema → BadRequestException', async () => {
      await expect(
        controller.createScheduleInDb(
          { input: mkInput() } as any,
          mkReq(),
        ),
      ).rejects.toThrow(/tenantSchema required/);
    });
  });

  // =================================================================
  // POST /api/schedules（内存版）— Sprint B.4-1 round 2:
  // 完全 server-derive，与 /db 路径行为对齐
  // （A04 修复：删除 fixture 模式 body 注入路径 — client 控制安全级别 = 硬违规）
  // =================================================================
  describe('createSchedule (memory) — server-derive 对齐 /db', () => {
    it('JWT role=admin → 403 早期挡（即使 body 自报 sales）', async () => {
      await expect(
        controller.createSchedule(
          {
            input: mkInput(),
            existingSchedules: [],
            existingStudentsAttachment: [],
            tenantSchema: TENANT,
            studentResponsibleSalesPairs: [],
            schedulableTeachers: [{ id: TEACHER_T1 }],
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
      expect(svc.createSchedule).not.toHaveBeenCalled();
      // 早挡保护：repo 反查不应在 RBAC 失败时发生（避免无谓 DB 压力）
      expect(teacherRepo.listActiveInTenant).not.toHaveBeenCalled();
      expect(studentRepo.findBrief).not.toHaveBeenCalled();
    });

    it('内存版缺 tenantSchema → BadRequestException（A04 skip-分支回归防御）', async () => {
      await expect(
        controller.createSchedule(
          {
            input: mkInput(),
            existingSchedules: [],
            existingStudentsAttachment: [],
          } as never,
          mkReq(),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(svc.createSchedule).not.toHaveBeenCalled();
    });

    it('JWT role=sales + body 自报 callerRole=teacher + 攻击 schedulableTeachers/SalesPairs → 全部 server 覆盖', async () => {
      // round 2: 内存版与 /db 一致，sales 路径 server-derive
      // schedulableTeachers (listActive) + salesMap (findBrief)
      teacherRepo.listActiveInTenant.mockResolvedValueOnce([teacherT1Row, teacherT2Row]);
      studentRepo.findBrief.mockResolvedValueOnce({
        id: STUDENT_S1,
        studentName: 's1',
        customerId: 'cus',
        ownerSalesId: USER_SALES_U1, // 自己学员
        assignedTeacherId: null,
        ownerChangedAt: null,
        ownerChangeReason: null,
        gradeOrAge: null,
        intendedSubject: null,
      });
      svc.createSchedule.mockReturnValueOnce({
        schedule: { id: SCHEDULE_ID } as Schedule,
        students: [],
      });

      await controller.createSchedule(
        {
          input: mkInput({ callerRole: 'teacher' as const }), // 攻击向量
          existingSchedules: [],
          existingStudentsAttachment: [],
          tenantSchema: TENANT,
          studentResponsibleSalesPairs: [[STUDENT_S1, 'attacker']], // @deprecated 攻击向量
          schedulableTeachers: [{ id: TEACHER_T1, userId: 'attacker' }], // @deprecated 攻击向量
        },
        mkReq(),
      );

      const callArgs = svc.createSchedule.mock.calls[0];
      const passedInput = callArgs[0] as CreateScheduleInput;
      expect(passedInput.callerRole).toBe('sales'); // 派生覆盖
      expect(passedInput.currentUser.id).toBe(USER_SALES_U1); // 派生覆盖

      // round 2: schedulableTeachers / salesMap 全部来自 server 反查（不是 body 的 'attacker'）
      const passedMap = callArgs[3] as Map<string, string>;
      expect(passedMap.get(STUDENT_S1)).toBe(USER_SALES_U1);

      const passedTeachers = callArgs[4] as Array<{ id: string; userId?: string }>;
      expect(passedTeachers).toHaveLength(2); // server listActive 返回的 [T1, T2]
      expect(passedTeachers[0].id).toBe(TEACHER_T1);

      // 内存版 round 2 起也调 repo（与 /db 对齐）
      expect(teacherRepo.listActiveInTenant).toHaveBeenCalledTimes(1);
      expect(studentRepo.findBrief).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================
  // Sprint B.4-1 round 2: schedule 3 个写 endpoint 早期 403 (business P1-A)
  // 对称 recurring-schedule.controller.spec.ts 的 unbind/archive describe
  // ===========================================================

  const dummySchedule: Schedule = {
    id: SCHEDULE_ID,
    teacherId: TEACHER_T1,
    studentIds: [STUDENT_S1],
    startAt: new Date('2026-05-20T10:00:00Z'),
    endAt: new Date('2026-05-20T11:00:00Z'),
    durationMin: 60,
    status: '已排课',
    source: 'one_off',
    createdByUserId: USER_SALES_U1,
    createdByRole: 'sales',
  } as Schedule;

  describe('cancelSchedule — 早期 403 角色限制 (Sprint B.4-1 round 2 P1-A)', () => {
    it('JWT role=admin → 403 ONLY_TEACHER_OR_SALES（早于 service）', async () => {
      await expect(
        controller.cancelSchedule(
          SCHEDULE_ID,
          { schedule: dummySchedule, reason: 'test', tenantSchema: TENANT },
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
      expect(svc.cancelSchedule).not.toHaveBeenCalled();
      // Sprint E backlog #3: 拒绝路径 audit_log 写入
      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({
          action: 'schedule.cancel.denied',
          targetType: 'schedule',
          targetId: SCHEDULE_ID,
        }),
      );
    });

    it('JWT role=finance → 403 ONLY_TEACHER_OR_SALES', async () => {
      await expect(
        controller.cancelSchedule(
          SCHEDULE_ID,
          { schedule: dummySchedule, tenantSchema: TENANT },
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

    it('JWT role=academic → 403 ONLY_TEACHER_OR_SALES（教务全只读老师线）', async () => {
      await expect(
        controller.cancelSchedule(
          SCHEDULE_ID,
          { schedule: dummySchedule, tenantSchema: TENANT },
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
      svc.cancelSchedule.mockReturnValueOnce({
        ...dummySchedule,
        status: '已取消',
      } as Schedule);
      await controller.cancelSchedule(
        SCHEDULE_ID,
        { schedule: dummySchedule, tenantSchema: TENANT, reason: 'parent-request' },
        mkReq(),
      );
      expect(svc.cancelSchedule).toHaveBeenCalledTimes(1);
      // Sprint E backlog #3: 成功路径 audit_log
      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({
          action: 'schedule.cancel',
          targetType: 'schedule',
          targetId: SCHEDULE_ID,
          actorUserId: USER_SALES_U1,
          actorRole: 'sales',
        }),
      );
    });

    it('JWT role=teacher → 调用 service', async () => {
      svc.cancelSchedule.mockReturnValueOnce({
        ...dummySchedule,
        status: '已取消',
      } as Schedule);
      await controller.cancelSchedule(
        SCHEDULE_ID,
        { schedule: dummySchedule, tenantSchema: TENANT },
        mkReq({
          user: {
            sub: USER_TEACHER_U3,
            role: 'teacher',
            tenantId: 'tenant-x',
            campusId: 'campus-x',
          },
        }),
      );
      expect(svc.cancelSchedule).toHaveBeenCalledTimes(1);
    });
  });

  describe('completeSchedule — 早期 403 角色限制 (Sprint B.4-1 round 2 P1-A)', () => {
    it('JWT role=admin → 403 ONLY_TEACHER_OR_SALES（早于 service）', async () => {
      await expect(
        controller.completeSchedule(
          SCHEDULE_ID,
          { schedule: dummySchedule, tenantSchema: TENANT },
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
      expect(svc.completeSchedule).not.toHaveBeenCalled();
      // Sprint E backlog #3: 拒绝路径 audit_log
      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({
          action: 'schedule.complete.denied',
          targetType: 'schedule',
          targetId: SCHEDULE_ID,
        }),
      );
    });

    it('JWT role=hr → 403 ONLY_TEACHER_OR_SALES', async () => {
      await expect(
        controller.completeSchedule(
          SCHEDULE_ID,
          { schedule: dummySchedule, tenantSchema: TENANT },
          mkReq({
            user: {
              sub: 'hr_hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh1',
              role: 'hr',
              tenantId: 'tenant-x',
              campusId: null,
            },
          }),
        ),
      ).rejects.toThrow(/ONLY_TEACHER_OR_SALES/);
    });

    it('JWT role=sales → 调用 service + 成功 audit_log', async () => {
      svc.completeSchedule.mockReturnValueOnce({
        ...dummySchedule,
        status: '已完成',
      } as Schedule);
      await controller.completeSchedule(
        SCHEDULE_ID,
        { schedule: dummySchedule, tenantSchema: TENANT },
        mkReq(),
      );
      expect(svc.completeSchedule).toHaveBeenCalledTimes(1);
      // Sprint E backlog #3: 成功路径 audit_log
      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({
          action: 'schedule.complete',
          targetType: 'schedule',
          targetId: SCHEDULE_ID,
        }),
      );
    });

    it('JWT role=teacher → 调用 service', async () => {
      svc.completeSchedule.mockReturnValueOnce({
        ...dummySchedule,
        status: '已完成',
      } as Schedule);
      await controller.completeSchedule(
        SCHEDULE_ID,
        { schedule: dummySchedule, tenantSchema: TENANT },
        mkReq({
          user: {
            sub: USER_TEACHER_U3,
            role: 'teacher',
            tenantId: 'tenant-x',
            campusId: 'campus-x',
          },
        }),
      );
      expect(svc.completeSchedule).toHaveBeenCalledTimes(1);
    });
  });

  describe('listByTeacherInDb — 早期 403 角色限制 (Sprint B.4-1 round 3 / Sprint E backlog #7 A01)', () => {
    const listBody = {
      tenantSchema: TENANT,
      teacherId: TEACHER_T1,
      fromIso: '2026-05-13T00:00:00Z',
      toIso: '2026-05-20T00:00:00Z',
    };

    it('JWT role=admin → 403 ONLY_TEACHER_OR_SALES（早于 service）', async () => {
      await expect(
        controller.listByTeacherInDb(
          listBody,
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
      expect(svc.listByTeacherInDb).not.toHaveBeenCalled();
    });

    it('JWT role=academic → 403 ONLY_TEACHER_OR_SALES（教务全只读老师线，pre-existing 漏洞收紧）', async () => {
      await expect(
        controller.listByTeacherInDb(
          listBody,
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

    it('JWT role=finance → 403 ONLY_TEACHER_OR_SALES', async () => {
      await expect(
        controller.listByTeacherInDb(
          listBody,
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

    it('JWT role=sales → 调用 service', async () => {
      svc.listByTeacherInDb.mockResolvedValueOnce([]);
      await controller.listByTeacherInDb(listBody, mkReq());
      expect(svc.listByTeacherInDb).toHaveBeenCalledTimes(1);
    });

    it('JWT role=teacher → 调用 service', async () => {
      svc.listByTeacherInDb.mockResolvedValueOnce([]);
      await controller.listByTeacherInDb(
        listBody,
        mkReq({
          user: {
            sub: USER_TEACHER_U3,
            role: 'teacher',
            tenantId: 'tenant-x',
            campusId: 'campus-x',
          },
        }),
      );
      expect(svc.listByTeacherInDb).toHaveBeenCalledTimes(1);
    });
  });

  describe('markAttendance — 早期 403 角色限制 (Sprint B.4-1 round 2 P1-A)', () => {
    const dummyStudent: ScheduleStudent = {
      scheduleId: SCHEDULE_ID,
      studentId: STUDENT_S1,
      attendanceStatus: '待出勤',
    } as ScheduleStudent;
    const newStatus: AttendanceStatus = '出勤';

    it('JWT role=admin → 403 ONLY_TEACHER_OR_SALES（早于 service）', async () => {
      await expect(
        controller.markAttendance(
          SCHEDULE_ID,
          STUDENT_S1,
          { scheduleStudent: dummyStudent, newStatus, tenantSchema: TENANT },
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
      expect(svc.markAttendance).not.toHaveBeenCalled();
      // Sprint E backlog #3: 拒绝路径 audit_log
      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({
          action: 'schedule.mark-attendance.denied',
          targetType: 'schedule',
          targetId: SCHEDULE_ID,
        }),
      );
    });

    it('JWT role=finance → 403 ONLY_TEACHER_OR_SALES', async () => {
      await expect(
        controller.markAttendance(
          SCHEDULE_ID,
          STUDENT_S1,
          { scheduleStudent: dummyStudent, newStatus, tenantSchema: TENANT },
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

    it('JWT role=academic → 403 ONLY_TEACHER_OR_SALES（教务全只读老师线）', async () => {
      await expect(
        controller.markAttendance(
          SCHEDULE_ID,
          STUDENT_S1,
          { scheduleStudent: dummyStudent, newStatus, tenantSchema: TENANT },
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
      svc.markAttendance.mockReturnValueOnce({
        ...dummyStudent,
        attendanceStatus: newStatus,
      } as ScheduleStudent);
      await controller.markAttendance(
        SCHEDULE_ID,
        STUDENT_S1,
        { scheduleStudent: dummyStudent, newStatus, tenantSchema: TENANT },
        mkReq(),
      );
      expect(svc.markAttendance).toHaveBeenCalledTimes(1);
      // Sprint E backlog #3: 成功路径 audit_log，after 含 studentId / attendanceStatus 变更
      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({
          action: 'schedule.mark-attendance',
          targetType: 'schedule',
          targetId: SCHEDULE_ID,
          after: expect.objectContaining({
            studentId: STUDENT_S1,
            attendanceStatus: newStatus,
          }),
        }),
      );
    });

    it('JWT role=teacher → 调用 service', async () => {
      svc.markAttendance.mockReturnValueOnce({
        ...dummyStudent,
        attendanceStatus: newStatus,
      } as ScheduleStudent);
      await controller.markAttendance(
        SCHEDULE_ID,
        STUDENT_S1,
        { scheduleStudent: dummyStudent, newStatus, tenantSchema: TENANT },
        mkReq({
          user: {
            sub: USER_TEACHER_U3,
            role: 'teacher',
            tenantId: 'tenant-x',
            campusId: 'campus-x',
          },
        }),
      );
      expect(svc.markAttendance).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================
  // Sprint E backlog #3: createSchedule / createScheduleInDb 成功路径 audit_log
  // ===========================================================
  describe('createSchedule / createScheduleInDb — 成功路径 audit_log (Sprint E #3)', () => {
    it('createScheduleInDb 成功 → audit_log action=schedule.create + 含 teacherId/studentIds', async () => {
      teacherRepo.listActiveInTenant.mockResolvedValueOnce([teacherT1Row]);
      studentRepo.findBrief.mockResolvedValueOnce({
        id: STUDENT_S1,
        ownerSalesId: USER_SALES_U1,
        studentName: '',
        customerId: '',
        assignedTeacherId: null,
        ownerChangedAt: null,
        ownerChangeReason: null,
        gradeOrAge: null,
        intendedSubject: null,
      });
      svc.createScheduleInDb.mockResolvedValueOnce({
        schedule: {
          id: SCHEDULE_ID,
          teacherId: TEACHER_T1,
          studentIds: [STUDENT_S1],
          startAt: new Date('2026-05-20T10:00:00Z'),
          endAt: new Date('2026-05-20T11:00:00Z'),
          durationMin: 60,
          status: '已排课',
          source: 'one_off',
          createdByUserId: USER_SALES_U1,
          createdByRole: 'sales',
        } as Schedule,
        students: [],
      });

      await controller.createScheduleInDb(
        { input: mkInput(), tenantSchema: TENANT },
        mkReq(),
      );

      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({
          action: 'schedule.create',
          targetType: 'schedule',
          targetId: SCHEDULE_ID,
          actorUserId: USER_SALES_U1,
          actorRole: 'sales',
          before: null,
          after: expect.objectContaining({
            id: SCHEDULE_ID,
            teacherId: TEACHER_T1,
            studentIds: [STUDENT_S1],
            durationMin: 60,
          }),
        }),
      );
    });

    it('createScheduleInDb 403 (admin) → audit_log action=schedule.create.denied + reason 含 ONLY_TEACHER_OR_SALES', async () => {
      await expect(
        controller.createScheduleInDb(
          { input: mkInput(), tenantSchema: TENANT },
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
          action: 'schedule.create.denied',
          targetType: 'schedule',
          targetId: SCHEDULE_ID,
          after: expect.objectContaining({
            reason: expect.stringMatching(/ONLY_TEACHER_OR_SALES/),
            endpoint: 'createScheduleInDb',
          }),
        }),
      );
    });

    it('createScheduleInDb 缺 tenantSchema → audit_log denied + tenantSchema 占位 unknown', async () => {
      await expect(
        controller.createScheduleInDb(
          { input: mkInput() } as any,
          mkReq(),
        ),
      ).rejects.toThrow(/tenantSchema required/);

      expect(auditLog.log).toHaveBeenCalledWith(
        'unknown',
        expect.objectContaining({
          action: 'schedule.create.denied',
          targetType: 'schedule',
          after: expect.objectContaining({
            reason: 'TENANT_SCHEMA_REQUIRED',
          }),
        }),
      );
    });

    it('createSchedule 内存版成功 → audit_log action=schedule.create', async () => {
      teacherRepo.listActiveInTenant.mockResolvedValueOnce([teacherT1Row]);
      studentRepo.findBrief.mockResolvedValueOnce({
        id: STUDENT_S1,
        ownerSalesId: USER_SALES_U1,
        studentName: '',
        customerId: '',
        assignedTeacherId: null,
        ownerChangedAt: null,
        ownerChangeReason: null,
        gradeOrAge: null,
        intendedSubject: null,
      });
      svc.createSchedule.mockReturnValueOnce({
        schedule: {
          id: SCHEDULE_ID,
          teacherId: TEACHER_T1,
          studentIds: [STUDENT_S1],
          startAt: new Date('2026-05-20T10:00:00Z'),
          endAt: new Date('2026-05-20T11:00:00Z'),
          durationMin: 60,
          status: '已排课',
          source: 'one_off',
          createdByUserId: USER_SALES_U1,
          createdByRole: 'sales',
        } as Schedule,
        students: [],
      });

      await controller.createSchedule(
        {
          input: mkInput(),
          existingSchedules: [],
          existingStudentsAttachment: [],
          tenantSchema: TENANT,
        },
        mkReq(),
      );

      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({
          action: 'schedule.create',
          targetType: 'schedule',
          targetId: SCHEDULE_ID,
        }),
      );
    });

    it('auditLog 不存在（@Optional 未注入）→ 主业务流不阻塞', async () => {
      // 重新 new controller 不传 auditLog
      const ctrlNoAudit = new ScheduleController(
        svc as unknown as ScheduleService,
        teacherRepo as unknown as TeacherRepository,
        studentRepo as unknown as StudentRepository,
        // auditLog 不传
      );
      teacherRepo.listActiveInTenant.mockResolvedValueOnce([teacherT1Row]);
      studentRepo.findBrief.mockResolvedValueOnce({
        id: STUDENT_S1,
        ownerSalesId: USER_SALES_U1,
        studentName: '',
        customerId: '',
        assignedTeacherId: null,
        ownerChangedAt: null,
        ownerChangeReason: null,
        gradeOrAge: null,
        intendedSubject: null,
      });
      svc.createScheduleInDb.mockResolvedValueOnce({
        schedule: { id: SCHEDULE_ID } as Schedule,
        students: [],
      });
      await ctrlNoAudit.createScheduleInDb(
        { input: mkInput(), tenantSchema: TENANT },
        mkReq(),
      );
      expect(svc.createScheduleInDb).toHaveBeenCalledTimes(1);
    });
  });
});
