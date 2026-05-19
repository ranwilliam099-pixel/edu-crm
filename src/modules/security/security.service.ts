import { Injectable, Logger } from '@nestjs/common';
import { WxAccessTokenService } from './wx-access-token.service';

/**
 * SecurityService — Sprint E.2 内容安全 2 项后端代理
 *
 * 来源：用户 2026-05-13 Sprint E.2 内容安全 2 项后端代理拍板
 *
 * 用途：
 *   - 调用微信 wx.security.msgSecCheck（文本安全检测）
 *   - 调用微信 wx.security.imgSecCheck（图片安全检测）
 *   - 给前端 mp 端通过后端代理调用（避免暴露 appsecret 到客户端 / 避免客户端无 access_token）
 *
 * 关键设计：
 *   - 通过 WxAccessTokenService 获取 access_token（自带缓存）
 *   - 微信 errcode 0 = 通过，87014 = 命中违规，其他视为「review」让业务侧决策
 *   - 不抛错（让 controller 把结果返给前端，前端按 suggest 决定 UX）
 *   - 上游 access_token 失败仍会抛错（让 controller 统一处理 5xx）
 *
 * 微信文档：
 *   https://developers.weixin.qq.com/miniprogram/dev/api-backend/open-api/sec-check/security.msgSecCheck.html
 *   https://developers.weixin.qq.com/miniprogram/dev/api-backend/open-api/sec-check/security.imgSecCheck.html
 */

export interface SecurityCheckResult {
  /** 是否通过（pass 才能放过）*/
  ok: boolean;
  /** 微信建议：pass = 通过 / review = 需人工 / risky = 违规 */
  suggest?: 'pass' | 'review' | 'risky';
  /** 违规分类（仅 errcode=0 时由 result 携带；或 87014 兜底字符串）*/
  label?: string | number;
  /** 微信原始 errcode（用于上游问题排查）*/
  errcode?: number;
  /** 微信原始 errmsg（仅异常时返回）*/
  errmsg?: string;
}

interface WxMsgSecCheckResponse {
  errcode?: number;
  errmsg?: string;
  result?: {
    suggest?: 'pass' | 'review' | 'risky';
    label?: number;
  };
}

interface WxImgSecCheckResponse {
  errcode?: number;
  errmsg?: string;
}

/** 微信 msgSecCheck v2 scene 枚举 */
export enum MsgSecScene {
  /** 1=资料 */
  PROFILE = 1,
  /** 2=评论 */
  COMMENT = 2,
  /** 3=论坛 */
  FORUM = 3,
  /** 4=社交日志 */
  SOCIAL_LOG = 4,
}

@Injectable()
export class SecurityService {
  private readonly logger = new Logger(SecurityService.name);

  constructor(private readonly token: WxAccessTokenService) {}

  /**
   * 文本安全检测
   *
   * @param content 待检测文本（最大 2500 字）
   * @param openid 用户 openid（微信要求）
   * @param scene 场景（默认 PROFILE=1）
   * @returns SecurityCheckResult { ok, suggest, label?, errcode? }
   */
  async msgSecCheck(
    content: string,
    openid: string,
    scene: MsgSecScene = MsgSecScene.PROFILE,
  ): Promise<SecurityCheckResult> {
    const accessToken = await this.token.getAccessToken();
    const url = `https://api.weixin.qq.com/wxa/msg_sec_check?access_token=${encodeURIComponent(
      accessToken,
    )}`;
    // Sprint X.2 round 25 (2026-05-19): openid 空走 v1 (B 端员工无 openid 场景, customer/staff 创建)
    //   v2 协议强制 openid (用户级风控), v1 server-side check 不需要 openid (功能弱但兼容 B 端)
    //   有 openid 走 v2 (用户级精准风控), 无 openid 走 v1 (服务端兜底审查)
    const body: Record<string, unknown> = openid
      ? { version: 2, scene, content, openid }
      : { version: 1, content };

    let data: WxMsgSecCheckResponse;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      data = (await res.json()) as WxMsgSecCheckResponse;
    } catch (err) {
      this.logger.warn(
        `msgSecCheck network failed: ${(err as Error).message}`,
      );
      return {
        ok: false,
        suggest: 'review',
        errmsg: (err as Error).message,
      };
    }

    // errcode 0 = 通过校验流程，按 result.suggest 决定
    if (data.errcode === 0) {
      const suggest = data.result?.suggest ?? 'review';
      return {
        ok: suggest === 'pass',
        suggest,
        label: data.result?.label,
        errcode: 0,
      };
    }

    // errcode 87014 = 命中违规（部分版本以 errcode 形式返回）
    if (data.errcode === 87014) {
      return {
        ok: false,
        suggest: 'risky',
        label: '内容含违法违规',
        errcode: 87014,
      };
    }

