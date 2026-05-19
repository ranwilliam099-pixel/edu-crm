import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_METADATA_KEY, RbacRole } from './rbac.decorator';
import { JwtPayload } from '../modules/auth/jwt-payload.interface';

/**
 * RbacGuard — W3-1 Phase 4.2 BE-W4-2
 *
 * 来源：
 *   - 《全部人员-审核往来总台账.md》条目 14 §B Track CODE-4 BE-W4-2
 *   - AUTH-7 A11 §3.1 RBAC 角色拆分
 *
 * PM-AUTH-7(2026-04-30): 角色 RBAC 按钮级权限
 *
 * 流程：
 *   1. 路由方法上没标 @Roles → 直接放行（默认开放）
 *   2. 路由方法上标了 @Roles(...) → 校验 request.user.role
 *   3. request.user 不存在 → UnauthorizedException
 *   4. role 不在允许列表 → ForbiddenException
 *
 * 严守边界：
 *   - 不依赖任何业务模块；只读 JwtPayload.role
 *   - 不引入企业管理系统主项目任何 RBAC 实现
 *   - 不预设业务路径之外的角色升级 / 降级逻辑
 */
@Injectable()
export class RbacGuard implements CanActivate {
  private readonly logger = new Logger(RbacGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<RbacRole[]>(ROLES_METADATA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      // 路由没标角色要求 → 默认放行（由其他 guard / middleware 控制）
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user as JwtPayload | undefined;

    if (!user || !user.role) {
      this.logger.warn(`[BE-W4-2] RBAC denied: no user in request, requiredRoles=${requiredRoles.join(',')}`);
      throw new UnauthorizedException('Authentication required');
    }

    if (!requiredRoles.includes(user.role as RbacRole)) {
      this.logger.warn(
        `[BE-W4-2] RBAC denied: user.role=${user.role} not in [${requiredRoles.join(',')}]`,
      );
      throw new ForbiddenException(
        `Insufficient role: required one of [${requiredRoles.join(',')}], got ${user.role}`,
      );
    }

    return true;
  }
}
