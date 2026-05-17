import { Global, Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { JwtStrategy } from './jwt.strategy';
import { ParentJwtStrategy } from './parent-jwt.strategy';
import { TenantMiddleware } from './tenant.middleware';
import { AuthController } from './auth.controller';
import { WxCodeSessionService } from './wx-code-session.service';
// T11 (2026-05-16) refresh token rotation
import { RefreshTokenRepository } from './refresh-token.repository';
import { RefreshTokenService } from './refresh-token.service';
// Sprint X.2 (2026-05-17) — 跨表 phone 反查 + bcrypt 校验（SSOT §12）
import { PhoneLookupService } from './phone-lookup.service';
import { PasswordHasher } from '../../common/crypto/password-hasher';

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
 *
 * Sprint X.2 (2026-05-17) — @Global() 注解：
 *   原因：DbModule (@Global) 内 UserController / TenantProvisionService 需注入
 *     PhoneLookupService / PasswordHasher / RefreshTokenService。若 AuthModule 非 global,
 *     DbModule 需 imports: [AuthModule], 与 AuthModule 内 ParentRepository / AuditLogRepository
 *     等 @Global DbModule 依赖形成循环 import。
 *   解法：AuthModule 改 @Global，全局可注入 + DbModule 无需显式 imports。
 *   边界：AuthModule providers 仍仅 export 该列 (不暴露非必要内部), 见 exports 列表。
 */
@Global()
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
  providers: [
    JwtStrategy,
    ParentJwtStrategy,
    TenantMiddleware,
    WxCodeSessionService,
    // T11 (2026-05-16) RefreshTokenRepository 注入 PgPoolService（DbModule @Global() 自动解析）
    //   RefreshTokenService 注入 HmacHasher + AuditLogRepository（同 @Global() 路径），
    //   无需显式 imports: [DbModule]（DbModule 已 @Global，且会引入循环依赖如 audit-log → user）
    RefreshTokenRepository,
    RefreshTokenService,
    // Sprint X.2 (2026-05-17) — auth.controller.ts 注入新 service
    //   PhoneLookupService 注入 PgPoolService + ParentRepository（@Global DbModule 自动解析）
    //   PasswordHasher 是无依赖 stateless service（bcrypt wrapper）
    PhoneLookupService,
    PasswordHasher,
  ],
  exports: [
    JwtStrategy,
    ParentJwtStrategy,
    TenantMiddleware,
    JwtModule,
    WxCodeSessionService,
    RefreshTokenService,
    PhoneLookupService,
    PasswordHasher,
  ],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantMiddleware).forRoutes('*');
  }
}
