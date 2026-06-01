/**
 * student-by-student-scope — by-student 列表端点 owner-scope 收口（同租户 IDOR 修复）
 *
 * 背景（2026-06-01）：feedback / homework / leave 的 by-student 列表端点（POST /db/.../:studentId/...）
 *   原本仅靠 @Roles（角色级）+ TenantScopeGuard（跨租户）放行，缺「学员归属」校验 →
 *   同租户内 teacher 可传他人班学员 studentId 读非自己班数据、sales 可读非自己客户学员数据
 *   = 同租户 by-student IDOR（contract by-student 早有此 scope，feedback/homework/leave 漏）。
 *
 * 本 helper 复刻 contract.controller.listByStudent 的 scope 思路，但抽成可复用函数：
 *   1. 调用方先 studentRepo.findBrief 拿 ownerSalesId / assignedTeacherId；
 *   2. 传入本 helper 按 actorGroup 判定可访问性。
 *
 * Scope 规则（统一）：
 *   - parent c 端流（req.parent 存在）→ bypass（绑定关系已由 tenant.middleware.requireParentDbUser
 *     校验过 parent↔tenant，字段级由 service 层 mask；本 owner-scope 不适用 C 端）；
 *   - admin group（admin / boss / sales_manager）→ 本校放行（不 owner 收口）；
 *   - academic group（academic / academic_admin / marketing）→ 本校放行（教务/市场本校只读）；
 *   - finance group → **拒绝**（财务作账走合同/发票，不读教学反馈/作业/请假；2026-06-01 安全审收口）；
 *   - sales（个人销售线）→ student.ownerSalesId === req.user.sub 才放行，否则拒绝；
 *   - teacher → 反查 teachers.user_id === req.user.sub 得 ownTeacherId，
 *     student.assignedTeacherId === ownTeacherId 才放行（老师只看自己班学员），否则拒绝；
 *   - parent role（非 c 端 req.parent 流，理论不出现）/ hr / unknown → 拒绝。
 *
 * 注意：与 contract 的差异 ——
 *   - contract「2026-06-01 拍板老师不看合同」→ teacher 直接拒绝；
 *     feedback/homework「老师要看自己班」→ teacher 走 own-class 反查（本 helper 默认行为）。
 *   - teacher own-class 反查多 1 次 DB IO（teachers.findByUserId）；仅 teacher role 触发，
 *     admin/academic/finance/sales 不触发（sales 用内存比对 ownerSalesId）。
 */
import { ForbiddenException } from '@nestjs/common';
import { actorGroupOf } from '../role-field-filter';
import { AuthenticatedRequest } from '../../modules/auth/jwt-payload.interface';

/** by-student scope 判定所需的学员归属（StudentBrief 子集） */
export interface StudentOwnership {
  ownerSalesId: string | null;
  assignedTeacherId: string | null;
}

/** teacher own-class 反查：把 JWT.sub（users.id）映射回 teachers.id；找不到返回 null */
export type OwnTeacherIdResolver = (
  tenantSchema: string,
  userId: string,
) => Promise<string | null>;

export interface StudentScopeResult {
  allowed: boolean;
  /** 拒绝原因（用于 audit / 日志；放行时为 null） */
  reason: string | null;
}

/**
 * 判定 caller 是否可访问该 student 的 by-student 列表数据。
 *
 * @param student   StudentBrief 子集（ownerSalesId / assignedTeacherId）
 * @param req       认证请求（含 user.role / user.sub / parent）
 * @param tenantSchema  租户 schema（teacher 反查用）
 * @param resolveOwnTeacherId  teacher role 时反查 teachers.id（其他 role 不调用）
 */
export async function resolveStudentByStudentScope(
  student: StudentOwnership,
  req: AuthenticatedRequest | undefined,
  tenantSchema: string,
  resolveOwnTeacherId: OwnTeacherIdResolver,
): Promise<StudentScopeResult> {
  // parent c 端独立 JWT 流：绑定关系已在 middleware 校验，owner-scope 不适用
  //   （req.parent 由 attachParentUser 注入；req.user.role 同时被设为 'parent'）
  if (req?.parent) {
    return { allowed: true, reason: null };
  }

  const role = req?.user?.role;
  const subId = req?.user?.sub;
  const group = actorGroupOf(role);

  // admin / academic group：本校放行（不 owner 收口）
  //   - admin group = admin / boss / sales_manager（拍板「老板/校长/销售校内主管 ✅ 全权」）
  //   - academic group = academic / academic_admin / marketing（本校只读）
  //   - finance（作账走合同/发票）/ hr / unknown 不读教学反馈/作业/请假 → 落到下方拒绝
  //     （2026-06-01 安全审：leave listByStudent 无 @Roles，finance group 经 helper 放行会读
  //      请假隐私理由 §6.4/§5.2 未授权 → 从放行组剔除 finance）
  if (group === 'admin' || group === 'academic') {
    return { allowed: true, reason: null };
  }

  // sales（个人销售线）：必须 student.ownerSalesId === me
  if (group === 'sales') {
    if (subId && student.ownerSalesId === subId) {
      return { allowed: true, reason: null };
    }
    return {
      allowed: false,
      reason:
        `sales owner-scope mismatch: sub=${subId ?? 'null'} ` +
        `ownerSales=${student.ownerSalesId ?? 'null'}`,
    };
  }

  // teacher：反查 teachers.user_id === me → ownTeacherId，再比对 assignedTeacherId
  if (group === 'teacher') {
    if (!subId) {
      return { allowed: false, reason: 'teacher scope: req.user.sub missing' };
    }
    const ownTeacherId = await resolveOwnTeacherId(tenantSchema, subId);
    if (!ownTeacherId) {
      return {
        allowed: false,
        reason: `teacher scope: no teachers row bound to user ${subId}`,
      };
    }
    if (student.assignedTeacherId === ownTeacherId) {
      return { allowed: true, reason: null };
    }
    return {
      allowed: false,
      reason:
        `teacher own-class mismatch: ownTeacherId=${ownTeacherId} ` +
        `assignedTeacher=${student.assignedTeacherId ?? 'null'}`,
    };
  }

  // parent role（非 c 端流，理论不出现）/ hr / unknown：拒绝
  return {
    allowed: false,
    reason: `role not allowed for by-student scope: role=${role ?? 'unknown'} group=${group}`,
  };
}

/**
 * 便捷封装：scope 不通过直接抛 ForbiddenException（端点统一拒绝行为）。
 *
 * @returns 放行时无返回（resolve）；拒绝时 throw ForbiddenException。
 */
export async function assertStudentByStudentScope(
  student: StudentOwnership,
  req: AuthenticatedRequest | undefined,
  tenantSchema: string,
  resolveOwnTeacherId: OwnTeacherIdResolver,
  context: { endpoint: string; studentId: string },
): Promise<void> {
  const verdict = await resolveStudentByStudentScope(
    student,
    req,
    tenantSchema,
    resolveOwnTeacherId,
  );
  if (!verdict.allowed) {
    throw new ForbiddenException(
      `BY_STUDENT_ACCESS_DENIED[${context.endpoint}]: studentId=${context.studentId} ` +
        `${verdict.reason ?? 'denied'}`,
    );
  }
}
