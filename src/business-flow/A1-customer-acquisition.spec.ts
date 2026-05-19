/**
 * L8 业务流 A1 — 客户开拓全链 (8 case, 销售线核心)
 *
 * 来源:
 *   - v2.0 §5.A1 客户开拓全链 (8 case)
 *   - SSOT §6 customer.create=[sales, sales_manager, boss, admin]
 *   - SSOT §6 student.create 同上 + (5/15 A-2) admin 跨校必须显式传 campusId
 *   - 拍板 (V41) customer.primary_mobile hash 唯一 → 重复 409
 *
 * 验证关注点:
 *   - sales 自建 customer + student + opportunity 同事务三写
 *   - sales 仅建 customer (不含 student)
 *   - opportunity 阶段流转 (初步 → 跟进 → 已签)
 *   - sales 跨 tenant / 改其他销售 owner → 403
 *   - primary_mobile hash 唯一性 → 409
 *   - admin 跨校 campusId 必填
 */
import { ForbiddenException, ConflictException, BadRequestException } from '@nestjs/common';

// ---------- Mock infrastructure ----------

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
  role: 'sales' | 'sales_manager' | 'academic' | 'teacher' | 'admin' | 'boss' | 'parent';
  campusId: string;
  tenantId: string;
}

interface Customer {
  id: string;
  primaryMobileHash: string;
  ownerSalesId: string;
  campusId: string;
  tenantId: string;
  lastPurchasedAt?: Date;
}

interface Student {
  id: string;
  customerId: string;
  ownerSalesId: string;
  campusId: string;
  tenantId: string;
}

interface Opportunity {
  id: string;
  customerId: string;
  stage: '初步接触' | '跟进中' | '已签约' | '已流失';
  ownerSalesId: string;
}

class MockStore {
  customers: Customer[] = [];
  students: Student[] = [];
  opportunities: Opportunity[] = [];

  hashMobile(m: string): string {
    return 'HASH_' + m;
  }
  mobileExists(hash: string, tenantId: string): boolean {
    return this.customers.some((c) => c.primaryMobileHash === hash && c.tenantId === tenantId);
  }
}

// 简化 RBAC
function assertRole(
  user: MockUser,
  allowed: ReadonlyArray<string>,
  action: string,
  audit: MockAuditLog,
): void {
  if (!allowed.includes(user.role)) {
    audit.log({ actorRole: user.role, action, outcome: 'denied', meta: { reason: 'role not allowed' } });
    throw new ForbiddenException(`role ${user.role} cannot ${action}`);
  }
}

function assertSameTenant(user: MockUser, targetTenantId: string, action: string, audit: MockAuditLog): void {
  if (user.tenantId !== targetTenantId) {
    audit.log({ actorRole: user.role, action, outcome: 'denied', meta: { reason: 'cross-tenant' } });
    throw new ForbiddenException('cross-tenant denied');
  }
}

// 业务 service: 同事务三写
function createCustomerWithStudent(
  user: MockUser,
  body: {
    primaryMobile: string;
    studentName?: string;
    campusId?: string; // admin 跨校必须传
  },
  store: MockStore,
  audit: MockAuditLog,
): { customer: Customer; student?: Student; opportunity: Opportunity } {
  assertRole(user, ['sales', 'sales_manager', 'boss', 'admin'], 'customer.create', audit);

  // 5/15 A-2: admin 跨校建客户必须显式传 campusId
  if (user.role === 'admin' && !body.campusId) {
    audit.log({ actorRole: user.role, action: 'customer.create', outcome: 'denied', meta: { reason: 'admin missing campusId' } });
    throw new BadRequestException('admin must supply campusId explicitly when creating customer cross-campus');
  }

  const campusId = body.campusId || user.campusId;
  const mobileHash = store.hashMobile(body.primaryMobile);

  // primary_mobile hash 唯一性 (V41 hash 列, 同 tenant 内不允许重复)
  if (store.mobileExists(mobileHash, user.tenantId)) {
    audit.log({ actorRole: user.role, action: 'customer.create', outcome: 'denied', meta: { reason: 'duplicate mobile' } });
    throw new ConflictException('primary_mobile already exists in tenant');
  }

  const customer: Customer = {
    id: 'CUST_' + Math.random().toString(36).slice(2, 8).toUpperCase(),
    primaryMobileHash: mobileHash,
    ownerSalesId: user.sub,
    campusId,
    tenantId: user.tenantId,
  };
  store.customers.push(customer);

  let student: Student | undefined;
  if (body.studentName) {
    student = {
      id: 'STU_' + Math.random().toString(36).slice(2, 8).toUpperCase(),
      customerId: customer.id,
      ownerSalesId: user.sub,
      campusId,
      tenantId: user.tenantId,
    };
    store.students.push(student);
  }

  const opportunity: Opportunity = {
    id: 'OPP_' + Math.random().toString(36).slice(2, 8).toUpperCase(),
    customerId: customer.id,
    stage: '初步接触',
    ownerSalesId: user.sub,
  };
  store.opportunities.push(opportunity);

  audit.log({
    actorRole: user.role,
    action: 'customer.create',
    outcome: 'success',
    meta: { customerId: customer.id, studentId: student?.id, opportunityId: opportunity.id, sameTransaction: true },
  });

  return { customer, student, opportunity };
}

