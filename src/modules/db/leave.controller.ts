import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { LeaveRepository, Leave, LeaveType } from './leave.repository';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';

/**
 * LeaveController — V16 请假/调课申请 HTTP 暴露
 *
 * 路由前缀：/api/db/...
 *   POST /api/db/leaves                        - 学员/家长提交请假/调课
 *   POST /api/db/students/:studentId/leaves/list - 列出学员请假记录
 *   POST /api/db/leaves/:id/approve            - 老师/管理员批准
 *   POST /api/db/leaves/:id/reject             - 老师/管理员驳回
 *
 * 鉴权：x-tenant-schema header（与其他 /db 路由一致）
 *
 * 业务规则：距上课 < 24h 提交时仍接受，但 response 加 warning='可能被驳回'
 */
@UseGuards(TenantScopeGuard)
@Controller('db')
export class LeaveController {
  constructor(private readonly leaveRepo: LeaveRepository) {}

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

  @Post('leaves/:id/approve')
  @HttpCode(HttpStatus.OK)
  async approveLeave(
    @Param('id') id: string,
    @Headers('x-tenant-schema') tenantSchema: string,
    @Body() body: { newDateMs?: number; newStartAtMs?: number },
  ): Promise<Leave> {
    if (!tenantSchema) {
      throw new BadRequestException('x-tenant-schema header required');
    }
    return this.leaveRepo.approve(tenantSchema, id, {
      newDate: body.newDateMs ? new Date(body.newDateMs) : undefined,
      newStartAt: body.newStartAtMs ? new Date(body.newStartAtMs) : undefined,
    });
  }

  @Post('leaves/:id/reject')
  @HttpCode(HttpStatus.OK)
  async rejectLeave(
    @Param('id') id: string,
    @Headers('x-tenant-schema') tenantSchema: string,
    @Body() body: { reason: string },
  ): Promise<Leave> {
    if (!tenantSchema) {
      throw new BadRequestException('x-tenant-schema header required');
    }
    if (!body.reason) {
      throw new BadRequestException('reason required');
    }
    return this.leaveRepo.reject(tenantSchema, id, body.reason);
  }
}
