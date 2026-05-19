/**
 * ScheduleService 单元测试
 *
 * USER-AUTH(2026-05-02 PD §3 + 条目 31 #2 + 条目 32 L2)
 *
 * Wave 11（2026-05-15）拍板反向修复：
 *   - 5/9 拍板「教务唯一创建」（fields-by-role.md L82/L102/L133/L201）
 *   - 5/12 Sprint B.4-1 round 2 误读拍板写成 {teacher, sales} 创建 + academic 403
 *   - Wave 11 修正：callerRole = 'academic'（教务）；service 兜底校验非 academic → 403
 *   - 学生 ownership 校验已移除（教务 ✅ 创建拍板无任何限定）
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import {
  ScheduleService,
  Schedule,
  ScheduleStudent,
  CurrentUser,
} from './schedule.service';

const ULID32_SCH1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLSCH1';
const ULID32_SCH2 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLSCH2';
const ULID32_T1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMTC1';
const ULID32_T2 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMTC2';
const ULID32_S1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMST1';
const ULID32_S2 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMST2';
const ULID32_S3 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMST3';
const ULID32_TENANT = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMTNT';
const ULID32_USER_ACADEMIC = '01HX7Y6P5K9N3M2QABCDEFGHIJKLACAD';
const ULID32_USER_TEACHER = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMUTC';
const ULID32_USER_SALES = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMUS1';

describe('ScheduleService - V8 BE-V8-1 PD §3 + 条目 31/32 (Wave 11 academic 唯一)', () => {
  let service: ScheduleService;

  const academicUser: CurrentUser = {
    id: ULID32_USER_ACADEMIC,
    role: 'academic',
    tenantId: ULID32_TENANT,
  };

  // schedulableTeachers：T1 全职（关联 user）、T2 纯档案（无 user_id）
  // controller 层 deriveSchedulableTeachers 已按 academic.campus_id 过滤
  const schedulableTeachers = [
    { id: ULID32_T1, userId: ULID32_USER_TEACHER },
    { id: ULID32_T2 }, // 纯档案不登录（条目 31 #2）
  ];

  // Wave 11: studentResponsibleSalesMap deprecated（教务无 ownership 校验）
  const emptySalesMap = new Map<string, string>();

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ScheduleService],
    }).compile();
    service = module.get<ScheduleService>(ScheduleService);
  });

  describe('createSchedule - 教务排课（Wave 11 拍板：教务唯一）', () => {
    it('教务给本校老师 + 任意学员排课 → 通过', () => {
      const { schedule, students } = service.createSchedule(
        {
          id: ULID32_SCH1,
          teacherId: ULID32_T1,
          studentIds: [ULID32_S1, ULID32_S2],
          startAt: new Date('2026-05-15T10:00:00Z'),
          durationMin: 60,
          currentUser: academicUser,
          callerRole: 'academic',
        },
        [],
        [],
        emptySalesMap,
        schedulableTeachers,
      );
      expect(schedule.id).toBe(ULID32_SCH1);
      expect(schedule.status).toBe('已排课');
      expect(schedule.createdByRole).toBe('academic');
      expect(schedule.createdByUserId).toBe(ULID32_USER_ACADEMIC);
      expect(students).toHaveLength(2);
    });

    it('教务给多个学员（拍板 L201 无 ownership 限定）→ 通过', () => {
      const { students } = service.createSchedule(
        {
          id: ULID32_SCH1,
          teacherId: ULID32_T1,
          studentIds: [ULID32_S1, ULID32_S2, ULID32_S3],
          startAt: new Date('2026-05-15T10:00:00Z'),
          durationMin: 60,
          currentUser: academicUser,
          callerRole: 'academic',
        },
        [],
        [],
        emptySalesMap, // 教务无需 ownership 校验
        schedulableTeachers,
      );
      expect(students).toHaveLength(3);
    });
  });

  describe('createSchedule - service 层 RBAC 兜底（Wave 11）', () => {
    const baseInput = {
      id: ULID32_SCH1,
      teacherId: ULID32_T1,
      studentIds: [ULID32_S1],
      startAt: new Date('2026-05-15T10:00:00Z'),
      durationMin: 60,
    };

    it('callerRole=sales（拍板违反）→ ForbiddenException(ONLY_ACADEMIC)', () => {
      expect(() =>
        service.createSchedule(
          {
            ...baseInput,
            currentUser: { ...academicUser, role: 'sales' },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            callerRole: 'sales' as any,
          },
          [],
          [],
          emptySalesMap,
          schedulableTeachers,
        ),
      ).toThrow(ForbiddenException);
      expect(() =>
        service.createSchedule(
          {
            ...baseInput,
            currentUser: { ...academicUser, role: 'sales' },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            callerRole: 'sales' as any,
          },
          [],
          [],
          emptySalesMap,
          schedulableTeachers,
        ),
      ).toThrow(/ONLY_ACADEMIC_CAN_CREATE_SCHEDULE/);
    });

    it('callerRole=teacher（拍板违反）→ ForbiddenException(ONLY_ACADEMIC)', () => {
      expect(() =>
        service.createSchedule(
          {
            ...baseInput,
            currentUser: { ...academicUser, role: 'teacher' },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            callerRole: 'teacher' as any,
          },
          [],
          [],
          emptySalesMap,
          schedulableTeachers,
        ),
      ).toThrow(/ONLY_ACADEMIC_CAN_CREATE_SCHEDULE/);
    });

    it('callerRole=admin（拍板违反）→ ForbiddenException(ONLY_ACADEMIC)', () => {
      expect(() =>
        service.createSchedule(
          {
            ...baseInput,
            currentUser: { ...academicUser, role: 'admin' },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            callerRole: 'admin' as any,
          },
          [],
          [],
          emptySalesMap,
          schedulableTeachers,
        ),
      ).toThrow(/ONLY_ACADEMIC_CAN_CREATE_SCHEDULE/);
    });
  });

  describe('createSchedule - 教师 schedulable 校验（Wave 11 改 ForbiddenException）', () => {
    it('teacherId 不在 schedulableTeachers（已归档 / 跨校）→ ForbiddenException(TEACHER_NOT_IN_ACADEMIC_CAMPUS)', () => {
      expect(() =>
        service.createSchedule(
          {
            id: ULID32_SCH1,
            teacherId: '01HX7Y6P5K9N3M2QABCDEFGHIJKLM888', // 不在列表
            studentIds: [ULID32_S1],
            startAt: new Date('2026-05-15T10:00:00Z'),
            durationMin: 60,
            currentUser: academicUser,
            callerRole: 'academic',
          },
          [],
          [],
          emptySalesMap,
          schedulableTeachers,
        ),
      ).toThrow(ForbiddenException);
      expect(() =>
        service.createSchedule(
          {
            id: ULID32_SCH1,
            teacherId: '01HX7Y6P5K9N3M2QABCDEFGHIJKLM888',
            studentIds: [ULID32_S1],
            startAt: new Date('2026-05-15T10:00:00Z'),
            durationMin: 60,
            currentUser: academicUser,
            callerRole: 'academic',
          },
          [],
          [],
          emptySalesMap,
          schedulableTeachers,
        ),
      ).toThrow(/TEACHER_NOT_IN_ACADEMIC_CAMPUS/);
    });
  });

  describe('createSchedule - 冲突硬阻塞（P5）', () => {
    const existingSchedule: Schedule = {
      id: ULID32_SCH2,
      teacherId: ULID32_T1,
      startAt: new Date('2026-05-15T10:00:00Z'),
      durationMin: 60,
      endAt: new Date('2026-05-15T11:00:00Z'),
      status: '已排课',
      source: 'one_off',
      createdByUserId: ULID32_USER_ACADEMIC,
      createdByRole: 'academic',
    };
    const existingAttachment: ScheduleStudent[] = [
      {
        scheduleId: ULID32_SCH2,
        studentId: ULID32_S2,
        attendanceStatus: '待出勤',
        joinedAt: new Date(),
      },
    ];

    it('老师同时段冲突 → ConflictException(TEACHER_TIME_CONFLICT)', () => {
      expect(() =>
        service.createSchedule(
          {
            id: ULID32_SCH1,
            teacherId: ULID32_T1, // 同老师
            studentIds: [ULID32_S1],
            startAt: new Date('2026-05-15T10:30:00Z'), // 重叠
            durationMin: 60,
            currentUser: academicUser,
            callerRole: 'academic',
          },
          [existingSchedule],
          existingAttachment,
          emptySalesMap,
          schedulableTeachers,
        ),
      ).toThrow(ConflictException);
    });

    it('学员同时段冲突 → ConflictException(STUDENT_TIME_CONFLICT)', () => {
      expect(() =>
        service.createSchedule(
          {
            id: ULID32_SCH1,
            teacherId: ULID32_T2, // 不同老师
            studentIds: [ULID32_S2], // 同学员
            startAt: new Date('2026-05-15T10:30:00Z'),
            durationMin: 60,
            currentUser: academicUser,
            callerRole: 'academic',
          },
          [existingSchedule],
          existingAttachment,
          emptySalesMap,
          schedulableTeachers,
        ),
      ).toThrow(ConflictException);
    });

    it('已 cancelled 排课不算冲突', () => {
      const cancelled = { ...existingSchedule, status: '已取消' as const };
      const { schedule } = service.createSchedule(
        {
          id: ULID32_SCH1,
          teacherId: ULID32_T1,
          studentIds: [ULID32_S1],
          startAt: new Date('2026-05-15T10:30:00Z'),
          durationMin: 60,
          currentUser: academicUser,
          callerRole: 'academic',
        },
        [cancelled],
        existingAttachment,
        emptySalesMap,
        schedulableTeachers,
      );
      expect(schedule).toBeDefined();
    });

    it('时间相邻不重叠 → 通过', () => {
      const { schedule } = service.createSchedule(
        {
          id: ULID32_SCH1,
          teacherId: ULID32_T1,
          studentIds: [ULID32_S1],
          startAt: new Date('2026-05-15T11:00:00Z'), // 紧挨着上节课结束
          durationMin: 60,
          currentUser: academicUser,
          callerRole: 'academic',
        },
        [existingSchedule],
        existingAttachment,
        emptySalesMap,
        schedulableTeachers,
      );
      expect(schedule.startAt.toISOString()).toBe('2026-05-15T11:00:00.000Z');
    });
  });

  describe('createSchedule - 输入校验', () => {
    const baseInput = {
      teacherId: ULID32_T1,
      studentIds: [ULID32_S1],
      startAt: new Date('2026-05-15T10:00:00Z'),
      durationMin: 60,
      currentUser: academicUser,
      callerRole: 'academic' as const,
    };

    it('id 长度非 32 → BadRequestException', () => {
      expect(() =>
        service.createSchedule(
          { ...baseInput, id: 'short' },
          [],
          [],
          emptySalesMap,
          schedulableTeachers,
        ),
      ).toThrow(BadRequestException);
    });

    it('studentIds 空 → BadRequestException', () => {
      expect(() =>
        service.createSchedule(
          { ...baseInput, id: ULID32_SCH1, studentIds: [] },
          [],
          [],
          emptySalesMap,
          schedulableTeachers,
        ),
      ).toThrow(BadRequestException);
    });

    it('durationMin <=0 → BadRequestException', () => {
      expect(() =>
        service.createSchedule(
          { ...baseInput, id: ULID32_SCH1, durationMin: 0 },
          [],
          [],
          emptySalesMap,
          schedulableTeachers,
        ),
      ).toThrow(BadRequestException);
    });

    it('durationMin > 480 → BadRequestException', () => {
      expect(() =>
        service.createSchedule(
          { ...baseInput, id: ULID32_SCH1, durationMin: 481 },
          [],
          [],
          emptySalesMap,
          schedulableTeachers,
        ),
      ).toThrow(BadRequestException);
    });
  });

  describe('cancelSchedule / completeSchedule / markAttendance', () => {
    const baseSchedule: Schedule = {
      id: ULID32_SCH1,
      teacherId: ULID32_T1,
      startAt: new Date('2026-05-15T10:00:00Z'),
      durationMin: 60,
      endAt: new Date('2026-05-15T11:00:00Z'),
      status: '已排课',
      source: 'one_off',
      createdByUserId: ULID32_USER_ACADEMIC,
      createdByRole: 'academic',
    };

    it('cancel 已排课 → 已取消', () => {
      const result = service.cancelSchedule(baseSchedule, '学员请假');
      expect(result.status).toBe('已取消');
      expect(result.notes).toContain('CANCEL');
    });

    it('cancel 已完成 → BadRequestException', () => {
      expect(() =>
        service.cancelSchedule({ ...baseSchedule, status: '已完成' }),
      ).toThrow(BadRequestException);
    });

    it('cancel 已取消 → BadRequestException', () => {
      expect(() =>
        service.cancelSchedule({ ...baseSchedule, status: '已取消' }),
      ).toThrow(BadRequestException);
    });

    it('complete 已排课 → 已完成', () => {
      const result = service.completeSchedule(baseSchedule);
      expect(result.status).toBe('已完成');
    });

    it('complete 非已排课 → BadRequestException', () => {
      expect(() =>
        service.completeSchedule({ ...baseSchedule, status: '已取消' }),
      ).toThrow(BadRequestException);
    });

    it('markAttendance', () => {
      const ss: ScheduleStudent = {
        scheduleId: ULID32_SCH1,
        studentId: ULID32_S1,
        attendanceStatus: '待出勤',
        joinedAt: new Date(),
      };
      const result = service.markAttendance(ss, '出勤');
      expect(result.attendanceStatus).toBe('出勤');
    });
  });

  describe('createSchedule - 防御性兜底（防内部直调绕过 controller 早期 403）', () => {
    it('USER_SALES 用 callerRole=academic 走 service (controller 已挡过) → service 兜底通过（拍板已遵守）', () => {
      // 业务语义：service 不知道 controller 是否挡过，但只信 input.callerRole
      // 此用例验证 service 不会做 currentUser.role !== callerRole 这种额外校验
      // （那是 controller 的 server-derive 职责）
      const { schedule } = service.createSchedule(
        {
          id: ULID32_SCH1,
          teacherId: ULID32_T1,
          studentIds: [ULID32_S1],
          startAt: new Date('2026-05-15T10:00:00Z'),
          durationMin: 60,
          currentUser: {
            id: ULID32_USER_SALES,
            role: 'sales', // 仅供 audit 显示，service 不读
            tenantId: ULID32_TENANT,
          },
          callerRole: 'academic', // controller 派生后的硬值
        },
        [],
        [],
        emptySalesMap,
        schedulableTeachers,
      );
      expect(schedule.createdByRole).toBe('academic');
    });
  });
});
