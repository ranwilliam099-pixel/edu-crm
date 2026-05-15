import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Optional,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  CourseProductRepository,
  CourseProduct,
  CourseProductStats,
} from './course-product.repository';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';
import { Roles } from '../../guards/rbac.decorator';
import { RbacGuard } from '../../guards/rbac.guard';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';
// 5/15 拍板：course-product/:id/stats 聚合 endpoint
//   - admin / boss / academic 三角色（fields-by-role.md L261）
//   - 拒绝路径写 audit_log（custom action 'course-product.stats-access-denied'）
//   - 404 也写 audit_log（防扫描；只记 productId 不嵌入 userId 之外的敏感字段）
import { ActorRole, AuditLogRepository, normalizeActorRole } from './audit-log.repository';

/**
 * CourseProductController — V29 R6 课程产品管理（机构标准产品库）
 *
 * 来源：用户 2026-05-07 Phase 5「全做」— 校长/老板可补课程产品
 *
 * Endpoints:
 *   GET  /db/course-products              列上架产品（销售签约下拉用）
 *   GET  /db/course-products/all          列全部含下架（admin 管理用）
 *   GET  /db/course-products/:id          详情
 *   GET  /db/course-products/:id/stats    聚合 detail（5/15 拍板 OOUX 中心对象）
 *   POST /db/course-products              创建（admin / boss）
 *   POST /db/course-products/:id/status   上下架切换（admin / boss）
 *
 * 5/15 拍板（feedback_教培业务架构-2026-05-10.md §六）：
 *   course-product 升级为 OOUX 中心对象，与 student 并列；前端 boss/products/detail
 *   通过 :id/stats 聚合 endpoint 一次拿到学员/老师/本周消课。RBAC 复用拍板
 *   「老板 ✅ / 校长 ✅ 本校 / 教务 👁」(fields-by-role.md L261) — 三 role 均可读。
 *   写操作仍仅 admin / boss（已有 RBAC 不动）。
 */
@Controller('db/course-products')
@UseGuards(TenantScopeGuard)
export class CourseProductController {
  constructor(
    private readonly repo: CourseProductRepository,
    // 5/15：拒绝路径 + 404 路径 audit_log
    //   - @Optional：unit spec 直接 new 不传也能跑（兼容现有 spec）
    //   - fail-open：AuditLogRepository.log 内部 try-catch；不阻塞主业务
    @Optional() private readonly auditLog?: AuditLogRepository,
  ) {}

  /**
   * 5/15：audit_log helper（actor + ctx）
   */
  private auditCtx(req: AuthenticatedRequest): {
    actorRole: ActorRole;
    ip: string | null;
    userAgent: string | null;
    requestId: string | null;
  } {
    return {
      // 使用 normalizeActorRole 防越界 role（marketing/finance_admin 等）违反 V33 CHECK
      actorRole: normalizeActorRole(req.user?.role),
      ip: req.ip ?? null,
      userAgent: (req.headers?.['user-agent'] as string | undefined) ?? null,
      requestId: (req.headers?.['x-request-id'] as string | undefined) ?? null,
    };
  }

