import { Module } from '@nestjs/common';
import { LifecycleScheduler } from './lifecycle.scheduler';
import { TenantModule } from '../tenant/tenant.module';

/**
 * Lifecycle 模块（W3-1 Phase 2.3 BE-W3-6）
 *
 * 来源：
 *   - 《全部人员-审核往来总台账.md》条目 14 §B Track CODE-1 BE-W3-6
 *   - V6__price_table_and_lifecycle_jobs.sql §2 subscription_lifecycle_jobs 表
 *   - AUTH-7 A10 §2.1 时间轴
 *
 * PM-AUTH-7(2026-04-30): A10 状态机调度
 *
 * 暴露 LifecycleScheduler — dispatch(jobs[]) 接收 pending jobs 派发到对应 handler
 * 不暴露 HTTP 路由 — 由 OS-level cron / pm2 / k8s CronJob 触发，调用 dispatch
 */
@Module({
  imports: [TenantModule],
  providers: [LifecycleScheduler],
  exports: [LifecycleScheduler],
})
export class LifecycleModule {}
