/**
 * L8 业务流 A2 — 续费全链 (5 case)
 *
 * 来源:
 *   - v2.0 §5.A2 续费全链
 *   - SSOT §6 contract.create=[sales, sales_manager, boss, admin]
 *   - 拍板 G3: course_packages_balance < 5 → 提醒销售续费 (单阈值)
 *   - 拍板: 续费课时累加 (不覆盖旧 balance), customer.last_purchased_at 更新
 *
 * 验证:
 *   - sales 在 student 详情发起续费 → 新 opportunity (stage=续费) + 新 contract (orderType=续费)
 *   - 续费合同生效后课时包余额累加 (旧 10 + 新 20 = 30)
 *   - 续费触发 customer.last_purchased_at 更新
 *   - academic 提醒销售续费 (balance < 5 G3 阈值)
 *   - academic / parent 直接续费 → 403
 */
import { ForbiddenException } from '@nestjs/common';

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
  role: 'sales' | 'sales_manager' | 'academic' | 'admin' | 'boss' | 'parent' | 'teacher';
  tenantId: string;
}

interface Contract {
  id: string;
  studentId: string;
  totalAmount: number;
  hours: number;
  orderType: '首次' | '续费';
  signedAt: Date;
  ownerSalesId: string;
}

interface CoursePackageBalance {
  studentId: string;
  totalHours: number;
  remainingHours: number;
}

interface Opportunity {
  id: string;
  customerId: string;
  stage: '初步接触' | '跟进中' | '已签约' | '续费';
}

class MockStore {
  contracts: Contract[] = [];
  balances: Map<string, CoursePackageBalance> = new Map();
  opportunities: Opportunity[] = [];
  customerLastPurchased: Map<string, Date> = new Map();
}

function renew(
  user: MockUser,
  body: { studentId: string; customerId: string; hours: number; totalAmount: number },
  store: MockStore,
  audit: MockAuditLog,
  now: Date = new Date(),
): { contract: Contract; opportunity: Opportunity; newBalance: CoursePackageBalance } {
  // SSOT §6 contract.create=[sales, sales_manager, boss, admin]
  if (!['sales', 'sales_manager', 'boss', 'admin'].includes(user.role)) {
    audit.log({ actorRole: user.role, action: 'contract.renew', outcome: 'denied', meta: { reason: 'role not allowed' } });
    throw new ForbiddenException(`role ${user.role} cannot create renewal contract`);
  }

  const opportunity: Opportunity = {
    id: 'OPP_' + Math.random().toString(36).slice(2, 8).toUpperCase(),
    customerId: body.customerId,
    stage: '续费',
  };
  store.opportunities.push(opportunity);

  const contract: Contract = {
    id: 'CONTRACT_' + Math.random().toString(36).slice(2, 8).toUpperCase(),
    studentId: body.studentId,
    totalAmount: body.totalAmount,
    hours: body.hours,
    orderType: '续费',
    signedAt: now,
    ownerSalesId: user.sub,
  };
  store.contracts.push(contract);

  // 课时包累加 (不覆盖旧 balance)
  const existing = store.balances.get(body.studentId);
  const newBalance: CoursePackageBalance = existing
    ? {
        studentId: body.studentId,
        totalHours: existing.totalHours + body.hours,
        remainingHours: existing.remainingHours + body.hours,
      }
    : {
        studentId: body.studentId,
        totalHours: body.hours,
        remainingHours: body.hours,
      };
  store.balances.set(body.studentId, newBalance);

  // last_purchased_at 更新
  store.customerLastPurchased.set(body.customerId, now);

  audit.log({
    actorRole: user.role,
    action: 'contract.renew',
    outcome: 'success',
    meta: {
      contractId: contract.id,
      opportunityId: opportunity.id,
      balanceAfter: newBalance.remainingHours,
      lastPurchasedAt: now.toISOString(),
    },
  });

  return { contract, opportunity, newBalance };
}

// academic 看到 balance < 5 → 提醒 sales 续费 (拍板 G3)
function academicReminderToSales(
  user: MockUser,
  balance: CoursePackageBalance,
  audit: MockAuditLog,
): { reminded: boolean; reason?: string } {
  if (!['academic', 'academic_admin'].includes(user.role)) {
    return { reminded: false, reason: 'caller not academic' };
  }
  if (balance.remainingHours < 5) {
    audit.log({
      actorRole: user.role,
      action: 'academic.remind-renewal',
      outcome: 'success',
      meta: { studentId: balance.studentId, remaining: balance.remainingHours },
    });
    return { reminded: true };
  }
  return { reminded: false, reason: 'balance not below threshold' };
}

