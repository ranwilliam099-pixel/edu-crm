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
    const body = {
      version: 2,
      scene,
      content,
      openid,
    };

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
