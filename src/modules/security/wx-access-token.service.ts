import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';

/**
 * WxAccessTokenService — Sprint E.2 内容安全前置依赖
 *
 * 来源：用户 2026-05-13 Sprint E.2 内容安全 2 项后端代理拍板
 *
 * 用途：
 *   - 获取并缓存微信小程序 access_token（用于 msg_sec_check / img_sec_check）
 *   - access_token 由微信侧颁发，TTL 7200s，需服务端集中缓存（避免单 appId 多机重复换取触发限流）
 *
 * 关键设计：
 *   - Redis 缓存 key = `wx:access_token`（全局 keyPrefix 由 RedisService 注入：`edu:wx:access_token`）
 *   - TTL 6600s = 7200s - 600s 安全余量（防服务端缓存还在但微信侧已失效）
 *   - 上游失败抛 InternalServerErrorException，让 SecurityService 决定是否降级
 *   - Redis fail-open：缓存读/写失败不阻塞主流程（仍可直接换 token）
 *
 * 配置 ENV（生产 .env 已配置）：
 *   WX_APP_ID = wxXXXXXXXXX
 *   WX_APP_SECRET = XXXXXXXXXXXXXXX
 */

const TOKEN_CACHE_KEY = 'wx:access_token';
const TOKEN_TTL_SECONDS = 6600; // 7200 - 600 (safety margin)

export interface WxTokenResponse {
  access_token?: string;
  expires_in?: number;
  errcode?: number;
  errmsg?: string;
}

@Injectable()
export class WxAccessTokenService {
  private readonly logger = new Logger(WxAccessTokenService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  /**
   * 获取微信 access_token
   * 1. 先查 Redis 缓存
   * 2. 缓存命中 → 直接返回
   * 3. 缓存未命中 / 失败 → 调用 https://api.weixin.qq.com/cgi-bin/token
   * 4. 成功 → 写回 Redis，返回 token
   *
   * @throws InternalServerErrorException 上游失败（errcode 或网络）
   */
  async getAccessToken(): Promise<string> {
    // 1. 查缓存（fail-open）
    const cached = await this.safeGetCached();
    if (cached) {
      return cached;
    }

    // 2. 换 token
    // 2026-05-13 round 2 (security validator P2 FINDING-2): 改用 getOrThrow 启动 fail-fast
    //   原 config.get + 手动 throw 等价 getOrThrow 但 NestJS 推荐用 getOrThrow（启动期 fail-fast）。
    //   仍保留 InternalServerErrorException 包装作 controller 层 5xx 兜底。
    let appid: string;
    let secret: string;
    try {
      appid = this.config.getOrThrow<string>('WX_APP_ID');
      secret = this.config.getOrThrow<string>('WX_APP_SECRET');
    } catch {
      throw new InternalServerErrorException({
        code: 'WX_CONFIG_MISSING',
        message: 'WX_APP_ID / WX_APP_SECRET 未配置',
      });
    }

    const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(
      appid,
    )}&secret=${encodeURIComponent(secret)}`;

    let data: WxTokenResponse;
    try {
      const res = await fetch(url, { method: 'GET' });
      data = (await res.json()) as WxTokenResponse;
    } catch (err) {
      this.logger.error(
        `wx access_token fetch failed: ${(err as Error).message}`,
      );
      throw new InternalServerErrorException({
        code: 'WX_TOKEN_NETWORK_ERROR',
        message: (err as Error).message,
      });
    }

    if (data.errcode || !data.access_token) {
      this.logger.warn(
        `wx access_token errcode=${data.errcode} errmsg=${data.errmsg}`,
      );
      throw new InternalServerErrorException({
        code: 'WX_TOKEN_FAILED',
        errcode: data.errcode,
        errmsg: data.errmsg,
      });
    }

    // 3. 写缓存（fail-open）
    await this.safeSetCached(data.access_token);
    return data.access_token;
  }

  // ============================================================
  // 内部：Redis 失败不影响主业务（容灾）
  // ============================================================

  private async safeGetCached(): Promise<string | null> {
    try {
      return await this.redis.get(TOKEN_CACHE_KEY);
    } catch (err) {
      this.logger.warn(
        `wx token cache get failed (fail-open): ${(err as Error).message}`,
      );
      return null;
    }
  }

  private async safeSetCached(token: string): Promise<void> {
    try {
      await this.redis.set(TOKEN_CACHE_KEY, token, TOKEN_TTL_SECONDS);
    } catch (err) {
      this.logger.warn(
        `wx token cache set failed (fail-open): ${(err as Error).message}`,
      );
    }
  }
}
