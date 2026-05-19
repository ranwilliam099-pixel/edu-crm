import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PgPoolService, PgRow } from './pg-pool.service';
import {
  MonthlyReport,
  ReportAudience,
  FinalizeParentPayload,
  FinalizeAuditContext,
  ParentHighlightItem,
  ParentImprovementItem,
} from '../feedback/monthly-report.service';
import { AuditLogRepository } from './audit-log.repository';

/**
 * MonthlyReportRepository — V9 月报持久化层（tenant schema）+ V36 双轨 audience 拓展
 *
 * 表：monthly_reports（V9 §4.1 + V36 §36.1 加 5 列 parent_*）
 *   PD 硬规则 P7：cron 每月 1 号 00:30 自动汇总
 *
 * V36 双轨 audience 隔离硬红线（SELECT 列层守护）：
 *   - audience='teacher' (默认) → SELECT 全部字段（teacher_blessing + renewal_suggestion + parent_*）
 *   - audience='parent'        → SELECT 不查 renewal_suggestion 列（SQL 层天然遮蔽）
 *   - 调用方约束：parent role JWT 强制 audience='parent'（Controller 层守护）
 */
@Injectable()
export class MonthlyReportRepository {
  // ========== V36 SELECT 列定义（按 audience 切换） ==========
  /**
   * teacher / internal 视角的完整 SELECT 列（含 renewal_suggestion + parent_*）
   */
  private readonly TEACHER_SELECT_COLUMNS = `
    id, student_id, teacher_id, month, attendance_summary,
    performance_trend, knowledge_summary, teacher_blessing,
    renewal_suggestion, status, generated_at, finalized_at, parent_read_at,
    parent_blessing, parent_highlights, parent_improvements,
    parent_next_plan, parent_finalized_at
  `;

  /**
   * parent c 端视角的 SELECT 列（⚠️ 永不查 renewal_suggestion 列）
   *
   * 保留字段：
   *   - 基础聚合: attendance_summary / performance_trend / knowledge_summary
   *   - 状态时间: status / generated_at / finalized_at / parent_read_at
   *   - 老师寄语: teacher_blessing（可作为家长版的 fallback；renewal_suggestion 严格不查）
   *   - parent_*: 5 列家长版
   */
  private readonly PARENT_SELECT_COLUMNS = `
    id, student_id, teacher_id, month, attendance_summary,
    performance_trend, knowledge_summary, teacher_blessing,
    status, generated_at, finalized_at, parent_read_at,
    parent_blessing, parent_highlights, parent_improvements,
    parent_next_plan, parent_finalized_at
  `;

  constructor(
    private readonly pg: PgPoolService,
    private readonly auditLog: AuditLogRepository,
  ) {}

  /**
   * 选取 SELECT 列（按 audience）
   *
   * 双轨硬红线：parent 视角永不查 renewal_suggestion 列（SQL 层天然遮蔽）
   */
  private selectColumns(audience: ReportAudience): string {
    return audience === 'parent'
      ? this.PARENT_SELECT_COLUMNS
      : this.TEACHER_SELECT_COLUMNS;
  }

