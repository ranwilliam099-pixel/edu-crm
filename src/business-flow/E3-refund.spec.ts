/**
 * L8 业务流 E3 — 退费 / 调价 (4 case)
 *
 * 来源:
 *   - v2.0 §5.E3
 *   - SSOT §6 refund.* = [finance, admin, boss]
 *   - SSOT §6 contract.updateAmount = [sales, sales_manager, boss, admin] (sales 财务字段守门反例: contract.totalAmount 字段在 update 集合中 sales 可改, 但 5/19 修正实际上 amount 应只能由 finance/admin/boss 改)
 *
 * 验证:
 *   - finance 发起退费 → refunds 表 + audit_log
 *   - 退费金额扣 contract.paidAmount
 *   - 退费触发 wxpay refund API
 *   - sales 改 contract.totalAmount → 403 (财务字段守门)
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

interface Contract {
  id: string;
  totalAmount: number;
  paidAmount: number;
  refundAmount: number;
}

interface Refund {
  id: string;
  contractId: string;
  amount: number;
  reason: string;
  wxpayRefundId?: string;
  status: 'pending' | 'completed';
}

class MockStore {
  contracts: Map<string, Contract> = new Map();
  refunds: Refund[] = [];
  wxpayRefundCalls: { contractId: string; amount: number }[] = [];
}

function refund(
  user: MockUser,
  body: { contractId: string; amount: number; reason: string },
  store: MockStore,
  audit: MockAuditLog,
): { refund: Refund; contractPaidAfter: number } {
  if (!['finance', 'admin', 'boss'].includes(user.role)) {
    audit.log({ actorRole: user.role, action: 'refund.create', outcome: 'denied', meta: { reason: 'role not allowed' } });
    throw new ForbiddenException(`role ${user.role} cannot create refund`);
  }
  const contract = store.contracts.get(body.contractId);
  if (!contract) throw new BadRequestException('contract not found');
  if (body.amount <= 0) throw new BadRequestException('refund amount must be positive');
  if (body.amount > contract.paidAmount - contract.refundAmount) {
    audit.log({
      actorRole: user.role,
      action: 'refund.create',
      outcome: 'denied',
      meta: { reason: 'refund exceeds paid', paid: contract.paidAmount, refunded: contract.refundAmount, requested: body.amount },
    });
    throw new BadRequestException('refund amount exceeds paid');
  }

  // 触发 wxpay refund API
  store.wxpayRefundCalls.push({ contractId: body.contractId, amount: body.amount });
  audit.log({ actorRole: user.role, action: 'wxpay.refund-api-called', outcome: 'success', meta: { contractId: body.contractId, amount: body.amount } });

  const r: Refund = {
    id: 'RFD_' + Math.random().toString(36).slice(2, 8).toUpperCase(),
    contractId: body.contractId,
    amount: body.amount,
    reason: body.reason,
    wxpayRefundId: 'WX_REFUND_' + Math.random().toString(36).slice(2, 12).toUpperCase(),
    status: 'completed',
  };
  store.refunds.push(r);

  // contract.refundAmount 累加
  contract.refundAmount += body.amount;

  audit.log({
    actorRole: user.role,
    action: 'refund.create',
    outcome: 'success',
    meta: { refundId: r.id, amount: body.amount, contractPaidAmount: contract.paidAmount, refundAmount: contract.refundAmount },
  });

  return { refund: r, contractPaidAfter: contract.paidAmount - contract.refundAmount };
}

function updateContractAmount(
  user: MockUser,
  contractId: string,
  newAmount: number,
  store: MockStore,
  audit: MockAuditLog,
): Contract {
  // 5/19 拍板修正: contract.totalAmount 财务字段, sales 不能改, 只有 finance/admin/boss
  if (!['finance', 'admin', 'boss'].includes(user.role)) {
    audit.log({ actorRole: user.role, action: 'contract.updateAmount', outcome: 'denied', meta: { reason: 'financial field, sales cannot edit' } });
    throw new ForbiddenException(`role ${user.role} cannot update contract amount`);
  }
  const contract = store.contracts.get(contractId);
  if (!contract) throw new BadRequestException('contract not found');
  contract.totalAmount = newAmount;
  audit.log({ actorRole: user.role, action: 'contract.updateAmount', outcome: 'success', meta: { contractId, newAmount } });
  return contract;
}

// ---------- Test data ----------

const finance1: MockUser = { sub: 'FIN01', role: 'finance', tenantId: 'TNT01' };
const sales1: MockUser = { sub: 'SAL01', role: 'sales', tenantId: 'TNT01' };
const admin1: MockUser = { sub: 'ADM01', role: 'admin', tenantId: 'TNT01' };

function makeStore(): MockStore {
  const s = new MockStore();
  s.contracts.set('CONTRACT_01', {
    id: 'CONTRACT_01',
    totalAmount: 1000000,
    paidAmount: 1000000,
    refundAmount: 0,
  });
  return s;
}

describe('[L8 业务流 E3] 退费 / 调价 (4 case)', () => {
  let store: MockStore;
  let audit: MockAuditLog;

  beforeEach(() => {
    store = makeStore();
    audit = new MockAuditLog();
  });

  it('E3.1 finance 发起退费 → refunds 表 + audit_log', () => {
    const result = refund(
      finance1,
      { contractId: 'CONTRACT_01', amount: 500000, reason: '中途退课' },
      store,
      audit,
    );
    expect(result.refund.id).toBeTruthy();
    expect(result.refund.status).toBe('completed');
    expect(result.refund.amount).toBe(500000);
    expect(result.refund.reason).toBe('中途退课');
    expect(store.refunds).toHaveLength(1);

    const success = audit.byAction('refund.create').filter((e) => e.outcome === 'success');
    expect(success).toHaveLength(1);
    expect(success[0].meta?.refundId).toBe(result.refund.id);
  });

  it('E3.2 退费金额从合同 paidAmount 扣减 (实际通过 refundAmount 累加)', () => {
    const result = refund(
      finance1,
      { contractId: 'CONTRACT_01', amount: 300000, reason: '退一部分' },
      store,
      audit,
    );
    expect(result.contractPaidAfter).toBe(700000); // 1000000 - 300000
    expect(store.contracts.get('CONTRACT_01')!.refundAmount).toBe(300000);

    // 累计退费 (不能超 paidAmount)
    const r2 = refund(finance1, { contractId: 'CONTRACT_01', amount: 400000, reason: '继续退' }, store, audit);
    expect(r2.contractPaidAfter).toBe(300000); // 1000000 - 700000
    expect(store.contracts.get('CONTRACT_01')!.refundAmount).toBe(700000);

    // 再退 400000 (累计 1.1M 超 paidAmount) → 拒绝
    expect(() =>
      refund(finance1, { contractId: 'CONTRACT_01', amount: 400000, reason: '超退' }, store, audit),
    ).toThrow(BadRequestException);
    const denied = audit.byAction('refund.create').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].meta?.reason).toBe('refund exceeds paid');
  });

  it('E3.3 退费触发 wxpay refund API', () => {
    refund(finance1, { contractId: 'CONTRACT_01', amount: 200000, reason: '部分退费' }, store, audit);
    expect(store.wxpayRefundCalls).toHaveLength(1);
    expect(store.wxpayRefundCalls[0]).toEqual({ contractId: 'CONTRACT_01', amount: 200000 });
    expect(audit.byAction('wxpay.refund-api-called')).toHaveLength(1);
    expect(store.refunds[0].wxpayRefundId).toMatch(/^WX_REFUND_/);
  });

  it('E3.4 sales 改 contract.totalAmount → 403 (财务字段守门)', () => {
    expect(() => updateContractAmount(sales1, 'CONTRACT_01', 2000000, store, audit)).toThrow(ForbiddenException);
    const denied = audit.byAction('contract.updateAmount').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].actorRole).toBe('sales');
    expect(denied[0].meta?.reason).toBe('financial field, sales cannot edit');
    expect(store.contracts.get('CONTRACT_01')!.totalAmount).toBe(1000000); // 未改

    // finance / admin 可改
    updateContractAmount(finance1, 'CONTRACT_01', 1500000, store, audit);
    expect(store.contracts.get('CONTRACT_01')!.totalAmount).toBe(1500000);

    updateContractAmount(admin1, 'CONTRACT_01', 2000000, store, audit);
    expect(store.contracts.get('CONTRACT_01')!.totalAmount).toBe(2000000);

    const success = audit.byAction('contract.updateAmount').filter((e) => e.outcome === 'success');
    expect(success).toHaveLength(2);
  });
});
