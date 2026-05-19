/**
 * L8 业务流 E2 — 开票 (7 case, 5/15 A-1 修订)
 *
 * 来源:
 *   - v2.0 §5.E2 开票
 *   - SSOT §6 操作权限矩阵：finance.invoice.create=[finance] — 5/15 A-1 修订：不含 boss/admin
 *   - 拍板: invoice 上传抬头 msgSecCheck (公司名/税号)
 *
 * 验证:
 *   - finance 从合同发起开票 → invoices.status=pending
 *   - finance 选发票类型 (普通 / 专用 / 电子)
 *   - finance 上传抬头 msgSecCheck → 风险拦截
 *   - 开票完成 push parent
 *   - sales / academic / teacher 看 invoices → 403
 *   - boss 创建/读发票 → 403（5/15 A-1）
 *   - admin 创建/读发票 → 403（5/15 A-1）
 */
import { ForbiddenException, BadRequestException } from '@nestjs/common';

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
}

type InvoiceType = 'normal' | 'special' | 'electronic';

interface Invoice {
  id: string;
  contractId: string;
  invoiceType: InvoiceType;
  status: 'pending' | 'issued' | 'cancelled';
  title?: { companyName: string; taxId: string };
  pendingReview?: boolean;
  issuedAt?: Date;
}

interface Notification {
  to: string;
  body: string;
}

class MockStore {
  invoices: Invoice[] = [];
  notifications: Notification[] = [];
}

type MsgSecResult = 'ok' | 'risky' | 'timeout';
function mockMsgSec(content: string): MsgSecResult {
  if (content.includes('诈骗') || content.includes('暴力')) return 'risky';
  if (content === '__TIMEOUT__') return 'timeout';
  return 'ok';
}

function createInvoice(
  user: MockUser,
  body: { contractId: string; invoiceType: InvoiceType },
  store: MockStore,
  audit: MockAuditLog,
): Invoice {
  // 5/15 A-1 拍板：finance.invoice.create=[finance]（不含 boss/admin）
  if (user.role !== 'finance') {
    audit.log({ actorRole: user.role, action: 'invoice.create', outcome: 'denied', meta: { reason: 'role not allowed (A-1)' } });
    throw new ForbiddenException(`role ${user.role} cannot create invoice (5/15 A-1: only finance)`);
  }
  const invoice: Invoice = {
    id: 'INV_' + Math.random().toString(36).slice(2, 8).toUpperCase(),
    contractId: body.contractId,
    invoiceType: body.invoiceType,
    status: 'pending',
  };
  store.invoices.push(invoice);
  audit.log({
    actorRole: user.role,
    action: 'invoice.create',
    outcome: 'success',
    meta: { invoiceId: invoice.id, type: body.invoiceType },
  });
  return invoice;
}

function uploadTitle(
  user: MockUser,
  invoiceId: string,
  title: { companyName: string; taxId: string },
  store: MockStore,
  audit: MockAuditLog,
): Invoice {
  // 5/15 A-1: upload-title 同 create — 仅 finance
  if (user.role !== 'finance') {
    audit.log({ actorRole: user.role, action: 'invoice.upload-title', outcome: 'denied', meta: { reason: 'A-1' } });
    throw new ForbiddenException(`role ${user.role} cannot upload title (5/15 A-1: only finance)`);
  }
  const inv = store.invoices.find((i) => i.id === invoiceId);
  if (!inv) throw new BadRequestException('invoice not found');

  // msgSecCheck on companyName + taxId
  const checkName = mockMsgSec(title.companyName);
  const checkTax = mockMsgSec(title.taxId);
  if (checkName === 'risky' || checkTax === 'risky') {
    audit.log({
      actorRole: user.role,
      action: 'invoice.msgsec-blocked',
      outcome: 'denied',
      meta: { field: checkName === 'risky' ? 'companyName' : 'taxId' },
    });
    throw new BadRequestException('title content blocked by msgSecCheck');
  }
  const pendingReview = checkName === 'timeout' || checkTax === 'timeout';
  if (pendingReview) {
    audit.log({ actorRole: user.role, action: 'invoice.msgsec-pending-review', outcome: 'success' });
  }
  inv.title = title;
  inv.pendingReview = pendingReview;
  audit.log({ actorRole: user.role, action: 'invoice.upload-title', outcome: 'success', meta: { invoiceId } });
  return inv;
}

function issueInvoice(
  user: MockUser,
  invoiceId: string,
  store: MockStore,
  audit: MockAuditLog,
  now: Date = new Date(),
): Invoice {
  // 5/15 A-1: issue 同 update — 仅 finance
  if (user.role !== 'finance') {
    audit.log({ actorRole: user.role, action: 'invoice.issue', outcome: 'denied', meta: { reason: 'A-1' } });
    throw new ForbiddenException(`role ${user.role} cannot issue invoice (5/15 A-1: only finance)`);
  }
  const inv = store.invoices.find((i) => i.id === invoiceId);
  if (!inv) throw new BadRequestException('invoice not found');
  if (!inv.title) throw new BadRequestException('title not uploaded');
  inv.status = 'issued';
  inv.issuedAt = now;

  // push parent
  store.notifications.push({
    to: 'PARENT_OF_CONTRACT_' + inv.contractId,
    body: `发票已开具 ${inv.title.companyName}`,
  });

  audit.log({ actorRole: user.role, action: 'invoice.issue', outcome: 'success', meta: { invoiceId } });
  return inv;
}

