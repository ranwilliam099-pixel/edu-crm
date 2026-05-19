/**
 * CustomerCreateDto — POST /api/db/customers
 *
 * 抽自 customer.controller.ts L145-162 `createSelfBuilt` @Body interface
 * 5/19 Phase B.L3 contract tests SSOT
 *
 * 业务语义（V29 R2 销售即时建客户）：
 *   - 销售自己开拓的客户能即时录入，不必等公共池
 *   - 一次创建 customer + opportunity（可选附带 student）
 *
 * RBAC: sales / sales_manager / boss / admin（5/15 A-2 删 sales_director）
 *
 * 必填：tenantSchema / customerId / opportunityId / parentName / primaryMobile
 *   - campusId 单校 role 可由 JWT.campusId 兜底；跨校 role（admin/hr）必传
 *
 * 可选：studentId / studentName / gradeOrAge / intendedSubject / source / note / stage
 */
export interface CustomerCreateDto {
  /** 多租户 schema（TenantScopeGuard 校验） */
  tenantId: string;
  tenantSchema: string;
  /** 32-char ULID（前端生成） */
  customerId: string;
  /** 32-char ULID（前端生成） */
  opportunityId: string;
  /** 家长姓名（PII，三写 hash + encrypted） */
  parentName: string;
  /** 家长手机号（PII，三写 hash + encrypted） */
  primaryMobile: string;
  /** 校区 ID（单校 role 可从 JWT 兜底；跨校 admin/hr 必填） */
  campusId?: string;
  /** 可选：一并建学生（前端生成 ULID） */
  studentId?: string;
  studentName?: string;
  /** 学段或年龄段（如「高三」/「6 岁」） */
  gradeOrAge?: string;
  /** 意向科目 */
  intendedSubject?: string;
  /** 来源（如「转介绍」/「地推」） */
  source?: string;
  /** 跟进备注（≤ 200，业务层 msgSecCheck） */
  note?: string;
  /** 跟进阶段，默认「初步接触」 */
  stage?: string;
}
