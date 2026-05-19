import { Module } from '@nestjs/common';
import { ParentService } from './parent.service';
import { ParentSubscriptionService } from './parent-subscription.service';
import { ParentController } from './parent.controller';
import { ParentSubscriptionController } from './parent-subscription.controller';
import { ParentSelfGuard } from '../auth/parent-self.guard';

/**
 * Parent 模块（V10 家长身份 + 订阅）
 *
 * USER-AUTH(2026-05-02): C 端家长跨租户身份 + 9.9/月订阅 + 7 天免费试用
 * T6b (2026-05-16): ParentSelfGuard 注册 — class-level 守 ParentController
 */
@Module({
  controllers: [ParentController, ParentSubscriptionController],
  providers: [ParentService, ParentSubscriptionService, ParentSelfGuard],
  exports: [ParentService, ParentSubscriptionService],
})
export class ParentModule {}