  async insert(
    tenantSchema: string,
    report: MonthlyReport,
  ): Promise<MonthlyReport> {
    // insert 返回完整字段（teacher 视角）— cron 写入或 controller 老师 finalize 才会调
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `INSERT INTO monthly_reports (
         id, student_id, teacher_id, month,
         attendance_summary, performance_trend, knowledge_summary,
         teacher_blessing, renewal_suggestion, status, generated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (student_id, month) DO UPDATE SET
         attendance_summary = EXCLUDED.attendance_summary,
         performance_trend = EXCLUDED.performance_trend,
         knowledge_summary = EXCLUDED.knowledge_summary,
         status = EXCLUDED.status,
         generated_at = EXCLUDED.generated_at
       RETURNING ${this.TEACHER_SELECT_COLUMNS}`,
      [
        report.id,
        report.studentId,
        report.teacherId,
        report.month,
        JSON.stringify(report.attendanceSummary),
        JSON.stringify(report.performanceTrend),
        JSON.stringify(report.knowledgeSummary),
        report.teacherBlessing || null,
        report.renewalSuggestion || null,
        report.status,
        report.generatedAt,
      ],
    );
    return this.mapRow(rows[0], 'teacher');
  }

  /**
   * V36 拓展 — 按 audience 切换 SELECT 列
   *
   * audience='parent' → 返回的 MonthlyReport 永远 renewalSuggestion=undefined（SQL 层不查）
   */
  async findById(
    tenantSchema: string,
    id: string,
    audience: ReportAudience = 'teacher',
  ): Promise<MonthlyReport | null> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT ${this.selectColumns(audience)}
       FROM monthly_reports WHERE id = $1`,
      [id],
    );
    return rows.length === 0 ? null : this.mapRow(rows[0], audience);
  }

  /**
   * V36 拓展 — 按 audience 切换 SELECT 列
   */
  async findByStudentMonth(
    tenantSchema: string,
    studentId: string,
    month: Date,
    audience: ReportAudience = 'teacher',
  ): Promise<MonthlyReport | null> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT ${this.selectColumns(audience)}
       FROM monthly_reports
       WHERE student_id = $1 AND month = $2`,
      [studentId, month],
    );
    return rows.length === 0 ? null : this.mapRow(rows[0], audience);
  }

  /**
   * V36 拓展 — 家长视角列表自动遮蔽 renewal_suggestion
   *
   * 家长侧 home 列表 / 历史月报浏览都走此方法（audience='parent'）
   */
  async listByStudent(
    tenantSchema: string,
    studentId: string,
    audience: ReportAudience = 'teacher',
  ): Promise<MonthlyReport[]> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT ${this.selectColumns(audience)}
       FROM monthly_reports
       WHERE student_id = $1
       ORDER BY month DESC`,
      [studentId],
    );
    return rows.map((r) => this.mapRow(r, audience));
  }

  /**
   * 老师 / 校长 / 教务 待办列表 — 老师视角（完整字段）
   */
  async listPendingFinalize(
    tenantSchema: string,
    teacherId?: string,
  ): Promise<MonthlyReport[]> {
    if (teacherId) {
      const rows = await this.pg.tenantQuery<any>(
        tenantSchema,
        `SELECT ${this.TEACHER_SELECT_COLUMNS}
         FROM monthly_reports
         WHERE status = 'auto_generated' AND teacher_id = $1
         ORDER BY generated_at ASC`,
        [teacherId],
      );
      return rows.map((r) => this.mapRow(r, 'teacher'));
    }
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT ${this.TEACHER_SELECT_COLUMNS}
       FROM monthly_reports
       WHERE status = 'auto_generated'
       ORDER BY generated_at ASC`,
    );
    return rows.map((r) => this.mapRow(r, 'teacher'));
  }

  /**
   * 老师视角 finalize — 写 teacher_blessing + renewal_suggestion + status=teacher_finalized
   *
   * V36 重命名：原 finalize() 拆为 finalizeTeacher() / finalizeParent()
   * 行为不变（仍要求 status='auto_generated'）
   *
   * audit_log: action='monthly-report.finalize-teacher'（before=auto_generated 行 / after=finalized 行）
   *
   * 2026-05-11 修复 (P2 audit_log 门控统一):
   *   原 if (auditCtx?.operatorUserId) 软门控 → 改为方法入口强制校验,
   *   跟 finalizeParent 一致 (audit_log 链路完整性硬红线)
   *   调用方必须传 auditCtx (FeedbackController.buildFinalizeAuditCtx 已经传了)
   *
   * @throws NotFoundException 记录不存在或不在 auto_generated 状态
   * @throws BadRequestException operator 缺失 (audit_log 链路完整性)
   */
  async finalizeTeacher(
    tenantSchema: string,
    id: string,
    teacherBlessing: string,
    renewalSuggestion: string,
    auditCtx: FinalizeAuditContext,
  ): Promise<MonthlyReport> {
    // P2 修复: 强制入口校验 audit_log 上下文 (跟 finalizeParent 一致)
    if (!auditCtx?.operatorUserId) {
      throw new BadRequestException(
        'operatorUserId required for finalize-teacher (audit_log chain integrity)',
      );
    }

    // 1. 读 before（用于 audit_log diff；null/不在 auto_generated 状态 → 后面 UPDATE 必失败）
    const before = await this.findById(tenantSchema, id, 'teacher');

    // 2. UPDATE
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `UPDATE monthly_reports
       SET status = 'teacher_finalized',
           teacher_blessing = $1,
           renewal_suggestion = $2,
           finalized_at = NOW()
       WHERE id = $3 AND status = 'auto_generated'
       RETURNING ${this.TEACHER_SELECT_COLUMNS}`,
      [teacherBlessing, renewalSuggestion, id],
    );
    if (rows.length === 0) {
      throw new NotFoundException(`report ${id} not found or not in auto_generated state`);
    }
    const after = this.mapRow(rows[0], 'teacher');

    // 3. audit_log — V36 双轨拓展（不阻塞主流程，AuditLogRepository.log 内部 catch）
    await this.auditLog.log(tenantSchema, {
      actorUserId: auditCtx.operatorUserId,
      actorRole: auditCtx.actorRole,
      action: 'monthly-report.finalize-teacher',
      targetType: 'monthly_report',
      targetId: id,
      before: before ? this.snapshotTeacherForAudit(before) : null,
      after: this.snapshotTeacherForAudit(after),
      ip: auditCtx.ip ?? null,
      userAgent: auditCtx.userAgent ?? null,
      requestId: auditCtx.requestId ?? null,
    });

    return after;
  }

  /**
   * V36 家长视角 finalize — 写 parent_blessing / parent_highlights /
   *   parent_improvements / parent_next_plan + parent_finalized_at=NOW()
   *
   * 与 finalizeTeacher() 严格分离：
   *   - 不切 status 字段（status='auto_generated'/'teacher_finalized' 保持原状）
   *   - 仅写 parent_* 5 字段
   *   - audit_log: action='monthly-report.finalize-parent'
   *
   * audit_log: before/after 都用 snapshotParentForAudit 仅含 parent_* 5 字段（不泄漏内部续报）
   *
   * @throws NotFoundException 记录不存在
   * @throws BadRequestException operator 缺失（audit_log 链路完整性）
   */
  async finalizeParent(
    tenantSchema: string,
    id: string,
    payload: FinalizeParentPayload,
    auditCtx: FinalizeAuditContext,
  ): Promise<MonthlyReport> {
    if (!auditCtx?.operatorUserId) {
      throw new BadRequestException(
        'operatorUserId required for finalize-parent (audit_log chain integrity)',
      );
    }
    if (!payload.parentBlessing || payload.parentBlessing.trim().length === 0) {
      throw new BadRequestException('parentBlessing required');
    }

    // 1. 读 before（用于 audit_log diff；audience='teacher' 拿全字段做对照）
    const before = await this.findById(tenantSchema, id, 'teacher');
    if (!before) {
      throw new NotFoundException(`report ${id} not found`);
    }

    // 2. UPDATE 5 列（不动 status）
    //    JSONB 字段：传 [] 显式清空；undefined → 用 null 让 COALESCE 保留旧值
    const highlightsParam =
      payload.parentHighlights !== undefined
        ? JSON.stringify(payload.parentHighlights)
        : null;
    const improvementsParam =
      payload.parentImprovements !== undefined
        ? JSON.stringify(payload.parentImprovements)
        : null;

    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `UPDATE monthly_reports
       SET parent_blessing     = $1,
           parent_highlights   = COALESCE($2::jsonb, parent_highlights),
           parent_improvements = COALESCE($3::jsonb, parent_improvements),
           parent_next_plan    = COALESCE($4, parent_next_plan),
           parent_finalized_at = NOW()
       WHERE id = $5
       RETURNING ${this.TEACHER_SELECT_COLUMNS}`,
      [
        payload.parentBlessing,
        highlightsParam,
        improvementsParam,
        payload.parentNextPlan ?? null,
        id,
      ],
    );
    if (rows.length === 0) {
      throw new NotFoundException(`report ${id} not found`);
    }
    const after = this.mapRow(rows[0], 'teacher');

    // 3. audit_log — 仅记 parent_* 5 字段 before/after diff
    await this.auditLog.log(tenantSchema, {
      actorUserId: auditCtx.operatorUserId,
      actorRole: auditCtx.actorRole,
      action: 'monthly-report.finalize-parent',
      targetType: 'monthly_report',
      targetId: id,
      before: this.snapshotParentForAudit(before),
      after: this.snapshotParentForAudit(after),
      ip: auditCtx.ip ?? null,
      userAgent: auditCtx.userAgent ?? null,
      requestId: auditCtx.requestId ?? null,
    });

    return after;
  }

  async markParentRead(
    tenantSchema: string,
    id: string,
  ): Promise<MonthlyReport> {
    // V36: markParentRead 高频低敏，不接 audit_log（按拍板）
    //     audience='teacher' 视角返回完整字段（C 端 controller 自行决定要不要遮蔽给前端）
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `UPDATE monthly_reports
       SET parent_read_at = COALESCE(parent_read_at, NOW())
       WHERE id = $1
       RETURNING ${this.TEACHER_SELECT_COLUMNS}`,
      [id],
    );
    if (rows.length === 0) throw new NotFoundException(`report ${id} not found`);
    return this.mapRow(rows[0], 'teacher');
  }

  // ===== helpers =====

  /**
   * V36 mapRow — 按 audience 切换是否暴露 renewal_suggestion
   *
   * 双轨硬红线：audience='parent' 时 renewalSuggestion 强制 undefined
   * （即便 SELECT 漏写也由 mapRow 兜底，双重防护）
   */
  private mapRow(row: PgRow, audience: ReportAudience): MonthlyReport {
    const base: MonthlyReport = {
      id: row.id,
      studentId: row.student_id,
      teacherId: row.teacher_id,
      month: row.month,
      attendanceSummary:
        typeof row.attendance_summary === 'string'
          ? JSON.parse(row.attendance_summary)
          : row.attendance_summary,
      performanceTrend:
        typeof row.performance_trend === 'string'
          ? JSON.parse(row.performance_trend)
          : row.performance_trend,
      knowledgeSummary:
        typeof row.knowledge_summary === 'string'
          ? JSON.parse(row.knowledge_summary)
          : row.knowledge_summary,
      teacherBlessing: row.teacher_blessing || undefined,
      status: row.status,
      generatedAt: row.generated_at,
      finalizedAt: row.finalized_at || undefined,
      parentReadAt: row.parent_read_at || undefined,
      // V36 parent_* 5 字段
      parentBlessing: row.parent_blessing || undefined,
      parentHighlights: this.parseJsonbArray(row.parent_highlights) as ParentHighlightItem[],
      parentImprovements: this.parseJsonbArray(row.parent_improvements) as ParentImprovementItem[],
      parentNextPlan: row.parent_next_plan || undefined,
      parentFinalizedAt: row.parent_finalized_at || undefined,
    };

    // 双轨硬红线：parent audience 路径强制遮蔽 renewal_suggestion
    //   - SELECT 已不查列（PARENT_SELECT_COLUMNS） → row.renewal_suggestion 不存在
    //   - mapRow 这里再兜底：哪怕 SELECT 写错也强制不暴露
    if (audience !== 'parent') {
      base.renewalSuggestion = row.renewal_suggestion || undefined;
    }
    // audience='parent' → renewalSuggestion 保持 undefined（不挂到对象上）

    return base;
  }

  /**
   * V36 audit_log snapshot — teacher 视角全字段（含 renewal_suggestion）
   */
  private snapshotTeacherForAudit(report: MonthlyReport): Record<string, unknown> {
    return {
      status: report.status,
      teacherBlessing: report.teacherBlessing ?? null,
      renewalSuggestion: report.renewalSuggestion ?? null,
      finalizedAt: report.finalizedAt ?? null,
      // 不冗余 attendance / performance / knowledge（这些来自 cron 自动汇总，finalize 不动）
    };
  }

  /**
   * V36 audit_log snapshot — parent 5 字段（不泄漏内部 renewal_suggestion）
   */
  private snapshotParentForAudit(report: MonthlyReport): Record<string, unknown> {
    return {
      parentBlessing: report.parentBlessing ?? null,
      parentHighlights: report.parentHighlights ?? null,
      parentImprovements: report.parentImprovements ?? null,
      parentNextPlan: report.parentNextPlan ?? null,
      parentFinalizedAt: report.parentFinalizedAt ?? null,
    };
  }

  /**
   * pg 驱动可能把 JSONB 列返回为：
   *   - 已解析的 array（默认 pg.types parser）
   *   - 字符串（特定 pool 配置 / 客户端 mock）
   *   - null（V36 之前的旧行 / 未写过 parent_*）
   * 都归一化为 array；null/缺失 → []
   *
   * 注：返回 [] 而非 undefined，前端可直接 .map 不需判 null
   *     但 service.MonthlyReport 接口 parentHighlights 仍 optional，前端语义不变
   */
  private parseJsonbArray(raw: unknown): unknown[] {
    if (raw === null || raw === undefined) return [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  }
}
