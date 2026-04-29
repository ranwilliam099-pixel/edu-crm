/**
 * JWT Claims（接口清单 V1 §6.1）
 *
 * - sub:        用户 ID（ULID, 32 chars）
 * - tenantId:   租户 ID（null = 平台超管，A11）
 * - role:       8 角色枚举 + platform_admin / finance_admin（A11 §角色拆分）
 * - campusId:   校区 ID（追加 #15 A08：标准版 ≤ 3 校区）
 * - exp / iat:  标准 JWT 字段
 */
export interface JwtPayload {
  sub: string;
  tenantId: string | null;
  role: TenantRole | PlatformRole;
  campusId: string | null;
  exp?: number;
  iat?: number;
}

export type TenantRole =
  | 'sales'
  | 'sales_manager'
  | 'sales_director'
  | 'marketing'
  | 'finance'
  | 'boss'
  | 'admin'
  | 'hr';

export type PlatformRole = 'platform_admin' | 'finance_admin';

export const PLATFORM_ROLES: readonly PlatformRole[] = ['platform_admin', 'finance_admin'] as const;

export function isPlatformRole(role: string): role is PlatformRole {
  return (PLATFORM_ROLES as readonly string[]).includes(role);
}
