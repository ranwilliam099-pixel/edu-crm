import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { TrialController } from './trial.controller';
import { Trial, TrialRepository } from './trial.repository';
import { TrialAssignmentService } from './trial-assignment.service';
import { UserRepository } from './user.repository';
import { TeacherRepository } from './teacher.repository';
import { ContentModerationService } from '../security/content-moderation.service';
import { CustomerRepository } from './customer.repository';
import { AuditLogRepository } from './audit-log.repository';
import { ROLES_METADATA_KEY } from '../../guards/rbac.decorator';
import { AuthenticatedRequest, JwtPayload, TenantRole } from '../auth/jwt-payload.interface';

/**
 * TrialController 单测 (V64 Phase 4 试听课流程)
 *   - 发起：建 + 触发分配（auto / manual）+ 内容安全 + campusId JWT + audit
 *   - 状态机：非法转移拒绝（pending_assign 不能直接 arrange 等）
 *   - 排老师：冲突校验（teacher 该时段 schedules+trials 占用 → 400）
 *   - @Roles：每端点角色门声明（RbacGuard 据此 403 非授权角色）
 *   - campusId 取自 JWT（缺失 → 403）
 *   - converted / lost 结果 + 内容安全
 *
 * 注：单测直接 new controller，guards（TenantScopeGuard/RbacGuard）不在此跑；
 *   RBAC 通过断言 @Roles metadata 验证（RbacGuard 运行时据此放行/403，guard 自有单测）。
 */