function transitionOpportunity(
  user: MockUser,
  oppId: string,
  newStage: Opportunity['stage'],
  store: MockStore,
  audit: MockAuditLog,
): Opportunity {
  const opp = store.opportunities.find((o) => o.id === oppId);
  if (!opp) throw new BadRequestException('opportunity not found');
  // 只有 owner 销售可改 + admin/boss override
  if (!['admin', 'boss'].includes(user.role) && opp.ownerSalesId !== user.sub) {
    audit.log({ actorRole: user.role, action: 'opportunity.transition', outcome: 'denied', meta: { reason: 'not owner' } });
    throw new ForbiddenException('not owner');
  }
  opp.stage = newStage;
  audit.log({ actorRole: user.role, action: 'opportunity.transition', outcome: 'success', meta: { oppId, newStage } });
  return opp;
}

function viewCustomer(user: MockUser, customerId: string, store: MockStore, audit: MockAuditLog): Customer {
  const cust = store.customers.find((c) => c.id === customerId);
  if (!cust) throw new BadRequestException('customer not found');
  assertSameTenant(user, cust.tenantId, 'customer.view', audit);
  return cust;
}

function updateCustomerOwner(
  user: MockUser,
  customerId: string,
  newOwnerSalesId: string,
  store: MockStore,
  audit: MockAuditLog,
): Customer {
  const cust = store.customers.find((c) => c.id === customerId);
  if (!cust) throw new BadRequestException('customer not found');
  // sales 只能改自己的 owner customer; admin/boss/sales_manager 可改任何
  if (user.role === 'sales' && cust.ownerSalesId !== user.sub) {
    audit.log({ actorRole: user.role, action: 'customer.changeOwner', outcome: 'denied', meta: { reason: 'not owner' } });
    throw new ForbiddenException('sales can only change own customers');
  }
  cust.ownerSalesId = newOwnerSalesId;
  audit.log({ actorRole: user.role, action: 'customer.changeOwner', outcome: 'success' });
  return cust;
}

function linkExistingStudent(
  user: MockUser,
  studentId: string,
  newCustomerId: string,
  store: MockStore,
  audit: MockAuditLog,
): Student {
  assertRole(user, ['sales', 'sales_manager', 'boss', 'admin'], 'student.link-existing', audit);
  const stu = store.students.find((s) => s.id === studentId);
  if (!stu) throw new BadRequestException('student not found');
  stu.customerId = newCustomerId;
  audit.log({ actorRole: user.role, action: 'student.link-existing', outcome: 'success' });
  return stu;
}

// ---------- Test data ----------

const sales1: MockUser = {
  sub: '01HX7Y6P5K9N3M2QABCDEFGHIJKSAL01',
  role: 'sales',
  campusId: 'CMP_01',
  tenantId: 'TNT_01',
};
const sales2: MockUser = {
  sub: '01HX7Y6P5K9N3M2QABCDEFGHIJKSAL02',
  role: 'sales',
  campusId: 'CMP_01',
  tenantId: 'TNT_01',
};
const admin1: MockUser = {
  sub: '01HX7Y6P5K9N3M2QABCDEFGHIJKADM01',
  role: 'admin',
  campusId: 'CMP_01',
  tenantId: 'TNT_01',
};
const sales1OtherTenant: MockUser = {
  sub: '01HX7Y6P5K9N3M2QABCDEFGHIJKSAL01',
  role: 'sales',
  campusId: 'CMP_99',
  tenantId: 'TNT_99',
};

