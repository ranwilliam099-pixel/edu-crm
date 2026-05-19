/**
 * CheckoutService 单元测试 — W3-1 Phase 1.3 BE-W3-3
 *
 * PM-AUTH-6(2026-04-30): 4 SKU 真值 + 容量边界
 *
 * 覆盖：
 *   - getSkuPrice 4 SKU 全部
 *   - createOrder trial / standard / school_pro / growth 4 场景
 *   - growth 询价制必须传 customQuotePriceCnyYuan + 不低于起步价
 *   - 非 growth 不接受 customQuotePriceCnyYuan
 *   - 输入校验
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { CheckoutService, CreateOrderDto } from './checkout.service';

const ULID32_A = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNOP';
const ULID32_B = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNOQ';

describe('CheckoutService', () => {
  let service: CheckoutService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CheckoutService],
    }).compile();
    service = module.get<CheckoutService>(CheckoutService);
  });

  describe('getSkuPrice - PM-AUTH-6 4 SKU 真值', () => {
    it('trial → 0 元 / 14 天 / 3 校区 / 50 账号', () => {
      const p = service.getSkuPrice('trial');
      expect(p.priceCnyYuan).toBe(0);
      expect(p.billingPeriodDays).toBe(14);
      expect(p.maxCampuses).toBe(3);
      expect(p.maxAccounts).toBe(50);
      expect(p.isQuoteBased).toBe(false);
    });

    it('standard_1999 → 1999 元 / 365 天 / 3 校区 / 50 账号', () => {
      const p = service.getSkuPrice('standard_1999');
      expect(p.priceCnyYuan).toBe(1999);
      expect(p.billingPeriodDays).toBe(365);
      expect(p.maxCampuses).toBe(3);
      expect(p.maxAccounts).toBe(50);
    });

    it('school_pro → 4999 元 / 365 天 / 5 校区 / 100 账号', () => {
      const p = service.getSkuPrice('school_pro');
      expect(p.priceCnyYuan).toBe(4999);
      expect(p.maxCampuses).toBe(5);
      expect(p.maxAccounts).toBe(100);
    });

    it('growth → 9999 元起 / 询价制', () => {
      const p = service.getSkuPrice('growth');
      expect(p.priceCnyYuan).toBe(9999);
      expect(p.isQuoteBased).toBe(true);
    });
  });

  describe('createOrder - PM-AUTH-6 订单生成', () => {
    it('trial 订单 → amount=0', () => {
      const dto: CreateOrderDto = { orderId: ULID32_A, tenantId: ULID32_B, sku: 'trial' };
      const order = service.createOrder(dto);
      expect(order.amountCnyYuan).toBe(0);
      expect(order.priceTier).toBe('trial');
      expect(order.state).toBe('待支付');
      expect(order.billingPeriodDays).toBe(14);
    });

    it('standard_1999 订单 → amount=1999', () => {
      const dto: CreateOrderDto = { orderId: ULID32_A, tenantId: ULID32_B, sku: 'standard_1999' };
      const order = service.createOrder(dto);
      expect(order.amountCnyYuan).toBe(1999);
      expect(order.priceTier).toBe('standard_1999');
    });

    it('school_pro 订单 → amount=4999', () => {
      const dto: CreateOrderDto = { orderId: ULID32_A, tenantId: ULID32_B, sku: 'school_pro' };
      const order = service.createOrder(dto);
      expect(order.amountCnyYuan).toBe(4999);
    });

    it('growth 订单需传 customQuotePriceCnyYuan ≥ 9999', () => {
      const dto: CreateOrderDto = {
        orderId: ULID32_A,
        tenantId: ULID32_B,
        sku: 'growth',
        customQuotePriceCnyYuan: 15000,
      };
      const order = service.createOrder(dto);
      expect(order.amountCnyYuan).toBe(15000);
      expect(order.priceTier).toBe('growth');
    });

    it('growth 不传 customQuotePriceCnyYuan → BadRequestException', () => {
      const dto: CreateOrderDto = { orderId: ULID32_A, tenantId: ULID32_B, sku: 'growth' };
      expect(() => service.createOrder(dto)).toThrow(BadRequestException);
    });

    it('growth customQuotePriceCnyYuan < 9999 → BadRequestException', () => {
      const dto: CreateOrderDto = {
        orderId: ULID32_A,
        tenantId: ULID32_B,
        sku: 'growth',
        customQuotePriceCnyYuan: 5000,
      };
      expect(() => service.createOrder(dto)).toThrow(BadRequestException);
    });

    it('非 growth 不接受 customQuotePriceCnyYuan → BadRequestException', () => {
      const dto: CreateOrderDto = {
        orderId: ULID32_A,
        tenantId: ULID32_B,
        sku: 'standard_1999',
        customQuotePriceCnyYuan: 3000,
      };
      expect(() => service.createOrder(dto)).toThrow(BadRequestException);
    });
  });

  describe('createOrder - 输入校验', () => {
    it('orderId 长度非 32 → BadRequestException', () => {
      expect(() =>
        service.createOrder({ orderId: 'short', tenantId: ULID32_B, sku: 'trial' }),
      ).toThrow(BadRequestException);
    });

    it('tenantId 长度非 32 → BadRequestException', () => {
      expect(() =>
        service.createOrder({ orderId: ULID32_A, tenantId: 'short', sku: 'trial' }),
      ).toThrow(BadRequestException);
    });
  });

  describe('getCapacityLimit - A07/A08 容量守护', () => {
    it('standard_1999 → 3 校区 + 50 账号', () => {
      expect(service.getCapacityLimit('standard_1999')).toEqual({
        maxCampuses: 3,
        maxAccounts: 50,
      });
    });

    it('school_pro → 5 校区 + 100 账号', () => {
      expect(service.getCapacityLimit('school_pro')).toEqual({
        maxCampuses: 5,
        maxAccounts: 100,
      });
    });
  });
});
