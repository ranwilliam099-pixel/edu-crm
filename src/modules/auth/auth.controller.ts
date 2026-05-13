import {
  Body,
  Controller,
  Post,
  HttpCode,
  HttpStatus,
  BadRequestException,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Throttle } from '@nestjs/throttler';
import { ulid } from 'ulid';
import { ParentJwtStrategy } from './parent-jwt.strategy';
import { isCrossCampusRole, TenantRole, AuthenticatedRequest, JwtPayload } from './jwt-payload.interface';
import { RedisService } from '../redis/redis.service';
import { WxCodeSessionService } from './wx-code-session.service';

/**
 * AuthController — 联调收尾 Q-FE-2 + 待补 B 端 /auth/login
 *
 * 路由前缀：/api/public（公开，TenantMiddleware 已豁免）
 *
 * 来源：
 *   - 派单条目 33 §5 待答清单 Q-FE-2
 *   - 用户 2026-05-02「立即补，马上做完」
 *
 * 当前实现：mock 鉴权（INT-01 docker PG 起来后接真用户表 + bcrypt）
 *   - 凡是手机号末尾 4 位非空，即视为合法登录
 *   - 真实场景：查 users 表 + bcrypt 比对密码
 */
@Controller('public/auth')
export class AuthController {
  constructor(
    private readonly jwt: JwtService,
    private readonly parentJwt: ParentJwtStrategy,
    private readonly redis: RedisService,
    private readonly wxCodeSession: WxCodeSessionService,
  ) {}

  /**
   * POST /api/public/auth/login — B 端员工登录
   *
   * Body: { phone, password, tenantId, role, campusId, userId }
   *   真实场景：phone + password → 查 users 表 → bcrypt → 取 user.role
   *   当前 mock：直接采信传入的 role / tenantId / userId（前端登录页输入即可）
   *
   * @returns { token, tokenType: 'Bearer', expiresIn, payload }
   */
  // SPRINT-E.1(2026-05-13) 限流：登录 10 次/分钟（防暴力破解 / 撞库）
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(
    @Body()
    body: {
      phone: string;
      password?: string; // mock 不校验
      tenantId: string;
      role: string;
      campusId?: string | null; // 跨校 role 可空
      userId: string;
    },
  ) {
    if (!body.phone || !/^1[3-9]\d{9}$/.test(body.phone)) {
      throw new BadRequestException('phone must be valid 11-digit Chinese mobile');
    }
    if (!body.userId || body.userId.length !== 32) {
      throw new BadRequestException('userId must be 32-char ULID');
    }
    if (!body.tenantId || body.tenantId.length !== 32) {
      throw new BadRequestException('tenantId must be 32-char ULID');
    }
    // Sprint B (2026-05-11): TenantRole 加 teacher / academic / academic_admin
    //   - teacher / academic / academic_admin 均为单校 role，campusId 必填
    //   - 校验逻辑通过下方 isCrossCampusRole 分支自动覆盖（fall-through 到 single-campus 分支）
    const validRoles = [
      'sales',
      'sales_manager',
      'sales_director',
      'marketing',
      'finance',
      'boss',
      'admin',
      'hr',
      'teacher',
      'academic',
      'academic_admin',
    ];
    if (!validRoles.includes(body.role)) {
      throw new BadRequestException(`role must be one of ${validRoles.join('/')}`);
    }

    // V10 拍板：跨校组（admin/sales_director/hr）campusId 可空；
    // 单校组（boss/sales/sales_manager/marketing/finance）必须 32 字符 ULID
    let campusId: string | null;
    if (isCrossCampusRole(body.role)) {
      if (body.campusId && body.campusId.length !== 32) {
        throw new BadRequestException(
          'cross-campus role campusId must be null/omitted or 32-char ULID',
        );
      }
      campusId = body.campusId || null;
    } else {
      if (!body.campusId || body.campusId.length !== 32) {
        throw new BadRequestException(
          `single-campus role (${body.role}) must have 32-char campusId`,
        );
      }
      campusId = body.campusId;
    }

    // SPRINT-E.1(2026-05-13) 给每个 token 分配唯一 jti（JWT ID, 26-char ULID）
    //   - logout 时 jti 入 Redis 黑名单（auth:revoked:{jti}），TTL = token 剩余有效期
    //   - jwt.strategy.parse() 校验 jti 不在黑名单
    //   - jsonwebtoken 限制：jti 不能同时在 payload + options.jwtid，所以只放 options
    //     最终 sign 出的 token 仍然有标准 JWT `jti` 字段，verify 后 decoded.jti 可读
    const jti = ulid();
    const signPayload: Omit<JwtPayload, 'jti'> = {
      sub: body.userId,
      tenantId: body.tenantId,
      role: body.role as TenantRole,
      campusId,
    };
    const token = this.jwt.sign(signPayload, { jwtid: jti });
    // 给前端返回完整 payload（含 jti）便于调试 / 前端缓存 logout 用
    const payload: JwtPayload = { ...signPayload, jti };
    return {
      token,
      tokenType: 'Bearer',
      expiresIn: 86400,
      payload,
    };
  }

