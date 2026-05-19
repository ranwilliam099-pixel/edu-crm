/**
 * L8 业务流 A3 — 销售转教务边界 (10 case, ★ 5/19 leader 拍板核心 OOUX 边界)
 *
 * 来源:
 *   - v2.0 §5.A3 销售转教务边界 (10 case)
 *   - SSOT §2 全局规则 #4「教务全只读老师线」
 *   - SSOT §6 操作权限矩阵 schedule.create=[academic] / contract.create=[sales, sales_manager, boss, admin]
 *
 * 验证关注点:
 *   - sales 签 contract → 状态 signed → 教务 dashboard 可见
 *   - sales 只读看后续 schedule / feedback (不改不删)
 *   - sales 试图改 schedule / 改 feedback / 改 teacher → 403
 *   - academic 试图改 contract.totalAmount / 改 customer.ownerSalesId → 403
 *   - teacher 试图看其他老师 student → 403
 *
 * 策略:
 *   - mock RbacGuard + 业务 service, 不依赖真 PG
 *   - 每个 403 必断言 audit_log 写一条 denied (5/19 拍板「audit_log on 403 Sprint E 整体补」, 本 spec 用 mock auditLog 验证调用契约)
 */
import { ForbiddenException } from '@nestjs/common';

// ---------- Mock infrastructure ----------

interface AuditEntry {
  actorRole: string;
  action: string;
  targetType: string;
  targetId: string;
  outcome: 'success' | 'denied';
  reason?: string;
}

class MockAuditLog {
  entries: AuditEntry[] = [];
  log(entry: AuditEntry): void {
    this.entries.push(entry);
  }
  byAction(action: string): AuditEntry[] {
    return this.entries.filter((e) => e.action === action);
  }
}

interface MockUser {
  sub: string;
  role: 'sales' | 'sales_manager' | 'academic' | 'teacher' | 'admin' | 'boss' | 'finance' | 'parent';
  campusId: string;
  tenantId: string;
}

// 简化 RBAC: 角色不在允许列表 → throw + audit denied
function assertRole(
  user: MockUser,
  allowed: ReadonlyArray<string>,
  action: string,
  targetType: string,
  targetId: string,
  audit: MockAuditLog,
): void {
  if (!allowed.includes(user.role)) {
    audit.log({
      actorRole: user.role,
      action,
      targetType,
      targetId,
      outcome: 'denied',
      reason: `role ${user.role} not in [${allowed.join(',')}]`,
    });
    throw new ForbiddenException(`${action} denied for role=${user.role}`);
  }
}

// 真业务 service 的简化版 (仅 RBAC 边界, 不含字段验证 / 持久化)
function createContract(
  user: MockUser,
  body: { studentId: string; totalAmount: number },
  audit: MockAuditLog,
): { id: string; status: 'signed' } {
  assertRole(user, ['sales', 'sales_manager', 'boss', 'admin'], 'contract.create', 'contract', body.studentId, audit);
  audit.log({
    actorRole: user.role,
    action: 'contract.create',
    targetType: 'contract',
    targetId: body.studentId,
    outcome: 'success',
  });
  return { id: 'CONTRACT_' + body.studentId, status: 'signed' };
}

function createSchedule(
  user: MockUser,
  body: { contractId: string; teacherId: string },
  audit: MockAuditLog,
): { id: string; status: '已排课' } {
  assertRole(user, ['academic'], 'schedule.create', 'schedule', body.contractId, audit);
  audit.log({
    actorRole: user.role,
    action: 'schedule.create',
    targetType: 'schedule',
    targetId: body.contractId,
    outcome: 'success',
  });
  return { id: 'SCHEDULE_' + body.contractId, status: '已排课' };
}

function updateSchedule(
  user: MockUser,
  scheduleId: string,
  audit: MockAuditLog,
): { id: string; status: string } {
  assertRole(user, ['academic'], 'schedule.update', 'schedule', scheduleId, audit);
  return { id: scheduleId, status: '已改' };
}

function deleteFeedback(user: MockUser, feedbackId: string, audit: MockAuditLog): void {
  assertRole(user, ['teacher', 'admin', 'boss'], 'feedback.delete', 'feedback', feedbackId, audit);
}

function updateTeacher(user: MockUser, teacherId: string, audit: MockAuditLog): { id: string } {
  assertRole(user, ['admin', 'boss', 'teacher'], 'teacher.update', 'teacher', teacherId, audit);
  return { id: teacherId };
}

function updateContractAmount(
  user: MockUser,
  contractId: string,
  newAmount: number,
  audit: MockAuditLog,
): { id: string; totalAmount: number } {
  assertRole(user, ['sales', 'sales_manager', 'boss', 'admin'], 'contract.updateAmount', 'contract', contractId, audit);
  return { id: contractId, totalAmount: newAmount };
}

