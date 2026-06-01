import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Logger,
  Optional,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';
import { RbacGuard } from '../../guards/rbac.guard';
import { Roles } from '../../guards/rbac.decorator';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';
import { IdempotencyInterceptor } from '../../common/idempotency/idempotency.interceptor';
import { FeedbackRuleConfigRepository } from './feedback-rule-config.repository';
import {
  PendingFeedbackService,
  PendingFeedbackStudent,
} from './pending-feedback.service';
import {
  ActorRole,
  AuditLogRepository,
  normalizeActorRole,
} from './audit-log.repository';

/**
 * FeedbackRuleController — V66 (Phase 5) 反馈提醒规则 + 教务待反馈学员
 *
 * 来源：../edu-mp-sandbox/docs/SSOT-拍板权威.md §5.3.3（2026-06-01 拍板走查 #7b，业务链末段）
 *
 * 端点（全 POST，header x-tenant-schema；TenantScopeGuard + RbacGuard 类级）：
 *   POST /db/campus-config/feedback-rule        读本校反馈规则           @Roles(boss, admin)
 *   POST /db/campus-config/feedback-rule/set     设反馈规则（upsert+audit） @Roles(boss, admin)
 *   POST /db/feedback/pending-students           教务本人名下待反馈学员    @Roles(academic, academic_admin)
 *
 * RBAC 分两组（RbacGuard 按 handler 元数据，class 仅挂 guard）：
 *   - feedback-rule 读/设 = [boss, admin]（校长配置页，仿 §5.3.1 assignment 形态）
 *   - pending-students  = [academic, academic_admin]（教务反馈页，只读监控待办）
 *
 * campusId 一律取自 JWT（禁信前端传参防伪造跨校）：
 *   - boss / academic = 单校 role，campusId 必有；缺失 → 403（配置异常，不兜底）。
 *   - admin / academic_admin = 跨校可能 null；本组「本校」语义 → 缺 campusId 同样 403
 *     （与 §5.3.1 CampusAssignmentController.requireCampusId 同纪律）。
 *
 * owner-scope（2026-06-02 用户拍板，范围分角色）：
 *   - 普通教务 academic = 本人名下（严格 assigned_academic_id = JWT.sub）。
 *   - 教务主管 academic_admin = 本校督导视图（listPendingForCampus，本校全部教务名下汇总；
 *     因 §5.3.1 发牌池仅 academic、主管不接 caseload，按本人名下会恒空 → 改全校督导）。
 *   两者 campusId 一律取 JWT（防伪造跨校）。
 *
 * 教务页性质 = 只读监控（§6「教务全只读老师线」红线不变，0 教务写反馈动作）。
 *
 * 写动作（feedback-rule/set）配 audit_log 'feedback-rule.set'（before/after）；
 *   读端点 home-read 同级不强制 audit（SSOT §5.3.3）。
 *   IdempotencyInterceptor 全局已注册（set 显式标注语义）。
 */
@Controller('db')
@UseGuards(TenantScopeGuard, RbacGuard)
export class FeedbackRuleController {
  private readonly logger = new Logger(FeedbackRuleController.name);

  constructor(
    private readonly ruleRepo: FeedbackRuleConfigRepository,
    private readonly pendingService: PendingFeedbackService,
    @Optional() private readonly auditLog?: AuditLogRepository,
  ) {}

  /** 取调用者本校 campusId（缺失 → 403，禁信前端）。 */
  private requireCampusId(req: AuthenticatedRequest): string {
    const campusId = req.user?.campusId;
    if (!campusId) {
      throw new ForbiddenException(
        'FEEDBACK_RULE_NO_CAMPUS: caller must have a campusId scope (boss/academic single-campus; admin/academic_admin must supply campus context)',
      );
    }
    return campusId;
  }

  private auditCtx(req: AuthenticatedRequest): {
    actorRole: ActorRole;
    ip: string | null;
    userAgent: string | null;
    requestId: string | null;
  } {
    return {
      actorRole: normalizeActorRole(req.user?.role),
      ip: req.ip ?? null,
      userAgent: (req.headers?.['user-agent'] as string | undefined) ?? null,
      requestId: (req.headers?.['x-request-id'] as string | undefined) ?? null,
    };
  }

  private async tryAudit(
    tenantSchema: string,
    entry: {
      actorUserId: string | null;
      actorRole: ActorRole;
      action: string;
      targetType: string;
      targetId: string | null;
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
      ip: string | null;
      userAgent: string | null;
      requestId: string | null;
    },
  ): Promise<void> {
    if (!this.auditLog) {
      this.logger.warn(
        `audit log repo not injected, skipping audit for ${entry.action} (target=${entry.targetId})`,
      );
      return;
    }
    try {
      await this.auditLog.log(tenantSchema, entry);
    } catch {
      // fail-open
    }
  }

