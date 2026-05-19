/**
 * InvoiceCreateDto — POST /api/db/invoices
 *
 * 抽自 invoice/invoice.dto.ts L29-48 `CreateInvoiceDto` 原 interface
 * 5/19 Phase B.L3 contract tests SSOT (re-export 保持兼容)
 *
 * 业务语义（Wave 4A B 端 finance 域开票）：
 *   - 财务从「待开票合同」起，不经学员中转
 *   - finance 无学员域访问权（fields-by-role.md customer.联系人 ❌）
 *
 * RBAC: finance / boss / admin
 *
 * 必填：tenantSchema / invoiceId / contractId / titleType / invoiceTitle / receiveEmail
 *   - taxId 企业必填，个人可空
 *
 * PII 三写：receivePhone（hash + encrypted）；invoiceTitle / taxId / remark 走 msgSecCheck
 */
export type InvoiceTitleType = '个人' | '企业';

export interface InvoiceCreateDto {
  /** 多租户 schema（TenantScopeGuard 校验） */
  tenantSchema: string;
  /** 32-char ULID（前端生成） */
  invoiceId: string;
  /** OOUX 父对象 contract.id（32-char ULID） */
  contractId: string;
  /** '个人' | '企业' */
  titleType: InvoiceTitleType;
  /** 开票抬头（≤ 80，msgSecCheck） */
  invoiceTitle: string;
  /** 企业必填，18 位统一信用代码 */
  taxId?: string;
  /** 接收邮箱（必填） */
  receiveEmail: string;
  /** 接收手机号（可选；走 hash + encrypted 三写） */
  receivePhone?: string;
  /** 备注（≤ 200，msgSecCheck） */
  remark?: string;
}
