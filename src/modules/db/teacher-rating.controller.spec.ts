/**
 * TeacherRatingController 单测 — P4-Y (2026-05-20)
 *
 * 验证 P4-Y 拍板：
 *   - parent JWT 自身校验（jwt.parentId === body.parentId）
 *   - tenant binding 校验（parent_student_bindings active in current tenant）
 *   - teacher × student 真实关系（owner / schedule / binding）
 *   - content 走 msgSecCheck（risky → 400 / review → 放行 + audit / err → 放行 + audit）
 *   - upsert（同三元组重复 → updated 而非 inserted）
 *   - audit_log 全路径（deny / created / updated / content-review / content-check-error）
 */
import {
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { TeacherRatingController } from './teacher-rating.controller';
import { TeacherRatingRepository } from './teacher-rating.repository';
import { ParentRepository } from './parent.repository';
import { AuditLogRepository } from './audit-log.repository';
import {
  SecurityService,
  SecurityCheckResult,
} from '../security/security.service';

// Crockford Base32 排除 I/L/O/U — 替换为 1/2/3 防 ULID_PATTERN 拒
const ULID_P = '01HX7Y6P5K9N3M2QABCDEFGHJKMN2PP1';
const ULID_P_OTHER = '01HX7Y6P5K9N3M2QABCDEFGHJKMN2PP2';
const ULID_T = '01HX7Y6P5K9N3M2QABCDEFGHJKMN2TT1';
const ULID_S = '01HX7Y6P5K9N3M2QABCDEFGHJKMN2SS1';
const ULID_RATING = '01HX7Y6P5K9N3M2QABCDEFGHJKMN2RR1';
const TENANT_ID = 'abcd1234567890abcd1234567890abcd';
const TENANT_SCHEMA = `tenant_${TENANT_ID}`;
const TENANT_OTHER_ID = 'xxxx0000000000000000000000000000';

function makeReq(overrides: Partial<{ parentSub: string; tenantSchema: string }> = {}) {
  return {
    parent: {
      sub: overrides.parentSub ?? ULID_P,
      parentId: overrides.parentSub ?? ULID_P,
      role: 'parent',
    },
    tenantSchema: overrides.tenantSchema ?? TENANT_SCHEMA,
    headers: { 'user-agent': 'jest', 'x-request-id': 'rid-1' },
    ip: '1.2.3.4',
  } as any;
}

function bindingsForCurrentTenant(): Array<any> {
  return [
    {
      id: 'b1',
      parentId: ULID_P,
      studentId: ULID_S,
      tenantId: TENANT_ID,
      bindingStatus: 'active',
      isPrimary: true,
      relationship: 'father',
      boundAt: new Date(),
    },
  ];
}

describe('TeacherRatingController', () => {
  let controller: TeacherRatingController;
  let ratingRepo: {
    upsert: jest.Mock;
    isTeacherForStudent: jest.Mock;
    findByTriple: jest.Mock;
  };
  let parentRepo: {
    findChildrenByParent: jest.Mock;
  };
  let security: { msgSecCheck: jest.Mock; serverSideCheckContent: jest.Mock };
  let auditLog: { log: jest.Mock };

  beforeEach(() => {
    ratingRepo = {
      upsert: jest.fn().mockResolvedValue({
        entry: {
          id: ULID_RATING,
          parentId: ULID_P,
          teacherId: ULID_T,
          studentId: ULID_S,
          stars: 5,
          content: null,
          tags: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          createdBy: ULID_P,
        },
        isInsert: true,
      }),
      isTeacherForStudent: jest.fn().mockResolvedValue(true),
      findByTriple: jest.fn(),
    };
    parentRepo = {
      findChildrenByParent: jest.fn().mockResolvedValue(bindingsForCurrentTenant()),
    };
    security = {
      msgSecCheck: jest.fn().mockResolvedValue({
        ok: true,
        suggest: 'pass',
        errcode: 0,
      } as SecurityCheckResult),
      serverSideCheckContent: jest.fn().mockResolvedValue({
        ok: true,
        suggest: 'pass',
        errcode: 0,
      } as SecurityCheckResult),
    };
    auditLog = { log: jest.fn().mockResolvedValue(undefined) };

    controller = new TeacherRatingController(
      ratingRepo as unknown as TeacherRatingRepository,
      parentRepo as unknown as ParentRepository,
      security as unknown as SecurityService,
      auditLog as unknown as AuditLogRepository,
    );
  });

  describe('参数校验', () => {
    it('id 非 32-char ULID → 400', async () => {
      await expect(
        controller.createRating(
          { id: 'short', parentId: ULID_P, teacherId: ULID_T, studentId: ULID_S, stars: 5 },
          makeReq(),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('stars 非 1-5 整数 → 400', async () => {
      await expect(
        controller.createRating(
          { id: ULID_RATING, parentId: ULID_P, teacherId: ULID_T, studentId: ULID_S, stars: 6 },
          makeReq(),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('stars 是浮点数 → 400', async () => {
      await expect(
        controller.createRating(
          { id: ULID_RATING, parentId: ULID_P, teacherId: ULID_T, studentId: ULID_S, stars: 4.5 },
          makeReq(),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('content 长度超 2000 → 400', async () => {
      const tooLong = 'a'.repeat(2001);
      await expect(
        controller.createRating(
          {
            id: ULID_RATING,
            parentId: ULID_P,
            teacherId: ULID_T,
            studentId: ULID_S,
            stars: 5,
            content: tooLong,
          },
          makeReq(),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('tags 超过 10 个 → 400', async () => {
      const tags = Array.from({ length: 11 }, (_, i) => `#tag${i}`);
      await expect(
        controller.createRating(
          {
            id: ULID_RATING,
            parentId: ULID_P,
            teacherId: ULID_T,
            studentId: ULID_S,
            stars: 5,
            tags,
          },
          makeReq(),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('RBAC - parent self', () => {
    it('body.parentId !== jwt.parentId → 403 + audit deny', async () => {
      await expect(
        controller.createRating(
          {
            id: ULID_RATING,
            parentId: ULID_P_OTHER,
            teacherId: ULID_T,
            studentId: ULID_S,
            stars: 5,
          },
          makeReq({ parentSub: ULID_P }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // audit_log 应记 deny-parent-mismatch
      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        expect.objectContaining({
          action: 'teacher.rating.deny-parent-mismatch',
        }),
      );
    });

    it('无 req.parent → 403', async () => {
      const req = makeReq();
      delete (req as any).parent;
      await expect(
        controller.createRating(
          { id: ULID_RATING, parentId: ULID_P, teacherId: ULID_T, studentId: ULID_S, stars: 5 },
          req,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('RBAC - binding 校验', () => {
    it('parent 无该 student 当前 tenant active binding → 403 + audit deny', async () => {
      parentRepo.findChildrenByParent.mockResolvedValueOnce([]);
      await expect(
        controller.createRating(
          { id: ULID_RATING, parentId: ULID_P, teacherId: ULID_T, studentId: ULID_S, stars: 5 },
          makeReq(),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        expect.objectContaining({ action: 'teacher.rating.deny-binding' }),
      );
    });

    it('parent 绑定其他 tenant（不是当前 tenant）→ 403', async () => {
      parentRepo.findChildrenByParent.mockResolvedValueOnce([
        {
          id: 'b2',
          parentId: ULID_P,
          studentId: ULID_S,
          tenantId: TENANT_OTHER_ID,
          bindingStatus: 'active',
          isPrimary: true,
          relationship: 'mother',
          boundAt: new Date(),
        },
      ]);
      await expect(
        controller.createRating(
          { id: ULID_RATING, parentId: ULID_P, teacherId: ULID_T, studentId: ULID_S, stars: 5 },
          makeReq(),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('binding 是 unbound 状态 → 403', async () => {
      parentRepo.findChildrenByParent.mockResolvedValueOnce([
        {
          ...bindingsForCurrentTenant()[0],
          bindingStatus: 'unbound',
        },
      ]);
      await expect(
        controller.createRating(
          { id: ULID_RATING, parentId: ULID_P, teacherId: ULID_T, studentId: ULID_S, stars: 5 },
          makeReq(),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('RBAC - teacher × student 关系', () => {
    it('teacher 与 student 无 owner/schedule/binding 关系 → 403 + audit deny', async () => {
      ratingRepo.isTeacherForStudent.mockResolvedValueOnce(false);
      await expect(
        controller.createRating(
          { id: ULID_RATING, parentId: ULID_P, teacherId: ULID_T, studentId: ULID_S, stars: 5 },
          makeReq(),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        expect.objectContaining({
          action: 'teacher.rating.deny-teacher-relation',
        }),
      );
    });
  });

  describe('msgSecCheck 内容审查', () => {
    it('无 content → 跳过 msgSecCheck 直接 upsert', async () => {
      const res = await controller.createRating(
        { id: ULID_RATING, parentId: ULID_P, teacherId: ULID_T, studentId: ULID_S, stars: 5 },
        makeReq(),
      );
      expect(res.success).toBe(true);
      expect(security.msgSecCheck).not.toHaveBeenCalled();
      expect(security.serverSideCheckContent).not.toHaveBeenCalled();
    });

    it('content 有 openid → 走 v2 msgSecCheck', async () => {
      await controller.createRating(
        {
          id: ULID_RATING,
          parentId: ULID_P,
          teacherId: ULID_T,
          studentId: ULID_S,
          stars: 5,
          content: '老师讲解清楚',
          openid: 'o123_test_openid_001',
        },
        makeReq(),
      );
      expect(security.msgSecCheck).toHaveBeenCalledWith(
        '老师讲解清楚',
        'o123_test_openid_001',
        2, // MsgSecScene.COMMENT
      );
    });

    it('content 无 openid → 走 v1 serverSideCheckContent', async () => {
      await controller.createRating(
        {
          id: ULID_RATING,
          parentId: ULID_P,
          teacherId: ULID_T,
          studentId: ULID_S,
          stars: 5,
          content: '老师不错',
        },
        makeReq(),
      );
      expect(security.serverSideCheckContent).toHaveBeenCalledWith('老师不错');
    });

    it('msgSecCheck suggest=risky → 400 + audit deny-content-violation', async () => {
      security.serverSideCheckContent.mockResolvedValueOnce({
        ok: false,
        suggest: 'risky',
        errcode: 87014,
      });
      await expect(
        controller.createRating(
          {
            id: ULID_RATING,
            parentId: ULID_P,
            teacherId: ULID_T,
            studentId: ULID_S,
            stars: 5,
            content: '违规内容',
          },
          makeReq(),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        expect.objectContaining({
          action: 'teacher.rating.deny-content-violation',
        }),
      );
      // 不应执行 upsert
      expect(ratingRepo.upsert).not.toHaveBeenCalled();
    });

    it('msgSecCheck suggest=review → 放行 + audit content-review + contentReviewed=true', async () => {
      security.serverSideCheckContent.mockResolvedValueOnce({
        ok: false,
        suggest: 'review',
        errcode: 0,
      });
      const res = await controller.createRating(
        {
          id: ULID_RATING,
          parentId: ULID_P,
          teacherId: ULID_T,
          studentId: ULID_S,
          stars: 5,
          content: '边界内容',
        },
        makeReq(),
      );
      expect(res.success).toBe(true);
      expect(res.contentReviewed).toBe(true);
      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        expect.objectContaining({
          action: 'teacher.rating.content-review',
        }),
      );
    });

    it('msgSecCheck 抛错 → fail-open + audit content-check-error', async () => {
      security.serverSideCheckContent.mockRejectedValueOnce(
        new Error('network unreachable'),
      );
      const res = await controller.createRating(
        {
          id: ULID_RATING,
          parentId: ULID_P,
          teacherId: ULID_T,
          studentId: ULID_S,
          stars: 5,
          content: '网络异常时的评论',
        },
        makeReq(),
      );
      expect(res.success).toBe(true);
      expect(res.contentReviewed).toBe(true);
      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        expect.objectContaining({
          action: 'teacher.rating.content-check-error',
        }),
      );
    });
  });

  describe('upsert 路径', () => {
    it('isInsert=true → upsert=inserted + audit created', async () => {
      const res = await controller.createRating(
        { id: ULID_RATING, parentId: ULID_P, teacherId: ULID_T, studentId: ULID_S, stars: 5 },
        makeReq(),
      );
      expect(res.upsert).toBe('inserted');
      expect(res.ratingId).toBe(ULID_RATING);
      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        expect.objectContaining({ action: 'teacher.rating.created' }),
      );
    });

    it('isInsert=false (重复评分) → upsert=updated + audit updated', async () => {
      ratingRepo.upsert.mockResolvedValueOnce({
        entry: {
          id: ULID_RATING,
          parentId: ULID_P,
          teacherId: ULID_T,
          studentId: ULID_S,
          stars: 4,
          content: null,
          tags: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          createdBy: ULID_P,
        },
        isInsert: false,
      });
      const res = await controller.createRating(
        { id: ULID_RATING, parentId: ULID_P, teacherId: ULID_T, studentId: ULID_S, stars: 4 },
        makeReq(),
      );
      expect(res.upsert).toBe('updated');
      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        expect.objectContaining({ action: 'teacher.rating.updated' }),
      );
    });

    it('upsert 传递所有参数', async () => {
      await controller.createRating(
        {
          id: ULID_RATING,
          parentId: ULID_P,
          teacherId: ULID_T,
          studentId: ULID_S,
          stars: 5,
          content: '老师有耐心',
          tags: ['#耐心', '#讲解清楚'],
        },
        makeReq(),
      );
      expect(ratingRepo.upsert).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        expect.objectContaining({
          id: ULID_RATING,
          parentId: ULID_P,
          teacherId: ULID_T,
          studentId: ULID_S,
          stars: 5,
          content: '老师有耐心',
          tags: ['#耐心', '#讲解清楚'],
        }),
      );
    });

    it('content 为空字符串 → null（DB 不存空串）', async () => {
      await controller.createRating(
        {
          id: ULID_RATING,
          parentId: ULID_P,
          teacherId: ULID_T,
          studentId: ULID_S,
          stars: 5,
          content: '   ',
        },
        makeReq(),
      );
      const arg = ratingRepo.upsert.mock.calls[0][1];
      expect(arg.content).toBeNull();
    });
  });

  describe('audit_log fail-open', () => {
    it('auditLog.log 抛错不阻塞业务返回', async () => {
      auditLog.log.mockRejectedValue(new Error('db down'));
      const res = await controller.createRating(
        { id: ULID_RATING, parentId: ULID_P, teacherId: ULID_T, studentId: ULID_S, stars: 5 },
        makeReq(),
      );
      expect(res.success).toBe(true);
    });
  });
});
