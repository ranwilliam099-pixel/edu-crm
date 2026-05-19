/**
 * L8 业务流 F1 — 离职转交 (4 case)
 *
 * 来源:
 *   - v2.0 §5.F1
 *   - 5/12 P0 闭环: deactivated user 触发 customer/student.owner 必须 handover
 *   - V27 离职 migration
 *
 * 验证:
 *   - admin 标记 user.deactivated_at
 *   - 触发 customer/student.owner_sales_id 必须 handover
 *   - contract.ownerSalesId 历史保留 (审计透明)
 *   - deactivated user 登录 JWT 黑名单拒绝
 */
import { ForbiddenException, BadRequestException, UnauthorizedException } from '@nestjs/common';

interface AuditEntry {
  actorRole: string;
  action: string;
  outcome: 'success' | 'denied';
  meta?: Record<string, unknown>;
}
class MockAuditLog {
  entries: AuditEntry[] = [];
  log(e: AuditEntry): void {
    this.entries.push(e);
  }
  byAction(a: string): AuditEntry[] {
    return this.entries.filter((entry) => entry.action === a);
  }
}

interface MockUser {
  sub: string;
  role: 'sales' | 'academic' | 'admin' | 'boss' | 'teacher' | 'parent' | 'finance';
  tenantId: string;
  deactivatedAt?: Date;
}

interface Customer {
  id: string;
  ownerSalesId: string;
}
interface Student {
  id: string;
  ownerSalesId: string;
}
interface Contract {
  id: string;
  ownerSalesId: string; // 历史保留, 不级联改
}

class MockStore {
  users: Map<string, MockUser> = new Map();
  customers: Customer[] = [];
  students: Student[] = [];
  contracts: Contract[] = [];
  jwtBlacklist: Set<string> = new Set();
}

function deactivateUser(
  caller: MockUser,
  targetSub: string,
  store: MockStore,
  audit: MockAuditLog,
  now: Date = new Date(),
): MockUser {
  // 拍板: 只有 admin/boss 可标记离职
  if (!['admin', 'boss'].includes(caller.role)) {
    audit.log({ actorRole: caller.role, action: 'user.deactivate', outcome: 'denied', meta: { reason: 'role not allowed' } });
    throw new ForbiddenException(`role ${caller.role} cannot deactivate user`);
  }
  const target = store.users.get(targetSub);
  if (!target) throw new BadRequestException('user not found');
  target.deactivatedAt = now;

  // 加 JWT 黑名单 (拒绝后续登录)
  store.jwtBlacklist.add(targetSub);

  audit.log({
    actorRole: caller.role,
    action: 'user.deactivate',
    outcome: 'success',
    meta: { targetSub, deactivatedAt: now.toISOString(), jwtBlacklisted: true },
  });
  return target;
}

// handover 前置检查: 离职 sales 必须先 transfer ownership 才能完成 deactivate workflow
function requireHandoverBeforeFinish(
  targetSub: string,
  store: MockStore,
  audit: MockAuditLog,
): { customersToHandover: string[]; studentsToHandover: string[]; readyToFinish: boolean } {
  const custList = store.customers.filter((c) => c.ownerSalesId === targetSub).map((c) => c.id);
  const stuList = store.students.filter((s) => s.ownerSalesId === targetSub).map((s) => s.id);
  const ready = custList.length === 0 && stuList.length === 0;
  if (!ready) {
    audit.log({
      actorRole: 'system',
      action: 'offboard.handover-required',
      outcome: 'success',
      meta: { targetSub, customers: custList.length, students: stuList.length },
    });
  } else {
    audit.log({
      actorRole: 'system',
      action: 'offboard.handover-complete',
      outcome: 'success',
      meta: { targetSub },
    });
  }
  return { customersToHandover: custList, studentsToHandover: stuList, readyToFinish: ready };
}

function handoverOwnership(
  user: MockUser,
  body: { fromSalesId: string; toSalesId: string },
  store: MockStore,
  audit: MockAuditLog,
): { customersTransferred: number; studentsTransferred: number; contractsKept: number } {
  if (!['admin', 'boss', 'sales_manager'].includes(user.role)) {
    audit.log({ actorRole: user.role, action: 'handover.transfer', outcome: 'denied', meta: { reason: 'role not allowed' } });
    throw new ForbiddenException(`role ${user.role} cannot handover`);
  }
  let customersCount = 0;
  let studentsCount = 0;
  for (const c of store.customers) {
    if (c.ownerSalesId === body.fromSalesId) {
      c.ownerSalesId = body.toSalesId;
      customersCount++;
    }
  }
  for (const s of store.students) {
    if (s.ownerSalesId === body.fromSalesId) {
      s.ownerSalesId = body.toSalesId;
      studentsCount++;
    }
  }
  // 拍板: contract.ownerSalesId 历史保留, 不级联改
  const contractsKept = store.contracts.filter((c) => c.ownerSalesId === body.fromSalesId).length;
  audit.log({
    actorRole: user.role,
    action: 'handover.transfer',
    outcome: 'success',
    meta: { fromSalesId: body.fromSalesId, toSalesId: body.toSalesId, customers: customersCount, students: studentsCount, contractsKept },
  });
  return { customersTransferred: customersCount, studentsTransferred: studentsCount, contractsKept };
}

