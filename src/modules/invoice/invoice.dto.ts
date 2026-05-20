/**
 * InvoiceDto — Wave 4A B 端 finance 域开票 DTO
 *
 * 来源：用户 2026-05-14 Wave 4 P0-2 拍板（前端 b/finance-invoices/new 表单契约）
 * 设计契约：edu-mp-sandbox/docs/p0-ooux-design-2026-05-14.md
 *
 * 字段清单（设计契约 Section C）：
 *   - contractId         32-char ULID（必填）          OOUX 父对象
 *   - invoiceId          32-char ULID（前端生成必填）
 *   - titleType          '个人' | '企业'（必填）
 *   - invoiceTitle       text ≤ 80（必填，走 msgSecCheck）
 *   - taxId              企业必填，18 位统一信用代码
 *   - receiveEmail       邮箱 RFC 5322 简化版（必填）
 *   - receivePhone       手机号 11 位（可选）
 *   - remark             text ≤ 200（可选，走 msgSecCheck）
 *
 * 验证策略：
 *   - 长度上限严格守 controller / service 层（DTO 仅做 narrow，避免 class-validator 增加依赖噪音）
 *   - msgSecCheck 在 service 层异步调用（SecurityService.serverSideCheckContent）
 *   - PII 加密在 repository 层（FieldEncryptor / HmacHasher 三写）
 *
 * 不强校验 18 位统一信用代码格式：
 *   - 后端不复用前端正则（部分国资单位编码不完全符合标准）
 *   - 仅校验长度 5..32 + 非空（防 SQL 注入靠 parameterized query）
 *
 * Phase B.L3 (2026-05-19) 改造为 class + @ApiProperty:
 *   - 让 SwaggerModule.createDocument 生成 requestBody schema（OpenAPI baseline 含真 schema）
 *   - InvoiceCreateDto 同步 re-export 自 @edu/shared-types（contract SSOT 单一源）
 *   - 兼容旧 `CreateInvoiceDto` 名字 alias，不破坏现有调用
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { InvoiceCreateDto as SharedInvoiceCreateDto } from '@edu/shared-types';

export type InvoiceTitleType = '个人' | '企业';

export class CreateInvoiceDto implements SharedInvoiceCreateDto {
  @ApiProperty({ description: '多租户 schema（TenantScopeGuard 校验）' })
  tenantSchema!: string;

  @ApiProperty({
    description: '32-char ULID（前端生成；与 contracts/students 一致）',
    minLength: 32,
    maxLength: 32,
  })
  invoiceId!: string;

  @ApiProperty({ description: 'OOUX 父对象 contract.id（32-char ULID）', minLength: 32, maxLength: 32 })
  contractId!: string;

  @ApiProperty({ description: '抬头类型', enum: ['个人', '企业'] })
  titleType!: InvoiceTitleType;

  @ApiProperty({ description: '开票抬头（≤ 80，msgSecCheck 过 wx.security）', maxLength: 80 })
  invoiceTitle!: string;

  @ApiPropertyOptional({ description: '企业必填；18 位统一信用代码', maxLength: 32 })
  taxId?: string;

  @ApiProperty({ description: '接收邮箱（必填）' })
  receiveEmail!: string;

  @ApiPropertyOptional({ description: '接收手机号（可选；走 hash + encrypted 三写）' })
  receivePhone?: string;

  @ApiPropertyOptional({ description: '备注（≤ 200，msgSecCheck）', maxLength: 200 })
  remark?: string;
}

export type InvoiceStatus = 'pending' | 'issued' | 'cancelled';

/**
 * Invoice — 持久化后的实体（POST 响应仅返回 minimal 字段）
 * Repository 层用，与 PG row 1:1 映射
 */
export interface Invoice {
  id: string;
  contractId: string;
  studentId: string | null;
  customerId: string | null;
  titleType: InvoiceTitleType;
  invoiceTitle: string;       // 解密后明文
  taxId: string | null;       // 解密后明文
  receiveEmail: string | null;
  receivePhone: string | null;  // 解密后明文
  amount: number;
  remark: string | null;
  status: InvoiceStatus;
  createdByUserId: string;
  issuedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  // P1 业务流 S2 (V54) — mark-paid endpoint 写入字段
  paidAt: string | null;
  paymentMethod: string | null;
}

/**
 * PendingContractView — 给前端 b/finance-invoices/new sheet 列表用的合同视图
 *
 * 设计契约 Section D 辅助 endpoint：
 *   GET /api/db/invoices/pending-contracts
 *   返 { items: [{ id, contractNo, studentName, parentNameMasked, totalAmount, signedAt }, ...] }
 *
 * 字段级 mask：
 *   - parentNameMasked = customer.parent_name 首字 + '*' + '女士/先生'
 *     （fields-by-role.md：finance ❌ customer.联系人 → 必须 mask）
 */
export interface PendingContractView {
  id: string;
  studentId: string;
  studentName: string | null;
  parentNameMasked: string | null;
  totalAmount: number;
  signedAt: string | null;
  /** OOUX：合同号即 contract.id 后 8 位（前端展示用，可读性强） */
  contractNo: string;
}

// ============================================================
// P1 业务流闭环 S2 (2026-05-20)：mark-paid → 合同激活 → 自动建课时包
// ============================================================

/** 收款方式枚举（财务录入收款记账） */
export type PaymentMethod =
  | '微信支付'
  | '对公转账'
  | '现金'
  | '支付宝'
  | '银行卡'
  | '其他';

/** mark-paid 入参（POST /api/db/invoices/:id/mark-paid Body） */
export class MarkInvoicePaidDto {
  @ApiProperty({ description: '多租户 schema（TenantScopeGuard 校验）' })
  tenantSchema!: string;

  @ApiProperty({
    description: '收款时间 ISO8601（财务实际收到款的时间，可早于 mark-paid 操作时间）',
    example: '2026-05-20T10:30:00.000Z',
  })
  paidAt!: string;

  @ApiProperty({
    description: '收款方式',
    enum: ['微信支付', '对公转账', '现金', '支付宝', '银行卡', '其他'],
  })
  paymentMethod!: PaymentMethod;
}

/**
 * mark-paid 响应体（一次写多个资源的复合返回）
 *
 * 设计意图：
 *   - 前端财务页 mark-paid 后立即更新 3 个相关视图（invoice/contract/课时包）
 *   - 不需再发 3 次 GET 拉取，省 N+1 网络请求
 */
export interface MarkInvoicePaidResult {
  invoice: Invoice;
  contract: MarkPaidContract;
  studentCoursePackage: MarkPaidStudentCoursePackage;
}

/** 合同激活后 snapshot（与 ContractRepository.Contract 同型，最小子集） */
export interface MarkPaidContract {
  id: string;
  studentId: string;
  status: 'active';                       // mark-paid 后必为 active
  activatedAt: string;                    // NOW() 由 ContractRepository.setStatus 自动写
  totalAmount: number;
  lessonHours: number;
  giftHours: number;
}

/** 自动建的 student_course_package snapshot */
export interface MarkPaidStudentCoursePackage {
  id: string;
  studentId: string;
  coursePackageId: string;                // 自动建的 course_package.id
  contractId: string;
  totalLessons: number;                   // = contract.lessonHours + contract.giftHours
  usedLessons: 0;                         // 初始 0
  refundedLessons: 0;                     // 初始 0
  remainingLessons: number;               // = totalLessons - 0 - 0（GENERATED ALWAYS）
  activatedAt: string;                    // NOW()
  expiresAt: string;                      // NOW() + validityMonths
  status: 'active';
}
