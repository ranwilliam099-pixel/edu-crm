import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { KpiController } from './kpi.controller';
import {
  KpiService,
  SignedKpiResult,
  RenewalKpiResult,
  ConsumptionKpiResult,
  StudentActivityKpiResult,
  SalesHomeKpiResult,
  TeacherHomeKpiResult,
  AcademicHomeKpiResult,
} from './kpi.service';
import { AuditLogRepository } from './audit-log.repository';
import { ContentModerationService } from '../security/content-moderation.service';
import { ROLES_METADATA_KEY } from '../../guards/rbac.decorator';
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
    // 2026-05-22 Sprint Y P1: finance home
    getFinanceHomeKpi: jest.Mock;
    // 2026-05-22 Level 3 明细 4 list endpoint
    listSignedContracts: jest.Mock;
    listRenewalContracts: jest.Mock;
    listConsumptionItems: jest.Mock;
    listStudentActivity: jest.Mock;
    // 2026-06-02 SSOT §3.-2 A 课程销量
    getCourseSales: jest.Mock;
    getCourseSalesByPerson: jest.Mock;
    // 2026-06-02 SSOT §3.-2 E 消课数据双维度排名
    getConsumptionRanking: jest.Mock;
  };
  let auditLog: { log: jest.Mock };
  let contentModeration: { enforceStaffText: jest.Mock };

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
      // 2026-05-22 Sprint Y P1: finance-home mock
      getFinanceHomeKpi: jest.fn().mockResolvedValue({
        pendingInvoices: { count: 0 },
        issuedThisMonth: { amount: '0', count: 0 },
        refundsThisMonth: { amount: '0', count: 0 },
        todos: [],
      }),
      // 2026-05-22 Level 3 list endpoint mock
      listSignedContracts: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      listRenewalContracts: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      listConsumptionItems: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      listStudentActivity: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      // 2026-06-02 SSOT §3.-2 A 课程销量 mock
      getCourseSales: jest.fn().mockResolvedValue({ total: 0, items: [] }),
      getCourseSalesByPerson: jest
        .fn()
        .mockResolvedValue({ productName: null, items: [] }),
      // 2026-06-02 SSOT §3.-2 E 消课数据双维度排名 mock
      getConsumptionRanking: jest
        .fn()
        .mockResolvedValue({ teacher: [], academic: [] }),
    };
    auditLog = { log: jest.fn().mockResolvedValue(undefined) };
    contentModeration = {
      enforceStaffText: jest.fn().mockResolvedValue(undefined),
    };
    controller = new KpiController(
      kpi as unknown as KpiService,
      contentModeration as unknown as ContentModerationService,
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
      const ctrlNoAudit = new KpiController(
        kpi as unknown as KpiService,
        contentModeration as unknown as ContentModerationService,
      );
      kpi.getTeacherHomeKpi.mockResolvedValueOnce(teacherHomeFixture());
      const r = await ctrlNoAudit.teacherHomeKpi(
        TENANT_SCHEMA,
        req(jwt('teacher', TEACHER_SUB, CAMPUS_A)),
      );
      expect(r.todayLessons.count).toBe(3);
    });
  });

  // ============================================================
  // GET /db/kpi/sales-home (2026-06-01 Sprint Y: audit 一致性补齐)
  // ============================================================
  describe('salesHomeKpi GET /db/kpi/sales-home', () => {
    const SALES_SUB = 'salesA00000000000000000000000S001';

    function salesHomeFixture(): SalesHomeKpiResult {
      return {
        personalSigned: { amount: '12000', count: 3, rankText: '第 1 / 共 2' },
        customersInProgress: { count: 7 },
        trialRate: { rate: '50', total: 4 },
      };
    }

    it('happy path: sales role + tenantSchema + sub + campusId(JWT) → service 收 userId+campusId', async () => {
      kpi.getSalesHomeKpi.mockResolvedValueOnce(salesHomeFixture());
      const r = await controller.salesHomeKpi(
        TENANT_SCHEMA,
        req(jwt('sales', SALES_SUB, CAMPUS_A)),
      );
      expect(r.personalSigned.count).toBe(3);
      expect(r.trialRate.rate).toBe('50');
      // campusId 必须从 JWT 透传（防 client 伪造 scope）
      expect(kpi.getSalesHomeKpi).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        SALES_SUB,
        CAMPUS_A,
      );
    });

    it('audit_log 写入 kpi.sales_home.read.success（success 路径，与其他 home 一致）', async () => {
      kpi.getSalesHomeKpi.mockResolvedValueOnce(salesHomeFixture());
      await controller.salesHomeKpi(
        TENANT_SCHEMA,
        req(jwt('sales', SALES_SUB, CAMPUS_A)),
      );
      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        expect.objectContaining({
          action: 'kpi.sales_home.read.success',
          actorUserId: SALES_SUB,
          actorRole: 'sales',
          targetType: 'kpi',
          targetId: SALES_SUB,
        }),
      );
    });

    it('缺 tenantSchema → BadRequest + 不调 service + 不写 audit', async () => {
      await expect(
        controller.salesHomeKpi('', req(jwt('sales', SALES_SUB, CAMPUS_A))),
      ).rejects.toThrow(BadRequestException);
      expect(kpi.getSalesHomeKpi).not.toHaveBeenCalled();
      expect(auditLog.log).not.toHaveBeenCalled();
    });

    it('user.sub 缺失 → BadRequest + 不调 service', async () => {
      await expect(
        controller.salesHomeKpi(TENANT_SCHEMA, req(undefined)),
      ).rejects.toThrow(BadRequestException);
      expect(kpi.getSalesHomeKpi).not.toHaveBeenCalled();
    });

    it('campusId 缺失（JWT 无 campusId）→ 透传 null，service 仍调用', async () => {
      kpi.getSalesHomeKpi.mockResolvedValueOnce(salesHomeFixture());
      await controller.salesHomeKpi(
        TENANT_SCHEMA,
        req(jwt('sales_manager', SALES_SUB, null)),
      );
      expect(kpi.getSalesHomeKpi).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        SALES_SUB,
        null,
      );
    });

    it('audit_log 写失败 → 不抛错（fail-open）+ KPI 仍返回', async () => {
      kpi.getSalesHomeKpi.mockResolvedValueOnce(salesHomeFixture());
      auditLog.log.mockRejectedValueOnce(new Error('db down'));
      const r = await controller.salesHomeKpi(
        TENANT_SCHEMA,
        req(jwt('sales', SALES_SUB, CAMPUS_A)),
      );
      expect(r.personalSigned.count).toBe(3);
      expect(auditLog.log).toHaveBeenCalled();
    });

    it('controller 无 auditLog (Optional)：spec 不传 → 仍跑通', async () => {
      const ctrlNoAudit = new KpiController(
        kpi as unknown as KpiService,
        contentModeration as unknown as ContentModerationService,
      );
      kpi.getSalesHomeKpi.mockResolvedValueOnce(salesHomeFixture());
      const r = await ctrlNoAudit.salesHomeKpi(
        TENANT_SCHEMA,
        req(jwt('sales', SALES_SUB, CAMPUS_A)),
      );
      expect(r.personalSigned.count).toBe(3);
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

  // ============================================================
  // POST /db/kpi/set-target (#24 内容安全收口 — note 自由文本)
  // ============================================================
  describe('setMonthlyTarget POST /db/kpi/set-target — #24 content moderation', () => {
    const MONTH = '2026-05';
    // targetUserId 必须 32-char ULID（handler 校验 length === 32）
    const TARGET_USER = 'tgtuser0000000000000000000000U01';

    function setTargetBody(overrides: Record<string, unknown> = {}) {
      return {
        tenantSchema: TENANT_SCHEMA,
        campusId: CAMPUS_A,
        targetRole: 'academic' as const,
        targetUserId: TARGET_USER,
        month: MONTH,
        targetLessons: 80,
        note: '本月冲刺续约',
        ...overrides,
      };
    }

    beforeEach(() => {
      kpi.setMonthlyTarget.mockResolvedValue({ id: 'kpitgt00000000000000000000000T01', updated: false });
    });

    it('happy: boss 下发 → enforceStaffText 以 [note] / action=kpi / targetType=kpi_target / targetId=targetUserId 调用 + 写库', async () => {
      const r = await controller.setMonthlyTarget(
        setTargetBody(),
        req(jwt('boss', BOSS_SUB, CAMPUS_A)),
      );
      expect(r.updated).toBe(false);
      // 内容安全在写库前以 [note] 调用
      expect(contentModeration.enforceStaffText).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        ['本月冲刺续约'],
        expect.objectContaining({
          action: 'kpi',
          targetType: 'kpi_target',
          targetId: TARGET_USER,
        }),
      );
      // 内容安全通过后才写库
      expect(kpi.setMonthlyTarget).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        expect.objectContaining({
          campusId: CAMPUS_A,
          targetRole: 'academic',
          targetUserId: TARGET_USER,
          month: MONTH,
          targetLessons: 80,
          note: '本月冲刺续约',
        }),
      );
    });

    it('happy: admin 下发 + note 省略 → enforceStaffText 以 [undefined] 调用（service 内部跳过微信）', async () => {
      await controller.setMonthlyTarget(
        setTargetBody({ note: undefined, campusId: CAMPUS_B }),
        req(jwt('admin', ADMIN_SUB, null)),
      );
      expect(contentModeration.enforceStaffText).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        [undefined],
        expect.objectContaining({ action: 'kpi', targetType: 'kpi_target' }),
      );
      expect(kpi.setMonthlyTarget).toHaveBeenCalled();
    });

    it('risky note → enforceStaffText 抛 400 → 不写库', async () => {
      contentModeration.enforceStaffText.mockRejectedValueOnce(
        new BadRequestException('content violates content policy'),
      );
      await expect(
        controller.setMonthlyTarget(
          setTargetBody({ note: '违规内容' }),
          req(jwt('boss', BOSS_SUB, CAMPUS_A)),
        ),
      ).rejects.toThrow(BadRequestException);
      // 写库必须未发生（违规内容不落库）
      expect(kpi.setMonthlyTarget).not.toHaveBeenCalled();
    });

    it('内容安全在 RBAC/campus 校验之后：boss 传他校 campusId → 403 且不调 enforceStaffText', async () => {
      await expect(
        controller.setMonthlyTarget(
          setTargetBody({ campusId: CAMPUS_B }),
          req(jwt('boss', BOSS_SUB, CAMPUS_A)),
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(contentModeration.enforceStaffText).not.toHaveBeenCalled();
      expect(kpi.setMonthlyTarget).not.toHaveBeenCalled();
    });

    it('参数校验先行：targetUserId 非 32-char → BadRequest 且不调 enforceStaffText', async () => {
      await expect(
        controller.setMonthlyTarget(
          setTargetBody({ targetUserId: 'short' }),
          req(jwt('boss', BOSS_SUB, CAMPUS_A)),
        ),
      ).rejects.toThrow(/targetUserId/);
      expect(contentModeration.enforceStaffText).not.toHaveBeenCalled();
      expect(kpi.setMonthlyTarget).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // GET /db/kpi/finance-home (Sprint Y P1: 财务自视角 home)
  // ============================================================
  describe('financeHomeKpi GET /db/kpi/finance-home', () => {
    const FINANCE_SUB = 'finance00000000000000000000000F1';

    it('happy path: finance role + sub → service 收 tenantSchema + 返 fixture', async () => {
      kpi.getFinanceHomeKpi.mockResolvedValueOnce({
        pendingInvoices: { count: 3 },
        issuedThisMonth: { amount: '120,000', count: 12 },
        refundsThisMonth: { amount: '8,000', count: 2 },
        todos: [{ id: 'invoice-1', title: '待开发票', meta: '王先生', type: 'invoice_pending' }],
      });
      const r = await controller.financeHomeKpi(
        TENANT_SCHEMA,
        req(jwt('finance', FINANCE_SUB, null)),
      );
      expect(r.pendingInvoices.count).toBe(3);
      expect(r.issuedThisMonth.amount).toBe('120,000');
      expect(r.refundsThisMonth.count).toBe(2);
      expect(r.todos).toHaveLength(1);
      expect(kpi.getFinanceHomeKpi).toHaveBeenCalledWith(TENANT_SCHEMA);
    });

    it('audit_log 写入 kpi.finance_home.read.success', async () => {
      kpi.getFinanceHomeKpi.mockResolvedValueOnce({
        pendingInvoices: { count: 0 },
        issuedThisMonth: { amount: '0', count: 0 },
        refundsThisMonth: { amount: '0', count: 0 },
        todos: [],
      });
      await controller.financeHomeKpi(
        TENANT_SCHEMA,
        req(jwt('finance', FINANCE_SUB, null)),
      );
      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        expect.objectContaining({
          action: 'kpi.finance_home.read.success',
          targetType: 'kpi',
          actorUserId: FINANCE_SUB,
        }),
      );
    });

    it('缺 tenantSchema → BadRequest + 不调 service', async () => {
      await expect(
        controller.financeHomeKpi('', req(jwt('finance', FINANCE_SUB, null))),
      ).rejects.toThrow(/tenantSchema required/);
      expect(kpi.getFinanceHomeKpi).not.toHaveBeenCalled();
      expect(auditLog.log).not.toHaveBeenCalled();
    });

    it('user.sub 缺失 → BadRequest', async () => {
      await expect(
        controller.financeHomeKpi(TENANT_SCHEMA, req(jwt('finance', undefined as any, null))),
      ).rejects.toThrow(/user sub required/);
    });
  });

  // ============================================================
  // Level 3 明细 — 4 list endpoint (2026-05-22 拍板替代 Level 2 分组)
  // ============================================================
  describe('Level 3 list endpoints', () => {
    it('signedItems happy: admin 跨校 (null campusIds) + 默认 limit/offset', async () => {
      kpi.listSignedContracts.mockResolvedValueOnce({
        items: [{ contractId: 'c1', studentName: 'A', totalAmount: 12000 } as any],
        total: 8,
      });
      const r = await controller.signedItems(
        TENANT_SCHEMA,
        req(jwt('admin', ADMIN_SUB, null)),
      );
      expect(r.items).toHaveLength(1);
      expect(r.total).toBe(8);
      expect(kpi.listSignedContracts).toHaveBeenCalledWith(TENANT_SCHEMA, {
        campusIds: null,
        limit: 50,
        offset: 0,
      });
    });

    it('signedItems boss 强制 jwt.campusId', async () => {
      await controller.signedItems(
        TENANT_SCHEMA,
        req(jwt('boss', BOSS_SUB, CAMPUS_A)),
      );
      expect(kpi.listSignedContracts).toHaveBeenCalledWith(TENANT_SCHEMA, {
        campusIds: [CAMPUS_A],
        limit: 50,
        offset: 0,
      });
    });

    it('signedItems boss 他校 → 403', async () => {
      await expect(
        controller.signedItems(
          TENANT_SCHEMA,
          req(jwt('boss', BOSS_SUB, CAMPUS_A)),
          CAMPUS_B,
        ),
      ).rejects.toThrow(/FORBIDDEN_CAMPUS_MISMATCH/);
      expect(kpi.listSignedContracts).not.toHaveBeenCalled();
    });

    it('limit 越界 (300) → clamp 默认 50; limit=20 透传', async () => {
      await controller.signedItems(TENANT_SCHEMA, req(jwt('admin', ADMIN_SUB, null)), undefined, '300');
      expect(kpi.listSignedContracts).toHaveBeenLastCalledWith(TENANT_SCHEMA, expect.objectContaining({ limit: 50 }));
      await controller.signedItems(TENANT_SCHEMA, req(jwt('admin', ADMIN_SUB, null)), undefined, '20');
      expect(kpi.listSignedContracts).toHaveBeenLastCalledWith(TENANT_SCHEMA, expect.objectContaining({ limit: 20 }));
    });

    it('renewalItems happy', async () => {
      await controller.renewalItems(TENANT_SCHEMA, req(jwt('admin', ADMIN_SUB, null)));
      expect(kpi.listRenewalContracts).toHaveBeenCalled();
    });

    it('consumptionItems happy', async () => {
      await controller.consumptionItems(TENANT_SCHEMA, req(jwt('admin', ADMIN_SUB, null)));
      expect(kpi.listConsumptionItems).toHaveBeenCalled();
    });

    it('studentActivityItems happy + activeOnly 透传', async () => {
      await controller.studentActivityItems(
        TENANT_SCHEMA,
        req(jwt('admin', ADMIN_SUB, null)),
        undefined,
        undefined,
        undefined,
        'true',
      );
      expect(kpi.listStudentActivity).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        expect.objectContaining({ activeOnly: true }),
      );
    });

    it('list endpoint 缺 tenantSchema → BadRequest', async () => {
      await expect(
        controller.signedItems('', req(jwt('admin', ADMIN_SUB, null))),
      ).rejects.toThrow(/tenantSchema required/);
    });
  });

  // ============================================================
  // 2026-06-02 SSOT §3.-2 A「课程销量」— POST /db/kpi/course-sales
  // ============================================================
  describe('courseSales POST /db/kpi/course-sales (A-Level2)', () => {
    const PROD_1 = 'prod0000000000000000000000000P01';

    it('happy path admin（本租户单校必有 campusId）→ campusId 从 JWT 透传 service', async () => {
      kpi.getCourseSales.mockResolvedValueOnce({
        total: 8,
        items: [{ courseProductId: PROD_1, productName: '英语 1v1', salesCount: 8 }],
      });
      const r = await controller.courseSales(
        { tenantSchema: TENANT_SCHEMA },
        req(jwt('admin', ADMIN_SUB, CAMPUS_A)),
      );
      expect(r.total).toBe(8);
      expect(r.items[0].salesCount).toBe(8);
      // campusId 一律 JWT（禁信前端）
      expect(kpi.getCourseSales).toHaveBeenCalledWith(TENANT_SCHEMA, CAMPUS_A);
    });

    it('happy path boss → 用自己 JWT campusId', async () => {
      kpi.getCourseSales.mockResolvedValueOnce({ total: 0, items: [] });
      await controller.courseSales(
        { tenantSchema: TENANT_SCHEMA },
        req(jwt('boss', BOSS_SUB, CAMPUS_A)),
      );
      expect(kpi.getCourseSales).toHaveBeenCalledWith(TENANT_SCHEMA, CAMPUS_A);
    });

    it('空结果透传 → { total:0, items:[] }', async () => {
      kpi.getCourseSales.mockResolvedValueOnce({ total: 0, items: [] });
      const r = await controller.courseSales(
        { tenantSchema: TENANT_SCHEMA },
        req(jwt('boss', BOSS_SUB, CAMPUS_A)),
      );
      expect(r).toEqual({ total: 0, items: [] });
    });

    it('campus-scope 403：JWT 无 campusId → ForbiddenException KPI_NO_CAMPUS（不调 service）', async () => {
      await expect(
        controller.courseSales(
          { tenantSchema: TENANT_SCHEMA },
          req(jwt('admin', ADMIN_SUB, null)),
        ),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        controller.courseSales(
          { tenantSchema: TENANT_SCHEMA },
          req(jwt('admin', ADMIN_SUB, null)),
        ),
      ).rejects.toThrow(/KPI_NO_CAMPUS/);
      expect(kpi.getCourseSales).not.toHaveBeenCalled();
    });

    it('缺 tenantSchema → BadRequest + 不调 service', async () => {
      await expect(
        controller.courseSales(
          { tenantSchema: '' },
          req(jwt('admin', ADMIN_SUB, CAMPUS_A)),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(kpi.getCourseSales).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // 2026-06-02 SSOT §3.-2 A「课程销量」— POST /db/kpi/course-sales/by-person
  // ============================================================
  describe('courseSalesByPerson POST /db/kpi/course-sales/by-person (A-Level3)', () => {
    const PROD_1 = 'prod0000000000000000000000000P01';

    it('happy path admin → campusId(JWT) + courseProductId 透传 service（人员维度）', async () => {
      kpi.getCourseSalesByPerson.mockResolvedValueOnce({
        productName: '英语 1v1',
        items: [{ salesUserId: 'sales1', salesName: '李雷', salesCount: 4 }],
      });
      const r = await controller.courseSalesByPerson(
        { tenantSchema: TENANT_SCHEMA, courseProductId: PROD_1 },
        req(jwt('admin', ADMIN_SUB, CAMPUS_A)),
      );
      expect(r.productName).toBe('英语 1v1');
      expect(r.items[0].salesName).toBe('李雷');
      expect(kpi.getCourseSalesByPerson).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        CAMPUS_A,
        PROD_1,
      );
    });

    it('happy path boss → 用自己 JWT campusId', async () => {
      kpi.getCourseSalesByPerson.mockResolvedValueOnce({ productName: null, items: [] });
      await controller.courseSalesByPerson(
        { tenantSchema: TENANT_SCHEMA, courseProductId: PROD_1 },
        req(jwt('boss', BOSS_SUB, CAMPUS_A)),
      );
      expect(kpi.getCourseSalesByPerson).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        CAMPUS_A,
        PROD_1,
      );
    });

    it('campus-scope 403：JWT 无 campusId → ForbiddenException（不调 service）', async () => {
      await expect(
        controller.courseSalesByPerson(
          { tenantSchema: TENANT_SCHEMA, courseProductId: PROD_1 },
          req(jwt('boss', BOSS_SUB, null)),
        ),
      ).rejects.toThrow(/KPI_NO_CAMPUS/);
      expect(kpi.getCourseSalesByPerson).not.toHaveBeenCalled();
    });

    it('courseProductId 非 32-char → BadRequest（先于 campus 校验，不调 service）', async () => {
      await expect(
        controller.courseSalesByPerson(
          { tenantSchema: TENANT_SCHEMA, courseProductId: 'short' },
          req(jwt('admin', ADMIN_SUB, CAMPUS_A)),
        ),
      ).rejects.toThrow(/courseProductId must be 32-char ULID/);
      expect(kpi.getCourseSalesByPerson).not.toHaveBeenCalled();
    });

    it('缺 tenantSchema → BadRequest + 不调 service', async () => {
      await expect(
        controller.courseSalesByPerson(
          { tenantSchema: '', courseProductId: PROD_1 },
          req(jwt('admin', ADMIN_SUB, CAMPUS_A)),
        ),
      ).rejects.toThrow(/tenantSchema required/);
      expect(kpi.getCourseSalesByPerson).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // 2026-06-02 SSOT §3.-2 E「消课数据双维度排名」— POST /db/kpi/consumption-ranking
  // ============================================================
  describe('consumptionRanking POST /db/kpi/consumption-ranking (E)', () => {
    it('happy path teacher 维 + academic 维：双维度透传 + campusId 从 JWT', async () => {
      kpi.getConsumptionRanking.mockResolvedValueOnce({
        teacher: [
          { id: 'tch1', name: '周勇', lessonCount: 12 },
          { id: 'tch2', name: '吴敏', lessonCount: 7 },
        ],
        academic: [{ id: 'acad1', name: '赵丽', lessonCount: 9 }],
      });
      const r = await controller.consumptionRanking(
        { tenantSchema: TENANT_SCHEMA },
        req(jwt('boss', BOSS_SUB, CAMPUS_A)),
      );
      // teacher 维 DESC
      expect(r.teacher).toHaveLength(2);
      expect(r.teacher[0]).toEqual({ id: 'tch1', name: '周勇', lessonCount: 12 });
      expect(r.teacher[1].lessonCount).toBe(7);
      // academic 维
      expect(r.academic).toHaveLength(1);
      expect(r.academic[0].name).toBe('赵丽');
      // campusId 一律 JWT（禁信前端）
      expect(kpi.getConsumptionRanking).toHaveBeenCalledWith(TENANT_SCHEMA, CAMPUS_A);
    });

    it('happy path admin（本租户单校必有 campusId）→ campusId 从 JWT 透传', async () => {
      kpi.getConsumptionRanking.mockResolvedValueOnce({
        teacher: [{ id: 'tch1', name: '周勇', lessonCount: 3 }],
        academic: [],
      });
      await controller.consumptionRanking(
        { tenantSchema: TENANT_SCHEMA },
        req(jwt('admin', ADMIN_SUB, CAMPUS_A)),
      );
      expect(kpi.getConsumptionRanking).toHaveBeenCalledWith(TENANT_SCHEMA, CAMPUS_A);
    });

    it('空结果透传 → { teacher:[], academic:[] }', async () => {
      kpi.getConsumptionRanking.mockResolvedValueOnce({ teacher: [], academic: [] });
      const r = await controller.consumptionRanking(
        { tenantSchema: TENANT_SCHEMA },
        req(jwt('boss', BOSS_SUB, CAMPUS_A)),
      );
      expect(r).toEqual({ teacher: [], academic: [] });
    });

    it('campus-scope 403：JWT 无 campusId → ForbiddenException KPI_NO_CAMPUS（不调 service）', async () => {
      await expect(
        controller.consumptionRanking(
          { tenantSchema: TENANT_SCHEMA },
          req(jwt('boss', BOSS_SUB, null)),
        ),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        controller.consumptionRanking(
          { tenantSchema: TENANT_SCHEMA },
          req(jwt('boss', BOSS_SUB, null)),
        ),
      ).rejects.toThrow(/KPI_NO_CAMPUS/);
      expect(kpi.getConsumptionRanking).not.toHaveBeenCalled();
    });

    it('缺 tenantSchema → BadRequest + 不调 service', async () => {
      await expect(
        controller.consumptionRanking(
          { tenantSchema: '' },
          req(jwt('admin', ADMIN_SUB, CAMPUS_A)),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(kpi.getConsumptionRanking).not.toHaveBeenCalled();
    });

    it('@Roles 元数据 = [admin, boss]（RbacGuard 据此 403 其他角色）', () => {
      const roles = Reflect.getMetadata(
        ROLES_METADATA_KEY,
        KpiController.prototype.consumptionRanking,
      );
      expect(roles).toEqual(['admin', 'boss']);
    });
  });
});
