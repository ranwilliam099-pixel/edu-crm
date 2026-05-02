import { Module } from '@nestjs/common';
import { ParentService } from './parent.service';
import { ParentSubscriptionService } from './parent-subscription.service';

/**
 * Parent 模块（V10 家长身份 + 订阅）
 *
 * USER-AUTH(2026-05-02): C 端家长跨租户身份 + 9.9/月订阅 + 7 天免费试用
 *   - 条目 31 #3 跨机构共享 1 笔订阅
 *   - 条目 31 #4 加 7 天免费试用
 *   - 条目 32 #10 退订后保留绑定
 */
@Module({
  providers: [ParentService, ParentSubscriptionService],
  exports: [ParentService, ParentSubscriptionService],
})
export class ParentModule {}
