import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { LeaveRepository, Leave, LeaveType } from './leave.repository';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';
import { RbacGuard } from '../../guards/rbac.guard';
import { Roles } from '../../guards/rbac.decorator';
import { ContentModerationService } from '../security/content-moderation.service';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';

/**
 * LeaveController — V16 请假/调课申请 HTTP 暴露
 *
 * 路由前缀：/api/db/...
 *   POST /api/db/leaves                        - 学员/家长提交请假/调课
 *   POST /api/db/students/:studentId/leaves/list - 列出学员请假记录
 *   POST /api/db/leaves/:id/approve            - 教务/教务主管/老板/校长批准（RBAC）
 *   POST /api/db/leaves/:id/reject             - 教务/教务主管/老板/校长驳回（RBAC）
 *
 * 鉴权：x-tenant-schema header（与其他 /db 路由一致）
 *   2026-05-30 越权修复：approve/reject 原无 @Roles（任意认证角色可审批）→ 加
 *   @UseGuards(RbacGuard) + @Roles([academic, academic_admin, admin, boss])。请假/调课
 *   是教务域（SSOT §6.4）；create/list 维持广开放（§6.4 主入口家长 C 端 + 教务代发）。
 *
 * 业务规则：距上课 < 24h 提交时仍接受，但 response 加 warning='可能被驳回'
 */
@UseGuards(TenantScopeGuard)
@Controller('db')
export class LeaveController {
  constructor(
    private readonly leaveRepo: LeaveRepository,
    // #24: B 端自由文本内容安全统一收口（@Global SecurityModule 注入，生产必有）
    private readonly contentModeration: ContentModerationService,
  ) {}

  @Post('leaves')
  @HttpCode(HttpStatus.CREATED)
  async createLeave(
    @Headers('x-tenant-schema') tenantSchema: string,
    @Body()
    body: {
      id: string;
      studentId: string;
      lessonId?: string;
      type: LeaveType;
      reason?: string;
      reasonNote?: string;
      // 距上课时间（毫秒），用于 24h 警告判定（前端传，后端不读 schedules 表）
      lessonStartAtMs?: number;
      newDateMs?: number;
      newStartAtMs?: number;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<{ leave: Leave; warning?: string }> {
    if (!tenantSchema) {
      throw new BadRequestException('x-tenant-schema header required');
    }
    if (!body.id || body.id.length !== 32) {
      throw new BadRequestException('id must be 32-char ULID');
    }
    if (!body.studentId || body.studentId.length !== 32) {
      throw new BadRequestException('studentId must be 32-char ULID');
    }
    if (!['leave', 'reschedule'].includes(body.type)) {
      throw new BadRequestException(`type must be leave|reschedule, got: ${body.type}`);
    }

    // #24: 自由文本过微信内容安全（risky → 400 拒存；写库前拦截，违规内容不落库）
    //   reason / reasonNote 为家长/学员请假理由自填文本（B 端 endpoint，沿用 reject 策略）
    await this.contentModeration.enforceStaffText(
      tenantSchema,
      [body.reason, body.reasonNote],
      {
        action: 'leave',
        targetType: 'leave',
        targetId: body.id,
        req,
      },
    );

    const leave: Leave = {
      id: body.id,
      studentId: body.studentId,
      lessonId: body.lessonId,
      type: body.type,
      reason: body.reason,
      reasonNote: body.reasonNote,
      newDate: body.newDateMs ? new Date(body.newDateMs) : undefined,
      newStartAt: body.newStartAtMs ? new Date(body.newStartAtMs) : undefined,
      status: 'pending',
      createdAt: new Date(),
    };
    const saved = await this.leaveRepo.create(tenantSchema, leave);

    // 24h 警告：距上课 < 24h 时加 warning（status 仍是 pending，但提示家长可能被驳回）
    let warning: string | undefined;
    if (body.lessonStartAtMs) {
      const now = Date.now();
      const ELAPSED_24H = 24 * 60 * 60 * 1000;
      if (body.lessonStartAtMs - now < ELAPSED_24H) {
        warning = '距上课不足 24 小时，申请可能被驳回';
      }
    }
    return warning ? { leave: saved, warning } : { leave: saved };
  }

  @Post('students/:studentId/leaves/list')
  @HttpCode(HttpStatus.OK)
  async listByStudent(
    @Param('studentId') studentId: string,
    @Headers('x-tenant-schema') tenantSchema: string,
    @Body() body: { limit?: number },
  ): Promise<Leave[]> {
    if (!tenantSchema) {
      throw new BadRequestException('x-tenant-schema header required');
    }
    return this.leaveRepo.findByStudent(tenantSchema, studentId, body.limit ?? 50);
  }

  @Post('leaves/:leaveId/approve')
  // RBAC（2026-05-30 越权修复）：请假/调课审批 = 教务域（SSOT §6.4 老师请假教务取消换老师 /
  //   留痕不审核但审批/驳回是教务调课职能）。教务双层 + 老板校长；排除 sales/finance/teacher/parent。
  //   class 级只有 TenantScopeGuard → 必加方法级 @UseGuards(RbacGuard) 才激活 @Roles。
  @UseGuards(RbacGuard)
  @Roles('academic', 'academic_admin', 'admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async approveLeave(
    @Param('leaveId') leaveId: string,
    @Headers('x-tenant-schema') tenantSchema: string,
    @Body() body: { newDateMs?: number; newStartAtMs?: number },
  ): Promise<Leave> {
    if (!tenantSchema) {
      throw new BadRequestException('x-tenant-schema header required');
    }
    return this.leaveRepo.approve(tenantSchema, leaveId, {
      newDate: body.newDateMs ? new Date(body.newDateMs) : undefined,
      newStartAt: body.newStartAtMs ? new Date(body.newStartAtMs) : undefined,
    });
  }

  @Post('leaves/:leaveId/reject')
  // RBAC（2026-05-30 越权修复）：同 approve — 教务双层 + 老板校长可驳回
  @UseGuards(RbacGuard)
  @Roles('academic', 'academic_admin', 'admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async rejectLeave(
    @Param('leaveId') leaveId: string,
    @Headers('x-tenant-schema') tenantSchema: string,
    @Body() body: { reason: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<Leave> {
    if (!tenantSchema) {
      throw new BadRequestException('x-tenant-schema header required');
    }
    if (!body.reason) {
      throw new BadRequestException('reason required');
    }

    // #24: 驳回理由（审批角色自填文本）过微信内容安全（risky → 400 拒存）
    await this.contentModeration.enforceStaffText(
      tenantSchema,
      [body.reason],
      {
        action: 'leave',
        targetType: 'leave',
        targetId: leaveId,
        req,
      },
    );

    return this.leaveRepo.reject(tenantSchema, leaveId, body.reason);
  }
}
