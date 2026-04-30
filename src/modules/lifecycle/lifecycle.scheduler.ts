import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { TenantLifecycleService, TenantLifecycleState } from '../tenant/tenant-lifecycle.service';

/**
 * LifecycleScheduler — W3-1 Phase 2.3 BE-W3-6 续费提醒 / 冻结 / 清理 cron
 *
 * 来源：
 *   - 《全部人员-审核往来总台账.md》条目 14 §B Track CODE-1 BE-W3-6
 *   - V6__price_table_and_lifecycle_jobs.sql §2 subscription_lifecycle_jobs 表
 *   - AUTH-7 A10 §2.1 时间轴：D-30 / D+0 / D+90
 *
 * PM-AUTH-7(2026-04-30): A10 状态机调度
 *
 * 职责：
 *   1. dispatch(jobs[]) — 接收 pending jobs 列表，按 job_type 派发到对应 handler
 *   2. handleRenewalReminder — D-30 续费提醒
 *   3. handleFreeze — D+0 active/expiring → frozen
 *   4. handleCleanup — D+90 frozen → pending_delete
 *
 * 严守边界：
 *   1. 不直接连 DB；jobs 列表由调用方（OrderRepository W3-3 拓展期）查 PG 后传入
 *   2. 不启动定时器（避免单测干扰 + 真实 cron 触发由 OS-level cron / pm2 / k8s CronJob 配置）
 *   3. 输出"应执行的状态推进 + 通知动作"，由调用方真实落到 DB / 邮件 / 短信
 */

export type LifecycleJobType = 'renewal_reminder' | 'freeze' | 'cleanup';

export type LifecycleJobStatus = 'pending' | 'executed' | 'failed' | 'skipped';

export interface LifecycleJob {
  /** job 主键 ULID 32-char */
  id: string;
  /** 32-char ULID 租户 ID */
  tenantId: string;
  /** 当前租户生命周期状态（用于跳过失效 job 的判断）*/
  currentTenantState: TenantLifecycleState;
  jobType: LifecycleJobType;
  scheduledAt: Date;
  status: LifecycleJobStatus;
  retryCount: number;
}

export interface LifecycleAction {
  jobId: string;
  tenantId: string;
  jobType: LifecycleJobType;
  /** 应推进到的目标状态；如果不需要推进（如 reminder 不改状态）则为 null */
  shouldTransitTo: TenantLifecycleState | null;
  /** 应执行的副作用类型（提醒发送 / 状态推进 / 清理） */
  sideEffect: 'send_renewal_reminder' | 'transit_state' | 'cleanup_tenant';
  /** 处理状态（成功/跳过/失败） */
  resultStatus: 'executed' | 'skipped' | 'failed';
  resultMessage: string;
}

@Injectable()
export class LifecycleScheduler {
  private readonly logger = new Logger(LifecycleScheduler.name);

  constructor(private readonly stateService: TenantLifecycleService) {}

  /**
   * 派发 pending jobs 到对应 handler
   *
   * PM-AUTH-7(2026-04-30): A10 §2.1 时间轴调度
   *
   * @param jobs pending jobs 列表（由调用方查 subscription_lifecycle_jobs 表取得）
   * @returns 每个 job 对应的应执行动作
   */
  dispatch(jobs: ReadonlyArray<LifecycleJob>): LifecycleAction[] {
    return jobs.map((job) => this.handleJob(job));
  }

  private handleJob(job: LifecycleJob): LifecycleAction {
    if (!job.id || job.id.length !== 32) {
      throw new BadRequestException(`job.id must be 32-char ULID`);
    }
    if (!job.tenantId || job.tenantId.length !== 32) {
      throw new BadRequestException(`job.tenantId must be 32-char ULID`);
    }
    if (job.status !== 'pending') {
      // 已 executed / failed / skipped 的 job 不再处理
      return this.skip(job, `job.status is ${job.status}, not pending`);
    }

    switch (job.jobType) {
      case 'renewal_reminder':
        return this.handleRenewalReminder(job);
      case 'freeze':
        return this.handleFreeze(job);
      case 'cleanup':
        return this.handleCleanup(job);
      default:
        throw new BadRequestException(`Unknown job.jobType: ${job.jobType}`);
    }
  }

