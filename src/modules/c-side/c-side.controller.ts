import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Optional,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ParentRepository } from '../db/parent.repository';
import { ParentSelfGuard } from '../auth/parent-self.guard';
import { AuditLogRepository, normalizeActorRole } from '../db/audit-log.repository';
import {
  CSideRepository,
  ChildBrief,
  MessageItem,
  MessageType,
  TodayLesson,
  UnreadCount,
} from './c-side.repository';
// 2026-05-22 波 C: 家长 C 端「待我决定老师变更」endpoint (SSOT §6.5 闭环)
import { TeacherChangeRequestService } from '../db/teacher-change-request.service';

/**
 * CSideController — P4-Y 2026-05-20 C 端家长聚合 endpoint
 *
 * 路由前缀：/api/c
 *
 * 路径分发：
 *   GET   /api/c/home                                 家长 home 一站式聚合
 *   GET   /api/c/students/:studentId/profile          C 端学员档案（家长视角脱敏）
 *   GET   /api/c/messages                             消息中心（feedback + monthly-report）
 *   PATCH /api/c/messages/:id/mark-read               标记单条消息已读（需 ?type=feedback|monthly-report）
 *
 * RBAC 双层守护：
 *   1. tenant.middleware.requireParentDbUser（parent_student_bindings 实绑校验）已挂 req.parent + req.tenantSchema
 *      → 跨 tenant 攻击早被中间件拦截
 *   2. 本 controller 用 req.parent.sub 反查 binding 列表 → 仅返绑定 student 的数据（family-owner scope）
 *      profile endpoint 额外校验 studentId 必须在当前 tenant 的 active binding 内
 *
 * 不挂 TenantScopeGuard：
 *   - parent JWT 不带 tenantId（跨机构身份），TenantScopeGuard 比对 user.tenantId 不适用
 *   - tenant.middleware 已校验 binding × tenant 真实关系 → 已挂 req.tenantSchema
 *
 * ParentSelfGuard class-level：
 *   - 仅守 :parentId path param，本 controller 无此参数 → guard 跳过
 *   - 留作未来如有 /api/c/parents/:parentId/... 时自动生效
 *
 * 限流：60 req/min（覆盖全局 default 60/min，与默认对齐）
 */

interface ParentRequest {
  parent?: { sub?: string; parentId?: string; role?: string };
  tenantSchema?: string;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  originalUrl?: string;
  url?: string;
  method?: string;
}

// P0 真生产 bug 修 (5/20): c-side read 严格 Crockford32 (排除 I/L/O/U) 与
// student.controller create 校验 (仅 length=32) 不一致 → 历史含 I/L/O/U 的 ID 被拒
// 修复: 放宽到 alphanumeric (与 create 一致)，PG 参数化查询防 SQL injection
const ULID_PATTERN = /^[0-9A-Z]{32}$/i;

@Controller('c')
@UseGuards(ParentSelfGuard)
export class CSideController {
  private readonly logger = new Logger(CSideController.name);

  constructor(
    private readonly cside: CSideRepository,
    private readonly parentRepo: ParentRepository,
    @Optional() private readonly auditLog?: AuditLogRepository,
    // 2026-05-22 波 C: 家长「待我决定老师变更」endpoint (SSOT §6.5 闭环)
    @Optional() private readonly tcrService?: TeacherChangeRequestService,
  ) {}