    // 其他异常 errcode → review（不阻塞业务，但不通过）
    this.logger.warn(
      `msgSecCheck 异常 errcode=${data.errcode} errmsg=${data.errmsg}`,
    );
    return {
      ok: false,
      suggest: 'review',
      errcode: data.errcode,
      errmsg: data.errmsg,
    };
  }

  /**
   * F-08 server-side mode: 服务端无 openid 场景的文本内容检测
   *
   * 来源：用户 2026-05-13 Sprint E.x F-08 拍板（onboarding/provision-tenant 公开 endpoint
   *      wizard 用户未登录小程序，body 自由文本字段需后端拦截违规内容）
   *
   * 适用场景：
   *   - POST /api/public/onboarding/provision-tenant — 机构名 / 校区名 / 校区地址 / 课程线
   *   - 其他无 openid 的公开 endpoint 自由文本字段（如未来 C 端注册前页）
   *
   * 不适用场景（仍走 msgSecCheck v2 + openid）：
   *   - 已登录用户场景（C 端家长评论 / B 端老师 showcase）— openid 由 JWT 提供
   *
   * 微信 API 选择：v1（不带 version: 2 字段，免 openid）
   *   URL: https://api.weixin.qq.com/wxa/msg_sec_check?access_token=xxx
   *   body: { content: string }
   *   响应同 v2：errcode 0 + result.suggest='pass'|'risky'|'review' / errcode 87014 直接命中违规
   *
   *   ⚠️ 微信文档标 v2 推荐但 v1 未停用；公开 endpoint 无 openid 只能用 v1。
   *   如未来 v1 停用（500 / errcode 不再支持），fail-open 返 review 不阻塞 onboarding。
   *
   * fail-open vs fail-close 策略：
   *   - 微信明确返 87014 → suggest='risky'（caller 应拦截 / 400）
   *   - 微信 errcode 0 + result.suggest 透传（pass / risky / review）
   *   - 微信 access_token 失败（network / errcode）→ 仍抛 InternalServerErrorException
   *     （让 caller 决定吞或抛；onboarding handler 可 try-catch 转 review 放行）
   *   - 微信 fetch 网络异常 → suggest='review'（fail-open，不阻塞 onboarding 注册）
   *
   * @param content 待检测文本（最大 2500 字）
   * @returns SecurityCheckResult { ok, suggest, label?, errcode? }
   *   - ok=true: 通过
   *   - ok=false + suggest='risky': 命中违规（caller 应抛 400）
   *   - ok=false + suggest='review': 需复查 / 网络异常（fail-open，caller 决策放行 or 阻塞）
   */
  async serverSideCheckContent(content: string): Promise<SecurityCheckResult> {
    const accessToken = await this.token.getAccessToken();
    const url = `https://api.weixin.qq.com/wxa/msg_sec_check?access_token=${encodeURIComponent(
      accessToken,
    )}`;
    // v1 body：不含 version=2 / openid / scene；微信侧按老接口走（公开场景兜底）
    const body = { content };

    let data: WxMsgSecCheckResponse;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      data = (await res.json()) as WxMsgSecCheckResponse;
    } catch (err) {
      this.logger.warn(
        `serverSideCheckContent network failed: ${(err as Error).message}`,
      );
      return {
        ok: false,
        suggest: 'review',
        errmsg: (err as Error).message,
      };
    }

    // errcode 0 = 通过校验流程，按 result.suggest 决定
    if (data.errcode === 0) {
      // v1 老接口部分版本不返回 result（仅 errcode=0 表通过）；兜底为 pass
      const suggest = data.result?.suggest ?? 'pass';
      return {
        ok: suggest === 'pass',
        suggest,
        label: data.result?.label,
        errcode: 0,
      };
    }

    // errcode 87014 = 命中违规
    if (data.errcode === 87014) {
      return {
        ok: false,
        suggest: 'risky',
        label: '内容含违法违规',
        errcode: 87014,
      };
    }

    // 其他异常 errcode → review（fail-open，让 caller 决策）
    this.logger.warn(
      `serverSideCheckContent 异常 errcode=${data.errcode} errmsg=${data.errmsg}`,
    );
    return {
      ok: false,
      suggest: 'review',
      errcode: data.errcode,
      errmsg: data.errmsg,
    };
  }

  /**
   * 图片安全检测
   *
   * @param imageBuffer 图片二进制（最大 1MB；jpeg/png/jpg/gif/bmp）
   * @param openid 用户 openid
   * @param mimeType MIME（默认 image/jpeg）
   * @returns SecurityCheckResult { ok, suggest, label?, errcode? }
   */
  async imgSecCheck(
    imageBuffer: Buffer,
    openid: string,
    mimeType: string = 'image/jpeg',
  ): Promise<SecurityCheckResult> {
    const accessToken = await this.token.getAccessToken();
    const url = `https://api.weixin.qq.com/wxa/img_sec_check?access_token=${encodeURIComponent(
      accessToken,
    )}`;

    // 微信 img_sec_check 接口为 multipart/form-data
    // Node 18+ FormData / Blob 全局可用（Web Standard）
    const formData = new FormData();
    formData.append(
      'media',
      new Blob([new Uint8Array(imageBuffer)], { type: mimeType }),
      'image',
    );
    formData.append('openid', openid);

    let data: WxImgSecCheckResponse;
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: formData,
      });
      data = (await res.json()) as WxImgSecCheckResponse;
    } catch (err) {
      this.logger.warn(
        `imgSecCheck network failed: ${(err as Error).message}`,
      );
      return {
        ok: false,
        suggest: 'review',
        errmsg: (err as Error).message,
      };
    }

    if (data.errcode === 0) {
      return { ok: true, suggest: 'pass', errcode: 0 };
    }
    if (data.errcode === 87014) {
      return {
        ok: false,
        suggest: 'risky',
        label: '图片含违法违规',
        errcode: 87014,
      };
    }

    this.logger.warn(
      `imgSecCheck 异常 errcode=${data.errcode} errmsg=${data.errmsg}`,
    );
    return {
      ok: false,
      suggest: 'review',
      errcode: data.errcode,
      errmsg: data.errmsg,
    };
  }
}