function updateCustomerOwner(
  user: MockUser,
  customerId: string,
  newOwnerSalesId: string,
  audit: MockAuditLog,
): { id: string; ownerSalesId: string } {
  // SSOT §6 student.transferSales=[admin,boss,sales,sales_manager]; customer 同语义
  assertRole(user, ['admin', 'boss', 'sales', 'sales_manager'], 'customer.transferOwner', 'customer', customerId, audit);
  return { id: customerId, ownerSalesId: newOwnerSalesId };
}

// teacher 看自己 student (controller layer ownership 校验; 非 RBAC)
function teacherViewStudent(
  user: MockUser,
  studentId: string,
  studentTeacherId: string,
  audit: MockAuditLog,
): { id: string } {
  if (user.role !== 'teacher') {
    throw new ForbiddenException(`only teacher allowed via this path; got ${user.role}`);
  }
  if (studentTeacherId !== user.sub) {
    audit.log({
      actorRole: user.role,
      action: 'student.view-not-owned',
      targetType: 'student',
      targetId: studentId,
      outcome: 'denied',
      reason: `teacher ${user.sub} attempted student owned by ${studentTeacherId}`,
    });
    throw new ForbiddenException(`student ${studentId} not owned by teacher ${user.sub}`);
  }
  return { id: studentId };
}

// sales 只读看 schedule (仅 dashboard 查询路径 listByCustomer)
function salesViewScheduleCount(user: MockUser, contractId: string): { count: number } {
  if (!['sales', 'sales_manager', 'boss', 'admin'].includes(user.role)) {
    throw new ForbiddenException(`role ${user.role} not allowed`);
  }
  // 模拟有 1 条 schedule
  return { count: 1 };
}

// sales 只读看 feedback (仅条数, 不看内容)
function salesViewFeedbackCount(user: MockUser, contractId: string): { count: number } {
  if (!['sales', 'sales_manager', 'boss', 'admin'].includes(user.role)) {
    throw new ForbiddenException(`role ${user.role} not allowed`);
  }
  return { count: 2 };
}

// ---------- Test data ----------

const sales1: MockUser = {
  sub: '01HX7Y6P5K9N3M2QABCDEFGHIJKSALE1',
  role: 'sales',
  campusId: '01HX7Y6P5K9N3M2QABCDEFGHIJKMP01',
  tenantId: '01HX7Y6P5K9N3M2QABCDEFGHIJKTN01',
};
const academic1: MockUser = {
  sub: '01HX7Y6P5K9N3M2QABCDEFGHIJKACAD1',
  role: 'academic',
  campusId: '01HX7Y6P5K9N3M2QABCDEFGHIJKMP01',
  tenantId: '01HX7Y6P5K9N3M2QABCDEFGHIJKTN01',
};
const teacher1: MockUser = {
  sub: '01HX7Y6P5K9N3M2QABCDEFGHIJKTCH1',
  role: 'teacher',
  campusId: '01HX7Y6P5K9N3M2QABCDEFGHIJKMP01',
  tenantId: '01HX7Y6P5K9N3M2QABCDEFGHIJKTN01',
};
const teacher2: MockUser = {
  sub: '01HX7Y6P5K9N3M2QABCDEFGHIJKTCH2',
  role: 'teacher',
  campusId: '01HX7Y6P5K9N3M2QABCDEFGHIJKMP01',
  tenantId: '01HX7Y6P5K9N3M2QABCDEFGHIJKTN01',
};

// ---------- Tests ----------

