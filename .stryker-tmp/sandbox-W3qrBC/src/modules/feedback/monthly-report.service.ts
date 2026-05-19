import { Injectable, BadRequestException, Logger, Optional, NotFoundException } from '@nestjs/common';
import { LessonFeedback, ClassroomPerformance } from './lesson-feedback.service';
import { MonthlyReportRepository } from '../db/monthly-report.repository';
import { LessonFeedbackRepository } from '../db/lesson-feedback.repository';
import { ActorRole } from '../db/audit-log.repository';

/**
 * MonthlyReportService — V9 月报 BE-V9-3 + V36 双轨 audience 拓展
 *
 * 来源：
 *   - 《PD设计稿-排课-教学反馈-家长订阅-V1-2026-05-02.md》§4.3
 *   - PD 硬规则 P7（月报自动汇总，cron 每月 1 号 00:30）
 *   - main session 5/11 拍板「方案 B」V36 = 加 5 列复用同一行
 *   - feedback_教培业务架构-2026-05-10.md 全局规则 #3 双轨数据
 *
 * V36 双轨 audience 隔离硬红线：
 *   - audience='teacher'（默认）→ 老师 / academic / boss / admin 视角 → 返回 teacher_blessing + renewal_suggestion
 *   - audience='parent'         → 家长 c 端视角 → 仅返回 parent_* 5 字段，renewal_suggestion 一定遮蔽
 *   - parent role JWT 强制 audience='parent'（自动遮蔽，不抛 403，UX 更佳）
 */
export type MonthlyReportStatus = 'auto_generated' | 'teacher_finalized';

/**
 * V36 视角枚举（双轨 audience 隔离）
 *
 * 用法约定：
 *   - audience='teacher' = 老师 / academic / boss / admin / 内部 KPI 视角
 *     → 返回完整字段（含 teacher_blessing + renewal_suggestion + parent_*）
 *   - audience='parent' = 家长 c 端视角
 *     → 仅返回基础聚合 + parent_* 5 字段（renewal_suggestion 严格遮蔽）
 *
 * 双轨硬红线（Controller / Repository 层守护）：
 *   - SQL SELECT 列表按 audience 切换 → parent 路径根本不查 renewal_suggestion 列
 *   - parent role JWT 强制 audience='parent'（自动遮蔽，UX 更友好）
 */
export type ReportAudience = 'teacher' | 'parent';

export interface AttendanceSummary {
  total: number;
  '出勤': number;
  '迟到': number;
  '缺席': number;
  '请假': number;
}

export interface PerformanceTrendPoint {
  date: string; // YYYY-MM-DD
  performance: ClassroomPerformance;
}

export interface KnowledgeSummaryItem {
  name: string;
  mastery: ClassroomPerformance;
  lessonCount: number;
}

/**
 * V36 家长版进步亮点 — c 端 monthly-report/detail 渲染
 *
 * point  = 短描述（如"基础运算稳定提升"）
 * lessonCount? = 关联课时数（可选，前端用于"X 节课见效"提示）
 */
export interface ParentHighlightItem {
  point: string;
  lessonCount?: number;
}

/**
 * V36 家长版待改进 — c 端只读列表
 *
 * point      = 待改进项（如"应用题审题"）
 * suggestion? = 建设性建议（避免 KPI / 排名 / 工资等敏感词）
 */
export interface ParentImprovementItem {
  point: string;
  suggestion?: string;
}

/**
 * V36 家长版 5 字段扩展（部分可见，未生成时为 undefined）
 *
 * 字段语义对应数据库列（V36 migration §36.1）：
 *   - parentBlessing     ↔ parent_blessing
 *   - parentHighlights   ↔ parent_highlights JSONB
 *   - parentImprovements ↔ parent_improvements JSONB
 *   - parentNextPlan     ↔ parent_next_plan
 *   - parentFinalizedAt  ↔ parent_finalized_at（NULL 表示未生成）
 */
