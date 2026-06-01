import { Injectable } from '@nestjs/common';
import { PgPoolService, PgRow } from './pg-pool.service';
import {
  FeedbackRuleConfig,
  FeedbackRuleConfigRepository,
} from './feedback-rule-config.repository';
import { ASSIGNMENT_POOL_ROLES } from './student-assignment.service';

/**
 * PendingFeedbackService — V66 (Phase 5) 教务待反馈学员计算
 *
 * 来源：../edu-mp-sandbox/docs/SSOT-拍板权威.md §5.3.3（2026-06-01 拍板：反馈规则 + 教务反馈页）
 *
 * 算「某教务名下」（students.assigned_academic_id = JWT.sub 本人）待反馈学员：
 *   读本校 feedback_rule_config（reminder_days 时间维度 / every_n_lessons 次数维度）→ OR 任一命中即进待办。
 *   - 各维度可单开/双开/全关（NULL=不启用）；**全关 → 空列表**（短路，不查库）。
 *   - 时间维度命中：距学员最后一次 lesson_feedback（MAX(submitted_at)）> N 天；
 *       从未反馈 → 以首次消课 MIN(course_consumptions.created_at) 为基准算天数；
 *       无消课无反馈 → 不命中（未开课不催）。
 *   - 次数维度命中：自上次反馈后消课数（COUNT(cc WHERE created_at > 上次 submitted_at)）≥ N；
 *       从未反馈则全部消课计数。
 *
 * 设计：
 *   - 聚合（last_fb / first_consumption / lessons_since_last）在单条参数化 SQL（per 教务名下学员，本租户）算出；
 *   - OR 规则判定 + reasons 标注在 TS 层显式做（可单测：时间命中/次数命中/OR/全关空/从未反馈 fallback）。
 *   - owner-scope = assigned_academic_id = JWT.sub（controller 透传，service 不自行解 JWT）。
 *   - 表名：消课表 V9 实名 `course_consumptions`（SSOT 简称 consumption）。
 *
 * 投影（每命中学员）：{ studentId, studentName, lastFeedbackAt|null, daysSinceLast|null, lessonsSinceLast, reasons:[] }
 *   reasons ∈ ['overdue_days','overdue_lessons']（OR 命中可同时含两者）。无一级 PII（不返手机号）。
 */

export type PendingReason = 'overdue_days' | 'overdue_lessons';

export interface PendingFeedbackStudent {
  studentId: string;
  studentName: string;
  lastFeedbackAt: string | null;
  daysSinceLast: number | null;
  lessonsSinceLast: number;
  reasons: PendingReason[];
}

/** SQL 聚合中间形态（rule 判定前） */
interface StudentFeedbackAgg {
  studentId: string;
  studentName: string;
  lastFeedbackAt: string | null;
  /** 距基准（最后反馈 or 首次消课）天数；无消课无反馈 → null */
  daysSinceLast: number | null;
  /** 自上次反馈后消课数（从未反馈则全部消课数） */
  lessonsSinceLast: number;
}

@Injectable()
export class PendingFeedbackService {
  constructor(
    private readonly pg: PgPoolService,
    private readonly ruleRepo: FeedbackRuleConfigRepository,
  ) {}