  /**
   * GET /api/c/home — 家长 home 聚合（当前 tenant scope）
   *
   * Query:
   *   tenantSchema?  可选，缺省走 req.tenantSchema（middleware 已挂）
   *
   * Response:
   *   {
   *     children: ChildBrief[],
   *     todayLessons: TodayLesson[],
   *     unreadCount: UnreadCount,
   *   }
   */
  @Get('home')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async getHome(
    @Req() req: ParentRequest,
  ): Promise<{
    children: ChildBrief[];
    todayLessons: TodayLesson[];
    unreadCount: UnreadCount;
  }> {
    const { parentId, tenantSchema, tenantId } = this.assertParent(req);

    // 1. 拿当前 tenant 内 active binding 的学员 ids
    const bindings = await this.parentRepo.findChildrenByParent(parentId);
    const studentIds = bindings
      .filter(
        (b) =>
          b.bindingStatus === 'active' &&
          b.tenantId.toLowerCase() === tenantId.toLowerCase(),
      )
      .map((b) => b.studentId);

    if (studentIds.length === 0) {
      // 该 tenant 下无 active binding（理论上 middleware 已拦截，但保险）
      return {
        children: [],
        todayLessons: [],
        unreadCount: { feedbacks: 0, monthlyReports: 0, total: 0 },
      };
    }

    // 2. children 基础档案（含主带老师 + 校区）
    const children = await this.cside.findChildrenByIds(
      tenantSchema,
      studentIds,
    );

    // 3. 今日课表（UTC 当天 [00:00, 24:00)）
    const now = new Date();
    const startUtc = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
    );
    const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000);
    const todayLessons = await this.cside.findTodayLessons(
      tenantSchema,
      studentIds,
      startUtc,
      endUtc,
    );

    // 4. 未读消息计数
    const unreadCount = await this.cside.countUnread(tenantSchema, studentIds);

    return { children, todayLessons, unreadCount };
  }

  /**
   * GET /api/c/students/:studentId/profile — C 端学员档案
   *
   * 业务：
   *   - parent 必须 active 绑定该 student 在当前 tenant
   *   - 返脱敏档案（不返家长 phone / contract 金额 / family_address）
   */
  @Get('students/:studentId/profile')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async getStudentProfile(
    @Param('studentId') studentId: string,
    @Req() req: ParentRequest,
  ): Promise<ChildBrief> {
    if (!ULID_PATTERN.test(studentId)) {
      throw new BadRequestException('studentId must be 32-char ULID');
    }
    const { parentId, tenantSchema, tenantId } = this.assertParent(req);

    // RBAC: parent 必须 active 绑定该 student 在当前 tenant
    const bindings = await this.parentRepo.findChildrenByParent(parentId);
    const owns = bindings.find(
      (b) =>
        b.bindingStatus === 'active' &&
        b.studentId === studentId &&
        b.tenantId.toLowerCase() === tenantId.toLowerCase(),
    );
    if (!owns) {
      await this.tryAudit(tenantSchema, {
        actorUserId: parentId,
        action: 'c.student-profile.deny-binding',
        targetType: 'student',
        targetId: studentId,
        after: { parentId, tenantId },
        req,
      });
      throw new ForbiddenException('parent not bound to this student in this tenant');
    }

    // 读 child brief（脱敏字段，无 PII）
    const profile = await this.cside.findChildById(tenantSchema, studentId);
    if (!profile) {
      throw new NotFoundException(`student ${studentId} not found`);
    }
    return profile;
  }

  /**
   * GET /api/c/messages — 消息中心
   *
   * Query:
   *   unreadOnly?    'true'/'1' → 仅未读
   *   limit?         默认 20，上限 100
   *   offset?        默认 0
   *
   * Response:
   *   { items: MessageItem[], total, unreadCount }
   */
  @Get('messages')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async listMessages(
    @Query('unreadOnly') unreadOnlyRaw: string | undefined,
    @Query('limit') limitRaw: string | undefined,
    @Query('offset') offsetRaw: string | undefined,
    @Req() req: ParentRequest,
  ): Promise<{
    items: MessageItem[];
    total: number;
    unreadCount: UnreadCount;
  }> {
    const { parentId, tenantSchema, tenantId } = this.assertParent(req);
    const unreadOnly = unreadOnlyRaw === 'true' || unreadOnlyRaw === '1';
    const limit = this.parseInt(limitRaw, 20, 1, 100);
    const offset = this.parseInt(offsetRaw, 0, 0, 100000);

    const bindings = await this.parentRepo.findChildrenByParent(parentId);
    const studentIds = bindings
      .filter(
        (b) =>
          b.bindingStatus === 'active' &&
          b.tenantId.toLowerCase() === tenantId.toLowerCase(),
      )
      .map((b) => b.studentId);

    if (studentIds.length === 0) {
      return {
        items: [],
        total: 0,
        unreadCount: { feedbacks: 0, monthlyReports: 0, total: 0 },
      };
    }

    const [list, unread] = await Promise.all([
      this.cside.listMessages(tenantSchema, studentIds, unreadOnly, limit, offset),
      this.cside.countUnread(tenantSchema, studentIds),
    ]);
    return {
      items: list.items,
      total: list.total,
      unreadCount: unread,
    };
  }

  /**
   * PATCH /api/c/messages/:id/mark-read?type=feedback|monthly-report
   *
   * 标记单条消息已读
   *   - type=feedback         → lesson_feedbacks.parent_read_at
   *   - type=monthly-report   → monthly_reports.parent_read_at
   *
   * RBAC：UPDATE WHERE student_id IN (家长绑定学员 ids)，跨家长 → rowCount=0 → 403
   */
  @Patch('messages/:id/mark-read')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async markMessageRead(
    @Param('id') id: string,
    @Query('type') typeRaw: string | undefined,
    @Req() req: ParentRequest,
  ): Promise<{ id: string; type: MessageType; markedAt: string }> {
    if (!ULID_PATTERN.test(id)) {
      throw new BadRequestException('id must be 32-char ULID');
    }
    if (typeRaw !== 'feedback' && typeRaw !== 'monthly-report') {
      throw new BadRequestException(
        `type must be 'feedback' or 'monthly-report' (got '${typeRaw ?? ''}')`,
      );
    }
    const type: MessageType = typeRaw;
    const { parentId, tenantSchema, tenantId } = this.assertParent(req);

    const bindings = await this.parentRepo.findChildrenByParent(parentId);
    const studentIds = bindings
      .filter(
        (b) =>
          b.bindingStatus === 'active' &&
          b.tenantId.toLowerCase() === tenantId.toLowerCase(),
      )
      .map((b) => b.studentId);

    if (studentIds.length === 0) {
      throw new ForbiddenException('parent has no active binding in this tenant');
    }

    const ok = await this.cside.markMessageRead(
      tenantSchema,
      type,
      id,
      studentIds,
    );
    if (!ok) {
      // 不存在 或 不归属家长 — 一律 403 不泄露存在性
      await this.tryAudit(tenantSchema, {
        actorUserId: parentId,
        action: 'c.message.deny-mark-read',
        targetType: type,
        targetId: id,
        after: { parentId, tenantId, type },
        req,
      });
      throw new ForbiddenException('message not found or not owned by this parent');
    }
    // 5/20 P5 三审 production P1-1: 写操作 audit 补全（避免 PATCH mark-read 静默无审计）
    await this.tryAudit(tenantSchema, {
      actorUserId: parentId,
      action: 'c.message.mark-read',
      targetType: type,
      targetId: id,
      after: { parentId, tenantId, type },
      req,
    });
    return { id, type, markedAt: new Date().toISOString() };
  }

  // ===== helpers =====

  // ============================================================
  // 2026-05-22 波 C: 家长「待我决定老师变更」 (SSOT §6.5 闭环)
  //   B 端教务发起变更 → 推送家长 → 家长在 C 端「同意 / 拒绝」
  //   approved → 同事务 update student.assigned_teacher_id + 未来 schedules
  // ============================================================

  /**
   * GET /api/c/teacher-changes/pending — 列我的 pending 老师变更请求
   *
   * 走 ParentJwtStrategy + tenant.middleware (req.parent.sub 已挂)
   * 服务端用 parent_id = req.parent.sub 过滤 — 跨家长 → 自动 0 行
   */
  @Get('teacher-changes/pending')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async listMyPendingTeacherChanges(
    @Req() req: ParentRequest,
  ): Promise<{ items: Awaited<ReturnType<TeacherChangeRequestService['listPendingByParent']>> }> {
    const { parentId, tenantSchema } = this.assertParent(req);
    if (!this.tcrService) {
      throw new BadRequestException('TeacherChangeRequestService not wired');
    }
    const items = await this.tcrService.listPendingByParent(tenantSchema, parentId);
    return { items };
  }

  /**
   * PATCH /api/c/teacher-changes/:id/decide — 家长同意/拒绝
   *
   * Body: { decision: 'approved' | 'rejected', rejectReason?: string }
   * approved → 自动 update student.assigned_teacher_id + 未来 schedules (service 同事务)
   *
   * RBAC: tcr.parent_id === req.parent.sub (service 内 SELECT FOR UPDATE 校验)
   *   跨家长 → service 抛 PARENT_MISMATCH BadRequest
   */
  @Patch('teacher-changes/:id/decide')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async decideTeacherChange(
    @Param('id') id: string,
    @Body() body: { decision: 'approved' | 'rejected'; rejectReason?: string },
    @Req() req: ParentRequest,
  ): Promise<{ id: string; decision: string; schedulesUpdated: number }> {
    if (!ULID_PATTERN.test(id)) {
      throw new BadRequestException('id must be 32-char ULID');
    }
    if (body.decision !== 'approved' && body.decision !== 'rejected') {
      throw new BadRequestException(`decision must be 'approved' or 'rejected'`);
    }
    const { parentId, tenantSchema } = this.assertParent(req);
    if (!this.tcrService) {
      throw new BadRequestException('TeacherChangeRequestService not wired');
    }
    const result = await this.tcrService.parentDecide(
      tenantSchema,
      id,
      parentId,
      body.decision,
      body.rejectReason,
    );
    await this.tryAudit(tenantSchema, {
      actorUserId: parentId,
      action: body.decision === 'approved'
        ? 'teacher.change-approved-by-parent'
        : 'teacher.change-rejected-by-parent',
      targetType: 'teacher_change_request',
      targetId: id,
      before: null,
      after: { schedulesUpdated: result.schedulesUpdated },
      req,
    });
    return { id, decision: body.decision, schedulesUpdated: result.schedulesUpdated };
  }

  /**
   * 校验 req.parent 存在并提取 parentId / tenantSchema / tenantId
   * tenant.middleware 已挂上，此处仅兜底
   */
  private assertParent(req: ParentRequest): {
    parentId: string;
    tenantSchema: string;
    tenantId: string;
  } {
    const parentId = req.parent?.sub;
    if (!parentId) {
      throw new ForbiddenException('parent JWT required (middleware should have set)');
    }
    const tenantSchema = req.tenantSchema;
    if (!tenantSchema) {
      throw new BadRequestException(
        'tenant context required (set x-tenant-schema header or body.tenantSchema)',
      );
    }
    const tenantId = tenantSchema.replace(/^tenant_/, '');
    return { parentId, tenantSchema, tenantId };
  }

  private parseInt(
    raw: string | undefined,
    defaultVal: number,
    min: number,
    max: number,
  ): number {
    if (!raw) return defaultVal;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n)) return defaultVal;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  private async tryAudit(
    tenantSchema: string,
    entry: {
      actorUserId: string;
      action: string;
      targetType: string;
      targetId: string | null;
      before?: Record<string, unknown> | null;
      after?: Record<string, unknown> | null;
      req: ParentRequest;
    },
  ): Promise<void> {
    if (!this.auditLog) return;
    try {
      await this.auditLog.log(tenantSchema, {
        actorUserId: entry.actorUserId,
        actorRole: normalizeActorRole('parent'),
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        before: entry.before ?? null,
        after: entry.after ?? null,
        ip: entry.req.ip ?? null,
        userAgent:
          (entry.req.headers?.['user-agent'] as string | undefined) ?? null,
        requestId:
          (entry.req.headers?.['x-request-id'] as string | undefined) ?? null,
      });
    } catch {
      // fail-open
    }
  }
}
