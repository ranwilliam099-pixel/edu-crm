import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { FeedbackRuleController } from './feedback-rule.controller';
import { FeedbackRuleConfigRepository } from './feedback-rule-config.repository';
import { PendingFeedbackService } from './pending-feedback.service';
import { AuditLogRepository } from './audit-log.repository';
import {
  AuthenticatedRequest,
  JwtPayload,
} from '../auth/jwt-payload.interface';

/**
 * FeedbackRuleController (V66 Phase 5) 单测
 *   - @Roles 元数据：feedback-rule 读/设 = [boss, admin]；pending-students = [academic, academic_admin]
 *   - campusId 取 JWT；缺失 → 403（禁信前端）
 *   - 维度校验（reminderDays 1-365 / everyNLessons 1-100 / null 清维度，越界 400）
 *   - set upsert + audit 'feedback-rule.set'（before/after）
 *   - pending-students owner-scope = JWT.sub（academicId）
 */
describe('FeedbackRuleController (V66 Phase 5 反馈规则 + 待反馈学员)', () => {
  let controller: FeedbackRuleController;
  let ruleRepo: { get: jest.Mock; upsert: jest.Mock };
  let pendingService: {
    listPendingForAcademic: jest.Mock;
    listPendingForCampus: jest.Mock;
  };
  let auditLog: { log: jest.Mock };

  const TENANT = 'tenant_073e69d6aa5ac5b7e38496d3f57e7cdb';
  const CAMPUS = 'campus0000000000000000000000C001';
  const BOSS = 'boss00000000000000000000000B001U';
  const ACADEMIC = 'academicA0000000000000000000A001';

  const ROLES_KEY = 'rbac_roles'; // guards/rbac.decorator.ts ROLES_METADATA_KEY

  const reqWith = (overrides: Partial<JwtPayload> = {}): AuthenticatedRequest =>
    ({
      user: {
        sub: BOSS,
        tenantId: TENANT,
        role: 'boss',
        campusId: CAMPUS,
        ...overrides,
      } as JwtPayload,
      headers: { 'user-agent': 'jest', 'x-request-id': 'req-1' },
      ip: '127.0.0.1',
    }) as AuthenticatedRequest;

  // 教务 req（pending-students 用）
  const academicReq = (overrides: Partial<JwtPayload> = {}): AuthenticatedRequest =>
    reqWith({ sub: ACADEMIC, role: 'academic', ...overrides });

  beforeEach(() => {
    ruleRepo = { get: jest.fn(), upsert: jest.fn() };
    pendingService = {
      listPendingForAcademic: jest.fn(),
      listPendingForCampus: jest.fn(),
    };
    auditLog = { log: jest.fn().mockResolvedValue(undefined) };
    controller = new FeedbackRuleController(
      ruleRepo as unknown as FeedbackRuleConfigRepository,
      pendingService as unknown as PendingFeedbackService,
      auditLog as unknown as AuditLogRepository,
    );
  });

  // ============================================================
  // @Roles 元数据
  // ============================================================
  describe('@Roles 元数据', () => {
    it('getFeedbackRule / setFeedbackRule = [boss, admin]', () => {
      for (const m of ['getFeedbackRule', 'setFeedbackRule'] as const) {
        const roles = Reflect.getMetadata(
          ROLES_KEY,
          FeedbackRuleController.prototype[m] as any,
        );
        expect(roles).toEqual(['boss', 'admin']);
      }
    });

    it('pendingStudents = [academic, academic_admin]', () => {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        FeedbackRuleController.prototype.pendingStudents as any,
      );
      expect(roles).toEqual(['academic', 'academic_admin']);
    });

    it('feedback-rule 配置端点不含教务/销售/老师/财务等（越权角色不在白名单）', () => {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        FeedbackRuleController.prototype.setFeedbackRule as any,
      ) as string[];
      for (const r of [
        'sales',
        'sales_manager',
        'teacher',
        'academic',
        'academic_admin',
        'finance',
        'marketing',
        'parent',
        'hr',
      ]) {
        expect(roles).not.toContain(r);
      }
    });

    it('pending-students 不含 boss/admin/sales/teacher/finance/parent（教务专属待办）', () => {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        FeedbackRuleController.prototype.pendingStudents as any,
      ) as string[];
      for (const r of [
        'boss',
        'admin',
        'sales',
        'sales_manager',
        'teacher',
        'finance',
        'marketing',
        'parent',
        'hr',
      ]) {
        expect(roles).not.toContain(r);
      }
    });
  });

  // ============================================================
  // getFeedbackRule
  // ============================================================
  describe('getFeedbackRule', () => {
    it('用 JWT.campusId 查（前端不传 campusId）', async () => {
      ruleRepo.get.mockResolvedValueOnce({
        reminderDays: 7,
        everyNLessons: 3,
      });
      const r = await controller.getFeedbackRule(
        { tenantSchema: TENANT },
        reqWith(),
      );
      expect(r.campusId).toBe(CAMPUS);
      expect(r.reminderDays).toBe(7);
      expect(r.everyNLessons).toBe(3);
      expect(ruleRepo.get).toHaveBeenCalledWith(TENANT, CAMPUS);
    });

    it('无配置行 → reminderDays / everyNLessons 默认 null（全关）', async () => {
      ruleRepo.get.mockResolvedValueOnce(null);
      const r = await controller.getFeedbackRule(
        { tenantSchema: TENANT },
        reqWith(),
      );
      expect(r.reminderDays).toBeNull();
      expect(r.everyNLessons).toBeNull();
    });

    it('campusId 缺失 → 403（admin 无校上下文 / token 异常）', async () => {
      await expect(
        controller.getFeedbackRule(
          { tenantSchema: TENANT },
          reqWith({ campusId: null }),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('缺 tenantSchema → 400', async () => {
      await expect(
        controller.getFeedbackRule({ tenantSchema: '' }, reqWith()),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ============================================================
  // setFeedbackRule（upsert + audit + 校验）
  // ============================================================
  describe('setFeedbackRule', () => {
    it('upsert + 写 feedback-rule.set 审计（before/after）', async () => {
      ruleRepo.get.mockResolvedValueOnce({
        reminderDays: null,
        everyNLessons: null,
      });
      ruleRepo.upsert.mockResolvedValueOnce({
        reminderDays: 7,
        everyNLessons: 3,
      });
      const r = await controller.setFeedbackRule(
        { tenantSchema: TENANT, reminderDays: 7, everyNLessons: 3 },
        reqWith(),
      );
      expect(r.reminderDays).toBe(7);
      expect(r.everyNLessons).toBe(3);
      expect(ruleRepo.upsert).toHaveBeenCalledWith(TENANT, CAMPUS, 7, 3, BOSS);
      expect(auditLog.log).toHaveBeenCalledTimes(1);
      const entry = auditLog.log.mock.calls[0][1];
      expect(entry.action).toBe('feedback-rule.set');
      expect(entry.targetId).toBe(CAMPUS);
      expect(entry.before).toEqual({ reminderDays: null, everyNLessons: null });
      expect(entry.after).toEqual({ reminderDays: 7, everyNLessons: 3 });
    });

    it('null 维度透传（清维度）', async () => {
      ruleRepo.get.mockResolvedValueOnce(null);
      ruleRepo.upsert.mockResolvedValueOnce({
        reminderDays: null,
        everyNLessons: 5,
      });
      await controller.setFeedbackRule(
        { tenantSchema: TENANT, reminderDays: null, everyNLessons: 5 },
        reqWith(),
      );
      expect(ruleRepo.upsert).toHaveBeenCalledWith(TENANT, CAMPUS, null, 5, BOSS);
    });

    it('两维度全省略（undefined）→ 都归一 null（全关）', async () => {
      ruleRepo.get.mockResolvedValueOnce(null);
      ruleRepo.upsert.mockResolvedValueOnce({
        reminderDays: null,
        everyNLessons: null,
      });
      await controller.setFeedbackRule({ tenantSchema: TENANT }, reqWith());
      expect(ruleRepo.upsert).toHaveBeenCalledWith(
        TENANT,
        CAMPUS,
        null,
        null,
        BOSS,
      );
    });

    it('reminderDays 越界（0）→ 400，不 upsert', async () => {
      await expect(
        controller.setFeedbackRule(
          { tenantSchema: TENANT, reminderDays: 0 },
          reqWith(),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(ruleRepo.upsert).not.toHaveBeenCalled();
    });

    it('reminderDays 越界（366）→ 400', async () => {
      await expect(
        controller.setFeedbackRule(
          { tenantSchema: TENANT, reminderDays: 366 },
          reqWith(),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('everyNLessons 越界（101）→ 400', async () => {
      await expect(
        controller.setFeedbackRule(
          { tenantSchema: TENANT, everyNLessons: 101 },
          reqWith(),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('everyNLessons 非整数（2.5）→ 400', async () => {
      await expect(
        controller.setFeedbackRule(
          { tenantSchema: TENANT, everyNLessons: 2.5 },
          reqWith(),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('campusId 缺失 → 403', async () => {
      await expect(
        controller.setFeedbackRule(
          { tenantSchema: TENANT, reminderDays: 7 },
          reqWith({ campusId: null }),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('audit fail-open：auditLog.log 抛错不影响主流程', async () => {
      ruleRepo.get.mockResolvedValueOnce(null);
      ruleRepo.upsert.mockResolvedValueOnce({
        reminderDays: 7,
        everyNLessons: null,
      });
      auditLog.log.mockRejectedValueOnce(new Error('audit down'));
      const r = await controller.setFeedbackRule(
        { tenantSchema: TENANT, reminderDays: 7 },
        reqWith(),
      );
      expect(r.reminderDays).toBe(7);
    });
  });

  // ============================================================
  // pendingStudents（教务待反馈，owner-scope=JWT.sub）
  // ============================================================
  describe('pendingStudents', () => {
    it('owner-scope：用 JWT.sub 作 academicId 查本人名下（+ JWT.campusId）', async () => {
      pendingService.listPendingForAcademic.mockResolvedValueOnce({
        items: [
          {
            studentId: 'stu1',
            studentName: '小明',
            lastFeedbackAt: '2026-05-20T00:00:00.000Z',
            daysSinceLast: 10,
            lessonsSinceLast: 2,
            reasons: ['overdue_days'],
          },
        ],
      });
      const r = await controller.pendingStudents(
        { tenantSchema: TENANT, limit: 50 },
        academicReq(),
      );
      expect(r.items).toHaveLength(1);
      expect(pendingService.listPendingForAcademic).toHaveBeenCalledWith(
        TENANT,
        CAMPUS,
        ACADEMIC, // = JWT.sub（不信前端）
        { limit: 50, offset: undefined },
      );
    });

    it('academic_admin = 本校督导视图（2026-06-02 拍板）：走 listPendingForCampus 本校，不传 sub', async () => {
      pendingService.listPendingForCampus.mockResolvedValueOnce({ items: [] });
      const ADMIN_ACAD = 'acadAdminAA000000000000000000A02';
      await controller.pendingStudents(
        { tenantSchema: TENANT, limit: 30 },
        academicReq({ sub: ADMIN_ACAD, role: 'academic_admin' }),
      );
      // 督导视图：按本校 campusId（JWT）查全校教务名下，不按本人 sub
      expect(pendingService.listPendingForCampus).toHaveBeenCalledWith(
        TENANT,
        CAMPUS,
        { limit: 30, offset: undefined },
      );
      // 不应误走本人名下分支
      expect(pendingService.listPendingForAcademic).not.toHaveBeenCalled();
    });

    it('campusId 缺失 → 403', async () => {
      await expect(
        controller.pendingStudents(
          { tenantSchema: TENANT },
          academicReq({ campusId: null }),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('JWT.sub 缺失 → 403（owner-scope 无法确定）', async () => {
      await expect(
        controller.pendingStudents(
          { tenantSchema: TENANT },
          academicReq({ sub: undefined as any }),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('缺 tenantSchema → 400', async () => {
      await expect(
        controller.pendingStudents({ tenantSchema: '' }, academicReq()),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
