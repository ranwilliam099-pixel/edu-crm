import { Injectable, Logger } from '@nestjs/common';
import { CourseConsumptionService, CourseConsumption } from '../feedback/course-consumption.service';
import { LessonFeedback, LessonFeedbackService } from '../feedback/lesson-feedback.service';
import { MonthlyReportService, MonthlyReport } from '../feedback/monthly-report.service';
import { ParentSubscriptionService, ParentSubscription } from '../parent/parent-subscription.service';
import { RecurringScheduleService, RecurringSchedule } from '../schedule/recurring-schedule.service';

/**
 * CronJobsService — 全局定时任务编排（W3-1 收尾）
 *
 * 来源：
 *   - PD 设计稿 §3.6.4 / §4.2 / §4.3 / §5.5
 *   - 用户拍板条目 31 #4 (7 天试用 + 自动续费) + 条目 32 L 系列
 *
 * 调度时点（cron expression 注释中标明，未来接 @nestjs/schedule 后加 @Cron 装饰器）：
 *   - scan_and_lock_consumptions:    每 10 分钟    '*​/10 * * * *'
 *   - convert_expired_trials:        每 5 分钟     '*​/5 * * * *'
 *   - monthly_renew_active:          每天 0 点     '0 0 * * *'
 *   - generate_monthly_reports:      每月 1 号 0:30 '30 0 1 * *'
 *   - expand_recurring_schedules:    每天 0:30     '30 0 * * *'
 *
 * 当前不引入 @nestjs/schedule（避免新依赖）；外部触发器 / k8s CronJob /
 * 系统 cron 通过 HTTP 调用对应 controller 路由（如 POST /api/course-consumptions/scan-and-lock）。
 *
 * 本 Service 提供**统一编排接口**，方便单元测试 + 未来真接入。
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
  ) {}

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
  ): Array<{ subscription: ParentSubscription; paymentOrder: any }> {
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
  ): Array<{ subscription: ParentSubscription; paymentOrder: any }> {
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
   * 周期性课表展开：active recurring → 展开未来 30 天到 schedules 实表
   *
   * 返回应展开的候选时段；外部按 uniq 索引幂等 upsert
   */
  expandRecurringSchedules(
    activeRecurrings: ReadonlyArray<RecurringSchedule>,
    rangeDays: number = 30,
    now: Date = new Date(),
  ): Array<{ recurringId: string; candidates: Array<{ startAt: Date; endAt: Date }> }> {
    const result = activeRecurrings
      .filter((r) => r.status === 'active')
      .map((r) => ({
        recurringId: r.id,
        candidates: this.recurring.expandToCandidates(
          r.byDay,
          r.startMinutes,
          r.durationMin,
          r.startDate,
          r.endDate,
          rangeDays,
          now,
        ),
      }));
    const totalSlots = result.reduce((sum, r) => sum + r.candidates.length, 0);
    this.logger.log(
      `[CRON] expandRecurringSchedules: ${result.length} 模板，展开 ${totalSlots} 时段`,
    );
    return result;
  }

  // 标记反馈已读统计 / 老师工资周期等更复杂的 cron 后续可按此模式扩展
}
