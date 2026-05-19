/**
 * JWT audience（T6a 2026-05-16 audit A1-r2 P0-NEW-3）
 *
 * 切分两类 token：
 *   - 'b-app'      B 端员工 token（AuthController.login 签发）
 *   - 'parent-app' C 端家长 token（ParentJwtStrategy.sign 签发）
 *
 * 双钥共用 JWT_SECRET，靠 audience 区分流量，防 B 端 admin/boss JWT 调 /api/parents/**。
 */
export const AUDIENCE_B_APP = 'b-app' as const;
export const AUDIENCE_PARENT_APP = 'parent-app' as const;

/**
 * JWT Claims（接口清单 V1 §6.1）
 *
 * - sub:        用户 ID（ULID, 32 chars）
 * - tenantId:   租户 ID（null = 平台超管，A11）
 * - role:       10 角色枚举 + platform_admin / finance_admin
 *               5/15 A-2 删 sales_director（11 → 10，详见 TenantRole 注释）
 * - campusId:   校区 ID（追加 #15 A08：标准版 ≤ 3 校区）
 * - exp / iat:  标准 JWT 字段
 * - jti:        JWT ID（Sprint E.1 加 — logout 黑名单查询 key；旧 token 无此字段时跳过黑名单查询）
 * - aud:        T6a audience 切分（'b-app'）；旧 token 无此字段（向前兼容）
 */
export interface JwtPayload {
  sub: string;
  tenantId: string | null;
  role: TenantRole | PlatformRole;
  campusId: string | null;
  exp?: number;
  iat?: number;
  jti?: string;
  aud?: string;
}

/**
 * Sprint B (2026-05-11) 扩展：新增 teacher / academic / academic_admin 三个 role
 *   - teacher：主讲老师（可改自己学生反馈、月报 finalize-teacher、showcase-meta self-edit）
 *   - academic：普通教务（拍板「教务全只读老师线」，仅 GET 老师线对象）
 *   - academic_admin：教务主管（5/10 拍板「教务/教务主管」双层；可批办、看全 campus 教务流）
 *
 * 三者均为单校 role（campusId 必填 32-char ULID），归属同一 campus。
 *
 * 5/15 A-2 拍板（用户口头）：sales_director 不在拍板权威 9 角色清单（fields-by-role.md
 *   L6-17 角色简表仅含 admin/boss/sales+sales_manager/academic/teacher/finance/hr/parent）—
 *   sales_director 是 dev 5/12 之前自加的「自由发挥」。本次应用层取消：
 *     - TenantRole 删 'sales_director'（jwt parse 时识别不到 → 401 Missing role 或类似）
 *     - CROSS_CAMPUS_ROLES 删 'sales_director'
 *     - role-field-filter / @Roles 装饰器 / login validRoles 全删
 *
 *   schema 层（V2 users.role CHECK + V33 audit_log.actor_role CHECK）仍含 sales_director —
 *   历史数据兼容保留，应用层不再主动生成。如生产实际有 sales_director 用户，需用户拍板
 *   迁移到 sales_manager（销售校内主管）或 admin（跨校管理）。
 *
 * 跨校组（CROSS_CAMPUS_ROLES）：admin / hr（删 sales_director 后剩 2 个）。
 */
export type TenantRole =
  | 'sales'
  | 'sales_manager'
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
 * 跨校组（V10 拍板 + 5/15 A-2 修订）：admin（老板）/ hr
 * 这两个 role 没有单一校区归属，jwt.campusId 允许为 null
 *   - admin 业务卡 = 老板，跨校看全量
 *   - hr 跨校管理员工
 *
 * 5/15 A-2 拍板：原 V10 含 sales_director 已删（不在拍板权威 9 角色清单，
 *   fields-by-role.md L13 销售栏 = sales + sales_manager 双层，无大区经理）。
 *
 * 单校组（campusId 必填 32 字符 ULID）：
 *   sales / sales_manager / boss / marketing / finance / teacher / academic / academic_admin
 */
export const CROSS_CAMPUS_ROLES: readonly TenantRole[] = [
  'admin',
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
