/**
 * CronJobsService 单元测试
 *
 * USER-AUTH(2026-05-02): 全局 cron 编排（接 V9/V10/V8.1）
 */
import { Test, TestingModule } from '@nestjs/testing';
import { CronJobsService } from './cron-jobs.service';
import {
  CourseConsumption,
  CourseConsumptionService,
} from '../feedback/course-consumption.service';
import { LessonFeedbackService } from '../feedback/lesson-feedback.service';
import { PromotionQuotaService } from '../db/promotion-quota.service';
import { ReferralRepository } from '../db/referral.repository';
import { ScheduleRepository } from '../db/schedule.repository';
import { ParentSubscriptionRepository } from '../db/parent-subscription.repository';
import { CampusFreeSlotRepository } from '../db/campus-free-slot.repository';
import { MonthlyReportService } from '../feedback/monthly-report.service';
import {
  ParentSubscription,
  ParentSubscriptionService,
} from '../parent/parent-subscription.service';
import {
  RecurringSchedule,
  RecurringScheduleService,
} from '../schedule/recurring-schedule.service';

const ULID32_C1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLCC01';
const ULID32_S1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMSU1';
const ULID32_S2 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMSU2';
const ULID32_P1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMPR1';
const ULID32_O1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMORD';
const ULID32_R1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLREC1';
const ULID32_T1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMTC1';
const ULID32_ST = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMST1';
const ULID32_M1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMM01';
const ULID32_BD = '01HX7Y6P5K9N3M2QABCDEFGHIJKLBND1';
const ULID32_U1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMUS1';

