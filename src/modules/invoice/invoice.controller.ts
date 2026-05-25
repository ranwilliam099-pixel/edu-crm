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
import {
  CreateInvoiceDto,
  Invoice,
  MarkInvoicePaidDto,
  MarkInvoicePaidResult,
  PendingContractView,
} from './invoice.dto';
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
 *   POST /db/invoices/:id/mark-paid         P1 业务流 S2 — 标记收款 + 合同激活 + 自动建课时包
 *   GET  /db/invoices/pending-contracts     列待开票合同（前端 new sheet 用）
 *   GET  /db/invoices/:id                   详情（已开票后 finance 复查）
 *
 * 鉴权 + 守门（class-level）：
 *   @UseGuards(TenantScopeGuard, RbacGuard)  — 三重防御
 *     - TenantScopeGuard: body/query/header tenantSchema 一致性校验
 *     - RbacGuard: 按 method-level @Roles 校验
 *
 * @Roles：finance（2026-05-15 A-1 拍板严格收敛；不含 boss/admin）
 *   - SSOT §6 操作权限矩阵：`finance.invoice.create=[finance]` — 5/15 A-1 修订：不含 boss/admin
 *   - 拍板 fields-by-role.md «财务作账域»：finance ✅ / sales ❌ / teacher ❌ / academic ❌ / hr ❌ / parent ❌
 *   - boss/admin 不直接开票（避免老板/校长越权代签财税单据）；红冲/作废仍走 delete 路径（admin/boss）
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
 *
 * OOUX 路径豁免（Wave 4A round 2，business validator P1 补注释）：
 *   平级路径 POST /api/db/invoices 而非 contract 子资源 /db/contracts/:id/invoices。
 *   依据 Wave 0 设计 P0-2 方案 C（p0-ooux-design-2026-05-14.md L361/394）：
 *     - 财务从「待开票合同」起，不经学员中转
 *     - finance 无学员域访问权（fields-by-role.md customer.联系人 ❌）
 *     - 入口对象是 contract（body.contractId 必填体现父对象关系）
 *   5/14 拍板 P0-2 优先级高于 5/10 通用 OOUX 「contract 是 student 子对象」规则。
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
   *   403 Forbidden           - role !== 'finance' / tenantSchema mismatch（5/15 A-1：boss/admin 也 403）
   *   404 ContractNotFound    - contractId 不存在 / 跨 tenant
   *   409 AlreadyIssued       - contract 已开票
   */
  @Post()
  @Roles('finance')
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
  // POST /api/db/invoices/:id/mark-paid — 财务标记收款 + 合同激活 + 自动建课时包
  // ============================================================

  /**
   * P1 业务流闭环 S2 (2026-05-20)
   *
   * @param id           32-char ULID invoiceId
   * @body
   *   tenantSchema    必填（TenantScopeGuard 校验）
   *   paidAt          ISO8601 实际收款时间
   *   paymentMethod   收款方式枚举（微信支付/对公转账/现金/支付宝/银行卡/其他）
   *
   * @returns MarkInvoicePaidResult { invoice, contract, studentCoursePackage }
   *
   * @errors
   *   400 BadRequest      paidAt 非 ISO8601 / paymentMethod 非合法枚举 / id 非 32-char / contract 0 课时
   *   401 Unauthorized    JWT 缺
   *   403 Forbidden       role !== 'finance' / tenantSchema mismatch
   *   404 NotFound        invoice 不存在 / contract 软删
   *   409 Conflict        invoice.status != 'pending' / contract.status='cancelled'/'expired'
   *
   * 5/20 拍板：@Roles('finance')（与 invoice.create 一致，SSOT §6 finance.invoice.* 严格只允许 finance）
   *
   * @UseInterceptors(IdempotencyInterceptor)：
   *   强烈推荐前端带 Idempotency-Key 防双击二次激活（合同已 active 后再 mark-paid 会 409 防御兜底，
   *   但 Idempotency 层先挡更友好）
   *
   * @Throttle 30/min：财务操作频次低，防恶意刷
   */
  @Post(':invoiceId/mark-paid')
  @Roles('finance')
  @UseInterceptors(IdempotencyInterceptor)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  async markPaid(
    @Param('invoiceId') invoiceId: string,
    @Body() body: MarkInvoicePaidDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<MarkInvoicePaidResult> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    if (!invoiceId || invoiceId.length !== 32) {
      throw new BadRequestException('invoiceId must be 32-char ULID');
    }
    if (!body.paidAt) {
      throw new BadRequestException('paidAt required (ISO8601)');
    }
    // ISO8601 简易校验（service 层会再做精确 Date 解析校验）
    const parsedAt = new Date(body.paidAt);
    if (Number.isNaN(parsedAt.getTime())) {
      throw new BadRequestException('paidAt must be valid ISO8601 datetime');
    }
    if (!body.paymentMethod) {
      throw new BadRequestException('paymentMethod required');
    }
    const userSub = req.user?.sub;
    const userRole = req.user?.role;
    if (!userSub || !userRole) {
      throw new BadRequestException('user identity required');
    }

    return this.service.markPaid(
      invoiceId,
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
  @Roles('finance')
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

  /**
   * 2026-05-25 #7 闭环：GET /api/db/invoices?status=issued|pending|cancelled
   *
   * 用户审计：finance-invoices/list 「已开票」「全部」tab 之前无后端数据源，
   * 仅靠前端 filter status 但实际数据只是 pending-contracts → 显示「同一数据」。
   *
   * 本 endpoint 直接列 invoices 表（已创建过的发票），与 pending-contracts（未开票合同）互补：
   *   - 「待开票」tab 走 GET /api/db/invoices/pending-contracts（contract 视角）
   *   - 「已开票」tab 走 GET /api/db/invoices?status=issued (invoice 视角)
   *   - 「全部」  tab 走 GET /api/db/invoices (无 filter)
   *
   * RBAC: @Roles('finance') 与 listPending 一致
   *
   * 注：本 endpoint 必须放在 @Get(':invoiceId') 之前，否则 NestJS 路由匹配会把 ''
   * 当 invoiceId（空字符串）。NestJS @Get() 无 path = root，可正常匹配。
   */
  @Get()
  @Roles('finance')
  @HttpCode(HttpStatus.OK)
  async listInvoices(
    @Query('tenantSchema') tenantSchema: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<{ items: Invoice[] }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const allowedStatus = ['pending', 'issued', 'cancelled'];
    if (status && !allowedStatus.includes(status)) {
      throw new BadRequestException(
        `status must be one of: ${allowedStatus.join(', ')}`,
      );
    }
    const items = await this.service.listInvoices(tenantSchema, {
      status: status || undefined,
      limit: limit ? Math.min(parseInt(limit, 10), 200) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
    });
    return { items };
  }

  // ============================================================
  // GET /api/db/invoices/:invoiceId — 详情（finance/boss/admin 复查）
  // ============================================================

  /**
   * @param invoiceId  32-char ULID
   * @query tenantSchema  必填
   *
   * @returns Invoice | { found: false }
   *
   * 字段返回策略：
   *   - 完整 PII（finance/boss/admin 可见）— mask 不在本 endpoint 做
   *   - 未来如扩展 sales/parent 查看，需 maskInvoice helper（当前 RBAC 已挡死）
   */
  @Get(':invoiceId')
  @Roles('finance')
  @HttpCode(HttpStatus.OK)
  async detail(
    @Param('invoiceId') invoiceId: string,
    @Query('tenantSchema') tenantSchema: string,
  ): Promise<Invoice | { found: false }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    if (!invoiceId || invoiceId.length !== 32) {
      throw new BadRequestException('invoiceId must be 32-char ULID');
    }
    const inv = await this.service.findById(tenantSchema, invoiceId);
    if (!inv) return { found: false };
    return inv;
  }
}
