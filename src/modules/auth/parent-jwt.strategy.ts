import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, TokenExpiredError, JsonWebTokenError } from '@nestjs/jwt';
import {
  ParentJwtPayload,
  PARENT_TOKEN_TYPE,
} from './parent-jwt-payload.interface';
import { AUDIENCE_PARENT_APP } from './jwt-payload.interface';

/**
 * ParentJwtStrategy — V10 BE-V10-3 C 端家长 token 鉴权
 *
 * 来源：
 *   - 派单条目 33/34 Q-FE-2 + 用户拍板「按建议」
 *
 * 职责：
 *   1. 解析 Authorization: Bearer <token> 中的 Parent JWT
 *   2. 校验 type='parent' + parentId（防止 B 端 token 误用为 C 端）
 *   3. 拒绝过期 / 签名错误 / 类型错误的 token
 *
 * 不引入：
 *   - 黑名单（待 V13+）
 *   - 微信小程序 OAuth 真接入（EXT-02 商户号到位后做）
 */
@Injectable()
export class ParentJwtStrategy {
  constructor(
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
  ) {}

  /**
   * 解析并校验 Parent JWT
   * @throws UnauthorizedException
   */
  parse(token: string): ParentJwtPayload {
    if (!token) {
      throw new UnauthorizedException('Missing parent token');
    }

    const secret = this.config.get<string>('JWT_SECRET');
    if (!secret || secret === '__CHANGE_ME_IN_PROD__') {
      throw new UnauthorizedException('JWT_SECRET not configured');
    }

    let raw: any;
    try {
      raw = this.jwt.verify(token, { secret });
    } catch (e) {
      if (e instanceof TokenExpiredError) {
        throw new UnauthorizedException('Parent token expired');
      }
      if (e instanceof JsonWebTokenError) {
        throw new UnauthorizedException('Parent token invalid signature');
      }
      throw new UnauthorizedException('Parent token verify failed');
    }

    if (raw.type !== PARENT_TOKEN_TYPE) {
      throw new UnauthorizedException('Token type mismatch (expected parent)');
    }
    // T6a audit A1-r2 P0-NEW-3: 拒绝 B 端 audience（admin/boss JWT 不可走 parent 路径）
    // 5/20 P5 三审 security P1-1 (A07): aud 缺失也强制 401，防 JWT_SECRET 泄露场景下
    // 旧 token 无 aud 字段绕过 c-app scope 限制（MEMORY「ENCRYPTION_KEY 建议轮换」背景）
    if (!raw.aud || raw.aud !== AUDIENCE_PARENT_APP) {
      throw new UnauthorizedException(
        `Parent token audience mismatch (expected ${AUDIENCE_PARENT_APP}, got ${raw.aud || 'missing'})`,
      );
    }
    if (!raw.parentId || typeof raw.parentId !== 'string' || raw.parentId.length !== 32) {
      throw new UnauthorizedException('Parent token missing/invalid parentId');
    }

    return {
      parentId: raw.parentId,
      openid: raw.openid,
      type: 'parent',
      aud: raw.aud,
      exp: raw.exp,
      iat: raw.iat,
    };
  }

  /**
   * 签发 Parent JWT（家长 OAuth 完成后调用）
   *
   * @param expiresIn 默认 30 天
   */
  sign(input: { parentId: string; openid?: string }, expiresIn = '30d'): string {
    if (!input.parentId || input.parentId.length !== 32) {
      throw new UnauthorizedException('parentId must be 32-char ULID');
    }
    // T6a: audience='parent-app' 标识 C 端 token（与 B 端 'b-app' 区分）
    // 注：jsonwebtoken 不允许同时在 payload + options 设 aud → 只放 options
    return this.jwt.sign(
      {
        parentId: input.parentId,
        openid: input.openid,
        type: PARENT_TOKEN_TYPE,
      },
      { expiresIn, audience: AUDIENCE_PARENT_APP },
    );
  }
}