  /**
   * POST /api/public/auth/wechat-login — C 端家长微信登录
   *
   * Body: { code, parentId, openid?, name?, phone? }
   *   真实场景：wx.login → 拿 code → 用 wx-server-sdk 换 openid → 查/建 parents 表
   *   当前 mock：直接采信传入的 parentId（前端 register 后调）
   *
   * @returns { token (ParentJwt), tokenType: 'Bearer', expiresIn, payload }
   */
  // SPRINT-E.1(2026-05-13) 限流：微信登录 10 次/分钟
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('wechat-login')
  @HttpCode(HttpStatus.OK)
  wechatLogin(
    @Body()
    body: {
      parentId: string;
      openid?: string;
      code?: string; // mock 不校验
    },
  ) {
    if (!body.parentId || body.parentId.length !== 32) {
      throw new BadRequestException('parentId must be 32-char ULID');
    }
    const token = this.parentJwt.sign({
      parentId: body.parentId,
      openid: body.openid,
    });
    return {
      token,
      tokenType: 'Bearer',
      expiresIn: 30 * 86400,
      payload: { parentId: body.parentId, openid: body.openid, type: 'parent' },
    };
  }

  /**
   * POST /api/public/auth/wx-jscode2session — 微信 code 换 openid
   *
   * 来源：2026-05-14 凌晨 wxpay 沙箱集成（c/checkout/pay 真接口）
   *
   * 流程：
   *   1. 前端 wx.login() 拿 code（5min 一次性）
   *   2. POST 此 endpoint { code }
   *   3. 后端调微信 sns/jscode2session 用 WX_APP_ID + WX_APP_SECRET 换取
   *   4. 返 { openid }（sessionKey 不返前端 — 防 XSS 攻击拿密钥解密 wx.getUserInfo 加密数据）
   *
   * 安全：
   *   - 公开 endpoint（前端 wx.login 后还没 token 就要换 openid）
   *   - @Throttle 20 次/分钟（防 code 滥用，code 本身一次性 + 5min 过期已有自带限流）
   *   - 微信 errcode 不透传 client（A05 内部 ID 暴露规避）
   *
   * @returns { openid } — 用于 POST /api/checkout/wxpay/unified-order
   */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('wx-jscode2session')
  @HttpCode(HttpStatus.OK)
  async wxJscode2Session(
    @Body() body: { code: string },
  ): Promise<{ openid: string }> {
    if (!body || !body.code || typeof body.code !== 'string') {
      throw new BadRequestException('code is required');
    }
    if (body.code.length < 5 || body.code.length > 200) {
      throw new BadRequestException('code length must be 5-200');
    }
    const result = await this.wxCodeSession.exchange(body.code);
    return { openid: result.openid };
  }

  /**
   * POST /api/public/auth/logout — B 端员工登出（Sprint E.1 JWT 黑名单）
   *
   * Header: Authorization: Bearer <token>
   *
   * 流程：
   *   1. 解 token（不依赖 JwtAuthGuard，避免依赖循环；公开路径手动 verify）
   *   2. 提取 jti + exp，将 jti 写入 Redis 黑名单 auth:revoked:{jti}
   *   3. TTL = exp - now（token 自然过期后 Redis key 同步过期，避免无限增长）
   *
   * 后续请求带同一 token：JwtStrategy.parse() 查 Redis 命中 → 401 TOKEN_REVOKED
   *
   * Redis fail-open 哲学：Redis 挂了不阻塞 logout 流程（用户客户端清 token 即可）
   *
   * @returns { ok: true }
   */
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Req() req: AuthenticatedRequest): Promise<{ ok: true }> {
    const auth = req.headers['authorization'];
    const header = Array.isArray(auth) ? auth[0] : auth;
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or malformed Authorization header');
    }
    const token = header.slice(7).trim();
    if (!token) {
      throw new UnauthorizedException('Empty bearer token');
    }

    let payload: JwtPayload;
    try {
      payload = this.jwt.verify<JwtPayload>(token);
    } catch {
      // 过期或签名错的 token 也允许 logout（幂等，无副作用）
      // 但拒绝完全无效的 token 防止滥用
      throw new UnauthorizedException('Invalid token');
    }

    if (!payload.jti) {
      // 旧版本 token 无 jti（向前兼容）：跳过黑名单写，但仍返回成功
      // 客户端清 token 即可；旧 token 自然过期后失效
      return { ok: true };
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const ttlSec = payload.exp ? Math.max(0, payload.exp - nowSec) : 86400;

    if (ttlSec > 0) {
      try {
        await this.redis.set(`auth:revoked:${payload.jti}`, '1', ttlSec);
      } catch {
        // Redis fail-open：写黑名单失败不阻塞 logout（客户端清 token 仍生效）
      }
    }

    return { ok: true };
  }
}
