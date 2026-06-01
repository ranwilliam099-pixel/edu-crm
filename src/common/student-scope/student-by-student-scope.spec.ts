/**
 * student-by-student-scope unit tests — 2026-06-01 同租户 by-student IDOR 修复
 *
 * 直测共享 scope helper 的角色判定矩阵（feedback/homework/leave 三处复用同一函数，
 * 单源测试避免三处重复测分支逻辑）。
 */
import { ForbiddenException } from '@nestjs/common';
import {
  resolveStudentByStudentScope,
  assertStudentByStudentScope,
  StudentOwnership,
} from './student-by-student-scope';
import { AuthenticatedRequest } from '../../modules/auth/jwt-payload.interface';

describe('resolveStudentByStudentScope', () => {
  const TENANT = 'tenant_scope_helper_xxxxxxxxxxx01';
  const SALES_A = 'salesA0000000000000000000000A001';
  const SALES_B = 'salesB0000000000000000000000B001';
  const TEACHER_T1 = 'tch00000000000000000000000000T001';
  const TEACHER_T2 = 'tch00000000000000000000000000T002';
  const USER_U1 = 'usr00000000000000000000000000U001';

  const student = (o: Partial<StudentOwnership> = {}): StudentOwnership => ({
    ownerSalesId: SALES_A,
    assignedTeacherId: TEACHER_T1,
    ...o,
  });

  const req = (
    role: string,
    sub: string,
    extra: Partial<AuthenticatedRequest> = {},
  ): AuthenticatedRequest =>
    ({ user: { sub, role, tenantId: 't', campusId: 'c' }, headers: {}, ...extra }) as AuthenticatedRequest;

  // resolver：U1 → T1，其余 → null
  const resolveOwn = jest.fn(async (_schema: string, userId: string) =>
    userId === USER_U1 ? TEACHER_T1 : null,
  );

  beforeEach(() => resolveOwn.mockClear());

  it('parent c 端流（req.parent）→ allowed（不查 teacher）', async () => {
    const r = await resolveStudentByStudentScope(
      student({ ownerSalesId: SALES_B, assignedTeacherId: TEACHER_T2 }),
      req('parent', 'p', { parent: { sub: 'p', parentId: 'p', role: 'parent' } }),
      TENANT,
      resolveOwn,
    );
    expect(r.allowed).toBe(true);
    expect(resolveOwn).not.toHaveBeenCalled();
  });

  it.each(['admin', 'boss', 'sales_manager', 'academic', 'academic_admin', 'marketing'])(
    '%s → 本校放行（不 owner 收口，不查 teacher）',
    async (role) => {
      const r = await resolveStudentByStudentScope(
        student({ ownerSalesId: SALES_B, assignedTeacherId: TEACHER_T2 }),
        req(role, 'x000000000000000000000000000X01'),
        TENANT,
        resolveOwn,
      );
      expect(r.allowed).toBe(true);
      expect(resolveOwn).not.toHaveBeenCalled();
    },
  );

  it('finance → denied（2026-06-01 安全审：财务不读教学反馈/作业/请假，§6.4/§5.2 未授权）', async () => {
    const r = await resolveStudentByStudentScope(
      student({ ownerSalesId: SALES_B, assignedTeacherId: TEACHER_T2 }),
      req('finance', 'x000000000000000000000000000X01'),
      TENANT,
      resolveOwn,
    );
    expect(r.allowed).toBe(false);
    expect(resolveOwn).not.toHaveBeenCalled();
  });

  it('sales 自己客户（ownerSalesId === sub）→ allowed', async () => {
    const r = await resolveStudentByStudentScope(student({ ownerSalesId: SALES_A }), req('sales', SALES_A), TENANT, resolveOwn);
    expect(r.allowed).toBe(true);
    expect(resolveOwn).not.toHaveBeenCalled();
  });

  it('sales 他人客户（ownerSalesId !== sub）→ denied', async () => {
    const r = await resolveStudentByStudentScope(student({ ownerSalesId: SALES_B }), req('sales', SALES_A), TENANT, resolveOwn);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('sales owner-scope mismatch');
  });

  it('teacher 自己班（assignedTeacherId === 反查 teacher.id）→ allowed', async () => {
    const r = await resolveStudentByStudentScope(student({ assignedTeacherId: TEACHER_T1 }), req('teacher', USER_U1), TENANT, resolveOwn);
    expect(r.allowed).toBe(true);
    expect(resolveOwn).toHaveBeenCalledWith(TENANT, USER_U1);
  });

  it('teacher 非自己班（assignedTeacherId !== 反查 teacher.id）→ denied', async () => {
    const r = await resolveStudentByStudentScope(student({ assignedTeacherId: TEACHER_T2 }), req('teacher', USER_U1), TENANT, resolveOwn);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('teacher own-class mismatch');
  });

  it('teacher 未绑 teachers 档案（resolver=null）→ denied', async () => {
    const r = await resolveStudentByStudentScope(student(), req('teacher', 'unbound000000000000000000000U9'), TENANT, resolveOwn);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('no teachers row bound');
  });

  it.each(['hr', 'sales_director', undefined])('%s（未授权 group）→ denied', async (role) => {
    const r = await resolveStudentByStudentScope(
      student(),
      req(role as any, 'x000000000000000000000000000X01'),
      TENANT,
      resolveOwn,
    );
    expect(r.allowed).toBe(false);
  });

  it('parent role 但无 req.parent（非 c 端流）→ denied（保守）', async () => {
    const r = await resolveStudentByStudentScope(student(), req('parent', 'p000000000000000000000000000P1'), TENANT, resolveOwn);
    expect(r.allowed).toBe(false);
  });

  describe('assertStudentByStudentScope', () => {
    it('放行 → 不抛', async () => {
      await expect(
        assertStudentByStudentScope(student({ ownerSalesId: SALES_A }), req('sales', SALES_A), TENANT, resolveOwn, {
          endpoint: 'feedbacks',
          studentId: 'stu00000000000000000000000000S01',
        }),
      ).resolves.toBeUndefined();
    });

    it('拒绝 → ForbiddenException 含 endpoint + studentId', async () => {
      await expect(
        assertStudentByStudentScope(student({ ownerSalesId: SALES_B }), req('sales', SALES_A), TENANT, resolveOwn, {
          endpoint: 'feedbacks',
          studentId: 'stu00000000000000000000000000S01',
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
