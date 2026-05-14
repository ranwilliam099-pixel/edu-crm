/**
 * InvoiceService 单元测试 — Wave 4A.2-T2
 *
 * 覆盖：
 *   - createInvoice 路径 (调 repo.createInvoiceAndMarkContract)
 *   - msgSecCheck risky → 400 / review→fail-open 放行
 *   - SecurityService 未注入（@Optional）→ 跳过 msgSecCheck
 *   - audit_log SUCCESS 调 normalizeActorRole + 含 mask 摘要
 *   - audit_log fail-open（log 抛错不阻塞主业务）
 *   - findById 透传 repo
 *   - listPendingContracts parentName mask 单/多字符 / null
 *
 * 模式：直接 new InvoiceService（避免拉起 wx access token / config 链）
 */

import { BadRequestException } from '@nestjs/common';
import { InvoiceService } from './invoice.service';
import type { InvoiceRepository } from './invoice.repository';
import type { SecurityService, SecurityCheckResult } from '../security/security.service';
import type { AuditLogRepository } from '../db/audit-log.repository';
import type { Invoice } from './invoice.dto';

const TENANT_A = 'tenant_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const INVOICE_ID = '01HRX5INVOICE0000000000000000A02';
const CONTRACT_ID = '01HRX5CONTRACT00000000000000A002';
const USER_FINANCE = 'usrFinance00000000000000000000A2';

function invoiceFixture(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: INVOICE_ID,
    contractId: CONTRACT_ID,
    studentId: 'stu0000000000000000000000000000A2',
    customerId: 'cus0000000000000000000000000000A2',
    titleType: '企业',
    invoiceTitle: '某某科技有限公司',
    taxId: '91500000XXXXXXXXXX',
    receiveEmail: 'finance@example.com',
    receivePhone: '13800001234',
    amount: 9999,
    remark: null,
    status: 'pending',
    createdByUserId: USER_FINANCE,
    issuedAt: null,
    cancelledAt: null,
    createdAt: '2026-05-15T00:00:00.000Z',
    updatedAt: '2026-05-15T00:00:00.000Z',
    ...overrides,
  };
}

