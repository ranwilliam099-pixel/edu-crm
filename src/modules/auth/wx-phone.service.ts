import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { WxAccessTokenService } from '../security/wx-access-token.service';

/**
 * WxPhoneService — 微信小程序「手机号快速验证」换真手机号
 *
 * 来源：2026-05-25 用户拍板「统一登录架构」— 取代 jscode2session + openid 反查链路：
 *   旧: wx.login → code → jscode2session → openid → 查 parents 表 → token
 *     问题: 新用户未绑 openid 永远 401；AppID 不一致 jscode2session 永远 40029
 *   新: <button open-type="getPhoneNumber"> → phoneCode → 本 service → 真手机号
 *     → PhoneLookupService 跨表查 users + parents → 自动 B/C 分流
 *
 * 微信文档：https://developers.weixin.qq.com/miniprogram/dev/api-backend/open-api/phonenumber/phonenumber.getPhoneNumber.html
 *   POST https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=ACCESS_TOKEN
 *   body: { code: <phoneCode from bindgetphonenumber e.detail.code> }
 *   response: {
 *     errcode: 0,
 *     errmsg: 'ok',
 *     phone_info: {
 *       phoneNumber: '+86 138****0000',  // 含 +86 前缀 + 区位
 *       purePhoneNumber: '13800000000',  // 11 位纯号码（业务直接用）
 *       countryCode: '86',
 *       watermark: { appid, timestamp }
 *     }
 *   }
 *
 * 安全设计：
 *   - phoneCode 5 分钟有效 + 一次性（与 jscode2session code 相同语义）
 *   - access_token 复用 WxAccessTokenService Redis 缓存（不重复调微信 cgi-bin/token）
 *   - 微信 errcode 不透传 client（A05 内部 ID 暴露规避）
 *   - 仅返 purePhoneNumber（业务统一存 11 位明文，FieldEncryptor 加密）
 *   - server log 含 phoneCode 前 6 位脱敏 + errcode（便于定位 code 重用 / 过期）
 */

const GETUSERPHONENUMBER_URL =
  'https://api.weixin.qq.com/wxa/business/getuserphonenumber';

interface WxGetUserPhoneRawResponse {
  errcode?: number;
  errmsg?: string;
  phone_info?: {
    phoneNumber?: string;
    purePhoneNumber?: string;
    countryCode?: string;
    watermark?: { appid?: string; timestamp?: number };
  };
}

export interface WxPhoneResult {
  /** 11 位纯手机号（业务直接用） */
  phone: string;
  /** 区位（'86' for 中国大陆） */
  countryCode: string;
  /** 微信小程序 appid（watermark，便于审计） */
  watermarkAppid?: string;
}

@Injectable()
export class WxPhoneService {
  private readonly logger = new Logger(WxPhoneService.name);

  constructor(private readonly accessToken: WxAccessTokenService) {}

  /**
   * 用 phoneCode 换真手机号（11 位纯号 + countryCode）
   *
   * @param code 前端 bindgetphonenumber e.detail.code（5 分钟有效，一次性）
   * @throws InternalServerErrorException 上游失败 / 网络异常
   */
  async exchange(code: string): Promise<WxPhoneResult> {
    if (!code || typeof code !== 'string') {
      throw new InternalServerErrorException({
        code: 'WX_PHONE_CODE_INVALID',
        message: 'phoneCode required',
      });
    }

    // 1. 拿 access_token（Redis 缓存）
    const accessToken = await this.accessToken.getAccessToken();

    const url = `${GETUSERPHONENUMBER_URL}?access_token=${encodeURIComponent(accessToken)}`;
    const codeMasked = code.slice(0, 6) + '****';

    // 2. 调微信 API
    let status: number;
    let data: WxGetUserPhoneRawResponse;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Accept-Language': 'zh-CN',
          'User-Agent': 'edu-server/wx-phone',
        },
        body: JSON.stringify({ code }),
      });
      status = res.status;
      data = (await res.json()) as WxGetUserPhoneRawResponse;
    } catch (err) {
      this.logger.error(
        `getuserphonenumber network error: ${(err as Error).message} code=${codeMasked}`,
      );
      throw new InternalServerErrorException({
        code: 'WX_PHONE_NETWORK',
        message: 'getuserphonenumber network error',
      });
    }

    // 3. HTTP 非 2xx
    if (status < 200 || status >= 300) {
      this.logger.error(
        `getuserphonenumber HTTP ${status} body=${JSON.stringify(data)} code=${codeMasked}`,
      );
      throw new InternalServerErrorException({
        code: 'WX_PHONE_FAILED',
        message: 'getuserphonenumber failed',
      });
    }

    // 4. 微信 errcode 非 0
    if (data.errcode && data.errcode !== 0) {
      this.logger.warn(
        `getuserphonenumber errcode=${data.errcode} errmsg=${data.errmsg} code=${codeMasked}`,
      );
      throw new InternalServerErrorException({
        code: 'WX_PHONE_FAILED',
        message: 'getuserphonenumber failed',
      });
    }

    // 5. 字段守门
    const info = data.phone_info;
    if (!info || !info.purePhoneNumber) {
      this.logger.error(
        `getuserphonenumber missing phone_info / purePhoneNumber: ${JSON.stringify(data)} code=${codeMasked}`,
      );
      throw new InternalServerErrorException({
        code: 'WX_PHONE_INVALID',
        message: 'getuserphonenumber response missing phone_info',
      });
    }

    // 6. 11 位纯号校验（中国大陆 / 防异常返回）
    const pure = info.purePhoneNumber.trim();
    if (!/^1[3-9]\d{9}$/.test(pure)) {
      this.logger.warn(
        `getuserphonenumber purePhoneNumber non-CN format: ${pure} code=${codeMasked}`,
      );
      throw new InternalServerErrorException({
        code: 'WX_PHONE_NON_CN',
        message: 'phone must be 11-digit CN mobile',
      });
    }

    return {
      phone: pure,
      countryCode: info.countryCode || '86',
      watermarkAppid: info.watermark?.appid,
    };
  }
}
