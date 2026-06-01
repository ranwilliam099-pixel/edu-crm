import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CourseConsumptionService, CourseConsumption } from '../feedback/course-consumption.service';
import { LessonFeedback, LessonFeedbackService } from '../feedback/lesson-feedback.service';
import { MonthlyReportService, MonthlyReport } from '../feedback/monthly-report.service';
import {
  ParentSubscriptionService,
  ParentSubscription,
  ParentPaymentOrder,
} from '../parent/parent-subscription.service';
import { RecurringScheduleService, RecurringSchedule } from '../schedule/recurring-schedule.service';
import { PromotionQuotaService } from '../db/promotion-quota.service';
import { ReferralRepository } from '../db/referral.repository';
import { ScheduleRepository } from '../db/schedule.repository';
import { ParentSubscriptionRepository } from '../db/parent-subscription.repository';
import { CampusFreeSlotRepository } from '../db/campus-free-slot.repository';
import { PgPoolService } from '../db/pg-pool.service';
import { AuditLogRepository } from '../db/audit-log.repository';

/**
 * CronJobsService — 全局定时任务编排（W3-1 收尾）
 *
 * 来源：
 *   - PD 设计稿 §3.6.4 / §4.2 / §4.3 / §5.5
 *   - 用户拍板条目 31 #4 (7 天试用 + 自动续费) + 条目 32 L 系列
 *
 * 调度时点（cron expression 在每个方法 @Cron 装饰器 / 注释里）：
 *   - scan_and_lock_consumptions:    每 10 分钟    '*​/10 * * * *' (HTTP 触发，未装 @Cron)
 *   - convert_expired_trials:        每 5 分钟     '*​/5 * * * *' (HTTP 触发，未装 @Cron)
 *   - monthly_renew_active:          每天 0 点     '0 0 * * *' (HTTP 触发，未装 @Cron)
 *   - generate_monthly_reports:      每月 1 号 0:30 '30 0 1 * *' (HTTP 触发，未装 @Cron)
 *   - expand_recurring_schedules:    每天 0:30     '30 0 * * *' (HTTP 触发，未装 @Cron)
 *   - expireOverdueTrials (T9-EPIC): 每天 03:30   '30 3 * * *' (✅ 已装 @Cron L332)
 *
 * T-DEPLOY-FIX-1 round 2 (2026-05-16 pr-code-reviewer W-5 注释修正)：
 *   原注释 "当前不引入 @nestjs/schedule" 已 stale。T7 (2026-05-16 commit 6632589) 装了
 *   @nestjs/schedule + NestScheduleModule.forRoot() 在 cron.module.ts:21。
 *   未来 @Cron 包装其他方法（scan_and_lock / convert_expired_trials / 等）在 T7-b backlog。
 *
 * 本 Service 提供**统一编排接口**，方便单元测试 + 未来 T7-b 包装时一处加 @Cron 即可触发。
 */
@Injectable()
export class CronJobsService {
  private readonly logger = new Logger(CronJobsService.name);

  constructor(
    private readonly consumption: CourseConsumptionService,
    private readonly feedback: LessonFeedbackService,
    private readonly report: MonthlyReportService,
    private readonly subscription: ParentSubscriptionService,
    private readonly recurring: RecurringScheduleService,
    private readonly promoQuota: PromotionQuotaService,
    private readonly referrals: ReferralRepository,
    private readonly scheduleRepo: ScheduleRepository,
    private readonly parentSubRepo: ParentSubscriptionRepository,
    private readonly freeSlotRepo: CampusFreeSlotRepository,
    // T9-EPIC(2026-05-16) §4：expireOverdueTrials cron 依赖
    //   @Optional 是为了 spec 兼容（旧测试 fixture 不传不报错）
    @Optional() private readonly pg?: PgPoolService,
    @Optional() private readonly auditLogRepo?: AuditLogRepository,
  ) {}

  /**
   * cron: '0 4 * * *'（每天 04:00 UTC）
   * V23 巡检：occupied 超 3 月 → expired
   */
  async expireFreeSlots(): Promise<{ expired: number }> {
    const expired = await this.freeSlotRepo.expirePending();
    if (expired > 0) {
      this.logger.log(`[CRON] expireFreeSlots: ${expired} 条 occupied → expired`);
    }
    return { expired };
  }

