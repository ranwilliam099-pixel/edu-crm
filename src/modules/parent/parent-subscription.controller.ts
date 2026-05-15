import {
  Body,
  Controller,
  Param,
  Post,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {
  ParentSubscriptionService,
  ParentSubscription,
} from './parent-subscription.service';
import { ParentSelfGuard } from '../auth/parent-self.guard';

/**
 * ParentSubscriptionController — V10/V11 9.9 订阅 + 7 天试用 HTTP 暴露 BE-V10-2
 *
 * 路由前缀：/api/parent-subscriptions
 *
 * USER-AUTH(2026-05-02): 条目 31 #3 共享 + #4 7 天试用 + 条目 32 L3
 *
 * T6b-FU-1 (2026-05-16): class-level @UseGuards(ParentSelfGuard)
 *   含 :parentId 路径（db/find/:parentId / db/cancel/:parentId）→ Guard 校验 jwt.sub === parentId
 *   不含 :parentId 路径 → Guard 跳过（return true，由 service 层兜底）
 */
@Controller('parent-subscriptions')
@UseGuards(ParentSelfGuard)
export class ParentSubscriptionController {
  constructor(private readonly service: ParentSubscriptionService) {}

  /**
   * POST /api/parent-subscriptions/start-trial — 启动 7 天免费试用
   */
  @Post('start-trial')
  @HttpCode(HttpStatus.CREATED)
  startTrial(
    @Body() body: { subscriptionId: string; parentId: string; nowMs?: number },
  ): ParentSubscription {
    return this.service.startTrial({
      subscriptionId: body.subscriptionId,
      parentId: body.parentId,
      now: body.nowMs ? new Date(body.nowMs) : undefined,
    });
  }

  /**
   * POST /api/parent-subscriptions/convert-trial — 试用转 9.9/月（cron）
   */
  @Post('convert-trial')
  @HttpCode(HttpStatus.OK)
  convertTrialToActive(
    @Body() body: { subscription: ParentSubscription; paymentOrderId: string; nowMs?: number },
  ) {
    return this.service.convertTrialToActive({
      subscription: this.deserialize(body.subscription),
      paymentOrderId: body.paymentOrderId,
      now: body.nowMs ? new Date(body.nowMs) : undefined,
    });
  }

  /**
   * POST /api/parent-subscriptions/renew — 月度续费（cron）
   */
  @Post('renew')
  @HttpCode(HttpStatus.OK)
  monthlyRenew(
    @Body()
    body: {
      subscription: ParentSubscription;
      paymentOrderId: string;
      paymentSucceeded: boolean;
      nowMs?: number;
    },
  ) {
    return this.service.monthlyRenew({
      subscription: this.deserialize(body.subscription),
      paymentOrderId: body.paymentOrderId,
      paymentSucceeded: body.paymentSucceeded,
      now: body.nowMs ? new Date(body.nowMs) : undefined,
    });
  }

  /**
   * POST /api/parent-subscriptions/cancel — 取消订阅
   */
  @Post('cancel')
  @HttpCode(HttpStatus.OK)
  cancelSubscription(
    @Body() body: { subscription: ParentSubscription; atPeriodEnd: boolean; nowMs?: number },
  ): ParentSubscription {
    return this.service.cancelSubscription({
      subscription: this.deserialize(body.subscription),
      atPeriodEnd: body.atPeriodEnd,
      now: body.nowMs ? new Date(body.nowMs) : undefined,
    });
  }

  /**
   * POST /api/parent-subscriptions/access-check — ParentReadGuard 校验入口
   *
   * 给前端预检（避免请求反馈接口才知道 403）
   */
  @Post('access-check')
  @HttpCode(HttpStatus.OK)
  accessCheck(
    @Body() body: { subscription?: ParentSubscription; nowMs?: number },
  ): { canAccess: boolean } {
    return {
      canAccess: this.service.canAccessContent({
        subscription: body.subscription
          ? this.deserialize(body.subscription)
          : undefined,
        now: body.nowMs ? new Date(body.nowMs) : undefined,
      }),
    };
  }

  /**
   * POST /api/parent-subscriptions/db/start-trial — 真存盘
   */
  @Post('db/start-trial')
  @HttpCode(HttpStatus.CREATED)
  async startTrialInDb(
    @Body() body: { subscriptionId: string; parentId: string },
  ): Promise<ParentSubscription> {
    return this.service.startTrialInDb(body);
  }

  @Post('db/find/:parentId')
  @HttpCode(HttpStatus.OK)
  async findInDb(@Param('parentId') parentId: string): Promise<ParentSubscription | { found: false }> {
    const sub = await this.service.findSubscriptionInDb(parentId);
    return sub || ({ found: false } as any);
  }

  @Post('db/cancel/:parentId')
  @HttpCode(HttpStatus.OK)
  async cancelInDb(
    @Param('parentId') parentId: string,
    @Body() body: { atPeriodEnd: boolean },
  ): Promise<ParentSubscription> {
    return this.service.cancelSubscriptionInDb(parentId, body.atPeriodEnd);
  }

  // 由于 JSON 不带 Date 类型，反序列化输入的字符串日期
  private deserialize(sub: ParentSubscription): ParentSubscription {
    return {
      ...sub,
      currentPeriodEnd: sub.currentPeriodEnd
        ? new Date(sub.currentPeriodEnd as unknown as string)
        : undefined,
      trialEndAt: sub.trialEndAt
        ? new Date(sub.trialEndAt as unknown as string)
        : undefined,
    };
  }
}
