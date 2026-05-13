/**
 * OnboardingController — Sprint E.x F-08 server-side msgSecCheck 集成单测
 *
 * 范围（F-08）：
 *   - provisionTenant: 自由文本字段（name / campus.name / campus.address / campus.courseLines）
 *     全部走 SecurityService.serverSideCheckContent
 *   - 任一字段命中 87014 risky → BadRequest CONTENT_RISKY，不进 provision.provisionTenant
 *   - review / 网络异常 → fail-open，注册继续
 *   - 不返微信内部 errcode（A05 内部 ID 暴露规避）
 */
import { BadRequestException } from '@nestjs/common';
import { OnboardingController } from './onboarding.controller';
import { TenantProvisionService } from './tenant-provision.service';
import { PgPoolService } from './pg-pool.service';
import { SecurityService } from '../security/security.service';

describe('OnboardingController (Sprint E.x F-08 msgSecCheck)', () => {
  let controller: OnboardingController;
  let provision: { provisionTenant: jest.Mock; listTenants: jest.Mock; deleteTenant: jest.Mock };
  let pg: { ping: jest.Mock };
  let security: { serverSideCheckContent: jest.Mock };

  const VALID_TENANT_ID = 'tenantE0000000000000000000000F08';
  const VALID_CAMPUS_ID = 'campusE0000000000000000000000F08';

  function makeBody(overrides: Partial<Parameters<OnboardingController['provisionTenant']>[0]> = {}) {
    return {
      tenantId: VALID_TENANT_ID,
      name: '阳光教育培训中心',
      sku: 'standard_1999' as const,
      campuses: [
        {
          id: VALID_CAMPUS_ID,
          name: '主校区',
          address: '北京市朝阳区某路 100 号',
          courseLines: '语文,数学,英语',
        },
      ],
      ...overrides,
    };
  }

  beforeEach(() => {
    provision = {
      provisionTenant: jest.fn().mockResolvedValue({
        tenantId: VALID_TENANT_ID,
        tenantSchema: `tenant_${VALID_TENANT_ID.toLowerCase()}`,
        ranMigrations: ['V2', 'V4'],
        campusIds: [VALID_CAMPUS_ID],
      }),
      listTenants: jest.fn(),
      deleteTenant: jest.fn(),
    };
    pg = { ping: jest.fn() };
    security = {
      // 默认所有 check 通过
      serverSideCheckContent: jest.fn().mockResolvedValue({
        ok: true,
        suggest: 'pass',
        errcode: 0,
      }),
    };

    controller = new OnboardingController(
      provision as unknown as TenantProvisionService,
      pg as unknown as PgPoolService,
      security as unknown as SecurityService,
    );
  });

  describe('provisionTenant 自由文本预检', () => {
    it('happy path 全部通过 → 调 provision 并返回结果', async () => {
      const body = makeBody();
      const res = await controller.provisionTenant(body);

      // 4 个文本字段全部 check（name + 1 campus.name + 1 address + 1 courseLines）
      expect(security.serverSideCheckContent).toHaveBeenCalledTimes(4);
      expect(security.serverSideCheckContent).toHaveBeenNthCalledWith(1, '阳光教育培训中心');
      expect(security.serverSideCheckContent).toHaveBeenNthCalledWith(2, '主校区');
      expect(security.serverSideCheckContent).toHaveBeenNthCalledWith(3, '北京市朝阳区某路 100 号');
      expect(security.serverSideCheckContent).toHaveBeenNthCalledWith(4, '语文,数学,英语');

      expect(provision.provisionTenant).toHaveBeenCalledWith(body);
      expect(res.tenantId).toBe(VALID_TENANT_ID);
    });

    it('body.name 违规 87014 → 400 CONTENT_RISKY，不进 provision', async () => {
      // 所有 4 个字段 check：mockResolvedValue（非 Once）让所有调用都返 risky
      // 由于 name 是第 1 个 check 字段，risky 抛错后短路，后续不再 check
      security.serverSideCheckContent.mockResolvedValueOnce({
        ok: false,
        suggest: 'risky',
        label: '内容含违法违规',
        errcode: 87014,
      });

      const body = makeBody({ name: '违规机构名示例' });

      let caught: BadRequestException | undefined;
      try {
        await controller.provisionTenant(body);
      } catch (err) {
        caught = err as BadRequestException;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      expect(caught?.getResponse()).toMatchObject({
        code: 'CONTENT_RISKY',
        suggest: 'risky',
      });
      // A05: 不返微信内部 errcode 给 client
      const response = caught?.getResponse() as { errcode?: number };
      expect(response.errcode).toBeUndefined();
      expect(provision.provisionTenant).not.toHaveBeenCalled();
    });

    it('campus.address 违规 → 400 CONTENT_RISKY，不进 provision', async () => {
      // 1: name pass, 2: campus.name pass, 3: campus.address risky
      security.serverSideCheckContent
        .mockResolvedValueOnce({ ok: true, suggest: 'pass' })
        .mockResolvedValueOnce({ ok: true, suggest: 'pass' })
        .mockResolvedValueOnce({
          ok: false,
          suggest: 'risky',
          label: '内容含违法违规',
          errcode: 87014,
        });

      const body = makeBody({
        campuses: [
          { id: VALID_CAMPUS_ID, name: '主校区', address: '违规地址' },
        ],
      });
      await expect(controller.provisionTenant(body)).rejects.toThrow(BadRequestException);
      expect(provision.provisionTenant).not.toHaveBeenCalled();
    });

    it('campus.name 违规 → 400 CONTENT_RISKY', async () => {
      // 1: name pass, 2: campus.name risky
      security.serverSideCheckContent
        .mockResolvedValueOnce({ ok: true, suggest: 'pass' })
        .mockResolvedValueOnce({
          ok: false,
          suggest: 'risky',
          errcode: 87014,
        });

      const body = makeBody({
        campuses: [{ id: VALID_CAMPUS_ID, name: '违规校区名' }],
      });
      await expect(controller.provisionTenant(body)).rejects.toThrow(BadRequestException);
      expect(provision.provisionTenant).not.toHaveBeenCalled();
    });

    it('suggest=review → fail-open，继续 provision', async () => {
      security.serverSideCheckContent.mockResolvedValue({
        ok: false,
        suggest: 'review',
        errcode: 40001,
      });

      const body = makeBody();
      const res = await controller.provisionTenant(body);

      expect(provision.provisionTenant).toHaveBeenCalledWith(body);
      expect(res.tenantId).toBe(VALID_TENANT_ID);
    });

    it('微信 access_token 失败抛 → fail-open，继续 provision', async () => {
      security.serverSideCheckContent.mockRejectedValueOnce(
        new Error('WX_TOKEN_FAILED'),
      );

      const body = makeBody();
      await expect(controller.provisionTenant(body)).resolves.toBeDefined();
      expect(provision.provisionTenant).toHaveBeenCalledWith(body);
    });

    it('campuses 缺省 → 仅 check body.name', async () => {
      const body = makeBody({ campuses: undefined });
      await controller.provisionTenant(body);

      expect(security.serverSideCheckContent).toHaveBeenCalledTimes(1);
      expect(security.serverSideCheckContent).toHaveBeenCalledWith('阳光教育培训中心');
      expect(provision.provisionTenant).toHaveBeenCalledWith(body);
    });

    it('campus.address / courseLines 空字符串 → 跳过（不调 security）', async () => {
      const body = makeBody({
        campuses: [{ id: VALID_CAMPUS_ID, name: '主校区', address: '', courseLines: '' }],
      });
      await controller.provisionTenant(body);

      // 2 calls: name + campus.name（address / courseLines 空字符串跳过）
      expect(security.serverSideCheckContent).toHaveBeenCalledTimes(2);
    });

    it('body.name 空白 trim → 不调 security 该字段', async () => {
      const body = makeBody({ name: '   ' });
      // name 空白被 trim 后跳过，campus 3 字段
      await controller.provisionTenant(body);
      expect(security.serverSideCheckContent).toHaveBeenCalledTimes(3);
    });

    it('多 campus 全部 check', async () => {
      const body = makeBody({
        campuses: [
          { id: VALID_CAMPUS_ID, name: '主校区', address: '北京', courseLines: '语数英' },
          { id: 'campusF0000000000000000000000F09', name: '分校区', address: '上海' },
        ],
      });
      await controller.provisionTenant(body);

      // 1 (name) + 3 (主校区 / 北京 / 语数英) + 2 (分校区 / 上海) = 6
      expect(security.serverSideCheckContent).toHaveBeenCalledTimes(6);
    });

    // F-08 round 2 (business validator P2): 补 body.name undefined null guard 覆盖
    it('body.name undefined → 跳过 name check，仅 check campus 字段', async () => {
      // 构造 body 但 name 为 undefined（绕过 makeBody 默认值，直接传 undefined）
      const body = {
        tenantId: 'mxedu_TEST_NO_NAME_00000000000001',
        // name 字段故意省略 → undefined
        sku: 'standard_1999' as const,
        campuses: [
          { id: VALID_CAMPUS_ID, name: '主校区', address: '北京', courseLines: '语数英' },
        ],
      };
      await controller.provisionTenant(body as never);

      // body.name undefined → 跳过 → 仅 check 主校区 3 字段 (name/address/courseLines)
      expect(security.serverSideCheckContent).toHaveBeenCalledTimes(3);
      expect(security.serverSideCheckContent).not.toHaveBeenCalledWith(
        expect.stringContaining('undefined'),
      );
    });

    // F-08 round 2 (business validator P1): 校验 @Throttle + campuses 上限
    it('campuses 超 20 → 400 TOO_MANY_CAMPUSES (DoS amplification 防护)', async () => {
      const tooManyCampuses = Array.from({ length: 21 }, (_, i) => ({
        id: `campus${String(i).padStart(28, '0')}`,
        name: `校区${i}`,
      }));
      const body = makeBody({ campuses: tooManyCampuses });

      await expect(controller.provisionTenant(body)).rejects.toThrow(BadRequestException);
      // 应在调 security 之前抛错（短路）
      expect(security.serverSideCheckContent).not.toHaveBeenCalled();
      expect(provision.provisionTenant).not.toHaveBeenCalled();
    });
  });
});