  /**
   * V10/V11/V23 月度续费 — 真接 PG + mock 微信支付（待 EXT-01）
   *
   * 流程：
   *   1. 拉所有 currentPeriodEnd <= NOW + 1d 的 active 订阅
   *   2. 逐个调用 monthlyRenew + 真扣费（mock：返回 true 模拟成功）
   *   3. 持久化 subscription 状态 + payment_order
   *
   * @param paymentExecutor 真扣费函数；prod 替换为微信支付 SDK 调用
   */
  async monthlyRenewActiveSubscriptionsInDb(
    paymentOrderIdGenerator: (parentId: string) => string,
    paymentExecutor: (sub: ParentSubscription) => Promise<boolean> | boolean,
    now: Date = new Date(),
  ): Promise<{ renewed: number; failed: number }> {
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const due = await this.parentSubRepo.listDueSubscriptions(tomorrow);
    let renewed = 0;
    let failed = 0;
    for (const sub of due) {
      if (!sub.autoRenew || sub.cancelAtPeriodEnd || sub.status !== 'active') continue;
      try {
        const succeeded = await paymentExecutor(sub);
        const result = this.subscription.monthlyRenew({
          subscription: sub,
          paymentOrderId: paymentOrderIdGenerator(sub.parentId),
          paymentSucceeded: succeeded,
          now,
        });
        await this.parentSubRepo.upsertSubscription(result.subscription);
        await this.parentSubRepo.insertPaymentOrder(result.paymentOrder);
        if (succeeded) renewed++;
        else failed++;
      } catch (e) {
        this.logger.warn(
          `[CRON-RENEW] sub=${sub.id} parent=${sub.parentId} failed: ${(e as Error).message}`,
        );
        failed++;
      }
    }
    this.logger.log(`[CRON] monthlyRenewActiveSubscriptionsInDb: ${renewed} 成功, ${failed} 失败`);
    return { renewed, failed };
  }

  /**
   * cron: '0 3 * * *'（每天 03:00 UTC）
   * V22 巡检：created 推荐超 30 天 → expired
   * @param tenantSchemas 当前所有活跃租户的 schema（外部 worker 传入）
   */
  async expirePendingReferrals(tenantSchemas: ReadonlyArray<string>): Promise<{ expired: number }> {
    let total = 0;
    for (const schema of tenantSchemas) {
      try {
        total += await this.referrals.expirePending(schema);
      } catch (e) {
        this.logger.warn(`[CRON-REFERRAL-EXPIRE] schema=${schema} failed: ${(e as Error).message}`);
      }
    }
    if (total > 0) {
      this.logger.log(`[CRON] expirePendingReferrals: ${total} referrals 转 expired`);
    }
    return { expired: total };
  }

  /**
   * cron: '0 2 * * *'（每天 02:00 UTC）
   * V20 巡检：committed 锁定超过 applies_years → expired
   */
  async expirePromotions(now: Date = new Date()): Promise<{ expired: number }> {
    const r = await this.promoQuota.expirePromotions(now);
    if (r.expired > 0) {
      this.logger.log(`[CRON] expirePromotions: ${r.expired} 条 committed → expired`);
    }
    return r;
  }

  /**
   * cron: '*​/10 * * * *' （每 10 分钟）
   * 扫描超期 pending_feedback 课消 → status=locked（老师工资暂不算）
   */
  scanAndLockConsumptions(
    consumptions: ReadonlyArray<CourseConsumption>,
    now: Date = new Date(),
  ): CourseConsumption[] {
    const locked = this.consumption.scanAndLock(consumptions, now);
    this.logger.log(`[CRON] scanAndLockConsumptions: ${locked.length} 条课消已锁定`);
    return locked;
  }