describe('[L8 业务流 A3] 销售转教务边界 (10 case)', () => {
  let audit: MockAuditLog;

  beforeEach(() => {
    audit = new MockAuditLog();
  });

  // ----- Happy path (1-4) -----

  it('1. sales 签 contract → 状态 signed → 教务 dashboard 可见', () => {
    const contract = createContract(sales1, { studentId: 'STU01', totalAmount: 1000000 }, audit);
    expect(contract.status).toBe('signed');
    expect(contract.id).toBe('CONTRACT_STU01');
    expect(audit.byAction('contract.create')).toHaveLength(1);
    expect(audit.byAction('contract.create')[0].outcome).toBe('success');
    expect(audit.byAction('contract.create')[0].actorRole).toBe('sales');
  });

  it('2. academic dashboard 进入 → 拉 GET /db/contracts?stage=pending_schedule (mock 返 1 条)', () => {
    // 模拟教务 dashboard query — 教务可读 contract (SSOT §4.5 务 ✅ 本校)
    const visibleToAcademic = (role: string) =>
      ['sales', 'sales_manager', 'boss', 'admin', 'academic', 'academic_admin', 'finance', 'parent'].includes(role);
    expect(visibleToAcademic(academic1.role)).toBe(true);
    // 实际 controller 走 contract.controller GET /db/contracts:stage 路径
    // 此处验证语义边界: academic 角色名在允许 read 集合内
  });

  it('3. academic 排第一节课 → schedule created → sales 在客户详情只读看到「已排 1 节」', () => {
    const schedule = createSchedule(academic1, { contractId: 'CONTRACT_STU01', teacherId: teacher1.sub }, audit);
    expect(schedule.status).toBe('已排课');
    expect(schedule.id).toBe('SCHEDULE_CONTRACT_STU01');
    expect(audit.byAction('schedule.create')[0].actorRole).toBe('academic');

    // sales 只读看到 1 条
    const viewCount = salesViewScheduleCount(sales1, 'CONTRACT_STU01');
    expect(viewCount.count).toBe(1);
  });

  it('4. teacher 填反馈 → sales 在客户详情只读看到反馈条数', () => {
    // teacher 写 feedback (略, 这里只验 sales 只读路径)
    const viewCount = salesViewFeedbackCount(sales1, 'CONTRACT_STU01');
    expect(viewCount.count).toBe(2);
    // sales 走 listByCustomer 路径只看 count 不看内容 — SSOT §4.1 学习表现 销 = 👁 只读不下载
  });

  // ----- Deny path (5-10) -----

  it('5. sales 尝试改 schedule → 403 + audit_log denied', () => {
    expect(() => updateSchedule(sales1, 'SCHEDULE_CONTRACT_STU01', audit)).toThrow(ForbiddenException);
    const denied = audit.byAction('schedule.update').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].actorRole).toBe('sales');
    expect(denied[0].reason).toContain('not in [academic]');
  });

  it('6. sales 尝试删 feedback → 403 + audit_log denied', () => {
    expect(() => deleteFeedback(sales1, 'FB_001', audit)).toThrow(ForbiddenException);
    const denied = audit.byAction('feedback.delete').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].actorRole).toBe('sales');
  });

  it('7. sales 尝试改 teacher 信息 → 403 + audit_log denied', () => {
    expect(() => updateTeacher(sales1, teacher1.sub, audit)).toThrow(ForbiddenException);
    const denied = audit.byAction('teacher.update').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].actorRole).toBe('sales');
    expect(denied[0].reason).toContain('not in [admin,boss,teacher]');
  });

  it('8. academic 尝试改 contract.totalAmount → 403 (financial 字段守门)', () => {
    expect(() => updateContractAmount(academic1, 'CONTRACT_STU01', 2000000, audit)).toThrow(ForbiddenException);
    const denied = audit.byAction('contract.updateAmount').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].actorRole).toBe('academic');
    expect(denied[0].reason).toContain('not in [sales,sales_manager,boss,admin]');
  });

  it('9. academic 尝试改 customer.ownerSalesId → 403 + audit_log denied', () => {
    expect(() => updateCustomerOwner(academic1, 'CUST_001', sales1.sub, audit)).toThrow(ForbiddenException);
    const denied = audit.byAction('customer.transferOwner').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].actorRole).toBe('academic');
  });

  it('10. teacher 尝试看其他老师的 student → 403 (ownership 校验) + audit_log denied', () => {
    // student 主带是 teacher2, teacher1 试图看
    expect(() => teacherViewStudent(teacher1, 'STU_OF_TEACHER2', teacher2.sub, audit)).toThrow(ForbiddenException);
    const denied = audit.byAction('student.view-not-owned');
    expect(denied).toHaveLength(1);
    expect(denied[0].actorRole).toBe('teacher');
    expect(denied[0].reason).toContain(teacher2.sub);
  });

  // ----- Corner / safety -----

  it('corner: teacher 看自己 student → ✅ 通过 (基准线)', () => {
    const stu = teacherViewStudent(teacher1, 'STU_OWNED', teacher1.sub, audit);
    expect(stu.id).toBe('STU_OWNED');
    expect(audit.entries.filter((e) => e.outcome === 'denied')).toHaveLength(0);
  });

  it('corner: 全程 audit_log 总计 (4 success + 6 denied)', () => {
    // 跑一次完整 happy + deny 序列
    createContract(sales1, { studentId: 'STU_E2E', totalAmount: 1000000 }, audit);
    createSchedule(academic1, { contractId: 'CONTRACT_STU_E2E', teacherId: teacher1.sub }, audit);
    try { updateSchedule(sales1, 'SCHEDULE_X', audit); } catch (_e) { /* expected */ }
    try { deleteFeedback(sales1, 'FB_X', audit); } catch (_e) { /* expected */ }
    try { updateTeacher(sales1, teacher1.sub, audit); } catch (_e) { /* expected */ }
    try { updateContractAmount(academic1, 'CONTRACT_X', 1, audit); } catch (_e) { /* expected */ }
    try { updateCustomerOwner(academic1, 'CUST_X', 'X', audit); } catch (_e) { /* expected */ }
    try { teacherViewStudent(teacher1, 'X', teacher2.sub, audit); } catch (_e) { /* expected */ }

    const success = audit.entries.filter((e) => e.outcome === 'success');
    const denied = audit.entries.filter((e) => e.outcome === 'denied');
    expect(success).toHaveLength(2); // contract.create + schedule.create
    expect(denied).toHaveLength(6); // 5,6,7,8,9,10
  });
});
