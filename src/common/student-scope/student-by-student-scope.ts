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
 *   - parent c 端流（req.parent 存在）→ **必须校验 parent↔student 绑定**：
 *     tenant.middleware.requireParentDbUser 仅校验 parent↔tenant（findChildrenByParent 验该
 *     parent 在该租户有 active binding），**不校验 parent↔具体 studentId** → 同租户家长传他人孩子
 *     studentId 可读他人反馈/作业/请假（2026-06-01 中危 IDOR）。本 helper 通过 resolveParentChildIds
 *     拿该 parent 的 active 绑定 student id 列表，校验 studentId ∈ 列表，不在 → 拒绝；
 *     resolver 未提供（兜底/旧调用）→ **保守拒绝**（fail-safe，不再无条件 bypass）；
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
import { ForbiddenException, Logger } from '@nestjs/common';
import { actorGroupOf } from '../role-field-filter';
import { AuthenticatedRequest } from '../../modules/auth/jwt-payload.interface';

/**
 * 模块级 logger（pure 函数里独立 new，不依赖 DI）。
 *
 * 2026-06-01 安全审 MEDIUM-1：assertStudentByStudentScope 旧版把 verdict.reason 拼进
 *   ForbiddenException message，GlobalExceptionFilter 对 4xx HttpException 原样回 client →
 *   parent 分支 reason 含 childIds（该家长自己孩子的 studentId 列表）/ teacher/sales 分支含
 *   assignedTeacherId/ownerSalesId 等内部 ID → 恶意请求反而拿到内部归属信息（IDOR 侧信道）。
 *   修法：抛错用固定不透明 message（仅含调用方自己传入的 studentId）；detailed reason 改落
 *   服务端日志（pino，不回 client），既保留排障信息又堵泄露。
 */
const scopeLogger = new Logger('student-by-student-scope');

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

/**
 * parent c 端绑定反查：返回当前 parent（req.parent）在本租户的 active 绑定 student id 列表。
 *
 * 调用方负责按 binding_status='active' + tenantId 过滤（parentRepo.findChildrenByParent 已在
 * SQL 层 binding_status='active'；调用方再按当前 tenant 过滤跨机构家长的多租户绑定）。
 *
 * 返回空数组 → parent 在本租户无任何 active 绑定 → 本 helper 判定所有 studentId 越权（拒绝）。
 */
export type ParentChildIdsResolver = () => Promise<string[]>;

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
 * @param resolveParentChildIds  parent c 端流时反查该 parent 本租户 active 绑定 student id 列表；
 *   **parent 流必须提供**，否则保守拒绝（fail-safe）。其他 role 不调用。
 * @param studentId  被访问的 student id（parent 绑定校验用：studentId ∈ 绑定列表才放行）。
 *   parent 流必须提供，否则保守拒绝。
 */
export async function resolveStudentByStudentScope(
  student: StudentOwnership,
  req: AuthenticatedRequest | undefined,
  tenantSchema: string,
  resolveOwnTeacherId: OwnTeacherIdResolver,
  resolveParentChildIds?: ParentChildIdsResolver,
  studentId?: string,
): Promise<StudentScopeResult> {
  // parent c 端独立 JWT 流（req.parent 由 attachParentUser 注入；req.user.role 同时被设为 'parent'）。
  //   middleware 仅验 parent↔租户（findChildrenByParent 验该 parent 在该租户有 active binding），
  //   **不验 parent↔具体 studentId** → 本 helper 补 parent↔student 绑定校验（同租户 IDOR 修复）。
  if (req?.parent) {
    // resolver / studentId 缺失 → 无法校验绑定 → 保守拒绝（fail-safe，不再无条件 bypass）
    if (!resolveParentChildIds || !studentId) {
      return {
        allowed: false,
        reason:
          'parent scope: resolveParentChildIds/studentId missing — ' +
          'cannot verify parent↔student binding (fail-safe deny)',
      };
    }
    const childIds = await resolveParentChildIds();
    if (childIds.includes(studentId)) {
      return { allowed: true, reason: null };
    }
    return {
      allowed: false,
      reason:
        `parent binding mismatch: studentId=${studentId} not in active bindings ` +
        `[${childIds.join(',')}] (parent=${req.parent.parentId ?? req.parent.sub ?? 'unknown'})`,
    };
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
 * @param resolveParentChildIds  parent c 端流时反查该 parent 本租户 active 绑定 student id 列表
 *   （parent 流必须提供，否则保守拒绝）。context.studentId 自动透传给绑定校验。
 * @returns 放行时无返回（resolve）；拒绝时 throw ForbiddenException。
 */
export async function assertStudentByStudentScope(
  student: StudentOwnership,
  req: AuthenticatedRequest | undefined,
  tenantSchema: string,
  resolveOwnTeacherId: OwnTeacherIdResolver,
  context: { endpoint: string; studentId: string },
  resolveParentChildIds?: ParentChildIdsResolver,
): Promise<void> {
  const verdict = await resolveStudentByStudentScope(
    student,
    req,
    tenantSchema,
    resolveOwnTeacherId,
    resolveParentChildIds,
    context.studentId,
  );
  if (!verdict.allowed) {
    // 2026-06-01 安全审 MEDIUM-1：detailed reason（含内部 ID：childIds / assignedTeacherId /
    //   ownerSalesId）只落服务端日志，**不回 client**（GlobalExceptionFilter 对 4xx 原样回响应体）。
    scopeLogger.warn(
      `[by-student-scope deny] endpoint=${context.endpoint} ` +
        `studentId=${context.studentId} reason=${verdict.reason ?? 'denied'}`,
    );
    // 抛出固定不透明 message：仅含调用方自己传入的 studentId（属其输入，不算泄露），
    //   不拼 verdict.reason（防内部归属 ID 经响应体外泄）。
    throw new ForbiddenException(
      `BY_STUDENT_ACCESS_DENIED[${context.endpoint}]: studentId=${context.studentId}`,
    );
  }
}
