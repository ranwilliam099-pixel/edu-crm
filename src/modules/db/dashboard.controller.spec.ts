/**
 * DashboardController.homeAlerts 单测 — Phase 3 item #4 (2026-05-30)
 *
 * 验证 GET /api/db/dashboards/alerts（b/home attentionStats）：
 *   - @Roles('admin','boss')（控制器装饰器，RbacGuard 实拦由 e2e 覆盖；此处测 handler 逻辑）
 *   - x-tenant-schema header 缺 → 400
 *   - happy path 转交 dashRepo.getHomeAlerts 并透传 { lowBalance, refundPending, handover }
 *   - service 抛错不吞（透传）
 */
import { BadRequestException } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import {
  DashboardRepository,
  HomeAlertStats,
  SalesFunnel,
} from './dashboard.repository';
import { PromotionEligibilityService } from './promotion-eligibility.service';
import { CampusRepository } from './campus.repository';
import { AuthenticatedRequest, JwtPayload, TenantRole } from '../auth/jwt-payload.interface';
import { ROLES_METADATA_KEY } from '../../guards/rbac.decorator';

describe('DashboardController.homeAlerts (Phase 3 item #4)', () => {
  let controller: DashboardController;
  let dashRepo: { getHomeAlerts: jest.Mock };
  let promoEligibility: { detectAndReserve: jest.Mock };

  const SCHEMA = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

  beforeEach(() => {
    dashRepo = { getHomeAlerts: jest.fn() };
    promoEligibility = { detectAndReserve: jest.fn() };
    controller = new DashboardController(
      dashRepo as unknown as DashboardRepository,
      promoEligibility as unknown as PromotionEligibilityService,
    );
  });

  it('x-tenant-schema 缺 → 400', async () => {
    await expect(controller.homeAlerts('')).rejects.toThrow(BadRequestException);
    expect(dashRepo.getHomeAlerts).not.toHaveBeenCalled();
  });

  it('happy path → 转交 getHomeAlerts 并透传 stats', async () => {
    const stats: HomeAlertStats = { lowBalance: 9, refundPending: 4, handover: 2 };
    dashRepo.getHomeAlerts.mockResolvedValueOnce(stats);
    const res = await controller.homeAlerts(SCHEMA);
    expect(dashRepo.getHomeAlerts).toHaveBeenCalledWith(SCHEMA);
    expect(res).toEqual(stats);
  });

  it('service 抛错 → 透传不吞', async () => {
    dashRepo.getHomeAlerts.mockRejectedValueOnce(new Error('boom'));
    await expect(controller.homeAlerts(SCHEMA)).rejects.toThrow('boom');
  });
});

