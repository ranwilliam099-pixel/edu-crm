/**
 * CreateUserDto — W3-1 sales campus_scope 应用层填充骨架
 *
 * 范围严守：仅含 sales 角色 campus_scope 默认填充逻辑所需的最小字段集。
 * 不延伸：tenants 业务字段、admin/manager/teacher 角色业务规则、密码 hash、JWT 签发等。
 *
 * 字段口径来源：
 *   - users.role: V2__tenant_schema_template.sql line 195 CHECK 4 枚举
 *   - users.campus_id: V2__tenant_schema_template.sql line 197 FK
 *   - users.campus_scope: V4__pd_05_06_07_tenant_schema_alter.sql 已加 JSONB DEFAULT '[]'
 *
 * PM-TEMP-AUTH(2026-04-30): 仅本 DTO 用于 sales campus_scope 主校区单值临时授权代码路径
 */
export type UserRole = 'admin' | 'manager' | 'sales' | 'teacher';

export interface CreateUserDto {
  /** 32-char ULID Crockford Base32 */
  readonly id: string;

  /** 32-char ULID 租户标识 */
  readonly tenantId: string;

  /** 4 枚举之一 */
  readonly role: UserRole;

  /** 32-char ULID 主校区 ID（W3-1 临时授权下作为 sales 默认 campus_scope 唯一来源）*/
  readonly campusId: string;

  /**
   * 显式传入则按显式值；不传由 UserService 按 role 自动填充。
   *
   * PM-TEMP-AUTH(2026-04-30): role=sales 且本字段未传时，
   * UserService 默认填充 [campusId]（主校区单值，等产品最终签字回归）。
   */
  readonly campusScope?: ReadonlyArray<string>;
}
