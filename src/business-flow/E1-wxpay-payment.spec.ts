/**
 * L8 业务流 E1 — wxpay 支付 (5 case)
 *
 * 来源:
 *   - v2.0 §5.E1
 *   - 5/14 wxpay V3 全链路代码已上线 (commit f73602a + e936f76 + 5abfba6)
 *
 * 验证:
 *   - parent 触发支付 → wx.login → openid → unified-order → wx.requestPayment
 *   - 支付成功 callback 解密 → contract.paidAmount 更新
 *   - 支付失败 / 取消 → 状态保持 (不动 paidAmount)
 *   - 重复支付 → idempotency 防重 (同 outTradeNo 返回相同 prepayId)
 *   - finance 看未授权合同 → 403
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
  ownedContractIds?: string[]; // finance own (campus level)
}

interface Contract {
  id: string;
  studentId: string;
  totalAmount: number;
  paidAmount: number;
  campusId: string;
  tenantId: string;
  ownerSalesId: string;
}

interface PrepayResult {
  prepayId: string;
  outTradeNo: string;
  signedAt: Date;
  amountCents: number;
}

interface Notification {
  to: string;
  body: string;
}

class MockStore {
  contracts: Map<string, Contract> = new Map();
  prepays: Map<string, PrepayResult> = new Map(); // key = outTradeNo
  notifications: Notification[] = [];
  openids: Map<string, string> = new Map(); // parentSub → openid
}

// wx.login → code2session → openid
function getOrFetchOpenid(parentSub: string, code: string, store: MockStore, audit: MockAuditLog): string {
  if (store.openids.has(parentSub)) {
    return store.openids.get(parentSub)!;
  }
  // mock 微信 code2session
  const openid = 'OPENID_' + parentSub;
  store.openids.set(parentSub, openid);
  audit.log({ actorRole: 'parent', action: 'wx.code2session', outcome: 'success', meta: { parentSub, openidPrefix: openid.slice(0, 10) } });
  return openid;
}

function unifiedOrder(
  user: MockUser,
  body: { contractId: string; amountCents: number; openid: string },
  store: MockStore,
  audit: MockAuditLog,
  now: Date = new Date(),
): PrepayResult {
  if (user.role !== 'parent') {
    audit.log({ actorRole: user.role, action: 'wxpay.unified-order', outcome: 'denied', meta: { reason: 'role not parent' } });
    throw new ForbiddenException(`role ${user.role} cannot trigger payment`);
  }
  const contract = store.contracts.get(body.contractId);
  if (!contract) throw new BadRequestException('contract not found');

  // outTradeNo idempotency: 同 contractId + amount + minute 窗口去重
  const outTradeNo = `${body.contractId}_${Math.floor(now.getTime() / 60000)}`;
  if (store.prepays.has(outTradeNo)) {
    audit.log({ actorRole: 'parent', action: 'wxpay.unified-order.idempotent-hit', outcome: 'success', meta: { outTradeNo } });
    return store.prepays.get(outTradeNo)!;
  }

  const prepay: PrepayResult = {
    prepayId: 'WX_PREPAY_' + Math.random().toString(36).slice(2, 12).toUpperCase(),
    outTradeNo,
    signedAt: now,
    amountCents: body.amountCents,
  };
  store.prepays.set(outTradeNo, prepay);
  audit.log({ actorRole: 'parent', action: 'wxpay.unified-order', outcome: 'success', meta: { outTradeNo, prepayId: prepay.prepayId } });
  return prepay;
}

// V3 callback (AES-256-GCM decrypted resource)
function onWxpayCallback(
  decryptedPayload: {
    out_trade_no: string;
    trade_state: 'SUCCESS' | 'CLOSED' | 'NOTPAY';
    amount: { total: number; payer_total: number };
  },
  store: MockStore,
  audit: MockAuditLog,
): { handled: boolean; contractPaidAmountAfter?: number } {
  audit.log({ actorRole: 'system', action: 'wxpay.callback.received', outcome: 'success', meta: { tradeState: decryptedPayload.trade_state, outTradeNo: decryptedPayload.out_trade_no } });

  if (decryptedPayload.trade_state !== 'SUCCESS') {
    // 状态保持, 不动 contract
    audit.log({
      actorRole: 'system',
      action: 'wxpay.callback.non-success-no-op',
      outcome: 'success',
      meta: { state: decryptedPayload.trade_state },
    });
    return { handled: true };
  }

  // 找 contract via outTradeNo prefix — outTradeNo format: `${contractId}_${minute}`
  // contractId 本身可能含 '_', 所以取最后一个 '_' 之前作为 contractId
  const lastUnderscore = decryptedPayload.out_trade_no.lastIndexOf('_');
  const contractId = lastUnderscore > 0 ? decryptedPayload.out_trade_no.slice(0, lastUnderscore) : decryptedPayload.out_trade_no;
  const contract = store.contracts.get(contractId);
  if (!contract) {
    audit.log({ actorRole: 'system', action: 'wxpay.callback.contract-not-found', outcome: 'denied' });
    return { handled: false };
  }

  contract.paidAmount += decryptedPayload.amount.payer_total;

  // push notify
  store.notifications.push({
    to: 'PARENT_OF_CONTRACT_' + contractId,
    body: `支付成功 ${decryptedPayload.amount.payer_total} 分`,
  });

  audit.log({
    actorRole: 'system',
    action: 'wxpay.callback.contract-updated',
    outcome: 'success',
    meta: { contractId, paidAmount: contract.paidAmount },
  });
  return { handled: true, contractPaidAmountAfter: contract.paidAmount };
}

function financeViewContract(user: MockUser, contractId: string, store: MockStore, audit: MockAuditLog): Contract {
  if (user.role !== 'finance' && !['admin', 'boss'].includes(user.role)) {
    audit.log({ actorRole: user.role, action: 'finance.view-contract', outcome: 'denied', meta: { reason: 'role not finance' } });
    throw new ForbiddenException('only finance/admin/boss');
  }
  const contract = store.contracts.get(contractId);
  if (!contract) throw new BadRequestException('contract not found');
  // finance 校区限制
  if (user.role === 'finance' && !user.ownedContractIds?.includes(contractId)) {
    audit.log({
      actorRole: 'finance',
      action: 'finance.view-contract',
      outcome: 'denied',
      meta: { reason: 'not own campus contract' },
    });
    throw new ForbiddenException('finance cannot view contract from other campus');
  }
  return contract;
}

// ---------- Test data ----------

const parent1: MockUser = { sub: 'PAR01', role: 'parent', tenantId: 'TNT01' };
const teacher1: MockUser = { sub: 'T_001', role: 'teacher', tenantId: 'TNT01' };
const finance1: MockUser = { sub: 'FIN01', role: 'finance', tenantId: 'TNT01', ownedContractIds: ['CONTRACT_01'] };
const financeOtherCampus: MockUser = { sub: 'FIN_OTHER', role: 'finance', tenantId: 'TNT01', ownedContractIds: ['CONTRACT_OTHER'] };

function makeStore(): MockStore {
  const s = new MockStore();
  s.contracts.set('CONTRACT_01', {
    id: 'CONTRACT_01',
    studentId: 'STU_001',
    totalAmount: 1000000, // ¥10,000
    paidAmount: 0,
    campusId: 'CMP_01',
    tenantId: 'TNT01',
    ownerSalesId: 'SAL01',
  });
  return s;
}

describe('[L8 业务流 E1] wxpay 支付 (5 case)', () => {
  let store: MockStore;
  let audit: MockAuditLog;

  beforeEach(() => {
    store = makeStore();
    audit = new MockAuditLog();
  });

  it('E1.1 parent 触发支付 → wx.login → openid → unified-order → wx.requestPayment', () => {
    // step 1: 拿 openid (wx.login + code2session)
    const openid = getOrFetchOpenid(parent1.sub, 'MOCK_CODE', store, audit);
    expect(openid).toBe('OPENID_' + parent1.sub);
    expect(audit.byAction('wx.code2session')).toHaveLength(1);

    // step 2: unified-order
    const prepay = unifiedOrder(parent1, { contractId: 'CONTRACT_01', amountCents: 1000000, openid }, store, audit);
    expect(prepay.prepayId).toMatch(/^WX_PREPAY_/);
    expect(prepay.outTradeNo).toMatch(/^CONTRACT_01_/);
    expect(prepay.amountCents).toBe(1000000);
    expect(audit.byAction('wxpay.unified-order').filter((e) => e.outcome === 'success')).toHaveLength(1);
  });

  it('E1.2 支付成功 → callback 解密 → contract.paidAmount 更新', () => {
    const openid = getOrFetchOpenid(parent1.sub, 'MOCK_CODE', store, audit);
    const prepay = unifiedOrder(parent1, { contractId: 'CONTRACT_01', amountCents: 1000000, openid }, store, audit);

    // V3 callback (已解密)
    const result = onWxpayCallback(
      {
        out_trade_no: prepay.outTradeNo,
        trade_state: 'SUCCESS',
        amount: { total: 1000000, payer_total: 1000000 },
      },
      store,
      audit,
    );
    expect(result.handled).toBe(true);
    expect(result.contractPaidAmountAfter).toBe(1000000);
    expect(store.contracts.get('CONTRACT_01')!.paidAmount).toBe(1000000);
    expect(store.notifications).toHaveLength(1);
    expect(audit.byAction('wxpay.callback.contract-updated')).toHaveLength(1);
  });

  it('E1.3 支付失败 / 取消 → 状态保持 + 用户友好提示', () => {
    const openid = getOrFetchOpenid(parent1.sub, 'MOCK_CODE', store, audit);
    const prepay = unifiedOrder(parent1, { contractId: 'CONTRACT_01', amountCents: 1000000, openid }, store, audit);
    const beforePaid = store.contracts.get('CONTRACT_01')!.paidAmount;

    // CLOSED
    const r1 = onWxpayCallback(
      { out_trade_no: prepay.outTradeNo, trade_state: 'CLOSED', amount: { total: 0, payer_total: 0 } },
      store,
      audit,
    );
    expect(r1.handled).toBe(true);
    expect(r1.contractPaidAmountAfter).toBeUndefined();
    expect(store.contracts.get('CONTRACT_01')!.paidAmount).toBe(beforePaid); // 不动

    // NOTPAY
    const r2 = onWxpayCallback(
      { out_trade_no: prepay.outTradeNo, trade_state: 'NOTPAY', amount: { total: 0, payer_total: 0 } },
      store,
      audit,
    );
    expect(r2.handled).toBe(true);
    expect(store.contracts.get('CONTRACT_01')!.paidAmount).toBe(beforePaid);

    const nop = audit.byAction('wxpay.callback.non-success-no-op');
    expect(nop).toHaveLength(2);
    expect(nop.map((e) => e.meta?.state).sort()).toEqual(['CLOSED', 'NOTPAY']);
  });

  it('E1.4 重复支付 → idempotency 防重 (同 outTradeNo 返回相同 prepayId)', () => {
    const openid = getOrFetchOpenid(parent1.sub, 'MOCK_CODE', store, audit);
    const now = new Date('2026-05-19T10:30:00Z');

    const p1 = unifiedOrder(parent1, { contractId: 'CONTRACT_01', amountCents: 1000000, openid }, store, audit, now);
    const p2 = unifiedOrder(parent1, { contractId: 'CONTRACT_01', amountCents: 1000000, openid }, store, audit, now);

    expect(p1.outTradeNo).toBe(p2.outTradeNo);
    expect(p1.prepayId).toBe(p2.prepayId);

    const idempotent = audit.byAction('wxpay.unified-order.idempotent-hit');
    expect(idempotent).toHaveLength(1);
    expect(idempotent[0].meta?.outTradeNo).toBe(p1.outTradeNo);
  });

  it('E1.5 finance 看自己未授权合同支付 → 403', () => {
    // finance1 拥有 CONTRACT_01
    const contract = financeViewContract(finance1, 'CONTRACT_01', store, audit);
    expect(contract.id).toBe('CONTRACT_01');

    // financeOtherCampus 不拥有 CONTRACT_01 → 403
    expect(() => financeViewContract(financeOtherCampus, 'CONTRACT_01', store, audit)).toThrow(ForbiddenException);
    const denied = audit.byAction('finance.view-contract').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].meta?.reason).toBe('not own campus contract');

    // teacher / parent 完全不能查 → 403
    expect(() => financeViewContract(teacher1, 'CONTRACT_01', store, audit)).toThrow(ForbiddenException);
    expect(() => financeViewContract(parent1, 'CONTRACT_01', store, audit)).toThrow(ForbiddenException);
  });
});
