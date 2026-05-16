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
// T-DEPLOY-FIX-1 round 2 (2026-05-16 user 拍板决策 #2 + 3 agent 共识 HIGH-3)：
//   T11-FU-1 完整实施 — refresh endpoint 查 users 表取真实 role/campusId
//   原 mock 'sales' 硬编码会让 admin/boss/academic refresh 后掉权限
import { UserRepository } from '../db/user.repository';

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
    // T-DEPLOY-FIX-1 round 2：T11-FU-1 INT-01 用 users 表查真实 role/campusId
    private readonly userRepo: UserRepository,
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
      // B 端续签：T-DEPLOY-FIX-1 round 2 (2026-05-16 user 拍板决策 #2)
      //   T11-FU-1 完整实施：查 users 表取真实 role/campusId（原 mock 'sales' 硬编码已下线）
      //
      //   流程：
      //     1. oldRow.tenantId 派生 schema (同 refresh-token.service.ts:227+255 模式)
      //     2. userRepo.findById(schema, oldRow.subjectId) → User | null
      //     3a. user 存在 → 用真实 role + campusId 签新 access token
      //     3b. user 不存在 / 已软删 → throw 401 强制重新 login
      //         （refresh_token 已被 rotate 撤销旧 row，user 被删后 token 也要失效）
      //
      //   安全考量：
      //     - tenantId.toLowerCase() 保持 schema 命名一致（V2 schema 全 lowercase）
      //     - 不能 fallback 到 'sales'（pr-code-reviewer HIGH-3 + silent-failure F-9 silent role downgrade）
      //     - user 软删（deleted_at IS NOT NULL）走 findById 返 null 分支（V44 + user.repository.ts:220-228）
      //
      //   Platform user 限制（T-DEPLOY-FIX-1 round 2 边界）：
      //     - tenantId === null 时（platform_admin / finance_admin 跨 tenant 角色）
      //       无法定位 tenant schema → users 表不存在 platform_admin 行 → throw 强制重新 login
      //     - T11-FU-3 backlog: platform users 落到 public.platform_users 表（独立 schema）
      if (!oldRow.tenantId) {
        throw new UnauthorizedException(
          'platform-user refresh not supported (T11-FU-3 backlog), please re-login',
        );
      }
      const schema = `tenant_${oldRow.tenantId.toLowerCase()}`;
      const realUser = await this.userRepo.findById(schema, oldRow.subjectId);
      if (!realUser) {
        // user 不存在 / 已 deactivate / 已软删 → refresh 链路终止
        //   audit_log 由 refresh-token.service rotate() 内部已写（rotated 事件）
        //   此处仅 throw，client 必须 prompt 重新登录
        throw new UnauthorizedException(
          'B-user not found or deactivated, please re-login',
        );
      }

      const accessJti = ulid();
      const signPayload: Pick<JwtPayload, 'sub' | 'tenantId' | 'role' | 'campusId'> = {
        sub: oldRow.subjectId,
        tenantId: oldRow.tenantId,
        role: realUser.role,
        // realUser.campusId 类型为 string（user.repository.ts:25），但 JwtPayload.campusId
        // 允许 null（跨校 role 如 boss / admin / hr）— V2 schema users.campus_id 可空
        campusId: realUser.campusId ?? null,
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
