/**
 * RecurringScheduleService 单元测试
 *
 * USER-AUTH(2026-05-02 PD §3.6 + 条目 32): 学员-老师绑定 + 周期性课表模板（P12）
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import {
  RecurringScheduleService,
  WeekDay,
  StudentTeacherBinding,
  RecurringRbacContext,
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
    // Sprint B.4-1 round 2: rbacContext 必填，注入一个合法的 sales/自己学员 ctx
    const validSalesCtx: RecurringRbacContext = {
      callerRole: 'sales',
      currentUserId: ULID32_U1,
      studentResponsibleSalesId: ULID32_U1,
    };

    it('合法创建', () => {
      const b = service.createBinding(
        {
          id: ULID32_B1,
          studentId: ULID32_S1,
          teacherId: ULID32_T1,
          subject: '数学',
          boundByUserId: ULID32_U1,
        },
        validSalesCtx,
      );
      expect(b.status).toBe('active');
      expect(b.subject).toBe('数学');
    });

    it('id 长度非 32 → BadRequestException', () => {
      expect(() =>
        service.createBinding(
          {
            id: 'short',
            studentId: ULID32_S1,
            teacherId: ULID32_T1,
            boundByUserId: ULID32_U1,
          },
          validSalesCtx,
        ),
      ).toThrow(BadRequestException);
    });

    it('Sprint B.4-1 round 2: rbacContext 缺失 → BadRequestException', () => {
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (service.createBinding as any)({
          id: ULID32_B1,
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
    // Sprint B.4-1 round 2: rbacContext 必填，注入合法 sales ctx 不改变测试意图
    const ctx: RecurringRbacContext = {
      callerRole: 'sales',
      currentUserId: ULID32_U1,
      studentResponsibleSalesId: ULID32_U1,
    };

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
        ctx,
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
          ctx,
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
        ctx,
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
          undefined,
          ctx,
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
          undefined,
          ctx,
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
          undefined,
          ctx,
        ),
      ).toThrow(BadRequestException);
    });

    it('Sprint B.4-1 round 2: rbacContext 缺失 → BadRequestException', () => {
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (service.createRecurring as any)(
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
          now,
          // 不传 ctx → 抛 BadRequestException
        ),
      ).toThrow(BadRequestException);
    });
  });

  describe('archiveRecurring - 归档', () => {
    it('active → archived 合法', () => {
      const ctx: RecurringRbacContext = {
        callerRole: 'sales',
        currentUserId: ULID32_U1,
        studentResponsibleSalesId: ULID32_U1,
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
        [],
        undefined,
        ctx,
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

  // ===========================================================
  // Sprint B.4-1 RBAC（rbacContext 注入版）
  // ===========================================================
  describe('Sprint B.4-1 RBAC — rbacContext 注入版', () => {
    const baseInput = {
      id: ULID32_R1,
      bindingId: ULID32_B1,
      studentId: ULID32_S1,
      teacherId: ULID32_T1,
      byDay: ['MO'] as WeekDay[],
      startMinutes: 18 * 60,
      durationMin: 60,
      startDate: new Date('2026-05-04T00:00:00Z'),
      createdByUserId: ULID32_U1,
      createdByRole: 'sales' as const,
    };

    const baseBindingInput = {
      id: ULID32_B1,
      studentId: ULID32_S1,
      teacherId: ULID32_T1,
      subject: '数学',
      boundByUserId: ULID32_U1,
    };

    describe('createBinding with rbacContext', () => {
      it('sales 路径 + studentResponsibleSalesId === currentUserId → 通过', () => {
        const ctx: RecurringRbacContext = {
          callerRole: 'sales',
          currentUserId: ULID32_U1,
          studentResponsibleSalesId: ULID32_U1,
        };
        const b = service.createBinding(baseBindingInput, ctx);
        expect(b.status).toBe('active');
      });

      it('sales 路径 + studentResponsibleSalesId !== currentUserId → 403 STUDENT_NOT_OWNED_BY_SALES', () => {
        const ctx: RecurringRbacContext = {
          callerRole: 'sales',
          currentUserId: ULID32_U1,
          studentResponsibleSalesId: '01HX7Y6P5K9N3M2QABCDEFGHIJKLOTHR',
        };
        expect(() => service.createBinding(baseBindingInput, ctx)).toThrow(
          ForbiddenException,
        );
        expect(() => service.createBinding(baseBindingInput, ctx)).toThrow(
          /STUDENT_NOT_OWNED_BY_SALES/,
        );
      });

      it('sales 路径 + studentResponsibleSalesId 缺失（null）→ 403', () => {
        const ctx: RecurringRbacContext = {
          callerRole: 'sales',
          currentUserId: ULID32_U1,
          studentResponsibleSalesId: null,
        };
        expect(() => service.createBinding(baseBindingInput, ctx)).toThrow(
          /STUDENT_NOT_OWNED_BY_SALES/,
        );
      });

      it('teacher 路径 + teacherUserId === currentUserId → 通过', () => {
        const ctx: RecurringRbacContext = {
          callerRole: 'teacher',
          currentUserId: ULID32_U1,
          teacherUserId: ULID32_U1,
        };
        const b = service.createBinding(baseBindingInput, ctx);
        expect(b.status).toBe('active');
      });

      it('teacher 路径 + teacherUserId !== currentUserId → 403 TEACHER_USER_NOT_BOUND', () => {
        const ctx: RecurringRbacContext = {
          callerRole: 'teacher',
          currentUserId: ULID32_U1,
          teacherUserId: '01HX7Y6P5K9N3M2QABCDEFGHIJKLOTHR',
        };
        expect(() => service.createBinding(baseBindingInput, ctx)).toThrow(
          /TEACHER_USER_NOT_BOUND/,
        );
      });

      it('teacher 路径 + teacherUserId 缺失（teacher 纯档案无 user_id）→ 403', () => {
        const ctx: RecurringRbacContext = {
          callerRole: 'teacher',
          currentUserId: ULID32_U1,
          teacherUserId: null,
        };
        expect(() => service.createBinding(baseBindingInput, ctx)).toThrow(
          /TEACHER_USER_NOT_BOUND/,
        );
      });

      it('非法 callerRole → 403 ONLY_TEACHER_OR_SALES（service 层兜底）', () => {
        const ctx = {
          callerRole: 'admin',
          currentUserId: ULID32_U1,
        } as unknown as RecurringRbacContext;
        expect(() => service.createBinding(baseBindingInput, ctx)).toThrow(
          /ONLY_TEACHER_OR_SALES_CAN_CREATE_SCHEDULE/,
        );
      });

      it('Sprint B.4-1 round 2: 不传 rbacContext → BadRequestException（A04 修复，删除旧 fixture 模式）', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(() => (service.createBinding as any)(baseBindingInput)).toThrow(
          BadRequestException,
        );
      });
    });

    describe('createRecurring with rbacContext', () => {
      const now = new Date('2026-05-02T00:00:00Z');

      it('sales 路径 + studentResponsibleSalesId === currentUserId → 通过（无冲突）', () => {
        const ctx: RecurringRbacContext = {
          callerRole: 'sales',
          currentUserId: ULID32_U1,
          studentResponsibleSalesId: ULID32_U1,
        };
        const r = service.createRecurring(baseInput, 30, [], now, ctx);
        expect(r.status).toBe('active');
      });

      it('sales 路径 + studentResponsibleSalesId !== currentUserId → 403', () => {
        const ctx: RecurringRbacContext = {
          callerRole: 'sales',
          currentUserId: ULID32_U1,
          studentResponsibleSalesId: '01HX7Y6P5K9N3M2QABCDEFGHIJKLOTHR',
        };
        expect(() => service.createRecurring(baseInput, 30, [], now, ctx)).toThrow(
          /STUDENT_NOT_OWNED_BY_SALES/,
        );
      });

      it('teacher 路径 + teacherUserId === currentUserId → 通过', () => {
        const ctx: RecurringRbacContext = {
          callerRole: 'teacher',
          currentUserId: ULID32_U1,
          teacherUserId: ULID32_U1,
        };
        const r = service.createRecurring(baseInput, 30, [], now, ctx);
        expect(r.status).toBe('active');
      });

      it('teacher 路径 + teacherUserId !== currentUserId → 403', () => {
        const ctx: RecurringRbacContext = {
          callerRole: 'teacher',
          currentUserId: ULID32_U1,
          teacherUserId: '01HX7Y6P5K9N3M2QABCDEFGHIJKLOTHR',
        };
        expect(() => service.createRecurring(baseInput, 30, [], now, ctx)).toThrow(
          /TEACHER_USER_NOT_BOUND/,
        );
      });

      it('非法 callerRole → 403 ONLY_TEACHER_OR_SALES', () => {
        const ctx = {
          callerRole: 'academic',
          currentUserId: ULID32_U1,
        } as unknown as RecurringRbacContext;
        expect(() => service.createRecurring(baseInput, 30, [], now, ctx)).toThrow(
          /ONLY_TEACHER_OR_SALES_CAN_CREATE_SCHEDULE/,
        );
      });

      it('Sprint B.4-1 round 2: 不传 rbacContext → BadRequestException（A04 修复，删除旧 fixture 模式）', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(() => (service.createRecurring as any)(baseInput, 30, [], now)).toThrow(
          BadRequestException,
        );
      });
    });
  });
});
