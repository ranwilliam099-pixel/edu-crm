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
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  TeacherRatingRepository,
  TeacherRatingEntry,
} from './teacher-rating.repository';
import { ParentRepository } from './parent.repository';
import { ParentSelfGuard } from '../auth/parent-self.guard';
import { AuditLogRepository, normalizeActorRole } from './audit-log.repository';
import { SecurityService, MsgSecScene } from '../security/security.service';

/**
 * TeacherRatingController — P4-Y 任务 2026-05-20
 *
 * 路由：POST /api/db/teacher-ratings
 *
 * 业务（家长评老师 5 星 + 文本 + tags）：
 *   1. RBAC：仅 parent JWT（family-owner scope）— ParentSelfGuard 守门 + body.parentId === jwt.parentId
 *   2. teacher 必须在 parent 孩子的真实师生关系内（students.assigned_teacher_id 或 schedules 历史或 bindings）
 *   3. binding 校验：parent 必须 active 绑定该 student（parent_student_bindings）
 *   4. tenant 校验：binding.tenant_id 与 body.tenantSchema 一致（parent 跨多机构需明示当前 tenant）
 *   5. content 必走 wx.security.msgSecCheck（risky → 400；review → 放行但 audit 留 violation）
 *   6. UNIQUE(parent, teacher, student) 重复 → upsert（PATCH 而非 INSERT）
 *   7. audit_log action='teacher.rating.created' / 'teacher.rating.updated' / 'teacher.rating.deny-*'
 *
 * 不挂 TenantScopeGuard：
 *   - parent JWT 不含 tenantId（跨机构身份），TenantScopeGuard 比对 user.tenantId 不适用
 *   - tenant.middleware.requireParentDbUser 已校验 binding × tenant 真实关系 → 已挂 req.tenantSchema
 *   - 本 controller 自行做 tenant×parent×student×teacher 四元一致性校验
 *
 * 限流：30 req/min/IP（家长高频但 msgSecCheck 触发微信侧 access_token 限流）
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

// P0 真生产 bug 修 (5/20): 一致性 — 同 c-side.controller，放宽到 alphanumeric
const ULID_PATTERN = /^[0-9A-Z]{32}$/i;
const TAGS_MAX = 10;
const TAG_MAX_LEN = 32;
const CONTENT_MAX_LEN = 2000;

@Controller('db/teacher-ratings')
@UseGuards(ParentSelfGuard)
export class TeacherRatingController {
  private readonly logger = new Logger(TeacherRatingController.name);

  constructor(
    private readonly ratingRepo: TeacherRatingRepository,
    private readonly parentRepo: ParentRepository,
    private readonly security: SecurityService,
    @Optional() private readonly auditLog?: AuditLogRepository,
  ) {}

  /**
   * POST /api/db/teacher-ratings — 家长评老师
   *
   * Body:
   *   id          32-char ULID（前端生成）
   *   parentId    32-char ULID（必须 === jwt.parentId）
   *   teacherId   32-char ULID
   *   studentId   32-char ULID
   *   tenantId    租户 ID（不带 tenant_ 前缀）
   *   tenantSchema 'tenant_xxx'（与 tenantId 二选一；tenant.middleware 已校验绑定）
   *   stars       1-5 整数
   *   content?    文本（≤ 2000，必走 msgSecCheck）
   *   tags?       ['#耐心', ...]（≤ 10 tag，每个 ≤ 32 char）
   *   openid?     微信 openid（用于 msgSecCheck v2；缺省走 v1）
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async createRating(
    @Body()
    body: {
      id?: string;
      parentId?: string;
      teacherId?: string;
      studentId?: string;
      tenantId?: string;
      tenantSchema?: string;
      stars?: number;
      content?: string;
      tags?: string[];
      openid?: string;
    },
    @Req() req: ParentRequest,
  ): Promise<{
    ratingId: string;
    success: boolean;
    upsert: 'inserted' | 'updated';
    contentReviewed: boolean;
  }> {
    // ===== 1. 参数校验 =====
    const id = this.requireUlid(body.id, 'id');
    const parentId = this.requireUlid(body.parentId, 'parentId');
    const teacherId = this.requireUlid(body.teacherId, 'teacherId');
    const studentId = this.requireUlid(body.studentId, 'studentId');

    if (
      typeof body.stars !== 'number' ||
      !Number.isInteger(body.stars) ||
      body.stars < 1 ||
      body.stars > 5
    ) {
      throw new BadRequestException('stars must be integer 1-5');
    }
    const stars = body.stars;

    let content: string | null = null;
    if (body.content !== undefined && body.content !== null && body.content !== '') {
      if (typeof body.content !== 'string') {
        throw new BadRequestException('content must be string');
      }
      const trimmed = body.content.trim();
      if (trimmed.length > CONTENT_MAX_LEN) {
        throw new BadRequestException(`content length > ${CONTENT_MAX_LEN}`);
      }
      content = trimmed.length === 0 ? null : trimmed;
    }

    let tags: string[] | null = null;
    if (body.tags !== undefined && body.tags !== null) {
      if (!Array.isArray(body.tags)) {
        throw new BadRequestException('tags must be string[]');
      }
      if (body.tags.length > TAGS_MAX) {
        throw new BadRequestException(`tags length > ${TAGS_MAX}`);
      }
      for (const t of body.tags) {
        if (typeof t !== 'string' || t.length === 0 || t.length > TAG_MAX_LEN) {
          throw new BadRequestException('each tag must be 1-32 chars');
        }
      }
      tags = body.tags.length === 0 ? null : body.tags;
    }

    // ===== 2. RBAC：parent 自身 + tenant.middleware 已校验 parent×tenant 绑定 =====
    const jwtParentSub = req.parent?.sub;
    if (!jwtParentSub) {
      // 不应到此（tenant.middleware 已挂），兜底
      throw new ForbiddenException('parent JWT required');
    }
    if (jwtParentSub !== parentId) {
      await this.tryAudit(req.tenantSchema, {
        actorUserId: jwtParentSub,
        actorRole: 'parent',
        action: 'teacher.rating.deny-parent-mismatch',
        targetType: 'teacher',
        targetId: teacherId,
        after: { bodyParentId: parentId, jwtParentId: jwtParentSub, studentId },
        req,
      });
      throw new ForbiddenException('parentId must equal jwt.parentId');
    }

    const tenantSchema = req.tenantSchema;
    if (!tenantSchema) {
      throw new BadRequestException('tenant context missing (middleware should have set)');
    }

    // ===== 3. binding 校验：parent 必须 active 绑定该 student 且在当前 tenant =====
    const bindings = await this.parentRepo.findChildrenByParent(parentId);
    const tenantId = tenantSchema.replace(/^tenant_/, '');
    const validBinding = bindings.find(
      (b) =>
        b.bindingStatus === 'active' &&
        b.studentId === studentId &&
        b.tenantId.toLowerCase() === tenantId.toLowerCase(),
    );
    if (!validBinding) {
      await this.tryAudit(tenantSchema, {
        actorUserId: parentId,
        actorRole: 'parent',
        action: 'teacher.rating.deny-binding',
        targetType: 'student',
        targetId: studentId,
        after: { parentId, teacherId, tenantId },
        req,
      });
      throw new ForbiddenException(
        'parent not bound to this student in this tenant',
      );
    }

    // ===== 4. teacher × student 真实关系校验 =====
    const isTeacher = await this.ratingRepo.isTeacherForStudent(
      tenantSchema,
      teacherId,
      studentId,
    );
    if (!isTeacher) {
      await this.tryAudit(tenantSchema, {
        actorUserId: parentId,
        actorRole: 'parent',
        action: 'teacher.rating.deny-teacher-relation',
        targetType: 'teacher',
        targetId: teacherId,
        after: { parentId, studentId, teacherId },
        req,
      });
      throw new ForbiddenException(
        'teacher has no schedule/binding/owner relation with this student',
      );
    }

    // ===== 5. content 过 wx.security.msgSecCheck（违规则拒；review 通过但 audit 留痕）=====
    let contentReviewed = false;
    if (content) {
      try {
        const check =
          body.openid && body.openid.length > 0
            ? await this.security.msgSecCheck(
                content,
                body.openid,
                MsgSecScene.COMMENT,
              )
            : await this.security.serverSideCheckContent(content);
        if (check.suggest === 'risky') {
          await this.tryAudit(tenantSchema, {
            actorUserId: parentId,
            actorRole: 'parent',
            action: 'teacher.rating.deny-content-violation',
            targetType: 'teacher',
            targetId: teacherId,
            after: {
              parentId,
              studentId,
              suggest: check.suggest,
              errcode: check.errcode,
              // 不写入 content 明文（PII / 违规内容防泄露）
              contentLen: content.length,
            },
            req,
          });
          throw new BadRequestException('content violates content policy');
        }
        if (check.suggest === 'review') {
          contentReviewed = true;
          await this.tryAudit(tenantSchema, {
            actorUserId: parentId,
            actorRole: 'parent',
            action: 'teacher.rating.content-review',
            targetType: 'teacher',
            targetId: teacherId,
            after: {
              parentId,
              studentId,
              suggest: 'review',
              contentLen: content.length,
            },
            req,
          });
        }
      } catch (err) {
        // SecurityService 网络/凭据失败 → fail-open 但 audit 留痕
        // ⚠️ 注意：上面的 BadRequestException 是业务拒绝，不应被吞
        if (err instanceof BadRequestException) throw err;
        this.logger.warn(
          `msgSecCheck failed (fail-open): ${(err as Error).message}`,
        );
        await this.tryAudit(tenantSchema, {
          actorUserId: parentId,
          actorRole: 'parent',
          action: 'teacher.rating.content-check-error',
          targetType: 'teacher',
          targetId: teacherId,
          after: {
            parentId,
            studentId,
            err: (err as Error).message,
            contentLen: content.length,
          },
          req,
        });
        contentReviewed = true;
      }
    }

    // ===== 6. upsert =====
    const { entry, isInsert } = await this.ratingRepo.upsert(tenantSchema, {
      id,
      parentId,
      teacherId,
      studentId,
      stars,
      content,
      tags,
    });

    // ===== 7. audit_log（业务成功）=====
    await this.tryAudit(tenantSchema, {
      actorUserId: parentId,
      actorRole: 'parent',
      action: isInsert ? 'teacher.rating.created' : 'teacher.rating.updated',
      targetType: 'teacher',
      targetId: teacherId,
      after: {
        ratingId: entry.id,
        studentId,
        stars,
        hasContent: content !== null,
        contentLen: content ? content.length : 0,
        tagsCount: tags ? tags.length : 0,
        contentReviewed,
      },
      req,
    });

    return {
      ratingId: entry.id,
      success: true,
      upsert: isInsert ? 'inserted' : 'updated',
      contentReviewed,
    };
  }

  // ===== helpers =====

  private requireUlid(v: unknown, field: string): string {
    if (typeof v !== 'string' || !ULID_PATTERN.test(v)) {
      throw new BadRequestException(`${field} must be 32-char ULID`);
    }
    return v;
  }

  private async tryAudit(
    tenantSchema: string | undefined,
    entry: {
      actorUserId: string;
      actorRole: 'parent';
      action: string;
      targetType: string;
      targetId: string | null;
      before?: Record<string, unknown> | null;
      after?: Record<string, unknown> | null;
      req: ParentRequest;
    },
  ): Promise<void> {
    if (!this.auditLog || !tenantSchema) return;
    try {
      await this.auditLog.log(tenantSchema, {
        actorUserId: entry.actorUserId,
        actorRole: normalizeActorRole(entry.actorRole),
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        before: entry.before ?? null,
        after: entry.after ?? null,
        ip: entry.req.ip ?? null,
        userAgent: (entry.req.headers?.['user-agent'] as string | undefined) ?? null,
        requestId:
          (entry.req.headers?.['x-request-id'] as string | undefined) ?? null,
      });
    } catch {
      // fail-open
    }
  }
}