  /** int 维度校验：null 透传（清维度）；否则须整数且在 [min,max]，越界 → 400。 */
  private validateDimension(
    raw: number | null | undefined,
    field: string,
    min: number,
    max: number,
  ): number | null {
    if (raw === null || raw === undefined) return null;
    if (
      typeof raw !== 'number' ||
      !Number.isInteger(raw) ||
      raw < min ||
      raw > max
    ) {
      throw new BadRequestException(
        `${field} must be an integer in [${min}, ${max}] or null`,
      );
    }
    return raw;
  }

  // ============================================================
  // 1. 读本校反馈规则
  // ============================================================
  /**
   * 读本校反馈规则。无配置行 → reminderDays / everyNLessons 默认 null（规则全关）。
   */
  @Post('campus-config/feedback-rule')
  @Roles('boss', 'admin')
  @HttpCode(HttpStatus.OK)
  async getFeedbackRule(
    @Body() body: { tenantSchema: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<{
    campusId: string;
    reminderDays: number | null;
    everyNLessons: number | null;
  }> {
    if (!body?.tenantSchema) throw new BadRequestException('tenantSchema required');
    const campusId = this.requireCampusId(req);
    const cfg = await this.ruleRepo.get(body.tenantSchema, campusId);
    return {
      campusId,
      reminderDays: cfg?.reminderDays ?? null,
      everyNLessons: cfg?.everyNLessons ?? null,
    };
  }

  // ============================================================
  // 2. 设反馈规则（upsert + audit）
  // ============================================================
  @Post('campus-config/feedback-rule/set')
  @Roles('boss', 'admin')
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(HttpStatus.OK)
  async setFeedbackRule(
    @Body()
    body: {
      tenantSchema: string;
      reminderDays?: number | null;
      everyNLessons?: number | null;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<{
    campusId: string;
    reminderDays: number | null;
    everyNLessons: number | null;
  }> {
    if (!body?.tenantSchema) throw new BadRequestException('tenantSchema required');
    // 校验 + 归一化（null = 清维度；越界 400 防滥用 SSOT §5.3.3）
    const reminderDays = this.validateDimension(
      body.reminderDays,
      'reminderDays',
      1,
      365,
    );
    const everyNLessons = this.validateDimension(
      body.everyNLessons,
      'everyNLessons',
      1,
      100,
    );
    const campusId = this.requireCampusId(req);
    const userId = req.user?.sub ?? null;

    const before = await this.ruleRepo.get(body.tenantSchema, campusId);
    const updated = await this.ruleRepo.upsert(
      body.tenantSchema,
      campusId,
      reminderDays,
      everyNLessons,
      userId ?? '',
    );

    await this.tryAudit(body.tenantSchema, {
      actorUserId: userId,
      ...this.auditCtx(req),
      action: 'feedback-rule.set',
      targetType: 'campus',
      targetId: campusId,
      before: {
        reminderDays: before?.reminderDays ?? null,
        everyNLessons: before?.everyNLessons ?? null,
      },
      after: {
        reminderDays: updated.reminderDays,
        everyNLessons: updated.everyNLessons,
      },
    });

    return {
      campusId,
      reminderDays: updated.reminderDays,
      everyNLessons: updated.everyNLessons,
    };
  }

  // ============================================================
  // 3. 教务本人名下待反馈学员（按本校规则算 + 标注命中原因）
  // ============================================================
  /**
   * 教务反馈页：本人（assigned_academic_id = JWT.sub）名下待反馈学员。
   *   - 读本校 feedback_rule_config → OR 任一命中即进待办；规则全关 → 空列表。
   *   - 只读监控（§6 教务全只读老师线红线，0 写反馈动作）。
   */
  @Post('feedback/pending-students')
  @Roles('academic', 'academic_admin')
  @HttpCode(HttpStatus.OK)
  async pendingStudents(
    @Body() body: { tenantSchema: string; limit?: number; offset?: number },
    @Req() req: AuthenticatedRequest,
  ): Promise<{ items: PendingFeedbackStudent[] }> {
    if (!body?.tenantSchema) throw new BadRequestException('tenantSchema required');
    const campusId = this.requireCampusId(req);
    const academicId = req.user?.sub;
    if (!academicId) {
      // JWT 异常（无 sub）→ 403（owner-scope 无法确定，不兜底）
      throw new ForbiddenException('FEEDBACK_PENDING_NO_SUBJECT: caller sub missing');
    }
    // 2026-06-02 用户拍板：academic_admin（教务主管）= 本校督导视图（本校全部教务名下待反馈）；
    //   普通 academic = 本人名下（assigned_academic_id=sub）。campusId 一律取 JWT（防伪造跨校）。
    const opts = { limit: body.limit, offset: body.offset };
    if (req.user?.role === 'academic_admin') {
      return this.pendingService.listPendingForCampus(
        body.tenantSchema,
        campusId,
        opts,
      );
    }
    return this.pendingService.listPendingForAcademic(
      body.tenantSchema,
      campusId,
      academicId,
      opts,
    );
  }
}
