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
 */

export type InvoiceTitleType = '个人' | '企业';

export interface CreateInvoiceDto {
  /** 多租户 schema（必填，TenantScopeGuard 校验） */
  tenantSchema: string;
  /** 32-char ULID（前端生成；与 contracts/students 一致） */
  invoiceId: string;
  /** OOUX 父对象 contract.id（32-char ULID） */
  contractId: string;
  /** '个人' | '企业' */
  titleType: InvoiceTitleType;
  /** 开票抬头（≤ 80，msgSecCheck 过 wx.security） */
  invoiceTitle: string;
  /** 企业必填；18 位统一信用代码（后端弱校验长度，前端守强校验） */
  taxId?: string;
  /** 接收邮箱（必填） */
  receiveEmail: string;
  /** 接收手机号（可选；走 hash + encrypted 三写） */
  receivePhone?: string;
  /** 备注（≤ 200，msgSecCheck） */
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
