/**
 * InvoiceController 单元测试 — Wave 4A.2-T1
 *
 * 模式：直接 new InvoiceController（避免 NestJS DI 拉起 IdempotencyInterceptor → RedisService 链）
 * RbacGuard / TenantScopeGuard / IdempotencyInterceptor / Throttler 已有独立 spec 覆盖；
 * 故本 spec 仅校验 controller 自身责任：
 *   - 入参校验 (BadRequestException)
 *   - 路径委派给 service
 *   - audit 上下文向 service 传递
 *   - @Roles 元数据正确（finance/boss/admin）
 *   - class-level 守门 metadata 存在（TenantScopeGuard + RbacGuard）
 *
 * 重要：本 spec 直接 new controller, 不走 NestJS DI Guard / Interceptor。
 *      所以 403/401 等 guard 行为 NOT 覆盖（由 guard 自身 spec 覆盖）。
 *      controller 层的「拒绝路径」体现在 BadRequest 入参校验。
 */

import { BadRequestException } from '@nestjs/common';
import 'reflect-metadata';
import { InvoiceController } from './invoice.controller';
import type { InvoiceService } from './invoice.service';
import type { AuditLogRepository } from '../db/audit-log.repository';
import type { AuthenticatedRequest, TenantRole } from '../auth/jwt-payload.interface';
import type { Invoice, PendingContractView } from './invoice.dto';

const TENANT_A = 'tenant_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const INVOICE_ID = '01HRX5INVOICE0000000000000000A01';
const CONTRACT_ID = '01HRX5CONTRACT00000000000000A001';
const USER_FINANCE = 'usrFinance00000000000000000000A1';
// 5/15 A-1：USER_BOSS / USER_ADMIN 在 invoice 域不再用 — boss/admin 不能创建/读/改发票
const CAMPUS_A = 'campus_A00000000000000000000000A1';

function jwt(role: TenantRole, sub = USER_FINANCE) {
  return { sub, tenantId: 'tnnt00000000000000000000000000A1', role, campusId: CAMPUS_A };
}

function makeReq(opts: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return {
    headers: { 'user-agent': 'WeChatMP/8.x', 'x-request-id': 'req-test-w4a-001' },
    ip: '10.0.0.1',
    body: {},
    query: {},
    params: {},
    ...opts,
  } as AuthenticatedRequest;
}

