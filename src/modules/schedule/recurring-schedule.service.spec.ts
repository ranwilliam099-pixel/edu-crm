/**
 * RecurringScheduleService 单元测试
 *
 * USER-AUTH(2026-05-02 PD §3.6 + 条目 32): 学员-老师绑定 + 周期性课表模板（P12）
 *
 * Wave 11（2026-05-15）拍板反向修复：
 *   - 5/9 拍板「教务唯一创建」(fields-by-role.md L82/L102/L133/L201)
 *   - 5/12 Sprint B.4-1 round 2 误读拍板写成 {teacher, sales} 创建
 *   - Wave 11 修正 RecurringRbacContext.callerRole 域 = 'academic'
 *   - assertRecurringRbac 改为 academic.campus_id === teacher.campus_id 比较
 *   - 学生 ownership 校验已移除
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import {
  RecurringScheduleService,
  WeekDay,
  StudentTeacherBinding,
  RecurringRbacContext,
} from './recurring-schedule.service';
import { PgPoolService } from '../db/pg-pool.service';

const ULID32_B1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLBND1';
const ULID32_R1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLREC1';
const ULID32_S1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMST1';
const ULID32_T1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMTC1';
const ULID32_U1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMUS1';
const CAMPUS_X = 'cmp_x00000000000000000000000000X1';
const CAMPUS_Y = 'cmp_y00000000000000000000000000Y1';

describe('RecurringScheduleService - V8.1 BE-V8-2 PD §3.6 (Wave 11 academic 唯一)', () => {
  let service: RecurringScheduleService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [RecurringScheduleService],
    }).compile();
    service = module.get<RecurringScheduleService>(RecurringScheduleService);
  });

  describe('createBinding - 学员-老师绑定（Wave 11 拍板：教务唯一）', () => {
    // academic 同校：academicCampusId === teacherCampusId
    const validAcademicCtx: RecurringRbacContext = {
      callerRole: 'academic',
      currentUserId: ULID32_U1,
      academicCampusId: CAMPUS_X,
      teacherCampusId: CAMPUS_X,
    };

    it('合法创建（academic 同校老师）', () => {
      const b = service.createBinding(
        {
          id: ULID32_B1,
          studentId: ULID32_S1,
          teacherId: ULID32_T1,
          subject: '数学',
          boundByUserId: ULID32_U1,
        },
        validAcademicCtx,
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
          validAcademicCtx,
        ),
      ).toThrow(BadRequestException);
    });

    it('rbacContext 缺失 → BadRequestException (A04 修复)', () => {
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
      for (const c of result) {
        expect(c.startAt.getUTCDay()).toBe(1);
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
      expect(result.length).toBe(3);
      const days = result.map((r) => r.startAt.getUTCDay()).sort();
      expect(days).toEqual([1, 3, 5]);
    });

    it('endDate 截止 → 不超过 endDate', () => {
      const startDate = new Date('2026-05-04T00:00:00Z');
      const endDate = new Date('2026-05-08T23:59:59Z');
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
      expect(result).toHaveLength(5);
      for (const c of result) {
        expect(c.startAt.getTime()).toBeLessThanOrEqual(
          endDate.getTime() + 24 * 60 * 60 * 1000,
        );
      }
    });
  });

  describe('createRecurring - 创建模板含冲突预检（Wave 11 academic 唯一）', () => {
    const now = new Date('2026-05-02T00:00:00Z');
    const ctx: RecurringRbacContext = {
      callerRole: 'academic',
      currentUserId: ULID32_U1,
      academicCampusId: CAMPUS_X,
      teacherCampusId: CAMPUS_X,
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
          createdByRole: 'academic',
        },
        30,
        [], // 无现有排课
        now,
        ctx,
      );
      expect(recurring.status).toBe('active');
      expect(recurring.byDay).toEqual(['MO']);
      expect(recurring.createdByRole).toBe('academic');
    });

    it('展开后任一时段冲突 → ConflictException', () => {
      const conflictingSchedule = {
        teacherId: ULID32_T1,
        studentIds: [ULID32_S1],
        startAt: new Date('2026-05-04T18:30:00Z'),
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
            createdByRole: 'academic',
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
          createdByRole: 'academic',
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
            createdByRole: 'academic',
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
            createdByRole: 'academic',
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
            createdByRole: 'academic',
          },
          30,
          [],
          undefined,
          ctx,
        ),
      ).toThrow(BadRequestException);
    });

    it('rbacContext 缺失 → BadRequestException (A04 修复)', () => {
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
            createdByRole: 'academic',
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
        callerRole: 'academic',
        currentUserId: ULID32_U1,
        academicCampusId: CAMPUS_X,
        teacherCampusId: CAMPUS_X,
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
          createdByRole: 'academic',
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
        createdByRole: 'academic' as const,
        createdAt: new Date(),
        archivedAt: new Date(),
      };
      expect(() => service.archiveRecurring(archived)).toThrow(BadRequestException);
    });
  });

  // ===========================================================
  // Wave 11 RBAC（academic + campus_id 校验）
  // ===========================================================
  describe('Wave 11 RBAC — academic + campus 校验', () => {
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
      createdByRole: 'academic' as const,
    };

    const baseBindingInput = {
      id: ULID32_B1,
      studentId: ULID32_S1,
      teacherId: ULID32_T1,
      subject: '数学',
      boundByUserId: ULID32_U1,
    };

    describe('createBinding with rbacContext', () => {
      it('academic 路径 + teacher 同校 → 通过', () => {
        const ctx: RecurringRbacContext = {
          callerRole: 'academic',
          currentUserId: ULID32_U1,
          academicCampusId: CAMPUS_X,
          teacherCampusId: CAMPUS_X,
        };
        const b = service.createBinding(baseBindingInput, ctx);
        expect(b.status).toBe('active');
      });

      it('academic 路径 + teacher 跨校 → 403 TEACHER_NOT_IN_ACADEMIC_CAMPUS', () => {
        const ctx: RecurringRbacContext = {
          callerRole: 'academic',
          currentUserId: ULID32_U1,
          academicCampusId: CAMPUS_X,
          teacherCampusId: CAMPUS_Y, // 跨校
        };
        expect(() => service.createBinding(baseBindingInput, ctx)).toThrow(
          ForbiddenException,
        );
        expect(() => service.createBinding(baseBindingInput, ctx)).toThrow(
          /TEACHER_NOT_IN_ACADEMIC_CAMPUS/,
        );
      });

      it('academic 路径 + teacherCampusId 缺失（反查不到老师）→ 403', () => {
        const ctx: RecurringRbacContext = {
          callerRole: 'academic',
          currentUserId: ULID32_U1,
          academicCampusId: CAMPUS_X,
          teacherCampusId: null,
        };
        expect(() => service.createBinding(baseBindingInput, ctx)).toThrow(
          /TEACHER_NOT_IN_ACADEMIC_CAMPUS/,
        );
      });

      it('academic 路径 + academicCampusId 缺失（jwt 篡改）→ 403 ACADEMIC_CAMPUS_REQUIRED', () => {
        const ctx: RecurringRbacContext = {
          callerRole: 'academic',
          currentUserId: ULID32_U1,
          academicCampusId: null,
          teacherCampusId: CAMPUS_X,
        };
        expect(() => service.createBinding(baseBindingInput, ctx)).toThrow(
          /ACADEMIC_CAMPUS_REQUIRED/,
        );
      });

      it('非法 callerRole=sales → 403 ONLY_ACADEMIC_CAN_CREATE_SCHEDULE（service 层兜底）', () => {
        const ctx = {
          callerRole: 'sales',
          currentUserId: ULID32_U1,
          academicCampusId: CAMPUS_X,
        } as unknown as RecurringRbacContext;
        expect(() => service.createBinding(baseBindingInput, ctx)).toThrow(
          /ONLY_ACADEMIC_CAN_CREATE_SCHEDULE/,
        );
      });

      it('非法 callerRole=teacher → 403 ONLY_ACADEMIC（5/12 反向修复）', () => {
        const ctx = {
          callerRole: 'teacher',
          currentUserId: ULID32_U1,
          academicCampusId: CAMPUS_X,
        } as unknown as RecurringRbacContext;
        expect(() => service.createBinding(baseBindingInput, ctx)).toThrow(
          /ONLY_ACADEMIC_CAN_CREATE_SCHEDULE/,
        );
      });

      it('非法 callerRole=admin → 403 ONLY_ACADEMIC', () => {
        const ctx = {
          callerRole: 'admin',
          currentUserId: ULID32_U1,
          academicCampusId: CAMPUS_X,
        } as unknown as RecurringRbacContext;
        expect(() => service.createBinding(baseBindingInput, ctx)).toThrow(
          /ONLY_ACADEMIC_CAN_CREATE_SCHEDULE/,
        );
      });

      it('不传 rbacContext → BadRequestException（A04 修复，删除旧 fixture 模式）', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(() => (service.createBinding as any)(baseBindingInput)).toThrow(
          BadRequestException,
        );
      });
    });

    describe('createRecurring with rbacContext', () => {
      const now = new Date('2026-05-02T00:00:00Z');

      it('academic 路径 + teacher 同校 → 通过（无冲突）', () => {
        const ctx: RecurringRbacContext = {
          callerRole: 'academic',
          currentUserId: ULID32_U1,
          academicCampusId: CAMPUS_X,
          teacherCampusId: CAMPUS_X,
        };
        const r = service.createRecurring(baseInput, 30, [], now, ctx);
        expect(r.status).toBe('active');
        expect(r.createdByRole).toBe('academic');
      });

      it('academic 路径 + teacher 跨校 → 403 TEACHER_NOT_IN_ACADEMIC_CAMPUS', () => {
        const ctx: RecurringRbacContext = {
          callerRole: 'academic',
          currentUserId: ULID32_U1,
          academicCampusId: CAMPUS_X,
          teacherCampusId: CAMPUS_Y,
        };
        expect(() => service.createRecurring(baseInput, 30, [], now, ctx)).toThrow(
          /TEACHER_NOT_IN_ACADEMIC_CAMPUS/,
        );
      });

      it('非法 callerRole=sales → 403 ONLY_ACADEMIC', () => {
        const ctx = {
          callerRole: 'sales',
          currentUserId: ULID32_U1,
          academicCampusId: CAMPUS_X,
        } as unknown as RecurringRbacContext;
        expect(() => service.createRecurring(baseInput, 30, [], now, ctx)).toThrow(
          /ONLY_ACADEMIC_CAN_CREATE_SCHEDULE/,
        );
      });

      it('非法 callerRole=teacher → 403 ONLY_ACADEMIC（5/12 反向修复）', () => {
        const ctx = {
          callerRole: 'teacher',
          currentUserId: ULID32_U1,
          academicCampusId: CAMPUS_X,
        } as unknown as RecurringRbacContext;
        expect(() => service.createRecurring(baseInput, 30, [], now, ctx)).toThrow(
          /ONLY_ACADEMIC_CAN_CREATE_SCHEDULE/,
        );
      });

      it('非法 callerRole=admin → 403 ONLY_ACADEMIC', () => {
        const ctx = {
          callerRole: 'admin',
          currentUserId: ULID32_U1,
          academicCampusId: CAMPUS_X,
        } as unknown as RecurringRbacContext;
        expect(() => service.createRecurring(baseInput, 30, [], now, ctx)).toThrow(
          /ONLY_ACADEMIC_CAN_CREATE_SCHEDULE/,
        );
      });

      it('不传 rbacContext → BadRequestException（A04 修复）', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(() => (service.createRecurring as any)(baseInput, 30, [], now)).toThrow(
          BadRequestException,
        );
      });
    });
  });
});

// ============================================================
// 2026-05-30 #17: listBindingsByStudent 回填 teacherName（LEFT JOIN teachers）
//   service 注入 mock PgPoolService（默认 describe 无 pg，DB 路径单独建）
// ============================================================
describe('RecurringScheduleService.listBindingsByStudent (#17 老师名)', () => {
  let service: RecurringScheduleService;
  let pg: { tenantQuery: jest.Mock };

  const TENANT = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const STUDENT = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMST1';
  const TEACHER = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMTC1';

  beforeEach(async () => {
    pg = { tenantQuery: jest.fn() };
    const m = await Test.createTestingModule({
      providers: [
        RecurringScheduleService,
        { provide: PgPoolService, useValue: pg },
      ],
    }).compile();
    service = m.get<RecurringScheduleService>(RecurringScheduleService);
  });

  it('SQL LEFT JOIN teachers + deleted_at IS NULL + SELECT t.name AS teacher_name', async () => {
    pg.tenantQuery.mockResolvedValueOnce([]);
    await service.listBindingsByStudent(TENANT, STUDENT);
    const [, sql, params] = pg.tenantQuery.mock.calls[0];
    expect(sql).toContain('LEFT JOIN teachers t ON t.id = b.teacher_id');
    expect(sql).toContain('t.deleted_at IS NULL');
    expect(sql).toContain('t.name AS teacher_name');
    // 仍只查 active 绑定 + 按 student 过滤
    expect(sql).toContain(`b.status = 'active'`);
    expect(sql).toContain('b.student_id = $1');
    expect(params).toEqual([STUDENT]);
  });

  it('teacher_name 命中 → 返回 teacherName 真名', async () => {
    pg.tenantQuery.mockResolvedValueOnce([
      {
        id: '01HX7Y6P5K9N3M2QABCDEFGHIJKLBND1',
        student_id: STUDENT,
        teacher_id: TEACHER,
        subject: '数学',
        status: 'active',
        bound_at: '2026-05-30T00:00:00.000Z',
        unbound_at: null,
        bound_by_user_id: '01HX7Y6P5K9N3M2QABCDEFGHIJKLMUS1',
        teacher_name: '王老师',
      },
    ]);
    const rows = await service.listBindingsByStudent(TENANT, STUDENT);
    expect(rows).toHaveLength(1);
    expect(rows[0].teacherName).toBe('王老师');
    expect(rows[0].teacherId).toBe(TEACHER);
  });

  it('teacher 已软删 / 缺失（teacher_name null）→ teacherName undefined（前端 fallback id 前缀）', async () => {
    pg.tenantQuery.mockResolvedValueOnce([
      {
        id: '01HX7Y6P5K9N3M2QABCDEFGHIJKLBND1',
        student_id: STUDENT,
        teacher_id: TEACHER,
        subject: null,
        status: 'active',
        bound_at: '2026-05-30T00:00:00.000Z',
        unbound_at: null,
        bound_by_user_id: '01HX7Y6P5K9N3M2QABCDEFGHIJKLMUS1',
        teacher_name: null,
      },
    ]);
    const rows = await service.listBindingsByStudent(TENANT, STUDENT);
    expect(rows[0].teacherName).toBeUndefined();
    // teacherId 仍返回（前端可用 id 前缀兜底）
    expect(rows[0].teacherId).toBe(TEACHER);
  });

  it('无 pg（未注入）→ 返 []（保持原 fail-safe）', async () => {
    const noPgService = new RecurringScheduleService();
    const rows = await noPgService.listBindingsByStudent(TENANT, STUDENT);
    expect(rows).toEqual([]);
  });
});
