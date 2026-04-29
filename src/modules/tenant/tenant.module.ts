import { Module } from '@nestjs/common';
import { TenantService } from './tenant.service';

/**
 * Tenant 模块（W1 BE-W1-2 骨架）
 *
 * 提供 TenantService（schema-per-tenant 初始化），供 checkout 模块（W2-T3 微信支付回调）注入调用。
 * 不暴露 HTTP 路由——租户初始化由内部业务编排触发，不是公开接口。
 */
@Module({
  providers: [TenantService],
  exports: [TenantService],
})
export class TenantModule {}