  /**
   * cron: '*​/5 * * * *' （每 5 分钟，等够频繁但不过载）
   * 试用到期：trialing + trial_end_at < now → 转 active（auto_renew=true 时调起 9.9 扣费）
   */
  convertExpiredTrials(
    subscriptions: ReadonlyArray<ParentSubscription>,
    paymentOrderIdGenerator: (sub: ParentSubscription) => string,
    now: Date = new Date(),
  ): Array<{ subscription: ParentSubscription; paymentOrder: ParentPaymentOrder }> {
    const expired = subscriptions.filter(
      (s) =>
        s.status === 'trialing' &&
        s.trialEndAt !== undefined &&
        s.trialEndAt.getTime() < now.getTime() &&
        s.autoRenew &&
        !s.cancelAtPeriodEnd,
    );
    const results = expired.map((sub) =>
      this.subscription.convertTrialToActive({
        subscription: sub,
        paymentOrderId: paymentOrderIdGenerator(sub),
        now,
      }),
    );
    this.logger.log(`[CRON] convertExpiredTrials: ${results.length} 个试用已转 active`);
    return results;
  }

  /**
   * cron: '0 0 * * *' （每天 0 点）
   * 月度自动续费：active + current_period_end <= today 当天 → 调起扣费
   */
  monthlyRenewActiveSubscriptions(
    subscriptions: ReadonlyArray<ParentSubscription>,
    paymentOrderIdGenerator: (sub: ParentSubscription) => string,
    paymentExecutor: (sub: ParentSubscription) => boolean,
    now: Date = new Date(),
  ): Array<{ subscription: ParentSubscription; paymentOrder: ParentPaymentOrder }> {
    const due = subscriptions.filter(
      (s) =>
        s.status === 'active' &&
        s.autoRenew &&
        !s.cancelAtPeriodEnd &&
        s.currentPeriodEnd !== undefined &&
        s.currentPeriodEnd.getTime() < now.getTime() + 24 * 60 * 60 * 1000,
    );
    const results = due.map((sub) =>
      this.subscription.monthlyRenew({
        subscription: sub,
        paymentOrderId: paymentOrderIdGenerator(sub),
        paymentSucceeded: paymentExecutor(sub),
        now,
      }),
    );
    this.logger.log(`[CRON] monthlyRenewActiveSubscriptions: ${results.length} 个续费已处理`);
    return results;
  }

  /**
   * cron: '30 0 1 * *' （每月 1 号 0:30）
   * 月报自动生成：上月所有 (student_id, teacher_id) 组合各生成一份
   */
  generateMonthlyReports(
    studentTeacherFeedbacksMap: ReadonlyArray<{
      studentId: string;
      teacherId: string;
      month: Date;
      feedbacksInMonth: ReadonlyArray<LessonFeedback>;
      reportId: string;
    }>,
  ): MonthlyReport[] {
    const reports = studentTeacherFeedbacksMap.map((entry) =>
      this.report.generate({
        id: entry.reportId,
        studentId: entry.studentId,
        teacherId: entry.teacherId,
        month: entry.month,
        feedbacksInMonth: entry.feedbacksInMonth,
      }),
    );
    this.logger.log(`[CRON] generateMonthlyReports: 生成 ${reports.length} 份月报`);
    return reports;
  }

