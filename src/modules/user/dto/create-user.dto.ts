/**
 * CreateUserDto — W3-1 sales campus_scope 应用层填充骨架
 *
 * 范围严守：仅含 sales 角色 campus_scope 默认填充逻辑所需的最小字段集。
 * 不延伸：tenants 业务字段、admin/manager/teacher 角色业务规则、密码 hash、JWT 签发等。
 *
 * 字段口径来源：
 *   - users.role: V2__tenant_schema_template.sql CHECK 实际为 8 枚举（sales/sales_manager/sales_director/marketing/finance/boss/admin/hr）；DTO 当前仅暴露 admin/manager/sales 3 个，等用户/PD 拍板对齐
 *   - users.campus_id: V2__tenant_schema_template.sql line 197 FK
 *   - users.campus_scope: V4__pd_05_06_07_tenant_schema_alter.sql 已加 JSONB DEFAULT '[]'
 *
 * USER-AUTH(2026-05-02): sales 主校区单值由用户最终拍板锁定（台账条目 28），PM-TEMP-AUTH 升级为 USER-AUTH
 */
/**
 * USER-AUTH(2026-05-02): 用户拍板「老师走方向 B」（台账条目 29）
 *   - teacher 不入 users 表，走独立 `teachers` 表（V7 ALTER 待开）
 *   - users 表角色枚举去掉 'teacher'
 *
 * 注：当前 DTO 仍存在与 V2 schema CHECK 8 枚举的漂移（manager 等），
 *   待问题 1（DTO 8 枚举对齐 DB）拍板后一次性修订。
 */
export type UserRole = 'admin' | 'manager' | 'sales';

export interface CreateUserDto {
  /** 32-char ULID Crockford Base32 */
  readonly id: string;

  /** 32-char ULID 租户标识 */
  readonly tenantId: string;

  /** 当前 DTO 暴露 3 枚举之一（admin/manager/sales）；DB CHECK 实际 8 枚举，待对齐 */
  readonly role: UserRole;

  /** 32-char ULID 主校区 ID（W3-1 临时授权下作为 sales 默认 campus_scope 唯一来源）*/
  readonly campusId: string;

  /**
   * 显式传入则按显式值；不传由 UserService 按 role 自动填充。
   *
   * USER-AUTH(2026-05-02): role=sales 且本字段未传时，
   * UserService 默认填充 [campusId]（主校区单值，用户最终拍板锁定，台账条目 28）。
   */
  readonly campusScope?: ReadonlyArray<string>;
}
