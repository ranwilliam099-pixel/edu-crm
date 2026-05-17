/**
 * ParentBindingController 单测 — Sprint X.2 (2026-05-17)
 *
 * 验证（SSOT §12.5 + D10）：
 *   - POST /db/parents staff 创建家长 + 绑定
 *   - PATCH /db/parent-bindings/:id staff 解绑
 *   - V10 3 家长上限触发器兜底
 *   - 跨 tenant binding 403
 *   - audit_log 留痕
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ParentBindingController } from './parent-binding.controller';
import { ParentRepository } from './parent.repository';
import { StudentRepository } from './student.repository';
import { PhoneLookupService } from '../auth/phone-lookup.service';
import { AuditLogRepository } from './audit-log.repository';
import type { AuthenticatedRequest } from '../auth/jwt-payload.interface';

const ULID32_T = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNT1';
const ULID32_T2 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNT2';
const ULID32_STAFF = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNS1';
const ULID32_STUDENT = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNST';
const ULID32_PARENT = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNP1';
const ULID32_BINDING = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNB1';

function makeReq(role: string = 'sales'): AuthenticatedRequest {
  return {
    user: {
      sub: ULID32_STAFF,
      role: role as never,
      tenantId: ULID32_T,
      campusId: null,
    },
    headers: { 'user-agent': 'jest', 'x-request-id': 'rid-1' },
    ip: '1.2.3.4',
  } as AuthenticatedRequest;
}

describe('ParentBindingController.createParent (Sprint X.2 SSOT §12.5)', () => {
  let controller: ParentBindingController;
  let parentRepo: {
    findParentById: jest.Mock;
    findParentByPhone: jest.Mock;
    findActiveBindingsForStudent: jest.Mock;
    insertParent: jest.Mock;
    insertBinding: jest.Mock;
    unbind: jest.Mock;
    findBindingById: jest.Mock;
  };
  let studentRepo: { findBrief: jest.Mock };
  let phoneLookup: { lookupByPhone: jest.Mock };
  let auditLog: { log: jest.Mock };

  beforeEach(() => {
    parentRepo = {
      findParentById: jest.fn().mockResolvedValue(null),
      findParentByPhone: jest.fn().mockResolvedValue(null),
      findActiveBindingsForStudent: jest.fn().mockResolvedValue([]),
      insertParent: jest.fn().mockImplementation((p) => Promise.resolve(p)),
      insertBinding: jest.fn().mockImplementation((b) => Promise.resolve(b)),
      unbind: jest.fn(),
      findBindingById: jest.fn(),
    };
    studentRepo = {
      findBrief: jest.fn().mockResolvedValue({ id: ULID32_STUDENT, studentName: 'X' }),
    };
    phoneLookup = {
      lookupByPhone: jest.fn().mockResolvedValue({ bUsers: [], parent: null }),
    };
    auditLog = { log: jest.fn().mockResolvedValue(undefined) };

    controller = new ParentBindingController(
      parentRepo as unknown as ParentRepository,
      studentRepo as unknown as StudentRepository,
      phoneLookup as unknown as PhoneLookupService,
      auditLog as unknown as AuditLogRepository,
    );
  });

  const validBody = () => ({
    tenantId: ULID32_T,
    tenantSchema: `tenant_${ULID32_T.toLowerCase()}`,
    phone: '13800001111',
    name: '张爸爸',
    relationship: 'father' as const,
    studentId: ULID32_STUDENT,
  });

  it('happy path → 创建 parent + binding + audit_log', async () => {
    const res = await controller.createParent(validBody(), makeReq('sales'));
    expect(res.parent.phone).toBe('13800001111');
    expect(res.binding.studentId).toBe(ULID32_STUDENT);
    expect(res.binding.bindingStatus).toBe('active');
    expect(auditLog.log).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        action: 'parent.bound-by-staff',
        targetType: 'parent_student_binding',
      }),
    );
  });

  it('phone 命中 B 端 user → 409 PHONE_ALREADY_REGISTERED_AS_STAFF', async () => {
    phoneLookup.lookupByPhone.mockResolvedValueOnce({
      bUsers: [
        {
          userId: 'u1'.padEnd(32, '0'),
          tenantId: ULID32_T,
          tenantName: 'T1',
          role: 'sales',
          campusId: null,
          userName: 'X',
          passwordHash: 'h',
          status: '启用',
          deletedAt: null,
          campusName: 'C',
        },
      ],
      parent: null,
    });
    await expect(controller.createParent(validBody(), makeReq('sales'))).rejects.toThrow(
      ConflictException,
    );
  });

  it('phone 命中 C 端 parent → 复用 parent (一家长多孩子)', async () => {
    phoneLookup.lookupByPhone.mockResolvedValueOnce({
      bUsers: [],
      parent: { parentId: ULID32_PARENT, status: '启用' },
    });
    parentRepo.findParentById.mockResolvedValueOnce({
      id: ULID32_PARENT,
      phone: '13800001111',
      name: '张爸爸',
      status: '启用',
    });
    const res = await controller.createParent(validBody(), makeReq('sales'));
    expect(res.parent.id).toBe(ULID32_PARENT);
    // 不 insertParent (复用)
    expect(parentRepo.insertParent).not.toHaveBeenCalled();
    // 仍 insert binding
    expect(parentRepo.insertBinding).toHaveBeenCalled();
  });

  it('student 不存在 → 404', async () => {
    studentRepo.findBrief.mockResolvedValueOnce(null);
    await expect(controller.createParent(validBody(), makeReq('sales'))).rejects.toThrow(
      NotFoundException,
    );
  });

  it('单孩 ≥ 3 家长 (应用层 pre-check) → 409 STUDENT_MAX_3_PARENTS_EXCEEDED', async () => {
    parentRepo.findActiveBindingsForStudent.mockResolvedValueOnce([
      { id: 'b1', parentId: 'p1' },
      { id: 'b2', parentId: 'p2' },
      { id: 'b3', parentId: 'p3' },
    ] as never);
    await expect(controller.createParent(validBody(), makeReq('sales'))).rejects.toThrow(
      /STUDENT_MAX_3_PARENTS_EXCEEDED/,
    );
  });

  it('parent 已绑同 student (防双绑) → 409 PARENT_ALREADY_BOUND_TO_STUDENT', async () => {
    phoneLookup.lookupByPhone.mockResolvedValueOnce({
      bUsers: [],
      parent: { parentId: ULID32_PARENT, status: '启用' },
    });
    parentRepo.findParentById.mockResolvedValueOnce({
      id: ULID32_PARENT,
      phone: '13800001111',
      status: '启用',
    });
    parentRepo.findActiveBindingsForStudent.mockResolvedValueOnce([
      { id: 'b1', parentId: ULID32_PARENT, studentId: ULID32_STUDENT, bindingStatus: 'active' },
    ] as never);
    await expect(controller.createParent(validBody(), makeReq('sales'))).rejects.toThrow(
      /PARENT_ALREADY_BOUND_TO_STUDENT/,
    );
  });

  it('V10 触发器并发 STUDENT_MAX_3_PARENTS_EXCEEDED → 409', async () => {
    parentRepo.insertBinding.mockRejectedValueOnce(
      Object.assign(new Error('STUDENT_MAX_3_PARENTS_EXCEEDED'), { code: 'P0001' }),
    );
    await expect(controller.createParent(validBody(), makeReq('sales'))).rejects.toThrow(
      ConflictException,
    );
  });

  it('UNIQUE (parent_id, student_id) DB 兜底 23505 → 409', async () => {
    parentRepo.insertBinding.mockRejectedValueOnce(
      Object.assign(new Error('duplicate'), { code: '23505' }),
    );
    await expect(controller.createParent(validBody(), makeReq('sales'))).rejects.toThrow(
      ConflictException,
    );
  });

  it('phone 非法 → 400', async () => {
    await expect(
      controller.createParent({ ...validBody(), phone: '12345' }, makeReq('sales')),
    ).rejects.toThrow(BadRequestException);
  });

  it('relationship 无效 → 400', async () => {
    await expect(
      controller.createParent(
        { ...validBody(), relationship: 'uncle' as never },
        makeReq('sales'),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('studentId 长度非 32 → 400', async () => {
    await expect(
      controller.createParent({ ...validBody(), studentId: 'short' }, makeReq('sales')),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('ParentBindingController.unbindBinding (Sprint X.2 SSOT §12.5)', () => {
  let controller: ParentBindingController;
  let parentRepo: {
    findParentById: jest.Mock;
    findParentByPhone: jest.Mock;
    findActiveBindingsForStudent: jest.Mock;
    insertParent: jest.Mock;
    insertBinding: jest.Mock;
    unbind: jest.Mock;
    findBindingById: jest.Mock;
  };
  let studentRepo: { findBrief: jest.Mock };
  let phoneLookup: { lookupByPhone: jest.Mock };
  let auditLog: { log: jest.Mock };

  beforeEach(() => {
    parentRepo = {
      findParentById: jest.fn(),
      findParentByPhone: jest.fn(),
      findActiveBindingsForStudent: jest.fn(),
      insertParent: jest.fn(),
      insertBinding: jest.fn(),
      unbind: jest.fn().mockImplementation((id) =>
        Promise.resolve({
          id,
          parentId: ULID32_PARENT,
          studentId: ULID32_STUDENT,
          tenantId: ULID32_T,
          isPrimary: false,
          relationship: 'father',
          bindingStatus: 'unbound',
          boundAt: new Date(),
          unboundAt: new Date(),
        }),
      ),
      findBindingById: jest.fn(),
    };
    studentRepo = { findBrief: jest.fn() };
    phoneLookup = { lookupByPhone: jest.fn() };
    auditLog = { log: jest.fn().mockResolvedValue(undefined) };
    controller = new ParentBindingController(
      parentRepo as unknown as ParentRepository,
      studentRepo as unknown as StudentRepository,
      phoneLookup as unknown as PhoneLookupService,
      auditLog as unknown as AuditLogRepository,
    );
  });

  const validUnbindBody = () => ({
    tenantId: ULID32_T,
    tenantSchema: `tenant_${ULID32_T.toLowerCase()}`,
    action: 'unbind' as const,
  });

  it('happy path → unbind + audit_log', async () => {
    parentRepo.findBindingById.mockResolvedValueOnce({
      id: ULID32_BINDING,
      parentId: ULID32_PARENT,
      studentId: ULID32_STUDENT,
      tenantId: ULID32_T,
      bindingStatus: 'active',
      isPrimary: false,
      relationship: 'father',
      boundAt: new Date(),
    });
    const res = await controller.unbindBinding(ULID32_BINDING, validUnbindBody(), makeReq('academic'));
    expect(res.binding.bindingStatus).toBe('unbound');
    expect(auditLog.log).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ action: 'parent.unbound-by-staff' }),
    );
  });

  it('binding 不存在 → 404', async () => {
    parentRepo.findBindingById.mockResolvedValueOnce(null);
    await expect(
      controller.unbindBinding(ULID32_BINDING, validUnbindBody(), makeReq('sales')),
    ).rejects.toThrow(NotFoundException);
  });

  it('跨 tenant binding → 403 ForbiddenException', async () => {
    parentRepo.findBindingById.mockResolvedValueOnce({
      id: ULID32_BINDING,
      parentId: ULID32_PARENT,
      studentId: ULID32_STUDENT,
      tenantId: ULID32_T2, // 不是当前 tenant
      bindingStatus: 'active',
      isPrimary: false,
      relationship: 'father',
      boundAt: new Date(),
    });
    await expect(
      controller.unbindBinding(ULID32_BINDING, validUnbindBody(), makeReq('sales')),
    ).rejects.toThrow(ForbiddenException);
    // 不调 unbind
    expect(parentRepo.unbind).not.toHaveBeenCalled();
  });

  it('已 unbound (幂等) → 不重复写 audit', async () => {
    parentRepo.findBindingById.mockResolvedValueOnce({
      id: ULID32_BINDING,
      parentId: ULID32_PARENT,
      studentId: ULID32_STUDENT,
      tenantId: ULID32_T,
      bindingStatus: 'unbound', // 已解绑
      isPrimary: false,
      relationship: 'father',
      boundAt: new Date(),
    });
    const res = await controller.unbindBinding(
      ULID32_BINDING,
      validUnbindBody(),
      makeReq('sales'),
    );
    expect(res.binding.bindingStatus).toBe('unbound');
    expect(parentRepo.unbind).not.toHaveBeenCalled();
    expect(auditLog.log).not.toHaveBeenCalled();
  });

  it('action !== "unbind" → 400', async () => {
    await expect(
      controller.unbindBinding(
        ULID32_BINDING,
        { ...validUnbindBody(), action: 'delete' as never },
        makeReq('sales'),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('bindingId 长度非 32 → 400', async () => {
    await expect(
      controller.unbindBinding('short', validUnbindBody(), makeReq('sales')),
    ).rejects.toThrow(BadRequestException);
  });
});