function invoiceFixture(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: INVOICE_ID,
    contractId: CONTRACT_ID,
    studentId: 'stu0000000000000000000000000000A1',
    customerId: 'cus0000000000000000000000000000A1',
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

describe('InvoiceController (Wave 4A.2-T1)', () => {
  let controller: InvoiceController;
  let service: {
    createInvoice: jest.Mock;
    listPendingContracts: jest.Mock;
    findById: jest.Mock;
  };
  let auditLog: { log: jest.Mock };

  function build(opts: { withAudit?: boolean } = {}) {
    const withAudit = opts.withAudit ?? true;
    return new InvoiceController(
      service as unknown as InvoiceService,
      withAudit ? (auditLog as unknown as AuditLogRepository) : undefined,
    );
  }

  beforeEach(() => {
    service = {
      createInvoice: jest.fn(),
      listPendingContracts: jest.fn(),
      findById: jest.fn(),
    };
    auditLog = { log: jest.fn().mockResolvedValue(undefined) };
    controller = build();
  });

  // ============================================================
  // POST /db/invoices — create
  // ============================================================
  describe('create() — happy path 与入参校验', () => {
    const validBody = () => ({
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

    it('finance happy path → 调 service.createInvoice + 返 Invoice', async () => {
      service.createInvoice.mockResolvedValueOnce(invoiceFixture());
      const req = makeReq({ user: jwt('finance', USER_FINANCE) });
      const r = await controller.create(validBody(), req);
      expect(r.id).toBe(INVOICE_ID);
      expect(r.status).toBe('pending');
      expect(service.createInvoice).toHaveBeenCalledTimes(1);
      const [dto, currentUser, auditCtx] = service.createInvoice.mock.calls[0];
      expect(dto.invoiceId).toBe(INVOICE_ID);
      expect(dto.contractId).toBe(CONTRACT_ID);
      expect(currentUser).toEqual({ sub: USER_FINANCE, role: 'finance' });
      expect(auditCtx.ip).toBe('10.0.0.1');
      expect(auditCtx.userAgent).toBe('WeChatMP/8.x');
      expect(auditCtx.requestId).toBe('req-test-w4a-001');
    });

    // 5/15 A-1 拍板：boss/admin 不直接调 create — 由 RbacGuard 在 controller 前抛 403
    // 此处不再保留 boss/admin happy-path（spec 直调 controller 绕过 guard，但 @Roles 已禁止）
    // 真实路径行为由 batch-b-peripheral.spec.ts (RbacGuard.canActivate boss/admin → ForbiddenException) 覆盖
    // 此 controller-spec 只保留 finance happy-path 验业务调用契约

    // ---- 入参校验（在 controller 层 fail-fast）-----
    it('tenantSchema 缺失 → BadRequest', async () => {
      const body = { ...validBody(), tenantSchema: '' };
      const req = makeReq({ user: jwt('finance') });
      await expect(controller.create(body as never, req)).rejects.toThrow(BadRequestException);
      await expect(controller.create(body as never, req)).rejects.toThrow(/tenantSchema/);
      expect(service.createInvoice).not.toHaveBeenCalled();
    });

    it('invoiceId 长度 != 32 → BadRequest', async () => {
      const body = { ...validBody(), invoiceId: 'short_id' };
      const req = makeReq({ user: jwt('finance') });
      await expect(controller.create(body, req)).rejects.toThrow(BadRequestException);
      await expect(controller.create(body, req)).rejects.toThrow(/invoiceId/);
    });

    it('invoiceId 缺失 → BadRequest', async () => {
      const body = { ...validBody(), invoiceId: '' };
      const req = makeReq({ user: jwt('finance') });
      await expect(controller.create(body, req)).rejects.toThrow(BadRequestException);
    });

    it('contractId 长度 != 32 → BadRequest', async () => {
      const body = { ...validBody(), contractId: 'too_short' };
      const req = makeReq({ user: jwt('finance') });
      await expect(controller.create(body, req)).rejects.toThrow(BadRequestException);
      await expect(controller.create(body, req)).rejects.toThrow(/contractId/);
    });

    it('contractId 缺失 → BadRequest', async () => {
      const body = { ...validBody(), contractId: '' };
      const req = makeReq({ user: jwt('finance') });
      await expect(controller.create(body, req)).rejects.toThrow(BadRequestException);
    });

    it('titleType 缺失 → BadRequest', async () => {
      const body = { ...validBody() } as Record<string, unknown>;
      delete body.titleType;
      const req = makeReq({ user: jwt('finance') });
      await expect(controller.create(body as never, req)).rejects.toThrow(BadRequestException);
      await expect(controller.create(body as never, req)).rejects.toThrow(/titleType/);
    });

    it('invoiceTitle 缺失 → BadRequest', async () => {
      const body = { ...validBody(), invoiceTitle: '' };
      const req = makeReq({ user: jwt('finance') });
      await expect(controller.create(body, req)).rejects.toThrow(BadRequestException);
      await expect(controller.create(body, req)).rejects.toThrow(/invoiceTitle/);
    });

    it('receiveEmail 缺失 → BadRequest', async () => {
      const body = { ...validBody(), receiveEmail: '' };
      const req = makeReq({ user: jwt('finance') });
      await expect(controller.create(body, req)).rejects.toThrow(BadRequestException);
      await expect(controller.create(body, req)).rejects.toThrow(/receiveEmail/);
    });

    it('req.user 缺失 → BadRequest（user identity required）', async () => {
      const req = makeReq();
      await expect(controller.create(validBody(), req)).rejects.toThrow(BadRequestException);
      await expect(controller.create(validBody(), req)).rejects.toThrow(/user identity/);
      expect(service.createInvoice).not.toHaveBeenCalled();
    });

    it('req.user.sub 缺失 → BadRequest', async () => {
      const req = makeReq({ user: { ...jwt('finance'), sub: '' } as never });
      await expect(controller.create(validBody(), req)).rejects.toThrow(BadRequestException);
    });

    it('service.createInvoice 抛错 → controller 透传错误', async () => {
      service.createInvoice.mockRejectedValueOnce(new Error('repo down'));
      const req = makeReq({ user: jwt('finance') });
      await expect(controller.create(validBody(), req)).rejects.toThrow(/repo down/);
    });

    it('req.headers 部分缺失 → auditCtx.userAgent/requestId 为 null（fail-safe）', async () => {
      service.createInvoice.mockResolvedValueOnce(invoiceFixture());
      const req = {
        headers: {},
        ip: '10.0.0.2',
        user: jwt('finance'),
      } as unknown as AuthenticatedRequest;
      await controller.create(validBody(), req);
      const [, , auditCtx] = service.createInvoice.mock.calls[0];
      expect(auditCtx.userAgent).toBeNull();
      expect(auditCtx.requestId).toBeNull();
      expect(auditCtx.ip).toBe('10.0.0.2');
    });

    it('req.ip 缺失 → auditCtx.ip=null', async () => {
      service.createInvoice.mockResolvedValueOnce(invoiceFixture());
      const req = {
        headers: { 'user-agent': 'WX/1' },
        user: jwt('finance'),
      } as unknown as AuthenticatedRequest;
      await controller.create(validBody(), req);
      const [, , auditCtx] = service.createInvoice.mock.calls[0];
      expect(auditCtx.ip).toBeNull();
    });

    it('包含 remark 时透传到 service', async () => {
      service.createInvoice.mockResolvedValueOnce(invoiceFixture({ remark: '5/15 开票备注' }));
      const req = makeReq({ user: jwt('finance') });
      const body = { ...validBody(), remark: '5/15 开票备注' };
      await controller.create(body, req);
      const [dto] = service.createInvoice.mock.calls[0];
      expect(dto.remark).toBe('5/15 开票备注');
    });
  });

  // ============================================================
  // GET /db/invoices/pending-contracts — listPending
  // ============================================================
  describe('listPending() — 待开票合同列表', () => {
    const pendingFixture = (overrides: Partial<PendingContractView> = {}): PendingContractView => ({
      id: CONTRACT_ID,
      studentId: 'stu0000000000000000000000000000A1',
      studentName: '王同学',
      parentNameMasked: '王*',
      totalAmount: 9999,
      signedAt: '2026-05-10T08:00:00.000Z',
      contractNo: 'CT000A01',
      ...overrides,
    });

    it('tenantSchema 缺失 → BadRequest', async () => {
      await expect(
        controller.listPending('', undefined, undefined, undefined),
      ).rejects.toThrow(BadRequestException);
      expect(service.listPendingContracts).not.toHaveBeenCalled();
    });

    it('happy path → 调 service.listPendingContracts + 返 items', async () => {
      service.listPendingContracts.mockResolvedValueOnce({
        items: [pendingFixture(), pendingFixture({ id: 'CT2', contractNo: 'CT2_LAST8' })],
      });
      const r = await controller.listPending(TENANT_A);
      expect(r.items).toHaveLength(2);
      expect(r.items[0].parentNameMasked).toBe('王*');
      expect(service.listPendingContracts).toHaveBeenCalledWith(TENANT_A, {
        campusId: undefined,
        limit: 50,
        offset: 0,
      });
    });

    it('limit 超过 200 → 截断到 200', async () => {
      service.listPendingContracts.mockResolvedValueOnce({ items: [] });
      await controller.listPending(TENANT_A, undefined, '500', '10');
      expect(service.listPendingContracts).toHaveBeenCalledWith(TENANT_A, {
        campusId: undefined,
        limit: 200,
        offset: 10,
      });
    });

    it('campusId 透传', async () => {
      service.listPendingContracts.mockResolvedValueOnce({ items: [] });
      await controller.listPending(TENANT_A, CAMPUS_A, '20', '0');
      expect(service.listPendingContracts).toHaveBeenCalledWith(TENANT_A, {
        campusId: CAMPUS_A,
        limit: 20,
        offset: 0,
      });
    });

    it('limit/offset 全 undefined → 默认 50/0', async () => {
      service.listPendingContracts.mockResolvedValueOnce({ items: [pendingFixture()] });
      await controller.listPending(TENANT_A);
      expect(service.listPendingContracts).toHaveBeenCalledWith(TENANT_A, {
        campusId: undefined,
        limit: 50,
        offset: 0,
      });
    });
  });

  // ============================================================
  // GET /db/invoices/:id — detail
  // ============================================================
  describe('detail() — 详情', () => {
    it('tenantSchema 缺失 → BadRequest', async () => {
      await expect(controller.detail(INVOICE_ID, '')).rejects.toThrow(BadRequestException);
    });

    it('id 长度 != 32 → BadRequest', async () => {
      await expect(controller.detail('short_id', TENANT_A)).rejects.toThrow(BadRequestException);
    });

    it('id 缺失 → BadRequest', async () => {
      await expect(controller.detail('', TENANT_A)).rejects.toThrow(BadRequestException);
    });

    it('找到 invoice → 返完整 Invoice 含 PII 字段', async () => {
      service.findById.mockResolvedValueOnce(invoiceFixture());
      const r = await controller.detail(INVOICE_ID, TENANT_A);
      expect(r).toEqual(invoiceFixture());
      expect((r as Invoice).receivePhone).toBe('13800001234'); // 5/15 A-1：仅 finance 可读完整 PII
      expect(service.findById).toHaveBeenCalledWith(TENANT_A, INVOICE_ID);
    });

    it('未找到 invoice → { found: false }', async () => {
      service.findById.mockResolvedValueOnce(null);
      const r = await controller.detail(INVOICE_ID, TENANT_A);
      expect(r).toEqual({ found: false });
    });
  });

  // ============================================================
  // 元数据：@Roles + class-level guards
  // ============================================================
  describe('RBAC 元数据（@Roles 装饰器）', () => {
    // @Roles 装饰器使用 ROLES_METADATA_KEY = 'rbac_roles'（见 guards/rbac.decorator.ts）
    const ROLES_KEY = 'rbac_roles';

    // 2026-05-15 A-1 修订：finance.invoice.create=[finance]（不含 boss/admin）
    it('create 方法 @Roles 严格等于 [finance]（5/15 A-1 拍板）', () => {
      const roles = Reflect.getMetadata(ROLES_KEY, InvoiceController.prototype.create);
      expect(roles).toEqual(['finance']);
    });

    it('listPending 方法 @Roles 严格等于 [finance]（5/15 A-1 拍板）', () => {
      const roles = Reflect.getMetadata(ROLES_KEY, InvoiceController.prototype.listPending);
      expect(roles).toEqual(['finance']);
    });

    it('detail 方法 @Roles 严格等于 [finance]（5/15 A-1 拍板）', () => {
      const roles = Reflect.getMetadata(ROLES_KEY, InvoiceController.prototype.detail);
      expect(roles).toEqual(['finance']);
    });

    it('@Roles 不包含 sales / teacher / academic / parent / boss / admin (拍板拒绝角色)', () => {
      const createRoles: string[] =
        Reflect.getMetadata(ROLES_KEY, InvoiceController.prototype.create) || [];
      expect(createRoles).not.toContain('sales');
      expect(createRoles).not.toContain('teacher');
      expect(createRoles).not.toContain('academic');
      expect(createRoles).not.toContain('parent');
      expect(createRoles).not.toContain('sales_manager');
      // 5/15 A-2：sales_director 应用层已删 → 不应在任何 @Roles 装饰器里出现
      expect(createRoles).not.toContain('sales_director');
      expect(createRoles).not.toContain('hr');
      // 5/15 A-1：boss/admin 也不在 invoice.create.allow（红冲走 delete 路径）
      expect(createRoles).not.toContain('boss');
      expect(createRoles).not.toContain('admin');
    });
  });

  // ============================================================
  // class-level guards
  // ============================================================
  describe('Class-level @UseGuards (TenantScopeGuard + RbacGuard)', () => {
    it('controller 类上挂 __guards__ 元数据 (含 2 个 guard)', () => {
      const guards = Reflect.getMetadata('__guards__', InvoiceController);
      expect(Array.isArray(guards)).toBe(true);
      expect((guards as unknown[]).length).toBeGreaterThanOrEqual(2);
    });
  });

  // ============================================================
  // AuditLog @Optional 注入 — 单测不强依赖 audit
  // ============================================================
  describe('AuditLogRepository @Optional', () => {
    it('audit 未注入也不抛错（@Optional fail-open）', async () => {
      controller = build({ withAudit: false });
      service.createInvoice.mockResolvedValueOnce(invoiceFixture());
      const req = makeReq({ user: jwt('finance') });
      const r = await controller.create(
        {
          tenantSchema: TENANT_A,
          invoiceId: INVOICE_ID,
          contractId: CONTRACT_ID,
          titleType: '企业',
          invoiceTitle: '某某科技有限公司',
          taxId: '91500000X',
          receiveEmail: 'a@b.com',
        },
        req,
      );
      expect(r.id).toBe(INVOICE_ID);
    });
  });
});