export interface MonthlyReportParentExtras {
  parentBlessing?: string;
  parentHighlights?: ReadonlyArray<ParentHighlightItem>;
  parentImprovements?: ReadonlyArray<ParentImprovementItem>;
  parentNextPlan?: string;
  parentFinalizedAt?: Date;
}

export interface MonthlyReport extends MonthlyReportParentExtras {
  id: string;
  studentId: string;
  teacherId: string;
  month: Date; // YYYY-MM-01
  attendanceSummary: AttendanceSummary;
  performanceTrend: ReadonlyArray<PerformanceTrendPoint>;
  knowledgeSummary: ReadonlyArray<KnowledgeSummaryItem>;
  /** ⚠️ audience='parent' 视角永远是 undefined（SELECT 不查该列） */
  teacherBlessing?: string;
  /** ⚠️ audience='parent' 视角永远是 undefined（双轨硬红线） */
  renewalSuggestion?: string;
  status: MonthlyReportStatus;
  generatedAt: Date;
  finalizedAt?: Date;
  parentReadAt?: Date;
}

/**
 * V36 finalizeParent 入参 — 4 字段（parentFinalizedAt 由 NOW() 自动写）
 */
export interface FinalizeParentPayload {
  parentBlessing: string;
  parentHighlights?: ReadonlyArray<ParentHighlightItem>;
  parentImprovements?: ReadonlyArray<ParentImprovementItem>;
  parentNextPlan?: string;
}

/**
 * V36 audit_log 审计上下文（finalize* 类操作必传 — 让 controller 注入 JWT）
 */
export interface FinalizeAuditContext {
  operatorUserId: string;
  actorRole: ActorRole;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

@Injectable()
export class MonthlyReportService {
  private readonly logger = new Logger(MonthlyReportService.name);

  constructor(
    @Optional() private readonly repo?: MonthlyReportRepository,
    @Optional() private readonly feedbackRepo?: LessonFeedbackRepository,
  ) {}

  /**
   * 月报自动生成（cron 每月 1 号 00:30 调用）
   *
   * @param studentId 学员
   * @param teacherId 主讲老师（同一月内可能多个老师 → 各自生成一份）
   * @param month 月份（YYYY-MM-01）
   * @param feedbacksInMonth 该 student×teacher 当月所有反馈
   */
  generate(input: {
    id: string;
    studentId: string;
    teacherId: string;
    month: Date;
    feedbacksInMonth: ReadonlyArray<LessonFeedback>;
  }): MonthlyReport {
    if (!input.id || input.id.length !== 32) {
      throw new BadRequestException('monthly_report id must be 32-char ULID');
    }
    if (!input.studentId || input.studentId.length !== 32) {
      throw new BadRequestException('studentId must be 32-char ULID');
    }
    if (!input.teacherId || input.teacherId.length !== 32) {
      throw new BadRequestException('teacherId must be 32-char ULID');
    }

    // 出勤汇总
    const attendance: AttendanceSummary = {
      total: input.feedbacksInMonth.length,
      '出勤': 0,
      '迟到': 0,
      '缺席': 0,
      '请假': 0,
    };
    for (const f of input.feedbacksInMonth) {
      attendance[f.attendanceStatus] += 1;
    }

    // 表现趋势（按 submittedAt 排序）
    const trend: PerformanceTrendPoint[] = [...input.feedbacksInMonth]
      .sort((a, b) => a.submittedAt.getTime() - b.submittedAt.getTime())
      .map((f) => ({
        date: f.submittedAt.toISOString().slice(0, 10),
        performance: f.classroomPerformance,
      }));

    // 知识点汇总（去重 by name + 多次取最近 mastery）
    const knowledgeMap = new Map<
      string,
      { mastery: ClassroomPerformance; lessonCount: number; lastDate: Date }
    >();
    for (const f of input.feedbacksInMonth) {
      const points = f.knowledgePoints ?? [];
      for (const p of points) {
        const existing = knowledgeMap.get(p.name);
        if (!existing || f.submittedAt.getTime() > existing.lastDate.getTime()) {
          knowledgeMap.set(p.name, {
            mastery: p.mastery,
            lessonCount: (existing?.lessonCount ?? 0) + 1,
            lastDate: f.submittedAt,
          });
        } else {
          existing.lessonCount += 1;
        }
      }
    }
    const knowledgeSummary: KnowledgeSummaryItem[] = Array.from(knowledgeMap.entries()).map(
      ([name, v]) => ({
        name,
        mastery: v.mastery,
        lessonCount: v.lessonCount,
      }),
    );

    this.logger.log(
      `[BE-V9-3] generateMonthlyReport id=${input.id} student=${input.studentId} ` +
        `teacher=${input.teacherId} month=${input.month.toISOString().slice(0, 7)} ` +
        `feedbacks=${input.feedbacksInMonth.length} attendance=${JSON.stringify(attendance)}`,
    );

    return {
      id: input.id,
      studentId: input.studentId,
      teacherId: input.teacherId,
      month: input.month,
      attendanceSummary: attendance,
      performanceTrend: trend,
      knowledgeSummary,
      status: 'auto_generated',
      generatedAt: new Date(),
    };
  }

