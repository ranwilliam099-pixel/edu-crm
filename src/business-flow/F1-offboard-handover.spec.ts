/**
 * L8 业务流 F1 — 离职转交 (5 case, P1-4 round 2 jti 改造)
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
 *   - deactivated user 登录 JWT 黑名单拒绝（按 jti 不按 sub）
 *   - 同一 user 不同 jti 历史 JWT 仍被拦（jti 批量加入黑名单）
 *
 * P1-4 round 2 改造（2026-05-19）：
 *   原 blacklist 按 sub（用户标识）拒绝。但 JWT 黑名单的正确语义是按 jti（token 标识）：
 *     - sub = 用户身份（永久），jti = token 实例（一次性）
 *     - 离职时撤销「用户全部 active jti」（按 sub 反向查 jti list）
 *     - 撤销后老 token 立即失效，未来该 user 重新激活不影响
 *   生产 src/modules/auth/jwt.strategy.ts 黑名单按 jti 不按 sub。
 *   现 spec 改为 mock JWT payload 含 jti 字段，jwtBlacklist 存 jti，verifyJwt 按 payload.jti 校验。
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
  // P1-4 round 2: user 当前持有的所有 active jti（在 issue 新 token 时追加，离职时整批拉黑）
  activeJtis: Set<string>;
}

// JWT payload 简化版（与生产 jwt-payload.interface.ts 接口）
interface MockJwtPayload {
  sub: string;
  jti: string; // JWT ID — 唯一识别本次签发的 token 实例
  role: string;
  tenantId: string;
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
  // P1-4 round 2: 黑名单存 jti（token 实例），不存 sub（用户标识）
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

  // P1-4 round 2: 整批拉黑 user 当前 active 的所有 jti（按 sub 反向查 jti list）
  // 不是把 sub 加入黑名单 — 那样老 token 仍能用 sub 通过 token decode 后旁路
  const revokedJtis = [...target.activeJtis];
  for (const jti of revokedJtis) {
    store.jwtBlacklist.add(jti);
  }
  target.activeJtis.clear(); // user 离职后 active jti 清零

  audit.log({
    actorRole: caller.role,
    action: 'user.deactivate',
    outcome: 'success',
    meta: {
      targetSub,
      deactivatedAt: now.toISOString(),
      revokedJtiCount: revokedJtis.length, // P1-4: 黑名单记录的是 token 实例数
    },
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

// JWT 验证 (登录路径) — P1-4 round 2: 按 payload.jti 校验黑名单
function verifyJwt(payload: MockJwtPayload, store: MockStore, audit: MockAuditLog): { ok: boolean; reason?: string } {
  // 按 jti 校验黑名单（不按 sub — 防 user 离职后老 token 旁路）
  if (store.jwtBlacklist.has(payload.jti)) {
    audit.log({
      actorRole: 'system',
      action: 'auth.jwt-blacklist-deny',
      outcome: 'denied',
      meta: { sub: payload.sub, jti: payload.jti },
    });
    throw new UnauthorizedException('token revoked (user deactivated); please contact admin');
  }
  return { ok: true };
}

// Helper：模拟 user 登录 → 后端 issue 新 jti → 加入 activeJtis（用于测「新 jti 不被旧 deactivate 影响」）
function issueJwtForUser(user: MockUser, jti: string): MockJwtPayload {
  user.activeJtis.add(jti);
  return { sub: user.sub, jti, role: user.role, tenantId: user.tenantId };
}

// ---------- Test data ----------

// 用 factory 函数防 ...spread 丢失 Set（深克隆）
const mkAdmin = (): MockUser => ({ sub: 'ADM01', role: 'admin', tenantId: 'TNT01', activeJtis: new Set() });
const mkBoss = (): MockUser => ({ sub: 'BOSS01', role: 'boss', tenantId: 'TNT01', activeJtis: new Set() });
const mkSales = (): MockUser => ({ sub: 'SAL01', role: 'sales', tenantId: 'TNT01', activeJtis: new Set() });
const mkSalesLeaving = (): MockUser => ({ sub: 'SAL_LEAVING', role: 'sales', tenantId: 'TNT01', activeJtis: new Set() });
const mkSalesReceiver = (): MockUser => ({ sub: 'SAL_RECEIVER', role: 'sales', tenantId: 'TNT01', activeJtis: new Set() });

// 顶层只读 user 引用（用于 sub 字符串、role 校验）
const admin1 = mkAdmin();
const boss1 = mkBoss();
const sales1 = mkSales();
const salesLeaving = mkSalesLeaving();
const salesReceiver = mkSalesReceiver();

function makeStore(): MockStore {
  const s = new MockStore();
  s.users.set(admin1.sub, mkAdmin());
  s.users.set(boss1.sub, mkBoss());
  s.users.set(sales1.sub, mkSales());
  s.users.set(salesLeaving.sub, mkSalesLeaving());
  s.users.set(salesReceiver.sub, mkSalesReceiver());
  s.customers.push({ id: 'CUST_01', ownerSalesId: salesLeaving.sub });
  s.customers.push({ id: 'CUST_02', ownerSalesId: salesLeaving.sub });
  s.students.push({ id: 'STU_01', ownerSalesId: salesLeaving.sub });
  s.contracts.push({ id: 'CONTRACT_HIST', ownerSalesId: salesLeaving.sub });
  return s;
}

describe('[L8 业务流 F1] 离职转交 (5 case, P1-4 round 2 jti 改造)', () => {
  let store: MockStore;
  let audit: MockAuditLog;

  beforeEach(() => {
    store = makeStore();
    audit = new MockAuditLog();
  });

  it('F1.1 admin 在 hr/staff 标记 user.deactivated_at', () => {
    const now = new Date('2026-05-19T10:00:00Z');
    // P1-4 round 2: 先给 user issue 一个 jti（模拟登录中），离职时应被拉黑
    const target = store.users.get(salesLeaving.sub)!;
    target.activeJtis.add('jti_test_001');

    const user = deactivateUser(admin1, salesLeaving.sub, store, audit, now);
    expect(user.deactivatedAt).toEqual(now);
    const success = audit.byAction('user.deactivate').filter((e) => e.outcome === 'success');
    expect(success).toHaveLength(1);
    expect(success[0].meta?.targetSub).toBe(salesLeaving.sub);
    // P1-4: audit meta 记 jti 撤销数量
    expect(success[0].meta?.revokedJtiCount).toBe(1);
    expect(store.jwtBlacklist.has('jti_test_001')).toBe(true);

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

  it('F1.4 deactivated user 历史 JWT → jti 黑名单 → 拒绝（P1-4 round 2）', () => {
    // 给 leaving user 签发一个 JWT（含 jti）
    const leavingUser = store.users.get(salesLeaving.sub)!;
    const leavingPayload = issueJwtForUser(leavingUser, 'jti_leaving_001');

    // 未离职 → OK
    const before = verifyJwt(leavingPayload, store, audit);
    expect(before.ok).toBe(true);

    // 标记离职 → jti 整批拉黑
    deactivateUser(admin1, salesLeaving.sub, store, audit);

    // 同一 jti 再用 → 拒绝
    expect(() => verifyJwt(leavingPayload, store, audit)).toThrow(UnauthorizedException);
    const denied = audit.byAction('auth.jwt-blacklist-deny');
    expect(denied).toHaveLength(1);
    expect(denied[0].meta?.sub).toBe(salesLeaving.sub);
    expect(denied[0].meta?.jti).toBe('jti_leaving_001');

    // 没离职的 user 用自己 jti 不受影响
    const otherUser = store.users.get(sales1.sub)!;
    const otherPayload = issueJwtForUser(otherUser, 'jti_other_001');
    const r = verifyJwt(otherPayload, store, audit);
    expect(r.ok).toBe(true);
  });

  it('F1.5 同 user 多个 active jti 全部拉黑（不只拉黑当前请求的 jti）', () => {
    const target = store.users.get(salesLeaving.sub)!;
    // 模拟 user 同时在 3 个设备登录（3 个 jti）
    const p1 = issueJwtForUser(target, 'jti_dev_phone');
    const p2 = issueJwtForUser(target, 'jti_dev_tablet');
    const p3 = issueJwtForUser(target, 'jti_dev_laptop');

    // 3 个 jti 都还在 active
    expect(target.activeJtis.size).toBe(3);

    // 离职
    deactivateUser(admin1, salesLeaving.sub, store, audit);

    // 3 个 jti 全在 blacklist
    expect(store.jwtBlacklist.has('jti_dev_phone')).toBe(true);
    expect(store.jwtBlacklist.has('jti_dev_tablet')).toBe(true);
    expect(store.jwtBlacklist.has('jti_dev_laptop')).toBe(true);

    // 3 个设备的 token 都被拒绝
    expect(() => verifyJwt(p1, store, audit)).toThrow(UnauthorizedException);
    expect(() => verifyJwt(p2, store, audit)).toThrow(UnauthorizedException);
    expect(() => verifyJwt(p3, store, audit)).toThrow(UnauthorizedException);

    // activeJtis 清零
    expect(target.activeJtis.size).toBe(0);

    // audit meta 记 revokedJtiCount=3
    const success = audit.byAction('user.deactivate').filter((e) => e.outcome === 'success');
    expect(success[0].meta?.revokedJtiCount).toBe(3);
  });
});
