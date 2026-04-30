/**
 * LifecycleScheduler 单元测试 — W3-1 Phase 2.3 BE-W3-6
 *
 * PM-AUTH-7(2026-04-30): A10 §2.1 时间轴调度
 *
 * 覆盖：
 *   - dispatch 多 job 顺序处理
 *   - renewal_reminder：active/expiring 触发，frozen/pending_delete 跳过
 *   - freeze：active/expiring → frozen，已 frozen/pending_delete 跳过
 *   - cleanup：frozen → pending_delete，其他状态跳过
 *   - 已 executed/failed 的 job 跳过
 *   - 输入校验（job.id / tenantId）
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { LifecycleScheduler, LifecycleJob } from './lifecycle.scheduler';
import { TenantLifecycleService } from '../tenant/tenant-lifecycle.service';

const ULID32_J = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNOJ';
const ULID32_T = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNOT';

const baseJob = (overrides: Partial<LifecycleJob>): LifecycleJob => ({
  id: ULID32_J,
  tenantId: ULID32_T,
  currentTenantState: 'active',
  jobType: 'renewal_reminder',
  scheduledAt: new Date('2026-11-01T00:00:00Z'),
  status: 'pending',
  retryCount: 0,
  ...overrides,
});

describe('LifecycleScheduler', () => {
  let scheduler: LifecycleScheduler;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [LifecycleScheduler, TenantLifecycleService],
    }).compile();
    scheduler = module.get<LifecycleScheduler>(LifecycleScheduler);
  });

  describe('renewal_reminder - PM-AUTH-7 D-30', () => {
    it('active 租户 → 触发提醒', () => {
      const [action] = scheduler.dispatch([baseJob({ currentTenantState: 'active' })]);
      expect(action.resultStatus).toBe('executed');
      expect(action.sideEffect).toBe('send_renewal_reminder');
      expect(action.shouldTransitTo).toBeNull();
    });

    it('expiring 租户 → 触发提醒', () => {
      const [action] = scheduler.dispatch([baseJob({ currentTenantState: 'expiring' })]);
      expect(action.resultStatus).toBe('executed');
    });

    it('frozen 租户 → 跳过提醒', () => {
      const [action] = scheduler.dispatch([baseJob({ currentTenantState: 'frozen' })]);
      expect(action.resultStatus).toBe('skipped');
    });

    it('pending_delete 租户 → 跳过提醒', () => {
      const [action] = scheduler.dispatch([baseJob({ currentTenantState: 'pending_delete' })]);
      expect(action.resultStatus).toBe('skipped');
    });
  });

  describe('freeze - PM-AUTH-7 D+0', () => {
    it('active → frozen', () => {
      const [action] = scheduler.dispatch([
        baseJob({ jobType: 'freeze', currentTenantState: 'active' }),
      ]);
      expect(action.resultStatus).toBe('executed');
      expect(action.shouldTransitTo).toBe('frozen');
      expect(action.sideEffect).toBe('transit_state');
    });

    it('expiring → frozen', () => {
      const [action] = scheduler.dispatch([
        baseJob({ jobType: 'freeze', currentTenantState: 'expiring' }),
      ]);
      expect(action.resultStatus).toBe('executed');
      expect(action.shouldTransitTo).toBe('frozen');
    });

    it('已 frozen → 跳过', () => {
      const [action] = scheduler.dispatch([
        baseJob({ jobType: 'freeze', currentTenantState: 'frozen' }),
      ]);
      expect(action.resultStatus).toBe('skipped');
    });

    it('已 pending_delete → 跳过', () => {
      const [action] = scheduler.dispatch([
        baseJob({ jobType: 'freeze', currentTenantState: 'pending_delete' }),
      ]);
      expect(action.resultStatus).toBe('skipped');
    });
  });

  describe('cleanup - PM-AUTH-7 D+90', () => {
    it('frozen → pending_delete', () => {
      const [action] = scheduler.dispatch([
        baseJob({ jobType: 'cleanup', currentTenantState: 'frozen' }),
      ]);
      expect(action.resultStatus).toBe('executed');
      expect(action.shouldTransitTo).toBe('pending_delete');
      expect(action.sideEffect).toBe('cleanup_tenant');
    });

    it('active 租户 → 跳过 cleanup（先要冻结）', () => {
      const [action] = scheduler.dispatch([
        baseJob({ jobType: 'cleanup', currentTenantState: 'active' }),
      ]);
      expect(action.resultStatus).toBe('skipped');
    });

    it('expiring 租户 → 跳过 cleanup', () => {
      const [action] = scheduler.dispatch([
        baseJob({ jobType: 'cleanup', currentTenantState: 'expiring' }),
      ]);
      expect(action.resultStatus).toBe('skipped');
    });

    it('已 pending_delete → 跳过', () => {
      const [action] = scheduler.dispatch([
        baseJob({ jobType: 'cleanup', currentTenantState: 'pending_delete' }),
      ]);
      expect(action.resultStatus).toBe('skipped');
    });
  });

  describe('已 executed/failed/skipped 的 job', () => {
    it('status=executed → 跳过', () => {
      const [action] = scheduler.dispatch([baseJob({ status: 'executed' })]);
      expect(action.resultStatus).toBe('skipped');
    });

    it('status=failed → 跳过', () => {
      const [action] = scheduler.dispatch([baseJob({ status: 'failed' })]);
      expect(action.resultStatus).toBe('skipped');
    });
  });

  describe('多 job 派发', () => {
    it('3 jobs 顺序处理 → 3 actions', () => {
      const actions = scheduler.dispatch([
        baseJob({ id: ULID32_J, jobType: 'renewal_reminder', currentTenantState: 'active' }),
        baseJob({
          id: '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNOK',
          jobType: 'freeze',
          currentTenantState: 'expiring',
        }),
        baseJob({
          id: '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNOL',
          jobType: 'cleanup',
          currentTenantState: 'frozen',
        }),
      ]);
      expect(actions).toHaveLength(3);
      expect(actions.map((a) => a.resultStatus)).toEqual(['executed', 'executed', 'executed']);
      expect(actions.map((a) => a.shouldTransitTo)).toEqual([null, 'frozen', 'pending_delete']);
    });
  });

  describe('输入校验', () => {
    it('job.id 长度非 32 → BadRequestException', () => {
      expect(() => scheduler.dispatch([baseJob({ id: 'short' })])).toThrow(BadRequestException);
    });

    it('job.tenantId 长度非 32 → BadRequestException', () => {
      expect(() => scheduler.dispatch([baseJob({ tenantId: 'short' })])).toThrow(
        BadRequestException,
      );
    });

    it('未知 jobType → BadRequestException', () => {
      expect(() => scheduler.dispatch([baseJob({ jobType: 'unknown' as any })])).toThrow(
        BadRequestException,
      );
    });
  });
});
