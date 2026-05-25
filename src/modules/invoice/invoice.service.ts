import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { InvoiceRepository } from './invoice.repository';
import {
  CreateInvoiceDto,
  Invoice,
  MarkInvoicePaidDto,
  MarkInvoicePaidResult,
  PaymentMethod,
  PendingContractView,
} from './invoice.dto';
import { SecurityService } from '../security/security.service';
import {
  ActorRole,
  AuditLogRepository,
  normalizeActorRole,
} from '../db/audit-log.repository';

/**
 * InvoiceService — Wave 4A B 端 finance 域开票业务编排
 *
 * 来源：用户 2026-05-14 Wave 4 P0-2 拍板
 *
 * 职责：
 *   1. 校验输入（DTO 层后的业务规则）
 *   2. msgSecCheck invoiceTitle + remark（wx.security 内容安全）
 *   3. 调 InvoiceRepository.createInvoiceAndMarkContract（事务原子性）
 *   4. 写 audit_log（invoice.create 成功路径）
 *
 * 不在 service 做：
 *   - RBAC（在 controller 层 @Roles + RbacGuard）
 *   - TenantScopeGuard（在 controller 层 class-level @UseGuards）
 *   - PII encrypt/hash（在 repository 层三写）
 *
 * msgSecCheck 策略：
 *   - 走 SecurityService.serverSideCheckContent (v1 API，无 openid 场景)
 *   - finance/boss/admin 用户登录态有 openid，但本 endpoint 是 B 端管理后台，
 *     设计契约未要求传 openid，且 finance 操作频次低 — 走 v1 API 与 onboarding 同型
 *   - suggest='risky' → 抛 400 BadRequest（拦截违规内容）
 *   - suggest='review' / 网络异常 → fail-open 放行（不阻塞 finance 作账主流程）
 *   - 失败仅 logger.warn，不抛主流程（fail-open，与 wxpay/onboarding 同型）
 *
 * audit_log：
 *   - invoice.create SUCCESS（after 含 invoice 完整 snapshot，金额不脱敏 — 财务作账可追溯）
 *   - invoice.create.denied（controller 层拒绝路径写 — RBAC/tenant 失败）
 */
@Injectable()
export class InvoiceService {
  private readonly logger = new Logger(InvoiceService.name);

  constructor(
    private readonly repo: InvoiceRepository,
    @Optional() private readonly security?: SecurityService,
    @Optional() private readonly auditLog?: AuditLogRepository,
  ) {}

  /**
   * 创建开票申请（B 端 finance 主流程）
   *
   * @param dto 前端表单数据（已过 TenantScopeGuard / RbacGuard / class-validator 层）
   * @param currentUser { sub, role } — 创建人（finance/boss/admin）
   * @param auditCtx { ip, userAgent, requestId } — audit_log 上下文
   * @throws BadRequestException msgSecCheck risky / 输入校验失败
   * @throws NotFoundException contract 不存在
   * @throws ConflictException contract 已开过票
   */
  async createInvoice(
    dto: CreateInvoiceDto,
    currentUser: { sub: string; role: string },
    auditCtx: {
      ip: string | null;
      userAgent: string | null;
      requestId: string | null;
    },
  ): Promise<Invoice> {
    // 1. msgSecCheck（fail-open；risky 拦截，review/error 放行）
    //    - invoiceTitle 必查（PII 抬头）
    //    - remark 仅当非空时查（可选字段）
    await this.checkContent(dto.invoiceTitle, 'invoiceTitle');
    if (dto.remark && dto.remark.trim().length > 0) {
      await this.checkContent(dto.remark, 'remark');
    }

    // 2. INSERT invoices + UPDATE contracts.invoice_issued (事务原子性)
    const invoice = await this.repo.createInvoiceAndMarkContract(dto.tenantSchema, {
      invoiceId: dto.invoiceId,
      contractId: dto.contractId,
      titleType: dto.titleType,
      invoiceTitle: dto.invoiceTitle,
      taxId: dto.taxId,
      receiveEmail: dto.receiveEmail,
      receivePhone: dto.receivePhone,
      remark: dto.remark,
      createdByUserId: currentUser.sub,
    });

    // 3. audit_log invoice.create SUCCESS
    //    金额完整入 audit（财务变更追溯红线 — 与 contract.create 同策略）
    //    PII 字段不入 audit after：invoiceTitle/taxId/receivePhone 仅保留 mask 后摘要
    //    （fields-by-role.md：finance/boss/admin 可见 PII，但 audit 长期留存需脱敏）
    await this.tryAudit(dto.tenantSchema, {
      actorUserId: currentUser.sub,
      actorRole: normalizeActorRole(currentUser.role),
      action: 'invoice.create',
      targetType: 'invoice',
      targetId: invoice.id,
      before: null,
      after: {
        id: invoice.id,
        contractId: invoice.contractId,
        studentId: invoice.studentId,
        customerId: invoice.customerId,
        titleType: invoice.titleType,
        // PII mask（仅留长度信息防日志泄露完整抬头）
        invoiceTitleLength: invoice.invoiceTitle.length,
        hasTaxId: !!invoice.taxId,
        amount: invoice.amount,
        hasRemark: !!invoice.remark,
        status: invoice.status,
        createdByUserId: invoice.createdByUserId,
      },
      ip: auditCtx.ip,
      userAgent: auditCtx.userAgent,
      requestId: auditCtx.requestId,
    });

    return invoice;
  }

