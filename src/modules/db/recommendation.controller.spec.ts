/**
 * recommendation.controller.spec.ts (V17/V22 家长推荐 controller — 5/20 stryker 0% coverage 修补)
 *
 * 来源：5/20 stryker mutation 跑出 recommendation.controller 61 mutant 全 no-cov
 *   → 该 controller 是「家长推荐」HTTP 入口（V10 §17）+ V22 推荐计数触发器
 *   → 4 endpoint：create / toggle / listByTeacher / inviteParent
 *
 * 范围（covers 61 mutant / 139 行）：
 *   - create: tenantSchema 必填 + id ULID 32 字符 + stars 1-5 数值 + tags 默认空数组
 *   - create: parentAuthorized?? false 默认 + displayed=false 默认 + 时间戳填充
 *   - create: V22 referrals.markRated 触发计数 + 异常 fail-open（不阻塞主流程）
 *   - toggle: tenantSchema 必填 + body.displayed 必须布尔 + 透传到 repo
 *   - listByTeacher: tenantSchema 必填 + items + displayedCount 聚合
 *   - inviteParent: tenantSchema + studentId 必填 + 透传到 repo
 *   - TenantScopeGuard 由 framework class @UseGuards 校验，单测 controller handler 不展开
 */

import { BadRequestException } from '@nestjs/common';
import { RecommendationController } from './recommendation.controller';
import {
  RecommendationRepository,
  ParentRecommendation,
} from './recommendation.repository';
import { ReferralRepository } from './referral.repository';