const sales1: MockUser = { sub: 'SAL01', role: 'sales', tenantId: 'TNT01' };
const academic1: MockUser = { sub: 'ACAD01', role: 'academic', tenantId: 'TNT01' };
const parent1: MockUser = { sub: 'PAR01', role: 'parent', tenantId: 'TNT01' };
const admin1: MockUser = { sub: 'ADM01', role: 'admin', tenantId: 'TNT01' };

describe('[L8 业务流 A2] 续费全链 (5 case)', () => {
  let store: MockStore;
  let audit: MockAuditLog;

  beforeEach(() => {
    store = new MockStore();
    audit = new MockAuditLog();
  });

  it('A2.1 sales 发起续费 → 新 opportunity (stage=续费) + 新 contract (orderType=续费)', () => {
    const result = renew(
      sales1,
      { studentId: 'STU01', customerId: 'CUST01', hours: 20, totalAmount: 800000 },
      store,
      audit,
    );
    expect(result.contract.orderType).toBe('续费');
    expect(result.opportunity.stage).toBe('续费');
    expect(result.contract.ownerSalesId).toBe(sales1.sub);
    expect(store.contracts).toHaveLength(1);
    expect(store.opportunities).toHaveLength(1);
    expect(audit.byAction('contract.renew')).toHaveLength(1);
    expect(audit.byAction('contract.renew')[0].outcome).toBe('success');
  });

  it('A2.2 续费合同生效后课时包余额累加 (不覆盖旧 balance)', () => {
    // 先有旧 balance 10 课时
    store.balances.set('STU02', { studentId: 'STU02', totalHours: 30, remainingHours: 10 });

    const result = renew(
      sales1,
      { studentId: 'STU02', customerId: 'CUST02', hours: 20, totalAmount: 800000 },
      store,
      audit,
    );
    // 累加 10 + 20 = 30
    expect(result.newBalance.remainingHours).toBe(30);
    expect(result.newBalance.totalHours).toBe(50); // 30 + 20
    // 不覆盖
    expect(store.balances.get('STU02')?.remainingHours).toBe(30);
  });

  it('A2.3 续费触发 customer.last_purchased_at 更新', () => {
    const now = new Date('2026-05-19T10:00:00Z');
    expect(store.customerLastPurchased.get('CUST03')).toBeUndefined();

    renew(
      sales1,
      { studentId: 'STU03', customerId: 'CUST03', hours: 10, totalAmount: 400000 },
      store,
      audit,
      now,
    );
    expect(store.customerLastPurchased.get('CUST03')).toEqual(now);

    // 再次续费 → 更新到新时间
    const later = new Date('2026-08-19T10:00:00Z');
    renew(
      sales1,
      { studentId: 'STU03', customerId: 'CUST03', hours: 5, totalAmount: 200000 },
      store,
      audit,
      later,
    );
    expect(store.customerLastPurchased.get('CUST03')).toEqual(later);
  });

  it('A2.4 academic 提醒销售续费 (balance < 5 触发, G3 拍板)', () => {
    const lowBalance: CoursePackageBalance = { studentId: 'STU04', totalHours: 20, remainingHours: 4 };
    const result = academicReminderToSales(academic1, lowBalance, audit);
    expect(result.reminded).toBe(true);
    expect(audit.byAction('academic.remind-renewal')).toHaveLength(1);

    // balance = 5 (临界值) → 不触发
    audit.entries.length = 0;
    const atThreshold: CoursePackageBalance = { studentId: 'STU05', totalHours: 20, remainingHours: 5 };
    const result2 = academicReminderToSales(academic1, atThreshold, audit);
    expect(result2.reminded).toBe(false);
    expect(audit.byAction('academic.remind-renewal')).toHaveLength(0);

    // balance > 5 → 不触发
    const high: CoursePackageBalance = { studentId: 'STU06', totalHours: 20, remainingHours: 10 };
    const result3 = academicReminderToSales(academic1, high, audit);
    expect(result3.reminded).toBe(false);
  });

  it('A2.5 academic / parent 直接续费 → 403 (必须 sales 发起)', () => {
    expect(() =>
      renew(academic1, { studentId: 'STU07', customerId: 'CUST07', hours: 10, totalAmount: 400000 }, store, audit),
    ).toThrow(ForbiddenException);
    expect(() =>
      renew(parent1, { studentId: 'STU07', customerId: 'CUST07', hours: 10, totalAmount: 400000 }, store, audit),
    ).toThrow(ForbiddenException);
    const denied = audit.byAction('contract.renew').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(2);
    expect(denied.map((d) => d.actorRole).sort()).toEqual(['academic', 'parent']);
    // admin 可以
    const result = renew(
      admin1,
      { studentId: 'STU08', customerId: 'CUST08', hours: 10, totalAmount: 400000 },
      store,
      audit,
    );
    expect(result.contract.orderType).toBe('续费');
  });
});
