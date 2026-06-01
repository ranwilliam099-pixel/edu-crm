import {
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { CampusAssignmentController } from './campus-assignment.controller';
import { CampusAssignmentConfigRepository } from './campus-assignment-config.repository';
import { StudentRepository } from './student.repository';
import { UserRepository } from './user.repository';
import { AuditLogRepository } from './audit-log.repository';
import {
  AuthenticatedRequest,
  JwtPayload,
} from '../auth/jwt-payload.interface';

/**
 * CampusAssignmentController (V63 Phase 3) 单测
 *   - @Roles 严格 = [boss, admin]（非授权角色不在白名单 → RbacGuard 403）
 *   - campusId 一律取自 JWT；缺失 → 403（禁信前端）
 *   - 配置读/设（upsert + audit）
 *   - 待分配列表（本校）
 *   - 手动分配：校验本校在职 academic + 跨校 403 + audit
 *   - 教务选择器
 */
describe('CampusAssignmentController (V63 Phase 3 学员→教务分配)', () => {
  let controller: CampusAssignmentController;
  let configRepo: {
    get: jest.Mock;
    upsertAutoAssign: jest.Mock;
  };
  let studentRepo: {
    listPendingAssignmentByCampus: jest.Mock;
    findAssignmentInfo: jest.Mock;
    setAssignedAcademic: jest.Mock;
  };
  let userRepo: {
    isActiveAcademicInCampus: jest.Mock;
    listActiveAcademicsInCampus: jest.Mock;
  };
  let auditLog: { log: jest.Mock };

  const TENANT = 'tenant_073e69d6aa5ac5b7e38496d3f57e7cdb';
  const CAMPUS = 'campus0000000000000000000000C001';
  const OTHER_CAMPUS = 'campusZ000000000000000000000C099';
  const BOSS = 'boss00000000000000000000000B001U';
  const STUDENT = 'student00000000000000000000S0001';
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

  beforeEach(() => {
    configRepo = {
      get: jest.fn(),
      upsertAutoAssign: jest.fn(),
    };
    studentRepo = {
      listPendingAssignmentByCampus: jest.fn(),
      findAssignmentInfo: jest.fn(),
      setAssignedAcademic: jest.fn(),
    };
    userRepo = {
      isActiveAcademicInCampus: jest.fn(),
      listActiveAcademicsInCampus: jest.fn(),
    };
    auditLog = { log: jest.fn().mockResolvedValue(undefined) };
    controller = new CampusAssignmentController(
      configRepo as unknown as CampusAssignmentConfigRepository,
      studentRepo as unknown as StudentRepository,
      userRepo as unknown as UserRepository,
      auditLog as unknown as AuditLogRepository,
    );
  });

  // ============================================================
  // @Roles 元数据：全 [boss, admin]
  // ============================================================
  describe('@Roles 元数据 = [boss, admin]', () => {
    const methods: Array<keyof CampusAssignmentController> = [
      'getAssignmentConfig',
      'setAssignmentConfig',
      'pendingAssignment',
      'assignAcademic',
      'academicsCampusList',
    ];
    it.each(methods)('%s @Roles = [boss, admin]', (method) => {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        CampusAssignmentController.prototype[method] as any,
      );
      expect(roles).toEqual(['boss', 'admin']);
    });

    it('非授权角色（sales/teacher/academic/finance/parent/hr）不在白名单', () => {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        CampusAssignmentController.prototype.assignAcademic as any,
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
  });

  // ============================================================
  // campusId 取 JWT
  // ============================================================
  describe('campusId 取自 JWT（禁信前端）', () => {
    it('getAssignmentConfig 用 JWT.campusId 查（前端不传 campusId）', async () => {
      configRepo.get.mockResolvedValueOnce({ autoAssignAcademic: true });
      const r = await controller.getAssignmentConfig(
        { tenantSchema: TENANT },
        reqWith(),
      );
      expect(r.campusId).toBe(CAMPUS);
      expect(configRepo.get).toHaveBeenCalledWith(TENANT, CAMPUS);
    });

    it('campusId 缺失 → 403（admin 无校上下文 / token 异常）', async () => {
      await expect(
        controller.getAssignmentConfig(
          { tenantSchema: TENANT },
          reqWith({ campusId: null }),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('pendingAssignment 缺 campusId → 403', async () => {
      await expect(
        controller.pendingAssignment(
          { tenantSchema: TENANT },
          reqWith({ campusId: null }),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('assignAcademic 缺 campusId → 403', async () => {
      await expect(
        controller.assignAcademic(
          STUDENT,
          { tenantSchema: TENANT, academicId: ACADEMIC },
          reqWith({ campusId: null }),
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ============================================================
  // getAssignmentConfig
  // ============================================================
  describe('getAssignmentConfig', () => {
    it('无配置行 → autoAssignAcademic 默认 false', async () => {
      configRepo.get.mockResolvedValueOnce(null);
      const r = await controller.getAssignmentConfig(
        { tenantSchema: TENANT },
        reqWith(),
      );
      expect(r.autoAssignAcademic).toBe(false);
    });

    it('缺 tenantSchema → 400', async () => {
      await expect(
        controller.getAssignmentConfig({ tenantSchema: '' }, reqWith()),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ============================================================
  // setAssignmentConfig（upsert + audit）
  // ============================================================
  describe('setAssignmentConfig', () => {
    it('upsert + 写 campus.assignment-config-set 审计（before/after）', async () => {
      configRepo.get.mockResolvedValueOnce({ autoAssignAcademic: false });
      configRepo.upsertAutoAssign.mockResolvedValueOnce({
        autoAssignAcademic: true,
      });
      const r = await controller.setAssignmentConfig(
        { tenantSchema: TENANT, autoAssignAcademic: true },
        reqWith(),
      );
      expect(r.autoAssignAcademic).toBe(true);
      expect(configRepo.upsertAutoAssign).toHaveBeenCalledWith(
        TENANT,
        CAMPUS,
        true,
        BOSS,
      );
      expect(auditLog.log).toHaveBeenCalledTimes(1);
      const entry = auditLog.log.mock.calls[0][1];
      expect(entry.action).toBe('campus.assignment-config-set');
      expect(entry.targetId).toBe(CAMPUS);
      expect(entry.before.autoAssignAcademic).toBe(false);
      expect(entry.after.autoAssignAcademic).toBe(true);
    });

    it('autoAssignAcademic 非 boolean → 400', async () => {
      await expect(
        controller.setAssignmentConfig(
          { tenantSchema: TENANT, autoAssignAcademic: 'yes' as any },
          reqWith(),
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ============================================================
  // pendingAssignment（本校待分配列表）
  // ============================================================
  describe('pendingAssignment', () => {
    it('返回本校 assigned_academic_id IS NULL 学员（campus 取 JWT）', async () => {
      studentRepo.listPendingAssignmentByCampus.mockResolvedValueOnce([
        { id: STUDENT, studentName: '小明', parentName: '王妈' },
      ]);
      const r = await controller.pendingAssignment(
        { tenantSchema: TENANT, limit: 50 },
        reqWith(),
      );
      expect(r.items).toHaveLength(1);
      expect(studentRepo.listPendingAssignmentByCampus).toHaveBeenCalledWith(
        TENANT,
        CAMPUS,
        { limit: 50, offset: 0 },
      );
    });

    it('limit 上限 200', async () => {
      studentRepo.listPendingAssignmentByCampus.mockResolvedValueOnce([]);
      await controller.pendingAssignment(
        { tenantSchema: TENANT, limit: 9999 },
        reqWith(),
      );
      const opts = studentRepo.listPendingAssignmentByCampus.mock.calls[0][2];
      expect(opts.limit).toBe(200);
    });
  });

  // ============================================================
  // assignAcademic（手动分配）
  // ============================================================
  describe('assignAcademic', () => {
    it('本校在职 academic → set + 写 student.manual_assigned 审计', async () => {
      studentRepo.findAssignmentInfo.mockResolvedValueOnce({
        assignedAcademicId: null,
        campusId: CAMPUS,
      });
      userRepo.isActiveAcademicInCampus.mockResolvedValueOnce(true);
      studentRepo.setAssignedAcademic.mockResolvedValueOnce(undefined);

      const r = await controller.assignAcademic(
        STUDENT,
        { tenantSchema: TENANT, academicId: ACADEMIC },
        reqWith(),
      );
      expect(r.assignedAcademicId).toBe(ACADEMIC);
      expect(studentRepo.setAssignedAcademic).toHaveBeenCalledWith(
        TENANT,
        STUDENT,
        ACADEMIC,
        BOSS,
      );
      const entry = auditLog.log.mock.calls[0][1];
      expect(entry.action).toBe('student.manual_assigned');
      expect(entry.before.assignedAcademicId).toBeNull();
      expect(entry.after.assignedAcademicId).toBe(ACADEMIC);
    });

    it('academicId 非本校在职 academic → 400，不 set', async () => {
      studentRepo.findAssignmentInfo.mockResolvedValueOnce({
        assignedAcademicId: null,
        campusId: CAMPUS,
      });
      userRepo.isActiveAcademicInCampus.mockResolvedValueOnce(false);
      await expect(
        controller.assignAcademic(
          STUDENT,
          { tenantSchema: TENANT, academicId: ACADEMIC },
          reqWith(),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(studentRepo.setAssignedAcademic).not.toHaveBeenCalled();
    });

    it('学员家庭校区 ≠ 本校 → 403（跨校分配拒绝），不校验 academic', async () => {
      studentRepo.findAssignmentInfo.mockResolvedValueOnce({
        assignedAcademicId: null,
        campusId: OTHER_CAMPUS,
      });
      await expect(
        controller.assignAcademic(
          STUDENT,
          { tenantSchema: TENANT, academicId: ACADEMIC },
          reqWith(),
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(userRepo.isActiveAcademicInCampus).not.toHaveBeenCalled();
    });

    it('学员不存在 → 400', async () => {
      studentRepo.findAssignmentInfo.mockResolvedValueOnce(null);
      await expect(
        controller.assignAcademic(
          STUDENT,
          { tenantSchema: TENANT, academicId: ACADEMIC },
          reqWith(),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('academicId 非 32 位 → 400', async () => {
      await expect(
        controller.assignAcademic(
          STUDENT,
          { tenantSchema: TENANT, academicId: 'short' },
          reqWith(),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('studentId 非 32 位 → 400', async () => {
      await expect(
        controller.assignAcademic(
          'short',
          { tenantSchema: TENANT, academicId: ACADEMIC },
          reqWith(),
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ============================================================
  // academicsCampusList（教务选择器）
  // ============================================================
  describe('academicsCampusList', () => {
    it('列本校在职教务（campus 取 JWT）', async () => {
      userRepo.listActiveAcademicsInCampus.mockResolvedValueOnce([
        { id: ACADEMIC, name: '李教务', role: 'academic' },
      ]);
      const r = await controller.academicsCampusList(
        { tenantSchema: TENANT },
        reqWith(),
      );
      expect(r.items).toHaveLength(1);
      expect(userRepo.listActiveAcademicsInCampus).toHaveBeenCalledWith(
        TENANT,
        CAMPUS,
        ['academic'],
      );
    });

    it('缺 campusId → 403', async () => {
      await expect(
        controller.academicsCampusList(
          { tenantSchema: TENANT },
          reqWith({ campusId: null }),
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
