/**
 * RecurringScheduleService 单元测试
 *
 * USER-AUTH(2026-05-02 PD §3.6 + 条目 32): 学员-老师绑定 + 周期性课表模板（P12）
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  RecurringScheduleService,
  WeekDay,
  StudentTeacherBinding,
} from './recurring-schedule.service';

const ULID32_B1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLBND1';
const ULID32_R1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLREC1';
const ULID32_S1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMST1';
const ULID32_T1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMTC1';
const ULID32_U1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMUS1';

describe('RecurringScheduleService - V8.1 BE-V8-2 PD §3.6', () => {
  let service: RecurringScheduleService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [RecurringScheduleService],
    }).compile();
    service = module.get<RecurringScheduleService>(RecurringScheduleService);
  });

  describe('createBinding - 学员-老师绑定', () => {
    it('合法创建', () => {
      const b = service.createBinding({
        id: ULID32_B1,
        studentId: ULID32_S1,
        teacherId: ULID32_T1,
        subject: '数学',
        boundByUserId: ULID32_U1,
      });
      expect(b.status).toBe('active');
      expect(b.subject).toBe('数学');
    });

    it('id 长度非 32 → BadRequestException', () => {
      expect(() =>
        service.createBinding({
          id: 'short',
          studentId: ULID32_S1,
          teacherId: ULID32_T1,
          boundByUserId: ULID32_U1,
        }),
      ).toThrow(BadRequestException);
    });
  });

  describe('unbindBinding - 解绑', () => {
    it('active → unbound 合法', () => {
      const b: StudentTeacherBinding = {
        id: ULID32_B1,
        studentId: ULID32_S1,
        teacherId: ULID32_T1,
        status: 'active',
        boundAt: new Date(),
        boundByUserId: ULID32_U1,
      };
      const result = service.unbindBinding(b);
      expect(result.status).toBe('unbound');
      expect(result.unboundAt).toBeDefined();
    });

    it('已 unbound 再解绑 → BadRequestException', () => {
      const b: StudentTeacherBinding = {
        id: ULID32_B1,
        studentId: ULID32_S1,
        teacherId: ULID32_T1,
        status: 'unbound',
        boundAt: new Date(),
        boundByUserId: ULID32_U1,
      };
      expect(() => service.unbindBinding(b)).toThrow(BadRequestException);
    });
  });

  describe('expandToCandidates - RRULE 简化展开', () => {
    it('每周一 18:00 60min，30 天范围 → 4-5 个时段', () => {
      const startDate = new Date('2026-05-04T00:00:00Z'); // 周一
      const now = new Date('2026-05-02T00:00:00Z');
      const result = service.expandToCandidates(
        ['MO'],
        18 * 60, // 18:00
        60,
        startDate,
        undefined,
        30,
        now,
      );
      expect(result.length).toBeGreaterThanOrEqual(4);
      // 全部应为周一
      for (const c of result) {
        expect(c.startAt.getUTCDay()).toBe(1); // 周一 = 1
        expect(c.startAt.getUTCHours()).toBe(18);
      }
    });

    it('每周一三五 7 天范围 → 3 个时段（周一周三周五各 1 次）', () => {
      const startDate = new Date('2026-05-04T00:00:00Z'); // 周一
      const now = new Date('2026-05-02T00:00:00Z');
      const result = service.expandToCandidates(
        ['MO', 'WE', 'FR'],
        18 * 60,
        60,
        startDate,
        undefined,
        7,
        now,
      );
      // 5/4 周一 / 5/6 周三 / 5/8 周五 = 3 个
      expect(result.length).toBe(3);
      const days = result.map((r) => r.startAt.getUTCDay()).sort();
      expect(days).toEqual([1, 3, 5]);
    });

    it('endDate 截止 → 不超过 endDate', () => {
      const startDate = new Date('2026-05-04T00:00:00Z');
      const endDate = new Date('2026-05-08T23:59:59Z'); // 5/4 ~ 5/8（5天）
      const now = new Date('2026-05-02T00:00:00Z');
      const result = service.expandToCandidates(
        ['MO', 'TU', 'WE', 'TH', 'FR'],
        9 * 60,
        60,
        startDate,
        endDate,
        30,
        now,
      );
      expect(result).toHaveLength(5); // 周一到周五各一次
      for (const c of result) {
        expect(c.startAt.getTime()).toBeLessThanOrEqual(
          endDate.getTime() + 24 * 60 * 60 * 1000,
        );
      }
    });
  });

  describe('createRecurring - 创建模板含冲突预检', () => {
    const now = new Date('2026-05-02T00:00:00Z');

    it('无冲突 → 返回 active 模板', () => {
      const recurring = service.createRecurring(
        {
          id: ULID32_R1,
          bindingId: ULID32_B1,
          studentId: ULID32_S1,
          teacherId: ULID32_T1,
          byDay: ['MO'],
          startMinutes: 18 * 60,
          durationMin: 60,
          startDate: new Date('2026-05-04T00:00:00Z'),
          createdByUserId: ULID32_U1,
          createdByRole: 'sales',
        },
        30,
        [], // 无现有排课
        now,
      );
      expect(recurring.status).toBe('active');
      expect(recurring.byDay).toEqual(['MO']);
    });

    it('展开后任一时段冲突 → ConflictException', () => {
      const conflictingSchedule = {
        teacherId: ULID32_T1,
        studentIds: [ULID32_S1],
        startAt: new Date('2026-05-04T18:30:00Z'), // 与第一节冲突
        endAt: new Date('2026-05-04T19:30:00Z'),
        status: '已排课',
      };
      expect(() =>
        service.createRecurring(
          {
            id: ULID32_R1,
            bindingId: ULID32_B1,
            studentId: ULID32_S1,
            teacherId: ULID32_T1,
            byDay: ['MO'],
            startMinutes: 18 * 60,
            durationMin: 60,
            startDate: new Date('2026-05-04T00:00:00Z'),
            createdByUserId: ULID32_U1,
            createdByRole: 'sales',
          },
          30,
          [conflictingSchedule],
          now,
        ),
      ).toThrow(ConflictException);
    });

    it('已 cancelled 排课不算冲突', () => {
      const cancelledSchedule = {
        teacherId: ULID32_T1,
        studentIds: [ULID32_S1],
        startAt: new Date('2026-05-04T18:30:00Z'),
        endAt: new Date('2026-05-04T19:30:00Z'),
        status: '已取消',
      };
      const recurring = service.createRecurring(
        {
          id: ULID32_R1,
          bindingId: ULID32_B1,
          studentId: ULID32_S1,
          teacherId: ULID32_T1,
          byDay: ['MO'],
          startMinutes: 18 * 60,
          durationMin: 60,
          startDate: new Date('2026-05-04T00:00:00Z'),
          createdByUserId: ULID32_U1,
          createdByRole: 'sales',
        },
        30,
        [cancelledSchedule],
        now,
      );
      expect(recurring.status).toBe('active');
    });

    it('byDay 空 → BadRequestException', () => {
      expect(() =>
        service.createRecurring(
          {
            id: ULID32_R1,
            bindingId: ULID32_B1,
            studentId: ULID32_S1,
            teacherId: ULID32_T1,
            byDay: [],
            startMinutes: 18 * 60,
            durationMin: 60,
            startDate: new Date('2026-05-04T00:00:00Z'),
            createdByUserId: ULID32_U1,
            createdByRole: 'sales',
          },
          30,
          [],
        ),
      ).toThrow(BadRequestException);
    });

    it('byDay 含非法值 → BadRequestException', () => {
      expect(() =>
        service.createRecurring(
          {
            id: ULID32_R1,
            bindingId: ULID32_B1,
            studentId: ULID32_S1,
            teacherId: ULID32_T1,
            byDay: ['XX' as WeekDay],
            startMinutes: 18 * 60,
            durationMin: 60,
            startDate: new Date('2026-05-04T00:00:00Z'),
            createdByUserId: ULID32_U1,
            createdByRole: 'sales',
          },
          30,
          [],
        ),
      ).toThrow(BadRequestException);
    });

    it('startMinutes 超界 → BadRequestException', () => {
      expect(() =>
        service.createRecurring(
          {
            id: ULID32_R1,
            bindingId: ULID32_B1,
            studentId: ULID32_S1,
            teacherId: ULID32_T1,
            byDay: ['MO'],
            startMinutes: 1500,
            durationMin: 60,
            startDate: new Date('2026-05-04T00:00:00Z'),
            createdByUserId: ULID32_U1,
            createdByRole: 'sales',
          },
          30,
          [],
        ),
      ).toThrow(BadRequestException);
    });
  });

  describe('archiveRecurring - 归档', () => {
    it('active → archived 合法', () => {
      const recurring = service.createRecurring(
        {
          id: ULID32_R1,
          bindingId: ULID32_B1,
          studentId: ULID32_S1,
          teacherId: ULID32_T1,
          byDay: ['MO'],
          startMinutes: 18 * 60,
          durationMin: 60,
          startDate: new Date('2026-05-04T00:00:00Z'),
          createdByUserId: ULID32_U1,
          createdByRole: 'sales',
        },
        30,
        [],
      );
      const archived = service.archiveRecurring(recurring);
      expect(archived.status).toBe('archived');
      expect(archived.archivedAt).toBeDefined();
    });

    it('已归档再归档 → BadRequestException', () => {
      const archived = {
        id: ULID32_R1,
        bindingId: ULID32_B1,
        studentId: ULID32_S1,
        teacherId: ULID32_T1,
        byDay: ['MO'] as WeekDay[],
        startMinutes: 18 * 60,
        durationMin: 60,
        startDate: new Date('2026-05-04T00:00:00Z'),
        status: 'archived' as const,
        createdByUserId: ULID32_U1,
        createdByRole: 'sales' as const,
        createdAt: new Date(),
        archivedAt: new Date(),
      };
      expect(() => service.archiveRecurring(archived)).toThrow(BadRequestException);
    });
  });
});