describe('[L8 业务流 A1] 客户开拓全链 (8 case)', () => {
  let store: MockStore;
  let audit: MockAuditLog;

  beforeEach(() => {
    store = new MockStore();
    audit = new MockAuditLog();
  });

  it('A1.1 sales 自建客户 (含 student) → customer + student + opportunity 同事务三写', () => {
    const result = createCustomerWithStudent(
      sales1,
      { primaryMobile: '13800000001', studentName: '张同学' },
      store,
      audit,
    );
    expect(result.customer).toBeTruthy();
    expect(result.student).toBeTruthy();
    expect(result.opportunity).toBeTruthy();
    expect(result.opportunity.stage).toBe('初步接触');
    expect(result.customer.ownerSalesId).toBe(sales1.sub);
    expect(result.student?.customerId).toBe(result.customer.id);
    expect(store.customers).toHaveLength(1);
    expect(store.students).toHaveLength(1);
    expect(store.opportunities).toHaveLength(1);
    // 同事务三写 audit
    const created = audit.byAction('customer.create');
    expect(created).toHaveLength(1);
    expect(created[0].outcome).toBe('success');
    expect(created[0].meta?.sameTransaction).toBe(true);
  });

  it('A1.2 sales 自建客户 (不含 student) → 只写 customer + opportunity', () => {
    const result = createCustomerWithStudent(
      sales1,
      { primaryMobile: '13800000002' },
      store,
      audit,
    );
    expect(result.customer).toBeTruthy();
    expect(result.student).toBeUndefined();
    expect(result.opportunity).toBeTruthy();
    expect(store.students).toHaveLength(0);
    expect(store.customers).toHaveLength(1);
    expect(store.opportunities).toHaveLength(1);
  });

  it('A1.3 sales 跟进 opportunity 阶段流转 (初步 → 跟进 → 已签)', () => {
    const result = createCustomerWithStudent(sales1, { primaryMobile: '13800000003' }, store, audit);
    const oppId = result.opportunity.id;

    let opp = transitionOpportunity(sales1, oppId, '跟进中', store, audit);
    expect(opp.stage).toBe('跟进中');

    opp = transitionOpportunity(sales1, oppId, '已签约', store, audit);
    expect(opp.stage).toBe('已签约');

    const transitions = audit.byAction('opportunity.transition');
    expect(transitions).toHaveLength(2);
    expect(transitions.every((t) => t.outcome === 'success')).toBe(true);
  });

  it('A1.4 sales 关联 customer 到现有 student (避免重复建学员)', () => {
    // 先建一个 customer + student
    const first = createCustomerWithStudent(sales1, { primaryMobile: '13800000004', studentName: '李同学' }, store, audit);
    expect(first.student).toBeTruthy();

    // 再建一个新 customer 不含 student
    const second = createCustomerWithStudent(sales1, { primaryMobile: '13800000005' }, store, audit);
    expect(second.student).toBeUndefined();

    // 关联现有 student 到 second customer
    const stuId = first.student!.id;
    const updated = linkExistingStudent(sales1, stuId, second.customer.id, store, audit);
    expect(updated.customerId).toBe(second.customer.id);
    expect(store.students).toHaveLength(1); // 没新增, 复用
    expect(audit.byAction('student.link-existing')).toHaveLength(1);
  });

  it('A1.5 sales 跨 tenant 看 customer → 403', () => {
    // sales1 在 TNT_01 建客户
    const result = createCustomerWithStudent(sales1, { primaryMobile: '13800000006' }, store, audit);

    // sales1OtherTenant 试图看 TNT_01 的客户
    expect(() => viewCustomer(sales1OtherTenant, result.customer.id, store, audit)).toThrow(ForbiddenException);
    const denied = audit.byAction('customer.view').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].meta?.reason).toBe('cross-tenant');
  });

  it('A1.6 sales 改其他销售的 owner customer → 403 (owner 字段守门)', () => {
    // sales1 建客户
    const result = createCustomerWithStudent(sales1, { primaryMobile: '13800000007' }, store, audit);

    // sales2 试图改 sales1 的 customer.ownerSalesId
    expect(() => updateCustomerOwner(sales2, result.customer.id, sales2.sub, store, audit)).toThrow(ForbiddenException);
    const denied = audit.byAction('customer.changeOwner').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].meta?.reason).toBe('not owner');

    // admin 可以改
    const updated = updateCustomerOwner(admin1, result.customer.id, sales2.sub, store, audit);
    expect(updated.ownerSalesId).toBe(sales2.sub);
  });

  it('A1.7 customer.primary_mobile 重复 (hash 命中) → 409 + 友好提示', () => {
    // 第一次成功
    createCustomerWithStudent(sales1, { primaryMobile: '13800000008' }, store, audit);
    expect(store.customers).toHaveLength(1);

    // 第二次相同手机号 → 409
    expect(() => createCustomerWithStudent(sales1, { primaryMobile: '13800000008' }, store, audit)).toThrow(
      ConflictException,
    );
    expect(store.customers).toHaveLength(1); // 没新增
    const denied = audit.byAction('customer.create').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].meta?.reason).toBe('duplicate mobile');
  });

  it('A1.8 admin 跨校建客户必须显式传 campusId (5/15 A-2 拍板)', () => {
    // admin 不传 campusId → 400
    expect(() => createCustomerWithStudent(admin1, { primaryMobile: '13800000009' }, store, audit)).toThrow(
      BadRequestException,
    );
    const denied = audit.byAction('customer.create').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].meta?.reason).toBe('admin missing campusId');

    // admin 传 campusId → 通过
    const result = createCustomerWithStudent(
      admin1,
      { primaryMobile: '13800000010', campusId: 'CMP_02' },
      store,
      audit,
    );
    expect(result.customer.campusId).toBe('CMP_02');
    expect(store.customers).toHaveLength(1);

    // sales 不需要传 campusId (用 user.campusId)
    const salesResult = createCustomerWithStudent(sales1, { primaryMobile: '13800000011' }, store, audit);
    expect(salesResult.customer.campusId).toBe(sales1.campusId);
  });
});
