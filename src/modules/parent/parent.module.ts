import { Module } from '@nestjs/common';
import { ParentService } from './parent.service';
import { ParentSubscriptionService } from './parent-subscription.service';
import { ParentController } from './parent.controller';
import { ParentSubscriptionController } from './parent-subscription.controller';

/**
 * Parent 模块（V10 家长身份 + 订阅）
 *
 * USER-AUTH(2026-05-02): C 端家长跨租户身份 + 9.9/月订阅 + 7 天免费试用
 */
@Module({
  controllers: [ParentController, ParentSubscriptionController],
  providers: [ParentService, ParentSubscriptionService],
  exports: [ParentService, ParentSubscriptionService],
})
export class ParentModule {}
