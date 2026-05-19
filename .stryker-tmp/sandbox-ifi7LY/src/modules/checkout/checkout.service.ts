import { Injectable, Logger, BadRequestException } from '@nestjs/common';

/**
 * CheckoutService — W3-1 Phase 1.3 BE-W3-3 4 SKU 价格表初始化 + 订单生成 + price_tier 落地
 *
 * 来源：
 *   - 《全部人员-审核往来总台账.md》条目 13 用户拍板 Q.PRICE 4 SKU 真值
 *   - 条目 14 §B Track CODE-1 BE-W3-3
 *   - V6__price_table_and_lifecycle_jobs.sql §3 price_table seed 数据
 *   - AUTH-2 EXT-01 挂账期间 wxpay V3 全链路按 mock 实现
 *   - AUTH-6 4 SKU 真值正式签字（trial 0/14天 / standard 1999/年 / school_pro 4999/年 / growth 询价）
 *
 * PM-AUTH-6(2026-04-30): 4 SKU 真值已落地 V6 seed
 *
 * 严守边界：
 *   1. 仅含 SKU 价格查询 + 订单数据生成（含 price_tier）；不真实 INSERT DB（INT-01 仍由 AUTH-1 docker PG 提供，
 *      但本 service 暂不直接连 PG，由 OrderRepository W3-3 拓展期落地）
 *   2. 不延伸 PaymentOrderStateService 之外的状态机
 *   3. growth SKU 询价制 — 不在本 service 直接给 price，而是抛"询价"标志，由销售实施评估后写入
 */
export interface SkuPrice {
  sku: SkuName;
  priceCnyYuan: number;
  billingPeriodDays: number;
  maxCampuses: number;
  maxAccounts: number;
  isQuoteBased: boolean;
}

export type SkuName = 'trial' | 'standard_1999' | 'school_pro' | 'growth';

export interface CreateOrderDto {
  /** 32-char ULID 订单 ID */
  readonly orderId: string;
  /** 32-char ULID 租户 ID */
  readonly tenantId: string;
  /** 4 SKU 之一 */
  readonly sku: SkuName;
  /** growth 询价制时由销售传入定制金额；其他 SKU 必须不传 */
  readonly customQuotePriceCnyYuan?: number;
}

export interface OrderData {
  orderId: string;
  tenantId: string;
  sku: SkuName;
  priceTier: SkuName; // 与 payment_orders.price_tier 字段一致
  amountCnyYuan: number;
  billingPeriodDays: number;
  state: '待支付';
}

@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  /**
   * 4 SKU 价格表内存常量（与 V6 seed 等价；真实 PG 落地后由 PriceTableRepository 替代）
   *
   * PM-AUTH-6(2026-04-30): 用户拍板正式签字
   */
  static readonly PRICE_TABLE: Readonly<Record<SkuName, SkuPrice>> = {
    trial: {
      sku: 'trial',
      priceCnyYuan: 0,
      billingPeriodDays: 14,
      maxCampuses: 3,
      maxAccounts: 50,
      isQuoteBased: false,
    },
    standard_1999: {
      sku: 'standard_1999',
      priceCnyYuan: 1999,
      billingPeriodDays: 365,
      maxCampuses: 3,
      maxAccounts: 50,
      isQuoteBased: false,
    },
    school_pro: {
      sku: 'school_pro',
      priceCnyYuan: 4999,
      billingPeriodDays: 365,
      maxCampuses: 5,
      maxAccounts: 100,
      isQuoteBased: false,
    },
    growth: {
      sku: 'growth',
      priceCnyYuan: 9999, // 起步价；询价制实际金额由销售实施给
      billingPeriodDays: 365,
      maxCampuses: 999,
      maxAccounts: 9999,
      isQuoteBased: true,
    },
  };

  /**
   * 查询 SKU 价格信息
   */
  getSkuPrice(sku: SkuName): SkuPrice {
    const price = CheckoutService.PRICE_TABLE[sku];
    if (!price) {
      throw new BadRequestException(`Unknown SKU: ${sku}`);
    }
    return price;
  }

  /**
   * 创建订单（生成 OrderData，含 price_tier；不真实 INSERT DB）
   *
   * PM-AUTH-6(2026-04-30): price_tier 与 SKU 同名（payment_orders.price_tier 字段约束 4 枚举）
   */
  createOrder(dto: CreateOrderDto): OrderData {
    if (!dto.orderId || dto.orderId.length !== 32) {
      throw new BadRequestException(`orderId must be 32-char ULID`);
    }
    if (!dto.tenantId || dto.tenantId.length !== 32) {
      throw new BadRequestException(`tenantId must be 32-char ULID`);
    }
    const price = this.getSkuPrice(dto.sku);

    // PM-AUTH-6: growth 询价制必须传 customQuotePriceCnyYuan
    let amountCnyYuan: number;
    if (price.isQuoteBased) {
      if (
        dto.customQuotePriceCnyYuan === undefined ||
        dto.customQuotePriceCnyYuan < price.priceCnyYuan
      ) {
        throw new BadRequestException(
          `growth SKU is quote-based; customQuotePriceCnyYuan must be >= ${price.priceCnyYuan}`,
        );
      }
      amountCnyYuan = dto.customQuotePriceCnyYuan;
    } else {
      if (dto.customQuotePriceCnyYuan !== undefined) {
        throw new BadRequestException(
          `non-growth SKU does not accept customQuotePriceCnyYuan`,
        );
      }
      amountCnyYuan = price.priceCnyYuan;
    }

    this.logger.log(
      `createOrder orderId=${dto.orderId} sku=${dto.sku} amount=${amountCnyYuan} period=${price.billingPeriodDays}`,
    );

    return {
      orderId: dto.orderId,
      tenantId: dto.tenantId,
      sku: dto.sku,
      priceTier: dto.sku,
      amountCnyYuan,
      billingPeriodDays: price.billingPeriodDays,
      state: '待支付',
    };
  }

  /**
   * 容量边界查询（A07/A08 守护用）
   */
  getCapacityLimit(sku: SkuName): { maxCampuses: number; maxAccounts: number } {
    const price = this.getSkuPrice(sku);
    return { maxCampuses: price.maxCampuses, maxAccounts: price.maxAccounts };
  }
}
