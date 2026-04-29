import { Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { JwtStrategy } from './jwt.strategy';
import { JwtPayload, isPlatformRole } from './jwt-payload.interface';

/**
 * 租户中间件（A01 schema-per-tenant + 接口清单 V1 §6.2 网关层）
 *
 * 职责：
 *   1. 解析 Authorization: Bearer <token>
 *   2. 把 JwtPayload 挂到 req.user
 *   3. 路由分发规则（接口清单 V1 §6.2）：
 *        - /api/admin/*       强制 tenantId === null && isPlatformRole(role)
 *        - /api/checkout/*    允许游客或已支付用户（不在本中间件做校验）
 *        - /api/onboarding/*  强制已支付用户（应用层用 PaidUserGuard）
 *        - 其他 /api/*         强制 tenantId !== null，自动注入 tenant_<id> schema
 *   4. ORM session SET search_path = tenant_<tenantId>, public（在 ORM 拦截器层落地，本中间件仅设置 req 上下文）
 *
 * §0 不猜测：实际 ORM session 切换由 W1 BE-W1-4/T-W2-... 落地，当前仅做 req 注入
 *
 * 项目隔离（追加 #8）：本中间件不引用企业管理系统主项目任何 auth 实现
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(private readonly jwt: JwtStrategy) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    // 用 originalUrl 而非 req.path：NestJS setGlobalPrefix('api') 后，全局 middleware
    // 在路由解析前执行；req.path 在某些 Express 内部路由层可能去掉 prefix。
    // originalUrl 保留 ?query，需先去 query 段再做前缀匹配。
    // 实测发现：req.path 在 setGlobalPrefix + middleware('*') 组合下不可靠。
    const fullUrl = req.originalUrl || req.url || req.path || '';
    const path = fullUrl.split('?')[0];

    // 公开成交链路：游客可访问，仅在已登录时挂用户
    if (path.startsWith('/api/public/') || path.startsWith('/api/checkout/')) {
      this.tryAttachUser(req);
      return next();
    }

    // 平台超管路径：必须无租户 + 平台角色
    if (path.startsWith('/api/admin/')) {
      const user = this.requireUser(req);
      if (user.tenantId !== null) {
        throw new UnauthorizedException('admin path requires tenantId=null');
      }
      if (!isPlatformRole(user.role)) {
        throw new UnauthorizedException('admin path requires platform role');
      }
      return next();
    }

    // 开通向导：必须已登录（已支付用户在应用层 PaidUserGuard 校验）
    if (path.startsWith('/api/onboarding/')) {
      this.requireUser(req);
      return next();
    }

    // 其他业务接口：必须已登录 + 有租户
    const user = this.requireUser(req);
    if (!user.tenantId) {
      throw new UnauthorizedException('tenant context required');
    }

    // ORM session search_path 切换由 ORM 拦截器层落地（BE-W1-4），此处仅记录上下文
    (req as RequestWithTenant).tenantSchema = `tenant_${user.tenantId}`;
    next();
  }

  private tryAttachUser(req: Request): void {
    const token = this.extractToken(req);
    if (!token) return;
    try {
      (req as RequestWithUser).user = this.jwt.parse(token);
    } catch {
      // 公开路径忽略 token 错误
    }
  }

  private requireUser(req: Request): JwtPayload {
    const token = this.extractToken(req);
    if (!token) throw new UnauthorizedException('Missing Authorization header');
    const user = this.jwt.parse(token);
    (req as RequestWithUser).user = user;
    return user;
  }

  private extractToken(req: Request): string | null {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return null;
    return auth.substring('Bearer '.length).trim() || null;
  }
}

interface RequestWithUser extends Request {
  user?: JwtPayload;
}

interface RequestWithTenant extends RequestWithUser {
  tenantSchema?: string;
}
