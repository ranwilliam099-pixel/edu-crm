import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { AdminTenantService, TenantListItem } from './admin-tenant.service';
import { TenantLifecycleService } from '../tenant/tenant-lifecycle.service';

const ULID32_T = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNOT';
const ULID32_O = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNOO';
const ULID32_R = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNOR';
const ULID32_I = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNOI';

describe('AdminTenantService - PM-AUTH-7 A11 §3.4 平台超管 API', () => {
  let service: AdminTenantService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AdminTenantService, TenantLifecycleService],
    }).compile();
    service = module.get<AdminTenantService>(AdminTenantService);
  });

  describe('freezeTenant', () => {
    it('active → frozen 合法', () => {
      const action = service.freezeTenant({
        tenantId: ULID32_T,
        currentState: 'active',
        reason: 'overdue 30 days',
        operatorId: ULID32_O,
      });
      expect(action.toState).toBe('frozen');
      expect(action.fromState).toBe('active');
      expect(action.operator).toBe(ULID32_O);
    });

    it('已 frozen → frozen 抛 ConflictException', () => {
      expect(() =>
        service.freezeTenant({
          tenantId: ULID32_T,
          currentState: 'frozen',
          reason: 'x',
          operatorId: ULID32_O,
        }),
      ).toThrow(ConflictException);
    });

    it('缺 reason → BadRequestException', () => {
      expect(() =>
        service.freezeTenant({
          tenantId: ULID32_T,
          currentState: 'active',
          reason: '',
          operatorId: ULID32_O,
        }),
      ).toThrow(BadRequestException);
    });

    it('缺 operatorId → BadRequestException', () => {
      expect(() =>
        service.freezeTenant({
          tenantId: ULID32_T,
          currentState: 'active',
          reason: 'x',
          operatorId: '',
        }),
      ).toThrow(BadRequestException);
    });
  });

  describe('unfreezeTenant', () => {
    it('frozen → active 合法', () => {
      const action = service.unfreezeTenant({
        tenantId: ULID32_T,
        currentState: 'frozen',
        operatorId: ULID32_O,
      });
      expect(action.toState).toBe('active');
    });

    it('expiring → active 合法（管理员手动续费）', () => {
      const action = service.unfreezeTenant({
        tenantId: ULID32_T,
        currentState: 'expiring',
        operatorId: ULID32_O,
      });
      expect(action.toState).toBe('active');
    });

    it('pending_delete → active 抛 ConflictException', () => {
      expect(() =>
        service.unfreezeTenant({
          tenantId: ULID32_T,
          currentState: 'pending_delete',
          operatorId: ULID32_O,
        }),
      ).toThrow(ConflictException);
    });
  });

  describe('approveRefund', () => {
    it('platform_admin 批准合法', () => {
      const action = service.approveRefund({
        refundOrderId: ULID32_R,
        decision: 'approve',
        reason: 'customer cancelled',
        approverRole: 'platform_admin',
        approverId: ULID32_O,
      });
      expect(action.decision).toBe('approve');
    });

    it('finance_admin 拒绝合法', () => {
      const action = service.approveRefund({
        refundOrderId: ULID32_R,
        decision: 'reject',
        reason: 'evidence insufficient',
        approverRole: 'finance_admin',
        approverId: ULID32_O,
      });
      expect(action.decision).toBe('reject');
    });

    it('未知 approverRole → BadRequestException', () => {
      expect(() =>
        service.approveRefund({
          refundOrderId: ULID32_R,
          decision: 'approve',
          reason: 'x',
          approverRole: 'sales' as any,
          approverId: ULID32_O,
        }),
      ).toThrow(BadRequestException);
    });

    it('未知 decision → BadRequestException', () => {
      expect(() =>
        service.approveRefund({
          refundOrderId: ULID32_R,
          decision: 'maybe' as any,
          reason: 'x',
          approverRole: 'platform_admin',
          approverId: ULID32_O,
        }),
      ).toThrow(BadRequestException);
    });
  });

  describe('approveInvoice', () => {
    it('finance_admin 批准合法', () => {
      const action = service.approveInvoice({
        invoiceId: ULID32_I,
        decision: 'approve',
        reason: 'tax info verified',
        approverRole: 'finance_admin',
        approverId: ULID32_O,
      });
      expect(action.decision).toBe('approve');
    });

    it('platform_admin 不允许审批发票 → BadRequestException', () => {
      expect(() =>
        service.approveInvoice({
          invoiceId: ULID32_I,
          decision: 'approve',
          reason: 'x',
          approverRole: 'platform_admin' as any,
          approverId: ULID32_O,
        }),
      ).toThrow(BadRequestException);
    });
  });

  describe('setReserveFlag', () => {
    it('设置保留标记合法', () => {
      const action = service.setReserveFlag({
        tenantId: ULID32_T,
        reservedFlag: true,
        reason: '客户长期合作 / 二次谈判',
        operator: ULID32_O,
        executedAt: new Date(),
      });
      expect(action.reservedFlag).toBe(true);
    });

    it('缺 reason → BadRequestException', () => {
      expect(() =>
        service.setReserveFlag({
          tenantId: ULID32_T,
          reservedFlag: true,
          reason: '',
          operator: ULID32_O,
          executedAt: new Date(),
        }),
      ).toThrow(BadRequestException);
    });
  });

  describe('filterTenants', () => {
    const tenants: TenantListItem[] = [
      {
        tenantId: ULID32_T,
        name: 'A',
        sku: 'standard_1999',
        state: 'active',
        expiresAt: new Date('2027-01-01'),
        campusCount: 2,
        accountCount: 30,
      },
      {
        tenantId: '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNOU',
        name: 'B',
        sku: 'school_pro',
        state: 'frozen',
        expiresAt: new Date('2026-12-01'),
        campusCount: 5,
        accountCount: 90,
      },
      {
        tenantId: '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNOV',
        name: 'C',
        sku: 'standard_1999',
        state: 'expiring',
        expiresAt: new Date('2026-11-15'),
        campusCount: 1,
        accountCount: 20,
      },
    ];

    it('按 state=active 过滤', () => {
      const result = service.filterTenants(tenants, { state: 'active' });
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('A');
    });

    it('按 sku=standard_1999 过滤', () => {
      const result = service.filterTenants(tenants, { sku: 'standard_1999' });
      expect(result).toHaveLength(2);
    });

    it('按 minAccounts=50 过滤', () => {
      const result = service.filterTenants(tenants, { minAccounts: 50 });
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('B');
    });

    it('多条件 AND 过滤', () => {
      const result = service.filterTenants(tenants, { sku: 'standard_1999', state: 'active' });
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('A');
    });

    it('空过滤器 → 返回全部', () => {
      const result = service.filterTenants(tenants, {});
      expect(result).toHaveLength(3);
    });
  });
});