function readInvoice(user: MockUser, invoiceId: string, store: MockStore, audit: MockAuditLog): Invoice {
  // 5/15 A-1 拍板：finance.invoice.read=[finance]（不含 boss/admin）
  // parent 走 contract.read 看自己合同票（不走 invoice.read）
  if (user.role !== 'finance') {
    audit.log({ actorRole: user.role, action: 'invoice.read', outcome: 'denied', meta: { reason: 'role not allowed (A-1)' } });
    throw new ForbiddenException(`role ${user.role} cannot read invoice (5/15 A-1: only finance)`);
  }
  const inv = store.invoices.find((i) => i.id === invoiceId);
  if (!inv) throw new BadRequestException('invoice not found');
  audit.log({ actorRole: user.role, action: 'invoice.read', outcome: 'success' });
  return inv;
}

// ---------- Test data ----------

const finance1: MockUser = { sub: 'FIN01', role: 'finance', tenantId: 'TNT01' };
const sales1: MockUser = { sub: 'SAL01', role: 'sales', tenantId: 'TNT01' };
const academic1: MockUser = { sub: 'ACAD01', role: 'academic', tenantId: 'TNT01' };
const teacher1: MockUser = { sub: 'T_001', role: 'teacher', tenantId: 'TNT01' };
const parent1: MockUser = { sub: 'PAR01', role: 'parent', tenantId: 'TNT01' };
// 5/15 A-1: boss/admin 也不能开票/读发票（仅 finance）
const boss1: MockUser = { sub: 'BOSS01', role: 'boss', tenantId: 'TNT01' };
const admin1: MockUser = { sub: 'ADM01', role: 'admin', tenantId: 'TNT01' };

