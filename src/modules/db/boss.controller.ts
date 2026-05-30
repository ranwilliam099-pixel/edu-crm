import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
  Query,
} from '@nestjs/common';
import { CampusRepository, Campus } from './campus.repository';
import {
  SubscriptionRepository,
  Subscription,
  PlanTier,
} from './subscription.repository';
import { PgPoolService } from './pg-pool.service';
import { AuditLogRepository, normalizeActorRole } from './audit-log.repository';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';
import { RbacGuard } from '../../guards/rbac.guard';
import { Roles } from '../../guards/rbac.decorator';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';

/**
 * BossController — V19 Boss 视角校区 + 订阅管理 HTTP 暴露
 *
 * 路由：
 *   POST /api/db/boss/campuses                  - 新增校区
 *   POST /api/db/boss/campuses/list             - 列出校区
 *   POST /api/db/boss/campuses/stats            - 30 天聚合统计
 *   POST /api/db/boss/subscription/upgrade      - 升级订阅
 *   GET  /api/db/boss/subscription              - 当前订阅状态
 *
 * 鉴权：tenantId 通过 body / query 传（不走 x-tenant-schema header — public 表）
 *
 * 审计（SSOT §2.10 内部少审核但留痕 / §9 P0 写操作必接 audit_log V33）：
 *   写操作（建/改校区、订阅升级）落 audit_log。BossController 走 public 表持 tenantId，
 *   audit_log 是 per-tenant schema 表 → 派生 `tenant_<tenantId>`（与 TenantScopeGuard
 *   L68 expectedSchema 同源；Guard 已强制 body.tenantId === JWT.tenantId，跨租户写已堵）。
 *   actor 取 @Req() req.user.sub/role；log() fail-open 不阻塞主业务（§2.10 留痕不审核）。
 */
@UseGuards(TenantScopeGuard)
@Controller('db/boss')
export class BossController {
  constructor(
    private readonly campusRepo: CampusRepository,
    private readonly subRepo: SubscriptionRepository,
    private readonly pg: PgPoolService,
    private readonly auditLog: AuditLogRepository,
  ) {}

  /**
   * 从认证请求提取 audit 公共字段（actor + 溯源）。
   * actorRole 经 normalizeActorRole 收口（越界 role → 'system'，防 V33 CHECK 违反）。
   */
  private auditActor(req: AuthenticatedRequest) {
    return {
      actorUserId: req.user?.sub ?? null,
      actorRole: normalizeActorRole(req.user?.role),
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      requestId: (req.headers['x-request-id'] as string | undefined) ?? null,
    };
  }

  /** tenantId → per-tenant schema 名（与 TenantScopeGuard expectedSchema 同源派生） */
  private schemaOf(tenantId: string): string {
    return `tenant_${tenantId.toLowerCase()}`;
  }

  // ===== tenant =====

  @Get('tenant/info')
  @UseGuards(RbacGuard)
  @Roles('admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async tenantInfo(@Query('tenantId') tenantId: string): Promise<{
    tenantId: string;
    name: string;
    status: string;
    version: string;
    planTier: PlanTier;
    maxCampuses: number;
    createdAt: string;
  }> {
    if (!tenantId) {
      throw new BadRequestException('tenantId required');
    }
    const rows = await this.pg.query<{
      id: string;
      name: string;
      status: string;
      version: string;
      plan_tier: PlanTier | null;
      max_campuses: number;
      created_at: Date;
    }>(
      `SELECT id, name, status, version, plan_tier, max_campuses, created_at
         FROM public.tenants
        WHERE id = $1`,
      [tenantId],
    );
    if (rows.length === 0) {
      throw new BadRequestException(`tenant ${tenantId} not found`);
    }
    const r = rows[0];
    return {
      tenantId: r.id,
      name: r.name,
      status: r.status,
      version: r.version,
      planTier: r.plan_tier || 'single',
      maxCampuses: r.max_campuses,
      createdAt: r.created_at.toISOString(),
    };
  }

  // ===== campuses =====

