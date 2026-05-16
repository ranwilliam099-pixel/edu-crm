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
import {
  isCrossCampusRole,
  TenantRole,
  AuthenticatedRequest,
  JwtPayload,
  AUDIENCE_B_APP,
  AUDIENCE_PARENT_APP,
} from './jwt-payload.interface';
import { RedisService } from '../redis/redis.service';
import { WxCodeSessionService } from './wx-code-session.service';
// T11 (2026-05-16) refresh token rotation
import { RefreshTokenService } from './refresh-token.service';

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
    private readonly refreshTokenService: RefreshTokenService,
  ) {}

  /**
   * POST /api/public/auth/login — B 端员工登录
   *
   * Body: { phone, password, tenantId, role, campusId, userId }
   *   真实场景：phone + password → 查 users 表 → bcrypt → 取 user.role
   *   当前 mock：直接采信传入的 role / tenantId / userId（前端登录页输入即可）
   *
   * 5/15 A-2：role 白名单删 'sales_director'（应用层取消大区经理岗位）
   *
   * @returns { token, tokenType: 'Bearer', expiresIn, payload }
   */
  // SPRINT-E.1(2026-05-13) 限流：登录 10 次/分钟（防暴力破解 / 撞库）
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Req() req: AuthenticatedRequest,
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
    //
    // 5/15 A-2 拍板：删 'sales_director'（不在拍板权威 9 角色清单 fields-by-role.md L6-17）
    //   - 应用层不再接受 sales_director 登录，jwt 也不会签发 sales_director claim
    //   - 历史 schema CHECK 仍允许，但应用层拒绝创建（与 user.service validRoles 一致）
    const validRoles = [
      'sales',
      'sales_manager',
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

    // V10 拍板（+ 5/15 A-2 删 sales_director）：跨校组（admin/hr）campusId 可空；
    // 单校组（boss/sales/sales_manager/marketing/finance/teacher/academic/academic_admin）必须 32 字符 ULID
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
    const signPayload: Omit<JwtPayload, 'jti' | 'aud'> = {
      sub: body.userId,
      tenantId: body.tenantId,
      role: body.role as TenantRole,
      campusId,
    };
    // T6a audit A1-r2 P0-NEW-3: B 端 token 标 audience='b-app'，与 C 端 'parent-app' 切分
    const token = this.jwt.sign(signPayload, { jwtid: jti, audience: AUDIENCE_B_APP });
    // 给前端返回完整 payload（含 jti / aud）便于调试 / 前端缓存 logout 用
    const payload: JwtPayload = { ...signPayload, jti, aud: AUDIENCE_B_APP };
    // T11 (2026-05-16): 签发配套 refresh token（7d B 端）
    const refresh = await this.refreshTokenService.issue({
      subjectType: 'b-user',
      subjectId: body.userId,
      tenantId: body.tenantId,
      userAgent: this.getUserAgent(req),
      ip: this.getIp(req),
    });
    return {
      token,
      refreshToken: refresh.refreshToken,
      tokenType: 'Bearer',
      expiresIn: 86400,
      refreshExpiresIn: refresh.refreshExpiresIn,
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
  async wechatLogin(
    @Req() req: AuthenticatedRequest,
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
    // T6a: ParentJwtStrategy.sign 内部已强制 audience='parent-app'
    const token = this.parentJwt.sign({
      parentId: body.parentId,
      openid: body.openid,
    });
    // T11 (2026-05-16): 签发配套 refresh token（30d C 端 parent）
    const refresh = await this.refreshTokenService.issue({
      subjectType: 'parent',
      subjectId: body.parentId,
      tenantId: null, // C 端 parent 跨租户身份（V10 拍板）
      userAgent: this.getUserAgent(req),
      ip: this.getIp(req),
    });
    return {
      token,
      refreshToken: refresh.refreshToken,
      tokenType: 'Bearer',
      expiresIn: 30 * 86400,
      refreshExpiresIn: refresh.refreshExpiresIn,
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
   * POST /api/public/auth/refresh — T11 (2026-05-16) refresh token rotation
   *
   * 入参: { refreshToken } — raw token（非 hash）
   * 不需 Authorization header（refresh token 本身即凭证）
   *
   * 流程（spec §2.2）：
   *   1. 校验 body 形态（非空 string, length 20-200）→ 否则 400
   *   2. service.rotate() 内部 hash + 查表 + 三态判定（INVALID/REVOKED/EXPIRED）
   *      - REVOKED 触发重放检测：撤销 subject 全部 active token + audit replay-detected
   *   3. 旋转事务：旧 row revoked + 新 row insert
   *   4. 签新 access token（B 端 b-app / C 端 parent-app，复用旧 row 的 subjectType + tenantId）
   *   5. 返 { accessToken, refreshToken, tokenType, expiresIn, refreshExpiresIn, payload }
   *
   * 失败语义（spec §2.3）：
   *   - body 形态错 → 400 BadRequest
   *   - INVALID/REVOKED/EXPIRED → 401 UnauthorizedException
   *
   * @Throttle 30/min per IP（spec §9.3 — 比 login 宽松，refresh 是正常生命周期事件）
   */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: AuthenticatedRequest,
    @Body() body: { refreshToken: string },
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    tokenType: 'Bearer';
    expiresIn: number;
    refreshExpiresIn: number;
    payload: JwtPayload | { parentId: string; openid?: string; type: 'parent'; aud: string };
  }> {
    if (!RefreshTokenService.isWellFormedRawToken(body?.refreshToken)) {
      throw new BadRequestException(
        'refreshToken is required (string, length 20-200)',
      );
    }
    const { oldRow, newToken } = await this.refreshTokenService.rotate(
      body.refreshToken,
      {
        userAgent: this.getUserAgent(req),
        ip: this.getIp(req),
        requestId: this.getRequestId(req),
      },
    );

    if (oldRow.subjectType === 'b-user') {
      // B 端：用旧 row.subjectId/tenantId 续签 access token（role/campusId 需从用户表查；
      //   当前 mock 模式：role/campusId 不在 refresh_tokens 表 → 由前端在 login 时缓存，
      //   refresh 后前端继续使用旧 role/campusId，下次 access token 复用旧 claims）
      // 注：spec §2.2 step 4 假定 jwt 库可签出含 role/campusId 的 access token；
      //   mock 阶段仅签 sub/tenantId/jti/aud；真实接 users 表后会从 DB 查出 role/campusId 填上。
      const accessJti = ulid();
      const signPayload: Pick<JwtPayload, 'sub' | 'tenantId' | 'role' | 'campusId'> = {
        sub: oldRow.subjectId,
        tenantId: oldRow.tenantId,
        // Backlog T11-FU-1 (Sprint 后续): INT-01 users 表落地后 query 真实 role/campusId
        //   当前 mock 限制：role 写死 'sales'，所有 B 端 user refresh 后 access token role=sales
        //   规避：T11 round 2 三审 security finding P1 — 待 INT-01 修
        //   规避方案（精确 API 引用，已 grep 验证 user.repository.ts:222 签名）:
        //     1. 注入 UserRepository (constructor 加 private readonly userRepo: UserRepository)
        //     2. 派 schema: const schema = `tenant_${oldRow.tenantId}` (同 refresh-token.service.ts:227+255 模式)
        //     3. query: const realUser = await this.userRepo.findById(schema, oldRow.subjectId)
        //     4. 取值: signPayload.role = realUser?.role ?? 'sales' as TenantRole; campusId = realUser?.campusId ?? null;
        //   User interface (user.repository.ts:20-26): { id, role: TenantRole, campusId: string, ... }
        role: 'sales' as TenantRole,
        campusId: null,
      };
      const accessToken = this.jwt.sign(signPayload, {
        jwtid: accessJti,
        audience: AUDIENCE_B_APP,
      });
      const payload: JwtPayload = {
        ...signPayload,
        jti: accessJti,
        aud: AUDIENCE_B_APP,
      };
      return {
        accessToken,
        refreshToken: newToken.refreshToken,
        tokenType: 'Bearer',
        expiresIn: 86400,
        refreshExpiresIn: newToken.refreshExpiresIn,
        payload,
      };
    }

    // C 端 parent
    const parentAccessToken = this.parentJwt.sign({
      parentId: oldRow.subjectId,
      // openid 不在 refresh_tokens 表 → 续期 token 时为 undefined（前端有 openid 缓存）
    });
    return {
      accessToken: parentAccessToken,
      refreshToken: newToken.refreshToken,
      tokenType: 'Bearer',
      expiresIn: 30 * 86400,
      refreshExpiresIn: newToken.refreshExpiresIn,
      payload: {
        parentId: oldRow.subjectId,
        type: 'parent' as const,
        aud: AUDIENCE_PARENT_APP,
      },
    };
  }

  /** 取请求 IP（IPv4 / IPv6 兼容） */
  private getIp(req: AuthenticatedRequest): string | null {
    const xf = req.headers['x-forwarded-for'];
    if (typeof xf === 'string' && xf) return xf.split(',')[0].trim();
    if (Array.isArray(xf) && xf.length > 0) return xf[0].split(',')[0].trim();
    return req.ip ?? null;
  }

  /** 取 user-agent */
  private getUserAgent(req: AuthenticatedRequest): string | null {
    const ua = req.headers['user-agent'];
    if (typeof ua === 'string') return ua;
    if (Array.isArray(ua) && ua.length > 0) return ua[0];
    return null;
  }

  /** 取 request id（pino reqId 同源） */
  private getRequestId(req: AuthenticatedRequest): string | null {
    const rid = req.headers['x-request-id'];
    if (typeof rid === 'string') return rid;
    if (Array.isArray(rid) && rid.length > 0) return rid[0];
    return null;
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
  async logout(
    @Req() req: AuthenticatedRequest,
    @Body() body?: { refreshToken?: string },
  ): Promise<{ ok: true }> {
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

    // T11 (2026-05-16 spec §4.3) logout 同时撤销 refresh token
    //   - body.refreshToken optional：旧客户端不传 refresh，向前兼容
    //   - revokeByRaw fail-open：raw 不匹配 / 行已 revoked 安静返回（logout 幂等）
    if (body?.refreshToken && RefreshTokenService.isWellFormedRawToken(body.refreshToken)) {
      try {
        await this.refreshTokenService.revokeByRaw(body.refreshToken);
      } catch {
        // DB fail-open：refresh 撤销失败不阻塞 logout（access 黑名单已写）
      }
    }

    return { ok: true };
  }
}
