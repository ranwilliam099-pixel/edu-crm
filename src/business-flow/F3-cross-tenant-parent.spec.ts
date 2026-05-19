/**
 * L8 业务流 F3 — 跨 tenant 家长 (6 case, P1-3 round 2 真 HMAC-SHA256 改造)
 *
 * 来源:
 *   - v2.0 §5.F3 跨 tenant 家长
 *   - V40 parents.phone_hash 唯一
 *   - public.parents + public.parent_student_bindings (跨 tenant)
 *
 * 验证:
 *   - parent 注册 (public.parents)
 *   - parent 绑定 student (public.parent_student_bindings × N tenant)
 *   - parent home 聚合多 tenant 学员视图
 *   - parent 跨 tenant 反馈聚合
 *   - V40 phone_hash 唯一性
 *   - parent 看非自己绑定 student → 403
 *
 * P1-3 round 2 改造（2026-05-19）：
 *   原 hashPhone = 'PH_' + phone 是明文拼接 — 同 phone 输入永远同输出，但**不等价于 HMAC-SHA256**。
 *   现改用真实 crypto.createHmac('sha256', HASH_KEY)，输出 32 字节 Buffer：
 *     - 同输入 + 同 key → 同输出（确定性，可建唯一索引 / WHERE 等值查询）
 *     - 同输入 + 不同 key → 不同输出
 *     - 不同输入 + 同 key → 不同输出（碰撞概率 2^-128 可忽略）
 *   断言改为 instanceof Buffer + length=32 + timingSafeEqual 比对（与生产 HmacHasher 一致）。
 */
