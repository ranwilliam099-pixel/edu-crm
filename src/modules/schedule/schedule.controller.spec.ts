/**
 * ScheduleController unit tests
 *
 * Wave 11（2026-05-15）拍板反向修复 — 教务唯一创建：
 *   - 5/9 拍板 fields-by-role.md L82/L102/L133/L201：教务是 ✅ 创建主责
 *   - 5/12 Sprint B.4-1 round 2 误读拍板写成 {teacher, sales} 创建 + academic 403
 *   - Wave 11 修正：仅 academic 可走写路径，其他全 403
 *
 * 重点：
 *   1. server-derive callerRole / currentUser / schedulableTeachers
 *      from JWT，body 上的同名字段被无视（防越权）
 *   2. JWT.role !== 'academic' → 403 ONLY_ACADEMIC_CAN_CREATE_SCHEDULE
 *   3. schedulableTeachers 按 academic.campus_id 过滤（防跨校排课）
 *   4. studentResponsibleSalesMap deprecated（教务无 ownership 校验，传空 Map）
 *   5. list-by-teacher (read 路径) 单独 helper，scope 含 {teacher, sales, academic, boss, admin}
 *
 * Sprint E backlog #3 (2026-05-13) audit_log 整体补齐保留：
 *   - 5 写 endpoint 全部成功 + 拒绝路径写 audit_log
 *   - cancel/complete/markAttendance 改 async（spec rejects.toThrow）
 *   - auditLog mock 注入 + 用例断言 action / targetType / targetId
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

describe('ScheduleController — Wave 11 academic 唯一创建', () => {
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
  let auditLog: { log: jest.Mock };

  const TENANT = 'tenant_w11_test_xxxxxxxxxxxxxxxx';
  const SCHEDULE_ID = 'sch00000000000000000000000000S001';
  const TEACHER_T1 = 'tch00000000000000000000000000T001';
  const TEACHER_T2 = 'tch00000000000000000000000000T002';
  const TEACHER_T3_OTHER_CAMPUS = 'tch00000000000000000000000000T003';
  const STUDENT_S1 = 'stu00000000000000000000000000S001';
  const STUDENT_S2 = 'stu00000000000000000000000000S002';
  const USER_ACADEMIC = 'usr_academic_00000000000000000U01'; // academic JWT.sub
  const USER_TEACHER = 'usr_teacher_000000000000000000U02';
  const USER_SALES = 'usr_sales_00000000000000000000U03';
  const CAMPUS_X = 'campus_x_00000000000000000000000X1';
  const CAMPUS_Y = 'campus_y_00000000000000000000000Y1';

  const teacherT1Row = {
    id: TEACHER_T1,
    campusId: CAMPUS_X, // 同 academic 校区
    name: 'T1',
    userId: USER_TEACHER,
    subjects: ['数学'],
    status: '在职' as const,
  };
  const teacherT2Row = {
    id: TEACHER_T2,
    campusId: CAMPUS_X, // 同 academic 校区
    name: 'T2',
    userId: undefined,
    subjects: ['英语'],
    status: '在职' as const,
  };
  const teacherT3OtherCampus = {
    id: TEACHER_T3_OTHER_CAMPUS,
    campusId: CAMPUS_Y, // 不同校区，应被过滤
    name: 'T3',
    userId: undefined,
    subjects: ['语文'],
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
    callerRole: 'academic',
    ...overrides,
  });

  /**
   * 构造 academic JWT 请求（Wave 11 默认）
   * 其他角色测试覆盖通过 overrides 传入
   */
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
      createSchedule: jest.fn(),
      createScheduleInDb: jest.fn(),
      cancelSchedule: jest.fn(),
      completeSchedule: jest.fn(),
      listByTeacherInDb: jest.fn(),
      markAttendance: jest.fn(),
    };
    teacherRepo = { findByUserId: jest.fn(), listActiveInTenant: jest.fn() };
    studentRepo = { findBrief: jest.fn() };
    auditLog = { log: jest.fn().mockResolvedValue(undefined) };
    controller = new ScheduleController(
      svc as unknown as ScheduleService,
      teacherRepo as unknown as TeacherRepository,
      studentRepo as unknown as StudentRepository,
      auditLog as unknown as AuditLogRepository,
    );
  });

  // =================================================================
  // POST /api/schedules/db — Wave 11 academic 唯一路径
  // =================================================================
  describe('createScheduleInDb — Wave 11 academic 唯一', () => {
    it('academic 调用 → server-derive callerRole/currentUser/schedulableTeachers + 调 service', async () => {
      teacherRepo.listActiveInTenant.mockResolvedValueOnce([teacherT1Row, teacherT2Row]);
      svc.createScheduleInDb.mockResolvedValueOnce({
        schedule: { id: SCHEDULE_ID } as Schedule,
        students: [],
      });

      await controller.createScheduleInDb(
        {
          // 攻击向量：body 自报 sales / 攻击 teachers/SalesPairs
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          input: mkInput({ callerRole: 'sales' as any }),
          tenantSchema: TENANT,
          studentResponsibleSalesPairs: [[STUDENT_S1, 'attacker']],
          schedulableTeachers: [{ id: TEACHER_T1, userId: 'attacker' }],
        },
        mkReq(),
      );

      const callArgs = svc.createScheduleInDb.mock.calls[0];
      const passedInput = callArgs[0] as CreateScheduleInput;
      // body 自报字段全被 server-derive 覆盖
      expect(passedInput.callerRole).toBe('academic');
      expect(passedInput.currentUser.id).toBe(USER_ACADEMIC);
      expect(passedInput.currentUser.role).toBe('academic');

      // schedulableTeachers 来自 server listActive + campus filter
      const passedTeachers = callArgs[3] as Array<{ id: string; userId?: string }>;
      expect(passedTeachers).toHaveLength(2);
      expect(passedTeachers.map((t) => t.id).sort()).toEqual([TEACHER_T1, TEACHER_T2].sort());

      // studentResponsibleSalesMap 已 deprecated → 空 Map
      const passedMap = callArgs[2] as Map<string, string>;
      expect(passedMap.size).toBe(0);

      // teacherRepo listActive 被调；studentRepo.findBrief 不再调（教务无 ownership 校验）
      expect(teacherRepo.listActiveInTenant).toHaveBeenCalledWith(TENANT);
      expect(studentRepo.findBrief).not.toHaveBeenCalled();
    });

    it('academic 跨校排课（teacher 在别的 campus_id）→ schedulableTeachers 过滤掉，service 抛 TEACHER_NOT_IN_ACADEMIC_CAMPUS', async () => {
      // listActive 返回 3 个老师，但 T3 在 CAMPUS_Y 应被过滤
      teacherRepo.listActiveInTenant.mockResolvedValueOnce([
        teacherT1Row,
        teacherT2Row,
        teacherT3OtherCampus,
      ]);
      svc.createScheduleInDb.mockImplementationOnce(() => {
        throw new ForbiddenException(
          `TEACHER_NOT_IN_ACADEMIC_CAMPUS: teacher ${TEACHER_T3_OTHER_CAMPUS} not in academic's campus or not active`,
        );
      });

      await expect(
        controller.createScheduleInDb(
          {
            input: mkInput({ teacherId: TEACHER_T3_OTHER_CAMPUS }),
            tenantSchema: TENANT,
          },
          mkReq(),
        ),
      ).rejects.toThrow(/TEACHER_NOT_IN_ACADEMIC_CAMPUS/);

      // controller 已过滤 schedulableTeachers，T3 不在传入列表
      const passedTeachers = svc.createScheduleInDb.mock.calls[0][3] as Array<{
        id: string;
        userId?: string;
      }>;
      expect(passedTeachers.map((t) => t.id)).not.toContain(TEACHER_T3_OTHER_CAMPUS);
      expect(passedTeachers).toHaveLength(2);
    });

    it('JWT role=sales → 403 ONLY_ACADEMIC_CAN_CREATE_SCHEDULE（早于 service）', async () => {
      await expect(
        controller.createScheduleInDb(
          { input: mkInput(), tenantSchema: TENANT },
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
      expect(svc.createScheduleInDb).not.toHaveBeenCalled();
      expect(teacherRepo.listActiveInTenant).not.toHaveBeenCalled();
    });

    it('JWT role=teacher → 403 ONLY_ACADEMIC（拍板 L133 老师 home「不该有 + 新建排课」）', async () => {
      await expect(
        controller.createScheduleInDb(
          { input: mkInput(), tenantSchema: TENANT },
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

    it('JWT role=admin → 403 ONLY_ACADEMIC（拍板 feedback L56 老板 home「不该有 + 排课」）', async () => {
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
      ).rejects.toThrow(/ONLY_ACADEMIC/);
    });

    it('JWT role=boss → 403 ONLY_ACADEMIC', async () => {
      await expect(
        controller.createScheduleInDb(
          { input: mkInput(), tenantSchema: TENANT },
          mkReq({
            user: {
              sub: 'boss_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1',
              role: 'boss',
              tenantId: 'tenant-x',
              campusId: CAMPUS_X,
            },
          }),
        ),
      ).rejects.toThrow(/ONLY_ACADEMIC/);
    });

    it('JWT role=finance → 403 ONLY_ACADEMIC', async () => {
      await expect(
        controller.createScheduleInDb(
          { input: mkInput(), tenantSchema: TENANT },
          mkReq({
            user: {
              sub: 'finance_fffffffffffffffffffffffffffff1',
              role: 'finance',
              tenantId: 'tenant-x',
              campusId: CAMPUS_X,
            },
          }),
        ),
      ).rejects.toThrow(/ONLY_ACADEMIC/);
    });

    // 2026-05-30 SSOT §5.3 line 426：教务双层（academic_admin）放行（原 Wave 11 仅 academic 已解封）
    it('JWT role=academic_admin → ✅ 教务主管可排课，server-derive callerRole=academic_admin', async () => {
      teacherRepo.listActiveInTenant.mockResolvedValueOnce([teacherT1Row, teacherT2Row]);
      svc.createScheduleInDb.mockResolvedValueOnce({
        schedule: { id: SCHEDULE_ID } as Schedule,
        students: [],
      });

      await controller.createScheduleInDb(
        { input: mkInput({ callerRole: 'sales' as any }), tenantSchema: TENANT },
        mkReq({
          user: {
            sub: 'admamin_xxxxxxxxxxxxxxxxxxxxxxxxxxx1',
            role: 'academic_admin',
            tenantId: 'tenant-x',
            campusId: CAMPUS_X,
          },
        }),
      );

      const callArgs = svc.createScheduleInDb.mock.calls[0];
      const passedInput = callArgs[0] as CreateScheduleInput;
      // server-derive 取实际 jwt.role（不恒为 academic）
      expect(passedInput.callerRole).toBe('academic_admin');
      expect(passedInput.currentUser.role).toBe('academic_admin');
      // schedulableTeachers 仍按 academic_admin.campusId 过滤（单校 role）
      const passedTeachers = callArgs[3] as Array<{ id: string; userId?: string }>;
      expect(passedTeachers).toHaveLength(2);
      expect(teacherRepo.listActiveInTenant).toHaveBeenCalledWith(TENANT);
    });

    it('JWT 缺 sub → BadRequestException', async () => {
      await expect(
        controller.createScheduleInDb(
          { input: mkInput(), tenantSchema: TENANT },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { user: { role: 'academic' } as any } as AuthenticatedRequest,
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

    it('academic JWT.campusId 缺失（极端 jwt 篡改）→ 403 ACADEMIC_CAMPUS_REQUIRED', async () => {
      // listActive 仍会被 mock，但 deriveSchedulableTeachers 应在 listActive 之前抛
      // （顺序：(1) listActive (2) 检查 jwtCampusId）— 当前实现 listActive 先调
      teacherRepo.listActiveInTenant.mockResolvedValueOnce([teacherT1Row]);
      await expect(
        controller.createScheduleInDb(
          { input: mkInput(), tenantSchema: TENANT },
          mkReq({
            user: {
              sub: USER_ACADEMIC,
              role: 'academic',
              tenantId: 'tenant-x',
              campusId: null, // 篡改 / 残留
            },
          }),
        ),
      ).rejects.toThrow(/ACADEMIC_CAMPUS_REQUIRED/);
      expect(svc.createScheduleInDb).not.toHaveBeenCalled();
    });

    it('academic 多学员 batch → schedulableTeachers 传递（学员 ownership 不校验）', async () => {
      teacherRepo.listActiveInTenant.mockResolvedValueOnce([teacherT1Row]);
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
      // studentResponsibleSalesMap 应为空 Map（教务无 ownership 校验）
      const passedMap = svc.createScheduleInDb.mock.calls[0][2] as Map<string, string>;
      expect(passedMap.size).toBe(0);
      // findBrief 不调用（旧路径 sales 才调）
      expect(studentRepo.findBrief).not.toHaveBeenCalled();
    });

    it('缺 tenantSchema → BadRequestException', async () => {
      await expect(
        controller.createScheduleInDb(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { input: mkInput() } as any,
          mkReq(),
        ),
      ).rejects.toThrow(/tenantSchema required/);
    });
  });

  // =================================================================
  // POST /api/schedules（内存版）— Wave 11 同 /db 路径行为
  // =================================================================
  describe('createSchedule (memory) — Wave 11 academic 唯一', () => {
    it('JWT role=admin → 403 早期挡（即使 body 自报 academic）', async () => {
      await expect(
        controller.createSchedule(
          {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            input: mkInput({ callerRole: 'academic' as any }),
            existingSchedules: [],
            existingStudentsAttachment: [],
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
      expect(svc.createSchedule).not.toHaveBeenCalled();
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
      expect(auditLog.log).toHaveBeenCalledWith(
        'unknown',
        expect.objectContaining({
          action: 'schedule.create.denied',
          targetType: 'schedule',
          after: expect.objectContaining({ reason: 'TENANT_SCHEMA_REQUIRED' }),
        }),
      );
    });

    it('academic 调用 → server-derive 派生 + 调 service（body 攻击向量被忽略）', async () => {
      teacherRepo.listActiveInTenant.mockResolvedValueOnce([teacherT1Row, teacherT2Row]);
      svc.createSchedule.mockReturnValueOnce({
        schedule: { id: SCHEDULE_ID } as Schedule,
        students: [],
      });

      await controller.createSchedule(
        {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          input: mkInput({ callerRole: 'sales' as any }),
          existingSchedules: [],
          existingStudentsAttachment: [],
          tenantSchema: TENANT,
          studentResponsibleSalesPairs: [[STUDENT_S1, 'attacker']],
          schedulableTeachers: [{ id: TEACHER_T1, userId: 'attacker' }],
        },
        mkReq(),
      );

      const callArgs = svc.createSchedule.mock.calls[0];
      const passedInput = callArgs[0] as CreateScheduleInput;
      expect(passedInput.callerRole).toBe('academic'); // server derived
      expect(passedInput.currentUser.id).toBe(USER_ACADEMIC);

      const passedMap = callArgs[3] as Map<string, string>;
      expect(passedMap.size).toBe(0); // deprecated 空 Map

      const passedTeachers = callArgs[4] as Array<{ id: string; userId?: string }>;
      expect(passedTeachers).toHaveLength(2);

      expect(teacherRepo.listActiveInTenant).toHaveBeenCalledTimes(1);
      expect(studentRepo.findBrief).not.toHaveBeenCalled();
    });
  });

  // ===========================================================
  // Sprint B.4-1 round 2: schedule 3 个写 endpoint 早期 403 (business P1-A)
  // Wave 11 (2026-05-15) 反向修复：早期 403 = 仅 academic（不是 {teacher,sales}）
  // ===========================================================

  const dummySchedule: Schedule = {
    id: SCHEDULE_ID,
    teacherId: TEACHER_T1,
    startAt: new Date('2026-05-20T10:00:00Z'),
    endAt: new Date('2026-05-20T11:00:00Z'),
    durationMin: 60,
    status: '已排课',
    source: 'one_off',
    createdByUserId: USER_ACADEMIC,
    createdByRole: 'academic',
  };

  describe('cancelSchedule — Wave 11 早期 403 仅 academic', () => {
    it('JWT role=admin → 403 ONLY_ACADEMIC（早于 service）', async () => {
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
      ).rejects.toThrow(/ONLY_ACADEMIC/);
      expect(svc.cancelSchedule).not.toHaveBeenCalled();
      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({
          action: 'schedule.cancel.denied',
          targetType: 'schedule',
          targetId: SCHEDULE_ID,
        }),
      );
    });

    it('JWT role=sales → 403 ONLY_ACADEMIC（5/12 反向修复）', async () => {
      await expect(
        controller.cancelSchedule(
          SCHEDULE_ID,
          { schedule: dummySchedule, tenantSchema: TENANT },
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

    it('JWT role=teacher → 403 ONLY_ACADEMIC（拍板 L133 老师不创建/调度）', async () => {
      await expect(
        controller.cancelSchedule(
          SCHEDULE_ID,
          { schedule: dummySchedule, tenantSchema: TENANT },
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
        controller.cancelSchedule(
          SCHEDULE_ID,
          { schedule: dummySchedule, tenantSchema: TENANT },
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
      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({
          action: 'schedule.cancel',
          targetType: 'schedule',
          targetId: SCHEDULE_ID,
          actorUserId: USER_ACADEMIC,
          actorRole: 'academic',
        }),
      );
    });

    // 2026-05-30 SSOT §5.3：教务主管 academic_admin 同样放行（actorRole 取实际角色）
    it('JWT role=academic_admin → 调用 service + 成功 audit_log（actorRole=academic_admin）', async () => {
      svc.cancelSchedule.mockReturnValueOnce({
        ...dummySchedule,
        status: '已取消',
      } as Schedule);
      await controller.cancelSchedule(
        SCHEDULE_ID,
        { schedule: dummySchedule, tenantSchema: TENANT, reason: 'parent-request' },
        mkReq({
          user: {
            sub: 'admamin_xxxxxxxxxxxxxxxxxxxxxxxxxxx1',
            role: 'academic_admin',
            tenantId: 'tenant-x',
            campusId: CAMPUS_X,
          },
        }),
      );
      expect(svc.cancelSchedule).toHaveBeenCalledTimes(1);
      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({
          action: 'schedule.cancel',
          targetType: 'schedule',
          actorRole: 'academic_admin',
        }),
      );
    });
  });

  describe('completeSchedule — Wave 11 早期 403 仅 academic', () => {
    it('JWT role=admin → 403 ONLY_ACADEMIC（早于 service）', async () => {
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
      ).rejects.toThrow(/ONLY_ACADEMIC/);
      expect(svc.completeSchedule).not.toHaveBeenCalled();
      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({
          action: 'schedule.complete.denied',
          targetType: 'schedule',
          targetId: SCHEDULE_ID,
        }),
      );
    });

    it('JWT role=hr → 403 ONLY_ACADEMIC', async () => {
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
      ).rejects.toThrow(/ONLY_ACADEMIC/);
    });

    it('JWT role=sales → 403 ONLY_ACADEMIC（5/12 反向修复）', async () => {
      await expect(
        controller.completeSchedule(
          SCHEDULE_ID,
          { schedule: dummySchedule, tenantSchema: TENANT },
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
        controller.completeSchedule(
          SCHEDULE_ID,
          { schedule: dummySchedule, tenantSchema: TENANT },
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
      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({
          action: 'schedule.complete',
          targetType: 'schedule',
          targetId: SCHEDULE_ID,
        }),
      );
    });

    // 2026-05-30 SSOT §5.3：教务主管 academic_admin 同样放行
    it('JWT role=academic_admin → 调用 service + 成功 audit_log', async () => {
      svc.completeSchedule.mockReturnValueOnce({
        ...dummySchedule,
        status: '已完成',
      } as Schedule);
      await controller.completeSchedule(
        SCHEDULE_ID,
        { schedule: dummySchedule, tenantSchema: TENANT },
        mkReq({
          user: {
            sub: 'admamin_xxxxxxxxxxxxxxxxxxxxxxxxxxx1',
            role: 'academic_admin',
            tenantId: 'tenant-x',
            campusId: CAMPUS_X,
          },
        }),
      );
      expect(svc.completeSchedule).toHaveBeenCalledTimes(1);
      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({
          action: 'schedule.complete',
          actorRole: 'academic_admin',
        }),
      );
    });
  });

  describe('listByTeacherInDb — Wave 11 read 路径 RBAC', () => {
    const listBody = {
      tenantSchema: TENANT,
      teacherId: TEACHER_T1,
      fromIso: '2026-05-13T00:00:00Z',
      toIso: '2026-05-20T00:00:00Z',
    };

    it('JWT role=teacher → 调用 service（read scope 含 teacher 自己课）', async () => {
      svc.listByTeacherInDb.mockResolvedValueOnce([]);
      await controller.listByTeacherInDb(
        listBody,
        mkReq({
          user: {
            sub: USER_TEACHER,
            role: 'teacher',
            tenantId: 'tenant-x',
            campusId: CAMPUS_X,
          },
        }),
      );
      expect(svc.listByTeacherInDb).toHaveBeenCalledTimes(1);
    });

    it('JWT role=sales → 调用 service（read scope 含 sales 自己客户孩子课）', async () => {
      svc.listByTeacherInDb.mockResolvedValueOnce([]);
      await controller.listByTeacherInDb(
        listBody,
        mkReq({
          user: {
            sub: USER_SALES,
            role: 'sales',
            tenantId: 'tenant-x',
            campusId: CAMPUS_X,
          },
        }),
      );
      expect(svc.listByTeacherInDb).toHaveBeenCalledTimes(1);
    });

    it('JWT role=academic → 调用 service（read scope 含教务质检看）', async () => {
      svc.listByTeacherInDb.mockResolvedValueOnce([]);
      await controller.listByTeacherInDb(listBody, mkReq());
      expect(svc.listByTeacherInDb).toHaveBeenCalledTimes(1);
    });

    it('JWT role=boss → 调用 service（read scope 含老板/校长看）', async () => {
      svc.listByTeacherInDb.mockResolvedValueOnce([]);
      await controller.listByTeacherInDb(
        listBody,
        mkReq({
          user: {
            sub: 'boss_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1',
            role: 'boss',
            tenantId: 'tenant-x',
            campusId: CAMPUS_X,
          },
        }),
      );
      expect(svc.listByTeacherInDb).toHaveBeenCalledTimes(1);
    });

    it('JWT role=admin → 调用 service（read scope 含 admin 跨校）', async () => {
      svc.listByTeacherInDb.mockResolvedValueOnce([]);
      await controller.listByTeacherInDb(
        listBody,
        mkReq({
          user: {
            sub: 'admin_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
            role: 'admin',
            tenantId: null,
            campusId: null,
          },
        }),
      );
      expect(svc.listByTeacherInDb).toHaveBeenCalledTimes(1);
    });

    it('JWT role=finance → 403 SCHEDULE_READ_ROLE_NOT_ALLOWED（不在 read scope）', async () => {
      await expect(
        controller.listByTeacherInDb(
          listBody,
          mkReq({
            user: {
              sub: 'finance_ffffffffffffffffffffffffffffff1',
              role: 'finance',
              tenantId: 'tenant-x',
              campusId: CAMPUS_X,
            },
          }),
        ),
      ).rejects.toThrow(/SCHEDULE_READ_ROLE_NOT_ALLOWED/);
      expect(svc.listByTeacherInDb).not.toHaveBeenCalled();
    });

    it('JWT role=hr → 403 SCHEDULE_READ_ROLE_NOT_ALLOWED', async () => {
      await expect(
        controller.listByTeacherInDb(
          listBody,
          mkReq({
            user: {
              sub: 'hr_hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh1',
              role: 'hr',
              tenantId: 'tenant-x',
              campusId: null,
            },
          }),
        ),
      ).rejects.toThrow(/SCHEDULE_READ_ROLE_NOT_ALLOWED/);
    });
  });

  describe('markAttendance — Wave 11 早期 403 仅 academic', () => {
    const dummyStudent: ScheduleStudent = {
      scheduleId: SCHEDULE_ID,
      studentId: STUDENT_S1,
      attendanceStatus: '待出勤',
    } as ScheduleStudent;
    const newStatus: AttendanceStatus = '出勤';

    it('JWT role=admin → 403 ONLY_ACADEMIC（早于 service）', async () => {
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
      ).rejects.toThrow(/ONLY_ACADEMIC/);
      expect(svc.markAttendance).not.toHaveBeenCalled();
      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({
          action: 'schedule.mark-attendance.denied',
          targetType: 'schedule',
          targetId: SCHEDULE_ID,
        }),
      );
    });

    it('JWT role=finance → 403 ONLY_ACADEMIC', async () => {
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
              campusId: CAMPUS_X,
            },
          }),
        ),
      ).rejects.toThrow(/ONLY_ACADEMIC/);
    });

    it('JWT role=sales → 403 ONLY_ACADEMIC（5/12 反向修复）', async () => {
      await expect(
        controller.markAttendance(
          SCHEDULE_ID,
          STUDENT_S1,
          { scheduleStudent: dummyStudent, newStatus, tenantSchema: TENANT },
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
        controller.markAttendance(
          SCHEDULE_ID,
          STUDENT_S1,
          { scheduleStudent: dummyStudent, newStatus, tenantSchema: TENANT },
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

    // 2026-05-30 SSOT §5.3：教务主管 academic_admin 同样可标考勤
    it('JWT role=academic_admin → 调用 service + 成功 audit_log', async () => {
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
            sub: 'admamin_xxxxxxxxxxxxxxxxxxxxxxxxxxx1',
            role: 'academic_admin',
            tenantId: 'tenant-x',
            campusId: CAMPUS_X,
          },
        }),
      );
      expect(svc.markAttendance).toHaveBeenCalledTimes(1);
      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({
          action: 'schedule.mark-attendance',
          actorRole: 'academic_admin',
        }),
      );
    });
  });

  // ===========================================================
  // Sprint E backlog #3: createSchedule / createScheduleInDb 成功路径 audit_log
  // Wave 11 actorRole = 'academic'
  // ===========================================================
  describe('createSchedule / createScheduleInDb — 成功路径 audit_log', () => {
    it('createScheduleInDb 成功 → audit_log action=schedule.create + actorRole=academic', async () => {
      teacherRepo.listActiveInTenant.mockResolvedValueOnce([teacherT1Row]);
      svc.createScheduleInDb.mockResolvedValueOnce({
        schedule: {
          id: SCHEDULE_ID,
          teacherId: TEACHER_T1,
          startAt: new Date('2026-05-20T10:00:00Z'),
          endAt: new Date('2026-05-20T11:00:00Z'),
          durationMin: 60,
          status: '已排课',
          source: 'one_off',
          createdByUserId: USER_ACADEMIC,
          createdByRole: 'academic',
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
          actorUserId: USER_ACADEMIC,
          actorRole: 'academic',
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

    it('createScheduleInDb 403 (admin) → audit_log action=schedule.create.denied + reason 含 ONLY_ACADEMIC', async () => {
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
      ).rejects.toThrow(/ONLY_ACADEMIC/);

      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({
          action: 'schedule.create.denied',
          targetType: 'schedule',
          targetId: SCHEDULE_ID,
          after: expect.objectContaining({
            reason: expect.stringMatching(/ONLY_ACADEMIC/),
            endpoint: 'createScheduleInDb',
          }),
        }),
      );
    });

    it('createScheduleInDb 缺 tenantSchema → audit_log denied + tenantSchema 占位 unknown', async () => {
      await expect(
        controller.createScheduleInDb(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

    it('createSchedule 内存版成功 → audit_log action=schedule.create + actorRole=academic', async () => {
      teacherRepo.listActiveInTenant.mockResolvedValueOnce([teacherT1Row]);
      svc.createSchedule.mockReturnValueOnce({
        schedule: {
          id: SCHEDULE_ID,
          teacherId: TEACHER_T1,
          startAt: new Date('2026-05-20T10:00:00Z'),
          endAt: new Date('2026-05-20T11:00:00Z'),
          durationMin: 60,
          status: '已排课',
          source: 'one_off',
          createdByUserId: USER_ACADEMIC,
          createdByRole: 'academic',
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
          actorRole: 'academic',
        }),
      );
    });

    it('auditLog 不存在（@Optional 未注入）→ 主业务流不阻塞', async () => {
      const ctrlNoAudit = new ScheduleController(
        svc as unknown as ScheduleService,
        teacherRepo as unknown as TeacherRepository,
        studentRepo as unknown as StudentRepository,
        // auditLog 不传
      );
      teacherRepo.listActiveInTenant.mockResolvedValueOnce([teacherT1Row]);
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
