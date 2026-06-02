import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Optional,
  Param,
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
import { ContentModerationService } from '../security/content-moderation.service';
import {
  ActorRole,
  AuditLogRepository,
  normalizeActorRole,
} from './audit-log.repository';
import {
  CommunicationType,
  ParentCommunication,
  ParentCommunicationRepository,
} from './parent-communication.repository';
import { StudentRepository } from './student.repository';
import { ulid } from 'ulid';

/** genId32 — 全库约定（5/31 教训：新建路径 id 必用此，不用裸 ulid()） */
function genId32(): string {
  return ulid().padEnd(32, '0').slice(0, 32);
}

const COMMUNICATION_TYPES: readonly CommunicationType[] = [
  'wechat',
  'phone',
  'in_person',
];

/**
 * ParentCommunicationController — V67 (SSOT §5.4) 教务家长沟通记录
 *
 * 来源：SSOT §5.4 parent_communication 家长沟通记录（5/16 拍板；2026-06-02 走查 B 定 spec）。
 *   走查 B 起因：教务在学员档案无反馈/沟通填写入口（只有老师点评区）。
 *   教务线 = 家长沟通（本对象）；老师线 = 上课点评（lesson_feedback，独立对象）。
 *
 * 路径前缀 /api/db/*（全 POST：写动作 + 读列表统一 body 带 tenantSchema）：
 *   POST /db/communications                       教务记录家长沟通     @Roles academic/academic_admin
 *   POST /db/students/:studentId/communications   列出学员家长沟通     @Roles academic/academic_admin/boss/admin
 *
 * 横切（仿 TrialController）：
 *   - 全 @UseGuards(TenantScopeGuard, RbacGuard) — 跨租户 403 + 角色门。
 *   - campusId 一律取自 JWT（禁信前端传参防伪造跨校）；缺 campusId → 403。
 *   - 跨校校验：student.campusId（家庭主档 customers.campus_id 派生，StudentRepository.findAssignmentInfo）
 *     === caller campus，跨校 403（仿 trial）。
 *   - 写动作 audit_log（communication.create）。
 *   - 自由文本（content / followUp）过 ContentModerationService.enforceStaffText（§24，全 reject）。
 *   - 写动作配 IdempotencyInterceptor（全局已注册；此处显式标注语义）。
 *
 * RBAC（SSOT §5.4）：
 *   - 写 = [academic, academic_admin]（教务双层，「教务主要写入」）。
 *   - 读 = [academic, academic_admin, boss, admin]（教务线 + 校长/管理员监管）。
 *     teacher/sales/marketing/finance/hr/parent 均不可读（教务内部家长沟通记录，
 *     非教学/非商业/非家长可见）→ 由 @Roles 排除（无需 scope helper），仍做本校 campus 校验。
 */
@Controller('db')
@UseGuards(TenantScopeGuard, RbacGuard)
export class ParentCommunicationController {
  private readonly logger = new Logger(ParentCommunicationController.name);

  constructor(
    private readonly commRepo: ParentCommunicationRepository,
    private readonly studentRepo: StudentRepository,
    // #24: B 端自由文本内容安全（@Global SecurityModule 注入，生产必有）
    private readonly contentModeration: ContentModerationService,
    // @Optional：unit spec 直接 new 不传也能跑；fail-open 不阻塞主业务
    @Optional() private readonly auditLog?: AuditLogRepository,
  ) {}

  // ============================================================
  // helpers（与 TrialController 同纪律）
  // ============================================================
  /** 取调用者本校 campusId（缺失 → 403，禁信前端） */
  private requireCampusId(req: AuthenticatedRequest): string {
    const campusId = req.user?.campusId;
    if (!campusId) {
      throw new ForbiddenException(
        'COMM_NO_CAMPUS: caller must have a campusId scope (single-campus; admin must supply campus context)',
      );
    }
    return campusId;
  }

