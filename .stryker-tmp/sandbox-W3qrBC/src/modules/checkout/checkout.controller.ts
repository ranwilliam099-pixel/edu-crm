import { Body, Controller, Get, Param, Post, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import {
  CheckoutService,
  CreateOrderDto,
  SkuName,
} from './checkout.service';
import { CheckoutInvoiceService, InvoiceRequestInput } from './invoice.service';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';

/**
 * CheckoutController — W3-1 Phase 1.3 BE-W3-3 订单 / 4 SKU 价格 HTTP 暴露
 *
 * 来源：
 *   - 《全部人员-审核往来总台账.md》条目 14 §B Track CODE-1 BE-W3-3
 *   - AUTH-6 4 SKU 真值 + AUTH-10 容量边界
 *
 * PM-AUTH-6(2026-04-30): 公开价格查询 + 已认证订单创建
 *
 * 路由前缀：/api/checkout
 * 价格查询为公开接口（GET /sku/* + GET /capacity/:sku，纯 SKU 元数据，无租户上下文）；
 * 订单创建需要认证（POST /orders + POST /invoices）
 *
 * Sprint B.6 mini (2026-05-11) 深度防御：
 *   - method-level @UseGuards(TenantScopeGuard) 仅装在 POST 写 endpoint
 *   - 公开 GET 不装（保持落地页 / 静态价格页可访问）
 */
@Controller('checkout')
export class CheckoutController {
  constructor(
    private readonly service: CheckoutService,
    private readonly invoice: CheckoutInvoiceService,
  ) {}

  /**
   * GET /api/public/checkout/sku/:sku — 查询单个 SKU 价格信息
   *
   * 公开接口，前端静态价格页 / 落地页直接查询
   */
  @Get('sku/:sku')
  getSkuPrice(@Param('sku') sku: string) {
    return this.service.getSkuPrice(sku as SkuName);
  }

  /**
   * GET /api/public/checkout/sku — 列出全部 4 SKU 价格
   */
  @Get('sku')
  listAllSku() {
    const skus: SkuName[] = ['trial', 'standard_1999', 'school_pro', 'growth'];
    return skus.map((sku) => this.service.getSkuPrice(sku));
  }

  /**
   * POST /api/checkout/orders — 创建订单（生成 OrderData）
   *
   * 当前不真实 INSERT DB（INT-01 仍由 AUTH-1 docker PG 提供，Repository 待落地）
   */
  @Post('orders')
  @UseGuards(TenantScopeGuard)
  @HttpCode(HttpStatus.CREATED)
  createOrder(@Body() dto: CreateOrderDto) {
    return this.service.createOrder(dto);
  }

  /**
   * POST /api/checkout/invoices — 提交开票申请
   *
   * 当前阶段先做服务端校验与状态回执；真实写入 invoice_requests
   * 等支付订单持久化仓库接入后补上。
   */
  @Post('invoices')
  @UseGuards(TenantScopeGuard)
  @HttpCode(HttpStatus.CREATED)
  createInvoiceRequest(@Body() dto: InvoiceRequestInput) {
    this.invoice.validateInvoiceRequest(dto);
    return {
      invoiceId: `inv${dto.orderId.slice(3)}`,
      orderId: dto.orderId,
      invoiceTitle: dto.invoiceTitle,
      state: '待审核',
      submittedAt: new Date().toISOString(),
    };
  }

  /**
   * GET /api/checkout/capacity/:sku — 查询 SKU 容量边界
   *
   * 公开接口（纯 SKU 元数据，对应 SKU 价格信息中的 maxCampuses/maxAccounts 字段）
   */
  @Get('capacity/:sku')
  getCapacity(@Param('sku') sku: string) {
    return this.service.getCapacityLimit(sku as SkuName);
  }
}
