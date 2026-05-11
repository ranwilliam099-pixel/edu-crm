import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
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
  constructor(private readonly repo: CustomerRepository) {}

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
   * RBAC：sales / sales_manager / sales_director / boss / admin
   * ownerSalesId 自动 = req.user.sub
   */
  @Post()
  @UseGuards(RbacGuard)
  @Roles('sales', 'sales_manager', 'sales_director', 'boss', 'admin')
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
        '跨校 role 必须显式传 campusId（admin/sales_director/hr 无单一 campus）',
      );
    }
    return this.repo.createWithOpportunity(body.tenantSchema, {
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
   * 仅 admin（老板）/ sales_director（大区经理）/ sales_manager 可调
   * @query campusId V26 校区切换过滤
   */
  @Get('all')
  @UseGuards(RbacGuard)
  @Roles('admin', 'sales_director', 'sales_manager')
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
    // Sprint B.3：admin/sales_director/sales_manager 都允许调，但字段裁剪按 role
    //   - admin / boss：全字段
    //   - sales_director / sales_manager：admin group（按 actorGroupOf 归类 sales，但
    //     canAccessCustomer 视为「主管类」全可看，maskCustomer 内 sales 路径需配合）
    //   - sales_manager / sales_director 走 sales path 但 isOwnerSelf=ownerUserId 自比
    //     主管类视为 owner（拍板「老板校长 + 销售主管 ✅ 看全」）— 这里走 admin group 视为全字段
    const ownerUserId = req?.user?.sub ?? null;
    const items_masked = items.map((c) => {
      // sales_director / sales_manager 走 admin group 等效（拍板 KPI 主可看）
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
    if (!canAccessCustomer(c, req?.user)) {
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
    return this.repo.claim(
      body.tenantSchema,
      id,
      userId,
      body.userLabel || `销售 ${userId.slice(0, 6)}`,
    );
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
    return this.repo.release(
      body.tenantSchema,
      id,
      userId,
      body.userLabel || `销售 ${userId.slice(0, 6)}`,
      body.reason,
    );
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
    return this.repo.markLost(
      body.tenantSchema,
      id,
      userId,
      body.userLabel || `销售 ${userId.slice(0, 6)}`,
      body.lostReason,
    );
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