describe('[L8 业务流 E2] 开票 (7 case, 5/15 A-1 修订)', () => {
  let store: MockStore;
  let audit: MockAuditLog;

  beforeEach(() => {
    store = new MockStore();
    audit = new MockAuditLog();
  });

  it('E2.1 finance 从合同发起开票 → invoices 表 + 状态 pending', () => {
    const inv = createInvoice(finance1, { contractId: 'CONTRACT_01', invoiceType: 'normal' }, store, audit);
    expect(inv.id).toBeTruthy();
    expect(inv.status).toBe('pending');
    expect(inv.invoiceType).toBe('normal');
    expect(store.invoices).toHaveLength(1);
    expect(audit.byAction('invoice.create').filter((e) => e.outcome === 'success')).toHaveLength(1);
  });

  it('E2.2 finance 选择发票类型 (普通 / 专用 / 电子)', () => {
    const i1 = createInvoice(finance1, { contractId: 'CONTRACT_01', invoiceType: 'normal' }, store, audit);
    const i2 = createInvoice(finance1, { contractId: 'CONTRACT_02', invoiceType: 'special' }, store, audit);
    const i3 = createInvoice(finance1, { contractId: 'CONTRACT_03', invoiceType: 'electronic' }, store, audit);
    expect(i1.invoiceType).toBe('normal');
    expect(i2.invoiceType).toBe('special');
    expect(i3.invoiceType).toBe('electronic');
    expect(store.invoices).toHaveLength(3);
    const types = audit.byAction('invoice.create').map((e) => e.meta?.type);
    expect(types.sort()).toEqual(['electronic', 'normal', 'special']);
  });

  it('E2.3 finance 上传抬头资料 → msgSecCheck (公司名 / 税号)', () => {
    const inv = createInvoice(finance1, { contractId: 'CONTRACT_01', invoiceType: 'normal' }, store, audit);

    // OK 通过
    const updated = uploadTitle(finance1, inv.id, { companyName: '北京某科技有限公司', taxId: '91110000000000' }, store, audit);
    expect(updated.title?.companyName).toBe('北京某科技有限公司');
    expect(updated.pendingReview).toBe(false);

    // risky 公司名 → 阻断
    const inv2 = createInvoice(finance1, { contractId: 'CONTRACT_02', invoiceType: 'normal' }, store, audit);
    expect(() =>
      uploadTitle(finance1, inv2.id, { companyName: '诈骗公司', taxId: '12345' }, store, audit),
    ).toThrow(BadRequestException);
    const blocked = audit.byAction('invoice.msgsec-blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0].meta?.field).toBe('companyName');

    // timeout → fail-open + pending review
    const inv3 = createInvoice(finance1, { contractId: 'CONTRACT_03', invoiceType: 'normal' }, store, audit);
    const upd = uploadTitle(finance1, inv3.id, { companyName: '__TIMEOUT__', taxId: 'OK_TAX' }, store, audit);
    expect(upd.pendingReview).toBe(true);
    expect(audit.byAction('invoice.msgsec-pending-review')).toHaveLength(1);
  });

  it('E2.4 开票完成 → push 通知 parent', () => {
    const inv = createInvoice(finance1, { contractId: 'CONTRACT_01', invoiceType: 'normal' }, store, audit);
    uploadTitle(finance1, inv.id, { companyName: '北京某科技有限公司', taxId: '91110000000000' }, store, audit);
    const issued = issueInvoice(finance1, inv.id, store, audit, new Date('2026-05-19T10:00:00Z'));
    expect(issued.status).toBe('issued');
    expect(issued.issuedAt?.toISOString()).toBe('2026-05-19T10:00:00.000Z');
    expect(store.notifications).toHaveLength(1);
    expect(store.notifications[0].to).toBe('PARENT_OF_CONTRACT_CONTRACT_01');
    expect(store.notifications[0].body).toContain('北京某科技有限公司');
  });

  it('E2.5 sales / academic / teacher / parent 看 invoices → 403', () => {
    const inv = createInvoice(finance1, { contractId: 'CONTRACT_01', invoiceType: 'normal' }, store, audit);

    expect(() => readInvoice(sales1, inv.id, store, audit)).toThrow(ForbiddenException);
    expect(() => readInvoice(academic1, inv.id, store, audit)).toThrow(ForbiddenException);
    expect(() => readInvoice(teacher1, inv.id, store, audit)).toThrow(ForbiddenException);
    // 5/15 A-1：parent 看 invoice.read → 403（parent 走 contract.read 看自己合同票）
    expect(() => readInvoice(parent1, inv.id, store, audit)).toThrow(ForbiddenException);

    const denied = audit.byAction('invoice.read').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(4);
    expect(denied.map((d) => d.actorRole).sort()).toEqual(['academic', 'parent', 'sales', 'teacher']);

    // 仅 finance 可读
    const readByFin = readInvoice(finance1, inv.id, store, audit);
    expect(readByFin.id).toBe(inv.id);
  });

  it('E2.6 boss 开票 / 读发票 / 上传抬头 / 推进状态 → 全部 403（5/15 A-1）', () => {
    // boss 不能创建
    expect(() =>
      createInvoice(boss1, { contractId: 'CONTRACT_BOSS', invoiceType: 'normal' }, store, audit),
    ).toThrow(ForbiddenException);

    // 先用 finance 建一个 invoice 给后续 boss 操作
    const inv = createInvoice(finance1, { contractId: 'CONTRACT_01', invoiceType: 'normal' }, store, audit);

    // boss 不能 upload-title
    expect(() =>
      uploadTitle(boss1, inv.id, { companyName: '某公司', taxId: '91110000xx' }, store, audit),
    ).toThrow(ForbiddenException);

    // boss 不能 issue
    expect(() => issueInvoice(boss1, inv.id, store, audit)).toThrow(ForbiddenException);

    // boss 不能 read
    expect(() => readInvoice(boss1, inv.id, store, audit)).toThrow(ForbiddenException);

    // 4 个 denied 都落 audit（reason 含 A-1）
    const allDenied = audit.entries.filter(
      (e) => e.outcome === 'denied' && e.actorRole === 'boss',
    );
    expect(allDenied).toHaveLength(4);
    expect(allDenied.map((d) => d.action).sort()).toEqual([
      'invoice.create',
      'invoice.issue',
      'invoice.read',
      'invoice.upload-title',
    ]);
  });

  it('E2.7 admin 开票 / 读发票 / 上传抬头 / 推进状态 → 全部 403（5/15 A-1）', () => {
    // admin 不能创建
    expect(() =>
      createInvoice(admin1, { contractId: 'CONTRACT_ADMIN', invoiceType: 'normal' }, store, audit),
    ).toThrow(ForbiddenException);

    // finance 先建一个 invoice
    const inv = createInvoice(finance1, { contractId: 'CONTRACT_02', invoiceType: 'normal' }, store, audit);

    // admin 不能 upload-title
    expect(() =>
      uploadTitle(admin1, inv.id, { companyName: '某公司', taxId: '91110000xx' }, store, audit),
    ).toThrow(ForbiddenException);

    // admin 不能 issue
    expect(() => issueInvoice(admin1, inv.id, store, audit)).toThrow(ForbiddenException);

    // admin 不能 read
    expect(() => readInvoice(admin1, inv.id, store, audit)).toThrow(ForbiddenException);

    const allDenied = audit.entries.filter(
      (e) => e.outcome === 'denied' && e.actorRole === 'admin',
    );
    expect(allDenied).toHaveLength(4);
    expect(allDenied.map((d) => d.action).sort()).toEqual([
      'invoice.create',
      'invoice.issue',
      'invoice.read',
      'invoice.upload-title',
    ]);
  });
});