  /**
   * 老师补寄语 + 续报建议 + finalize（家长在订阅活跃时可见）
   *
   * @throws BadRequestException 状态非 auto_generated
   */
  finalize(
    report: MonthlyReport,
    input: { teacherBlessing: string; renewalSuggestion: string },
    now: Date = new Date(),
  ): MonthlyReport {
    if (report.status !== 'auto_generated') {
      throw new BadRequestException(
        `only auto_generated can be finalized; got ${report.status}`,
      );
    }
    if (!input.teacherBlessing || input.teacherBlessing.trim().length === 0) {
      throw new BadRequestException('teacherBlessing required');
    }
    if (!input.renewalSuggestion || input.renewalSuggestion.trim().length === 0) {
      throw new BadRequestException('renewalSuggestion required');
    }
    return {
      ...report,
      teacherBlessing: input.teacherBlessing,
      renewalSuggestion: input.renewalSuggestion,
      status: 'teacher_finalized',
      finalizedAt: now,
    };
  }

  /**
   * 家长打"已读"
   */
  markParentRead(report: MonthlyReport, now: Date = new Date()): MonthlyReport {
    if (report.parentReadAt !== undefined) {
      return report; // 幂等
    }
    return { ...report, parentReadAt: now };
  }

  // ============= 真存盘版 =============

  /**
   * 自动生成月报（从 PG 拉本月反馈，UPSERT 月报）
   */
  async generateInDb(
    input: { id: string; studentId: string; teacherId: string; month: Date },
    tenantSchema: string,
  ): Promise<MonthlyReport> {
    if (!this.repo || !this.feedbackRepo) {
      throw new BadRequestException('MonthlyReportRepository or LessonFeedbackRepository not available');
    }
    const monthStart = new Date(input.month.getFullYear(), input.month.getMonth(), 1);
    const monthEnd = new Date(input.month.getFullYear(), input.month.getMonth() + 1, 1);
    const feedbacks = await this.feedbackRepo.listByStudentTeacherInRange(
      tenantSchema,
      input.studentId,
      input.teacherId,
      monthStart,
      monthEnd,
    );
    const memReport = this.generate({ ...input, month: monthStart, feedbacksInMonth: feedbacks });
    return this.repo.insert(tenantSchema, memReport);
  }

