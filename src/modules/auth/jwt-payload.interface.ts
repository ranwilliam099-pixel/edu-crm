/**
 * JWT Claims（接口清单 V1 §6.1）
 *
 * - sub:        用户 ID（ULID, 32 chars）
 * - tenantId:   租户 ID（null = 平台超管，A11）
 * - role:       11 角色枚举 + platform_admin / finance_admin（A11 §角色拆分 + Sprint B 老师线）
 * - campusId:   校区 ID（追加 #15 A08：标准版 ≤ 3 校区）
 * - exp / iat:  标准 JWT 字段
 * - jti:        JWT ID（Sprint E.1 加 — logout 黑名单查询 key；旧 token 无此字段时跳过黑名单查询）
 */
export interface JwtPayload {
  sub: string;
  tenantId: string | null;
  role: TenantRole | PlatformRole;
  campusId: string | null;
  exp?: number;
  iat?: number;
  jti?: string;
}

/**
 * Sprint B (2026-05-11) 扩展：新增 teacher / academic / academic_admin 三个 role
 *   - teacher：主讲老师（可改自己学生反馈、月报 finalize-teacher、showcase-meta self-edit）
 *   - academic：普通教务（拍板「教务全只读老师线」，仅 GET 老师线对象）
 *   - academic_admin：教务主管（5/10 拍板「教务/教务主管」双层；可批办、看全 campus 教务流）
 *
 * 三者均为单校 role（campusId 必填 32-char ULID），归属同一 campus。
 * 跨校组（CROSS_CAMPUS_ROLES）仍维持 V10 拍板：admin / sales_director / hr。
 */
export type TenantRole =
  | 'sales'
  | 'sales_manager'
  | 'sales_director'
  | 'marketing'
  | 'finance'
  | 'boss'
  | 'admin'
  | 'hr'
  | 'teacher'
  | 'academic'
  | 'academic_admin';

export type PlatformRole = 'platform_admin' | 'finance_admin';

export const PLATFORM_ROLES: readonly PlatformRole[] = ['platform_admin', 'finance_admin'] as const;

export function isPlatformRole(role: string): role is PlatformRole {
  return (PLATFORM_ROLES as readonly string[]).includes(role);
}

/**
 * 跨校组（V10 拍板）：admin（老板）/ sales_director（大区经理）/ hr
 * 这三个 role 没有单一校区归属，jwt.campusId 允许为 null
 *   - admin 业务卡 = 老板，跨校看全量
 *   - sales_director = 大区经理，跨校看团队
 *   - hr 跨校管理员工
 *
 * 单校组（campusId 必填 32 字符 ULID）：
 *   sales / sales_manager / boss / marketing / finance
 */
export const CROSS_CAMPUS_ROLES: readonly TenantRole[] = [
  'admin',
  'sales_director',
  'hr',
] as const;

export function isCrossCampusRole(role: string): boolean {
  return (CROSS_CAMPUS_ROLES as readonly string[]).includes(role);
}

/**
 * Express Request 扩展类型 — controller 用 `@Req() req: AuthenticatedRequest`
 * 替代 `req: any`，保留类型安全又不引入硬依赖
 */
export interface AuthenticatedRequest {
  user?: JwtPayload;
  parent?: { sub: string; parentId?: string; role: string };
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  body?: Record<string, unknown>;
  query?: Record<string, unknown>;
  params?: Record<string, string>;
  url?: string;
  method?: string;
}
