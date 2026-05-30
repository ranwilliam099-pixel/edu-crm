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
import { DashboardRepository, HomeAlertStats } from './dashboard.repository';
import { PromotionEligibilityService } from './promotion-eligibility.service';

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
