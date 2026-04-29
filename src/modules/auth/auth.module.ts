import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';
import { TenantMiddleware } from './tenant.middleware';

/**
 * Auth 模块（W1 BE-W1-3 / BE-W1-4 骨架）
 *
 * 当前注册：JwtStrategy + TenantMiddleware
 * 待 W1 接入：@nestjs/jwt JwtModule.registerAsync（用 ConfigService 读 JWT_SECRET / JWT_TTL_SEC）
 *
 * 中间件挂载策略：
 *   - 全局挂载在所有 /api/* 路径
 *   - /api/public/health 在 TenantMiddleware 内部分支处理（公开路径不要求 token）
 */
@Module({
  providers: [JwtStrategy, TenantMiddleware],
  exports: [JwtStrategy, TenantMiddleware],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantMiddleware).forRoutes('*');
  }
}
