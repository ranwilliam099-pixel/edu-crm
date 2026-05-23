import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Optional,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';
import { RbacGuard } from '../../guards/rbac.guard';
import { Roles } from '../../guards/rbac.decorator';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';
import {
  TeacherChangeRequestService,
  TeacherChangeRequest,
} from './teacher-change-request.service';
import { AuditLogRepository, normalizeActorRole } from './audit-log.repository';

/**
 * TeacherChangeRequestController — SSOT §6.5「改老师 = 家长同意」endpoint
 *
 * 教务端：
 *   POST /db/teacher-changes/request               发起变更
 *   GET  /db/teacher-changes/pending?campusId=     本校 pending 列表
 *   POST /db/teacher-changes/:id/cancel            撤回 pending
 *
 * 家长 C 端：
 *   GET  /db/teacher-changes/parent-pending        我的 pending (取 JWT.parentId)
 *   POST /db/teacher-changes/:id/parent-decide     同意/拒绝
 *
 * audit_log 留痕 3 事件 (SSOT §6.5):
 *   - teacher.change-requested-by-academic
 *   - teacher.change-approved-by-parent
 *   - teacher.change-rejected-by-parent
 *
 * 读路径 @SkipThrottle (academic-home todos 可能命中, 不限流)
 */
@SkipThrottle()
@Controller('db/teacher-changes')
@UseGuards(TenantScopeGuard, RbacGuard)
export class TeacherChangeRequestController {
  constructor(
    private readonly svc: TeacherChangeRequestService,
    @Optional() private readonly auditLog?: AuditLogRepository,
  ) {}

  /**
   * 教务发起变更请求 (SSOT §6.5 step 1)
   */
  @Post('request')
  @Roles('academic', 'academic_admin')
  @HttpCode(HttpStatus.OK)
  async createRequest(
    @Body() body: {
      tenantSchema: string;
      studentId: string;
      toTeacherId: string;
      reason?: string;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<{ id: string }> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    if (!body.studentId || body.studentId.length !== 32) {
      throw new BadRequestException('studentId must be 32-char ULID');
    }
    if (!body.toTeacherId || body.toTeacherId.length !== 32) {
      throw new BadRequestException('toTeacherId must be 32-char ULID');
    }
    const userId = req.user?.sub;
    const campusId = req.user?.campusId;
    if (!userId) throw new BadRequestException('user sub required');
    if (!campusId) {
      throw new ForbiddenException(
        'ACADEMIC_MISSING_CAMPUS_ID: academic 必有 jwt.campusId',
      );
    }

    const result = await this.svc.request({
      tenantSchema: body.tenantSchema,
      studentId: body.studentId,
      toTeacherId: body.toTeacherId,
      reason: body.reason,
      requestedByUserId: userId,
      campusId,
    });

    await this._tryAudit(body.tenantSchema, req, 'teacher.change-requested-by-academic', result.id);
    return result;
  }

  /**
   * 教务/校长查本校 pending 列表 (academic-home todos 数据源)
   */
  @Get('pending')
  @Roles('academic', 'academic_admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async listPending(
    @Query('tenantSchema') tenantSchema: string,
    @Query('campusId') campusId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ items: TeacherChangeRequest[] }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    if (!campusId) throw new BadRequestException('campusId required');

    // A04 防御: academic/boss 强制 jwt.campusId
    const jwtCampus = req.user?.campusId;
    if (!jwtCampus || jwtCampus !== campusId) {
      throw new ForbiddenException(
        'CROSS_CAMPUS_DENIED: 只能查本校 pending (jwt.campusId)',
      );
    }

    const items = await this.svc.listPendingByCampus(tenantSchema, campusId);
    return { items };
  }

  /**
   * 列本校可选 teacher (academic 发起变更老师 selector 用)
   *   minimal shape (id/name/subjects), 不暴露 phone 等 PII
   */
  @Get('eligible-teachers')
  @Roles('academic', 'academic_admin', 'admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async listEligibleTeachers(
    @Query('tenantSchema') tenantSchema: string,
    @Query('campusId') campusId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ items: Awaited<ReturnType<TeacherChangeRequestService['listEligibleTeachersForCampus']>> }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    if (!campusId) throw new BadRequestException('campusId required');
    // A04: academic/boss 强制 jwt.campusId / admin 可任意
    if (req.user?.role !== 'admin') {
      const jwtCampus = req.user?.campusId;
      if (!jwtCampus || jwtCampus !== campusId) {
        throw new ForbiddenException('CROSS_CAMPUS_DENIED: 只能列本校老师');
      }
    }
    const items = await this.svc.listEligibleTeachersForCampus(tenantSchema, campusId);
    return { items };
  }

  /**
   * 教务撤回 pending 请求 (家长还没决定前)
   */
  @Post(':teacherChangeRequestId/cancel')
  @Roles('academic', 'academic_admin')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @Param('teacherChangeRequestId') teacherChangeRequestId: string,
    @Body() body: { tenantSchema: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<{ updated: boolean }> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    if (!teacherChangeRequestId || teacherChangeRequestId.length !== 32) {
      throw new BadRequestException('teacherChangeRequestId must be 32-char ULID');
    }
    const userId = req.user?.sub;
    if (!userId) throw new BadRequestException('user sub required');

    const result = await this.svc.cancel(body.tenantSchema, teacherChangeRequestId, userId);
    await this._tryAudit(body.tenantSchema, req, 'teacher.change-cancelled-by-academic', teacherChangeRequestId);
    return result;
  }

  // 注: 家长 C 端 endpoints (parent-pending / parent-decide) 走另一套 JWT (ParentJwtStrategy)
  //   + ParentSelfGuard, 与 B 端 TenantScopeGuard/RbacGuard 解耦
  //   单独 controller 在 c-side 模块实施 (Sprint Y P3.1) — 暂留 service.parentDecide /
  //   listPendingByParent method 待挂入

  // ----- helper -----
  private async _tryAudit(
    tenantSchema: string,
    req: AuthenticatedRequest,
    action: string,
    targetId: string,
  ): Promise<void> {
    if (!this.auditLog) return;
    try {
      await this.auditLog.log(tenantSchema, {
        actorUserId: req.user?.sub ?? null,
        actorRole: normalizeActorRole(req.user?.role),
        action,
        targetType: 'teacher_change_request',
        targetId,
        before: null,
        after: null,
        ip: req.ip ?? null,
        userAgent: (req.headers?.['user-agent'] as string | undefined) ?? null,
        requestId: (req.headers?.['x-request-id'] as string | undefined) ?? null,
      });
    } catch {
      // fail-open
    }
  }
}
