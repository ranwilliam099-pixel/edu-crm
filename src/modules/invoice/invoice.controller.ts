import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Optional,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';
import { RbacGuard } from '../../guards/rbac.guard';
import { Roles } from '../../guards/rbac.decorator';
import { IdempotencyInterceptor } from '../../common/idempotency/idempotency.interceptor';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';
import { InvoiceService } from './invoice.service';
import { CreateInvoiceDto, Invoice, PendingContractView } from './invoice.dto';
import {
  ActorRole,
  AuditLogRepository,
  normalizeActorRole,
} from '../db/audit-log.repository';

/**
 * InvoiceController — Wave 4A B 端 finance 域开票 HTTP 暴露
 *
 * 来源：用户 2026-05-14 Wave 4 P0-2 拍板
 *
 * 路径前缀 /api/db/invoices/*
 *
 * Endpoints:
 *   POST /db/invoices                       创建开票申请（B 端 finance/boss/admin）
 *   GET  /db/invoices/pending-contracts     列待开票合同（前端 new sheet 用）
 *   GET  /db/invoices/:id                   详情（已开票后 finance 复查）
 *
 * 鉴权 + 守门（class-level）：
 *   @UseGuards(TenantScopeGuard, RbacGuard)  — 三重防御
 *     - TenantScopeGuard: body/query/header tenantSchema 一致性校验
 *     - RbacGuard: 按 method-level @Roles 校验
 *
 * @Roles：finance / boss / admin
 *   - 拍板 fields-by-role.md «财务作账域»：finance ✅ / sales ❌ / teacher ❌ / academic ❌ / hr ❌ / parent ❌
 *   - boss + admin 财务全权（老板校长视图）
 *
 * @UseInterceptors(IdempotencyInterceptor)：
 *   - POST /db/invoices 强烈推荐带 Idempotency-Key 防双击双开票
 *   - 已 fail-open（无 key 直接放行兼容旧客户端）
 *
 * @Throttle：
 *   - POST /db/invoices 30/min（finance 操作频次低，防恶意刷）
 *
 * audit_log：
 *   - invoice.create SUCCESS（service 层写）
 *   - invoice.create.denied（controller 层 RBAC/tenant 拒绝时，由 RbacGuard/TenantScopeGuard 抛 403，
 *                            audit 由 Sprint E #3 整体补齐 → 本 controller 不在 catch 内做 audit，
 *                            避免「拒绝 403 但内部仍写 success audit」语义不一致）
 *
 * GET pending-contracts 路由顺序：
 *   /db/invoices/pending-contracts 必须放在 /db/invoices/:id 之前注册
 *   （否则 :id 会贪婪匹配 'pending-contracts' 字符串）
 */
@Controller('db/invoices')
@UseGuards(TenantScopeGuard, RbacGuard)
export class InvoiceController {
  private readonly logger = new Logger(InvoiceController.name);

  constructor(
    private readonly service: InvoiceService,
    @Optional() private readonly auditLog?: AuditLogRepository,
  ) {}

  /**
   * Helper：从 req 取 audit 上下文（与 contract.controller / customer.controller 同型）
   */
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

  // ============================================================
  // POST /api/db/invoices — 创建开票申请
  // ============================================================

  /**
   * @body
   *   tenantSchema   必填（TenantScopeGuard 校验）
   *   invoiceId      32-char ULID（前端生成）
   *   contractId     32-char ULID（OOUX 父对象）
   *   titleType      '个人' | '企业'
   *   invoiceTitle   开票抬头（≤80，msgSecCheck）
   *   taxId          企业必填
   *   receiveEmail   必填
   *   receivePhone   可选（PII 三写）
   *   remark         可选（≤200，msgSecCheck）
   *
   * @returns Invoice (201)
   *
   * @errors
   *   400 BadRequest          - validate 失败 / msgSecCheck risky
   *   401 Unauthorized        - JWT 缺
   *   403 Forbidden           - role 不在 [finance, boss, admin] / tenantSchema mismatch
   *   404 ContractNotFound    - contractId 不存在 / 跨 tenant
   *   409 AlreadyIssued       - contract 已开票
   */
  @Post()
  @Roles('finance', 'boss', 'admin')
  @UseInterceptors(IdempotencyInterceptor)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() body: CreateInvoiceDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<Invoice> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    if (!body.invoiceId || body.invoiceId.length !== 32) {
      throw new BadRequestException('invoiceId must be 32-char ULID');
    }
    if (!body.contractId || body.contractId.length !== 32) {
      throw new BadRequestException('contractId must be 32-char ULID');
    }
    if (!body.titleType) {
      throw new BadRequestException('titleType required');
    }
    if (!body.invoiceTitle) {
      throw new BadRequestException('invoiceTitle required');
    }
    if (!body.receiveEmail) {
      throw new BadRequestException('receiveEmail required');
    }
    const userSub = req.user?.sub;
    const userRole = req.user?.role;
    if (!userSub || !userRole) {
      throw new BadRequestException('user identity required');
    }

    return this.service.createInvoice(
      body,
      { sub: userSub, role: userRole },
      {
        ip: req.ip ?? null,
        userAgent: (req.headers?.['user-agent'] as string | undefined) ?? null,
        requestId: (req.headers?.['x-request-id'] as string | undefined) ?? null,
      },
    );
  }

  // ============================================================
  // GET /api/db/invoices/pending-contracts — 列待开票合同（new sheet 用）
  // ============================================================

  /**
   * @query
   *   tenantSchema   必填
   *   campusId?      可选过滤
   *   limit?         默认 50，max 200
   *   offset?        默认 0
   *
   * @returns { items: PendingContractView[] }
   *   PendingContractView 含 parentNameMasked（finance ❌ customer.联系人 → mask）
   */
  @Get('pending-contracts')
  @Roles('finance', 'boss', 'admin')
  @HttpCode(HttpStatus.OK)
  async listPending(
    @Query('tenantSchema') tenantSchema: string,
    @Query('campusId') campusId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<{ items: PendingContractView[] }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    return this.service.listPendingContracts(tenantSchema, {
      campusId: campusId || undefined,
      limit: limit ? Math.min(parseInt(limit, 10), 200) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
    });
  }

  // ============================================================
  // GET /api/db/invoices/:id — 详情（finance/boss/admin 复查）
  // ============================================================

  /**
   * @param id  32-char ULID
   * @query tenantSchema  必填
   *
   * @returns Invoice | { found: false }
   *
   * 字段返回策略：
   *   - 完整 PII（finance/boss/admin 可见）— mask 不在本 endpoint 做
   *   - 未来如扩展 sales/parent 查看，需 maskInvoice helper（当前 RBAC 已挡死）
   */
  @Get(':id')
  @Roles('finance', 'boss', 'admin')
  @HttpCode(HttpStatus.OK)
  async detail(
    @Param('id') id: string,
    @Query('tenantSchema') tenantSchema: string,
  ): Promise<Invoice | { found: false }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    if (!id || id.length !== 32) {
      throw new BadRequestException('id must be 32-char ULID');
    }
    const inv = await this.service.findById(tenantSchema, id);
    if (!inv) return { found: false };
    return inv;
  }
}