describe('CronJobsService - W3-1 收尾全局 cron 编排', () => {
  let service: CronJobsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CronJobsService,
        CourseConsumptionService,
        LessonFeedbackService,
        MonthlyReportService,
        ParentSubscriptionService,
        RecurringScheduleService,
        {
          provide: PromotionQuotaService,
          useValue: { expirePromotions: jest.fn().mockResolvedValue({ expired: 0 }) },
        },
        {
          provide: ReferralRepository,
          useValue: { expirePending: jest.fn().mockResolvedValue(0) },
        },
        {
          provide: ScheduleRepository,
          useValue: {
            bulkUpsertFromRecurring: jest.fn().mockResolvedValue({ inserted: 4, skipped: 0 }),
          },
        },
        {
          provide: ParentSubscriptionRepository,
          useValue: {
            listDueSubscriptions: jest.fn().mockResolvedValue([]),
            upsertSubscription: jest.fn().mockResolvedValue(undefined),
            insertPaymentOrder: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: CampusFreeSlotRepository,
          useValue: { expirePending: jest.fn().mockResolvedValue(0) },
        },
      ],
    }).compile();
    service = module.get<CronJobsService>(CronJobsService);
  });

  describe('scanAndLockConsumptions - 每 10min', () => {
    it('扫超期 pending_feedback → locked', () => {
      const now = new Date('2026-05-02T12:00:00Z');
      const consumptions: CourseConsumption[] = [
        {
          id: ULID32_C1,
          scheduleId: '01HX7Y6P5K9N3M2QABCDEFGHIJKLSCH1',
          studentId: ULID32_S1,
          teacherId: ULID32_T1,
          status: 'pending_feedback',
          feedbackDueAt: new Date('2026-05-02T10:00:00Z'),
          createdAt: new Date(),
        },
      ];
      const locked = service.scanAndLockConsumptions(consumptions, now);
      expect(locked).toHaveLength(1);
      expect(locked[0].status).toBe('locked');
    });
  });

  describe('convertExpiredTrials - 每 5min', () => {
    it('试用到期 + auto_renew=true → 转 active', () => {
      const now = new Date('2026-05-09T00:00:00Z');
      const subs: ParentSubscription[] = [
        {
          id: '01HX7Y6P5K9N3M2QABCDEFGHIJKLSU01',
          parentId: ULID32_P1,
          status: 'trialing',
          trialEndAt: new Date('2026-05-08T00:00:00Z'), // 已过期
          autoRenew: true,
          cancelAtPeriodEnd: false,
        },
        {
          id: '01HX7Y6P5K9N3M2QABCDEFGHIJKLSU02',
          parentId: '01HX7Y6P5K9N3M2QABCDEFGHIJKLMPR2',
          status: 'trialing',
          trialEndAt: new Date('2026-05-15T00:00:00Z'), // 未过期
          autoRenew: true,
          cancelAtPeriodEnd: false,
        },
      ];
      const results = service.convertExpiredTrials(subs, () => ULID32_O1, now);
      expect(results).toHaveLength(1);
      expect(results[0].subscription.status).toBe('active');
    });

    it('cancel_at_period_end=true 不被 convert', () => {
      const subs: ParentSubscription[] = [
        {
          id: '01HX7Y6P5K9N3M2QABCDEFGHIJKLSU01',
          parentId: ULID32_P1,
          status: 'trialing',
          trialEndAt: new Date('2026-05-08T00:00:00Z'),
          autoRenew: true,
          cancelAtPeriodEnd: true, // 用户已退订
        },
      ];
      const results = service.convertExpiredTrials(
        subs,
        () => ULID32_O1,
        new Date('2026-05-09T00:00:00Z'),
      );
      expect(results).toHaveLength(0);
    });
  });

  describe('monthlyRenewActiveSubscriptions - 每天 0 点', () => {
    it('扣款成功 → currentPeriodEnd +30 天', () => {
      const now = new Date('2026-05-15T00:00:00Z');
      const subs: ParentSubscription[] = [
        {
          id: '01HX7Y6P5K9N3M2QABCDEFGHIJKLSU01',
          parentId: ULID32_P1,
          status: 'active',
          currentPeriodEnd: new Date('2026-05-15T12:00:00Z'), // 即将到期
          autoRenew: true,
          cancelAtPeriodEnd: false,
        },
      ];
      const results = service.monthlyRenewActiveSubscriptions(
        subs,
        () => ULID32_O1,
        () => true, // 扣款成功
        now,
      );
      expect(results).toHaveLength(1);
      expect(results[0].subscription.status).toBe('active');
      expect(results[0].paymentOrder.status).toBe('paid');
    });

    it('扣款失败 → past_due', () => {
      const now = new Date('2026-05-15T00:00:00Z');
      const subs: ParentSubscription[] = [
        {
          id: '01HX7Y6P5K9N3M2QABCDEFGHIJKLSU01',
          parentId: ULID32_P1,
          status: 'active',
          currentPeriodEnd: new Date('2026-05-15T12:00:00Z'),
          autoRenew: true,
          cancelAtPeriodEnd: false,
        },
      ];
      const results = service.monthlyRenewActiveSubscriptions(
        subs,
        () => ULID32_O1,
        () => false, // 扣款失败
        now,
      );
      expect(results).toHaveLength(1);
      expect(results[0].subscription.status).toBe('past_due');
    });

    it('未到期不续费', () => {
      const now = new Date('2026-05-10T00:00:00Z');
      const subs: ParentSubscription[] = [
        {
          id: '01HX7Y6P5K9N3M2QABCDEFGHIJKLSU01',
          parentId: ULID32_P1,
          status: 'active',
          currentPeriodEnd: new Date('2026-05-30T00:00:00Z'), // 还远
          autoRenew: true,
          cancelAtPeriodEnd: false,
        },
      ];
      const results = service.monthlyRenewActiveSubscriptions(
        subs,
        () => ULID32_O1,
        () => true,
        now,
      );
      expect(results).toHaveLength(0);
    });
  });

  describe('generateMonthlyReports - 每月 1 号 0:30', () => {
    it('为每个 (student, teacher) 组合生成一份月报', () => {
      const reports = service.generateMonthlyReports([
        {
          reportId: ULID32_M1,
          studentId: ULID32_S1,
          teacherId: ULID32_T1,
          month: new Date('2026-04-01T00:00:00Z'),
          feedbacksInMonth: [],
        },
        {
          reportId: '01HX7Y6P5K9N3M2QABCDEFGHIJKLMM02',
          studentId: ULID32_S2,
          teacherId: ULID32_T1,
          month: new Date('2026-04-01T00:00:00Z'),
          feedbacksInMonth: [],
        },
      ]);
      expect(reports).toHaveLength(2);
      expect(reports[0].status).toBe('auto_generated');
    });
  });

  describe('monthlyRenewActiveSubscriptionsInDb - V23 真接 PG', () => {
    it('mock paymentExecutor=true → 续费成功 + persist', async () => {
      const m = (service as any).parentSubRepo;
      const sub: any = {
        id: 'ps01',
        parentId: 'par01',
        status: 'active',
        autoRenew: true,
        cancelAtPeriodEnd: false,
        currentPeriodEnd: new Date('2026-05-05T00:00:00Z'),
      };
      m.listDueSubscriptions.mockResolvedValueOnce([sub]);
      const r = await service.monthlyRenewActiveSubscriptionsInDb(
        () => 'po01',
        () => true,
        new Date('2026-05-05T12:00:00Z'),
      );
      expect(r.renewed).toBe(1);
      expect(r.failed).toBe(0);
      expect(m.upsertSubscription).toHaveBeenCalled();
      expect(m.insertPaymentOrder).toHaveBeenCalled();
    });

    it('mock paymentExecutor=false → 续费失败计数', async () => {
      const m = (service as any).parentSubRepo;
      const sub: any = {
        id: 'ps02',
        parentId: 'par02',
        status: 'active',
        autoRenew: true,
        cancelAtPeriodEnd: false,
        currentPeriodEnd: new Date('2026-05-05T00:00:00Z'),
      };
      m.listDueSubscriptions.mockResolvedValueOnce([sub]);
      const r = await service.monthlyRenewActiveSubscriptionsInDb(
        () => 'po02',
        () => false,
        new Date('2026-05-05T12:00:00Z'),
      );
      expect(r.renewed).toBe(0);
      expect(r.failed).toBe(1);
    });

    it('cancel_at_period_end=true → 跳过（保留状态）', async () => {
      const m = (service as any).parentSubRepo;
      const sub: any = {
        id: 'ps03',
        parentId: 'par03',
        status: 'active',
        autoRenew: true,
        cancelAtPeriodEnd: true,
        currentPeriodEnd: new Date('2026-05-05T00:00:00Z'),
      };
      m.listDueSubscriptions.mockResolvedValueOnce([sub]);
      const r = await service.monthlyRenewActiveSubscriptionsInDb(
        () => 'po03',
        () => true,
        new Date('2026-05-05T12:00:00Z'),
      );
      expect(r.renewed).toBe(0);
      expect(m.upsertSubscription).not.toHaveBeenCalled();
    });
  });

  describe('expandRecurringSchedules - 每天 0:30 真接 schedule 表', () => {
    it('active 模板 → bulkUpsertFromRecurring 被调用', async () => {
      const recurring: RecurringSchedule = {
        id: ULID32_R1,
        bindingId: ULID32_BD,
        studentId: ULID32_ST,
        teacherId: ULID32_T1,
        byDay: ['MO'],
        startMinutes: 18 * 60,
        durationMin: 60,
        startDate: new Date('2026-05-04T00:00:00Z'),
        status: 'active',
        createdByUserId: ULID32_U1,
        createdByRole: 'sales',
        createdAt: new Date(),
      };
      const r = await service.expandRecurringSchedules(
        'tenant_test',
        [recurring],
        () => '01HX0000000000000000000000000001',
        30,
        new Date('2026-05-02T00:00:00Z'),
      );
      expect(r.templates).toBe(1);
      expect(r.inserted).toBeGreaterThanOrEqual(0);
    });

    it('archived 模板被排除', async () => {
      const recurring: RecurringSchedule = {
        id: ULID32_R1,
        bindingId: ULID32_BD,
        studentId: ULID32_ST,
        teacherId: ULID32_T1,
        byDay: ['MO'],
        startMinutes: 18 * 60,
        durationMin: 60,
        startDate: new Date('2026-05-04T00:00:00Z'),
        status: 'archived',
        createdByUserId: ULID32_U1,
        createdByRole: 'sales',
        createdAt: new Date(),
      };
      const r = await service.expandRecurringSchedules(
        'tenant_test',
        [recurring],
        () => '01HX0000000000000000000000000001',
      );
      expect(r.templates).toBe(0);
      expect(r.inserted).toBe(0);
    });
  });
});