  /**
   * 查 invoice 详情（解密 PII；fields-by-role.md：finance/boss/admin 全权可见）
   */
  async findById(tenantSchema: string, id: string): Promise<Invoice | null> {
    return this.repo.findById(tenantSchema, id);
  }

  /**
   * P1 业务流闭环 S2 (2026-05-20) — mark-paid 编排
   *
   * 业务流：财务在「待付款 invoice 列表」上点「已收款」按钮 →
   *   1. invoice.status: pending → issued + 写 paid_at / payment_method / issued_at
   *   2. contract.status: pending → active + 写 activated_at
   *   3. 自动建 course_package（机构课包 snapshot）
   *   4. 自动建 student_course_package（学员账户，触发 remainingLessons 余额）
   *
   * 上述 4 个写操作走 InvoiceRepository.markPaid 单事务原子性，本方法仅做：
   *   - PaymentMethod 枚举校验
   *   - 调 repo.markPaid（事务内 SELECT FOR UPDATE 双锁防并发）
   *   - 写 audit_log 3 条（invoice.mark-paid / contract.activate / student_course_package.create）
   *
   * audit_log 策略（5/10 拍板「敏感金额变更必入 audit」）：
   *   - invoice.mark-paid: amount + payment_method + paidAt 入 after（财务作账可追溯）
   *   - contract.activate: action 派生（无独立 endpoint），关联 invoice_id（before.status='pending' → after.status='active'）
   *   - student_course_package.create: totalLessons + contractId + invoiceId 入 after（教学链路源头）
   *
   * 不在 service 做：
   *   - RBAC（controller 层 @Roles + RbacGuard）
   *   - TenantScopeGuard（controller 层 class-level）
   *   - 收款方式向第三方支付平台调账（人工录入，不联动支付网关）
   *
   * @throws BadRequestException paymentMethod 非合法枚举
   * @throws NotFoundException invoice 不存在 / 合同已软删
   * @throws ConflictException invoice 已 issued/cancelled / contract 已 cancelled/expired
   */
  async markPaid(
    invoiceId: string,
    dto: MarkInvoicePaidDto,
    currentUser: { sub: string; role: string },
    auditCtx: {
      ip: string | null;
      userAgent: string | null;
      requestId: string | null;
    },
  ): Promise<MarkInvoicePaidResult> {
    // 1. PaymentMethod 枚举校验（应用层 enum）
    const validMethods: PaymentMethod[] = [
      '微信支付',
      '对公转账',
      '现金',
      '支付宝',
      '银行卡',
      '其他',
    ];
    if (!validMethods.includes(dto.paymentMethod)) {
      throw new BadRequestException(
        `paymentMethod must be one of: ${validMethods.join(' | ')}`,
      );
    }

    // 2. 调 repo.markPaid（5 步事务原子性）
    const result = await this.repo.markPaid(dto.tenantSchema, invoiceId, {
      paidAt: dto.paidAt,
      paymentMethod: dto.paymentMethod,
      operatorUserId: currentUser.sub,
    });

    // 3. audit_log 3 条（与 service 层「金额变更必入 audit」一致）
    const actorRole = normalizeActorRole(currentUser.role);

    // 3.1 invoice.mark-paid
    await this.tryAudit(dto.tenantSchema, {
      actorUserId: currentUser.sub,
      actorRole,
      action: 'invoice.mark-paid',
      targetType: 'invoice',
      targetId: result.invoice.id,
      before: {
        status: 'pending',
      },
      after: {
        status: result.invoice.status, // 'issued'
        amount: result.invoice.amount,
        paymentMethod: dto.paymentMethod,
        paidAt: result.invoice.paidAt,
        issuedAt: result.invoice.issuedAt,
        contractId: result.invoice.contractId,
        studentId: result.invoice.studentId,
        // PII mask（不入完整抬头 / 税号 / 手机）
        invoiceTitleLength: result.invoice.invoiceTitle.length,
        hasTaxId: !!result.invoice.taxId,
        hasReceivePhone: !!result.invoice.receivePhone,
      },
      ip: auditCtx.ip,
      userAgent: auditCtx.userAgent,
      requestId: auditCtx.requestId,
    });

    // 3.2 contract.activate（派生 action，关联 invoice_id 让审计可追溯触发源）
    await this.tryAudit(dto.tenantSchema, {
      actorUserId: currentUser.sub,
      actorRole,
      action: 'contract.activate',
      targetType: 'contract',
      targetId: result.contract.id,
      before: {
        status: 'pending',
      },
      after: {
        status: result.contract.status, // 'active'
        activatedAt: result.contract.activatedAt,
        totalAmount: result.contract.totalAmount,
        lessonHours: result.contract.lessonHours,
        giftHours: result.contract.giftHours,
        studentId: result.contract.studentId,
        // 关联触发源（财务 mark-paid 一气呵成激活合同）
        triggeredByInvoiceId: result.invoice.id,
      },
      ip: auditCtx.ip,
      userAgent: auditCtx.userAgent,
      requestId: auditCtx.requestId,
    });

    // 3.3 student_course_package.create
    await this.tryAudit(dto.tenantSchema, {
      actorUserId: currentUser.sub,
      actorRole,
      action: 'student_course_package.create',
      targetType: 'student_course_package',
      targetId: result.studentCoursePackage.id,
      before: null,
      after: {
        id: result.studentCoursePackage.id,
        studentId: result.studentCoursePackage.studentId,
        coursePackageId: result.studentCoursePackage.coursePackageId,
        contractId: result.studentCoursePackage.contractId,
        invoiceId: result.invoice.id,                 // 关联触发源
        totalLessons: result.studentCoursePackage.totalLessons,
        remainingLessons: result.studentCoursePackage.remainingLessons,
        activatedAt: result.studentCoursePackage.activatedAt,
        expiresAt: result.studentCoursePackage.expiresAt,
        status: result.studentCoursePackage.status,
      },
      ip: auditCtx.ip,
      userAgent: auditCtx.userAgent,
      requestId: auditCtx.requestId,
    });

    return result;
  }