// ============================================================
// 2026-06-02 SSOT §3.-2 D 全局校区筛选（增量 2）— salesFunnel campus override
//   - admin 经 @Query('campusId') 选具体校区 override（校验 ∈ 本租户 campuses）
//   - 非 admin（含 boss / sales）恒用 JWT.campusId（A04 防越权选他校）
//   - sales owner-scope（owner==='me'）与 campus 正交，不变
// ============================================================
describe('DashboardController.salesFunnel (§3.-2 D campus override)', () => {
  let controller: DashboardController;
  let dashRepo: { getSalesFunnel: jest.Mock };
  let promoEligibility: { detectAndReserve: jest.Mock };
  let campusRepo: { findById: jest.Mock };

  const TENANT_A = 'TENANTA00000000000000000000000A1';
  const SCHEMA = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const CAMPUS_A = 'campus_A0000000000000000000000A01';
  const CAMPUS_B = 'campusB00000000000000000000000B1';
  const ADMIN_SUB = 'adminA00000000000000000000000A01';
  const SALES_SUB = 'salesA00000000000000000000000A01';

  function jwt(
    role: TenantRole,
    sub: string,
    campusId: string | null = CAMPUS_A,
  ): JwtPayload {
    return { sub, tenantId: TENANT_A, role, campusId };
  }

  function req(user?: JwtPayload): AuthenticatedRequest {
    return { user, headers: {}, body: {}, query: {}, params: {} };
  }

  function funnelFixture(): SalesFunnel {
    return { stages: [], lostTop: [] } as unknown as SalesFunnel;
  }

  beforeEach(() => {
    dashRepo = { getSalesFunnel: jest.fn().mockResolvedValue(funnelFixture()) };
    promoEligibility = { detectAndReserve: jest.fn() };
    campusRepo = {
      findById: jest.fn().mockImplementation((tenantId: string, id: string) =>
        Promise.resolve(
          tenantId === TENANT_A
            ? { id, tenantId: TENANT_A, name: '分校区', status: 'active' }
            : null,
        ),
      ),
    };
    controller = new DashboardController(
      dashRepo as unknown as DashboardRepository,
      promoEligibility as unknown as PromotionEligibilityService,
      campusRepo as unknown as CampusRepository,
    );
  });

  it('缺 x-tenant-schema → 400', async () => {
    await expect(
      controller.salesFunnel('', req(jwt('admin', ADMIN_SUB))),
    ).rejects.toThrow(BadRequestException);
    expect(dashRepo.getSalesFunnel).not.toHaveBeenCalled();
  });

  it('admin 单校 + 不传 override → 用 JWT.campusId', async () => {
    await controller.salesFunnel(SCHEMA, req(jwt('admin', ADMIN_SUB, CAMPUS_A)));
    expect(dashRepo.getSalesFunnel).toHaveBeenCalledWith(SCHEMA, {
      campusId: CAMPUS_A,
      ownerUserId: undefined,
    });
  });

  it('admin override 单校（∈ 本租户）→ campusId=override（校验 findById 调用）', async () => {
    await controller.salesFunnel(
      SCHEMA,
      req(jwt('admin', ADMIN_SUB, CAMPUS_A)),
      CAMPUS_B,
    );
    expect(campusRepo.findById).toHaveBeenCalledWith(TENANT_A, CAMPUS_B);
    expect(dashRepo.getSalesFunnel).toHaveBeenCalledWith(SCHEMA, {
      campusId: CAMPUS_B,
      ownerUserId: undefined,
    });
  });

  it('admin override 校区不存在（findById null）→ 回退 JWT.campusId', async () => {
    campusRepo.findById.mockResolvedValueOnce(null);
    await controller.salesFunnel(
      SCHEMA,
      req(jwt('admin', ADMIN_SUB, CAMPUS_A)),
      CAMPUS_B,
    );
    expect(dashRepo.getSalesFunnel).toHaveBeenCalledWith(SCHEMA, {
      campusId: CAMPUS_A,
      ownerUserId: undefined,
    });
  });

  it('admin JWT.campusId=null（跨校）+ 无 override → campusId=undefined（全机构兜底）', async () => {
    await controller.salesFunnel(SCHEMA, req(jwt('admin', ADMIN_SUB, null)));
    expect(dashRepo.getSalesFunnel).toHaveBeenCalledWith(SCHEMA, {
      campusId: undefined,
      ownerUserId: undefined,
    });
  });

  it('非 admin（sales）owner=me 传 override → 忽略 override 恒 JWT.campusId（owner-scope 不变）', async () => {
    await controller.salesFunnel(
      SCHEMA,
      req(jwt('sales', SALES_SUB, CAMPUS_A)),
      CAMPUS_B, // sales 传他校 campusId
      'me',
    );
    expect(campusRepo.findById).not.toHaveBeenCalled();
    expect(dashRepo.getSalesFunnel).toHaveBeenCalledWith(SCHEMA, {
      campusId: CAMPUS_A,
      ownerUserId: SALES_SUB,
    });
  });

  it('boss 传 override → 忽略 override 恒 JWT.campusId（锁本校）', async () => {
    await controller.salesFunnel(
      SCHEMA,
      req(jwt('boss', ADMIN_SUB, CAMPUS_A)),
      CAMPUS_B,
    );
    expect(campusRepo.findById).not.toHaveBeenCalled();
    expect(dashRepo.getSalesFunnel).toHaveBeenCalledWith(SCHEMA, {
      campusId: CAMPUS_A,
      ownerUserId: undefined,
    });
  });

  // 2026-06-02 安全审 FINDING-1：salesFunnel 补 @Roles（原无 → 任意租户 JWT 可读漏斗，中危 A01）
  it('@Roles = [admin, boss, sales, sales_manager]（teacher/finance/parent 拒）', () => {
    const roles = Reflect.getMetadata(ROLES_METADATA_KEY, DashboardController.prototype.salesFunnel);
    expect(roles).toEqual(['admin', 'boss', 'sales', 'sales_manager']);
  });
});
