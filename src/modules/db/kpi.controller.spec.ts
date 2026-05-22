import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { KpiController } from './kpi.controller';
import {
  KpiService,
  SignedKpiResult,
  RenewalKpiResult,
  ConsumptionKpiResult,
  StudentActivityKpiResult,
  TeacherHomeKpiResult,
  AcademicHomeKpiResult,
} from './kpi.service';
import { AuditLogRepository } from './audit-log.repository';
import {
  AuthenticatedRequest,
  JwtPayload,
  TenantRole,
} from '../auth/jwt-payload.interface';

describe('KpiController (P4-X 2026-05-20)', () => {
  let controller: KpiController;
  let kpi: {
    getSignedKpi: jest.Mock;
    getRenewalKpi: jest.Mock;
    getConsumptionKpi: jest.Mock;
    getStudentActivityKpi: jest.Mock;
    getSalesHomeKpi: jest.Mock;
    getTeacherHomeKpi: jest.Mock;
    getAcademicHomeKpi: jest.Mock;
    // 2026-05-22 SSOT §6.8 KPI 4 字段
    getMonthlyKpiSummary: jest.Mock;
    setMonthlyTarget: jest.Mock;
    getMonthlyRenewalAmount: jest.Mock;
    // 2026-05-22 Sprint Y: list targets
    listTargets: jest.Mock;
  };
  let auditLog: { log: jest.Mock };

  const TENANT_A = 'TENANTA00000000000000000000000A1';
  const TENANT_SCHEMA = 'tenant_tenanta00000000000000000000000a1';
  const CAMPUS_A = 'campus0000000000000000000000A001';
  const CAMPUS_B = 'campus0000000000000000000000B002';
  const ADMIN_SUB = 'adminA00000000000000000000000A001';
  const BOSS_SUB = 'boss0000000000000000000000000B001';

  function jwt(
    role: TenantRole,
    sub: string,
    campusId: string | null = CAMPUS_A,
  ): JwtPayload {
    return { sub, tenantId: TENANT_A, role, campusId };
  }

  function req(user?: JwtPayload): AuthenticatedRequest {
    return {
      user,
      headers: {},
      body: {},
      query: {},
      params: {},
      ip: '1.2.3.4',
    } as AuthenticatedRequest;
  }

  function signedFixture(overrides: Partial<SignedKpiResult> = {}): SignedKpiResult {
    return {
      total: { amount: '128,560', count: 9 },
      sales: [
        {
          userId: 'sales1',
          name: '张三',
          amountText: '¥48,200',
          amountYuanRaw: 48200,
          count: 3,
          rankText: '第 1',
        },
      ],
      academic: [
        {
          userId: 'acad1',
          name: '王教务',
          amountText: '¥50,360',
          amountYuanRaw: 50360,
          count: 4,
          rankText: '第 1',
        },
      ],
      ...overrides,
    };
  }

  function renewalFixture(): RenewalKpiResult {
    return {
      total: { amount: '80,000', count: 7 },
      sales: [],
      academic: [
        {
          userId: 'acad1',
          name: '王教务',
          amountText: '¥60,000',
          amountYuanRaw: 60000,
          count: 5,
          rankText: '第 1',
        },
      ],
    };
  }

  function consumptionFixture(): ConsumptionKpiResult {
    return {
      total: { hours: 65.5, lessons: 50 },
      academic: [
        {
          userId: 'acad1',
          name: '王教务',
          hoursText: '40.5',
          hoursRaw: 40.5,
          lessonsCount: 30,
          rankText: '第 1',
        },
      ],
    };
  }

  function activityFixture(): StudentActivityKpiResult {
    return {
      total: { activeStudents: 55, totalStudents: 80, activityRate: '68.8%' },
      campusBreakdown: [
        {
          campusId: CAMPUS_A,
          campusName: '总部校区',
          activeCount: 40,
          totalCount: 50,
          rate: '80%',
        },
      ],
    };
  }

  beforeEach(() => {
    kpi = {
      getSignedKpi: jest.fn(),
      getRenewalKpi: jest.fn(),
      getConsumptionKpi: jest.fn(),
      getStudentActivityKpi: jest.fn(),
      getSalesHomeKpi: jest.fn(),
      getTeacherHomeKpi: jest.fn(),
      getAcademicHomeKpi: jest.fn(),
      // 2026-05-22 SSOT §6.8 KPI 4 字段 mock (默认返 0)
      getMonthlyKpiSummary: jest.fn().mockResolvedValue({
        target: 0, scheduled: 0, attended: 0, forecast: 0,
      }),
      setMonthlyTarget: jest.fn(),
      // 2026-05-22 用户拍板: academic 4 卡续约金额 mock
      getMonthlyRenewalAmount: jest.fn().mockResolvedValue(0),
      // 2026-05-22 Sprint Y: list-targets endpoint mock
      listTargets: jest.fn().mockResolvedValue([]),
    };
    auditLog = { log: jest.fn().mockResolvedValue(undefined) };
    controller = new KpiController(
      kpi as unknown as KpiService,
      auditLog as unknown as AuditLogRepository,
    );
  });

  // ============================================================
  // GET /db/kpi/signed
  // ============================================================
  describe('signedKpi GET /db/kpi/signed', () => {
    it('happy path admin: 不传 campusId → service campusIds=null', async () => {
      kpi.getSignedKpi.mockResolvedValueOnce(signedFixture());
      const r = await controller.signedKpi(
        TENANT_SCHEMA,
        req(jwt('admin', ADMIN_SUB, null)),
      );
      expect(r.total.amount).toBe('128,560');
      expect(kpi.getSignedKpi).toHaveBeenCalledWith(TENANT_SCHEMA, {
        campusIds: null,
      });
    });

    it('happy path admin: campusId csv → service 收 [A,B]', async () => {
      kpi.getSignedKpi.mockResolvedValueOnce(signedFixture());
      await controller.signedKpi(
        TENANT_SCHEMA,
        req(jwt('admin', ADMIN_SUB, null)),
        `${CAMPUS_A},${CAMPUS_B}`,
      );
      expect(kpi.getSignedKpi).toHaveBeenCalledWith(TENANT_SCHEMA, {
        campusIds: [CAMPUS_A, CAMPUS_B],
      });
    });

    it('happy path boss: 不传 campusId → service 强制 = [jwt.campusId]', async () => {
      kpi.getSignedKpi.mockResolvedValueOnce(signedFixture());
      await controller.signedKpi(
        TENANT_SCHEMA,
        req(jwt('boss', BOSS_SUB, CAMPUS_A)),
      );
      expect(kpi.getSignedKpi).toHaveBeenCalledWith(TENANT_SCHEMA, {
        campusIds: [CAMPUS_A],
      });
    });

    it('boss campusId 传同值 → 允许 + service 收 [jwt.campusId]', async () => {
      kpi.getSignedKpi.mockResolvedValueOnce(signedFixture());
      await controller.signedKpi(
        TENANT_SCHEMA,
        req(jwt('boss', BOSS_SUB, CAMPUS_A)),
        CAMPUS_A,
      );
      expect(kpi.getSignedKpi).toHaveBeenCalledWith(TENANT_SCHEMA, {
        campusIds: [CAMPUS_A],
      });
    });

    it('boss campusId 传他校 → ForbiddenException FORBIDDEN_CAMPUS_MISMATCH', async () => {
      await expect(
        controller.signedKpi(
          TENANT_SCHEMA,
          req(jwt('boss', BOSS_SUB, CAMPUS_A)),
          CAMPUS_B,
        ),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        controller.signedKpi(
          TENANT_SCHEMA,
          req(jwt('boss', BOSS_SUB, CAMPUS_A)),
          CAMPUS_B,
        ),
      ).rejects.toThrow(/FORBIDDEN_CAMPUS_MISMATCH/);
      expect(kpi.getSignedKpi).not.toHaveBeenCalled();
    });

    it('boss campusId 混合自校 + 他校 → 拒（他校字符串 trigger 403）', async () => {
      await expect(
        controller.signedKpi(
          TENANT_SCHEMA,
          req(jwt('boss', BOSS_SUB, CAMPUS_A)),
          `${CAMPUS_A},${CAMPUS_B}`,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('boss jwt.campusId=null → ForbiddenException BOSS_MISSING_CAMPUS_ID', async () => {
      await expect(
        controller.signedKpi(
          TENANT_SCHEMA,
          req(jwt('boss', BOSS_SUB, null)),
        ),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        controller.signedKpi(
          TENANT_SCHEMA,
          req(jwt('boss', BOSS_SUB, null)),
        ),
      ).rejects.toThrow(/BOSS_MISSING_CAMPUS_ID/);
    });

    it('缺 tenantSchema → BadRequest', async () => {
      await expect(
        controller.signedKpi('', req(jwt('admin', ADMIN_SUB, null))),
      ).rejects.toThrow(BadRequestException);
      expect(kpi.getSignedKpi).not.toHaveBeenCalled();
    });

    it('其他 role 通过 service（兜底空 []）— RBAC 由 RbacGuard 拦截，本测试模拟绕过', async () => {
      kpi.getSignedKpi.mockResolvedValueOnce(signedFixture());
      await controller.signedKpi(
        TENANT_SCHEMA,
        req(jwt('sales' as TenantRole, ADMIN_SUB, CAMPUS_A)),
      );
      // sales/teacher/etc 直接走 fallback path 返 []，service.campusIds=[]
      expect(kpi.getSignedKpi).toHaveBeenCalledWith(TENANT_SCHEMA, {
        campusIds: [],
      });
    });

    it('admin campusId csv 含空白条目 → trim 过滤', async () => {
      kpi.getSignedKpi.mockResolvedValueOnce(signedFixture());
      await controller.signedKpi(
        TENANT_SCHEMA,
        req(jwt('admin', ADMIN_SUB, null)),
        ` ${CAMPUS_A} , , ${CAMPUS_B} `,
      );
      expect(kpi.getSignedKpi).toHaveBeenCalledWith(TENANT_SCHEMA, {
        campusIds: [CAMPUS_A, CAMPUS_B],
      });
    });

    it('admin campusId 空字符串 → null', async () => {
      kpi.getSignedKpi.mockResolvedValueOnce(signedFixture());
      await controller.signedKpi(
        TENANT_SCHEMA,
        req(jwt('admin', ADMIN_SUB, null)),
        '',
      );
      expect(kpi.getSignedKpi).toHaveBeenCalledWith(TENANT_SCHEMA, {
        campusIds: null,
      });
    });
  });

  // ============================================================
  // GET /db/kpi/renewal
  // ============================================================
  describe('renewalKpi GET /db/kpi/renewal', () => {
    it('happy path admin → service 收 campusIds=null + 返 fixture', async () => {
      kpi.getRenewalKpi.mockResolvedValueOnce(renewalFixture());
      const r = await controller.renewalKpi(
        TENANT_SCHEMA,
        req(jwt('admin', ADMIN_SUB, null)),
      );
      expect(r.academic).toHaveLength(1);
      expect(r.academic[0].amountText).toBe('¥60,000');
      expect(kpi.getRenewalKpi).toHaveBeenCalledWith(TENANT_SCHEMA, {
        campusIds: null,
      });
    });

    it('boss → service 收 campusIds=[jwt.campusId]', async () => {
      kpi.getRenewalKpi.mockResolvedValueOnce(renewalFixture());
      await controller.renewalKpi(
        TENANT_SCHEMA,
        req(jwt('boss', BOSS_SUB, CAMPUS_A)),
      );
      expect(kpi.getRenewalKpi).toHaveBeenCalledWith(TENANT_SCHEMA, {
        campusIds: [CAMPUS_A],
      });
    });

    it('boss 传他校 campusId → ForbiddenException', async () => {
      await expect(
        controller.renewalKpi(
          TENANT_SCHEMA,
          req(jwt('boss', BOSS_SUB, CAMPUS_A)),
          CAMPUS_B,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('缺 tenantSchema → BadRequest', async () => {
      await expect(
        controller.renewalKpi('', req(jwt('admin', ADMIN_SUB, null))),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ============================================================
  // GET /db/kpi/consumption
  // ============================================================
  describe('consumptionKpi GET /db/kpi/consumption', () => {
    it('happy path admin → 返 fixture', async () => {
      kpi.getConsumptionKpi.mockResolvedValueOnce(consumptionFixture());
      const r = await controller.consumptionKpi(
        TENANT_SCHEMA,
        req(jwt('admin', ADMIN_SUB, null)),
      );
      expect(r.total.hours).toBe(65.5);
      expect(r.academic).toHaveLength(1);
      expect(kpi.getConsumptionKpi).toHaveBeenCalledWith(TENANT_SCHEMA, {
        campusIds: null,
      });
    });

    it('boss → service 收 [jwt.campusId]', async () => {
      kpi.getConsumptionKpi.mockResolvedValueOnce(consumptionFixture());
      await controller.consumptionKpi(
        TENANT_SCHEMA,
        req(jwt('boss', BOSS_SUB, CAMPUS_A)),
      );
      expect(kpi.getConsumptionKpi).toHaveBeenCalledWith(TENANT_SCHEMA, {
        campusIds: [CAMPUS_A],
      });
    });

    it('boss 他校 campusId → 403', async () => {
      await expect(
        controller.consumptionKpi(
          TENANT_SCHEMA,
          req(jwt('boss', BOSS_SUB, CAMPUS_A)),
          CAMPUS_B,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('缺 tenantSchema → BadRequest', async () => {
      await expect(
        controller.consumptionKpi('', req(jwt('admin', ADMIN_SUB, null))),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ============================================================
  // GET /db/kpi/student-activity
  // ============================================================
  describe('studentActivityKpi GET /db/kpi/student-activity', () => {
    it('happy path admin → activityRate + campusBreakdown', async () => {
      kpi.getStudentActivityKpi.mockResolvedValueOnce(activityFixture());
      const r = await controller.studentActivityKpi(
        TENANT_SCHEMA,
        req(jwt('admin', ADMIN_SUB, null)),
      );
      expect(r.total.activityRate).toBe('68.8%');
      expect(r.campusBreakdown).toHaveLength(1);
      expect(r.campusBreakdown[0].rate).toBe('80%');
      expect(kpi.getStudentActivityKpi).toHaveBeenCalledWith(TENANT_SCHEMA, {
        campusIds: null,
      });
    });

    it('boss → service 收 [jwt.campusId]', async () => {
      kpi.getStudentActivityKpi.mockResolvedValueOnce(activityFixture());
      await controller.studentActivityKpi(
        TENANT_SCHEMA,
        req(jwt('boss', BOSS_SUB, CAMPUS_A)),
      );
      expect(kpi.getStudentActivityKpi).toHaveBeenCalledWith(TENANT_SCHEMA, {
        campusIds: [CAMPUS_A],
      });
    });

    it('boss 他校 campusId → 403', async () => {
      await expect(
        controller.studentActivityKpi(
          TENANT_SCHEMA,
          req(jwt('boss', BOSS_SUB, CAMPUS_A)),
          CAMPUS_B,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('缺 tenantSchema → BadRequest', async () => {
      await expect(
        controller.studentActivityKpi('', req(jwt('admin', ADMIN_SUB, null))),
      ).rejects.toThrow(BadRequestException);
    });

    it('admin csv 含 single campusId → 透传', async () => {
      kpi.getStudentActivityKpi.mockResolvedValueOnce(activityFixture());
      await controller.studentActivityKpi(
        TENANT_SCHEMA,
        req(jwt('admin', ADMIN_SUB, null)),
        CAMPUS_A,
      );
      expect(kpi.getStudentActivityKpi).toHaveBeenCalledWith(TENANT_SCHEMA, {
        campusIds: [CAMPUS_A],
      });
    });
  });

  // ============================================================
  // 跨 endpoint 共性：resolveCampusScope edge cases
  // ============================================================
  describe('resolveCampusScope edge cases (跨 4 endpoint)', () => {
    it('admin role + campusId=undefined → null', async () => {
      kpi.getSignedKpi.mockResolvedValueOnce(signedFixture());
      await controller.signedKpi(
        TENANT_SCHEMA,
        req(jwt('admin', ADMIN_SUB, null)),
        undefined,
      );
      expect(kpi.getSignedKpi).toHaveBeenCalledWith(TENANT_SCHEMA, {
        campusIds: null,
      });
    });

    it('admin role + campusId=" " (空白) → null', async () => {
      kpi.getSignedKpi.mockResolvedValueOnce(signedFixture());
      await controller.signedKpi(
        TENANT_SCHEMA,
        req(jwt('admin', ADMIN_SUB, null)),
        '   ',
      );
      expect(kpi.getSignedKpi).toHaveBeenCalledWith(TENANT_SCHEMA, {
        campusIds: null,
      });
    });

    it('req.user 缺失 → role=undefined fallback path 返 []（不会到 service）', async () => {
      // controller 不抛 401（由 framework middleware 处理），仅 sales/teacher fallback
      kpi.getSignedKpi.mockResolvedValueOnce(signedFixture());
      const noUserReq = req(undefined);
      await controller.signedKpi(TENANT_SCHEMA, noUserReq);
      expect(kpi.getSignedKpi).toHaveBeenCalledWith(TENANT_SCHEMA, {
        campusIds: [],
      });
    });
  });

  // ============================================================
  // 2026-05-22 Sprint Y — GET /db/kpi/teacher-home
  // ============================================================
  describe('teacherHomeKpi GET /db/kpi/teacher-home (Sprint Y)', () => {
    const TEACHER_SUB = 'teacher000000000000000000000T001';

    function teacherHomeFixture(): TeacherHomeKpiResult {
      return {
        todayLessons: { count: 3, lastLessonAgoMin: 60 },
        primaryStudents: { count: 12, pendingFeedback: 2 },
        monthlyReferrals: { count: 4 },
        monthlyAttendance: { taught: 28, leave: 2, swap: 1 },
        todos: [
          {
            id: 'lesson-S001',
            title: '今日待上课',
            meta: '',
            time: new Date().toISOString(),
            type: 'today_lesson',
          },
        ],
      };
    }

    it('happy path: teacher role + tenantSchema + sub → service 收 userId + 返 fixture', async () => {
      kpi.getTeacherHomeKpi.mockResolvedValueOnce(teacherHomeFixture());
      const r = await controller.teacherHomeKpi(
        TENANT_SCHEMA,
        req(jwt('teacher', TEACHER_SUB, CAMPUS_A)),
      );
      expect(r.todayLessons.count).toBe(3);
      expect(r.primaryStudents.count).toBe(12);
      expect(r.monthlyAttendance.taught).toBe(28);
      expect(r.todos).toHaveLength(1);
      expect(kpi.getTeacherHomeKpi).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        TEACHER_SUB,
      );
    });

    it('audit_log 写入 kpi.teacher_home.read.success（success 路径）', async () => {
      kpi.getTeacherHomeKpi.mockResolvedValueOnce(teacherHomeFixture());
      await controller.teacherHomeKpi(
        TENANT_SCHEMA,
        req(jwt('teacher', TEACHER_SUB, CAMPUS_A)),
      );
      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        expect.objectContaining({
          action: 'kpi.teacher_home.read.success',
          actorUserId: TEACHER_SUB,
          actorRole: 'teacher',
          targetType: 'kpi',
          targetId: TEACHER_SUB,
        }),
      );
    });

    it('缺 tenantSchema → BadRequest + 不调 service + 不写 audit', async () => {
      await expect(
        controller.teacherHomeKpi('', req(jwt('teacher', TEACHER_SUB, CAMPUS_A))),
      ).rejects.toThrow(BadRequestException);
      expect(kpi.getTeacherHomeKpi).not.toHaveBeenCalled();
      expect(auditLog.log).not.toHaveBeenCalled();
    });

    it('user.sub 缺失 → BadRequest', async () => {
      await expect(
        controller.teacherHomeKpi(TENANT_SCHEMA, req(undefined)),
      ).rejects.toThrow(BadRequestException);
      expect(kpi.getTeacherHomeKpi).not.toHaveBeenCalled();
    });

    it('空数据 fallback：service 返全 0 → controller 透传 + audit 仍写 success', async () => {
      const emptyResult: TeacherHomeKpiResult = {
        todayLessons: { count: 0, lastLessonAgoMin: 0 },
        primaryStudents: { count: 0, pendingFeedback: 0 },
        monthlyReferrals: { count: 0 },
        monthlyAttendance: { taught: 0, leave: 0, swap: 0 },
        todos: [],
      };
      kpi.getTeacherHomeKpi.mockResolvedValueOnce(emptyResult);
      const r = await controller.teacherHomeKpi(
        TENANT_SCHEMA,
        req(jwt('teacher', TEACHER_SUB, CAMPUS_A)),
      );
      expect(r.todayLessons.count).toBe(0);
      expect(r.todos).toEqual([]);
      // audit 仍写：success 是 endpoint-level，与 service 数据无关
      expect(auditLog.log).toHaveBeenCalledTimes(1);
    });

    it('audit_log 写失败 → 不抛错（fail-open）+ KPI 仍返回', async () => {
      kpi.getTeacherHomeKpi.mockResolvedValueOnce(teacherHomeFixture());
      auditLog.log.mockRejectedValueOnce(new Error('db down'));
      // 不应该 throw
      const r = await controller.teacherHomeKpi(
        TENANT_SCHEMA,
        req(jwt('teacher', TEACHER_SUB, CAMPUS_A)),
      );
      expect(r.todayLessons.count).toBe(3);
      expect(auditLog.log).toHaveBeenCalled();
    });

    it('controller 无 auditLog (Optional)：spec 不传 → 仍跑通', async () => {
      const ctrlNoAudit = new KpiController(kpi as unknown as KpiService);
      kpi.getTeacherHomeKpi.mockResolvedValueOnce(teacherHomeFixture());
      const r = await ctrlNoAudit.teacherHomeKpi(
        TENANT_SCHEMA,
        req(jwt('teacher', TEACHER_SUB, CAMPUS_A)),
      );
      expect(r.todayLessons.count).toBe(3);
    });
  });

  // ============================================================
  // GET /db/kpi/targets (Sprint Y P0: 校长 page 入口)
  // ============================================================
  describe('listTargets GET /db/kpi/targets', () => {
    const MONTH = '2026-05';

    it('happy path boss: campusId = jwt.campusId → 透传 service', async () => {
      kpi.listTargets.mockResolvedValueOnce([
        { targetUserId: 'u1', targetRole: 'academic', targetLessons: 80, note: null, setAt: '2026-05-22' },
      ]);
      const r = await controller.listTargets(
        TENANT_SCHEMA,
        CAMPUS_A,
        MONTH,
        req(jwt('boss', BOSS_SUB, CAMPUS_A)),
      );
      expect(r.items).toHaveLength(1);
      expect(r.items[0].targetLessons).toBe(80);
      expect(kpi.listTargets).toHaveBeenCalledWith(TENANT_SCHEMA, CAMPUS_A, MONTH);
    });

    it('happy path admin: 任意 campusId 都允许', async () => {
      kpi.listTargets.mockResolvedValueOnce([]);
      const r = await controller.listTargets(
        TENANT_SCHEMA,
        CAMPUS_B,
        MONTH,
        req(jwt('admin', ADMIN_SUB, null)),
      );
      expect(r.items).toEqual([]);
      expect(kpi.listTargets).toHaveBeenCalledWith(TENANT_SCHEMA, CAMPUS_B, MONTH);
    });

    it('boss 查他校 campusId → 403 ForbiddenException', async () => {
      await expect(
        controller.listTargets(
          TENANT_SCHEMA,
          CAMPUS_B,
          MONTH,
          req(jwt('boss', BOSS_SUB, CAMPUS_A)),
        ),
      ).rejects.toThrow(/BOSS_CROSS_CAMPUS_DENIED/);
      expect(kpi.listTargets).not.toHaveBeenCalled();
    });

    it('缺 tenantSchema → BadRequest', async () => {
      await expect(
        controller.listTargets('', CAMPUS_A, MONTH, req(jwt('boss', BOSS_SUB, CAMPUS_A))),
      ).rejects.toThrow(/tenantSchema required/);
    });

    it('缺 campusId → BadRequest', async () => {
      await expect(
        controller.listTargets(TENANT_SCHEMA, '', MONTH, req(jwt('boss', BOSS_SUB, CAMPUS_A))),
      ).rejects.toThrow(/campusId required/);
    });

    it("month 不是 'YYYY-MM' → BadRequest", async () => {
      await expect(
        controller.listTargets(TENANT_SCHEMA, CAMPUS_A, '2026/05', req(jwt('boss', BOSS_SUB, CAMPUS_A))),
      ).rejects.toThrow(/'YYYY-MM'/);
      await expect(
        controller.listTargets(TENANT_SCHEMA, CAMPUS_A, '', req(jwt('boss', BOSS_SUB, CAMPUS_A))),
      ).rejects.toThrow(/'YYYY-MM'/);
    });
  });
});
