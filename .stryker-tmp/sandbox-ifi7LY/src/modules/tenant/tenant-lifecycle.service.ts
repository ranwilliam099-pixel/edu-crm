import { Injectable, BadRequestException, ConflictException } from '@nestjs/common';

/**
 * TenantLifecycleService — W3-1 Phase 2.1 BE-W3-2 A10 状态机
 *
 * 来源：
 *   - 《全部人员-审核往来总台账.md》条目 14 §B Track CODE-1 BE-W3-2
 *   - AUTH-7 A10/A11/A12 全部按规约
 *   - A10 §2.1 时间轴：D-30 续费提醒 / D+0 到期冻结 / D+90 清理
 *
 * 4 状态：active / expiring / frozen / pending_delete
 *
 * 合法转换图（PM-AUTH-7）：
 *   active        → expiring     （D-30 进入续费提醒期）
 *   active        → frozen       （平台超管手动冻结，A11 §3.4）
 *   expiring      → active       （已续费续期，D-30~D+0 内）
 *   expiring      → frozen       （D+0 到期未续费）
 *   frozen        → active       （D+0~D+90 内补缴解冻）
 *   frozen        → pending_delete（D+90 冻结期满清理）
 *   pending_delete → 终态（不可恢复，A12 paid 锁原则保留 reverse_orders）
 *
 * 项目隔离（追加 #8）：本服务不引用企业管理系统主项目任何状态机
 */
export type TenantLifecycleState = 'active' | 'expiring' | 'frozen' | 'pending_delete';

@Injectable()
export class TenantLifecycleService {
  static readonly STATES: ReadonlyArray<TenantLifecycleState> = [
    'active',
    'expiring',
    'frozen',
    'pending_delete',
  ];

  static readonly TRANSITIONS: Readonly<
    Record<TenantLifecycleState, ReadonlyArray<TenantLifecycleState>>
  > = {
    active: ['expiring', 'frozen'],
    expiring: ['active', 'frozen'],
    frozen: ['active', 'pending_delete'],
    pending_delete: [], // 终态
  };

  /**
   * 校验状态转换是否合法
   *
   * PM-AUTH-7(2026-04-30): A10 状态机
   *
   * @throws ConflictException 不合法转换
   * @throws BadRequestException 未知状态值
   */
  assertTransition(from: TenantLifecycleState, to: TenantLifecycleState): void {
    if (!TenantLifecycleService.STATES.includes(from)) {
      throw new BadRequestException(`Unknown source state: ${from}`);
    }
    if (!TenantLifecycleService.STATES.includes(to)) {
      throw new BadRequestException(`Unknown target state: ${to}`);
    }
    const allowed = TenantLifecycleService.TRANSITIONS[from];
    if (!allowed.includes(to)) {
      throw new ConflictException(
        `Illegal tenant lifecycle transition: ${from} → ${to} (allowed: [${allowed.join(', ') || 'TERMINAL'}])`,
      );
    }
  }

  /**
   * 终态判定（A10 + A12 paid 锁规则：pending_delete 不可改）
   */
  isTerminal(state: TenantLifecycleState): boolean {
    return TenantLifecycleService.TRANSITIONS[state].length === 0;
  }

  /**
   * 计算 D-30 / D+0 / D+90 时间锚点
   *
   * PM-AUTH-7(2026-04-30): A10 §2.1 时间轴
   *
   * @param expiresAt 订阅到期时间
   * @returns 三个 Date：renewalReminderAt (D-30) / freezeAt (D+0) / cleanupAt (D+90)
   */
  computeLifecycleAnchors(expiresAt: Date): {
    renewalReminderAt: Date;
    freezeAt: Date;
    cleanupAt: Date;
  } {
    if (!(expiresAt instanceof Date) || isNaN(expiresAt.getTime())) {
      throw new BadRequestException(`expiresAt must be a valid Date`);
    }
    const dayMs = 24 * 60 * 60 * 1000;
    return {
      renewalReminderAt: new Date(expiresAt.getTime() - 30 * dayMs),
      freezeAt: new Date(expiresAt.getTime()),
      cleanupAt: new Date(expiresAt.getTime() + 90 * dayMs),
    };
  }

  /**
   * 根据当前时间 + 到期时间推断目标状态（不真实推进，仅计算）
   *
   * PM-AUTH-7(2026-04-30): A10 §2.1 时间轴推断
   *
   * 规则：
   *   - now < expiresAt - 30d  → active
   *   - expiresAt - 30d ≤ now < expiresAt → expiring
   *   - expiresAt ≤ now < expiresAt + 90d → frozen
   *   - now ≥ expiresAt + 90d → pending_delete
   */
  inferStateByTime(expiresAt: Date, now: Date = new Date()): TenantLifecycleState {
    if (!(expiresAt instanceof Date) || isNaN(expiresAt.getTime())) {
      throw new BadRequestException(`expiresAt must be a valid Date`);
    }
    const anchors = this.computeLifecycleAnchors(expiresAt);
    if (now < anchors.renewalReminderAt) return 'active';
    if (now < anchors.freezeAt) return 'expiring';
    if (now < anchors.cleanupAt) return 'frozen';
    return 'pending_delete';
  }
}
