import { SetMetadata } from '@nestjs/common';
import { TenantRole, PlatformRole } from '../modules/auth/jwt-payload.interface';

/**
 * RBAC 装饰器 — W3-1 Phase 4.2 BE-W4-2
 *
 * 来源：
 *   - 《全部人员-审核往来总台账.md》条目 14 §B Track CODE-4 BE-W4-2
 *   - AUTH-7 A11 §3.1 RBAC 角色拆分（platform_admin / finance_admin / 8 租户角色）
 *
 * PM-AUTH-7(2026-04-30): 角色 RBAC 按钮级权限
 *
 * 用法（在 Controller 路由方法上）：
 *   @Roles('platform_admin', 'finance_admin')
 *   @Get('/admin/refund/list')
 *   listPendingRefunds() { ... }
 *
 * RbacGuard 在 canActivate 中读取本元数据，对照 JwtPayload.role 决定放行 / 拒绝
 */

export const ROLES_METADATA_KEY = 'rbac_roles';

export type RbacRole = TenantRole | PlatformRole;

/**
 * 标注路由所需角色（OR 关系：满足任一即可）
 */
export const Roles = (...roles: RbacRole[]) => SetMetadata(ROLES_METADATA_KEY, roles);
