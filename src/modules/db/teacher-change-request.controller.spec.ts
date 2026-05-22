import { TeacherChangeRequestController } from './teacher-change-request.controller';
import { TeacherChangeRequestService } from './teacher-change-request.service';
import { AuditLogRepository } from './audit-log.repository';
import {
  AuthenticatedRequest,
  JwtPayload,
  TenantRole,
} from '../auth/jwt-payload.interface';
import { BadRequestException, ForbiddenException } from '@nestjs/common';

describe('TeacherChangeRequestController (V58 2026-05-22 SSOT §6.5)', () => {
  let controller: TeacherChangeRequestController;
  let svc: {
    request: jest.Mock;
    parentDecide: jest.Mock;
    listPendingByCampus: jest.Mock;
    listPendingByParent: jest.Mock;
    cancel: jest.Mock;
    listEligibleTeachersForCampus: jest.Mock;
  };
  let auditLog: { log: jest.Mock };

  const TENANT_SCHEMA = 'tenant_tenanta00000000000000000000000a1';
  const CAMPUS_A = 'campus0000000000000000000000A001';
  const CAMPUS_B = 'campus0000000000000000000000B002';
  const ACADEMIC_SUB = 'academic00000000000000000000A001';  // 32
  const PARENT_SUB = 'parentSUB00000000000000000000P01';   // 32
  const PARENT_ID = 'parentID0000000000000000000000P01';   // 33 (unused for B-side)
  const STUDENT_ID = 'studentaa0000000000000000000aa01';   // 32
  const TEACHER_FROM = 'teacherFrom000000000000000000T01'; // 32
  const TEACHER_TO = 'teacherToo000000000000000000000T';   // 32
  const REQUEST_ID = 'reqRequest00000000000000000000R0';   // 32

  function jwt(
    role: TenantRole | 'parent',
    sub: string,
    campusId: string | null = CAMPUS_A,
    extra: Record<string, any> = {},
  ): JwtPayload {
    return {
      sub,
      tenantId: 'tenant',
      tenantSchema: TENANT_SCHEMA,
      role: role as TenantRole,
      campusId: campusId || undefined,
      ...extra,
    } as JwtPayload;
  }

  function req(payload: JwtPayload): AuthenticatedRequest {
    return {
      user: payload,
      ip: '127.0.0.1',
      headers: {},
    } as unknown as AuthenticatedRequest;
  }

  beforeEach(() => {
    svc = {
      request: jest.fn(),
      parentDecide: jest.fn(),
      listPendingByCampus: jest.fn().mockResolvedValue([]),
      listPendingByParent: jest.fn().mockResolvedValue([]),
      cancel: jest.fn(),
      listEligibleTeachersForCampus: jest.fn().mockResolvedValue([]),
    };
    auditLog = { log: jest.fn().mockResolvedValue(undefined) };
    controller = new TeacherChangeRequestController(
      svc as unknown as TeacherChangeRequestService,
      auditLog as unknown as AuditLogRepository,
    );
  });

  // ============================================================
  // POST /db/teacher-changes/request (academic 发起)
  // ============================================================
  describe('createRequest POST /db/teacher-changes/request', () => {
    const validBody = {
      tenantSchema: TENANT_SCHEMA,
      studentId: STUDENT_ID,
      toTeacherId: TEACHER_TO,
      reason: '老师风格不匹配',
    };

    it('happy path: academic 发起 → service.request + audit_log', async () => {
      svc.request.mockResolvedValueOnce({ id: REQUEST_ID });
      const r = await controller.createRequest(
        validBody,
        req(jwt('academic', ACADEMIC_SUB, CAMPUS_A)),
      );
      expect(r.id).toBe(REQUEST_ID);
      expect(svc.request).toHaveBeenCalledWith({
        tenantSchema: TENANT_SCHEMA,
        studentId: STUDENT_ID,
        toTeacherId: TEACHER_TO,
        reason: '老师风格不匹配',
        requestedByUserId: ACADEMIC_SUB,
        campusId: CAMPUS_A,
      });
      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        expect.objectContaining({
          action: 'teacher.change-requested-by-academic',
          targetType: 'teacher_change_request',
          targetId: REQUEST_ID,
        }),
      );
    });

    it('academic 缺 jwt.campusId → 403', async () => {
      await expect(
        controller.createRequest(
          validBody,
          req(jwt('academic', ACADEMIC_SUB, null)),
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(svc.request).not.toHaveBeenCalled();
    });

    it('缺 tenantSchema → BadRequest', async () => {
      await expect(
        controller.createRequest(
          { ...validBody, tenantSchema: '' },
          req(jwt('academic', ACADEMIC_SUB, CAMPUS_A)),
        ),
      ).rejects.toThrow(/tenantSchema required/);
    });

    it('studentId 非 32 字符 → BadRequest', async () => {
      await expect(
        controller.createRequest(
          { ...validBody, studentId: 'short' },
          req(jwt('academic', ACADEMIC_SUB, CAMPUS_A)),
        ),
      ).rejects.toThrow(/studentId must be 32-char/);
    });

    it('toTeacherId 非 32 字符 → BadRequest', async () => {
      await expect(
        controller.createRequest(
          { ...validBody, toTeacherId: '' },
          req(jwt('academic', ACADEMIC_SUB, CAMPUS_A)),
        ),
      ).rejects.toThrow(/toTeacherId must be 32-char/);
    });
  });

  // ============================================================
  // GET /db/teacher-changes/pending (academic 本校)
  // ============================================================
  describe('listPending GET /db/teacher-changes/pending', () => {
    it('happy path academic: jwt.campusId 一致 → 透传 service', async () => {
      svc.listPendingByCampus.mockResolvedValueOnce([
        { id: REQUEST_ID, status: 'pending' } as any,
      ]);
      const r = await controller.listPending(
        TENANT_SCHEMA,
        CAMPUS_A,
        req(jwt('academic', ACADEMIC_SUB, CAMPUS_A)),
      );
      expect(r.items).toHaveLength(1);
      expect(svc.listPendingByCampus).toHaveBeenCalledWith(TENANT_SCHEMA, CAMPUS_A);
    });

    it('academic 查他校 campusId → 403', async () => {
      await expect(
        controller.listPending(
          TENANT_SCHEMA,
          CAMPUS_B,
          req(jwt('academic', ACADEMIC_SUB, CAMPUS_A)),
        ),
      ).rejects.toThrow(/CROSS_CAMPUS_DENIED/);
      expect(svc.listPendingByCampus).not.toHaveBeenCalled();
    });

    it('缺 campusId → BadRequest', async () => {
      await expect(
        controller.listPending(
          TENANT_SCHEMA,
          '',
          req(jwt('academic', ACADEMIC_SUB, CAMPUS_A)),
        ),
      ).rejects.toThrow(/campusId required/);
    });
  });

  // ============================================================
  // POST /db/teacher-changes/:id/cancel (academic 撤回)
  // ============================================================
  describe('cancel POST /db/teacher-changes/:id/cancel', () => {
    it('happy path: pending → cancelled + audit', async () => {
      svc.cancel.mockResolvedValueOnce({ updated: true });
      const r = await controller.cancel(
        REQUEST_ID,
        { tenantSchema: TENANT_SCHEMA },
        req(jwt('academic', ACADEMIC_SUB, CAMPUS_A)),
      );
      expect(r.updated).toBe(true);
      expect(svc.cancel).toHaveBeenCalledWith(TENANT_SCHEMA, REQUEST_ID, ACADEMIC_SUB);
      expect(auditLog.log).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        expect.objectContaining({
          action: 'teacher.change-cancelled-by-academic',
        }),
      );
    });

    it('id 非 32 字符 → BadRequest', async () => {
      await expect(
        controller.cancel(
          'short',
          { tenantSchema: TENANT_SCHEMA },
          req(jwt('academic', ACADEMIC_SUB, CAMPUS_A)),
        ),
      ).rejects.toThrow(/id must be 32-char/);
    });
  });

  // 注: parent-pending / parent-decide endpoints split to c-side module (Sprint Y P3.1)
  //   走另一套 JWT (ParentJwtStrategy) + ParentSelfGuard, 不在本 controller spec

  // ============================================================
  // GET /db/teacher-changes/eligible-teachers (波 B 教务发起 page 用)
  // ============================================================
  describe('listEligibleTeachers GET /db/teacher-changes/eligible-teachers', () => {
    it('happy path academic: jwt.campusId 一致 → 透传 service', async () => {
      svc.listEligibleTeachersForCampus.mockResolvedValueOnce([
        { id: 't1', name: '老师·王', subjects: ['数学'], status: '在职' },
      ]);
      const r = await controller.listEligibleTeachers(
        TENANT_SCHEMA,
        CAMPUS_A,
        req(jwt('academic', ACADEMIC_SUB, CAMPUS_A)),
      );
      expect(r.items).toHaveLength(1);
      expect(svc.listEligibleTeachersForCampus).toHaveBeenCalledWith(TENANT_SCHEMA, CAMPUS_A);
    });

    it('academic 查他校 → 403', async () => {
      await expect(
        controller.listEligibleTeachers(
          TENANT_SCHEMA,
          CAMPUS_B,
          req(jwt('academic', ACADEMIC_SUB, CAMPUS_A)),
        ),
      ).rejects.toThrow(/CROSS_CAMPUS_DENIED/);
      expect(svc.listEligibleTeachersForCampus).not.toHaveBeenCalled();
    });

    it('admin 跨校任意 campusId 可查', async () => {
      await controller.listEligibleTeachers(
        TENANT_SCHEMA,
        CAMPUS_B,
        req(jwt('admin', 'admin00000000000000000000000A001', null)),
      );
      expect(svc.listEligibleTeachersForCampus).toHaveBeenCalledWith(TENANT_SCHEMA, CAMPUS_B);
    });

    it('缺 campusId → BadRequest', async () => {
      await expect(
        controller.listEligibleTeachers(
          TENANT_SCHEMA,
          '',
          req(jwt('academic', ACADEMIC_SUB, CAMPUS_A)),
        ),
      ).rejects.toThrow(/campusId required/);
    });
  });
});
