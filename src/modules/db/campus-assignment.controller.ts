import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Logger,
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
import {
  CampusAssignmentConfigRepository,
} from './campus-assignment-config.repository';
import { StudentRepository } from './student.repository';
import { UserRepository } from './user.repository';
import { ASSIGNMENT_POOL_ROLES } from './student-assignment.service';
import {
  ActorRole,
  AuditLogRepository,
  normalizeActorRole,
} from './audit-log.repository';

/**
 * CampusAssignmentController — V63 (Phase 3) 学员→教务分配机制（校长侧）
 *
 * 来源：../edu-mp-sandbox/docs/2026-06-01-业务链方案-试听激活分配反馈.md Phase 3（#8）
 *
 * 路径前缀（混合）：
 *   POST /db/campus-config/assignment       读本校分配配置（自动分配开关）
 *   POST /db/campus-config/assignment/set   设自动分配开关（upsert + audit）
 *   POST /db/students/pending-assignment    本校待分配学员列表（校长手动派数据源）
 *   POST /db/students/:studentId/assign-academic  校长手动分配（校验本校在职 academic + audit）
 *   POST /db/academics/campus-list          本校在职教务选择器（手动分配选 academic）
 *
 * RBAC：全 @Roles('boss','admin') —— 校长配置 + 手动分配（SSOT §5.3 配置/分配 = 老板/校长）。
 *
 * campusId 一律取自 JWT（禁信前端传参防伪造跨校）：
 *   - boss = 单校 role，campusId 必有；缺失 → 403（配置异常，不兜底）。
 *   - admin = 跨校 role，campusId 可能为 null；本组端点是「本校」语义 → 缺 campusId 同样 403
 *     （admin 若要按校配置须带 campusId 上下文；与 contract.pending-activation finance 缺校 403 同纪律）。
 *
 * 写动作（set / assign-academic）配 audit_log；IdempotencyInterceptor 全局已注册（显式标注语义）。
 */
@Controller('db')
@UseGuards(TenantScopeGuard, RbacGuard)
export class CampusAssignmentController {
  private readonly logger = new Logger(CampusAssignmentController.name);

  constructor(
    private readonly configRepo: CampusAssignmentConfigRepository,
    private readonly studentRepo: StudentRepository,
    private readonly userRepo: UserRepository,
    @Optional() private readonly auditLog?: AuditLogRepository,
  ) {}