  /**
   * 列待开票合同（B 端 finance new sheet 用）
   *
   * 返 PendingContractView[]（含 parentNameMasked 字段级 mask）
   *
   * 设计契约 Section E：finance 看 customer.联系人 必 mask
   *   - mask 规则：首字 + '*'.repeat(name.length - 1) + 性别敬称启发式（与现有 customer mask 风格一致）
   */
  async listPendingContracts(
    tenantSchema: string,
    options: { campusId?: string; limit?: number; offset?: number } = {},
  ): Promise<{ items: PendingContractView[] }> {
    const rows = await this.repo.listPendingContracts(tenantSchema, options);
    const items: PendingContractView[] = rows.map((r) => ({
      id: r.id,
      studentId: r.studentId,
      studentName: r.studentName,
      parentNameMasked: this.maskParentName(r.parentName),
      totalAmount: r.totalAmount,
      signedAt: r.signedAt,
      // 合同号 = id 后 8 位（可读性 + 不暴露完整 ULID）
      contractNo: r.id.slice(-8).toUpperCase(),
    }));
    return { items };
  }

  /**
   * 2026-05-25 #7 闭环：列已开 invoice (已开票 / 全部 tab 用)
   *   passthrough 到 repository.listInvoices
   *   注：本方法不脱敏（finance 看完整 PII 合法，与 createInvoice / findById 一致）
   */
  async listInvoices(
    tenantSchema: string,
    options: { status?: string; limit?: number; offset?: number } = {},
  ): Promise<Invoice[]> {
    return this.repo.listInvoices(tenantSchema, options);
  }

  /**
   * Mask 家长姓名：王二 → 王*；王小明 → 王** ；空 → null
   *   - finance 不应看完整 customer.联系人（fields-by-role.md），列表中仅辅助识别用
   */
  private maskParentName(name: string | null): string | null {
    if (!name || name.length === 0) return null;
    if (name.length === 1) return name; // 单字不 mask
    return name[0] + '*'.repeat(name.length - 1);
  }

  /**
   * msgSecCheck 内容安全（fail-open）
   *
   * @param content 待检测文本
   * @param fieldLabel 字段名（用于错误提示，不传给微信 — 防数据扩散）
   * @throws BadRequestException 微信 suggest='risky'（命中违规）
   */
  private async checkContent(content: string, fieldLabel: string): Promise<void> {
    if (!this.security) {
      // 单测 / 离线环境 — SecurityService 未注入，跳过
      this.logger.debug(`SecurityService not injected, skip msgSecCheck on ${fieldLabel}`);
      return;
    }
    try {
      const result = await this.security.serverSideCheckContent(content);
      if (result.suggest === 'risky') {
        // 拦截违规（不透传微信 label 内容 — 防上游变更导致前端格式漂移）
        throw new BadRequestException(
          `INVOICE_CONTENT_RISKY: ${fieldLabel} contains disallowed content`,
        );
      }
      // suggest='pass' / 'review' / undefined / 网络异常 → 放行（fail-open）
    } catch (err) {
      if (err instanceof BadRequestException) {
        throw err;
      }
      // 上游 access_token / network 失败 → fail-open（不阻塞 finance 作账）
      // 不在日志 log content (PII 防扩散，与 redact-paths.ts 通配规则双层防御)
      this.logger.warn(
        `msgSecCheck failed on ${fieldLabel}: ${(err as Error).message} — fail-open`,
      );
    }
  }

  /**
   * audit_log 写入（fail-open；audit 失败不阻塞主业务）
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
    if (!this.auditLog) return;
    try {
      await this.auditLog.log(tenantSchema, entry);
    } catch {
      // fail-open；AuditLogRepository.log 内部已 catch，此处兜底
    }
  }
}