describe('TrialController (V64 Phase 4 试听课流程)', () => {
  let controller: TrialController;
  let trialRepo: {
    create: jest.Mock;
    findById: jest.Mock;
    list: jest.Mock;
    assignAcademic: jest.Mock;
    arrange: jest.Mock;
    complete: jest.Mock;
    setResult: jest.Mock;
    findTeacherConflicts: jest.Mock;
    requireExists: jest.Mock;
  };
  let assignmentService: { assignTrialIfNeeded: jest.Mock };
  let userRepo: { isActiveAcademicInCampus: jest.Mock };
  let teacherRepo: { findById: jest.Mock };
  let contentModeration: { enforceStaffText: jest.Mock };
  let customerRepo: { findOwnershipById: jest.Mock };
  let auditLog: { log: jest.Mock };

  const TENANT_ID = 'TENANTA00000000000000000000000A1';
  const TENANT_SCHEMA = 'tenant_073e69d6aa5ac5b7e38496d3f57e7cdb';
  const CAMPUS = 'campus0000000000000000000000C001';
  const OTHER_CAMPUS = 'campus0000000000000000000000C999';
  const SALES = 'salesUser000000000000000000000S1';
  const OTHER_SALES = 'salesUser000000000000000000000S2';
  const SALES_MGR = 'salesMgr0000000000000000000000M1';
  const ACADEMIC = 'academicA0000000000000000000A001';
  const BOSS = 'bossUser0000000000000000000000B1';
  const TRIAL_ID = 'trial000000000000000000000000T01';
  const CUSTOMER = 'customer0000000000000000000000C1';
  const TEACHER = 'teacher00000000000000000000000T1';

  function jwt(role: TenantRole, sub: string, campusId: string | null = CAMPUS): JwtPayload {
    return { sub, tenantId: TENANT_ID, role, campusId };
  }
  function req(user?: JwtPayload): AuthenticatedRequest {
    return { user, headers: {}, body: {}, query: {}, params: {} } as AuthenticatedRequest;
  }

  function trialFixture(overrides: Partial<Trial> = {}): Trial {
    return {
      id: TRIAL_ID,
      customerId: CUSTOMER,
      studentName: '小明',
      subject: '数学',
      preferredTime: '周六上午',
      scheduledAt: null,
      status: 'pending_assign',
      assignedAcademicId: null,
      teacherId: null,
      campusId: CAMPUS,
      initiatedBy: SALES,
      resultNote: null,
      convertedContractId: null,
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      ...overrides,
    };
  }

  beforeEach(() => {
    trialRepo = {
      create: jest.fn(),
      findById: jest.fn(),
      list: jest.fn().mockResolvedValue([]),
      assignAcademic: jest.fn(),
      arrange: jest.fn(),
      complete: jest.fn(),
      setResult: jest.fn(),
      findTeacherConflicts: jest.fn().mockResolvedValue([]),
      requireExists: jest.fn(),
    };
    assignmentService = { assignTrialIfNeeded: jest.fn().mockResolvedValue({ assigned: false }) };
    userRepo = { isActiveAcademicInCampus: jest.fn().mockResolvedValue(true) };
    teacherRepo = {
      findById: jest.fn().mockResolvedValue({ id: TEACHER, campusId: CAMPUS, status: '在职' }),
    };
    contentModeration = { enforceStaffText: jest.fn().mockResolvedValue(undefined) };
    // 默认：客户归属 SALES（自己客户）+ 同校 → owner-scope 通过（不影响既有用例）
    customerRepo = {
      findOwnershipById: jest
        .fn()
        .mockResolvedValue({ ownerUserId: SALES, campusId: CAMPUS }),
    };
    auditLog = { log: jest.fn().mockResolvedValue(undefined) };

    controller = new TrialController(
      trialRepo as unknown as TrialRepository,
      assignmentService as unknown as TrialAssignmentService,
      userRepo as unknown as UserRepository,
      teacherRepo as unknown as TeacherRepository,
      contentModeration as unknown as ContentModerationService,
      auditLog as unknown as AuditLogRepository,
      customerRepo as unknown as CustomerRepository,
    );
  });

  // ============================================================
  // 1. 发起试听
  // ============================================================
  describe('POST /db/trials — 发起试听', () => {
    const body = {
      tenantSchema: TENANT_SCHEMA,
      customerId: CUSTOMER,
      studentName: '小明',
      subject: '数学',
      preferredTime: '周六上午',
    };

    it('建 trial + 触发分配 + audit；内容安全先于建库', async () => {
      const created = trialFixture();
      trialRepo.create.mockResolvedValue(created);
      // 分配后重读：auto on 把状态推到 pending_teacher
      trialRepo.findById.mockResolvedValue(
        trialFixture({ status: 'pending_teacher', assignedAcademicId: ACADEMIC }),
      );

      const r = await controller.create(body, req(jwt('sales', SALES)));

      // 内容安全调用，且在 repo.create 之前
      expect(contentModeration.enforceStaffText).toHaveBeenCalledTimes(1);
      const modOrder = contentModeration.enforceStaffText.mock.invocationCallOrder[0];
      const createOrder = trialRepo.create.mock.invocationCallOrder[0];
      expect(modOrder).toBeLessThan(createOrder);

      // create 用 campusId(JWT) + initiatedBy(JWT) + genId32（32 字符）
      const createArg = trialRepo.create.mock.calls[0][1];
      expect(createArg.campusId).toBe(CAMPUS);
      expect(createArg.initiatedBy).toBe(SALES);
      expect(createArg.id).toHaveLength(32);

      // 触发分配
      expect(assignmentService.assignTrialIfNeeded).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        createArg.id,
        CAMPUS,
        { userId: SALES, role: 'sales' },
      );
      // audit trial.create
      expect(auditLog.log.mock.calls[0][1].action).toBe('trial.create');
      // 返回分配后最新态
      expect(r.status).toBe('pending_teacher');
      expect(r.assignedAcademicId).toBe(ACADEMIC);
    });

    it('内容安全 risky → 抛 400，不建库不分配', async () => {
      contentModeration.enforceStaffText.mockRejectedValue(
        new BadRequestException('content violates content policy'),
      );
      await expect(controller.create(body, req(jwt('sales', SALES)))).rejects.toThrow(
        BadRequestException,
      );
      expect(trialRepo.create).not.toHaveBeenCalled();
      expect(assignmentService.assignTrialIfNeeded).not.toHaveBeenCalled();
    });

    it('分配失败 fail-open：发起仍成功（返回 created）', async () => {
      const created = trialFixture();
      trialRepo.create.mockResolvedValue(created);
      assignmentService.assignTrialIfNeeded.mockRejectedValue(new Error('db down'));
      trialRepo.findById.mockResolvedValue(created);
      const r = await controller.create(body, req(jwt('sales', SALES)));
      expect(r.id).toBe(TRIAL_ID);
    });

    it('campusId 缺失（JWT 无校区）→ 403', async () => {
      await expect(
        controller.create(body, req(jwt('sales', SALES, null))),
      ).rejects.toThrow(ForbiddenException);
      expect(trialRepo.create).not.toHaveBeenCalled();
    });

    it('customerId 非 32 字符 → 400', async () => {
      await expect(
        controller.create({ ...body, customerId: 'short' }, req(jwt('sales', SALES))),
      ).rejects.toThrow(BadRequestException);
    });

    // ---- 2026-06-01 customer owner-scope（中危 IDOR 收口） ----
    it('owner-scope：sales 自己的客户（owner=me + 本校）→ 通过、建库', async () => {
      customerRepo.findOwnershipById.mockResolvedValue({
        ownerUserId: SALES,
        campusId: CAMPUS,
      });
      const created = trialFixture();
      trialRepo.create.mockResolvedValue(created);
      trialRepo.findById.mockResolvedValue(created);
      const r = await controller.create(body, req(jwt('sales', SALES)));
      expect(r.id).toBe(TRIAL_ID);
      // scope 查询用 body.customerId
      expect(customerRepo.findOwnershipById).toHaveBeenCalledWith(TENANT_SCHEMA, CUSTOMER);
      // owner-scope 校验在 repo.create 之前
      const scopeOrder = customerRepo.findOwnershipById.mock.invocationCallOrder[0];
      const createOrder = trialRepo.create.mock.invocationCallOrder[0];
      expect(scopeOrder).toBeLessThan(createOrder);
    });

    it('owner-scope：sales 给他人客户发起（owner≠me）→ 403 + 不建库 + audit denied', async () => {
      customerRepo.findOwnershipById.mockResolvedValue({
        ownerUserId: OTHER_SALES,
        campusId: CAMPUS,
      });
      await expect(controller.create(body, req(jwt('sales', SALES)))).rejects.toThrow(
        /TRIAL_CREATE_NOT_OWN_CUSTOMER/,
      );
      expect(trialRepo.create).not.toHaveBeenCalled();
      expect(assignmentService.assignTrialIfNeeded).not.toHaveBeenCalled();
      // 拒绝路径 audit
      expect(auditLog.log.mock.calls[0][1].action).toBe('trial.create-denied');
      expect(auditLog.log.mock.calls[0][1].after.reason).toBe('not-own-customer');
    });

    it('owner-scope：客户跨校（campus≠caller）→ 403 + 不建库 + audit denied', async () => {
      customerRepo.findOwnershipById.mockResolvedValue({
        ownerUserId: SALES,
        campusId: OTHER_CAMPUS,
      });
      await expect(controller.create(body, req(jwt('sales', SALES)))).rejects.toThrow(
        /TRIAL_CREATE_CROSS_CAMPUS/,
      );
      expect(trialRepo.create).not.toHaveBeenCalled();
      expect(auditLog.log.mock.calls[0][1].action).toBe('trial.create-denied');
      expect(auditLog.log.mock.calls[0][1].after.reason).toBe('cross-campus');
    });

    it('owner-scope：customer 不存在 → 400 + 不建库', async () => {
      customerRepo.findOwnershipById.mockResolvedValue(null);
      await expect(controller.create(body, req(jwt('sales', SALES)))).rejects.toThrow(
        /TRIAL_CUSTOMER_NOT_FOUND/,
      );
      expect(trialRepo.create).not.toHaveBeenCalled();
    });

    it('owner-scope：sales_manager（admin group）非自己客户但本校 → 通过（不 owner 收口）', async () => {
      // sales_manager 经 actorGroupOf → admin group：本校放行，不要求 owner=me
      customerRepo.findOwnershipById.mockResolvedValue({
        ownerUserId: OTHER_SALES,
        campusId: CAMPUS,
      });
      const created = trialFixture();
      trialRepo.create.mockResolvedValue(created);
      trialRepo.findById.mockResolvedValue(created);
      const r = await controller.create(body, req(jwt('sales_manager', SALES_MGR)));
      expect(r.id).toBe(TRIAL_ID);
      expect(trialRepo.create).toHaveBeenCalled();
    });

    it('owner-scope：sales_manager 跨校客户 → 403（admin group 仍受本校约束）', async () => {
      customerRepo.findOwnershipById.mockResolvedValue({
        ownerUserId: OTHER_SALES,
        campusId: OTHER_CAMPUS,
      });
      await expect(
        controller.create(body, req(jwt('sales_manager', SALES_MGR))),
      ).rejects.toThrow(/TRIAL_CREATE_CROSS_CAMPUS/);
      expect(trialRepo.create).not.toHaveBeenCalled();
    });

    it('owner-scope：customerRepo 未注入（@Optional）→ 跳过校验（fail-open，兼容旧装配）', async () => {
      const c = new TrialController(
        trialRepo as unknown as TrialRepository,
        assignmentService as unknown as TrialAssignmentService,
        userRepo as unknown as UserRepository,
        teacherRepo as unknown as TeacherRepository,
        contentModeration as unknown as ContentModerationService,
        auditLog as unknown as AuditLogRepository,
        undefined,
      );
      const created = trialFixture();
      trialRepo.create.mockResolvedValue(created);
      trialRepo.findById.mockResolvedValue(created);
      const r = await c.create(body, req(jwt('sales', SALES)));
      expect(r.id).toBe(TRIAL_ID);
      expect(customerRepo.findOwnershipById).not.toHaveBeenCalled();
    });

    it('@Roles = [sales, sales_manager]（其他角色 RbacGuard 403）', () => {
      const roles = Reflect.getMetadata(ROLES_METADATA_KEY, TrialController.prototype.create);
      expect(roles).toEqual(['sales', 'sales_manager']);
    });
  });

  // ============================================================
  // 2. 校长手动派教务 — 状态机 + 同校 + academic 校验
  // ============================================================
  describe('POST /db/trials/:id/assign-academic — 校长手动派', () => {
    const body = { tenantSchema: TENANT_SCHEMA, academicId: ACADEMIC };

    it('pending_assign → 派教务成功 + audit', async () => {
      trialRepo.requireExists.mockResolvedValue(trialFixture({ status: 'pending_assign' }));
      trialRepo.assignAcademic.mockResolvedValue(
        trialFixture({ status: 'pending_teacher', assignedAcademicId: ACADEMIC }),
      );
      const r = await controller.assignAcademic(TRIAL_ID, body, req(jwt('boss', BOSS)));
      expect(r.status).toBe('pending_teacher');
      expect(userRepo.isActiveAcademicInCampus).toHaveBeenCalled();
      expect(auditLog.log.mock.calls[0][1].action).toBe('trial.assign-academic');
    });

    it('状态非 pending_assign（已 scheduled）→ 400 非法转移', async () => {
      trialRepo.requireExists.mockResolvedValue(trialFixture({ status: 'scheduled' }));
      await expect(
        controller.assignAcademic(TRIAL_ID, body, req(jwt('boss', BOSS))),
      ).rejects.toThrow(/TRIAL_INVALID_TRANSITION/);
      expect(trialRepo.assignAcademic).not.toHaveBeenCalled();
    });

    it('跨校（trial 校区 ≠ 调用者校区）→ 403', async () => {
      trialRepo.requireExists.mockResolvedValue(trialFixture({ campusId: OTHER_CAMPUS }));
      await expect(
        controller.assignAcademic(TRIAL_ID, body, req(jwt('boss', BOSS))),
      ).rejects.toThrow(ForbiddenException);
    });

    it('目标 academicId 非本校在职 academic → 400', async () => {
      trialRepo.requireExists.mockResolvedValue(trialFixture({ status: 'pending_assign' }));
      userRepo.isActiveAcademicInCampus.mockResolvedValue(false);
      await expect(
        controller.assignAcademic(TRIAL_ID, body, req(jwt('boss', BOSS))),
      ).rejects.toThrow(/TRIAL_INVALID_ACADEMIC/);
    });

    it('trial 不存在 → NotFound（repo.requireExists 抛）', async () => {
      trialRepo.requireExists.mockRejectedValue(new NotFoundException('trial not found'));
      await expect(
        controller.assignAcademic(TRIAL_ID, body, req(jwt('boss', BOSS))),
      ).rejects.toThrow(NotFoundException);
    });

    it('@Roles = [boss, admin]', () => {
      const roles = Reflect.getMetadata(ROLES_METADATA_KEY, TrialController.prototype.assignAcademic);
      expect(roles).toEqual(['boss', 'admin']);
    });
  });

  // ============================================================
  // 3. 教务排老师 — 状态机 + 冲突校验
  // ============================================================
  describe('POST /db/trials/:id/arrange — 排老师 + 冲突校验', () => {
    const body = {
      tenantSchema: TENANT_SCHEMA,
      teacherId: TEACHER,
      scheduledAt: '2026-06-10T02:00:00.000Z',
    };

    it('pending_teacher + 无冲突 → scheduled + audit', async () => {
      trialRepo.requireExists.mockResolvedValue(trialFixture({ status: 'pending_teacher' }));
      trialRepo.findTeacherConflicts.mockResolvedValue([]);
      trialRepo.arrange.mockResolvedValue(
        trialFixture({ status: 'scheduled', teacherId: TEACHER, scheduledAt: body.scheduledAt }),
      );
      const r = await controller.arrange(TRIAL_ID, body, req(jwt('academic', ACADEMIC)));
      expect(r.status).toBe('scheduled');
      // 冲突校验排除自身 id
      const conflictArgs = trialRepo.findTeacherConflicts.mock.calls[0];
      expect(conflictArgs[1]).toBe(TEACHER);
      expect(conflictArgs[5]).toBe(TRIAL_ID);
      expect(auditLog.log.mock.calls[0][1].action).toBe('trial.arrange');
    });

    it('老师该时段已被占用（schedules/trials）→ 400 含冲突信息', async () => {
      trialRepo.requireExists.mockResolvedValue(trialFixture({ status: 'pending_teacher' }));
      trialRepo.findTeacherConflicts.mockResolvedValue([
        { source: 'schedule', id: 'sch1', startAt: 'x', endAt: 'y' },
      ]);
      await expect(
        controller.arrange(TRIAL_ID, body, req(jwt('academic', ACADEMIC))),
      ).rejects.toThrow(/TRIAL_TEACHER_CONFLICT/);
      expect(trialRepo.arrange).not.toHaveBeenCalled();
    });

    it('状态非 pending_teacher（仍 pending_assign）→ 400 非法转移（不能跳过分配直接排）', async () => {
      trialRepo.requireExists.mockResolvedValue(trialFixture({ status: 'pending_assign' }));
      await expect(
        controller.arrange(TRIAL_ID, body, req(jwt('academic', ACADEMIC))),
      ).rejects.toThrow(/TRIAL_INVALID_TRANSITION/);
      expect(trialRepo.findTeacherConflicts).not.toHaveBeenCalled();
    });

    it('老师已归档 → 400', async () => {
      trialRepo.requireExists.mockResolvedValue(trialFixture({ status: 'pending_teacher' }));
      teacherRepo.findById.mockResolvedValue({ id: TEACHER, campusId: CAMPUS, status: '归档' });
      await expect(
        controller.arrange(TRIAL_ID, body, req(jwt('academic', ACADEMIC))),
      ).rejects.toThrow(/TRIAL_INVALID_TEACHER/);
    });

    it('老师跨校 → 403', async () => {
      trialRepo.requireExists.mockResolvedValue(trialFixture({ status: 'pending_teacher' }));
      teacherRepo.findById.mockResolvedValue({ id: TEACHER, campusId: OTHER_CAMPUS, status: '在职' });
      await expect(
        controller.arrange(TRIAL_ID, body, req(jwt('academic', ACADEMIC))),
      ).rejects.toThrow(ForbiddenException);
    });

    // 2026-06-01：trial 跨校（trial 校区 ≠ 调用教务校区）→ 403（与 assign/complete/result 对称）
    it('trial 跨校（trial.campusId ≠ caller campus）→ 403，不查老师/不排', async () => {
      trialRepo.requireExists.mockResolvedValue(
        trialFixture({ status: 'pending_teacher', campusId: OTHER_CAMPUS }),
      );
      await expect(
        controller.arrange(TRIAL_ID, body, req(jwt('academic', ACADEMIC))),
      ).rejects.toThrow(/TRIAL_ARRANGE_CROSS_CAMPUS/);
      expect(teacherRepo.findById).not.toHaveBeenCalled();
      expect(trialRepo.arrange).not.toHaveBeenCalled();
    });

    it('scheduledAt 非法 → 400', async () => {
      await expect(
        controller.arrange(
          TRIAL_ID,
          { ...body, scheduledAt: 'not-a-date' },
          req(jwt('academic', ACADEMIC)),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('@Roles = [academic, academic_admin]', () => {
      const roles = Reflect.getMetadata(ROLES_METADATA_KEY, TrialController.prototype.arrange);
      expect(roles).toEqual(['academic', 'academic_admin']);
    });
  });

  // ============================================================
  // 4. 教务标记已试听 — 状态机
  // ============================================================
  describe('POST /db/trials/:id/complete — 标记已试听', () => {
    const body = { tenantSchema: TENANT_SCHEMA };

    it('scheduled → done + audit', async () => {
      trialRepo.requireExists.mockResolvedValue(trialFixture({ status: 'scheduled' }));
      trialRepo.complete.mockResolvedValue(trialFixture({ status: 'done' }));
      const r = await controller.complete(TRIAL_ID, body, req(jwt('academic', ACADEMIC)));
      expect(r.status).toBe('done');
      expect(auditLog.log.mock.calls[0][1].action).toBe('trial.complete');
    });

    it('状态非 scheduled（仍 pending_teacher）→ 400 非法转移', async () => {
      trialRepo.requireExists.mockResolvedValue(trialFixture({ status: 'pending_teacher' }));
      await expect(
        controller.complete(TRIAL_ID, body, req(jwt('academic', ACADEMIC))),
      ).rejects.toThrow(/TRIAL_INVALID_TRANSITION/);
      expect(trialRepo.complete).not.toHaveBeenCalled();
    });

    it('@Roles = [academic, academic_admin]', () => {
      const roles = Reflect.getMetadata(ROLES_METADATA_KEY, TrialController.prototype.complete);
      expect(roles).toEqual(['academic', 'academic_admin']);
    });
  });

  // ============================================================
  // 5. 试听结果 — converted / lost + 内容安全
  // ============================================================
  describe('POST /db/trials/:id/result — 结果 converted/lost', () => {
    it('done → converted + note 过内容安全 + audit', async () => {
      trialRepo.requireExists.mockResolvedValue(trialFixture({ status: 'done' }));
      trialRepo.setResult.mockResolvedValue(
        trialFixture({ status: 'converted', resultNote: '家长满意' }),
      );
      const r = await controller.result(
        TRIAL_ID,
        { tenantSchema: TENANT_SCHEMA, result: 'converted', note: '家长满意' },
        req(jwt('sales', SALES)),
      );
      expect(r.status).toBe('converted');
      expect(contentModeration.enforceStaffText).toHaveBeenCalledTimes(1);
      // 2026-06-01 重排：内容安全在 requireExists/状态机校验**之后**（done 才调外部 API）
      const existsOrder = trialRepo.requireExists.mock.invocationCallOrder[0];
      const modOrder = contentModeration.enforceStaffText.mock.invocationCallOrder[0];
      const setOrder = trialRepo.setResult.mock.invocationCallOrder[0];
      expect(existsOrder).toBeLessThan(modOrder);
      expect(modOrder).toBeLessThan(setOrder);
      expect(auditLog.log.mock.calls[0][1].action).toBe('trial.result');
      expect(auditLog.log.mock.calls[0][1].after.result).toBe('converted');
    });

    it('done → lost', async () => {
      trialRepo.requireExists.mockResolvedValue(trialFixture({ status: 'done' }));
      trialRepo.setResult.mockResolvedValue(trialFixture({ status: 'lost' }));
      const r = await controller.result(
        TRIAL_ID,
        { tenantSchema: TENANT_SCHEMA, result: 'lost' },
        req(jwt('academic', ACADEMIC)),
      );
      expect(r.status).toBe('lost');
    });

    it('result 非 converted/lost → 400', async () => {
      await expect(
        controller.result(
          TRIAL_ID,
          { tenantSchema: TENANT_SCHEMA, result: 'whatever' as any },
          req(jwt('sales', SALES)),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('状态非 done（仍 scheduled）→ 400 非法转移，且不白调内容安全（重排后）', async () => {
      trialRepo.requireExists.mockResolvedValue(trialFixture({ status: 'scheduled' }));
      await expect(
        controller.result(
          TRIAL_ID,
          { tenantSchema: TENANT_SCHEMA, result: 'converted', note: 'x' },
          req(jwt('sales', SALES)),
        ),
      ).rejects.toThrow(/TRIAL_INVALID_TRANSITION/);
      expect(trialRepo.setResult).not.toHaveBeenCalled();
      // 2026-06-01 重排：非法态不应触发内容安全外部 API
      expect(contentModeration.enforceStaffText).not.toHaveBeenCalled();
    });

    it('trial 不存在 → NotFound，且不白调内容安全（重排后）', async () => {
      trialRepo.requireExists.mockRejectedValue(new NotFoundException('trial not found'));
      await expect(
        controller.result(
          TRIAL_ID,
          { tenantSchema: TENANT_SCHEMA, result: 'converted', note: 'x' },
          req(jwt('sales', SALES)),
        ),
      ).rejects.toThrow(NotFoundException);
      expect(contentModeration.enforceStaffText).not.toHaveBeenCalled();
    });

    it('trial 跨校（result）→ 403，且不白调内容安全（重排后）', async () => {
      trialRepo.requireExists.mockResolvedValue(
        trialFixture({ status: 'done', campusId: OTHER_CAMPUS }),
      );
      await expect(
        controller.result(
          TRIAL_ID,
          { tenantSchema: TENANT_SCHEMA, result: 'converted', note: 'x' },
          req(jwt('sales', SALES)),
        ),
      ).rejects.toThrow(/TRIAL_RESULT_CROSS_CAMPUS/);
      expect(contentModeration.enforceStaffText).not.toHaveBeenCalled();
    });

    it('@Roles = [sales, sales_manager, academic, academic_admin]', () => {
      const roles = Reflect.getMetadata(ROLES_METADATA_KEY, TrialController.prototype.result);
      expect(roles).toEqual(['sales', 'sales_manager', 'academic', 'academic_admin']);
    });
  });

  // ============================================================
  // 6. 列表端点 — scope + @Roles
  // ============================================================
  describe('列表端点', () => {
    it('my-trials → 用 assigned=自己（JWT.sub）过滤', async () => {
      await controller.myTrials({ tenantSchema: TENANT_SCHEMA }, req(jwt('academic', ACADEMIC)));
      expect(trialRepo.list.mock.calls[0][1].assignedAcademicId).toBe(ACADEMIC);
      const roles = Reflect.getMetadata(ROLES_METADATA_KEY, TrialController.prototype.myTrials);
      expect(roles).toEqual(['academic', 'academic_admin']);
    });

    it('my-initiated → 用 initiatedBy=自己（JWT.sub）过滤（销售闭环 owner-scope）', async () => {
      await controller.myInitiated({ tenantSchema: TENANT_SCHEMA }, req(jwt('sales', SALES)));
      expect(trialRepo.list.mock.calls[0][1].initiatedBy).toBe(SALES);
      const roles = Reflect.getMetadata(ROLES_METADATA_KEY, TrialController.prototype.myInitiated);
      expect(roles).toEqual(['sales', 'sales_manager']);
    });

    it('pending-assignment → 本校 campusId(JWT) + assignedIsNull', async () => {
      await controller.pendingAssignment({ tenantSchema: TENANT_SCHEMA }, req(jwt('boss', BOSS)));
      const f = trialRepo.list.mock.calls[0][1];
      expect(f.campusId).toBe(CAMPUS);
      expect(f.assignedIsNull).toBe(true);
      const roles = Reflect.getMetadata(ROLES_METADATA_KEY, TrialController.prototype.pendingAssignment);
      expect(roles).toEqual(['boss', 'admin']);
    });

    it('pending-assignment campusId 缺失 → 403', async () => {
      await expect(
        controller.pendingAssignment({ tenantSchema: TENANT_SCHEMA }, req(jwt('boss', BOSS, null))),
      ).rejects.toThrow(ForbiddenException);
    });

    it('campus-list → 本校 campusId(JWT) + 可选 status', async () => {
      await controller.campusList(
        { tenantSchema: TENANT_SCHEMA, status: 'scheduled' },
        req(jwt('boss', BOSS)),
      );
      const f = trialRepo.list.mock.calls[0][1];
      expect(f.campusId).toBe(CAMPUS);
      expect(f.status).toBe('scheduled');
      const roles = Reflect.getMetadata(ROLES_METADATA_KEY, TrialController.prototype.campusList);
      expect(roles).toEqual(['boss', 'admin']);
    });
  });

  // ============================================================
  // 7. audit fail-open（@Optional 未注入）
  // ============================================================
  describe('audit fail-open', () => {
    it('auditLog 未注入 → 主流程不抛', async () => {
      const c = new TrialController(
        trialRepo as unknown as TrialRepository,
        assignmentService as unknown as TrialAssignmentService,
        userRepo as unknown as UserRepository,
        teacherRepo as unknown as TeacherRepository,
        contentModeration as unknown as ContentModerationService,
        undefined,
        customerRepo as unknown as CustomerRepository,
      );
      trialRepo.requireExists.mockResolvedValue(trialFixture({ status: 'scheduled' }));
      trialRepo.complete.mockResolvedValue(trialFixture({ status: 'done' }));
      const r = await c.complete(TRIAL_ID, { tenantSchema: TENANT_SCHEMA }, req(jwt('academic', ACADEMIC)));
      expect(r.status).toBe('done');
    });
  });
});
