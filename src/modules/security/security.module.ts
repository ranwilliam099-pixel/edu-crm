import { Global, Module } from '@nestjs/common';
import { SecurityController } from './security.controller';
import { SecurityService } from './security.service';
import { WxAccessTokenService } from './wx-access-token.service';
import { RedisModule } from '../redis/redis.module';

/**
 * SecurityModule — Sprint E.2 内容安全 2 项后端代理
 *
 * 来源：用户 2026-05-13 Sprint E.2 内容安全 2 项后端代理拍板
 *
 * 暴露：
 *   POST /api/security/msg-check  — 文本安全检测（wx.security.msgSecCheck 代理）
 *   POST /api/security/img-check  — 图片安全检测（wx.security.imgSecCheck 代理）
 *
 * @Global() — Sprint E.x F-08 round 2 (production validator P2 F-08-02) 加:
 *   F-08 让 DbModule.imports + AppModule.imports 双重引入 SecurityModule，
 *   非 @Global 时两套 SecurityService/WxAccessTokenService 实例并存（极低概率
 *   并发刷新微信 access_token）。加 @Global() 让全局单例，DbModule 可省 imports。
 *
 * 依赖：
 *   RedisModule — WxAccessTokenService 用 Redis 缓存 access_token
 *   ConfigModule — 全局（app.module 已 isGlobal:true）
 *   ThrottlerModule — 限流（Sprint E.1 在 app.module 全局 ThrottlerModule.forRoot + APP_GUARD ThrottlerGuard）
 *     - msg-check: @Throttle({ default: { limit: 30, ttl: 60_000 } })
 *     - img-check: @Throttle({ default: { limit: 10, ttl: 60_000 } })
 */
@Global()
@Module({
  imports: [RedisModule],
  controllers: [SecurityController],
  providers: [SecurityService, WxAccessTokenService],
  exports: [SecurityService],
})
export class SecurityModule {}