  private requireUserId(req: AuthenticatedRequest): string {
    const userId = req.user?.sub;
    if (!userId) throw new BadRequestException('user sub required');
    return userId;
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

  private requireStudentId(studentId: string): void {
    if (!studentId || studentId.length !== 32) {
      throw new BadRequestException('studentId must be 32-char ULID');
    }
  }

  /**
   * 跨校校验：学员家庭校区必须 === 调用者 JWT 校区。
   *   学员不存在 / 已软删 → 404（findAssignmentInfo 返 null）。
   *   学员家庭无校区（campusId null）→ 403（无法证明同校，保守拒）。
   */
  private async assertSameCampus(
    tenantSchema: string,
    studentId: string,
    callerCampus: string,
  ): Promise<void> {
    const info = await this.studentRepo.findAssignmentInfo(tenantSchema, studentId);
    if (!info) {
      throw new NotFoundException(`student ${studentId} not found`);
    }
    if (info.campusId !== callerCampus) {
      throw new ForbiddenException(
        `COMM_CROSS_CAMPUS: student campus=${info.campusId ?? 'null'} != caller campus=${callerCampus}`,
      );
    }
  }

  // ============================================================
  // 1. 教务记录家长沟通（create）
  // ============================================================
  /**
   * POST /db/communications
   * body: { tenantSchema, studentId, communicationDate, type, content, followUp? }
   *
   * 1. 入参校验（studentId 32 位、type 枚举、communicationDate 合法日期、content 非空）。
   * 2. 跨校校验（student.campus === caller campus；学员不存在 → 404）。
   * 3. 自由文本（content / followUp）过内容安全（risky → 400 不落库）。
   * 4. 建记录（id=genId32，created_by=JWT.sub，campus_id=JWT.campus）+ audit communication.create。
   */
  @Post('communications')
  @Roles('academic', 'academic_admin')
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body()
    body: {
      tenantSchema: string;
      studentId: string;
      communicationDate: string;
      type: CommunicationType;
      content: string;
      followUp?: string;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<ParentCommunication> {
    if (!body?.tenantSchema) throw new BadRequestException('tenantSchema required');
    this.requireStudentId(body.studentId);
    if (!COMMUNICATION_TYPES.includes(body.type)) {
      throw new BadRequestException(
        `type must be one of ${COMMUNICATION_TYPES.join('|')}`,
      );
    }
    if (!body.content || !body.content.trim()) {
      throw new BadRequestException('content required');
    }
    if (!body.communicationDate || !/^\d{4}-\d{2}-\d{2}$/.test(body.communicationDate)) {
      throw new BadRequestException('communicationDate must be YYYY-MM-DD');
    }
    const parsedDate = new Date(`${body.communicationDate}T00:00:00Z`);
    if (isNaN(parsedDate.getTime())) {
      throw new BadRequestException('communicationDate must be a valid date');
    }
    const campusId = this.requireCampusId(req);
    const userId = this.requireUserId(req);

    // 2. 跨校校验（学员不存在 → 404；他校学员 → 403）。先于内容安全外部 API（省微信配额）。
    await this.assertSameCampus(body.tenantSchema, body.studentId, campusId);

    // 3. 自由文本（content + followUp）过内容安全 —— 写库前拦截违规（全 reject）。
    await this.contentModeration.enforceStaffText(
      body.tenantSchema,
      [body.content, body.followUp],
      {
        action: 'communication',
        targetType: 'parent_communication',
        targetId: null,
        req,
      },
    );

    // 4. 建记录
    const id = genId32();
    const created = await this.commRepo.create(body.tenantSchema, {
      id,
      studentId: body.studentId,
      campusId,
      communicationDate: body.communicationDate,
      type: body.type,
      content: body.content.trim(),
      followUp: body.followUp?.trim() || null,
      createdBy: userId,
    });

    await this.tryAudit(body.tenantSchema, {
      actorUserId: userId,
      ...this.auditCtx(req),
      action: 'communication.create',
      targetType: 'parent_communication',
      targetId: id,
      before: null,
      after: {
        studentId: body.studentId,
        campusId,
        communicationDate: created.communicationDate,
        type: created.type,
      },
    });

    return created;
  }

  // ============================================================
  // 2. 列出学员家长沟通记录（list）
  // ============================================================
  /**
   * POST /db/students/:studentId/communications
   * body: { tenantSchema, limit?, offset? }
   *   @Roles 已排除 teacher/sales/marketing/finance/hr/parent（教务内部记录）。
   *   本校校验：student.campus === caller campus（跨校 403；学员不存在 → 404）。
   */
  @Post('students/:studentId/communications')
  @Roles('academic', 'academic_admin', 'boss', 'admin')
  @HttpCode(HttpStatus.OK)
  async listByStudent(
    @Param('studentId') studentId: string,
    @Body() body: { tenantSchema: string; limit?: number; offset?: number },
    @Req() req: AuthenticatedRequest,
  ): Promise<{ items: ParentCommunication[] }> {
    if (!body?.tenantSchema) throw new BadRequestException('tenantSchema required');
    this.requireStudentId(studentId);
    const campusId = this.requireCampusId(req);

    // 本校校验（学员不存在 → 404；他校学员 → 403）
    await this.assertSameCampus(body.tenantSchema, studentId, campusId);

    const items = await this.commRepo.listByStudent(body.tenantSchema, studentId, {
      limit: body.limit,
      offset: body.offset,
    });
    return { items };
  }
}
