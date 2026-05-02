/**
 * ScheduleService 单元测试
 *
 * USER-AUTH(2026-05-02 PD §3 + 条目 31 #2 + 条目 32 L2)
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
const ULID32_USER_SALES = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMUS1';
const ULID32_USER_OTHER_SALES = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMUS2';
const ULID32_USER_TEACHER = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMUTC';

describe('ScheduleService - V8 BE-V8-1 PD §3 + 条目 31/32', () => {
  let service: ScheduleService;

  const salesUser: CurrentUser = {
    id: ULID32_USER_SALES,
    role: 'sales',
    tenantId: ULID32_TENANT,
  };
  const teacherUser: CurrentUser = {
    id: ULID32_USER_TEACHER,
    role: 'admin', // teacher 用户的 users.role 通常是 admin/sales_manager（条目 31 #2）
    tenantId: ULID32_TENANT,
  };

  // 该 sales 跟进 student S1 / S2，不跟 S3
  const studentSalesMap = new Map<string, string>([
    [ULID32_S1, ULID32_USER_SALES],
    [ULID32_S2, ULID32_USER_SALES],
    [ULID32_S3, ULID32_USER_OTHER_SALES],
  ]);

  // schedulableTeachers：T1 全职（关联 user）、T2 纯档案（无 user_id）
  const schedulableTeachers = [
    { id: ULID32_T1, userId: ULID32_USER_TEACHER },
    { id: ULID32_T2 }, // 纯档案不登录（条目 31 #2）
  ];

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ScheduleService],
    }).compile();
    service = module.get<ScheduleService>(ScheduleService);
  });

  describe('createSchedule - 销售排课（P3：只能跟进学员）', () => {
    it('销售给自己跟进学员排课 → 通过', () => {
      const { schedule, students } = service.createSchedule(
        {
          id: ULID32_SCH1,
          teacherId: ULID32_T1,
          studentIds: [ULID32_S1, ULID32_S2],
          startAt: new Date('2026-05-15T10:00:00Z'),
          durationMin: 60,
          currentUser: salesUser,
          callerRole: 'sales',
        },
        [],
        [],
        studentSalesMap,
        schedulableTeachers,
      );
      expect(schedule.id).toBe(ULID32_SCH1);
      expect(schedule.status).toBe('已排课');
      expect(students).toHaveLength(2);
    });

    it('销售给非跟进学员排课 → ForbiddenException(SALES_ONLY_OWN_STUDENTS)', () => {
      expect(() =>
        service.createSchedule(
          {
            id: ULID32_SCH1,
            teacherId: ULID32_T1,
            studentIds: [ULID32_S3], // 非自己跟进
            startAt: new Date('2026-05-15T10:00:00Z'),
            durationMin: 60,
            currentUser: salesUser,
            callerRole: 'sales',
          },
          [],
          [],
          studentSalesMap,
          schedulableTeachers,
        ),
      ).toThrow(ForbiddenException);
    });
  });

  describe('createSchedule - 老师排课（P4：跨校豁免）', () => {
    it('老师身份合法（teachers.user_id 反查到）→ 通过', () => {
      const { schedule } = service.createSchedule(
        {
          id: ULID32_SCH1,
          teacherId: ULID32_T1,
          studentIds: [ULID32_S3], // 跨销售跟进，老师跨校豁免
          startAt: new Date('2026-05-15T10:00:00Z'),
          durationMin: 60,
          currentUser: teacherUser,
          callerRole: 'teacher',
        },
        [],
        [],
        studentSalesMap,
        schedulableTeachers,
      );
      expect(schedule.createdByRole).toBe('teacher');
    });

    it('老师身份反查不到（user 未关联 teachers）→ ForbiddenException', () => {
      const unboundUser: CurrentUser = {
        id: '01HX7Y6P5K9N3M2QABCDEFGHIJKLM999',
        role: 'admin',
        tenantId: ULID32_TENANT,
      };
      expect(() =>
        service.createSchedule(
          {
            id: ULID32_SCH1,
            teacherId: ULID32_T1,
            studentIds: [ULID32_S1],
            startAt: new Date('2026-05-15T10:00:00Z'),
            durationMin: 60,
            currentUser: unboundUser,
            callerRole: 'teacher',
          },
          [],
          [],
          studentSalesMap,
          schedulableTeachers,
        ),
      ).toThrow(ForbiddenException);
    });
  });

  describe('createSchedule - 教师 schedulable 校验', () => {
    it('teacherId 不在 schedulableTeachers（已归档）→ BadRequestException', () => {
      expect(() =>
        service.createSchedule(
          {
            id: ULID32_SCH1,
            teacherId: '01HX7Y6P5K9N3M2QABCDEFGHIJKLM888', // 不在列表
            studentIds: [ULID32_S1],
            startAt: new Date('2026-05-15T10:00:00Z'),
            durationMin: 60,
            currentUser: salesUser,
            callerRole: 'sales',
          },
          [],
          [],
          studentSalesMap,
          schedulableTeachers,
        ),
      ).toThrow(BadRequestException);
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
      createdByUserId: ULID32_USER_SALES,
      createdByRole: 'sales',
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
            currentUser: salesUser,
            callerRole: 'sales',
          },
          [existingSchedule],
          existingAttachment,
          studentSalesMap,
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
            currentUser: salesUser,
            callerRole: 'sales',
          },
          [existingSchedule],
          existingAttachment,
          studentSalesMap,
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
          currentUser: salesUser,
          callerRole: 'sales',
        },
        [cancelled],
        existingAttachment,
        studentSalesMap,
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
          currentUser: salesUser,
          callerRole: 'sales',
        },
        [existingSchedule],
        existingAttachment,
        studentSalesMap,
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
      currentUser: salesUser,
      callerRole: 'sales' as const,
    };

    it('id 长度非 32 → BadRequestException', () => {
      expect(() =>
        service.createSchedule(
          { ...baseInput, id: 'short' },
          [],
          [],
          studentSalesMap,
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
          studentSalesMap,
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
          studentSalesMap,
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
          studentSalesMap,
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
      createdByUserId: ULID32_USER_SALES,
      createdByRole: 'sales',
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
});