// JWT 验证 (登录路径)
function verifyJwt(sub: string, store: MockStore, audit: MockAuditLog): { ok: boolean; reason?: string } {
  if (store.jwtBlacklist.has(sub)) {
    audit.log({ actorRole: 'system', action: 'auth.jwt-blacklist-deny', outcome: 'denied', meta: { sub } });
    throw new UnauthorizedException('user has been deactivated; please contact admin');
  }
  return { ok: true };
}

// ---------- Test data ----------

const admin1: MockUser = { sub: 'ADM01', role: 'admin', tenantId: 'TNT01' };
const boss1: MockUser = { sub: 'BOSS01', role: 'boss', tenantId: 'TNT01' };
const sales1: MockUser = { sub: 'SAL01', role: 'sales', tenantId: 'TNT01' };
const salesLeaving: MockUser = { sub: 'SAL_LEAVING', role: 'sales', tenantId: 'TNT01' };
const salesReceiver: MockUser = { sub: 'SAL_RECEIVER', role: 'sales', tenantId: 'TNT01' };

function makeStore(): MockStore {
  const s = new MockStore();
  s.users.set(admin1.sub, { ...admin1 });
  s.users.set(boss1.sub, { ...boss1 });
  s.users.set(sales1.sub, { ...sales1 });
  s.users.set(salesLeaving.sub, { ...salesLeaving });
  s.users.set(salesReceiver.sub, { ...salesReceiver });
  s.customers.push({ id: 'CUST_01', ownerSalesId: salesLeaving.sub });
  s.customers.push({ id: 'CUST_02', ownerSalesId: salesLeaving.sub });
  s.students.push({ id: 'STU_01', ownerSalesId: salesLeaving.sub });
  s.contracts.push({ id: 'CONTRACT_HIST', ownerSalesId: salesLeaving.sub });
  return s;
}

describe('[L8 业务流 F1] 离职转交 (4 case)', () => {
  let store: MockStore;
  let audit: MockAuditLog;

  beforeEach(() => {
    store = makeStore();
    audit = new MockAuditLog();
  });

  it('F1.1 admin 在 hr/staff 标记 user.deactivated_at', () => {
    const now = new Date('2026-05-19T10:00:00Z');
    const user = deactivateUser(admin1, salesLeaving.sub, store, audit, now);
    expect(user.deactivatedAt).toEqual(now);
    const success = audit.byAction('user.deactivate').filter((e) => e.outcome === 'success');
    expect(success).toHaveLength(1);
    expect(success[0].meta?.targetSub).toBe(salesLeaving.sub);

    // sales 不能标记离职
    expect(() => deactivateUser(sales1, sales1.sub, store, audit)).toThrow(ForbiddenException);
  });

  it('F1.2 触发 customer.owner_sales_id / student.owner_sales_id 必须 handover', () => {
    deactivateUser(admin1, salesLeaving.sub, store, audit);

    // 在 handover 之前: 检查发现仍有 2 customer + 1 student 关联
    const check = requireHandoverBeforeFinish(salesLeaving.sub, store, audit);
    expect(check.readyToFinish).toBe(false);
    expect(check.customersToHandover).toEqual(['CUST_01', 'CUST_02']);
    expect(check.studentsToHandover).toEqual(['STU_01']);

    // handover
    const result = handoverOwnership(
      admin1,
      { fromSalesId: salesLeaving.sub, toSalesId: salesReceiver.sub },
      store,
      audit,
    );
    expect(result.customersTransferred).toBe(2);
    expect(result.studentsTransferred).toBe(1);

    // 再次检查 → ready
    const check2 = requireHandoverBeforeFinish(salesLeaving.sub, store, audit);
    expect(check2.readyToFinish).toBe(true);
    expect(audit.byAction('offboard.handover-complete')).toHaveLength(1);

    // sales 不能 handover
    expect(() =>
      handoverOwnership(sales1, { fromSalesId: salesLeaving.sub, toSalesId: salesReceiver.sub }, store, audit),
    ).toThrow(ForbiddenException);
  });

  it('F1.3 contract.ownerSalesId 历史保留 (不级联改, 审计透明)', () => {
    handoverOwnership(
      admin1,
      { fromSalesId: salesLeaving.sub, toSalesId: salesReceiver.sub },
      store,
      audit,
    );
    // contract 不改 (历史记录)
    const c = store.contracts.find((x) => x.id === 'CONTRACT_HIST');
    expect(c?.ownerSalesId).toBe(salesLeaving.sub); // 仍是离职销售

    const transfer = audit.byAction('handover.transfer').filter((e) => e.outcome === 'success');
    expect(transfer).toHaveLength(1);
    expect(transfer[0].meta?.contractsKept).toBe(1); // 历史保留 1 个
  });

  it('F1.4 deactivated user 登录 → JWT 黑名单 → 拒绝', () => {
    // 未离职 → OK
    const before = verifyJwt(salesLeaving.sub, store, audit);
    expect(before.ok).toBe(true);

    // 标记离职 → JWT 黑名单
    deactivateUser(admin1, salesLeaving.sub, store, audit);

    // 再次登录 → 拒绝
    expect(() => verifyJwt(salesLeaving.sub, store, audit)).toThrow(UnauthorizedException);
    const denied = audit.byAction('auth.jwt-blacklist-deny');
    expect(denied).toHaveLength(1);
    expect(denied[0].meta?.sub).toBe(salesLeaving.sub);

    // 没离职的 user 不受影响
    const r = verifyJwt(sales1.sub, store, audit);
    expect(r.ok).toBe(true);
  });
});