  /**
   * D-30 续费提醒：发提醒，不改状态
   */
  private handleRenewalReminder(job: LifecycleJob): LifecycleAction {
    if (job.currentTenantState !== 'active' && job.currentTenantState !== 'expiring') {
      return this.skip(job, `tenant is ${job.currentTenantState}, no reminder needed`);
    }
    this.logger.log(`[BE-W3-6] renewal_reminder tenantId=${job.tenantId} → send notification`);
    return {
      jobId: job.id,
      tenantId: job.tenantId,
      jobType: 'renewal_reminder',
      shouldTransitTo: null,
      sideEffect: 'send_renewal_reminder',
      resultStatus: 'executed',
      resultMessage: 'renewal reminder dispatched',
    };
  }

  /**
   * D+0 到期冻结：active/expiring → frozen
   */
  private handleFreeze(job: LifecycleJob): LifecycleAction {
    if (job.currentTenantState === 'frozen' || job.currentTenantState === 'pending_delete') {
      return this.skip(job, `tenant already in ${job.currentTenantState}`);
    }
    try {
      this.stateService.assertTransition(job.currentTenantState, 'frozen');
    } catch (err) {
      return {
        jobId: job.id,
        tenantId: job.tenantId,
        jobType: 'freeze',
        shouldTransitTo: null,
        sideEffect: 'transit_state',
        resultStatus: 'failed',
        resultMessage: `transition denied: ${(err as Error).message}`,
      };
    }
    this.logger.log(`[BE-W3-6] freeze tenantId=${job.tenantId} ${job.currentTenantState} → frozen`);
    return {
      jobId: job.id,
      tenantId: job.tenantId,
      jobType: 'freeze',
      shouldTransitTo: 'frozen',
      sideEffect: 'transit_state',
      resultStatus: 'executed',
      resultMessage: 'tenant frozen at D+0',
    };
  }

  /**
   * D+90 冻结期满清理：frozen → pending_delete
   */
  private handleCleanup(job: LifecycleJob): LifecycleAction {
    if (job.currentTenantState !== 'frozen') {
      return this.skip(job, `tenant is ${job.currentTenantState}, cleanup only applies to frozen`);
    }
    try {
      this.stateService.assertTransition('frozen', 'pending_delete');
    } catch (err) {
      return {
        jobId: job.id,
        tenantId: job.tenantId,
        jobType: 'cleanup',
        shouldTransitTo: null,
        sideEffect: 'cleanup_tenant',
        resultStatus: 'failed',
        resultMessage: `transition denied: ${(err as Error).message}`,
      };
    }
    this.logger.log(
      `[BE-W3-6] cleanup tenantId=${job.tenantId} frozen → pending_delete (A12 paid 锁原则保留 reverse_orders)`,
    );
    return {
      jobId: job.id,
      tenantId: job.tenantId,
      jobType: 'cleanup',
      shouldTransitTo: 'pending_delete',
      sideEffect: 'cleanup_tenant',
      resultStatus: 'executed',
      resultMessage: 'tenant marked pending_delete at D+90',
    };
  }

  private skip(job: LifecycleJob, reason: string): LifecycleAction {
    this.logger.warn(`[BE-W3-6] skip jobId=${job.id} type=${job.jobType} — ${reason}`);
    return {
      jobId: job.id,
      tenantId: job.tenantId,
      jobType: job.jobType,
      shouldTransitTo: null,
      sideEffect:
        job.jobType === 'renewal_reminder'
          ? 'send_renewal_reminder'
          : job.jobType === 'freeze'
            ? 'transit_state'
            : 'cleanup_tenant',
      resultStatus: 'skipped',
      resultMessage: reason,
    };
  }
}
