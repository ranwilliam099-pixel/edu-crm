import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ParentCommunicationController } from './parent-communication.controller';
import {
  ParentCommunication,
  ParentCommunicationRepository,
} from './parent-communication.repository';
import { StudentRepository } from './student.repository';
import { ContentModerationService } from '../security/content-moderation.service';
import { AuditLogRepository } from './audit-log.repository';
import { ROLES_METADATA_KEY } from '../../guards/rbac.decorator';
import { AuthenticatedRequest, JwtPayload, TenantRole } from '../auth/jwt-payload.interface';

/**
 * ParentCommunicationController 单测 (V67 SSOT §5.4 教务家长沟通记录)
 *   - create：内容安全先于建库 + campusId/createdBy 取 JWT + genId32 + audit + 跨校 403 + risky 400
 *   - list：跨校 403 + 学员不存在 404 + 透传 limit/offset
 *   - @Roles：每端点角色门声明（RbacGuard 据此 403 非授权角色）
 *
 * 注：单测直接 new controller，guards（TenantScopeGuard/RbacGuard）不在此跑；
 *   RBAC 通过断言 @Roles metadata 验证（RbacGuard 运行时据此放行/403，guard 自有单测）。
 */
describe('ParentCommunicationController (V67 §5.4 教务家长沟通记录)', () => {
  let controller: ParentCommunicationController;
  let commRepo: { create: jest.Mock; listByStudent: jest.Mock };
  let studentRepo: { findAssignmentInfo: jest.Mock };
  let contentModeration: { enforceStaffText: jest.Mock };
  let auditLog: { log: jest.Mock };

  const TENANT_ID = 'TENANTA00000000000000000000000A1';
  const TENANT_SCHEMA = 'tenant_073e69d6aa5ac5b7e38496d3f57e7cdb';
  const CAMPUS = 'campus0000000000000000000000C001';
  const OTHER_CAMPUS = 'campus0000000000000000000000C999';
  const ACADEMIC = 'academicA0000000000000000000A001';
  const ACADEMIC_ADMIN = 'acadAdmin00000000000000000000X1';
  const BOSS = 'bossUser0000000000000000000000B1';
  const STUDENT = 'student00000000000000000000000S1';
  const COMM_ID = 'comm0000000000000000000000000C01';

  function jwt(role: TenantRole, sub: string, campusId: string | null = CAMPUS): JwtPayload {
    return { sub, tenantId: TENANT_ID, role, campusId };
  }
  function req(user?: JwtPayload): AuthenticatedRequest {
    return { user, headers: {}, body: {}, query: {}, params: {} } as AuthenticatedRequest;
  }

  function commFixture(overrides: Partial<ParentCommunication> = {}): ParentCommunication {
    return {
      id: COMM_ID,
      studentId: STUDENT,
      campusId: CAMPUS,
      communicationDate: '2026-06-02',
      type: 'wechat',
      content: '家长反馈孩子最近作业拖拉',
      followUp: null,
      createdBy: ACADEMIC,
      createdByName: '赵丽',
      createdAt: '2026-06-02T00:00:00.000Z',
      updatedAt: '2026-06-02T00:00:00.000Z',
      ...overrides,
    };
  }

  beforeEach(() => {
    commRepo = {
      create: jest.fn(),
      listByStudent: jest.fn().mockResolvedValue([]),
    };
    // 默认：学员本校（同校）→ 跨校校验通过
    studentRepo = {
      findAssignmentInfo: jest
        .fn()
        .mockResolvedValue({ assignedAcademicId: ACADEMIC, campusId: CAMPUS }),
    };
    contentModeration = { enforceStaffText: jest.fn().mockResolvedValue(undefined) };
    auditLog = { log: jest.fn().mockResolvedValue(undefined) };

    controller = new ParentCommunicationController(
      commRepo as unknown as ParentCommunicationRepository,
      studentRepo as unknown as StudentRepository,
      contentModeration as unknown as ContentModerationService,
      auditLog as unknown as AuditLogRepository,
    );
  });

  // ============================================================
  // 1. 教务记录家长沟通（create）
  // ============================================================
  describe('POST /db/communications — 教务记录家长沟通', () => {
    const body = {
      tenantSchema: TENANT_SCHEMA,
      studentId: STUDENT,
      communicationDate: '2026-06-02',
      type: 'wechat' as const,
      content: '家长反馈孩子最近作业拖拉',
      followUp: '本周末电话回访',
    };

    it('建记录 + audit；内容安全先于建库；campusId/createdBy 取 JWT + genId32', async () => {
      commRepo.create.mockResolvedValue(commFixture());

      const r = await controller.create(body, req(jwt('academic', ACADEMIC)));

      // 内容安全调用，且在 repo.create 之前
      expect(contentModeration.enforceStaffText).toHaveBeenCalledTimes(1);
      const modOrder = contentModeration.enforceStaffText.mock.invocationCallOrder[0];
      const createOrder = commRepo.create.mock.invocationCallOrder[0];
      expect(modOrder).toBeLessThan(createOrder);

      // create 用 campusId(JWT) + createdBy(JWT) + genId32（32 字符）
      const createArg = commRepo.create.mock.calls[0][1];
      expect(createArg.campusId).toBe(CAMPUS);
      expect(createArg.createdBy).toBe(ACADEMIC);
      expect(createArg.id).toHaveLength(32);
      expect(createArg.type).toBe('wechat');

      // audit communication.create
      expect(auditLog.log.mock.calls[0][1].action).toBe('communication.create');
      expect(r.id).toBe(COMM_ID);
    });

    it('content + followUp 一并过内容安全', async () => {
      commRepo.create.mockResolvedValue(commFixture());
      await controller.create(body, req(jwt('academic', ACADEMIC)));
      const texts = contentModeration.enforceStaffText.mock.calls[0][1] as Array<
        string | null | undefined
      >;
      expect(texts).toContain(body.content);
      expect(texts).toContain(body.followUp);
    });

    it('内容安全 risky → 抛 400，不建库', async () => {
      contentModeration.enforceStaffText.mockRejectedValue(
        new BadRequestException('content violates content policy'),
      );
      await expect(
        controller.create(body, req(jwt('academic', ACADEMIC))),
      ).rejects.toThrow(BadRequestException);
      expect(commRepo.create).not.toHaveBeenCalled();
    });

    it('跨校（学员家庭校区 ≠ 调用者校区）→ 403 + 不建库 + 不调内容安全', async () => {
      studentRepo.findAssignmentInfo.mockResolvedValue({
        assignedAcademicId: ACADEMIC,
        campusId: OTHER_CAMPUS,
      });
      await expect(
        controller.create(body, req(jwt('academic', ACADEMIC))),
      ).rejects.toThrow(/COMM_CROSS_CAMPUS/);
      expect(commRepo.create).not.toHaveBeenCalled();
      // 跨校校验先于内容安全外部 API（省微信配额）
      expect(contentModeration.enforceStaffText).not.toHaveBeenCalled();
    });

    it('学员不存在 → 404 + 不建库', async () => {
      studentRepo.findAssignmentInfo.mockResolvedValue(null);
      await expect(
        controller.create(body, req(jwt('academic', ACADEMIC))),
      ).rejects.toThrow(NotFoundException);
      expect(commRepo.create).not.toHaveBeenCalled();
    });

    it('campusId 缺失（JWT 无校区）→ 403', async () => {
      await expect(
        controller.create(body, req(jwt('academic', ACADEMIC, null))),
      ).rejects.toThrow(ForbiddenException);
      expect(commRepo.create).not.toHaveBeenCalled();
    });

    it('studentId 非 32 字符 → 400', async () => {
      await expect(
        controller.create({ ...body, studentId: 'short' }, req(jwt('academic', ACADEMIC))),
      ).rejects.toThrow(BadRequestException);
    });

    it('type 非法枚举 → 400', async () => {
      await expect(
        controller.create(
          { ...body, type: 'sms' as never },
          req(jwt('academic', ACADEMIC)),
        ),
      ).rejects.toThrow(/type must be one of/);
    });

    it('content 空 → 400', async () => {
      await expect(
        controller.create({ ...body, content: '   ' }, req(jwt('academic', ACADEMIC))),
      ).rejects.toThrow(/content required/);
    });

    it('communicationDate 非法 → 400', async () => {
      await expect(
        controller.create(
          { ...body, communicationDate: '2026/06/02' },
          req(jwt('academic', ACADEMIC)),
        ),
      ).rejects.toThrow(/communicationDate must be YYYY-MM-DD/);
    });

    it('academic_admin 同样可写（教务双层）', async () => {
      commRepo.create.mockResolvedValue(commFixture({ createdBy: ACADEMIC_ADMIN }));
      const r = await controller.create(body, req(jwt('academic_admin', ACADEMIC_ADMIN)));
      const createArg = commRepo.create.mock.calls[0][1];
      expect(createArg.createdBy).toBe(ACADEMIC_ADMIN);
      expect(r.id).toBe(COMM_ID);
    });

    it('@Roles = [academic, academic_admin]（其他角色 RbacGuard 403）', () => {
      const roles = Reflect.getMetadata(
        ROLES_METADATA_KEY,
        ParentCommunicationController.prototype.create,
      );
      expect(roles).toEqual(['academic', 'academic_admin']);
    });
  });

  // ============================================================
  // 2. 列出学员家长沟通记录（list）
  // ============================================================
  describe('POST /db/students/:studentId/communications — 列出家长沟通', () => {
    const body = { tenantSchema: TENANT_SCHEMA, limit: 50, offset: 0 };

    it('本校学员 → 返回 items；透传 limit/offset', async () => {
      commRepo.listByStudent.mockResolvedValue([commFixture()]);
      const r = await controller.listByStudent(STUDENT, body, req(jwt('academic', ACADEMIC)));
      expect(r.items).toHaveLength(1);
      expect(commRepo.listByStudent).toHaveBeenCalledWith(TENANT_SCHEMA, STUDENT, {
        limit: 50,
        offset: 0,
      });
    });

    it('boss 监管可读（教务线 + 校长监管）', async () => {
      commRepo.listByStudent.mockResolvedValue([commFixture()]);
      const r = await controller.listByStudent(STUDENT, body, req(jwt('boss', BOSS)));
      expect(r.items).toHaveLength(1);
    });

    it('跨校（学员家庭校区 ≠ 调用者校区）→ 403 + 不查列表', async () => {
      studentRepo.findAssignmentInfo.mockResolvedValue({
        assignedAcademicId: ACADEMIC,
        campusId: OTHER_CAMPUS,
      });
      await expect(
        controller.listByStudent(STUDENT, body, req(jwt('academic', ACADEMIC))),
      ).rejects.toThrow(/COMM_CROSS_CAMPUS/);
      expect(commRepo.listByStudent).not.toHaveBeenCalled();
    });

    it('学员不存在 → 404 + 不查列表', async () => {
      studentRepo.findAssignmentInfo.mockResolvedValue(null);
      await expect(
        controller.listByStudent(STUDENT, body, req(jwt('academic', ACADEMIC))),
      ).rejects.toThrow(NotFoundException);
      expect(commRepo.listByStudent).not.toHaveBeenCalled();
    });

    it('campusId 缺失（JWT 无校区）→ 403', async () => {
      await expect(
        controller.listByStudent(STUDENT, body, req(jwt('academic', ACADEMIC, null))),
      ).rejects.toThrow(ForbiddenException);
      expect(commRepo.listByStudent).not.toHaveBeenCalled();
    });

    it('studentId 非 32 字符 → 400', async () => {
      await expect(
        controller.listByStudent('short', body, req(jwt('academic', ACADEMIC))),
      ).rejects.toThrow(BadRequestException);
    });

    it('@Roles = [academic, academic_admin, boss, admin]（teacher/sales/marketing/finance/hr/parent 排除）', () => {
      const roles = Reflect.getMetadata(
        ROLES_METADATA_KEY,
        ParentCommunicationController.prototype.listByStudent,
      );
      expect(roles).toEqual(['academic', 'academic_admin', 'boss', 'admin']);
    });
  });
});
