import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { KpiController } from './kpi.controller';
import {
  KpiService,
  SignedKpiResult,
  RenewalKpiResult,
  ConsumptionKpiResult,
  StudentActivityKpiResult,
} from './kpi.service';
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
  };

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
    };
    controller = new KpiController(kpi as unknown as KpiService);
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
});
