/**
 * CampusFreeSlotController 单测 — 5/20 stryker 0% coverage 修补
 *
 * 来源：5/20 stryker mutation 跑出 campus-free-slot.controller 40 mutant 全 no-cov
 *   → 该 controller 是 V23 C 端家长抢校区赠送 slot 的唯一 HTTP 入口
 *   → 业务规则：FCFS 抢占 / 3 个月免费 / 校区 10 slot 上限 / 防一家长占多槽
 *   → 错误路径全无 spec：campusId/parentId/slotId 必填 / durationMonths 范围 / repo 抛 Conflict/NotFound 透传
 *
 * 覆盖 case：
 *   listByCampus
 *     1. happy path → 返 { items }
 *     2. campusId 缺 → 400 BadRequestException
 *     3. 空校区 → 返 { items: [] }
 *
 *   stats
 *     4. happy path → 返 { total, occupied, empty, expired }
 *     5. campusId 缺 → 400
 *     6. 全空校区 → 0/0/0/0
 *
 *   claim (POST)
 *     7. happy path durationMonths=3（默认）→ 返 slot
 *     8. happy path durationMonths=6（自定义）→ 透传到 repo
 *     9. campusId 缺 → 400
 *     10. parentId 缺 → 400
 *     11. durationMonths < 1 → 400
 *     12. durationMonths > 12 → 400
 *     13. durationMonths = 1 边界通过
 *     14. durationMonths = 12 边界通过
 *     15. repo 抛 PARENT_ALREADY_HAS_SLOT 透传 409
 *     16. repo 抛 CAMPUS_SLOT_EXHAUSTED 透传 409
 *     17. repo 抛 SLOT_RACE_LOST 透传 409
 *
 *   release (POST)
 *     18. happy path → 返释放后的 slot
 *     19. slotId 缺 → 400
 *     20. slotId = 0 → 400（falsy）
 *     21. repo 抛 NotFoundException 透传 404
 *
 *   byParent (GET)
 *     22. happy path 有 slot → 返 slot 对象
 *     23. happy path 无 slot → 返 { found: false }
 *     24. parentId 缺 → 400
 *
 * 注：TenantScopeGuard 在 controller 测试中绕过（DI 不实际执行 guard）。
 *      跨租户校验由 e2e + guard 自己的单测覆盖。
 */
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { CampusFreeSlotController } from './campus-free-slot.controller';
import type {
  CampusFreeSlot,
  CampusFreeSlotRepository,
} from './campus-free-slot.repository';

function makeSlot(over: Partial<CampusFreeSlot> = {}): CampusFreeSlot {
  return {
    id: 1,
    campusId: 'campus-001',
    slotIndex: 1,
    parentId: 'parent-001',
    grantedAt: '2026-05-20T00:00:00.000Z',
    expiresAt: '2026-08-20T00:00:00.000Z',
    status: 'occupied',
    version: 1,
    createdAt: '2026-05-20T00:00:00.000Z',
    updatedAt: '2026-05-20T00:00:00.000Z',
    ...over,
  };
}