  /**
   * 5/15：写 audit_log 包装（fail-open）
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
      // fail-open
    }
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(
    @Query('tenantSchema') tenantSchema: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<{ items: CourseProduct[] }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const items = await this.repo.list(tenantSchema, {
      includeOffShelf: false,
      limit: limit ? Math.min(parseInt(limit, 10), 200) : 100,
      offset: offset ? parseInt(offset, 10) : 0,
    });
    return { items };
  }

  @Get('all')
  @UseGuards(RbacGuard)
  @Roles('admin', 'boss', 'sales_director')
  @HttpCode(HttpStatus.OK)
  async listAll(
    @Query('tenantSchema') tenantSchema: string,
  ): Promise<{ items: CourseProduct[] }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const items = await this.repo.list(tenantSchema, { includeOffShelf: true });
    return { items };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  async detail(
    @Param('id') id: string,
    @Query('tenantSchema') tenantSchema: string,
  ): Promise<CourseProduct | { found: false }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const c = await this.repo.findById(tenantSchema, id);
    if (!c) return { found: false };
    return c;
  }

  /**
   * 5/15 拍板：course-product/:id/stats — 聚合学员/老师/本周消课
   *
   * 来源：用户 2026-05-15「老板要看每个课程对应的学员/老师/本周消课情况」
   *        feedback_教培业务架构-2026-05-10.md §六 course-product OOUX 中心对象升级
   *
   * RBAC（fields-by-role.md L261）：
   *   - admin（老板）：跨校全权 ✅
   *   - boss（校长）：本校 ✅（campus filter 留作 future enhancement — 当前
   *     boss/admin 都看全部 tenant 内课程）
   *   - academic（教务）：本校 👁 只读 ✅
   *   - sales / teacher / hr / finance / parent：403（不在拍板矩阵）
   *
   * 错误路径：
   *   - 401: req.user 缺失（middleware 兜底）
   *   - 403: 角色不在 admin/boss/academic（RbacGuard 自动）
   *   - 404: productId 不存在（tenant 内未查到 row）
   *
   * audit_log 写入策略：
   *   - 200 成功路径：不写（高频读 endpoint，不污染 audit_log；前端缓存 30-60s）
   *   - 404 not-found：写 'course-product.stats-not-found'（防扫描线索）
   *   - 403 自动由 RbacGuard 抛，本 handler 未到（无法写 audit_log）
   *     注：B.3 模式的拒绝路径 audit_log 用于 controller 内显式判定的 403；本
   *     endpoint RBAC 已交给 RbacGuard 统一处理，不在此 handler 重复写
   *
   * PII：
   *   - 不返回 students.phone / id_number / 家庭住址
   *   - 不返回 teachers.phone / hourly_price_yuan
   *   - 仅 id / name / 业务必需字段（contractStatus / remainingHours / weeklyLessonCount）
   *   - admin/boss/academic 在 fields-by-role.md L283 一级隐私矩阵均可看 phone，但
   *     本 endpoint 是「聚合下钻列表」语义，PII 留到 student/detail 与 teacher detail
   *     再返回（前端从此处下钻进单对象 detail 看完整 PII）
   */
  @Get(':id/stats')
  @UseGuards(RbacGuard)
  @Roles('admin', 'boss', 'academic')
  @HttpCode(HttpStatus.OK)
  async getStats(
    @Param('id') id: string,
    @Query('tenantSchema') tenantSchema: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<CourseProductStats> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    if (!id || id.length !== 32) {
      throw new BadRequestException('productId must be 32-char ULID');
    }

    const stats = await this.repo.findStats(tenantSchema, id);

    if (!stats) {
      // 404 路径写 audit_log（防扫描留证据）
      //   - targetId 含 productId，after 含 attempted_role / endpoint
      //   - 不嵌入 sub 以外的敏感字段（req.user.sub 已是 actorUserId）
      await this.tryAudit(tenantSchema, {
        actorUserId: req.user?.sub ?? null,
        ...this.auditCtx(req),
        action: 'course-product.stats-not-found',
        targetType: 'course-product',
        targetId: id,
        before: null,
        after: {
          attempted_role: req.user?.role ?? 'unknown',
          endpoint: 'stats',
          reason: 'product_id_not_found_in_tenant',
        },
      });
      throw new NotFoundException(
        `COURSE_PRODUCT_NOT_FOUND: productId=${id}`,
      );
    }

    return stats;
  }

  @Post()
  @UseGuards(RbacGuard)
  @Roles('admin', 'boss')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body()
    body: {
      tenantId: string;
      tenantSchema: string;
      id: string;
      productName: string;
      courseLine: string;
      classType: string;
      lessonPackage?: string;
      standardPrice: number;
      campusScope?: string;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<CourseProduct> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    const operatorUserId = req.user?.sub;
    if (!operatorUserId) throw new BadRequestException('user sub required');
    return this.repo.create(body.tenantSchema, {
      id: body.id,
      productName: body.productName,
      courseLine: body.courseLine,
      classType: body.classType,
      lessonPackage: body.lessonPackage,
      standardPrice: body.standardPrice,
      campusScope: body.campusScope,
      operatorUserId,
    });
  }

  @Post(':id/status')
  @UseGuards(RbacGuard)
  @Roles('admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async toggleStatus(
    @Param('id') id: string,
    @Body() body: { tenantId: string; tenantSchema: string; status: '上架' | '下架' },
    @Req() req: AuthenticatedRequest,
  ): Promise<CourseProduct> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    if (body.status !== '上架' && body.status !== '下架') {
      throw new BadRequestException('status must be 上架 or 下架');
    }
    const operatorUserId = req.user?.sub;
    if (!operatorUserId) throw new BadRequestException('user sub required');
    return this.repo.setStatus(body.tenantSchema, id, body.status, operatorUserId);
  }
}