  /**
   * 老师视角 finalize — 写 teacher_blessing + renewal_suggestion
   *
   * V36 audit_log: action='monthly-report.finalize-teacher'，记录 teacher_blessing + renewal_suggestion 写入
   *
   * 2026-05-11 修复 (P2): auditCtx 改为必传 (跟 finalizeParentInDb 对齐, audit_log 链路硬红线)
   */
  async finalizeInDb(
    id: string,
    teacherBlessing: string,
    renewalSuggestion: string,
    tenantSchema: string,
    auditCtx: FinalizeAuditContext,
  ): Promise<MonthlyReport> {
    if (!this.repo) throw new BadRequestException('MonthlyReportRepository not available');
    if (!teacherBlessing || teacherBlessing.trim().length === 0) {
      throw new BadRequestException('teacherBlessing required');
    }
    if (!renewalSuggestion || renewalSuggestion.trim().length === 0) {
      throw new BadRequestException('renewalSuggestion required');
    }
    if (!auditCtx?.operatorUserId) {
      throw new BadRequestException(
        'operatorUserId required for finalize-teacher (audit_log chain integrity)',
      );
    }
    return this.repo.finalizeTeacher(
      tenantSchema,
      id,
      teacherBlessing,
      renewalSuggestion,
      auditCtx,
    );
  }

  /**
   * V36 家长视角 finalize — 写 parent_blessing + parent_highlights + parent_improvements
   *                       + parent_next_plan + parent_finalized_at=NOW()
   *
   * 与 finalizeInDb（老师）严格分离：
   *   - 老师可以先 finalize 自己版本（renewal_suggestion 内部续报话术）
   *   - 老师 / academic / admin 再补写家长温柔版（不含 KPI 措辞）
   *   - 两者互不影响 status 字段（finalize-parent 不切 status，只写 parent_finalized_at）
   *
   * 校验：
   *   - parentBlessing required（家长 c 端首要可见字段）
   *   - operator 必传（audit_log 链路完整性）
   *
   * V36 audit_log: action='monthly-report.finalize-parent'，记录 parent_* 5 字段 before/after
   *
   * @throws BadRequestException parentBlessing 缺失 / operator 缺失
   * @throws NotFoundException 记录不存在
   */
  async finalizeParentInDb(
    id: string,
    payload: FinalizeParentPayload,
    tenantSchema: string,
    auditCtx: FinalizeAuditContext,
  ): Promise<MonthlyReport> {
    if (!this.repo) throw new BadRequestException('MonthlyReportRepository not available');
    if (!payload.parentBlessing || payload.parentBlessing.trim().length === 0) {
      throw new BadRequestException('parentBlessing required');
    }
    if (!auditCtx?.operatorUserId) {
      throw new BadRequestException(
        'operatorUserId required for finalize-parent (audit_log chain integrity)',
      );
    }
    return this.repo.finalizeParent(tenantSchema, id, payload, auditCtx);
  }

  /**
   * V36 拓展 — 默认 audience='teacher' 保持向后兼容
   */
  async findInDb(
    id: string,
    tenantSchema: string,
    audience: ReportAudience = 'teacher',
  ): Promise<MonthlyReport> {
    if (!this.repo) throw new BadRequestException('MonthlyReportRepository not available');
    const r = await this.repo.findById(tenantSchema, id, audience);
    if (!r) throw new NotFoundException(`report ${id} not found`);
    return r;
  }

  /**
   * V36 拓展 — 默认 audience='teacher' 保持向后兼容
   */
  async listByStudentInDb(
    studentId: string,
    tenantSchema: string,
    audience: ReportAudience = 'teacher',
  ): Promise<MonthlyReport[]> {
    if (!this.repo) throw new BadRequestException('MonthlyReportRepository not available');
    return this.repo.listByStudent(tenantSchema, studentId, audience);
  }

  async listPendingFinalizeInDb(
    tenantSchema: string,
    teacherId?: string,
  ): Promise<MonthlyReport[]> {
    if (!this.repo) throw new BadRequestException('MonthlyReportRepository not available');
    return this.repo.listPendingFinalize(tenantSchema, teacherId);
  }

  async markParentReadInDb(id: string, tenantSchema: string): Promise<MonthlyReport> {
    if (!this.repo) throw new BadRequestException('MonthlyReportRepository not available');
    return this.repo.markParentRead(tenantSchema, id);
  }
}