  /**
   * cron: '30 0 * * *' （每天 0:30）
   * 周期性课表展开：active recurring → 展开未来 N 天到 schedules 实表（幂等 upsert）
   *
   * @param tenantSchema 租户 schema
   * @param activeRecurrings 该租户当前 active 的 recurring schedules
   * @param idGenerator 给每节展开的排课生成 32-char ULID
   */
  async expandRecurringSchedules(
    tenantSchema: string,
    activeRecurrings: ReadonlyArray<RecurringSchedule>,
    idGenerator: () => string,
    rangeDays: number = 30,
    now: Date = new Date(),
  ): Promise<{
    templates: number;
    inserted: number;
    skipped: number;
    perTemplate: Array<{ recurringId: string; inserted: number; skipped: number }>;
  }> {
    const perTemplate: Array<{ recurringId: string; inserted: number; skipped: number }> = [];
    let totalInserted = 0;
    let totalSkipped = 0;
    const active = activeRecurrings.filter((r) => r.status === 'active');

    for (const r of active) {
      const candidates = this.recurring.expandToCandidates(
        r.byDay,
        r.startMinutes,
        r.durationMin,
        r.startDate,
        r.endDate,
        rangeDays,
        now,
      );
      try {
        const result = await this.scheduleRepo.bulkUpsertFromRecurring(
          tenantSchema,
          {
            id: r.id,
            teacherId: r.teacherId,
            studentId: r.studentId,
            durationMin: r.durationMin,
            createdByUserId: r.createdByUserId,
            createdByRole: r.createdByRole,
            courseProductId: r.courseProductId,
          },
          candidates,
          () => idGenerator(),
        );
        perTemplate.push({ recurringId: r.id, ...result });
        totalInserted += result.inserted;
        totalSkipped += result.skipped;
      } catch (e) {
        this.logger.warn(
          `[CRON-EXPAND] recurring=${r.id} schema=${tenantSchema} failed: ${(e as Error).message}`,
        );
        perTemplate.push({ recurringId: r.id, inserted: 0, skipped: 0 });
      }
    }
    this.logger.log(
      `[CRON] expandRecurringSchedules schema=${tenantSchema}: ${active.length} 模板, ` +
        `inserted ${totalInserted} skipped ${totalSkipped}`,
    );
    return {
      templates: active.length,
      inserted: totalInserted,
      skipped: totalSkipped,
      perTemplate,
    };
  }

  /**
   * T9-EPIC(2026-05-16) §4 — trial 14d 到期自动标 expired（数据只读）
   *
   * cron: '30 3 * * *'（每天 03:30 UTC，避开 refresh-token cleanup @ 03:00）
   *
   * 流程（spec §4）：
   *   1. UPDATE trial → expired RETURNING id
   *   2. 逐条写 audit_log 'tenant.subscription.expired'（fail-open 每条独立 try）
   *   3. 整体 fail-open（PG 失败不抛错，pino + Sentry 兜底监控）
   *
   * 与 TenantSubscriptionGuard 关系：
   *   - 03:30 到期当时 → 数据库 expired
   *   - 用户下次 POST 请求 → Guard 查 PG 返 expired → 403
   *   - 03:30 之前到期但还未 cron → Guard 仍放行（漂移 < 3.5h，影响 < 0.1% 用户）
   */
  @Cron('30 3 * * *', { name: 'trial-expiry' })
  async expireOverdueTrials(): Promise<void> {
    if (!this.pg) {
      this.logger.warn('[trial-expiry] PgPoolService not available, skip');
      return;
    }
    try {
      const result = await this.pg.query<{ id: string }>(
        `UPDATE public.tenants
           SET subscription_status='expired'
           WHERE subscription_status='trial'
             AND trial_ends_at IS NOT NULL
             AND trial_ends_at < NOW()
           RETURNING id`,
      );
      this.logger.log(`[trial-expiry] expired ${result.length} tenant(s)`);

      // 2026-06-01 Sprint Y 可观测性：AuditLogRepository @Global 恒注入；
      // undefined 仅错误配线/单测脱钩 → warn 一次（不在 loop 内 warn 防 N 条刷屏）
      if (!this.auditLogRepo && result.length > 0) {
        this.logger.warn(
          `audit log repo not injected, skipping tenant.subscription.expired audit for ${result.length} tenant(s)`,
        );
      }

      // 每条独立 try 写 audit_log；单条失败不中断后续
      for (const row of result) {
        if (!this.auditLogRepo) continue;
        const schema = `tenant_${row.id.toLowerCase()}`;
        try {
          await this.auditLogRepo.log(schema, {
            actorUserId: null,
            actorRole: 'system',
            action: 'tenant.subscription.expired',
            targetType: 'tenant',
            targetId: row.id,
            before: { subscription_status: 'trial' },
            after: { subscription_status: 'expired' },
            ip: null,
            userAgent: null,
            requestId: null,
          });
        } catch (e) {
          this.logger.warn(
            `[trial-expiry] audit_log skip tenant=${row.id}: ${(e as Error).message}`,
          );
        }
      }
    } catch (err) {
      // 整体 fail-open：cron 失败不应导致进程重启（与 refresh-token cleanup 一致）
      this.logger.error(
        `[trial-expiry] failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 标记反馈已读统计 / 老师工资周期等更复杂的 cron 后续可按此模式扩展
}