  @Post('campuses')
  @UseGuards(RbacGuard)
  @Roles('admin')
  @HttpCode(HttpStatus.CREATED)
  async createCampus(
    @Body()
    body: {
      tenantId: string;
      id: string;
      name: string;
      city?: string;
      district?: string;
      address?: string;
      isHq?: boolean;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<Campus> {
    if (!body.tenantId || body.tenantId.length !== 32) {
      throw new BadRequestException('tenantId must be 32-char ULID');
    }
    if (!body.id || body.id.length !== 32) {
      throw new BadRequestException('id must be 32-char ULID');
    }
    if (!body.name) {
      throw new BadRequestException('name required');
    }
    const created = await this.campusRepo.create(body.tenantId, {
      id: body.id,
      name: body.name,
      city: body.city,
      district: body.district,
      address: body.address,
      isHq: body.isHq,
    });
    await this.auditLog.log(this.schemaOf(body.tenantId), {
      ...this.auditActor(req),
      action: 'campus.create',
      targetType: 'campus',
      targetId: created.id,
      before: null, // 新建无前态
      after: {
        name: created.name,
        city: created.city ?? null,
        district: created.district ?? null,
        isHq: created.isHq,
      },
    });
    return created;
  }

  /**
   * 编辑校区（SSOT §5.3 校区写=老板）
   *
   * PATCH /api/db/boss/campuses/:id
   * Body: { tenantId, name?, city?, district?, address? }
   *   - RBAC @Roles('admin')（同 createCampus）
   *   - tenantId WHERE 保持租户隔离（防跨租户改他人校区）
   *   - 只更非空字段；目标校区不存在/不属本 tenant → NotFound（repo 层）
   */
  @Patch('campuses/:id')
  @UseGuards(RbacGuard)
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  async updateCampus(
    @Param('id') id: string,
    @Body()
    body: {
      tenantId: string;
      name?: string;
      city?: string;
      district?: string;
      address?: string;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<Campus> {
    if (!body.tenantId || body.tenantId.length !== 32) {
      throw new BadRequestException('tenantId must be 32-char ULID');
    }
    if (!id || id.length !== 32) {
      throw new BadRequestException('id must be 32-char ULID');
    }
    // 审计前态快照：变更操作需记录 before 以便事后还原「改了什么」（三审一致要求）。
    // update 抛 NotFound 时不会走到 audit（before 仅在 update 成功后入库）。
    const before = await this.campusRepo.findById(body.tenantId, id);
    const updated = await this.campusRepo.update(body.tenantId, id, {
      name: body.name,
      city: body.city,
      district: body.district,
      address: body.address,
    });
    await this.auditLog.log(this.schemaOf(body.tenantId), {
      ...this.auditActor(req),
      action: 'campus.update',
      targetType: 'campus',
      targetId: id,
      before: before
        ? {
            name: before.name,
            city: before.city ?? null,
            district: before.district ?? null,
            address: before.address ?? null,
          }
        : null,
      after: {
        name: updated.name,
        city: updated.city ?? null,
        district: updated.district ?? null,
        address: updated.address ?? null,
      },
    });
    return updated;
  }

  @Post('campuses/list')
  @UseGuards(RbacGuard)
  @Roles('admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async listCampuses(@Body() body: { tenantId: string }): Promise<Campus[]> {
    if (!body.tenantId) {
      throw new BadRequestException('tenantId required');
    }
    return this.campusRepo.list(body.tenantId);
  }

  @Post('campuses/stats')
  @UseGuards(RbacGuard)
  @Roles('admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async campusStats(@Body() body: { tenantId: string }) {
    if (!body.tenantId) {
      throw new BadRequestException('tenantId required');
    }
    return this.campusRepo.getStats30d(body.tenantId);
  }

  // ===== subscription =====

  @Post('subscription/upgrade')
  @UseGuards(RbacGuard)
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  async upgradeSubscription(
    @Body() body: { tenantId: string; targetPlan: PlanTier },
    @Req() req: AuthenticatedRequest,
  ) {
    if (!body.tenantId) {
      throw new BadRequestException('tenantId required');
    }
    if (!body.targetPlan) {
      throw new BadRequestException('targetPlan required');
    }
    const result = await this.subRepo.upgrade(body.tenantId, body.targetPlan);
    await this.auditLog.log(this.schemaOf(body.tenantId), {
      ...this.auditActor(req),
      action: 'subscription.upgrade',
      targetType: 'subscription',
      targetId: body.tenantId,
      before: { plan: result.oldPlan },
      after: { plan: result.newPlan, priceDiff: result.priceDiff },
    });
    return result;
  }

  @Get('subscription')
  @UseGuards(RbacGuard)
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  async getSubscription(
    @Query('tenantId') tenantId: string,
  ): Promise<Subscription> {
    if (!tenantId) {
      throw new BadRequestException('tenantId required');
    }
    return this.subRepo.getCurrent(tenantId);
  }
}
