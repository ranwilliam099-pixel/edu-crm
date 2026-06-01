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
  // 2026-06-01 parent↔student 绑定 IDOR 修复：parent 自己孩子 / 他人孩子 studentId
  const STU_MINE = 'stuMine00000000000000000000M001';
  const STU_OTHERS = 'stuOthers000000000000000000O001';

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

  // ============================================================
  // 2026-06-01 parent↔student 绑定 IDOR 修复：parent c 端流不再无条件 bypass
  //   middleware 仅验 parent↔租户，本 helper 补 parent↔student 绑定校验。
  // ============================================================
  describe('parent c 端流（req.parent）— parent↔student 绑定校验', () => {
    const parentReq = () =>
      req('parent', 'p000000000000000000000000000P1', {
        parent: { sub: 'p000000000000000000000000000P1', parentId: 'p000000000000000000000000000P1', role: 'parent' },
      });

    it('parent 自己孩子 studentId（∈ active 绑定）→ allowed（不查 teacher）', async () => {
      const resolveChildren = jest.fn(async () => [STU_MINE, 'stuOther2000000000000000000O002']);
      const r = await resolveStudentByStudentScope(
        student({ ownerSalesId: SALES_B, assignedTeacherId: TEACHER_T2 }),
        parentReq(),
        TENANT,
        resolveOwn,
        resolveChildren,
        STU_MINE,
      );
      expect(r.allowed).toBe(true);
      expect(resolveChildren).toHaveBeenCalledTimes(1);
      expect(resolveOwn).not.toHaveBeenCalled();
    });

    it('parent 他人孩子 studentId（∉ active 绑定）→ denied（同租户 IDOR 拦截）', async () => {
      const resolveChildren = jest.fn(async () => [STU_MINE]);
      const r = await resolveStudentByStudentScope(
        student(),
        parentReq(),
        TENANT,
        resolveOwn,
        resolveChildren,
        STU_OTHERS,
      );
      expect(r.allowed).toBe(false);
      expect(r.reason).toContain('parent binding mismatch');
      expect(resolveChildren).toHaveBeenCalledTimes(1);
    });

    it('parent 无任何 active 绑定（resolver 返空）→ denied', async () => {
      const resolveChildren = jest.fn(async () => []);
      const r = await resolveStudentByStudentScope(
        student(),
        parentReq(),
        TENANT,
        resolveOwn,
        resolveChildren,
        STU_MINE,
      );
      expect(r.allowed).toBe(false);
      expect(r.reason).toContain('parent binding mismatch');
    });

    it('parent 流但 resolver 缺失 → 保守拒绝（fail-safe，不再无条件 bypass）', async () => {
      const r = await resolveStudentByStudentScope(
        student(),
        parentReq(),
        TENANT,
        resolveOwn,
        undefined,
        STU_MINE,
      );
      expect(r.allowed).toBe(false);
      expect(r.reason).toContain('resolveParentChildIds/studentId missing');
      expect(resolveOwn).not.toHaveBeenCalled();
    });

    it('parent 流但 studentId 缺失 → 保守拒绝（fail-safe）', async () => {
      const resolveChildren = jest.fn(async () => [STU_MINE]);
      const r = await resolveStudentByStudentScope(
        student(),
        parentReq(),
        TENANT,
        resolveOwn,
        resolveChildren,
        undefined,
      );
      expect(r.allowed).toBe(false);
      expect(r.reason).toContain('resolveParentChildIds/studentId missing');
      expect(resolveChildren).not.toHaveBeenCalled();
    });
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

    // 2026-06-01 parent↔student 绑定：context.studentId 自动透传给 resolveParentChildIds 校验
    it('parent 自己孩子 → 不抛（context.studentId 透传给绑定校验）', async () => {
      const parentReq = req('parent', 'p000000000000000000000000000P1', {
        parent: { sub: 'p000000000000000000000000000P1', parentId: 'p000000000000000000000000000P1', role: 'parent' },
      });
      const resolveChildren = jest.fn(async () => [STU_MINE]);
      await expect(
        assertStudentByStudentScope(
          student(),
          parentReq,
          TENANT,
          resolveOwn,
          { endpoint: 'feedbacks', studentId: STU_MINE },
          resolveChildren,
        ),
      ).resolves.toBeUndefined();
      expect(resolveChildren).toHaveBeenCalledTimes(1);
    });

    it('parent 他人孩子 → ForbiddenException（context.studentId ∉ 绑定）', async () => {
      const parentReq = req('parent', 'p000000000000000000000000000P1', {
        parent: { sub: 'p000000000000000000000000000P1', parentId: 'p000000000000000000000000000P1', role: 'parent' },
      });
      const resolveChildren = jest.fn(async () => [STU_MINE]);
      await expect(
        assertStudentByStudentScope(
          student(),
          parentReq,
          TENANT,
          resolveOwn,
          { endpoint: 'feedbacks', studentId: STU_OTHERS },
          resolveChildren,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('parent 流无 resolver → ForbiddenException（fail-safe deny）', async () => {
      const parentReq = req('parent', 'p000000000000000000000000000P1', {
        parent: { sub: 'p000000000000000000000000000P1', parentId: 'p000000000000000000000000000P1', role: 'parent' },
      });
      await expect(
        assertStudentByStudentScope(
          student(),
          parentReq,
          TENANT,
          resolveOwn,
          { endpoint: 'feedbacks', studentId: STU_MINE },
          // resolveParentChildIds 缺失
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    // ============================================================
    // 2026-06-01 安全审 MEDIUM-1：403 响应体不得泄露内部 ID（PII / IDOR 侧信道）
    //   旧版把 verdict.reason 拼进 ForbiddenException message，GlobalExceptionFilter 对 4xx
    //   原样回 client → parent 分支 reason 含 childIds（该家长自己孩子 studentId 列表）、
    //   teacher/sales 分支含 assignedTeacherId/ownerSalesId 等内部 ID → 外泄。
    //   修后：抛错 message 固定不透明，仅含调用方自己传入的 studentId（其输入），不含 reason。
    // ============================================================
    describe('MEDIUM-1: 403 message 不泄露内部 ID', () => {
      const PARENT_ID = 'p000000000000000000000000000P1';
      const parentReq = () =>
        req('parent', PARENT_ID, {
          parent: { sub: PARENT_ID, parentId: PARENT_ID, role: 'parent' },
        });

      // 抓取抛出的 ForbiddenException message（getResponse 提取，对齐 GlobalExceptionFilter 行为）
      async function captureMessage(p: Promise<unknown>): Promise<string> {
        try {
          await p;
          throw new Error('expected ForbiddenException but none thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(ForbiddenException);
          return (e as ForbiddenException).message;
        }
      }

      it('parent 他人孩子 → message 不含其他孩子 id（无逗号分隔多 ULID）', async () => {
        // 该 parent 自己绑定 2 个孩子；传他人 STU_OTHERS → 旧版 reason 会含 [STU_MINE,OTHER2]
        const OTHER2 = 'stuOther2000000000000000000O002';
        const resolveChildren = jest.fn(async () => [STU_MINE, OTHER2]);
        const msg = await captureMessage(
          assertStudentByStudentScope(
            student(),
            parentReq(),
            TENANT,
            resolveOwn,
            { endpoint: 'feedbacks', studentId: STU_OTHERS },
            resolveChildren,
          ),
        );
        // 固定不透明文案 + 调用方自己传入的 studentId 可保留
        expect(msg).toContain('BY_STUDENT_ACCESS_DENIED[feedbacks]');
        expect(msg).toContain(STU_OTHERS);
        // 泄露断言：不含该家长其他孩子 id
        expect(msg).not.toContain(STU_MINE);
        expect(msg).not.toContain(OTHER2);
        // 不含逗号分隔的多 ULID（childIds.join(',') 形态）
        expect(msg).not.toContain(',');
        // 不含 reason 关键字（旧版会拼 'parent binding mismatch' / parentId）
        expect(msg).not.toContain('parent binding mismatch');
        expect(msg).not.toContain(PARENT_ID);
      });

      it('teacher 非自己班 → message 不含 assignedTeacherId / ownTeacherId', async () => {
        const msg = await captureMessage(
          assertStudentByStudentScope(
            student({ assignedTeacherId: TEACHER_T2 }),
            req('teacher', USER_U1),
            TENANT,
            resolveOwn,
            { endpoint: 'homework-assignments', studentId: STU_MINE },
          ),
        );
        expect(msg).toContain('BY_STUDENT_ACCESS_DENIED[homework-assignments]');
        expect(msg).not.toContain(TEACHER_T1); // 反查得到的 ownTeacherId
        expect(msg).not.toContain(TEACHER_T2); // student.assignedTeacherId
        expect(msg).not.toContain('teacher own-class mismatch');
      });

      it('sales 他人客户 → message 不含 ownerSalesId', async () => {
        const msg = await captureMessage(
          assertStudentByStudentScope(
            student({ ownerSalesId: SALES_B }),
            req('sales', SALES_A),
            TENANT,
            resolveOwn,
            { endpoint: 'leaves-list', studentId: STU_MINE },
          ),
        );
        expect(msg).toContain('BY_STUDENT_ACCESS_DENIED[leaves-list]');
        expect(msg).not.toContain(SALES_A); // caller sub
        expect(msg).not.toContain(SALES_B); // student.ownerSalesId
        expect(msg).not.toContain('sales owner-scope mismatch');
      });
    });
  });
});
