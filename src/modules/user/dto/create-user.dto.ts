/**
 * CreateUserDto — W3-1 sales campus_scope 应用层填充骨架
 *
 * 范围严守：仅含 sales 角色 campus_scope 默认填充逻辑所需的最小字段集。
 * 不延伸：tenants 业务字段、admin/manager/teacher 角色业务规则、密码 hash、JWT 签发等。
 *
 * 字段口径来源：
 *   - users.role: V2__tenant_schema_template.sql CHECK 8 枚举
 *     5/15 A-2：应用层删 sales_director → 7 枚举（schema CHECK 仍允许历史 sales_director 行）
 *   - users.campus_id: V2__tenant_schema_template.sql line 197 FK
 *   - users.campus_scope: V4__pd_05_06_07_tenant_schema_alter.sql 已加 JSONB DEFAULT '[]'
 *
 * USER-AUTH(2026-05-02): sales 主校区单值由用户最终拍板锁定（台账条目 28），PM-TEMP-AUTH 升级为 USER-AUTH
 */
/**
 * USER-AUTH(2026-05-02): DTO 角色枚举与 V2 schema CHECK 对齐（台账条目 30）
 *   - V2 line 41: CHECK (role IN ('sales','sales_manager','sales_director','marketing','finance','boss','admin','hr'))
 *   - 5/15 A-2 拍板：应用层删 sales_director（fields-by-role.md 角色清单不含），
 *     V2 CHECK 仍允许此值用于历史 row 兼容（不可逆 ALTER）；DTO 拒绝再创建。
 *   - DTO 历史漂移（'manager' / 'teacher' 不在 DB 枚举内）一次性清理
 *   - teacher 走独立 `teachers` 表（条目 29 方向 B）
 */
export type UserRole =
  | 'sales'
  | 'sales_manager'
  | 'marketing'
  | 'finance'
  | 'boss'
  | 'admin'
  | 'hr';

export interface CreateUserDto {
  /** 32-char ULID Crockford Base32 */
  readonly id: string;

  /** 32-char ULID 租户标识 */
  readonly tenantId: string;

  /** 8 枚举之一，与 V2 schema CHECK 完全对齐 */
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
