import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { JwtStrategy } from './jwt.strategy';
import { ParentJwtStrategy } from './parent-jwt.strategy';
import { TenantMiddleware } from './tenant.middleware';
import { AuthController } from './auth.controller';

/**
 * Auth 模块（W1 BE-W1-3 + V10 BE-V10-3 ParentJwt）
 *
 * - JwtModule.registerAsync：JWT_SECRET 同时给 B 端 + C 端使用（不同 type 字段区分）
 * - JwtStrategy：B 端 token（sales/admin/...）
 * - ParentJwtStrategy：C 端家长 token（type='parent'）— 派单条目 33/34 Q-FE-2
 * - TenantMiddleware：路由分发（B 端公开+鉴权；C 端 parent 路径白名单由本中间件跳过，
 *   由 ParentAuthMiddleware 接管 — 待续，本 commit 仅交付 ParentJwtStrategy 骨架）
 *
 * USER-AUTH(2026-05-02): 条目 34 用户拍板「按建议」+ 后端补 ParentJwt 模块（0.5 人日）
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
  controllers: [AuthController],
  providers: [JwtStrategy, ParentJwtStrategy, TenantMiddleware],
  exports: [JwtStrategy, ParentJwtStrategy, TenantMiddleware, JwtModule],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantMiddleware).forRoutes('*');
  }
}