describe('InvoiceService (Wave 4A.2-T2)', () => {
  let service: InvoiceService;
  let repo: {
    createInvoiceAndMarkContract: jest.Mock;
    findById: jest.Mock;
    listPendingContracts: jest.Mock;
  };
  let security: { serverSideCheckContent: jest.Mock };
  let auditLog: { log: jest.Mock };

  function build(opts: { withSecurity?: boolean; withAudit?: boolean } = {}) {
    const withSecurity = opts.withSecurity ?? true;
    const withAudit = opts.withAudit ?? true;
    return new InvoiceService(
      repo as unknown as InvoiceRepository,
      withSecurity ? (security as unknown as SecurityService) : undefined,
      withAudit ? (auditLog as unknown as AuditLogRepository) : undefined,
    );
  }

  beforeEach(() => {
    repo = {
      createInvoiceAndMarkContract: jest.fn(),
      findById: jest.fn(),
      listPendingContracts: jest.fn(),
    };
    security = {
      serverSideCheckContent: jest
        .fn()
        .mockResolvedValue({ ok: true, suggest: 'pass' } as SecurityCheckResult),
    };
    auditLog = { log: jest.fn().mockResolvedValue(undefined) };
    service = build();
  });

  const baseDto = () => ({
    tenantSchema: TENANT_A,
    invoiceId: INVOICE_ID,
    contractId: CONTRACT_ID,
    titleType: '企业' as const,
    invoiceTitle: '某某科技有限公司',
    taxId: '91500000XXXXXXXXXX',
    receiveEmail: 'finance@example.com',
    receivePhone: '13800001234',
    remark: undefined,
  });

  const baseAuditCtx = () => ({
    ip: '10.0.0.1',
    userAgent: 'WeChatMP/8.x',
    requestId: 'req-test-w4a-002',
  });

  // ============================================================
  // createInvoice — happy path & 路径委派
  // ============================================================
  describe('createInvoice() — happy path', () => {
    it('finance role → repo + msgSecCheck + audit_log 全调一次，返 Invoice', async () => {
      repo.createInvoiceAndMarkContract.mockResolvedValueOnce(invoiceFixture());
      const r = await service.createInvoice(
        baseDto(),
        { sub: USER_FINANCE, role: 'finance' },
        baseAuditCtx(),
      );
      expect(r.id).toBe(INVOICE_ID);
      expect(r.status).toBe('pending');

      // repo 调用一次，payload 字段正确
      expect(repo.createInvoiceAndMarkContract).toHaveBeenCalledTimes(1);
      const [tenant, payload] = repo.createInvoiceAndMarkContract.mock.calls[0];
      expect(tenant).toBe(TENANT_A);
      expect(payload.invoiceId).toBe(INVOICE_ID);
      expect(payload.contractId).toBe(CONTRACT_ID);
      expect(payload.titleType).toBe('企业');
      expect(payload.invoiceTitle).toBe('某某科技有限公司');
      expect(payload.taxId).toBe('91500000XXXXXXXXXX');
      expect(payload.receiveEmail).toBe('finance@example.com');
      expect(payload.receivePhone).toBe('13800001234');
      expect(payload.createdByUserId).toBe(USER_FINANCE);

      // msgSecCheck 调 invoiceTitle 一次（remark 空，不查）
      expect(security.serverSideCheckContent).toHaveBeenCalledTimes(1);
      expect(security.serverSideCheckContent).toHaveBeenCalledWith('某某科技有限公司');

      // audit_log 调一次
      expect(auditLog.log).toHaveBeenCalledTimes(1);
      const [schema, entry] = auditLog.log.mock.calls[0];
      expect(schema).toBe(TENANT_A);
      expect(entry.action).toBe('invoice.create');
      expect(entry.targetType).toBe('invoice');
      expect(entry.targetId).toBe(INVOICE_ID);
      expect(entry.actorUserId).toBe(USER_FINANCE);
      expect(entry.actorRole).toBe('finance');
      expect(entry.before).toBeNull();
    });

    it('remark 非空 → msgSecCheck 调 2 次（invoiceTitle + remark）', async () => {
      repo.createInvoiceAndMarkContract.mockResolvedValueOnce(invoiceFixture({ remark: '5/15 备注' }));
      const dto = { ...baseDto(), remark: '5/15 备注' };
      await service.createInvoice(dto, { sub: USER_FINANCE, role: 'finance' }, baseAuditCtx());
      expect(security.serverSideCheckContent).toHaveBeenCalledTimes(2);
      expect(security.serverSideCheckContent).toHaveBeenNthCalledWith(1, '某某科技有限公司');
      expect(security.serverSideCheckContent).toHaveBeenNthCalledWith(2, '5/15 备注');
    });

    it('remark 空字符串/纯空格 → msgSecCheck 仅查 invoiceTitle', async () => {
      repo.createInvoiceAndMarkContract.mockResolvedValueOnce(invoiceFixture());
      await service.createInvoice(
        { ...baseDto(), remark: '   ' },
        { sub: USER_FINANCE, role: 'finance' },
        baseAuditCtx(),
      );
      expect(security.serverSideCheckContent).toHaveBeenCalledTimes(1);
    });

    it('boss role → audit_log actorRole=boss', async () => {
      repo.createInvoiceAndMarkContract.mockResolvedValueOnce(invoiceFixture());
      await service.createInvoice(
        baseDto(),
        { sub: 'bossSubXxx', role: 'boss' },
        baseAuditCtx(),
      );
      const entry = auditLog.log.mock.calls[0][1];
      expect(entry.actorRole).toBe('boss');
    });

    it('admin role → audit_log actorRole=admin', async () => {
      repo.createInvoiceAndMarkContract.mockResolvedValueOnce(invoiceFixture());
      await service.createInvoice(
        baseDto(),
        { sub: 'adminSubXxx', role: 'admin' },
        baseAuditCtx(),
      );
      const entry = auditLog.log.mock.calls[0][1];
      expect(entry.actorRole).toBe('admin');
    });

    it('未知 role → normalizeActorRole 收口 system', async () => {
      repo.createInvoiceAndMarkContract.mockResolvedValueOnce(invoiceFixture());
      // 用 finance_admin（平台级，不在 ActorRole 内）触发 normalize
      await service.createInvoice(
        baseDto(),
        { sub: 'unknownSub', role: 'finance_admin' },
        baseAuditCtx(),
      );
      const entry = auditLog.log.mock.calls[0][1];
      expect(entry.actorRole).toBe('system');
    });

    it('audit_log.after 不入完整 PII（仅长度摘要 + status）', async () => {
      repo.createInvoiceAndMarkContract.mockResolvedValueOnce(invoiceFixture());
      await service.createInvoice(baseDto(), { sub: USER_FINANCE, role: 'finance' }, baseAuditCtx());
      const entry = auditLog.log.mock.calls[0][1];
      // PII 完整明文绝不能出现在 audit_log.after
      const afterStr = JSON.stringify(entry.after);
      expect(afterStr).not.toContain('某某科技有限公司');
      expect(afterStr).not.toContain('91500000XXXXXXXXXX');
      expect(afterStr).not.toContain('13800001234');
      // 摘要字段就位
      expect(entry.after.invoiceTitleLength).toBe('某某科技有限公司'.length);
      expect(entry.after.hasTaxId).toBe(true);
      expect(entry.after.amount).toBe(9999);
      expect(entry.after.status).toBe('pending');
    });

    it('auditCtx 透传 ip / userAgent / requestId 到 entry', async () => {
      repo.createInvoiceAndMarkContract.mockResolvedValueOnce(invoiceFixture());
      await service.createInvoice(
        baseDto(),
        { sub: USER_FINANCE, role: 'finance' },
        { ip: '99.99.99.99', userAgent: 'TestUA', requestId: 'req-X' },
      );
      const entry = auditLog.log.mock.calls[0][1];
      expect(entry.ip).toBe('99.99.99.99');
      expect(entry.userAgent).toBe('TestUA');
      expect(entry.requestId).toBe('req-X');
    });
  });

  // ============================================================
  // msgSecCheck 行为：risky → 400 / review → 放行 / 网络异常 → 放行
  // ============================================================
  describe('msgSecCheck — risky 拦截 / review 放行 / 网络异常 fail-open', () => {
    it('suggest="risky" on invoiceTitle → 400 + repo 不调', async () => {
      // 用 mockResolvedValue（每次调用都返回 risky）避免第二次 await expect 退化为 pass mock
      security.serverSideCheckContent.mockResolvedValue({
        ok: false,
        suggest: 'risky',
        errcode: 87014,
      } as SecurityCheckResult);
      await expect(
        service.createInvoice(baseDto(), { sub: USER_FINANCE, role: 'finance' }, baseAuditCtx()),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.createInvoice(baseDto(), { sub: USER_FINANCE, role: 'finance' }, baseAuditCtx()),
      ).rejects.toThrow(/INVOICE_CONTENT_RISKY/);
      expect(repo.createInvoiceAndMarkContract).not.toHaveBeenCalled();
      expect(auditLog.log).not.toHaveBeenCalled();
    });

    it('suggest="risky" on remark → 400 + repo 不调', async () => {
      security.serverSideCheckContent
        .mockResolvedValueOnce({ ok: true, suggest: 'pass' } as SecurityCheckResult) // title pass
        .mockResolvedValueOnce({
          ok: false,
          suggest: 'risky',
        } as SecurityCheckResult); // remark risky
      await expect(
        service.createInvoice(
          { ...baseDto(), remark: '违规内容' },
          { sub: USER_FINANCE, role: 'finance' },
          baseAuditCtx(),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(repo.createInvoiceAndMarkContract).not.toHaveBeenCalled();
    });

    it('suggest="review" → 放行（fail-open，repo 仍调）', async () => {
      security.serverSideCheckContent.mockResolvedValueOnce({
        ok: false,
        suggest: 'review',
      } as SecurityCheckResult);
      repo.createInvoiceAndMarkContract.mockResolvedValueOnce(invoiceFixture());
      const r = await service.createInvoice(
        baseDto(),
        { sub: USER_FINANCE, role: 'finance' },
        baseAuditCtx(),
      );
      expect(r.id).toBe(INVOICE_ID);
      expect(repo.createInvoiceAndMarkContract).toHaveBeenCalledTimes(1);
    });

    it('网络异常（serverSideCheckContent 抛错）→ fail-open 放行', async () => {
      security.serverSideCheckContent.mockRejectedValueOnce(new Error('network timeout'));
      repo.createInvoiceAndMarkContract.mockResolvedValueOnce(invoiceFixture());
      const r = await service.createInvoice(
        baseDto(),
        { sub: USER_FINANCE, role: 'finance' },
        baseAuditCtx(),
      );
      expect(r.id).toBe(INVOICE_ID);
    });

    it('SecurityService 未注入（@Optional）→ 跳过 msgSecCheck，直接 repo', async () => {
      service = build({ withSecurity: false });
      repo.createInvoiceAndMarkContract.mockResolvedValueOnce(invoiceFixture());
      const r = await service.createInvoice(
        baseDto(),
        { sub: USER_FINANCE, role: 'finance' },
        baseAuditCtx(),
      );
      expect(r.id).toBe(INVOICE_ID);
      expect(security.serverSideCheckContent).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // repo 抛错 → service 透传（不写 audit success）
  // ============================================================
  describe('repo error path — 404 / 409 / 其他抛错透传', () => {
    it('repo 抛 NotFoundException (合同不存在) → service 透传 + audit 不写', async () => {
      const { NotFoundException } = await import('@nestjs/common');
      repo.createInvoiceAndMarkContract.mockRejectedValueOnce(
        new NotFoundException('INVOICE_CONTRACT_NOT_FOUND: contractId=xxx'),
      );
      await expect(
        service.createInvoice(baseDto(), { sub: USER_FINANCE, role: 'finance' }, baseAuditCtx()),
      ).rejects.toThrow(NotFoundException);
      expect(auditLog.log).not.toHaveBeenCalled();
    });

    it('repo 抛 ConflictException (合同已开票) → service 透传', async () => {
      const { ConflictException } = await import('@nestjs/common');
      repo.createInvoiceAndMarkContract.mockRejectedValueOnce(
        new ConflictException({
          error: 'INVOICE_ALREADY_ISSUED',
          contractId: CONTRACT_ID,
          existedInvoiceId: 'OTHER_INVOICE_0000000000000000A0',
        }),
      );
      await expect(
        service.createInvoice(baseDto(), { sub: USER_FINANCE, role: 'finance' }, baseAuditCtx()),
      ).rejects.toThrow(ConflictException);
    });

    it('repo 抛通用 Error → service 透传 + audit 不写', async () => {
      repo.createInvoiceAndMarkContract.mockRejectedValueOnce(new Error('PG down'));
      await expect(
        service.createInvoice(baseDto(), { sub: USER_FINANCE, role: 'finance' }, baseAuditCtx()),
      ).rejects.toThrow(/PG down/);
      expect(auditLog.log).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // audit_log 抛错不阻塞主业务（fail-open）
  // ============================================================
  describe('audit_log fail-open', () => {
    it('auditLog.log 抛错 → 不阻塞主业务（仍返 invoice）', async () => {
      repo.createInvoiceAndMarkContract.mockResolvedValueOnce(invoiceFixture());
      auditLog.log.mockRejectedValueOnce(new Error('audit insert failed'));
      const r = await service.createInvoice(
        baseDto(),
        { sub: USER_FINANCE, role: 'finance' },
        baseAuditCtx(),
      );
      expect(r.id).toBe(INVOICE_ID);
      expect(auditLog.log).toHaveBeenCalledTimes(1);
    });

    it('AuditLogRepository 未注入 → 不抛错 + repo 仍调', async () => {
      service = build({ withAudit: false });
      repo.createInvoiceAndMarkContract.mockResolvedValueOnce(invoiceFixture());
      const r = await service.createInvoice(
        baseDto(),
        { sub: USER_FINANCE, role: 'finance' },
        baseAuditCtx(),
      );
      expect(r.id).toBe(INVOICE_ID);
      expect(repo.createInvoiceAndMarkContract).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // findById — 透传 repo
  // ============================================================
  describe('findById() — 透传 repo', () => {
    it('调 repo.findById 一次 + 透传返回值', async () => {
      repo.findById.mockResolvedValueOnce(invoiceFixture());
      const r = await service.findById(TENANT_A, INVOICE_ID);
      expect(r).not.toBeNull();
      expect(r!.id).toBe(INVOICE_ID);
      expect(repo.findById).toHaveBeenCalledWith(TENANT_A, INVOICE_ID);
    });

    it('repo 返 null → service 返 null', async () => {
      repo.findById.mockResolvedValueOnce(null);
      const r = await service.findById(TENANT_A, INVOICE_ID);
      expect(r).toBeNull();
    });
  });

  // ============================================================
  // listPendingContracts — parentName mask 单/多字符 / null + contractNo
  // ============================================================
  describe('listPendingContracts() — parentName mask + contractNo', () => {
    const pendingRow = (parentName: string | null) => ({
      id: 'CT_LONG_ULID_0000000000000000ABCDA1',
      studentId: 'stuABCDA1',
      studentName: '王同学',
      parentName,
      totalAmount: 9999,
      signedAt: '2026-05-10T08:00:00.000Z',
    });

    it('parentName="王二"（2 字）→ mask "王*"', async () => {
      repo.listPendingContracts.mockResolvedValueOnce([pendingRow('王二')]);
      const r = await service.listPendingContracts(TENANT_A);
      expect(r.items).toHaveLength(1);
      expect(r.items[0].parentNameMasked).toBe('王*');
    });

    it('parentName="王小明"（3 字）→ mask "王**"', async () => {
      repo.listPendingContracts.mockResolvedValueOnce([pendingRow('王小明')]);
      const r = await service.listPendingContracts(TENANT_A);
      expect(r.items[0].parentNameMasked).toBe('王**');
    });

    it('parentName="王大小明"（4 字）→ mask "王***"', async () => {
      repo.listPendingContracts.mockResolvedValueOnce([pendingRow('王大小明')]);
      const r = await service.listPendingContracts(TENANT_A);
      expect(r.items[0].parentNameMasked).toBe('王***');
    });

    it('parentName="王"（1 字）→ 单字不 mask 直接保留', async () => {
      repo.listPendingContracts.mockResolvedValueOnce([pendingRow('王')]);
      const r = await service.listPendingContracts(TENANT_A);
      expect(r.items[0].parentNameMasked).toBe('王');
    });

    it('parentName=null → parentNameMasked=null', async () => {
      repo.listPendingContracts.mockResolvedValueOnce([pendingRow(null)]);
      const r = await service.listPendingContracts(TENANT_A);
      expect(r.items[0].parentNameMasked).toBeNull();
    });

    it('parentName="" 空字符串 → null', async () => {
      repo.listPendingContracts.mockResolvedValueOnce([pendingRow('')]);
      const r = await service.listPendingContracts(TENANT_A);
      expect(r.items[0].parentNameMasked).toBeNull();
    });

    it('contractNo 取 id 后 8 位（大写）', async () => {
      // id 末 8 字符 "BCDA1" → 实际后 8 = "0ABCDA1" + last char
      // id = 'CT_LONG_ULID_0000000000000000ABCDA1' （35 字符）
      // 后 8 = '00ABCDA1'
      repo.listPendingContracts.mockResolvedValueOnce([pendingRow('王二')]);
      const r = await service.listPendingContracts(TENANT_A);
      expect(r.items[0].contractNo).toBe('00ABCDA1');
      // 全大写（id 后 8 已大写 → toUpperCase 幂等）
      expect(r.items[0].contractNo).toBe(r.items[0].contractNo.toUpperCase());
    });

    it('id 含小写 → contractNo 转大写', async () => {
      const lowerRow = { ...pendingRow('王二'), id: 'CT_LONG_ULID_0000000000000000abcdef01' };
      repo.listPendingContracts.mockResolvedValueOnce([lowerRow]);
      const r = await service.listPendingContracts(TENANT_A);
      // 后 8 = 'abcdef01' → toUpperCase → 'ABCDEF01'
      expect(r.items[0].contractNo).toBe('ABCDEF01');
    });

    it('options 透传 (campusId/limit/offset)', async () => {
      repo.listPendingContracts.mockResolvedValueOnce([]);
      await service.listPendingContracts(TENANT_A, {
        campusId: 'campus_A',
        limit: 30,
        offset: 100,
      });
      expect(repo.listPendingContracts).toHaveBeenCalledWith(TENANT_A, {
        campusId: 'campus_A',
        limit: 30,
        offset: 100,
      });
    });

    it('多行混合 mask（包含 null + 多字 + 单字）', async () => {
      repo.listPendingContracts.mockResolvedValueOnce([
        pendingRow('王二'),
        pendingRow(null),
        pendingRow('李'),
        pendingRow('张三丰'),
      ]);
      const r = await service.listPendingContracts(TENANT_A);
      expect(r.items.map((x) => x.parentNameMasked)).toEqual(['王*', null, '李', '张**']);
    });
  });
});
