import {
  Body,
  Controller,
  Param,
  Post,
  Patch,
  Req,
  HttpCode,
  HttpStatus,
  Optional,
  UseGuards,
  UseInterceptors,
  BadRequestException,
  ForbiddenException,
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
import { ActorRole, AuditLogRepository, normalizeActorRole } from '../db/audit-log.repository';
import { TeacherRepository } from '../db/teacher.repository';
import { ContentModerationService } from '../security/content-moderation.service';

/**
 * FeedbackController — V9 教学反馈 + 课消 + 月报 HTTP 暴露 BE-V9-1/2/3
 *
 * 路由前缀（多个）：
 *   - /api/lesson-feedbacks
 *   - /api/course-consumptions
 *   - /api/monthly-reports
 *
 * Sprint B (2026-05-11) 深度防御：
 *   - class-level @UseGuards(TenantScopeGuard) — 兜底所有 /db endpoint 跨租户校验
 *   - method-level @UseGuards(TenantScopeGuard, RbacGuard) 仍保留（不重复执行，NestJS 已去重）
 *   - 注：parent c 端走 isParentDbPath 分流，middleware 注入 parent 用户后 guard 也能正确跑（tenantId 来自 parent JWT）
 *
 * USER-AUTH(2026-05-02): PD §4 + P6 24h 必填 + P7 月报自动
 */
@UseGuards(TenantScopeGuard)
@Controller()
export class FeedbackController {
  constructor(
    private readonly feedback: LessonFeedbackService,
    private readonly consumption: CourseConsumptionService,
    private readonly report: MonthlyReportService,
    // Sprint B (2026-05-11): self-check 需要把 req.user.sub 映射回 teachers.user_id
    //   - teacher role JWT 的 sub = 用户表 users.id（V32 teachers.user_id 引用此字段）
    //   - 用此 repo 反查老师档案，判定该 user 是否是 report.teacher_id 的真实所有者
    private readonly teacherRepo: TeacherRepository,
    // #24: B 端自由文本内容安全统一收口（@Global SecurityModule 注入，生产必有）
    private readonly contentModeration: ContentModerationService,
    // Sprint B (2026-05-11 复审): self-check 失败时写 audit_log
    //   - @Optional：unit spec 直接 new 时可传 undefined（不破坏现有 spec test）
    //   - fail-open：audit_log 写失败不阻塞主 ForbiddenException
    @Optional() private readonly auditLog?: AuditLogRepository,
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
   * PATCH /api/lesson-feedbacks/:feedbackId — 24h 内修改反馈
   */
  @Patch('lesson-feedbacks/:feedbackId')
  @HttpCode(HttpStatus.OK)
  updateFeedback(
    @Param('feedbackId') _feedbackId: string,
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
   * POST /api/lesson-feedbacks/:feedbackId/parent-read
   */
  @Post('lesson-feedbacks/:feedbackId/parent-read')
  @HttpCode(HttpStatus.OK)
  markParentReadFeedback(
    @Param('feedbackId') _feedbackId: string,
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
   * POST /api/course-consumptions/:consumptionId/confirm — 反馈提交时 confirm
   */
  @Post('course-consumptions/:consumptionId/confirm')
  @HttpCode(HttpStatus.OK)
  confirmConsumption(
    @Param('consumptionId') _consumptionId: string,
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
   * POST /api/course-consumptions/:consumptionId/unlock-late — 老师超期补填恢复
   */
  @Post('course-consumptions/:consumptionId/unlock-late')
  @HttpCode(HttpStatus.OK)
  unlockLate(
    @Param('consumptionId') _consumptionId: string,
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
   * POST /api/monthly-reports/:reportId/finalize — 老师补寄语 + 续报建议
   */
  @Post('monthly-reports/:reportId/finalize')
  @HttpCode(HttpStatus.OK)
  finalizeReport(
    @Param('reportId') _reportId: string,
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
   * POST /api/monthly-reports/:reportId/parent-read
   */
  @Post('monthly-reports/:reportId/parent-read')
  @HttpCode(HttpStatus.OK)
  markParentReadReport(
    @Param('reportId') _reportId: string,
    @Body() body: { report: MonthlyReport; nowMs?: number },
  ): MonthlyReport {
    return this.report.markParentRead(
      this.deserializeReport(body.report),
      body.nowMs ? new Date(body.nowMs) : new Date(),
    );
  }

  // ==================== /db 真存盘版 ====================

  // ----- LessonFeedback -----

  /**
   * Sprint B RBAC: teacher / admin / boss 可创建反馈
   *   - 拍板「教务全只读老师线」→ academic 不在写列表
   *   - 拍板「家长不能写反馈」→ parent 不在写列表
   *   - teacher self-check: feedback.teacherId === req.user 反查的 teachers.id
   *
   * 5/21 round 2 (security BLOCKER-1 修复)：
   *   旧版 handler 直接将 body.teacherId 传 submitInDb 零 JWT 反查校验 →
   *   teacher 可设 body.teacherId 为他人 → S3 触发他人 consumption confirm →
   *   影响 weeklyConsumedYuan 财务对账（A04 跨 actor 攻击面）
   *   修法：调用 assertTeacherIdSelfOrPrivileged 按 body.teacherId 比对 JWT 反查
   *
   * 5/21 round 2 (P1 audit_log 修复)：
   *   写成功后调 auditLog.log 写 'lesson-feedback.submitted'（对标 finalize 模式）
   */
  @Post('db/lesson-feedbacks')
  @UseGuards(TenantScopeGuard, RbacGuard)
  @Roles('teacher', 'admin', 'boss')
  @UseInterceptors(IdempotencyInterceptor)
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
    @Req() req: AuthenticatedRequest,
  ): Promise<LessonFeedback> {
    const { tenantSchema, homeworkDeadlineMs, ...rest } = body;

    // 5/21 BLOCKER-1: teacher 必须只能为自己 schedule 写反馈（防伪造 body.teacherId）
    //   - admin/boss 跳过 self-check（拍板「老板校长 ✅ 全权」）
    //   - teacher self-check 失败抛 ForbiddenException + 写 audit_log（teacher.self-check-failed）
    // 5/22 改: assertTeacherIdSelfOrPrivileged 返 final teacherId, body 空时 teacher 自身兜底
    //   (前端不必再调 GET /api/teachers/me 多 1 个 roundtrip 拿自己 teacher.id)
    const finalTeacherId = await this.assertTeacherIdSelfOrPrivileged(req, tenantSchema, body.teacherId);

    // #24: B 端自由文本过微信内容安全（risky → 400 拒存；写库前拦截，违规内容不落库）
    //   含嵌套自由文本：knowledgePoints[].name / knowledgeMatrix[].name（老师自定义知识点名，
    //   security-auditor 标的覆盖缺口）。homeworkAttachments[].filename 多为 OSS key 非自由输入，不纳入。
    await this.contentModeration.enforceStaffText(
      tenantSchema,
      [
        body.homework,
        body.teacherNote,
        body.teacherInternalNote,
        body.nextPreview,
        ...(body.knowledgePoints ?? []).map((p) => p.name),
        ...(body.knowledgeMatrix ?? []).map((p) => p.name),
      ],
      {
        action: 'lesson-feedback',
        targetType: 'lesson_feedback',
        targetId: body.id,
        req,
      },
    );

    const result = await this.feedback.submitInDb(
      {
        ...rest,
        teacherId: finalTeacherId,
        homeworkDeadline: homeworkDeadlineMs ? new Date(homeworkDeadlineMs) : undefined,
      },
      tenantSchema,
    );

    // 5/21 P1: 写 audit_log（对标 finalize 模式 — fail-open）
    try {
      await this.auditLog?.log(tenantSchema, {
        actorUserId: req.user?.sub ?? null,
        actorRole: normalizeActorRole(req.user?.role),
        action: 'lesson-feedback.submitted',
        targetType: 'lesson_feedback',
        targetId: result.id,
        before: null,
        after: {
          scheduleId: body.scheduleId,
          studentId: body.studentId,
          teacherId: body.teacherId,
          attendanceStatus: body.attendanceStatus,
        },
        ip: req.ip ?? null,
        userAgent: (req.headers?.['user-agent'] as string | undefined) ?? null,
        requestId: (req.headers?.['x-request-id'] as string | undefined) ?? null,
      });
    } catch {
      // fail-open: AuditLogRepository.log 已内部 catch，此层兜底
    }

    return result;
  }

  /**
   * Sprint B RBAC (2026-05-11 复审补): 读反馈
   *   - 老师 ✅ / 教务（双层）👁 / 销售（自己客户的孩子）👁 / 老板校长 ✅
   *   - 家长走 c 端独立 endpoint（parent JWT 流），middleware isParentDbPath 已含 lesson-feedbacks
   *     parent JWT 进入时 req.user.role='parent'，RbacGuard 不在 @Roles 列表 → 拒绝
   *     但 isParentDbPath 分流前已用 requireParentDbUser 校验，parent 实际访问的是同 controller 但走 parent 视角
   *     ⚠ 风险：parent role 不在 @Roles → RbacGuard 拦截 parent → 路由失效
   *     → 解决：parent 走独立 controller 路径（c 端独立 endpoint）；本 endpoint 仅 B 端 role 访问
   */
  @Post('db/lesson-feedbacks/:feedbackId/find')
  @UseGuards(TenantScopeGuard, RbacGuard)
  @Roles(
    'teacher',
    'academic',
    'academic_admin',
    'admin',
    'boss',
    'sales',
    'sales_manager',
    // 5/15 A-2：删 'sales_director'（不在拍板角色清单）
  )
  @HttpCode(HttpStatus.OK)
  async findFeedbackInDb(
    @Param('feedbackId') feedbackId: string,
    @Body() body: { tenantSchema: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<LessonFeedback> {
    // 2026-05-31 SSOT §5.1: 透传 caller role → service 按 role 剥离 teacherInternalNote
    //   - sales / sales_manager 不可见老师内部备注（只读家长可见内容）
    //   - parent 经 c 端 isParentDbPath 分流，req.user.role='parent' → 同样剥离
    return this.feedback.findInDb(feedbackId, body.tenantSchema, req.user?.role);
  }

  @Post('db/students/:studentId/feedbacks')
  @UseGuards(TenantScopeGuard, RbacGuard)
  @Roles(
    'teacher',
    'academic',
    'academic_admin',
    'admin',
    'boss',
    'sales',
    'sales_manager',
    'marketing', // 2026-05-31 §4.1 学习表现 市 ✅（只读）；teacherInternalNote 仍按 §5.1 剥离（marketing 不在白名单）
    // 5/15 A-2：删 'sales_director'（不在拍板角色清单）
  )
  @HttpCode(HttpStatus.OK)
  async listFeedbacksByStudentInDb(
    @Param('studentId') studentId: string,
    @Body() body: { tenantSchema: string; limit?: number; offset?: number },
    @Req() req: AuthenticatedRequest,
  ): Promise<LessonFeedback[]> {
    // 2026-05-31 SSOT §5.1: 透传 caller role → service 逐条剥离 teacherInternalNote
    //   - sales / sales_manager 不可见老师内部备注
    //   - parent 经 c 端 isParentDbPath 分流（/api/db/students/:id/feedbacks），role='parent' → 剥离
    return this.feedback.listByStudentInDb(
      studentId,
      body.tenantSchema,
      { limit: body.limit, offset: body.offset },
      req.user?.role,
    );
  }

  /**
   * Sprint B RBAC: 24h 内改反馈（老师 / admin / boss；教务只读不能改）
   */
  @Post('db/lesson-feedbacks/:feedbackId/update')
  @UseGuards(TenantScopeGuard, RbacGuard)
  @Roles('teacher', 'admin', 'boss')
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(HttpStatus.OK)
  async updateFeedbackInDb(
    @Param('feedbackId') feedbackId: string,
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
    @Req() req: AuthenticatedRequest,
  ): Promise<LessonFeedback> {
    const { homeworkDeadlineMs, ...patchRest } = body.patch;

    // #24: 改反馈同样过内容安全（patch 里的自由文本字段；含 knowledgePoints/knowledgeMatrix 嵌套 name）
    await this.contentModeration.enforceStaffText(
      body.tenantSchema,
      [
        body.patch.homework,
        body.patch.teacherNote,
        body.patch.teacherInternalNote,
        body.patch.nextPreview,
        ...(body.patch.knowledgePoints ?? []).map((p) => p.name),
        ...(body.patch.knowledgeMatrix ?? []).map((p) => p.name),
      ],
      {
        action: 'lesson-feedback',
        targetType: 'lesson_feedback',
        targetId: feedbackId,
        req,
      },
    );

    return this.feedback.updateInDb(
      feedbackId,
      {
        ...patchRest,
        homeworkDeadline: homeworkDeadlineMs ? new Date(homeworkDeadlineMs) : undefined,
      },
      body.tenantSchema,
      body.nowMs ? new Date(body.nowMs) : new Date(),
    );
  }

  /**
   * Sprint B: parent-read 由家长 c 端打"已读"，但 endpoint 仍可被 admin / boss 调（运营回放）
   *   - 走 middleware isParentDbPath 分支（/api/db/lesson-feedbacks/ 前缀），parent JWT 也能调
   *   - RbacGuard 这道闸默认放行无 @Roles 路由（含 parent role 走 parent JWT 流时 req.user.role='parent'）
   */
  @Post('db/lesson-feedbacks/:feedbackId/parent-read')
  @HttpCode(HttpStatus.OK)
  async markParentReadFeedbackInDb(
    @Param('feedbackId') feedbackId: string,
    @Body() body: { tenantSchema: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<LessonFeedback> {
    // 2026-05-31 安全审残留路径修复：透传 caller role，service 剥离 teacherInternalNote
    return this.feedback.markParentReadInDb(feedbackId, body.tenantSchema, req.user?.role);
  }

  // ----- CourseConsumption -----

  /**
   * Sprint B RBAC: 创建课消 — schedule.complete 时由 admin / boss / teacher 触发
   *   - 拍板「教务全只读老师线」→ academic 不在写列表
   *   - cron 调 service 直接绕过 controller，不影响
   */
  @Post('db/course-consumptions')
  @UseGuards(TenantScopeGuard, RbacGuard)
  @Roles('teacher', 'admin', 'boss')
  @UseInterceptors(IdempotencyInterceptor)
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

  /**
   * Sprint B RBAC (2026-05-11 复审补): cron / admin / boss 调用
   *   - 反馈提交时由 lesson-feedback 内联调用 → admin / boss 可重放
   *   - teacher 不能直接调（schedule.complete 时反馈服务自动 confirm）
   */
  @Post('db/course-consumptions/:consumptionId/confirm')
  @UseGuards(TenantScopeGuard, RbacGuard)
  @Roles('admin', 'boss')
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(HttpStatus.OK)
  async confirmConsumptionInDb(
    @Param('consumptionId') consumptionId: string,
    @Body() body: { feedbackId: string; tenantSchema: string },
  ): Promise<CourseConsumption> {
    return this.consumption.confirmByFeedbackInDb(consumptionId, body.feedbackId, body.tenantSchema);
  }

  /**
   * Sprint B RBAC (2026-05-11 复审补): cron / admin / boss 调用
   *   - 通常 CronJobsService 定时调，HTTP endpoint 仅运营回放
   */
  @Post('db/course-consumptions/scan-and-lock')
  @UseGuards(TenantScopeGuard, RbacGuard)
  @Roles('admin', 'boss')
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(HttpStatus.OK)
  async scanAndLockInDb(
    @Body() body: { tenantSchema: string; nowMs?: number },
  ): Promise<{ locked: number; ids: string[] }> {
    return this.consumption.scanAndLockInDb(
      body.tenantSchema,
      body.nowMs ? new Date(body.nowMs) : new Date(),
    );
  }

  /**
   * Sprint B RBAC (2026-05-11 复审补): teacher / admin / boss
   *   - 老师超期补填时恢复（self-check 在 service 层）
   */
  @Post('db/course-consumptions/:consumptionId/unlock-late')
  @UseGuards(TenantScopeGuard, RbacGuard)
  @Roles('teacher', 'admin', 'boss')
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(HttpStatus.OK)
  async unlockLateInDb(
    @Param('consumptionId') consumptionId: string,
    @Body() body: { feedbackId: string; tenantSchema: string },
  ): Promise<CourseConsumption> {
    return this.consumption.unlockByLateFeedbackInDb(consumptionId, body.feedbackId, body.tenantSchema);
  }

  /**
   * Sprint B RBAC (2026-05-11 复审补): admin / boss
   */
  @Post('db/course-consumptions/:consumptionId/cancel')
  @UseGuards(TenantScopeGuard, RbacGuard)
  @Roles('admin', 'boss')
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(HttpStatus.OK)
  async cancelConsumptionInDb(
    @Param('consumptionId') consumptionId: string,
    @Body() body: { tenantSchema: string },
  ): Promise<CourseConsumption> {
    return this.consumption.cancelInDb(consumptionId, body.tenantSchema);
  }

  // V38: 删 POST /api/db/teachers/:teacherId/payroll（薪资业务下线 + A04 R3 跨租户漏洞修复）
  //   原方法 sumPayrollForTeacherInDb 同步删除（course-consumption.service.ts）
  //   A04 红线：此 endpoint 历史上仅靠 body.tenantSchema 自填，无 TenantScopeGuard，
  //   删除即修复跨租户隐患（W5）

  /**
   * home-teacher 待办 banner 聚合：老师待点评课消数 + 最早到期时间
   * UI 据 earliestDueAt 显示「剩 X 小时锁课消」或「已超期」
   *
   * Sprint B RBAC (2026-05-11 复审补): teacher / academic / academic_admin / admin / boss
   *   - teacher 自己看待办（home banner）
   *   - 教务双层只读（看全 campus 老师待办）
   *   - admin / boss 全权
   */
  @Post('db/teachers/:teacherId/pending-feedback-summary')
  @UseGuards(TenantScopeGuard, RbacGuard)
  @Roles('teacher', 'academic', 'academic_admin', 'admin', 'boss')
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

  /**
   * Sprint B RBAC: 月报生成 — cron / admin / boss 调用
   *   - cron 走 CronJobsService.generateMonthlyReports 直接调 service，绕过 controller
   *   - 此 HTTP endpoint 仅给运营 / boss 重跑用，所以 admin / boss
   *   - parent 不应能调（V36 漏洞修复配套：middleware isParentDbPath /generate 已排除）
   */
  @Post('db/monthly-reports/generate')
  @UseGuards(TenantScopeGuard, RbacGuard)
  @Roles('admin', 'boss')
  @UseInterceptors(IdempotencyInterceptor)
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
   * RBAC (Sprint B 2026-05-11): TenantRole 加 'teacher' 后放行 teacher，
   *   并在 controller 层做 self-check（teacher 只能 finalize 自己学生的报告）
   *   - admin / boss：任意 teacher_id 的月报
   *   - teacher：req.user.sub 必须 = teachers.user_id WHERE teachers.id = report.teacher_id
   *   - parent / sales / academic 等：RbacGuard 拒绝（不在 @Roles 列表）
   *
   * 漏洞修复 (A01-CRIT 配套):
   *   旧实现仅 @UseGuards(TenantScopeGuard) 无 @Roles, parent role JWT 可调此 endpoint
   *   组合 Fix 1 后 parent 已被跨租户校验拦截, 但本 endpoint 应明确拒绝 parent role
   */
  @Post('db/monthly-reports/:reportId/finalize')
  @UseGuards(TenantScopeGuard, RbacGuard)
  @Roles('teacher', 'admin', 'boss')
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(HttpStatus.OK)
  async finalizeReportInDb(
    @Param('reportId') reportId: string,
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

    // Sprint B self-check: teacher role 只能 finalize 自己学生的报告
    //   - 先 SELECT 出 report 拿 teacher_id，再核对 teachers.user_id 是否 = req.user.sub
    //   - 如果 report 不存在 → repo 层会抛 NotFoundException；先做 self-check 才能拿到 teacher_id
    //   - admin / boss 跳过 self-check（拍板：boss 是校长，admin 是老板，都能改全 campus 数据）
    await this.assertTeacherSelfOrPrivileged(req, body.tenantSchema, reportId);

    // #24: 月报自由文本过内容安全（teacher 版 + parent 合并版字段一并送检，含
    //   parentHighlights[].point / parentImprovements[].point+.suggestion 嵌套家长可见文本）
    await this.contentModeration.enforceStaffText(
      body.tenantSchema,
      [
        body.teacherBlessing,
        body.renewalSuggestion,
        body.parentBlessing,
        body.parentNextPlan,
        ...(body.parentHighlights ?? []).map((h) => h.point),
        ...(body.parentImprovements ?? []).flatMap((i) => [i.point, i.suggestion]),
      ],
      {
        action: 'monthly-report',
        targetType: 'monthly_report',
        targetId: reportId,
        req,
      },
    );

    // V36 audience='parent' 合并路径 → 转走 finalize-parent
    if (body.audience === 'parent') {
      if (!body.parentBlessing) {
        throw new BadRequestException(
          'audience=parent requires parentBlessing in body',
        );
      }
      return this.report.finalizeParentInDb(
        reportId,
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
      reportId,
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
   * RBAC (Sprint B 2026-05-11 复审): teacher / admin / boss
   *   - 注释与代码一致 — academic / academic_admin 不能 finalize（拍板「教务全只读老师线」）
   *   - 家长 c 端不应能补写自己的"家长版评语"，所以 parent role 不在允许列表
   *   - teacher self-check: 只能补自己学生的家长版
   *
   * Body:
   *   - parentBlessing required
   *   - parentHighlights / parentImprovements / parentNextPlan optional
   *   - tenantSchema required
   *
   * 注：parent role 进入此 endpoint → 应被 RbacGuard 挡住（@Roles 不含 parent）
   *     如未来 c 端要让家长自己写感谢回馈，应另开 endpoint，避免与"老师写给家长"语义混淆
   */
  @Post('db/monthly-reports/:reportId/finalize-parent')
  @UseGuards(TenantScopeGuard, RbacGuard)
  @Roles('teacher', 'admin', 'boss')
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(HttpStatus.OK)
  async finalizeReportParentInDb(
    @Param('reportId') reportId: string,
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
    // Sprint B self-check: teacher role 只能补写自己学生的家长版评语
    await this.assertTeacherSelfOrPrivileged(req, body.tenantSchema, reportId);

    // #24: 家长版自由文本过内容安全（家长直接可见；含 highlights/improvements 嵌套文本）
    await this.contentModeration.enforceStaffText(
      body.tenantSchema,
      [
        body.parentBlessing,
        body.parentNextPlan,
        ...(body.parentHighlights ?? []).map((h) => h.point),
        ...(body.parentImprovements ?? []).flatMap((i) => [i.point, i.suggestion]),
      ],
      {
        action: 'monthly-report',
        targetType: 'monthly_report',
        targetId: reportId,
        req,
      },
    );

    const auditCtx = this.buildFinalizeAuditCtx(req);
    const payload: FinalizeParentPayload = {
      parentBlessing: body.parentBlessing,
      parentHighlights: body.parentHighlights,
      parentImprovements: body.parentImprovements,
      parentNextPlan: body.parentNextPlan,
    };
    return this.report.finalizeParentInDb(reportId, payload, body.tenantSchema, auditCtx);
  }

  /**
   * V36 拓展 — find 按 audience 切换 SELECT
   *
   * 双轨硬红线：parent role JWT 强制 audience='parent'（自动遮蔽不抛 403，UX 友好）
   * 其他 role 默认 audience='teacher'（除非 body 显式传 audience）
   */
  @Post('db/monthly-reports/:reportId/find')
  @UseGuards(TenantScopeGuard)
  @HttpCode(HttpStatus.OK)
  async findReportInDb(
    @Param('reportId') reportId: string,
    @Body() body: { tenantSchema: string; audience?: ReportAudience },
    @Req() req: AuthenticatedRequest,
  ): Promise<MonthlyReport> {
    const audience = this.resolveAudience(req, body.audience);
    return this.report.findInDb(reportId, body.tenantSchema, audience);
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
      // T-DEADCODE-CLEANUP H4 (2026-05-17): normalizeActorRole 替换 unsafe cast
      actorRole: normalizeActorRole(req.user?.role),
      ip: req.ip ?? null,
      userAgent: (req.headers?.['user-agent'] as string | undefined) ?? null,
      requestId: (req.headers?.['x-request-id'] as string | undefined) ?? null,
    };
  }

  /**
   * 2026-05-11 修复 (P1): 添加 TenantScopeGuard + RbacGuard
   *   - 该 endpoint 用于 admin/boss/academic 看老师 finalize 待办列表 (校长 / 老板 / 教务 视角)
   *   - Sprint B 扩展：teacher / academic / academic_admin 也允许（拍板「教务全只读老师线」+ 老师看自己）
   *     - teacher: 强制按 teacherId=req.user 映射的 teachers.id 过滤
   *     - academic / academic_admin / admin / boss: 任意 teacherId 或不传
   *   - 添加 IdempotencyInterceptor 跟其他 finalize 系列对齐 (虽然这是读请求, 但走 POST + body 模式)
   */
  @Post('db/monthly-reports/pending-finalize')
  @UseGuards(TenantScopeGuard, RbacGuard)
  @Roles('teacher', 'academic', 'academic_admin', 'admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async listPendingFinalizeInDb(
    @Body() body: { tenantSchema: string; teacherId?: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<MonthlyReport[]> {
    // Sprint B: teacher role 强制按自己 teacher_id 过滤（防越权看他人待办列表）
    let effectiveTeacherId = body.teacherId;
    if (req.user?.role === 'teacher') {
      const ownTeacherId = await this.resolveOwnTeacherId(req, body.tenantSchema);
      // 即便 body 传了 teacherId，teacher role 也强制覆盖为自己 — UX 友好（前端不必判断 role）
      effectiveTeacherId = ownTeacherId;
    }
    return this.report.listPendingFinalizeInDb(body.tenantSchema, effectiveTeacherId);
  }

  /**
   * 2026-05-11 修复 (P1): 添加 TenantScopeGuard + IdempotencyInterceptor
   *   - 家长打"已读"主调用方 = parent role JWT
   *   - 跨租户已由 Fix 1 (requireParentDbUser) 守护: parent 不能用错的 tenantSchema
   *   - TenantScopeGuard 兜底: 即便 parent role 也走 body.tenantId/x-tenant-schema 校验
   *   - 不加 @Roles: parent role 是合法调用者 (RbacGuard 默认放行无 @Roles 路由)
   *   - Idempotency: parent 双击「已读」防重复写 parent_read_at (虽然 COALESCE 幂等, 加一层稳)
   */
  @Post('db/monthly-reports/:reportId/parent-read')
  @UseGuards(TenantScopeGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(HttpStatus.OK)
  async markParentReadReportInDb(
    @Param('reportId') reportId: string,
    @Body() body: { tenantSchema: string },
  ): Promise<MonthlyReport> {
    return this.report.markParentReadInDb(reportId, body.tenantSchema);
  }

  // -- Sprint B (2026-05-11) self-check helpers --

  /**
   * 把 req.user.sub（B 端用户表 users.id）映射回 teachers.id
   *
   * 来源：teachers.user_id 在 V7 schema 中作为软链，记录该 teacher 档案绑定的用户账号
   *
   * 用法：
   *   - finalize / finalize-parent self-check：拿到 ownTeacherId 后核对 report.teacherId
   *   - pending-finalize 强制按 teacher_id 过滤：返回值替换 body.teacherId
   *
   * @throws ForbiddenException 找不到对应 teachers 行（用户表里有，但 teachers 表里未绑定）
   */
  private async resolveOwnTeacherId(
    req: AuthenticatedRequest,
    tenantSchema: string,
  ): Promise<string> {
    const userId = req.user?.sub;
    if (!userId) {
      throw new ForbiddenException('teacher self-check: req.user.sub missing');
    }
    const teacher = await this.teacherRepo.findByUserId(tenantSchema, userId);
    if (!teacher) {
      throw new ForbiddenException(
        `teacher self-check: no teachers row bound to user ${userId} ` +
          `(teachers.user_id missing — 拒绝写月报/反馈)`,
      );
    }
    return teacher.id;
  }

  /**
   * finalize / finalize-parent self-check:
   *   - teacher role: 必须 = teachers.user_id ↔ report.teacher_id
   *   - admin / boss: 跳过 self-check（拍板「老板校长 ✅ 全权」）
   *   - 其他 role: RbacGuard 已挡，此处不会触达
   *
   * 流程：
   *   1. SELECT report by id → 拿 teacher_id（若不存在抛 NotFound — repo 后续 finalize 会兜底）
   *   2. 若 req.user.role === 'teacher': resolveOwnTeacherId 反查再比对
   *
   * Sprint B (2026-05-11 复审): self-check 失败前写 audit_log
   *   - try-catch 包裹（audit fail-open，不阻塞主 ForbiddenException）
   *   - action='teacher.self-check-failed'
   *
   * @throws ForbiddenException teacher role 但报告 teacher_id !== 自己 teachers.id
   */
  private async assertTeacherSelfOrPrivileged(
    req: AuthenticatedRequest,
    tenantSchema: string,
    reportId: string,
  ): Promise<void> {
    if (req.user?.role !== 'teacher') {
      // admin / boss 走特权路径，无需 self-check
      return;
    }
    // teacher role: 先反查 report 拿 teacher_id
    //   - 用 audience='teacher' 拉完整字段（含 teacherId）
    //   - finalize 操作语义就是 teacher 视角，audience='teacher' 是天然搭档
    const report = await this.report.findInDb(reportId, tenantSchema, 'teacher');
    const ownTeacherId = await this.resolveOwnTeacherId(req, tenantSchema);
    if (report.teacherId !== ownTeacherId) {
      // Sprint B 复审：self-check 失败写 audit_log（fail-open）
      try {
        await this.auditLog?.log(tenantSchema, {
          actorUserId: req.user?.sub ?? null,
          actorRole: 'teacher',
          action: 'teacher.self-check-failed',
          targetType: 'monthly_report',
          targetId: reportId,
          before: null,
          after: {
            attempted_report_teacher_id: report.teacherId,
            own_teacher_id: ownTeacherId,
          },
          ip: req.ip ?? null,
          userAgent: (req.headers?.['user-agent'] as string | undefined) ?? null,
          requestId: (req.headers?.['x-request-id'] as string | undefined) ?? null,
        });
      } catch {
        // audit fail-open — 不阻塞主 ForbiddenException
      }
      throw new ForbiddenException(
        `teacher self-check: report.teacher_id=${report.teacherId} ` +
          `but req.user maps to teachers.id=${ownTeacherId} — 拒绝改他人月报`,
      );
    }
  }

  /**
   * 5/21 round 2 (security BLOCKER-1): 按 body.teacherId 比对 JWT 反查 teachers.id
   *
   * 与 assertTeacherSelfOrPrivileged 区别：
   *   - 后者按 reportId 先 SELECT report 拿 teacher_id（用于 finalize 等基于已有 row 的操作）
   *   - 本 helper 直接接受 expectedTeacherId 参数（用于 submitFeedbackInDb 等 body 自带 teacherId 的创建操作）
   *
   * 用法：
   *   - submitFeedbackInDb：body.teacherId 必须 = JWT 反查的 teachers.id（teacher role）
   *   - admin / boss：跳过 self-check（特权路径）
   *   - 其他 role：RbacGuard 已挡，此处不会触达
   *
   * 失败路径：
   *   - 写 audit_log action='teacher.self-check-failed' targetType='lesson_feedback'（fail-open）
   *   - 抛 ForbiddenException 阻断主流程
   */
  /**
   * 2026-05-22 改返 final teacherId — body 空时 teacher 自身兜底
   *   - admin / boss: 必须显式传 expectedTeacherId (无 ownTeacherId 反查)
   *   - teacher + body 空: 用 ownTeacherId (语义即 self, 等价 body.teacherId = ownTeacherId)
   *   - teacher + body 非空且 ≠ ownTeacherId: 403 (防伪造写他人反馈)
   */
  private async assertTeacherIdSelfOrPrivileged(
    req: AuthenticatedRequest,
    tenantSchema: string,
    expectedTeacherId: string | undefined,
  ): Promise<string> {
    if (req.user?.role !== 'teacher') {
      // admin / boss 走特权路径，无 self-check, 必须显式 body.teacherId
      if (!expectedTeacherId) {
        throw new ForbiddenException(
          'admin/boss 写反馈必须显式提供 body.teacherId',
        );
      }
      return expectedTeacherId;
    }
    const ownTeacherId = await this.resolveOwnTeacherId(req, tenantSchema);
    if (!expectedTeacherId) {
      // teacher 自身兜底: body 空 → 用反查的 ownTeacherId (语义即 self)
      return ownTeacherId;
    }
    if (expectedTeacherId !== ownTeacherId) {
      // self-check 失败写 audit_log（fail-open）
      try {
        await this.auditLog?.log(tenantSchema, {
          actorUserId: req.user?.sub ?? null,
          actorRole: 'teacher',
          action: 'teacher.self-check-failed',
          targetType: 'lesson_feedback',
          targetId: null,
          before: null,
          after: {
            attempted_teacher_id: expectedTeacherId,
            own_teacher_id: ownTeacherId,
          },
          ip: req.ip ?? null,
          userAgent: (req.headers?.['user-agent'] as string | undefined) ?? null,
          requestId: (req.headers?.['x-request-id'] as string | undefined) ?? null,
        });
      } catch {
        // audit fail-open — 不阻塞主 ForbiddenException
      }
      throw new ForbiddenException(
        `teacher self-check: body.teacherId=${expectedTeacherId} ` +
          `but req.user maps to teachers.id=${ownTeacherId} — 拒绝写他人反馈`,
      );
    }
    return ownTeacherId;
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
