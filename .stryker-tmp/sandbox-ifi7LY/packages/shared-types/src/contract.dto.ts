/**
 * ContractCreateDto — POST /api/db/contracts
 *
 * 抽自 contract.controller.ts L332-353 `create` @Body interface
 * 5/19 Phase B.L3 contract tests SSOT
 *
 * 业务语义（V25 + V29 销售自填）：
 *   - 销售录入业绩入口（业绩数据源头）
 *   - courseProductId 与 courseProductName 二选一：
 *     - courseProductId：选既有产品（标准价 join 自动带）
 *     - courseProductName：销售自填（销售线临时课程包）
 *
 * RBAC: sales / sales_manager / boss / admin
 *
 * 必填：tenantSchema / id / studentId / lessonHours / standardPrice / totalAmount
 *   + (courseProductId | courseProductName) 至少一个
 *
 * 可选：opportunityId / campusId / classType / discountAmount / giftHours / orderType / signedAt / note
 */
export type ContractOrderType = 'new' | 'renewal' | 'transfer';

export interface ContractCreateDto {
  /** 多租户 schema（TenantScopeGuard 校验） */
  tenantId: string;
  tenantSchema: string;
  /** 32-char ULID（前端生成） */
  id: string;
  /** 32-char ULID（OOUX 父对象 student.id） */
  studentId: string;
  /** 二选一其一（选既有产品） */
  courseProductId?: string;
  /** 二选一其一（销售自填课程包名） */
  courseProductName?: string;
  /** 关联商机 id（可选，customer 来路追溯） */
  opportunityId?: string;
  /** 校区 ID（跨校 admin/hr 必传；单校 role JWT 兜底） */
  campusId?: string;
  /** 班型（V32：1v1 / 小组课 / 大班） */
  classType?: string;
  /** 课时数（必填） */
  lessonHours: number;
  /** 标准单价（元） */
  standardPrice: number;
  /** 优惠金额（元，默认 0） */
  discountAmount?: number;
  /** 赠送课时数（默认 0） */
  giftHours?: number;
  /** 实付总金额（元，必填，业绩数据源头） */
  totalAmount: number;
  /** 订单类型，默认 'new' */
  orderType?: ContractOrderType;
  /** 签约时间 ISO 8601；默认 now */
  signedAt?: string;
  /** 合同备注（≤ 200，业务层 msgSecCheck） */
  note?: string;
}