describe('RecommendationController (5/20 stryker no-cov 修补)', () => {
  let controller: RecommendationController;
  let recRepo: {
    insert: jest.Mock;
    listByTeacher: jest.Mock;
    toggleDisplayed: jest.Mock;
    countDisplayed: jest.Mock;
    inviteParent: jest.Mock;
  };
  let referrals: {
    markRated: jest.Mock;
  };

  const TENANT_SCHEMA = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const REC_ID = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMRE1';
  const TEACHER_ID = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMTE1';
  const PARENT_ID = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMPR1';
  const STUDENT_ID = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMST1';

  beforeEach(() => {
    recRepo = {
      insert: jest.fn(),
      listByTeacher: jest.fn(),
      toggleDisplayed: jest.fn(),
      countDisplayed: jest.fn(),
      inviteParent: jest.fn(),
    };
    referrals = {
      markRated: jest.fn().mockResolvedValue(null),
    };
    controller = new RecommendationController(
      recRepo as unknown as RecommendationRepository,
      referrals as unknown as ReferralRepository,
    );
  });

  function recFixture(
    overrides: Partial<ParentRecommendation> = {},
  ): ParentRecommendation {
    return {
      id: REC_ID,
      teacherId: TEACHER_ID,
      parentId: PARENT_ID,
      studentId: STUDENT_ID,
      stars: 5,
      content: '老师讲解清晰',
      tags: ['认真负责'],
      parentAuthorized: true,
      displayed: false,
      submittedAt: new Date('2026-05-10T10:00:00.000Z'),
      createdAt: new Date('2026-05-10T10:00:00.000Z'),
      ...overrides,
    };
  }

  // ============================================================
  // create — POST /db/recommendations
  // ============================================================
  describe('create()', () => {
    const VALID_BODY = {
      id: REC_ID,
      teacherId: TEACHER_ID,
      parentId: PARENT_ID,
      studentId: STUDENT_ID,
      stars: 5,
      content: '老师讲解清晰',
      tags: ['认真负责'],
      parentAuthorized: true,
    };

    it('case-1: happy — recRepo.insert 调 1 次 + 返回 mapped recommendation', async () => {
      const created = recFixture();
      recRepo.insert.mockResolvedValueOnce(created);
      const result = await controller.create(TENANT_SCHEMA, VALID_BODY);

      expect(recRepo.insert).toHaveBeenCalledTimes(1);
      expect(result).toBe(created);
    });

    it('case-2: insert 入参 = tenantSchema + 完整 record（tags / parentAuthorized / displayed=false / submittedAt now）', async () => {
      recRepo.insert.mockResolvedValueOnce(recFixture());
      await controller.create(TENANT_SCHEMA, VALID_BODY);

      const [schema, rec] = recRepo.insert.mock.calls[0];
      expect(schema).toBe(TENANT_SCHEMA);
      expect(rec.id).toBe(REC_ID);
      expect(rec.teacherId).toBe(TEACHER_ID);
      expect(rec.parentId).toBe(PARENT_ID);
      expect(rec.studentId).toBe(STUDENT_ID);
      expect(rec.stars).toBe(5);
      expect(rec.content).toBe('老师讲解清晰');
      expect(rec.tags).toEqual(['认真负责']);
      expect(rec.parentAuthorized).toBe(true);
      expect(rec.displayed).toBe(false);
      expect(rec.submittedAt).toBeInstanceOf(Date);
      expect(rec.createdAt).toBeInstanceOf(Date);
    });

    it('case-3: 缺 tenantSchema → BadRequest x-tenant-schema header required', async () => {
      await expect(controller.create('', VALID_BODY)).rejects.toThrow(
        new BadRequestException('x-tenant-schema header required'),
      );
      expect(recRepo.insert).not.toHaveBeenCalled();
    });

    it('case-4: id 缺失 → BadRequest id must be 32-char ULID', async () => {
      await expect(
        controller.create(TENANT_SCHEMA, { ...VALID_BODY, id: '' }),
      ).rejects.toThrow(BadRequestException);
      expect(recRepo.insert).not.toHaveBeenCalled();
    });

    it('case-5: id 长度非 32 → BadRequest', async () => {
      await expect(
        controller.create(TENANT_SCHEMA, { ...VALID_BODY, id: 'short' }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        controller.create(TENANT_SCHEMA, {
          ...VALID_BODY,
          id: 'X'.repeat(33),
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('case-6: stars 非 number → BadRequest stars must be 1-5', async () => {
      await expect(
        controller.create(TENANT_SCHEMA, {
          ...VALID_BODY,
          stars: '5' as unknown as number,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('case-7: stars < 1 → BadRequest', async () => {
      await expect(
        controller.create(TENANT_SCHEMA, { ...VALID_BODY, stars: 0 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('case-8: stars > 5 → BadRequest', async () => {
      await expect(
        controller.create(TENANT_SCHEMA, { ...VALID_BODY, stars: 6 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('case-9: stars 边界 1 / 5 通过', async () => {
      recRepo.insert.mockResolvedValueOnce(recFixture({ stars: 1 }));
      await expect(
        controller.create(TENANT_SCHEMA, { ...VALID_BODY, stars: 1 }),
      ).resolves.toBeDefined();

      recRepo.insert.mockResolvedValueOnce(recFixture({ stars: 5 }));
      await expect(
        controller.create(TENANT_SCHEMA, { ...VALID_BODY, stars: 5 }),
      ).resolves.toBeDefined();
    });

    it('case-10: tags 未传 → 默认空数组 [] 入 insert', async () => {
      recRepo.insert.mockResolvedValueOnce(recFixture({ tags: [] }));
      await controller.create(TENANT_SCHEMA, {
        ...VALID_BODY,
        tags: undefined,
      });
      const rec = recRepo.insert.mock.calls[0][1];
      expect(rec.tags).toEqual([]);
    });

    it('case-11: parentAuthorized 未传 → 默认 false', async () => {
      recRepo.insert.mockResolvedValueOnce(recFixture({ parentAuthorized: false }));
      await controller.create(TENANT_SCHEMA, {
        ...VALID_BODY,
        parentAuthorized: undefined,
      });
      const rec = recRepo.insert.mock.calls[0][1];
      expect(rec.parentAuthorized).toBe(false);
    });

    it('case-12: content 未传 → undefined 入 insert（repo 内层会 || null）', async () => {
      recRepo.insert.mockResolvedValueOnce(recFixture({ content: undefined }));
      await controller.create(TENANT_SCHEMA, {
        ...VALID_BODY,
        content: undefined,
      });
      const rec = recRepo.insert.mock.calls[0][1];
      expect(rec.content).toBeUndefined();
    });

    it('case-13: V22 触发 — referrals.markRated 调用入参 = tenantSchema + parentId + teacherId + rating', async () => {
      recRepo.insert.mockResolvedValueOnce(recFixture());
      await controller.create(TENANT_SCHEMA, VALID_BODY);

      expect(referrals.markRated).toHaveBeenCalledTimes(1);
      expect(referrals.markRated).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        PARENT_ID,
        TEACHER_ID,
        { id: REC_ID, source: 'parent_recommendation' },
      );
    });

    it('case-14: V22 fail-open — referrals.markRated 抛错不阻塞主流程，仍返回创建结果', async () => {
      const created = recFixture();
      recRepo.insert.mockResolvedValueOnce(created);
      referrals.markRated.mockRejectedValueOnce(
        new Error('referral table missing'),
      );

      const result = await controller.create(TENANT_SCHEMA, VALID_BODY);
      expect(result).toBe(created);
      expect(referrals.markRated).toHaveBeenCalled();
    });

    it('case-15: recRepo.insert 抛错 → 不进 referrals 调用，错抛出（主流程不容失败）', async () => {
      recRepo.insert.mockRejectedValueOnce(new Error('UNIQUE violation'));
      await expect(
        controller.create(TENANT_SCHEMA, VALID_BODY),
      ).rejects.toThrow(/UNIQUE violation/);
      expect(referrals.markRated).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // toggle — POST /db/recommendations/:id/toggle
  // ============================================================
  describe('toggle()', () => {
    it('case-16: happy — toggleDisplayed 调 1 次 + 透传 tenant/id/displayed', async () => {
      const after = recFixture({ displayed: true });
      recRepo.toggleDisplayed.mockResolvedValueOnce(after);
      const result = await controller.toggle(REC_ID, TENANT_SCHEMA, {
        displayed: true,
      });

      expect(recRepo.toggleDisplayed).toHaveBeenCalledTimes(1);
      expect(recRepo.toggleDisplayed).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        REC_ID,
        true,
      );
      expect(result).toBe(after);
    });

    it('case-17: displayed=false 也走透传（关闭展示）', async () => {
      const after = recFixture({ displayed: false });
      recRepo.toggleDisplayed.mockResolvedValueOnce(after);
      const result = await controller.toggle(REC_ID, TENANT_SCHEMA, {
        displayed: false,
      });
      expect(recRepo.toggleDisplayed).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        REC_ID,
        false,
      );
      expect(result.displayed).toBe(false);
    });

    it('case-18: 缺 tenantSchema → BadRequest', async () => {
      await expect(
        controller.toggle(REC_ID, '', { displayed: true }),
      ).rejects.toThrow(
        new BadRequestException('x-tenant-schema header required'),
      );
      expect(recRepo.toggleDisplayed).not.toHaveBeenCalled();
    });

    it('case-19: displayed 非布尔（string）→ BadRequest displayed must be boolean', async () => {
      await expect(
        controller.toggle(REC_ID, TENANT_SCHEMA, {
          displayed: 'true' as unknown as boolean,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(recRepo.toggleDisplayed).not.toHaveBeenCalled();
    });

    it('case-20: displayed 缺失 → BadRequest displayed must be boolean', async () => {
      await expect(
        controller.toggle(REC_ID, TENANT_SCHEMA, {} as { displayed: boolean }),
      ).rejects.toThrow(BadRequestException);
    });

    it('case-21: repo 抛错（业务约束 parent_authorized=false）→ 透传到 controller 调用方', async () => {
      recRepo.toggleDisplayed.mockRejectedValueOnce(
        new BadRequestException(
          'cannot display recommendation without parent authorization',
        ),
      );
      await expect(
        controller.toggle(REC_ID, TENANT_SCHEMA, { displayed: true }),
      ).rejects.toThrow(/parent authorization/);
    });
  });

  // ============================================================
  // listByTeacher — POST /db/teachers/:teacherId/recommendations/list
  // ============================================================
  describe('listByTeacher()', () => {
    it('case-22: happy — listByTeacher 1 次 + 返回 items + displayedCount 聚合', async () => {
      const items = [
        recFixture({ id: 'A'.repeat(32), displayed: true }),
        recFixture({ id: 'B'.repeat(32), displayed: false }),
        recFixture({ id: 'C'.repeat(32), displayed: true }),
      ];
      recRepo.listByTeacher.mockResolvedValueOnce(items);
      const result = await controller.listByTeacher(TEACHER_ID, TENANT_SCHEMA);

      expect(recRepo.listByTeacher).toHaveBeenCalledTimes(1);
      expect(recRepo.listByTeacher).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        TEACHER_ID,
      );
      expect(result.items).toBe(items);
      expect(result.displayedCount).toBe(2);
    });

    it('case-23: 0 条 → items=[] + displayedCount=0', async () => {
      recRepo.listByTeacher.mockResolvedValueOnce([]);
      const result = await controller.listByTeacher(TEACHER_ID, TENANT_SCHEMA);
      expect(result.items).toEqual([]);
      expect(result.displayedCount).toBe(0);
    });

    it('case-24: 全 displayed=false → displayedCount=0', async () => {
      const items = [
        recFixture({ displayed: false }),
        recFixture({ displayed: false }),
      ];
      recRepo.listByTeacher.mockResolvedValueOnce(items);
      const result = await controller.listByTeacher(TEACHER_ID, TENANT_SCHEMA);
      expect(result.displayedCount).toBe(0);
    });

    it('case-25: 全 displayed=true → displayedCount=N', async () => {
      const items = [
        recFixture({ displayed: true }),
        recFixture({ displayed: true }),
        recFixture({ displayed: true }),
      ];
      recRepo.listByTeacher.mockResolvedValueOnce(items);
      const result = await controller.listByTeacher(TEACHER_ID, TENANT_SCHEMA);
      expect(result.displayedCount).toBe(3);
    });

    it('case-26: 缺 tenantSchema → BadRequest', async () => {
      await expect(
        controller.listByTeacher(TEACHER_ID, ''),
      ).rejects.toThrow(
        new BadRequestException('x-tenant-schema header required'),
      );
      expect(recRepo.listByTeacher).not.toHaveBeenCalled();
    });

    it('case-27: repo 抛错 → 透传', async () => {
      recRepo.listByTeacher.mockRejectedValueOnce(new Error('connection lost'));
      await expect(
        controller.listByTeacher(TEACHER_ID, TENANT_SCHEMA),
      ).rejects.toThrow(/connection lost/);
    });
  });

  // ============================================================
  // inviteParent — POST /db/teachers/:teacherId/recommendations/invite
  // ============================================================
  describe('inviteParent()', () => {
    it('case-28: happy — recRepo.inviteParent 调 1 次 + 透传 tenant/teacher/student', async () => {
      recRepo.inviteParent.mockResolvedValueOnce({
        ok: true,
        msg: 'invite-sent (mock)',
      });
      const result = await controller.inviteParent(
        TEACHER_ID,
        TENANT_SCHEMA,
        { studentId: STUDENT_ID },
      );

      expect(recRepo.inviteParent).toHaveBeenCalledTimes(1);
      expect(recRepo.inviteParent).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        TEACHER_ID,
        STUDENT_ID,
      );
      expect(result).toEqual({ ok: true, msg: 'invite-sent (mock)' });
    });

    it('case-29: 缺 tenantSchema → BadRequest', async () => {
      await expect(
        controller.inviteParent(TEACHER_ID, '', { studentId: STUDENT_ID }),
      ).rejects.toThrow(
        new BadRequestException('x-tenant-schema header required'),
      );
      expect(recRepo.inviteParent).not.toHaveBeenCalled();
    });

    it('case-30: 缺 studentId → BadRequest studentId required', async () => {
      await expect(
        controller.inviteParent(TEACHER_ID, TENANT_SCHEMA, { studentId: '' }),
      ).rejects.toThrow(new BadRequestException('studentId required'));
      expect(recRepo.inviteParent).not.toHaveBeenCalled();
    });

    it('case-31: repo 抛错（外部消息失败）→ 透传', async () => {
      recRepo.inviteParent.mockRejectedValueOnce(
        new Error('wx subscribe template missing'),
      );
      await expect(
        controller.inviteParent(TEACHER_ID, TENANT_SCHEMA, {
          studentId: STUDENT_ID,
        }),
      ).rejects.toThrow(/wx subscribe template missing/);
    });
  });
});