  /**
   * 计算教务（academicId = JWT.sub）名下待反馈学员（按本校 campusId 规则）。
   *   - 规则全关（两维度皆 null）→ 立即空列表（不查库）。
   *   - 否则查名下学员聚合 → TS 层 OR 判定。
   */
  async listPendingForAcademic(
    tenantSchema: string,
    campusId: string,
    academicId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<{ items: PendingFeedbackStudent[] }> {
    const rule = await this.ruleRepo.get(tenantSchema, campusId);
    // 规则全关（无行 或 两维度皆 null）→ 空列表（不催）
    if (!PendingFeedbackService.ruleHasAnyDimension(rule)) {
      return { items: [] };
    }

    const limit = options.limit && options.limit > 0 ? Math.min(options.limit, 200) : 100;
    const offset = options.offset && options.offset > 0 ? options.offset : 0;

    const aggs = await this.aggregateForAcademic(
      tenantSchema,
      academicId,
      limit,
      offset,
    );

    return { items: PendingFeedbackService.assembleItems(aggs, rule!) };
  }

  /**
   * 计算【本校全部教务名下】待反馈学员（教务主管 academic_admin 督导视图，2026-06-02 用户拍板）。
   *   - 规则/OR 判定与 listPendingForAcademic 完全一致，唯 owner-scope = 本校
   *     （assigned_academic_id ∈ 本校教务池，见 aggregateForCampus）而非单个教务 sub。
   *   - 普通教务(academic) 仍走 listPendingForAcademic 本人名下；本方法仅 academic_admin 用。
   *   - 规则全关 → 空列表（短路，不查库）。
   */
  async listPendingForCampus(
    tenantSchema: string,
    campusId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<{ items: PendingFeedbackStudent[] }> {
    const rule = await this.ruleRepo.get(tenantSchema, campusId);
    if (!PendingFeedbackService.ruleHasAnyDimension(rule)) {
      return { items: [] };
    }
    const limit = options.limit && options.limit > 0 ? Math.min(options.limit, 200) : 100;
    const offset = options.offset && options.offset > 0 ? options.offset : 0;
    const aggs = await this.aggregateForCampus(tenantSchema, campusId, limit, offset);
    return { items: PendingFeedbackService.assembleItems(aggs, rule!) };
  }

  /** 聚合行 → 命中学员投影（OR 规则判定，仅 reasons 非空进列表）。academic/academic_admin 共用。 */
  private static assembleItems(
    aggs: StudentFeedbackAgg[],
    rule: FeedbackRuleConfig,
  ): PendingFeedbackStudent[] {
    const items: PendingFeedbackStudent[] = [];
    for (const agg of aggs) {
      const reasons = PendingFeedbackService.evaluateReasons(agg, rule);
      if (reasons.length > 0) {
        items.push({
          studentId: agg.studentId,
          studentName: agg.studentName,
          lastFeedbackAt: agg.lastFeedbackAt,
          daysSinceLast: agg.daysSinceLast,
          lessonsSinceLast: agg.lessonsSinceLast,
          reasons,
        });
      }
    }
    return items;
  }

  /** 规则是否至少启用一个维度（null/无行 = 全关）。 */
  static ruleHasAnyDimension(rule: FeedbackRuleConfig | null): boolean {
    if (!rule) return false;
    return rule.reminderDays !== null || rule.everyNLessons !== null;
  }

  /**
   * OR 规则判定 → 命中原因数组。
   *   - overdue_days：reminderDays 启用 + daysSinceLast 非 null（=学员有过消课/反馈基准）+ > reminderDays。
   *       无消课无反馈（daysSinceLast=null）→ 不命中（未开课不催）。
   *   - overdue_lessons：everyNLessons 启用 + lessonsSinceLast >= everyNLessons。
   */
  static evaluateReasons(
    agg: StudentFeedbackAgg,
    rule: FeedbackRuleConfig,
  ): PendingReason[] {
    const reasons: PendingReason[] = [];
    if (
      rule.reminderDays !== null &&
      agg.daysSinceLast !== null &&
      agg.daysSinceLast > rule.reminderDays
    ) {
      reasons.push('overdue_days');
    }
    if (
      rule.everyNLessons !== null &&
      agg.lessonsSinceLast >= rule.everyNLessons
    ) {
      reasons.push('overdue_lessons');
    }
    return reasons;
  }

  /**
   * 单条参数化 SQL：教务名下（assigned_academic_id=$1）有效学员的反馈聚合。
   *   - last_fb        = MAX(lf.submitted_at)
   *   - first_consume  = MIN(cc.created_at)
   *   - days_since     = 距基准天数（last_fb 优先，否则 first_consume，否则 NULL）
   *       用 EXTRACT(EPOCH FROM NOW() - 基准)/86400 取整天（FLOOR）。
   *   - lessons_since  = 自上次反馈后消课数（last_fb 为 NULL 时全部消课计数；用 FILTER 条件聚合）
   *   排序 days_since DESC NULLS LAST（最久未反馈优先），分页。
   */
  private async aggregateForAcademic(
    tenantSchema: string,
    academicId: string,
    limit: number,
    offset: number,
  ): Promise<StudentFeedbackAgg[]> {
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `WITH lf AS (
         SELECT student_id, MAX(submitted_at) AS last_fb
           FROM lesson_feedbacks
          GROUP BY student_id
       )
       SELECT s.id,
              s.student_name,
              lf.last_fb,
              COUNT(cc.created_at) FILTER (
                WHERE lf.last_fb IS NULL OR cc.created_at > lf.last_fb
              ) AS lessons_since_last,
              CASE
                WHEN lf.last_fb IS NOT NULL
                  THEN FLOOR(EXTRACT(EPOCH FROM (NOW() - lf.last_fb)) / 86400)
                WHEN MIN(cc.created_at) IS NOT NULL
                  THEN FLOOR(EXTRACT(EPOCH FROM (NOW() - MIN(cc.created_at))) / 86400)
                ELSE NULL
              END AS days_since_last
         FROM students s
         LEFT JOIN lf ON lf.student_id = s.id
         LEFT JOIN course_consumptions cc ON cc.student_id = s.id
        WHERE s.deleted_at IS NULL
          AND s.assigned_academic_id = $1
        GROUP BY s.id, s.student_name, lf.last_fb
        ORDER BY days_since_last DESC NULLS LAST, s.id ASC
        LIMIT $2 OFFSET $3`,
      [academicId, limit, offset],
    );

    return rows.map((r) => ({
      studentId: r.id,
      studentName: r.student_name,
      lastFeedbackAt: r.last_fb ? new Date(r.last_fb).toISOString() : null,
      daysSinceLast:
        r.days_since_last === null || r.days_since_last === undefined
          ? null
          : Number(r.days_since_last),
      lessonsSinceLast: Number(r.lessons_since_last ?? 0),
    }));
  }

  /**
   * 本校全部教务名下学员的反馈聚合（academic_admin 督导视图，2026-06-02 拍板）。
   *   owner-scope = assigned_academic_id ∈ 本校教务池（u.campus_id=$1 且 role∈ASSIGNMENT_POOL_ROLES 且未删）。
   *   其余聚合/排序/分页与 aggregateForAcademic 完全一致；students 无 campus_id 列，经 assigned 教务的
   *   campus 反查本校 caseload（assigned_academic_id 仅指向 academic，故等价本校全部教务名下）。
   */
  private async aggregateForCampus(
    tenantSchema: string,
    campusId: string,
    limit: number,
    offset: number,
  ): Promise<StudentFeedbackAgg[]> {
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `WITH lf AS (
         SELECT student_id, MAX(submitted_at) AS last_fb
           FROM lesson_feedbacks
          GROUP BY student_id
       )
       SELECT s.id,
              s.student_name,
              lf.last_fb,
              COUNT(cc.created_at) FILTER (
                WHERE lf.last_fb IS NULL OR cc.created_at > lf.last_fb
              ) AS lessons_since_last,
              CASE
                WHEN lf.last_fb IS NOT NULL
                  THEN FLOOR(EXTRACT(EPOCH FROM (NOW() - lf.last_fb)) / 86400)
                WHEN MIN(cc.created_at) IS NOT NULL
                  THEN FLOOR(EXTRACT(EPOCH FROM (NOW() - MIN(cc.created_at))) / 86400)
                ELSE NULL
              END AS days_since_last
         FROM students s
         LEFT JOIN lf ON lf.student_id = s.id
         LEFT JOIN course_consumptions cc ON cc.student_id = s.id
        WHERE s.deleted_at IS NULL
          AND s.assigned_academic_id IN (
            SELECT u.id FROM users u
             WHERE u.campus_id = $1
               AND u.role = ANY($2::varchar[])
               AND u.deleted_at IS NULL
          )
        GROUP BY s.id, s.student_name, lf.last_fb
        ORDER BY days_since_last DESC NULLS LAST, s.id ASC
        LIMIT $3 OFFSET $4`,
      [campusId, ASSIGNMENT_POOL_ROLES as string[], limit, offset],
    );

    return rows.map((r) => ({
      studentId: r.id,
      studentName: r.student_name,
      lastFeedbackAt: r.last_fb ? new Date(r.last_fb).toISOString() : null,
      daysSinceLast:
        r.days_since_last === null || r.days_since_last === undefined
          ? null
          : Number(r.days_since_last),
      lessonsSinceLast: Number(r.lessons_since_last ?? 0),
    }));
  }
}