  /** 取调用者本校 campusId（缺失 → 403，禁信前端） */
  private requireCampusId(req: AuthenticatedRequest): string {
    const campusId = req.user?.campusId;
    if (!campusId) {
      throw new ForbiddenException(
        'ASSIGNMENT_NO_CAMPUS: caller must have a campusId scope (boss single-campus; admin must supply campus context)',
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

  // ============================================================
  // 1. 读本校分配配置
  // ============================================================
  /**
   * 读本校分配配置（自动分配开关）。无配置行 → 默认 autoAssignAcademic=false。
   */
  @Post('campus-config/assignment')
  @Roles('boss', 'admin')
  @HttpCode(HttpStatus.OK)
  async getAssignmentConfig(
    @Body() body: { tenantSchema: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<{ campusId: string; autoAssignAcademic: boolean }> {
    if (!body?.tenantSchema) throw new BadRequestException('tenantSchema required');
    const campusId = this.requireCampusId(req);
    const cfg = await this.configRepo.get(body.tenantSchema, campusId);
    return {
      campusId,
      autoAssignAcademic: cfg?.autoAssignAcademic ?? false,
    };
  }

  // ============================================================
  // 2. 设自动分配开关（upsert + audit）
  // ============================================================
  @Post('campus-config/assignment/set')
  @Roles('boss', 'admin')
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(HttpStatus.OK)
  async setAssignmentConfig(
    @Body() body: { tenantSchema: string; autoAssignAcademic: boolean },
    @Req() req: AuthenticatedRequest,
  ): Promise<{ campusId: string; autoAssignAcademic: boolean }> {
    if (!body?.tenantSchema) throw new BadRequestException('tenantSchema required');
    if (typeof body.autoAssignAcademic !== 'boolean') {
      throw new BadRequestException('autoAssignAcademic (boolean) required');
    }
    const campusId = this.requireCampusId(req);
    const userId = req.user?.sub ?? null;

    const before = await this.configRepo.get(body.tenantSchema, campusId);
    const updated = await this.configRepo.upsertAutoAssign(
      body.tenantSchema,
      campusId,
      body.autoAssignAcademic,
      userId ?? '',
    );

    await this.tryAudit(body.tenantSchema, {
      actorUserId: userId,
      ...this.auditCtx(req),
      action: 'campus.assignment-config-set',
      targetType: 'campus',
      targetId: campusId,
      before: { autoAssignAcademic: before?.autoAssignAcademic ?? false },
      after: { autoAssignAcademic: updated.autoAssignAcademic },
    });

    return {
      campusId,
      autoAssignAcademic: updated.autoAssignAcademic,
    };
  }

  // ============================================================
  // 3. 本校待分配学员列表（校长手动派数据源）
  // ============================================================
  @Post('students/pending-assignment')
  @Roles('boss', 'admin')
  @HttpCode(HttpStatus.OK)
  async pendingAssignment(
    @Body() body: { tenantSchema: string; limit?: number; offset?: number },
    @Req() req: AuthenticatedRequest,
  ): Promise<{
    items: Array<{
      id: string;
      studentName: string;
      gradeOrAge: string | null;
      intendedSubject: string | null;
      customerId: string;
      parentName: string | null;
      createdAt: string;
    }>;
  }> {
    if (!body?.tenantSchema) throw new BadRequestException('tenantSchema required');
    const campusId = this.requireCampusId(req);
    const items = await this.studentRepo.listPendingAssignmentByCampus(
      body.tenantSchema,
      campusId,
      {
        limit: body.limit ? Math.min(body.limit, 200) : 100,
        offset: body.offset ?? 0,
      },
    );
    return { items };
  }

  // ============================================================
  // 4. 校长手动分配（校验本校在职 academic + audit）
  // ============================================================
  @Post('students/:studentId/assign-academic')
  @Roles('boss', 'admin')
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(HttpStatus.OK)
  async assignAcademic(
    @Param('studentId') studentId: string,
    @Body() body: { tenantSchema: string; academicId: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<{ studentId: string; assignedAcademicId: string }> {
    if (!body?.tenantSchema) throw new BadRequestException('tenantSchema required');
    if (!studentId || studentId.length !== 32) {
      throw new BadRequestException('studentId must be 32-char ULID');
    }
    if (!body.academicId || body.academicId.length !== 32) {
      throw new BadRequestException('academicId must be 32-char ULID');
    }
    const campusId = this.requireCampusId(req);
    const userId = req.user?.sub ?? null;

    // 1. 学员存在 + 拿前态（before）+ 同校校验（学员家庭校区须 = 调用者本校）
    const info = await this.studentRepo.findAssignmentInfo(
      body.tenantSchema,
      studentId,
    );
    if (!info) {
      // 学员不存在 → 400（手动分配是明确目标动作，非枚举侧信道）
      throw new BadRequestException(`student ${studentId} not found`);
    }
    if (info.campusId !== campusId) {
      // 跨校分配 → 403（校长只能分配本校学员）
      throw new ForbiddenException(
        `ASSIGN_CROSS_CAMPUS: student campus=${info.campusId ?? 'null'} != caller campus=${campusId}`,
      );
    }

    // 2. 校验目标 academicId 是本校在职教务（池角色与发牌一致）
    const ok = await this.userRepo.isActiveAcademicInCampus(
      body.tenantSchema,
      body.academicId,
      campusId,
      ASSIGNMENT_POOL_ROLES,
    );
    if (!ok) {
      throw new BadRequestException(
        `ASSIGN_INVALID_ACADEMIC: ${body.academicId} is not an active academic in campus ${campusId}`,
      );
    }

    // 3. set + audit（before/after）
    await this.studentRepo.setAssignedAcademic(
      body.tenantSchema,
      studentId,
      body.academicId,
      userId ?? '',
    );

    await this.tryAudit(body.tenantSchema, {
      actorUserId: userId,
      ...this.auditCtx(req),
      action: 'student.manual_assigned',
      targetType: 'student',
      targetId: studentId,
      before: { assignedAcademicId: info.assignedAcademicId },
      after: { assignedAcademicId: body.academicId, campusId },
    });

    return { studentId, assignedAcademicId: body.academicId };
  }

  // ============================================================
  // 5. 本校在职教务选择器（手动分配选 academic）
  // ============================================================
  @Post('academics/campus-list')
  @Roles('boss', 'admin')
  @HttpCode(HttpStatus.OK)
  async academicsCampusList(
    @Body() body: { tenantSchema: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<{ items: Array<{ id: string; name: string; role: string }> }> {
    if (!body?.tenantSchema) throw new BadRequestException('tenantSchema required');
    const campusId = this.requireCampusId(req);
    const items = await this.userRepo.listActiveAcademicsInCampus(
      body.tenantSchema,
      campusId,
      ASSIGNMENT_POOL_ROLES,
    );
    return { items };
  }
}
