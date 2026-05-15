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
import {
  CustomerRepository,
  Customer,
  CreateCustomerResult,
  FollowEntry,
  FollowType,
} from './customer.repository';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';
import { AuthenticatedRequest, JwtPayload } from '../auth/jwt-payload.interface';
import { Roles } from '../../guards/rbac.decorator';
import { RbacGuard } from '../../guards/rbac.guard';
// Sprint B.3 (2026-05-11): 字段级权限过滤 + 范围过滤
import { maskCustomer, canAccessCustomer, actorGroupOf } from '../../common/role-field-filter';
// Sprint B.5 (2026-05-11): audit_log 业务写操作 + 拒绝路径
//   - createSelfBuilt / claim / release / markLost 写 audit_log
//   - canAccessCustomer 失败前写 'customer.access-denied' 留证据
//   - 复用 C.2 / V36 / B.3 修复 (cross-tenant-denied, teacher.self-check-failed) 模式
import { ActorRole, AuditLogRepository } from './audit-log.repository';

/**
 * CustomerController — V25 销售客户管理 HTTP 暴露
 *
 * 路径前缀 /api/db/customers/*
 *
 * Endpoints:
 *   GET  /db/customers/mine              我的客户列表
 *   GET  /db/customers/pool              公共池
 *   GET  /db/customers/:id               详情
 *   GET  /db/customers/:id/follows       跟进时间轴
 *   POST /db/customers/:id/claim         捞客户（FCFS）
 *   POST /db/customers/:id/release       退回池
 *   POST /db/customers/:id/mark-lost     标失单
 *   POST /db/customers/:id/follow        加跟进时间轴
 *
 * 鉴权：TenantScopeGuard（强制 tenantId 一致）
 */
@Controller('db/customers')
@UseGuards(TenantScopeGuard)
export class CustomerController {
  constructor(
    private readonly repo: CustomerRepository,
    // Sprint B.5 (2026-05-11): audit_log 业务写 + 拒绝路径
    //   - @Optional：unit spec 直接 new 不传也能跑（兼容现有 spec 测试）
    //   - fail-open：log() 写失败仅 logger.warn 不抛主业务（AuditLogRepository.log 内部 catch）
    @Optional() private readonly auditLog?: AuditLogRepository,
  ) {}

  /**
   * Sprint B.5：PII 脱敏入 audit_log
   *
   * 拍板约束 #4：snapshot 含 PII（phone/wechat）必须 mask
   *   - 但 customer.create 仍需部分敏感字段以便溯源（保留 mask 后的 hint）
   *   - 规则：phone 13800138000 → '138****8000'；wechat 'wx_abc' → 'wx_***'；长度 < 4 → '***'
   *   - id_number / family_address 直接置 null（不入 audit）
   */
  private maskPhoneForAudit(phone: string | null | undefined): string | null {
    if (!phone || typeof phone !== 'string') return null;
    if (phone.length < 7) return '***';
    return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
  }

  private maskWechatForAudit(wechat: string | null | undefined): string | null {
    if (!wechat || typeof wechat !== 'string') return null;
    if (wechat.length < 4) return '***';
    return `${wechat.slice(0, 2)}***`;
  }

  /**
   * Sprint B.5 helper：从 req 取 audit 上下文（ip/ua/req-id + actorRole）
   */
  private auditCtx(req: AuthenticatedRequest): {
    actorRole: ActorRole;
    ip: string | null;
    userAgent: string | null;
    requestId: string | null;
  } {
    return {
      actorRole: ((req.user?.role as ActorRole) ?? 'admin') as ActorRole,
      ip: req.ip ?? null,
      userAgent: (req.headers?.['user-agent'] as string | undefined) ?? null,
      requestId: (req.headers?.['x-request-id'] as string | undefined) ?? null,
    };
  }

