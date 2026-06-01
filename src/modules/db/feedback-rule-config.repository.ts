import { Injectable } from '@nestjs/common';
import { PgPoolService, PgRow } from './pg-pool.service';

/**
 * FeedbackRuleConfigRepository — V66 (Phase 5) 反馈提醒规则配置
 *
 * 来源：../edu-mp-sandbox/docs/SSOT-拍板权威.md §5.3.3（2026-06-01 拍板：反馈规则 + 教务反馈页）
 *
 * 表：feedback_rule_config（tenant schema，V66，per campus；独立新表，不复用 campus_assignment_config）
 *   campus_id        PK（public.campuses.id；跨 schema 不加硬 FK，与 V63 campus_assignment_config 同风格）
 *   reminder_days    INT NULL（时间维度阈值；NULL = 不启用此维度）
 *   every_n_lessons  INT NULL（次数维度阈值；NULL = 不启用此维度）
 *   updated_by / updated_at（审计辅助；权威审计在 audit_log V33 = 'feedback-rule.set'）
 *
 * 职责：
 *   - get(): 读规则（无行 → 返 null 由调用方兜默认 null/null = 规则全关 = 空待办列表）
 *   - upsert(): 校长设规则（INSERT ... ON CONFLICT(campus_id) DO UPDATE）；
 *     reminderDays / everyNLessons 各可独立设值或 null（null = 清该维度）。
 *
 * 注：int 范围校验（1-365 / 1-100）在 controller 层做（400 越界），repo 仅落库（信任已校验的入参）。
 */

export interface FeedbackRuleConfig {
  campusId: string;
  reminderDays: number | null;
  everyNLessons: number | null;
  updatedBy: string | null;
  updatedAt: string;
}

@Injectable()
export class FeedbackRuleConfigRepository {
  constructor(private readonly pg: PgPoolService) {}

  private static mapRow(row: PgRow): FeedbackRuleConfig {
    return {
      campusId: row.campus_id,
      reminderDays:
        row.reminder_days === null || row.reminder_days === undefined
          ? null
          : Number(row.reminder_days),
      everyNLessons:
        row.every_n_lessons === null || row.every_n_lessons === undefined
          ? null
          : Number(row.every_n_lessons),
      updatedBy: row.updated_by ?? null,
      updatedAt: row.updated_at
        ? new Date(row.updated_at).toISOString()
        : new Date(0).toISOString(),
    };
  }

  /**
   * 读某校区反馈规则。无行 → null（调用方兜默认 reminderDays=null / everyNLessons=null = 规则全关）。
   */
  async get(
    tenantSchema: string,
    campusId: string,
  ): Promise<FeedbackRuleConfig | null> {
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT campus_id, reminder_days, every_n_lessons, updated_by, updated_at
         FROM feedback_rule_config
        WHERE campus_id = $1`,
      [campusId],
    );
    return rows.length === 0 ? null : FeedbackRuleConfigRepository.mapRow(rows[0]);
  }

  /**
   * 校长设反馈规则（upsert）。
   *   - INSERT 新行（campus_id + 两维度阈值 + updated_by）
   *   - 冲突（同 campus_id 已有行）→ 覆盖两维度 + updated_by/at
   *   - reminderDays / everyNLessons 传 null = 清该维度（不启用）。
   */
  async upsert(
    tenantSchema: string,
    campusId: string,
    reminderDays: number | null,
    everyNLessons: number | null,
    updatedBy: string,
  ): Promise<FeedbackRuleConfig> {
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `INSERT INTO feedback_rule_config
         (campus_id, reminder_days, every_n_lessons, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (campus_id) DO UPDATE
         SET reminder_days = EXCLUDED.reminder_days,
             every_n_lessons = EXCLUDED.every_n_lessons,
             updated_by = EXCLUDED.updated_by,
             updated_at = NOW()
       RETURNING campus_id, reminder_days, every_n_lessons, updated_by, updated_at`,
      [campusId, reminderDays, everyNLessons, updatedBy],
    );
    return FeedbackRuleConfigRepository.mapRow(rows[0]);
  }
}
