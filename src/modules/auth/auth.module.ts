import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { JwtStrategy } from './jwt.strategy';
import { TenantMiddleware } from './tenant.middleware';

/**
 * Auth 模块（W1 BE-W1-3 真接入版 + BE-W1-4）
 *
 * - JwtModule.registerAsync：用 ConfigService 注入 JWT_SECRET + JWT_TTL_SEC
 * - JwtStrategy：解析 + 校验 token，注入 JwtService（@nestjs/jwt）
 * - TenantMiddleware：路由分发（接口清单 V1 §6.2 完整 4 路径分支）
 *
 * 中间件挂载策略：全局挂在所有 `*` 路径；公开路径在 TenantMiddleware 内部分支处理（不要求 token）
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET') ?? '__CHANGE_ME_IN_PROD__',
        signOptions: {
          expiresIn: `${config.get<number>('JWT_TTL_SEC', 86400)}s`,
        },
      }),
    }),
  ],
  providers: [JwtStrategy, TenantMiddleware],
  exports: [JwtStrategy, TenantMiddleware, JwtModule],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantMiddleware).forRoutes('*');
  }
}
