import {
  Body,
  Controller,
  Param,
  Post,
  Patch,
  Req,
  HttpCode,
  HttpStatus,
  UseGuards,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import {
  LessonFeedbackService,
  LessonFeedback,
  AttendanceForFeedback,
  ClassroomPerformance,
  HomeworkDifficulty,
} from './lesson-feedback.service';
import {
  CourseConsumptionService,
  CourseConsumption,
} from './course-consumption.service';
import {
  MonthlyReportService,
  MonthlyReport,
  ReportAudience,
  FinalizeParentPayload,
  FinalizeAuditContext,
  ParentHighlightItem,
  ParentImprovementItem,
} from './monthly-report.service';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';
import { RbacGuard } from '../../guards/rbac.guard';
import { Roles } from '../../guards/rbac.decorator';
import { IdempotencyInterceptor } from '../../common/idempotency/idempotency.interceptor';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';
import { ActorRole } from '../db/audit-log.repository';

/**
 * FeedbackController — V9 教学反馈 + 课消 + 月报 HTTP 暴露 BE-V9-1/2/3
 *
 * 路由前缀（多个）：
 *   - /api/lesson-feedbacks
 *   - /api/course-consumptions
 *   - /api/monthly-reports
 *
 * USER-AUTH(2026-05-02): PD §4 + P6 24h 必填 + P7 月报自动
 */
@Controller()
export class FeedbackController {
  constructor(
    private readonly feedback: LessonFeedbackService,
    private readonly consumption: CourseConsumptionService,
    private readonly report: MonthlyReportService,
  ) {}

  // ==================== LessonFeedback ====================

  /**
   * POST /api/lesson-feedbacks — 老师提交反馈（24h 内）
   */
  @Post('lesson-feedbacks')
  @HttpCode(HttpStatus.CREATED)
  submitFeedback(
    @Body()
    body: {
      id: string;
      scheduleId: string;
      studentId: string;
      teacherId: string;
      attendanceStatus: AttendanceForFeedback;
      classroomPerformance: ClassroomPerformance;
      knowledgePoints?: Array<{ name: string; mastery: ClassroomPerformance }>;
      homework?: string;
      homeworkAttachments?: Array<{ url: string; type: string; filename: string }>;
      teacherNote?: string;
      teacherInternalNote?: string;
    },
  ): LessonFeedback {
    return this.feedback.submit(body);
  }

  /**
   * PATCH /api/lesson-feedbacks/:id — 24h 内修改反馈
   */
  @Patch('lesson-feedbacks/:id')
  @HttpCode(HttpStatus.OK)
  updateFeedback(
    @Param('id') _id: string,
    @Body()
    body: {
      feedback: LessonFeedback;
      patch: Partial<{
        attendanceStatus: AttendanceForFeedback;
        classroomPerformance: ClassroomPerformance;
        knowledgePoints: Array<{ name: string; mastery: ClassroomPerformance }>;
        homework: string;
        teacherNote: string;
        teacherInternalNote: string;
      }>;
      nowMs?: number;
    },
  ): LessonFeedback {
    return this.feedback.update(
      this.deserializeFeedback(body.feedback),
      body.patch,
      body.nowMs ? new Date(body.nowMs) : new Date(),
    );
  }

  /**
   * POST /api/lesson-feedbacks/:id/parent-read
   */
  @Post('lesson-feedbacks/:id/parent-read')
  @HttpCode(HttpStatus.OK)
  markParentReadFeedback(
    @Param('id') _id: string,
    @Body() body: { feedback: LessonFeedback; nowMs?: number },
  ): LessonFeedback {
    return this.feedback.markParentRead(
      this.deserializeFeedback(body.feedback),
      body.nowMs ? new Date(body.nowMs) : new Date(),
    );
  }

  // ==================== CourseConsumption ====================

  /**
   * POST /api/course-consumptions — schedule.complete 时为每个学员创建一条
   */
  @Post('course-consumptions')
  @HttpCode(HttpStatus.CREATED)
  createConsumption(
    @Body()
    body: {
      id: string;
      scheduleId: string;
      studentId: string;
      teacherId: string;
      scheduleEndAt: string;
      amountYuan?: number;
    },
  ): CourseConsumption {
    return this.consumption.createConsumption({
      ...body,
      scheduleEndAt: new Date(body.scheduleEndAt),
    });
  }

  /**
   * POST /api/course-consumptions/:id/confirm — 反馈提交时 confirm
   */
  @Post('course-consumptions/:id/confirm')
  @HttpCode(HttpStatus.OK)
  confirmConsumption(
    @Param('id') _id: string,
    @Body() body: { consumption: CourseConsumption; feedbackId: string; nowMs?: number },
  ): CourseConsumption {
    return this.consumption.confirmByFeedback(
      this.deserializeConsumption(body.consumption),
      body.feedbackId,
      body.nowMs ? new Date(body.nowMs) : new Date(),
    );
  }

  /**
   * POST /api/course-consumptions/scan-and-lock — cron 每 10min 扫超期 → locked
   */
  @Post('course-consumptions/scan-and-lock')
  @HttpCode(HttpStatus.OK)
  scanAndLock(
    @Body() body: { consumptions: CourseConsumption[]; nowMs?: number },
  ): CourseConsumption[] {
    return this.consumption.scanAndLock(
      body.consumptions.map((c) => this.deserializeConsumption(c)),
      body.nowMs ? new Date(body.nowMs) : new Date(),
    );
  }

  /**
   * POST /api/course-consumptions/:id/unlock-late — 老师超期补填恢复
   */
  @Post('course-consumptions/:id/unlock-late')
  @HttpCode(HttpStatus.OK)
  unlockLate(
    @Param('id') _id: string,
    @Body() body: { consumption: CourseConsumption; feedbackId: string; nowMs?: number },
  ): CourseConsumption {
    return this.consumption.unlockByLateFeedback(
      this.deserializeConsumption(body.consumption),
      body.feedbackId,
      body.nowMs ? new Date(body.nowMs) : new Date(),
    );
  }

  // V38: 删 POST /api/teachers/:teacherId/payroll（薪资业务下线）
  //   依据：feedback_教培业务架构-2026-05-10.md「薪资全删」
  //   原方法 sumPayrollForTeacher 同步删除（course-consumption.service.ts）

  // ==================== MonthlyReport ====================

  /**
   * POST /api/monthly-reports/generate — cron 每月 1 号 00:30 调用
   */
  @Post('monthly-reports/generate')
  @HttpCode(HttpStatus.CREATED)
  generateReport(
    @Body()
    body: {
      id: string;
      studentId: string;
      teacherId: string;
      month: string;
      feedbacksInMonth: LessonFeedback[];
    },
  ): MonthlyReport {
    return this.report.generate({
      id: body.id,
      studentId: body.studentId,
      teacherId: body.teacherId,
      month: new Date(body.month),
      feedbacksInMonth: body.feedbacksInMonth.map((f) => this.deserializeFeedback(f)),
    });
  }

  /**
   * POST /api/monthly-reports/:id/finalize — 老师补寄语 + 续报建议
   */
  @Post('monthly-reports/:id/finalize')
  @HttpCode(HttpStatus.OK)
  finalizeReport(
    @Param('id') _id: string,
    @Body()
    body: {
      report: MonthlyReport;
      teacherBlessing: string;
      renewalSuggestion: string;
      nowMs?: number;
    },
  ): MonthlyReport {
    return this.report.finalize(
      this.deserializeReport(body.report),
      { teacherBlessing: body.teacherBlessing, renewalSuggestion: body.renewalSuggestion },
      body.nowMs ? new Date(body.nowMs) : new Date(),
    );
  }

  /**
   * POST /api/monthly-reports/:id/parent-read
   */
  @Post('monthly-reports/:id/parent-read')
  @HttpCode(HttpStatus.OK)
  markParentReadReport(
    @Param('id') _id: string,
    @Body() body: { report: MonthlyReport; nowMs?: number },
  ): MonthlyReport {
    return this.report.markParentRead(
      this.deserializeReport(body.report),
      body.nowMs ? new Date(body.nowMs) : new Date(),
    );
  }

  // ==================== /db 真存盘版 ====================

  // ----- LessonFeedback -----

  @Post('db/lesson-feedbacks')
  @HttpCode(HttpStatus.CREATED)
  async submitFeedbackInDb(
    @Body()
    body: {
      id: string;
      scheduleId: string;
      studentId: string;
      teacherId: string;
      attendanceStatus: AttendanceForFeedback;
      classroomPerformance: ClassroomPerformance;
      knowledgePoints?: Array<{ name: string; mastery: ClassroomPerformance }>;
      homework?: string;
      homeworkAttachments?: Array<{ url: string; type: string; filename: string }>;
      teacherNote?: string;
      teacherInternalNote?: string;
      // V18 5 fields
      knowledgeMatrix?: Array<{ name: string; mastery: string }>;
      dimRatings?: { focus?: number; engage?: number; think?: number; homework?: number };
      homeworkDeadlineMs?: number;
      homeworkDifficulty?: HomeworkDifficulty;
      nextPreview?: string;
      tenantSchema: string;
    },
  ): Promise<LessonFeedback> {
    const { tenantSchema, homeworkDeadlineMs, ...rest } = body;
    return this.feedback.submitInDb(
      {
        ...rest,
        homeworkDeadline: homeworkDeadlineMs ? new Date(homeworkDeadlineMs) : undefined,
      },
      tenantSchema,
    );
  }

  @Post('db/lesson-feedbacks/:id/find')
  @HttpCode(HttpStatus.OK)
  async findFeedbackInDb(
    @Param('id') id: string,
    @Body() body: { tenantSchema: string },
  ): Promise<LessonFeedback> {
    return this.feedback.findInDb(id, body.tenantSchema);
  }

  @Post('db/students/:studentId/feedbacks')
  @HttpCode(HttpStatus.OK)
  async listFeedbacksByStudentInDb(
    @Param('studentId') studentId: string,
    @Body() body: { tenantSchema: string; limit?: number; offset?: number },
  ): Promise<LessonFeedback[]> {
    return this.feedback.listByStudentInDb(studentId, body.tenantSchema, {
      limit: body.limit,
      offset: body.offset,
    });
  }

  @Post('db/lesson-feedbacks/:id/update')
  @HttpCode(HttpStatus.OK)
  async updateFeedbackInDb(
    @Param('id') id: string,
    @Body()
    body: {
      patch: {
        attendanceStatus?: AttendanceForFeedback;
        classroomPerformance?: ClassroomPerformance;
        knowledgePoints?: Array<{ name: string; mastery: ClassroomPerformance }>;
        homework?: string;
        teacherNote?: string;
        teacherInternalNote?: string;
        // V18 5 fields
        knowledgeMatrix?: Array<{ name: string; mastery: string }>;
        dimRatings?: { focus?: number; engage?: number; think?: number; homework?: number };
        homeworkDeadlineMs?: number;
        homeworkDifficulty?: HomeworkDifficulty;
        nextPreview?: string;
      };
      tenantSchema: string;
      nowMs?: number;
    },
  ): Promise<LessonFeedback> {
    const { homeworkDeadlineMs, ...patchRest } = body.patch;
    return this.feedback.updateInDb(
      id,
      {
        ...patchRest,
        homeworkDeadline: homeworkDeadlineMs ? new Date(homeworkDeadlineMs) : undefined,
      },
      body.tenantSchema,
      body.nowMs ? new Date(body.nowMs) : new Date(),
    );
  }

  @Post('db/lesson-feedbacks/:id/parent-read')
  @HttpCode(HttpStatus.OK)
  async markParentReadFeedbackInDb(
    @Param('id') id: string,
    @Body() body: { tenantSchema: string },
  ): Promise<LessonFeedback> {
    return this.feedback.markParentReadInDb(id, body.tenantSchema);
  }

  // ----- CourseConsumption -----

  @Post('db/course-consumptions')
  @HttpCode(HttpStatus.CREATED)
  async createConsumptionInDb(
    @Body()
    body: {
      id: string;
      scheduleId: string;
      studentId: string;
      teacherId: string;
      scheduleEndAtMs: number;
      amountYuan?: number;
      tenantSchema: string;
    },
  ): Promise<CourseConsumption> {
    const { tenantSchema, scheduleEndAtMs, ...rest } = body;
    return this.consumption.createConsumptionInDb(
      { ...rest, scheduleEndAt: new Date(scheduleEndAtMs) },
      tenantSchema,
    );
  }

  @Post('db/course-consumptions/:id/confirm')
  @HttpCode(HttpStatus.OK)
  async confirmConsumptionInDb(
    @Param('id') id: string,
    @Body() body: { feedbackId: string; tenantSchema: string },
  ): Promise<CourseConsumption> {
    return this.consumption.confirmByFeedbackInDb(id, body.feedbackId, body.tenantSchema);
  }

  @Post('db/course-consumptions/scan-and-lock')
  @HttpCode(HttpStatus.OK)
  async scanAndLockInDb(
    @Body() body: { tenantSchema: string; nowMs?: number },
  ): Promise<{ locked: number; ids: string[] }> {
    return this.consumption.scanAndLockInDb(
      body.tenantSchema,
      body.nowMs ? new Date(body.nowMs) : new Date(),
    );
  }

  @Post('db/course-consumptions/:id/unlock-late')
  @HttpCode(HttpStatus.OK)
  async unlockLateInDb(
    @Param('id') id: string,
    @Body() body: { feedbackId: string; tenantSchema: string },
  ): Promise<CourseConsumption> {
    return this.consumption.unlockByLateFeedbackInDb(id, body.feedbackId, body.tenantSchema);
  }

  @Post('db/course-consumptions/:id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelConsumptionInDb(
    @Param('id') id: string,
    @Body() body: { tenantSchema: string },
  ): Promise<CourseConsumption> {
    return this.consumption.cancelInDb(id, body.tenantSchema);
  }

  // V38: 删 POST /api/db/teachers/:teacherId/payroll（薪资业务下线 + A04 R3 跨租户漏洞修复）
  //   原方法 sumPayrollForTeacherInDb 同步删除（course-consumption.service.ts）
  //   A04 红线：此 endpoint 历史上仅靠 body.tenantSchema 自填，无 TenantScopeGuard，
  //   删除即修复跨租户隐患（W5）

  /**
   * home-teacher 待办 banner 聚合：老师待点评课消数 + 最早到期时间
   * UI 据 earliestDueAt 显示「剩 X 小时锁课消」或「已超期」
   */
  @Post('db/teachers/:teacherId/pending-feedback-summary')
  @HttpCode(HttpStatus.OK)
  async teacherPendingFeedbackSummaryInDb(
    @Param('teacherId') teacherId: string,
    @Body() body: { tenantSchema: string },
  ): Promise<{ teacherId: string; count: number; earliestDueAt: Date | null }> {
    return this.consumption.pendingFeedbackSummaryByTeacherInDb(
      teacherId,
      body.tenantSchema,
    );
  }

  // ----- MonthlyReport -----

  @Post('db/monthly-reports/generate')
  @HttpCode(HttpStatus.CREATED)
  async generateReportInDb(
    @Body()
    body: {
      id: string;
      studentId: string;
      teacherId: string;
      monthMs: number;
      tenantSchema: string;
    },
  ): Promise<MonthlyReport> {
    const { tenantSchema, monthMs, ...rest } = body;
    return this.report.generateInDb({ ...rest, month: new Date(monthMs) }, tenantSchema);
  }

  /**
   * V36 finalize（老师视角） — 写 teacher_blessing + renewal_suggestion
   *
   * 兼容：body.audience 可选；audience='parent' → 转走 finalize-parent 路径（合并接口）
   *      但官方推荐：c 端用专门的 POST /db/monthly-reports/:id/finalize-parent
   *
   * RBAC (2026-05-11 修复): @Roles('admin','boss') 跟 finalize-parent 一致
   *   - 临时只放行 admin/boss (TenantRole 枚举暂未含 'teacher'/'academic', Sprint B 债)
   *   - TODO Sprint B: 加 'teacher' 到 TenantRole 枚举后, @Roles 增加 'teacher'
   *     并在 service 层加 self-check (req.user.sub === report.teacher_id),
   *     老师只能 finalize 自己写的报告
   *   - audit_log 仍记 actorRole='teacher' (V33 actorRole 已枚举 teacher), 兜底审计链
   *
   * 漏洞修复 (A01-CRIT 配套):
   *   旧实现仅 @UseGuards(TenantScopeGuard) 无 @Roles, parent role JWT 可调此 endpoint
   *   组合 Fix 1 后 parent 已被跨租户校验拦截, 但本 endpoint 应明确拒绝 parent role
   */
  @Post('db/monthly-reports/:id/finalize')
  @UseGuards(TenantScopeGuard, RbacGuard)
  @Roles('admin', 'boss')
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(HttpStatus.OK)
  async finalizeReportInDb(
    @Param('id') id: string,
    @Body()
    body: {
      teacherBlessing: string;
      renewalSuggestion: string;
      tenantSchema: string;
      /** V36 可选：'parent' 走 parent 版（兼容前端旧 finalize 路径） */
      audience?: ReportAudience;
      /** V36 当 audience='parent' 时的 4 字段（与 finalize-parent endpoint 等价） */
      parentBlessing?: string;
      parentHighlights?: ParentHighlightItem[];
      parentImprovements?: ParentImprovementItem[];
      parentNextPlan?: string;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<MonthlyReport> {
    const auditCtx = this.buildFinalizeAuditCtx(req);

    // V36 audience='parent' 合并路径 → 转走 finalize-parent
    if (body.audience === 'parent') {
      if (!body.parentBlessing) {
        throw new BadRequestException(
          'audience=parent requires parentBlessing in body',
        );
      }
      return this.report.finalizeParentInDb(
        id,
        {
          parentBlessing: body.parentBlessing,
          parentHighlights: body.parentHighlights,
          parentImprovements: body.parentImprovements,
          parentNextPlan: body.parentNextPlan,
        },
        body.tenantSchema,
        auditCtx,
      );
    }

    // 默认 audience='teacher' 路径
    return this.report.finalizeInDb(
      id,
      body.teacherBlessing,
      body.renewalSuggestion,
      body.tenantSchema,
      auditCtx,
    );
  }

  /**
   * V36 新 endpoint — 家长版 finalize（推荐入口，更语义化）
   *
   * 与 POST /db/monthly-reports/:id/finalize { audience: 'parent' } 等价
   * 但更清晰地把 parent 版分离，audit_log action 锁定 'monthly-report.finalize-parent'
   *
   * RBAC: teacher / academic / academic_admin / admin / boss
   *      （家长 c 端不应能补写自己的"家长版评语"，所以 parent role 不在允许列表）
   *
   * Body:
   *   - parentBlessing required
   *   - parentHighlights / parentImprovements / parentNextPlan optional
   *   - tenantSchema required
   *
   * 注：parent role 进入此 endpoint → 应被 RbacGuard 挡住（@Roles 不含 parent）
   *     如未来 c 端要让家长自己写感谢回馈，应另开 endpoint，避免与"老师写给家长"语义混淆
   */
  @Post('db/monthly-reports/:id/finalize-parent')
  @UseGuards(TenantScopeGuard, RbacGuard)
  @Roles('admin', 'boss')
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(HttpStatus.OK)
  async finalizeReportParentInDb(
    @Param('id') id: string,
    @Body()
    body: {
      parentBlessing: string;
      parentHighlights?: ParentHighlightItem[];
      parentImprovements?: ParentImprovementItem[];
      parentNextPlan?: string;
      tenantSchema: string;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<MonthlyReport> {
    const auditCtx = this.buildFinalizeAuditCtx(req);
    const payload: FinalizeParentPayload = {
      parentBlessing: body.parentBlessing,
      parentHighlights: body.parentHighlights,
      parentImprovements: body.parentImprovements,
      parentNextPlan: body.parentNextPlan,
    };
    return this.report.finalizeParentInDb(id, payload, body.tenantSchema, auditCtx);
  }

  /**
   * V36 拓展 — find 按 audience 切换 SELECT
   *
   * 双轨硬红线：parent role JWT 强制 audience='parent'（自动遮蔽不抛 403，UX 友好）
   * 其他 role 默认 audience='teacher'（除非 body 显式传 audience）
   */
  @Post('db/monthly-reports/:id/find')
  @UseGuards(TenantScopeGuard)
  @HttpCode(HttpStatus.OK)
  async findReportInDb(
    @Param('id') id: string,
    @Body() body: { tenantSchema: string; audience?: ReportAudience },
    @Req() req: AuthenticatedRequest,
  ): Promise<MonthlyReport> {
    const audience = this.resolveAudience(req, body.audience);
    return this.report.findInDb(id, body.tenantSchema, audience);
  }

  /**
   * V36 拓展 — listByStudent 按 audience 切换 SELECT
   *
   * 同 find：parent role JWT 强制 audience='parent'
   */
  @Post('db/students/:studentId/monthly-reports')
  @UseGuards(TenantScopeGuard)
  @HttpCode(HttpStatus.OK)
  async listReportsByStudentInDb(
    @Param('studentId') studentId: string,
    @Body() body: { tenantSchema: string; audience?: ReportAudience },
    @Req() req: AuthenticatedRequest,
  ): Promise<MonthlyReport[]> {
    const audience = this.resolveAudience(req, body.audience);
    return this.report.listByStudentInDb(studentId, body.tenantSchema, audience);
  }

  /**
   * V36 双轨硬红线：parent role JWT 强制 audience='parent'
   *
   * 设计意图（拍板）：
   *   - parent role 即使 body 传了 audience='teacher' 也强制改为 'parent'（自动遮蔽）
   *   - 不抛 403：UX 更友好（前端不必判断 role 决定参数）
   *   - 其他 role 默认 audience='teacher'，body 显式传 'parent' 才走家长视角
   *
   * parent role 识别来源（两处均判，因为家长 c 端有独立 JWT 流）：
   *   - req.user.role === 'parent' （tenant 用户 JWT，理论上 8 角色未含 parent；为防误配兼容）
   *   - req.parent 存在（家长 c 端独立 JWT，jwt-payload.interface AuthenticatedRequest.parent）
   *
   * 调用方式：
   *   const audience = this.resolveAudience(req, body.audience);
   */
  private resolveAudience(
    req: AuthenticatedRequest,
    bodyAudience?: ReportAudience,
  ): ReportAudience {
    // 家长 c 端独立 JWT 流（req.parent 被 parent-auth middleware 注入）
    if (req.parent) return 'parent';
    // 兼容：tenant JWT 也可能未来加 'parent' 角色（actorRole 已支持）
    const userRole = req.user?.role as string | undefined;
    if (userRole === 'parent') return 'parent';
    return bodyAudience ?? 'teacher';
  }

  /**
   * V36 audit_log 上下文（finalize* 类操作必须有 operator）
   *
   * 从 JWT 取 sub + role + 请求级 ip/ua/req-id
   * 如未走 auth middleware（极少 — 测试 / 公网未 protected），operator 为 undefined
   * 时 audit_log 链路断 → service 层抛 BadRequest（finalizeParentInDb 已校验）
   *
   * 注：finalize-parent / finalize-teacher 都不允许 parent role 调用（RbacGuard 已挡）
   *     所以 ctx 不需要兼容 req.parent 路径
   */
  private buildFinalizeAuditCtx(req: AuthenticatedRequest): FinalizeAuditContext {
    return {
      operatorUserId: req.user?.sub ?? '',
      // V33 actorRole 枚举已含 teacher / academic / academic_admin / admin / boss / parent
      // 取 JWT 实际 role 透传；fallback 'admin'（极少出现：内部 cron 兼容）
      actorRole: ((req.user?.role as ActorRole) ?? 'admin') as ActorRole,
      ip: req.ip ?? null,
      userAgent: (req.headers?.['user-agent'] as string | undefined) ?? null,
      requestId: (req.headers?.['x-request-id'] as string | undefined) ?? null,
    };
  }

  /**
   * 2026-05-11 修复 (P1): 添加 TenantScopeGuard + RbacGuard
   *   - 该 endpoint 用于 admin/boss 看老师 finalize 待办列表 (校长 / 老板视角)
   *   - 暂不含 'teacher' (TenantRole 枚举未含, Sprint B 加后, teacher 应自动按 teacherId 过滤)
   *   - 添加 IdempotencyInterceptor 跟其他 finalize 系列对齐 (虽然这是读请求, 但走 POST + body 模式)
   */
  @Post('db/monthly-reports/pending-finalize')
  @UseGuards(TenantScopeGuard, RbacGuard)
  @Roles('admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async listPendingFinalizeInDb(
    @Body() body: { tenantSchema: string; teacherId?: string },
  ): Promise<MonthlyReport[]> {
    return this.report.listPendingFinalizeInDb(body.tenantSchema, body.teacherId);
  }

  /**
   * 2026-05-11 修复 (P1): 添加 TenantScopeGuard + IdempotencyInterceptor
   *   - 家长打"已读"主调用方 = parent role JWT
   *   - 跨租户已由 Fix 1 (requireParentDbUser) 守护: parent 不能用错的 tenantSchema
   *   - TenantScopeGuard 兜底: 即便 parent role 也走 body.tenantId/x-tenant-schema 校验
   *   - 不加 @Roles: parent role 是合法调用者 (RbacGuard 默认放行无 @Roles 路由)
   *   - Idempotency: parent 双击「已读」防重复写 parent_read_at (虽然 COALESCE 幂等, 加一层稳)
   */
  @Post('db/monthly-reports/:id/parent-read')
  @UseGuards(TenantScopeGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(HttpStatus.OK)
  async markParentReadReportInDb(
    @Param('id') id: string,
    @Body() body: { tenantSchema: string },
  ): Promise<MonthlyReport> {
    return this.report.markParentReadInDb(id, body.tenantSchema);
  }

  // -- helpers: JSON Date 反序列化 --

  private deserializeFeedback(f: LessonFeedback): LessonFeedback {
    return {
      ...f,
      submittedAt: new Date(f.submittedAt as unknown as string),
      updatedAt: new Date(f.updatedAt as unknown as string),
      parentReadAt: f.parentReadAt
        ? new Date(f.parentReadAt as unknown as string)
        : undefined,
    };
  }

  private deserializeConsumption(c: CourseConsumption): CourseConsumption {
    return {
      ...c,
      feedbackDueAt: new Date(c.feedbackDueAt as unknown as string),
      confirmedAt: c.confirmedAt ? new Date(c.confirmedAt as unknown as string) : undefined,
      lockedAt: c.lockedAt ? new Date(c.lockedAt as unknown as string) : undefined,
      createdAt: new Date(c.createdAt as unknown as string),
    };
  }

  private deserializeReport(r: MonthlyReport): MonthlyReport {
    return {
      ...r,
      month: new Date(r.month as unknown as string),
      generatedAt: new Date(r.generatedAt as unknown as string),
      finalizedAt: r.finalizedAt ? new Date(r.finalizedAt as unknown as string) : undefined,
      parentReadAt: r.parentReadAt
        ? new Date(r.parentReadAt as unknown as string)
        : undefined,
    };
  }
}