  /**
   * Sprint B.5 helper：写 audit_log，try-catch 不阻塞主业务
   */
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
    try {
      await this.auditLog?.log(tenantSchema, entry);
    } catch {
      // fail-open: audit 写失败不阻塞主业务（AuditLogRepository.log 内部已 catch，再加一层兜底）
    }
  }

  /**
   * V29 R2 销售即时建客户（家长 + opportunity + 可选 student 一并）
   *
   * 用户 2026-05-07「全做」— 销售自己开拓的客户能即时录入，不必等公共池
   *
   * Body:
   *   customerId / opportunityId  32-char ULID（前端生成）
   *   parentName / primaryMobile / campusId  必填
   *   studentId / studentName     可选（提供则一并建学生）
   *   gradeOrAge / intendedSubject / source / note 可选
   *
   * RBAC：sales / sales_manager / boss / admin — 5/15 A-2 删 sales_director
   * ownerSalesId 自动 = req.user.sub
   */
  @Post()
  @UseGuards(RbacGuard)
  @Roles('sales', 'sales_manager', 'boss', 'admin') // 5/15 A-2：删 'sales_director'
  @HttpCode(HttpStatus.CREATED)
  async createSelfBuilt(
    @Body()
    body: {
      tenantId: string;
      tenantSchema: string;
      customerId: string;
      opportunityId: string;
      parentName: string;
      primaryMobile: string;
      campusId?: string;
      studentId?: string;
      studentName?: string;
      gradeOrAge?: string;
      intendedSubject?: string;
      source?: string;
      note?: string;
      stage?: string;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<CreateCustomerResult> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    const operatorUserId = req.user?.sub;
    if (!operatorUserId) throw new BadRequestException('user sub required');
    const campusId = body.campusId || req.user?.campusId;
    if (!campusId) {
      throw new BadRequestException(
        '跨校 role 必须显式传 campusId（admin/hr 无单一 campus；5/15 A-2 删 sales_director）',
      );
    }
    const result = await this.repo.createWithOpportunity(body.tenantSchema, {
      customerId: body.customerId,
      opportunityId: body.opportunityId,
      parentName: body.parentName,
      primaryMobile: body.primaryMobile,
      campusId,
      ownerSalesId: operatorUserId,
      studentId: body.studentId,
      studentName: body.studentName,
      gradeOrAge: body.gradeOrAge,
      intendedSubject: body.intendedSubject,
      stage: body.stage,
      source: body.source,
      note: body.note,
    });

    // Sprint B.5: audit_log customer.create（PII masked phone 入 after，便于运营溯源）
    await this.tryAudit(body.tenantSchema, {
      actorUserId: operatorUserId,
      ...this.auditCtx(req),
      action: 'customer.create',
      targetType: 'customer',
      targetId: result.customerId,
      before: null,
      after: {
        customerId: result.customerId,
        opportunityId: result.opportunityId,
        studentId: result.studentId,
        parentName: body.parentName,
        primaryMobileMask: this.maskPhoneForAudit(body.primaryMobile),
        campusId,
        ownerSalesId: operatorUserId,
        studentName: body.studentName ?? null,
        gradeOrAge: body.gradeOrAge ?? null,
        intendedSubject: body.intendedSubject ?? null,
        stage: body.stage ?? '初步接触',
        source: body.source ?? null,
      },
    });

    return result;
  }

  @Get('mine')
  @HttpCode(HttpStatus.OK)
  async listMine(
    @Query('tenantSchema') tenantSchema: string,
    @Query('stage') stage?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Req() req?: AuthenticatedRequest,
  ): Promise<{ items: Customer[] }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const ownerUserId = req?.user?.sub;
    if (!ownerUserId) throw new BadRequestException('user sub required');
    const items = await this.repo.listMine(tenantSchema, ownerUserId, {
      stage: stage as any,
      limit: limit ? Math.min(parseInt(limit, 10), 200) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
    });
    // Sprint B.3：listMine 已是 SQL 层 owner_user_id=me 过滤过，但字段级
    // 仍需走 mask：保证一致策略（如未来 sales_manager 调 listMine 路径也走同 mask）
    const items_masked = items.map((c) =>
      maskCustomer(c, req?.user, { isOwnerSelf: c.ownerUserId === ownerUserId }),
    );
    return { items: items_masked };
  }

  /**
   * 老板视角：本租户全部销售的客户（含未分配 + 各销售归属）
   * 仅 admin（老板）/ sales_manager（销售校内主管）可调 — 5/15 A-2 删 sales_director
   * @query campusId V26 校区切换过滤
   */
  @Get('all')
  @UseGuards(RbacGuard)
  @Roles('admin', 'sales_manager') // 5/15 A-2：删 'sales_director'
  @HttpCode(HttpStatus.OK)
  async listAllForBoss(
    @Query('tenantSchema') tenantSchema: string,
    @Query('ownerFilter') ownerFilter?: string,
    @Query('stage') stage?: string,
    @Query('campusId') campusId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Req() req?: AuthenticatedRequest,
  ): Promise<{ items: Customer[] }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const items = await this.repo.listAllForBoss(tenantSchema, {
      ownerFilter,
      stage: stage as any,
      campusId,
      limit: limit ? Math.min(parseInt(limit, 10), 500) : 200,
      offset: offset ? parseInt(offset, 10) : 0,
    });
    // Sprint B.3：admin/sales_manager 都允许调，但字段裁剪按 role
    //   - admin / boss：全字段
    //   - sales_manager：admin group（按 actorGroupOf 归类 admin，全字段）
    //     主管类视为 owner（拍板「老板校长 + 销售校内主管 ✅ 看全」）
    //   - 5/15 A-2：删 sales_director（不在拍板角色清单）
    const ownerUserId = req?.user?.sub ?? null;
    const items_masked = items.map((c) => {
      // sales_manager 走 admin group 等效（拍板 KPI 主可看）
      // 实际取决于 actorGroupOf；这里直接传 owner 比对，subgroup 不影响 admin/boss
      const isOwnerSelf = ownerUserId !== null && c.ownerUserId === ownerUserId;
      return maskCustomer(c, req?.user, { isOwnerSelf });
    });
    return { items: items_masked };
  }

  @Get('pool')
  @HttpCode(HttpStatus.OK)
  async listPool(
    @Query('tenantSchema') tenantSchema: string,
    @Query('source') source?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Req() req?: AuthenticatedRequest,
  ): Promise<{ items: Customer[] }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const items = await this.repo.listPool(tenantSchema, {
      source,
      limit: limit ? Math.min(parseInt(limit, 10), 200) : 100,
      offset: offset ? parseInt(offset, 10) : 0,
    });
    // Sprint B.3：公共池里 owner_user_id=NULL，sales 看到的都不是"自己持有"，
    //   但拍板「公共池」客户对销售可见 phone/wechat（FCFS 抢占前提需见联系人）
    //   → 把 isOwnerSelf 设为 true（=池里所有 sales 都视为「可看」），不影响 admin/finance
    //   注：admin 路径下 maskCustomer 无视 isOwnerSelf，按 admin 路径全字段保留
    const items_masked = items.map((c) =>
      maskCustomer(c, req?.user, { isOwnerSelf: true }),
    );
    return { items: items_masked };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  async detail(
    @Param('id') id: string,
    @Query('tenantSchema') tenantSchema: string,
    @Req() req?: AuthenticatedRequest,
  ): Promise<Customer | { found: false }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const c = await this.repo.findById(tenantSchema, id);
    if (!c) return { found: false };

    // Sprint B.3 (2026-05-11)：范围过滤优先于字段过滤
    //   1. canAccessCustomer：sales 只能看 owner=me / 池内（admin/academic/finance 全可看）
    //   2. 拒绝场景：返 {found:false} 避免侧信道泄漏（不区分「不存在」vs「无权」）
    //   3. teacher / hr / parent / unknown 都拒绝（拍板不该看）
    //
    // Sprint B.5 (2026-05-11) — 拒绝路径 audit_log：A09 安全留证
    //   - 写在 throw 之前（try-catch fail-open；audit 失败不阻塞 403）
    //   - action='customer.access-denied'
    //   - after 含 attempted_role / actual_owner / 端点语义（detail）
    if (!canAccessCustomer(c, req?.user)) {
      if (req) {
        await this.tryAudit(tenantSchema, {
          actorUserId: req.user?.sub ?? null,
          ...this.auditCtx(req),
          action: 'customer.access-denied',
          targetType: 'customer',
          targetId: id,
          before: null,
          after: {
            attempted_role: req.user?.role ?? 'unknown',
            attempted_owner: req.user?.sub ?? null,
            actual_owner: c.ownerUserId ?? 'pool',
            endpoint: 'detail',
          },
        });
      }
      throw new ForbiddenException(
        `CUSTOMER_ACCESS_DENIED: role=${req?.user?.role ?? 'unknown'} ` +
          `customerId=${id} owner=${c.ownerUserId ?? 'pool'}`,
      );
    }

    // 字段级 mask
    //   - sales 个人：isOwnerSelf 比对 sub
    //   - 池客户（ownerUserId=null）→ isOwnerSelf=true（允许 sales 看 phone 以便 claim）
    //   - admin / academic / finance：mask 内部按 group 自己判定
    const isOwnerSelf =
      c.ownerUserId === null || // 池
      (req?.user?.sub !== undefined && c.ownerUserId === req.user.sub);
    return maskCustomer(c, req?.user, { isOwnerSelf });
  }

  @Get(':id/follows')
  @HttpCode(HttpStatus.OK)
  async listFollows(
    @Param('id') id: string,
    @Query('tenantSchema') tenantSchema: string,
    @Query('limit') limit?: string,
    @Req() req?: AuthenticatedRequest,
  ): Promise<{ items: FollowEntry[] }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');

    // Sprint B.3 复审 (2026-05-11) — 红线 A01：
    //   - 跟进时间轴是销售线敏感数据（沟通记录 + 内部 note）
    //   - 必须先 canAccessCustomer：sales 仅看 owner=me / 池；teacher/parent/hr 403
    //   - 拍板「教务/财务可看本校客户」→ 直接放行（campus 比对在 controller 层）
    //
    // 实现：先 findById 拿 ownerUserId → canAccessCustomer 判定 → listFollowLog
    const c = await this.repo.findById(tenantSchema, id);
    if (!c) {
      // 客户不存在 → 空数组（避免侧信道泄漏「该 ID 是否存在」）
      return { items: [] };
    }
    if (!canAccessCustomer(c, req?.user)) {
      // Sprint B.5: 拒绝路径 audit_log（同 detail，但 endpoint='follows'）
      if (req) {
        await this.tryAudit(tenantSchema, {
          actorUserId: req.user?.sub ?? null,
          ...this.auditCtx(req),
          action: 'customer.access-denied',
          targetType: 'customer',
          targetId: id,
          before: null,
          after: {
            attempted_role: req.user?.role ?? 'unknown',
            attempted_owner: req.user?.sub ?? null,
            actual_owner: c.ownerUserId ?? 'pool',
            endpoint: 'follows',
          },
        });
      }
      throw new ForbiddenException(
        `CUSTOMER_ACCESS_DENIED: role=${req?.user?.role ?? 'unknown'} ` +
          `customerId=${id} owner=${c.ownerUserId ?? 'pool'} (follows)`,
      );
    }

    const items = await this.repo.listFollowLog(
      tenantSchema,
      id,
      limit ? Math.min(parseInt(limit, 10), 500) : 100,
    );
    return { items };
  }

  @Post(':id/claim')
  @HttpCode(HttpStatus.OK)
  async claim(
    @Param('id') id: string,
    @Body() body: { tenantId: string; tenantSchema: string; userLabel?: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<Customer> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    const userId = req.user?.sub;
    if (!userId) throw new BadRequestException('user sub required');

    // Sprint B.5: 先读 before（用于 audit_log diff — 池内 owner=null → 自己抢占）
    //   注：claim 失败（CUSTOMER_ALREADY_OWNED）走 repo 抛 ConflictException，不入 audit
    //   此处 before 用 findById 拿到 ownerUserId（应为 null，否则下面 repo 会抛错）
    const before = await this.repo.findById(body.tenantSchema, id);
    const result = await this.repo.claim(
      body.tenantSchema,
      id,
      userId,
      body.userLabel || `销售 ${userId.slice(0, 6)}`,
    );

    // Sprint B.5: audit_log customer.claim（PII 不入 audit，仅记 owner 流转）
    await this.tryAudit(body.tenantSchema, {
      actorUserId: userId,
      ...this.auditCtx(req),
      action: 'customer.claim',
      targetType: 'customer',
      targetId: id,
      before: { ownerUserId: before?.ownerUserId ?? null, stage: before?.stage ?? null },
      after: { ownerUserId: result.ownerUserId, stage: result.stage },
    });

    return result;
  }

  @Post(':id/release')
  @HttpCode(HttpStatus.OK)
  async release(
    @Param('id') id: string,
    @Body()
    body: { tenantId: string; tenantSchema: string; userLabel?: string; reason?: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<Customer> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    const userId = req.user?.sub;
    if (!userId) throw new BadRequestException('user sub required');

    // Sprint B.5: before snapshot（owner=me → release 后 null）
    const before = await this.repo.findById(body.tenantSchema, id);
    const result = await this.repo.release(
      body.tenantSchema,
      id,
      userId,
      body.userLabel || `销售 ${userId.slice(0, 6)}`,
      body.reason,
    );

    // Sprint B.5: audit_log customer.release
    await this.tryAudit(body.tenantSchema, {
      actorUserId: userId,
      ...this.auditCtx(req),
      action: 'customer.release',
      targetType: 'customer',
      targetId: id,
      before: { ownerUserId: before?.ownerUserId ?? null, stage: before?.stage ?? null },
      after: {
        ownerUserId: result.ownerUserId,
        stage: result.stage,
        reason: body.reason ?? null,
      },
    });

    return result;
  }

  @Post(':id/mark-lost')
  @HttpCode(HttpStatus.OK)
  async markLost(
    @Param('id') id: string,
    @Body()
    body: {
      tenantId: string;
      tenantSchema: string;
      userLabel?: string;
      lostReason: string;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<Customer> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    if (!body.lostReason) throw new BadRequestException('lostReason required');
    const userId = req.user?.sub;
    if (!userId) throw new BadRequestException('user sub required');

    // Sprint B.5: before snapshot（stage → '已失单'）
    const before = await this.repo.findById(body.tenantSchema, id);
    const result = await this.repo.markLost(
      body.tenantSchema,
      id,
      userId,
      body.userLabel || `销售 ${userId.slice(0, 6)}`,
      body.lostReason,
    );

    // Sprint B.5: audit_log customer.mark-lost
    await this.tryAudit(body.tenantSchema, {
      actorUserId: userId,
      ...this.auditCtx(req),
      action: 'customer.mark-lost',
      targetType: 'customer',
      targetId: id,
      before: { stage: before?.stage ?? null, lostReason: before?.lostReason ?? null },
      after: { stage: result.stage, lostReason: result.lostReason },
    });

    return result;
  }

  @Post(':id/follow')
  @HttpCode(HttpStatus.CREATED)
  async addFollow(
    @Param('id') id: string,
    @Body()
    body: {
      tenantId: string;
      tenantSchema: string;
      followType: FollowType;
      label: string;
      userLabel?: string;
      extra?: Record<string, unknown>;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<FollowEntry> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    if (!body.label) throw new BadRequestException('label required');
    const userId = req.user?.sub;
    if (!userId) throw new BadRequestException('user sub required');
    return this.repo.addFollow(body.tenantSchema, id, {
      followType: body.followType || 'remark',
      label: body.label,
      byUserId: userId,
      byLabel: body.userLabel || `销售 ${userId.slice(0, 6)}`,
      extra: body.extra,
    });
  }
}
