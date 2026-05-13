import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * WxCodeSessionService — 微信 jscode2session 换 openid
 *
 * 来源：2026-05-14 凌晨 wxpay 沙箱集成需求
 *   前端 wx.login() → code → 此 service 换 openid → wxpay/unified-order
 *
 * 用途：
 *   小程序前端 wx.login 拿到 code（5 分钟有效，一次性），后端用 appid + appsecret
 *   调微信 https://api.weixin.qq.com/sns/jscode2session 换取用户 openid + sessionKey。
 *
 * 安全设计：
 *   - sessionKey 不返给前端（仅服务端持有用于解密 wx.getUserInfo 加密数据等场景）
 *   - 接口公开（前端 wx.login 后就要换 openid），@Throttle 防滥用
 *   - 微信 errcode 不透传 client，仅返 InternalServerError + 通用 message
 *
 * 配置 ENV：
 *   WX_APP_ID = wxpay 关联的小程序 appid（5/14: wxde9d7818d7420d00）
 *   WX_APP_SECRET = 同上 appid 的 secret
 */

const JSCODE2SESSION_URL = 'https://api.weixin.qq.com/sns/jscode2session';

interface WxJscode2SessionRawResponse {
  openid?: string;
  session_key?: string;
  unionid?: string;
  errcode?: number;
  errmsg?: string;
}

export interface WxJscode2SessionResult {
  openid: string;
  sessionKey: string;
  unionid?: string;
}

@Injectable()
export class WxCodeSessionService {
  private readonly logger = new Logger(WxCodeSessionService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * 用 code 换 openid + sessionKey
   *
   * @param code 前端 wx.login() 拿到的 code（5 分钟有效）
   * @throws InternalServerErrorException 微信 errcode 非 0 或网络异常
   */
  async exchange(code: string): Promise<WxJscode2SessionResult> {
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

    const url =
      `${JSCODE2SESSION_URL}?appid=${encodeURIComponent(appid)}` +
      `&secret=${encodeURIComponent(secret)}` +
      `&js_code=${encodeURIComponent(code)}` +
      `&grant_type=authorization_code`;

    let data: WxJscode2SessionRawResponse;
    let status: number;
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          // Node 20 fetch (undici) 默认 Accept-Language:* 微信会 406
          'Accept-Language': 'zh-CN',
          'User-Agent': 'edu-server/wx-code-session',
        },
      });
      status = res.status;
      data = (await res.json()) as WxJscode2SessionRawResponse;
    } catch (err) {
      this.logger.error(
        `jscode2session network error: ${(err as Error).message}`,
      );
      throw new InternalServerErrorException({
        code: 'WX_CODE2SESSION_NETWORK',
        message: 'jscode2session network error',
      });
    }

    if (status < 200 || status >= 300) {
      this.logger.error(
        `jscode2session HTTP ${status} body=${JSON.stringify(data)}`,
      );
      throw new InternalServerErrorException({
        code: 'WX_CODE2SESSION_FAILED',
        message: 'jscode2session failed',
      });
    }

    if (data.errcode && data.errcode !== 0) {
      // 微信 errcode 不透传 client (A05 内部 ID 暴露规避)
      this.logger.warn(
        `jscode2session errcode=${data.errcode} errmsg=${data.errmsg}`,
      );
      throw new InternalServerErrorException({
        code: 'WX_CODE2SESSION_FAILED',
        message: 'jscode2session failed',
      });
    }

    if (!data.openid || !data.session_key) {
      throw new InternalServerErrorException({
        code: 'WX_CODE2SESSION_INVALID',
        message: 'jscode2session response missing openid/session_key',
      });
    }

    return {
      openid: data.openid,
      sessionKey: data.session_key,
      unionid: data.unionid,
    };
  }
}