describe('CampusFreeSlotController', () => {
  let controller: CampusFreeSlotController;
  let repo: jest.Mocked<
    Pick<
      CampusFreeSlotRepository,
      'listByCampus' | 'getCampusStats' | 'claim' | 'release' | 'findByParent'
    >
  >;

  beforeEach(() => {
    repo = {
      listByCampus: jest.fn(),
      getCampusStats: jest.fn(),
      claim: jest.fn(),
      release: jest.fn(),
      findByParent: jest.fn(),
    };
    controller = new CampusFreeSlotController(repo as unknown as CampusFreeSlotRepository);
  });

  // ----------------------------------------------------------------
  // listByCampus
  // ----------------------------------------------------------------
  describe('listByCampus', () => {
    it('happy path — 返 { items: [...] } 且调 repo.listByCampus 一次（传 campusId）', async () => {
      const slots = [makeSlot({ id: 1 }), makeSlot({ id: 2, slotIndex: 2 })];
      repo.listByCampus.mockResolvedValueOnce(slots);

      const res = await controller.listByCampus('campus-001', 'tenant-A');

      expect(res).toEqual({ items: slots });
      expect(repo.listByCampus).toHaveBeenCalledTimes(1);
      expect(repo.listByCampus).toHaveBeenCalledWith('campus-001');
    });

    it('campusId 空字符串 → 400 BadRequestException("campusId required")', async () => {
      await expect(controller.listByCampus('', 'tenant-A')).rejects.toThrow(
        BadRequestException,
      );
      await expect(controller.listByCampus('', 'tenant-A')).rejects.toThrow('campusId required');
      expect(repo.listByCampus).not.toHaveBeenCalled();
    });

    it('空校区 → { items: [] }（repo 返空数组透传）', async () => {
      repo.listByCampus.mockResolvedValueOnce([]);
      const res = await controller.listByCampus('campus-empty', 'tenant-A');
      expect(res).toEqual({ items: [] });
    });
  });

  // ----------------------------------------------------------------
  // stats
  // ----------------------------------------------------------------
  describe('stats', () => {
    it('happy path — 透传 repo.getCampusStats 返回值', async () => {
      const statsObj = { total: 10, occupied: 5, empty: 3, expired: 2 };
      repo.getCampusStats.mockResolvedValueOnce(statsObj);

      const res = await controller.stats('campus-001', 'tenant-A');

      expect(res).toEqual(statsObj);
      expect(repo.getCampusStats).toHaveBeenCalledWith('campus-001');
    });

    it('campusId 空字符串 → 400 BadRequestException', async () => {
      await expect(controller.stats('', 'tenant-A')).rejects.toThrow(BadRequestException);
      await expect(controller.stats('', 'tenant-A')).rejects.toThrow('campusId required');
      expect(repo.getCampusStats).not.toHaveBeenCalled();
    });

    it('全空校区 → 0/0/0/0', async () => {
      const empty = { total: 0, occupied: 0, empty: 0, expired: 0 };
      repo.getCampusStats.mockResolvedValueOnce(empty);
      const res = await controller.stats('campus-zero', 'tenant-A');
      expect(res).toEqual(empty);
    });
  });

  // ----------------------------------------------------------------
  // claim
  // ----------------------------------------------------------------
  describe('claim', () => {
    const validBody = () => ({
      tenantId: 'tenant-A',
      campusId: 'campus-001',
      parentId: 'parent-001',
    });

    it('happy path durationMonths 缺省 → 默认 3 个月，repo.claim(campusId, parentId, 3)', async () => {
      const slot = makeSlot();
      repo.claim.mockResolvedValueOnce(slot);

      const res = await controller.claim(validBody());

      expect(res).toEqual(slot);
      expect(repo.claim).toHaveBeenCalledTimes(1);
      expect(repo.claim).toHaveBeenCalledWith('campus-001', 'parent-001', 3);
    });

    it('happy path durationMonths=6 → 透传 6 到 repo', async () => {
      const slot = makeSlot();
      repo.claim.mockResolvedValueOnce(slot);

      await controller.claim({ ...validBody(), durationMonths: 6 });

      expect(repo.claim).toHaveBeenCalledWith('campus-001', 'parent-001', 6);
    });

    it('campusId 缺 → 400 BadRequestException("campusId required") 且不调 repo', async () => {
      await expect(
        controller.claim({ ...validBody(), campusId: '' }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        controller.claim({ ...validBody(), campusId: '' }),
      ).rejects.toThrow('campusId required');
      expect(repo.claim).not.toHaveBeenCalled();
    });

    it('parentId 缺 → 400 BadRequestException("parentId required") 且不调 repo', async () => {
      await expect(
        controller.claim({ ...validBody(), parentId: '' }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        controller.claim({ ...validBody(), parentId: '' }),
      ).rejects.toThrow('parentId required');
      expect(repo.claim).not.toHaveBeenCalled();
    });

    it('durationMonths = 0 → 400 BadRequestException("durationMonths must be 1-12")', async () => {
      await expect(
        controller.claim({ ...validBody(), durationMonths: 0 }),
      ).rejects.toThrow(BadRequestException);
      // 0 也走 ??= 3 的左侧 (0 是非 null/undefined)，所以仍校验 < 1 分支
      await expect(
        controller.claim({ ...validBody(), durationMonths: 0 }),
      ).rejects.toThrow('durationMonths must be 1-12');
      expect(repo.claim).not.toHaveBeenCalled();
    });

    it('durationMonths < 0 → 400', async () => {
      await expect(
        controller.claim({ ...validBody(), durationMonths: -1 }),
      ).rejects.toThrow(/durationMonths must be 1-12/);
    });

    it('durationMonths > 12 → 400', async () => {
      await expect(
        controller.claim({ ...validBody(), durationMonths: 13 }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        controller.claim({ ...validBody(), durationMonths: 13 }),
      ).rejects.toThrow('durationMonths must be 1-12');
      expect(repo.claim).not.toHaveBeenCalled();
    });

    it('durationMonths = 1 边界通过 → 调 repo', async () => {
      repo.claim.mockResolvedValueOnce(makeSlot());
      await controller.claim({ ...validBody(), durationMonths: 1 });
      expect(repo.claim).toHaveBeenCalledWith('campus-001', 'parent-001', 1);
    });

    it('durationMonths = 12 边界通过 → 调 repo', async () => {
      repo.claim.mockResolvedValueOnce(makeSlot());
      await controller.claim({ ...validBody(), durationMonths: 12 });
      expect(repo.claim).toHaveBeenCalledWith('campus-001', 'parent-001', 12);
    });

    it('repo 抛 PARENT_ALREADY_HAS_SLOT (一家长占多槽防护) → 透传 409 ConflictException', async () => {
      repo.claim.mockRejectedValue(new ConflictException('PARENT_ALREADY_HAS_SLOT'));
      await expect(controller.claim(validBody())).rejects.toThrow(ConflictException);
      await expect(controller.claim(validBody())).rejects.toThrow('PARENT_ALREADY_HAS_SLOT');
    });

    it('repo 抛 CAMPUS_SLOT_EXHAUSTED → 透传 409', async () => {
      repo.claim.mockRejectedValue(new ConflictException('CAMPUS_SLOT_EXHAUSTED'));
      await expect(controller.claim(validBody())).rejects.toThrow(ConflictException);
      await expect(controller.claim(validBody())).rejects.toThrow(/CAMPUS_SLOT_EXHAUSTED/);
    });

    it('repo 抛 SLOT_RACE_LOST (FCFS 并发输) → 透传 409', async () => {
      repo.claim.mockRejectedValue(new ConflictException('SLOT_RACE_LOST'));
      await expect(controller.claim(validBody())).rejects.toThrow(ConflictException);
      await expect(controller.claim(validBody())).rejects.toThrow(/SLOT_RACE_LOST/);
    });
  });

  // ----------------------------------------------------------------
  // release
  // ----------------------------------------------------------------
  describe('release', () => {
    it('happy path — 透传 slotId 到 repo.release，返回释放后的 slot', async () => {
      const released = makeSlot({ status: 'empty', parentId: null, grantedAt: null, expiresAt: null });
      repo.release.mockResolvedValueOnce(released);

      const res = await controller.release({ tenantId: 'tenant-A', slotId: 42 });

      expect(res).toEqual(released);
      expect(repo.release).toHaveBeenCalledTimes(1);
      expect(repo.release).toHaveBeenCalledWith(42);
    });

    it('slotId = 0 → 400 BadRequestException("slotId required")（0 falsy 路径）', async () => {
      await expect(
        controller.release({ tenantId: 'tenant-A', slotId: 0 }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        controller.release({ tenantId: 'tenant-A', slotId: 0 }),
      ).rejects.toThrow('slotId required');
      expect(repo.release).not.toHaveBeenCalled();
    });

    it('slotId 缺 (undefined) → 400', async () => {
      await expect(
        controller.release({ tenantId: 'tenant-A' } as never),
      ).rejects.toThrow(BadRequestException);
      expect(repo.release).not.toHaveBeenCalled();
    });

    it('repo 抛 NotFoundException → 透传 404（slot 不是 occupied 状态）', async () => {
      repo.release.mockRejectedValue(new NotFoundException('slot 99 not occupied'));
      await expect(
        controller.release({ tenantId: 'tenant-A', slotId: 99 }),
      ).rejects.toThrow(NotFoundException);
      await expect(
        controller.release({ tenantId: 'tenant-A', slotId: 99 }),
      ).rejects.toThrow('slot 99 not occupied');
    });
  });

  // ----------------------------------------------------------------
  // byParent
  // ----------------------------------------------------------------
  describe('byParent', () => {
    it('happy path 有 slot → 返完整 slot 对象', async () => {
      const slot = makeSlot();
      repo.findByParent.mockResolvedValueOnce(slot);

      const res = await controller.byParent('parent-001', 'tenant-A');

      expect(res).toEqual(slot);
      expect(repo.findByParent).toHaveBeenCalledTimes(1);
      expect(repo.findByParent).toHaveBeenCalledWith('parent-001');
    });

    it('happy path 无 slot → 返 { found: false }（不抛 404）', async () => {
      repo.findByParent.mockResolvedValueOnce(null);

      const res = await controller.byParent('parent-none', 'tenant-A');

      expect(res).toEqual({ found: false });
      expect(repo.findByParent).toHaveBeenCalledWith('parent-none');
    });

    it('parentId 空字符串 → 400 BadRequestException("parentId required") 且不调 repo', async () => {
      await expect(controller.byParent('', 'tenant-A')).rejects.toThrow(BadRequestException);
      await expect(controller.byParent('', 'tenant-A')).rejects.toThrow('parentId required');
      expect(repo.findByParent).not.toHaveBeenCalled();
    });
  });
});