import { ForbiddenException, ConflictException, BadRequestException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';

// P1-3: 真实 HMAC-SHA256 hashPhone（与生产 src/common/crypto/hmac-hasher.ts 同算法）
// HASH_KEY 用 32 字节固定测试 key（与 spec 通用的 0x01 重复 key 一致，避免 jest.setup 全 0 冲突）
const TEST_HASH_KEY = Buffer.alloc(32, 0x01);
function hashPhoneReal(phone: string): Buffer {
  return createHmac('sha256', TEST_HASH_KEY).update(phone).digest();
}

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

interface Parent {
  id: string;
  phoneHash: Buffer; // V40 — 真 HMAC-SHA256 32 字节
  encryptedPhone: string; // V41 mock encrypted
  createdAt: Date;
}

interface ParentStudentBinding {
  parentId: string;
  studentId: string;
  tenantId: string;
  status: 'active' | 'archived';
}

interface Feedback {
  id: string;
  studentId: string;
  tenantId: string;
  content: string;
}

class MockStore {
  parents: Parent[] = [];
  bindings: ParentStudentBinding[] = [];
  feedbacks: Feedback[] = [];
  // P1-3 round 2: 用真 HMAC-SHA256（与生产 HmacHasher 同算法）
  hashPhone(phone: string): Buffer {
    return hashPhoneReal(phone);
  }
  encryptPhone(phone: string): string {
    return 'ENC_' + phone;
  }
}

function registerParent(phone: string, store: MockStore, audit: MockAuditLog, now: Date = new Date()): Parent {
  const phoneHash = store.hashPhone(phone);
  // V40 phone_hash 唯一 — 用 timingSafeEqual 比对 Buffer（防侧信道，且 Buffer === 是引用比较不等价于内容比较）
  const existing = store.parents.find(
    (p) => p.phoneHash.length === phoneHash.length && timingSafeEqual(p.phoneHash, phoneHash),
  );
  if (existing) {
    audit.log({ actorRole: 'parent', action: 'parent.register', outcome: 'denied', meta: { reason: 'phone exists' } });
    throw new ConflictException('phone already registered');
  }
  const parent: Parent = {
    id: 'PAR_' + Math.random().toString(36).slice(2, 8).toUpperCase(),
    phoneHash,
    encryptedPhone: store.encryptPhone(phone),
    createdAt: now,
  };
  store.parents.push(parent);
  audit.log({ actorRole: 'parent', action: 'parent.register', outcome: 'success', meta: { parentId: parent.id } });
  return parent;
}

function bindStudent(
  parentId: string,
  studentId: string,
  tenantId: string,
  store: MockStore,
  audit: MockAuditLog,
): ParentStudentBinding {
  // 同 parent + student + tenant 已绑 → idempotent (不重复创建)
  const existing = store.bindings.find(
    (b) => b.parentId === parentId && b.studentId === studentId && b.tenantId === tenantId,
  );
  if (existing) return existing;
  const b: ParentStudentBinding = { parentId, studentId, tenantId, status: 'active' };
  store.bindings.push(b);
  audit.log({ actorRole: 'system', action: 'binding.create', outcome: 'success', meta: { parentId, studentId, tenantId } });
  return b;
}

function parentHomeAggregateStudents(parentId: string, store: MockStore): { tenantId: string; students: string[] }[] {
  const myBindings = store.bindings.filter((b) => b.parentId === parentId && b.status === 'active');
  const grouped: Map<string, string[]> = new Map();
  for (const b of myBindings) {
    if (!grouped.has(b.tenantId)) grouped.set(b.tenantId, []);
    grouped.get(b.tenantId)!.push(b.studentId);
  }
  return Array.from(grouped, ([tenantId, students]) => ({ tenantId, students }));
}

function parentCrossTenantFeedbacks(parentId: string, store: MockStore): Feedback[] {
  const myBindings = store.bindings.filter((b) => b.parentId === parentId && b.status === 'active');
  const tenantStudentPairs = new Set(myBindings.map((b) => `${b.tenantId}:${b.studentId}`));
  return store.feedbacks.filter((f) => tenantStudentPairs.has(`${f.tenantId}:${f.studentId}`));
}

function parentViewStudent(parentId: string, studentId: string, tenantId: string, store: MockStore, audit: MockAuditLog): { ok: boolean } {
  const binding = store.bindings.find(
    (b) => b.parentId === parentId && b.studentId === studentId && b.tenantId === tenantId && b.status === 'active',
  );
  if (!binding) {
    audit.log({ actorRole: 'parent', action: 'parent.view-student', outcome: 'denied', meta: { reason: 'not bound', studentId, tenantId } });
    throw new ForbiddenException('parent cannot view non-bound student');
  }
  audit.log({ actorRole: 'parent', action: 'parent.view-student', outcome: 'success', meta: { studentId, tenantId } });
  return { ok: true };
}

// ---------- Tests ----------

describe('[L8 业务流 F3] 跨 tenant 家长 (6 case)', () => {
  let store: MockStore;
  let audit: MockAuditLog;

  beforeEach(() => {
    store = new MockStore();
    audit = new MockAuditLog();
  });

  it('F3.1 parent 注册 (public.parents) — phone_hash 是真 HMAC-SHA256 32 字节', () => {
    const parent = registerParent('13800000001', store, audit);
    expect(parent.id).toBeTruthy();
    // P1-3 round 2: phone_hash 是 Buffer 长度 32（HMAC-SHA256 输出）
    expect(parent.phoneHash).toBeInstanceOf(Buffer);
    expect(parent.phoneHash).toHaveLength(32);
    // 同 phone 输入必产出同 hash（确定性）
    expect(timingSafeEqual(parent.phoneHash, hashPhoneReal('13800000001'))).toBe(true);
    // 不同 phone 输入必产出不同 hash
    expect(timingSafeEqual(parent.phoneHash, hashPhoneReal('13800000002'))).toBe(false);
    expect(parent.encryptedPhone).toBe('ENC_13800000001');
    expect(store.parents).toHaveLength(1);
    expect(audit.byAction('parent.register').filter((e) => e.outcome === 'success')).toHaveLength(1);
  });

  it('F3.2 parent 绑定 student (public.parent_student_bindings × N tenant)', () => {
    const parent = registerParent('13800000002', store, audit);
    // 绑定 TNT01 的 STU_001
    const b1 = bindStudent(parent.id, 'STU_001', 'TNT01', store, audit);
    expect(b1.parentId).toBe(parent.id);
    expect(b1.tenantId).toBe('TNT01');

    // 跨 tenant 绑定 TNT02 的 STU_002
    const b2 = bindStudent(parent.id, 'STU_002', 'TNT02', store, audit);
    expect(b2.tenantId).toBe('TNT02');

    expect(store.bindings).toHaveLength(2);

    // 重复绑定 idempotent
    const b3 = bindStudent(parent.id, 'STU_001', 'TNT01', store, audit);
    expect(store.bindings).toHaveLength(2); // 没新增
    expect(b3).toEqual(b1);
  });

  it('F3.3 parent home 聚合多 tenant 学员视图', () => {
    const parent = registerParent('13800000003', store, audit);
    bindStudent(parent.id, 'STU_001', 'TNT01', store, audit);
    bindStudent(parent.id, 'STU_002', 'TNT01', store, audit); // 同 tenant 多孩
    bindStudent(parent.id, 'STU_003', 'TNT02', store, audit); // 跨 tenant

    const agg = parentHomeAggregateStudents(parent.id, store);
    expect(agg).toHaveLength(2);
    const t1 = agg.find((a) => a.tenantId === 'TNT01');
    const t2 = agg.find((a) => a.tenantId === 'TNT02');
    expect(t1?.students.sort()).toEqual(['STU_001', 'STU_002']);
    expect(t2?.students).toEqual(['STU_003']);
  });

  it('F3.4 parent 跨 tenant 反馈聚合', () => {
    const parent = registerParent('13800000004', store, audit);
    bindStudent(parent.id, 'STU_001', 'TNT01', store, audit);
    bindStudent(parent.id, 'STU_002', 'TNT02', store, audit);

    // 反馈分散在两个 tenant
    store.feedbacks.push({ id: 'FB_T1_1', studentId: 'STU_001', tenantId: 'TNT01', content: 'T1 feedback' });
    store.feedbacks.push({ id: 'FB_T2_1', studentId: 'STU_002', tenantId: 'TNT02', content: 'T2 feedback' });
    // 别 parent 的反馈不应混入
    store.feedbacks.push({ id: 'FB_OTHER', studentId: 'STU_FAR', tenantId: 'TNT01', content: 'unrelated' });

    const myFeedbacks = parentCrossTenantFeedbacks(parent.id, store);
    expect(myFeedbacks).toHaveLength(2);
    expect(myFeedbacks.map((f) => f.id).sort()).toEqual(['FB_T1_1', 'FB_T2_1']);
  });

  it('F3.5 parent.phone 唯一性校验 (V40 phone_hash)', () => {
    registerParent('13800000005', store, audit);
    expect(() => registerParent('13800000005', store, audit)).toThrow(ConflictException);
    const denied = audit.byAction('parent.register').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].meta?.reason).toBe('phone exists');
    expect(store.parents).toHaveLength(1); // 只有 1 个

    // 不同手机号 → OK
    registerParent('13800000006', store, audit);
    expect(store.parents).toHaveLength(2);
  });

  it('F3.6 parent 看非自己绑定的 student → 403', () => {
    const parent = registerParent('13800000007', store, audit);
    bindStudent(parent.id, 'STU_001', 'TNT01', store, audit);

    // 看自己孩子 OK
    const ok = parentViewStudent(parent.id, 'STU_001', 'TNT01', store, audit);
    expect(ok.ok).toBe(true);

    // 看别孩子 → 403
    expect(() => parentViewStudent(parent.id, 'STU_FAR', 'TNT01', store, audit)).toThrow(ForbiddenException);
    const denied = audit.byAction('parent.view-student').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].meta?.reason).toBe('not bound');

    // 看同孩子但不同 tenant (未绑) → 403
    expect(() => parentViewStudent(parent.id, 'STU_001', 'TNT99', store, audit)).toThrow(ForbiddenException);
    expect(audit.byAction('parent.view-student').filter((e) => e.outcome === 'denied')).toHaveLength(2);
  });
});
