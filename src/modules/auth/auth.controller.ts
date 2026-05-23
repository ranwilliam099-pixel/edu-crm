import {
  Body,
  Controller,
  Logger,
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
// 2026-05-23 P0 T2: wechatLogin 安全改造 — openid 反查 parents 表
import { ParentRepository } from '../db/parent.repository';
// Sprint X.2 (2026-05-17) — SSOT §12 注册登录分流
//   check-phone / login bcrypt 改造 / login-confirm 多 tenant 候选
import { PhoneLookupService, BUserMatch } from './phone-lookup.service';
import { PasswordHasher } from '../../common/crypto/password-hasher';
// Sprint X.2 round 2 (2026-05-17 3 审共识 A09 BLOCKER)：
//   注入 AuditLogRepository → login / login-confirm / check-phone 写 audit_log V33
//   SSOT §12.9 + §9 「check-phone / login / parents.create / user.deactivate 全 endpoint 必接 audit_log V33」
import { AuditLogRepository, normalizeActorRole } from '../db/audit-log.repository';

/**
 * AuthController — Sprint X.2 (2026-05-17) 登录分流 + B 端密码登录改造
 *
 * 路由前缀：/api/public（公开，TenantMiddleware 已豁免）
 *
 * 来源：
 *   - SSOT §12.1 / §12.3 B/C 登录页统一 + check-phone 路由分支
 *   - SSOT §12.4 admin 唯一创建 B 端子账户 + bcrypt cost=12
 *   - SSOT §12.6 失效逻辑统一 status='停用'
 *   - 用户拍板 D1（跨 tenant 应用层串行）/ D3（C 端推 X+1）/ D4（无 session）/ D5（互斥违反 401）
 *
 * 改造摘要（Sprint X.2 vs Sprint X.1 mock）：
 *   - check-phone 新增：phone blur 路由分支（返 accountType + exists）
 *   - login 改造：删 role/tenantId/userId body 自报 → 跨表 phone + bcrypt 比对 → 0/1/2+ 分支
 *   - login-confirm 新增：多 tenant 候选选择器后二次确认（无 session, D4 重发 phone+password）
 *   - wechat-login 保留（C 端 wx-jscode2session 走旧路径, D3 推 X+1 加密码登录）
 */
@Controller('public/auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly parentJwt: ParentJwtStrategy,
    private readonly redis: RedisService,
    private readonly wxCodeSession: WxCodeSessionService,
    private readonly refreshTokenService: RefreshTokenService,
    // T-DEPLOY-FIX-1 round 2：T11-FU-1 INT-01 用 users 表查真实 role/campusId
    private readonly userRepo: UserRepository,
    // Sprint X.2 (2026-05-17) — 跨表 phone 反查 + bcrypt 校验
    private readonly phoneLookup: PhoneLookupService,
    private readonly passwordHasher: PasswordHasher,
    // Sprint X.2 round 2 (2026-05-17 3 审共识)：audit_log V33 接入（SSOT §12.9 + §9）
    private readonly auditLog: AuditLogRepository,
    // 2026-05-23 P0 T2: wechatLogin openid 反查 parents 表 (取代旧 body.parentId mock)
    private readonly parentRepo: ParentRepository,
  ) {}

  /**
   * Sprint X.2 round 2 helper — audit_log 失败/成功路径
   *
   * 调用 auditLog.log 时 tenantSchema 取值：
   *   - 1-row 命中 → tenant_{matchedTenantId}
   *   - 0-row / 互斥 / parent-redirect → '' (无 tenant 上下文，audit 兜底 fail-open 入 platform-level)
   * 走 try-catch 兜底，绝不阻断登录主流程
   */
  private async tryAuditLogin(
    tenantSchema: string,
    action: 'auth.login.success' | 'auth.login.failed' | 'auth.check-phone.queried',
    actorUserId: string | null,
    actorRoleRaw: string,
    targetId: string,
    after: Record<string, unknown>,
    req?: AuthenticatedRequest,
  ): Promise<void> {
    try {
      // normalizeActorRole 在 audit-log.repository.ts 内部 V33 CHECK 白名单
      await this.auditLog.log(tenantSchema, {
        actorUserId,
        actorRole: normalizeActorRole(actorRoleRaw),
        action,
        targetType: 'user',
        targetId,
        before: null,
        after,
        // req? optional → 未传时 ip/ua/reqId 全 null（无 HTTP 上下文场景如 cron / 内部调用）
        ip: req ? this.getIp(req) : null,
        userAgent: req ? this.getUserAgent(req) : null,
        requestId: req ? this.getRequestId(req) : null,
      });
    } catch (err) {
      this.logger.warn(`[audit.${action}.fail-open] ${(err as Error).message}`);
    }
  }

  /**
   * POST /api/public/auth/check-phone — Sprint X.2 phone 路由分支（SSOT §12.1）
   *
   * Body: { phone }
   * Response: { exists: boolean, accountType: 'b' | 'c' | null }
   *
   * 行为：
   *   - 跨表反查 phone：parents 表 + N 个 tenant.users 表
   *   - accountType='b' = B 端命中（可能多 tenant，但不透传细节防枚举）
   *   - accountType='c' = C 端 parent 命中（互斥）
   *   - exists=false = 未注册 → 引导注册（前端「自助开通新机构」按钮）
   *
   * 安全（D5 互斥违反）：
   *   - B/C 同 phone 命中 → 仍返 accountType=null + exists=false（不透传细节）
   *   - pino warn 提示 ops 人工介入（数据库违反业务红线）
   *
   * 安全（防枚举）：
   *   - throttle 5/min/IP（spec D1 收紧）
   *   - parents 不存在时 dummy bcrypt.compare（spec timing attack 防御）
   *     注：本 endpoint 不做 bcrypt 比对（login 才做），timing 防御转嫁到 login endpoint
   */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('check-phone')
  @HttpCode(HttpStatus.OK)
  async checkPhone(
    @Body() body: { phone: string },
  ): Promise<{ exists: boolean; accountType: 'b' | 'c' | null }> {
    if (!body?.phone || !/^1[3-9]\d{9}$/.test(body.phone)) {
      throw new BadRequestException('phone must be valid 11-digit Chinese mobile');
    }
    const result = await this.phoneLookup.lookupByPhone(body.phone);

    // 过滤 B-user: 仅 '启用' AND deleted_at IS NULL 算 active 命中
    const activeBUsers = result.bUsers.filter(
      (u) => u.status === '启用' && u.deletedAt === null,
    );
    const activeParent =
      result.parent && result.parent.status === '启用' ? result.parent : null;

    // D5 互斥违反：B + C 同时命中 → 返 null + pino warn ops
    if (activeBUsers.length > 0 && activeParent) {
      this.logger.warn(
        `[auth.check-phone.mutex-violation] phone=***${body.phone.slice(-4)} bUsers=${activeBUsers.length} parent=1 — manual ops review required`,
      );
      return { exists: false, accountType: null };
    }

    if (activeBUsers.length > 0) {
      return { exists: true, accountType: 'b' };
    }
    if (activeParent) {
      return { exists: true, accountType: 'c' };
    }
    return { exists: false, accountType: null };
  }

  /**
   * POST /api/public/auth/login — B/C 端登录（SSOT §12.3）
   *
   * Body: { phone, password }
   *   - 删除 role/tenantId/userId/campusId 自报字段（旧 mock 已下线）
   *   - 跨表反查 + bcrypt 比对 + status='启用' AND deleted_at IS NULL
   *
   * 响应（B 端，accountType='b'）：
   *   - 0 row 命中 → 401 INVALID_CREDENTIALS（不透传是 phone 错还是 password 错，防枚举）
   *   - 1 row 命中 → 直接签 JWT + refresh（同 Sprint X.1 模式）
   *   - 2+ row 命中 → { needTenantSelection: true, candidates: [...] }（D4 无 session，
   *     前端弹选择器后调 /login-confirm 重发 phone+password+tenantId）
   *
   * 响应（C 端 parent，accountType='c'）：
   *   - D3 推 Sprint X+1：本 Sprint 不实施密码登录，返 401 PARENT_USE_WECHAT
   *   - msg「请使用微信家长小程序登录」(走 wx-jscode2session)
   *
   * 互斥违反（D5）：401 + pino warn ops
   *
   * 5/15 A-2：role 白名单删 'sales_director'（应用层取消大区经理岗位）
   */
  // SPRINT-E.1(2026-05-13) 限流：登录 10 次/分钟（防暴力破解 / 撞库）
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Req() req: AuthenticatedRequest,
    @Body() body: { phone: string; password: string },
  ): Promise<
    | {
        token: string;
        refreshToken: string;
        tokenType: 'Bearer';
        expiresIn: number;
        refreshExpiresIn: number;
        payload: JwtPayload;
      }
    | {
        needTenantSelection: true;
        candidates: Array<{
          tenantId: string;
          tenantName: string;
          campusName: string;
          role: string;
        }>;
      }
  > {
    if (!body?.phone || !/^1[3-9]\d{9}$/.test(body.phone)) {
      throw new BadRequestException('phone must be valid 11-digit Chinese mobile');
    }
    if (typeof body.password !== 'string' || body.password.length === 0) {
      throw new BadRequestException('password is required');
    }
    if (body.password.length > 128) {
      throw new BadRequestException('password too long (max 128 chars)');
    }
    const result = await this.phoneLookup.lookupByPhone(body.phone);
    const activeBUsers = result.bUsers.filter(
      (u) => u.status === '启用' && u.deletedAt === null,
    );
    const activeParent =
      result.parent && result.parent.status === '启用' ? result.parent : null;

    const phoneMask = `***${body.phone.slice(-4)}`;

    // D5 互斥违反：B + C 同时命中 → 401 + pino warn ops + audit_log V33
    if (activeBUsers.length > 0 && activeParent) {
      this.logger.warn(
        `[auth.login.mutex-violation] phone=${phoneMask} bUsers=${activeBUsers.length} parent=1 — manual ops review required`,
      );
      await this.tryAuditLogin('', 'auth.login.failed', null, 'system', phoneMask, {
        reason: 'MUTEX_VIOLATION',
        bUsers: activeBUsers.length,
        parent: 1,
      }, req);
      throw new UnauthorizedException('INVALID_CREDENTIALS');
    }

    // D3 C 端 parent 推 Sprint X+1 密码登录, 本 Sprint 提示走微信
    if (activeBUsers.length === 0 && activeParent) {
      // Sprint X.2 round 2 (security A04-P1-TIMING)：dummy bcrypt 防 C-parent phone 枚举 timing oracle
      await this.passwordHasher.verify(body.password, '');
      await this.tryAuditLogin('', 'auth.login.failed', null, 'system', phoneMask, {
        reason: 'PARENT_USE_WECHAT',
      }, req);
      throw new UnauthorizedException({
        code: 'PARENT_USE_WECHAT',
        message: '请使用微信家长小程序登录',
      });
    }

    // B 端无命中（含 phone 未注册 + 全部停用 / 软删情形）→ 401
    if (activeBUsers.length === 0) {
      // timing attack 防御：dummy bcrypt.compare 消耗等量时间
      await this.passwordHasher.verify(body.password, '');
      await this.tryAuditLogin('', 'auth.login.failed', null, 'system', phoneMask, {
        reason: 'PHONE_NOT_FOUND',
      }, req);
      throw new UnauthorizedException('INVALID_CREDENTIALS');
    }

    // 1 row → 直接 bcrypt 比对 + 签 token
    if (activeBUsers.length === 1) {
      const match = activeBUsers[0];
      const ok = await this.passwordHasher.verify(body.password, match.passwordHash);
      if (!ok) {
        await this.tryAuditLogin(
          `tenant_${match.tenantId.toLowerCase()}`,
          'auth.login.failed', match.userId, match.role, phoneMask,
          { reason: 'BCRYPT_MISMATCH', tenantId: match.tenantId }, req,
        );
        throw new UnauthorizedException('INVALID_CREDENTIALS');
      }
      // Sprint X.2 round 2: audit_log success（tryAuditLogin tenantSchema 取 match.tenantId）
      await this.tryAuditLogin(
        `tenant_${match.tenantId.toLowerCase()}`,
        'auth.login.success', match.userId, match.role, match.userId,
        { tenantId: match.tenantId, role: match.role, campusId: match.campusId, phoneLast4: body.phone.slice(-4) },
        req,
      );
      return this.signBUserToken(req, match, body.phone);
    }

    // 2+ rows → 返候选 list（前端弹选择器 → 调 /login-confirm，D4 无 session 重发）
    // 注意：candidates 不含 userId/sub/email/passwordHash（防细粒度枚举攻击）
    await this.tryAuditLogin('', 'auth.login.success', null, 'system', phoneMask, {
      reason: 'MULTI_TENANT_PROMPT',
      candidatesCount: activeBUsers.length,
    }, req);
    return {
      needTenantSelection: true,
      candidates: activeBUsers.map((u) => ({
        tenantId: u.tenantId,
        tenantName: u.tenantName,
        campusName: u.campusName,
        role: u.role,
      })),
    };
  }

  /**
   * POST /api/public/auth/login-confirm — Sprint X.2 多 tenant 候选确认（SSOT §12.3）
   *
   * Body: { phone, password, tenantId }
   *
   * 行为（D4 无 session）：
   *   - 不信前端 candidates list；重新跨 tenant phone 反查 + bcrypt 比对该 tenant
   *   - tenantId 不在反查结果中 → 401（防伪造 tenantId）
   *   - 成功 → 签 B 端 JWT + refresh
   *
   * 安全：
   *   - 同 login 完整路径（throttle / bcrypt / phone format）
   *   - tenantId 必填 + 32-char ULID 校验
   */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login-confirm')
  @HttpCode(HttpStatus.OK)
  async loginConfirm(
    @Req() req: AuthenticatedRequest,
    @Body() body: { phone: string; password: string; tenantId: string },
  ): Promise<{
    token: string;
    refreshToken: string;
    tokenType: 'Bearer';
    expiresIn: number;
    refreshExpiresIn: number;
    payload: JwtPayload;
  }> {
    if (!body?.phone || !/^1[3-9]\d{9}$/.test(body.phone)) {
      throw new BadRequestException('phone must be valid 11-digit Chinese mobile');
    }
    if (typeof body.password !== 'string' || body.password.length === 0) {
      throw new BadRequestException('password is required');
    }
    if (body.password.length > 128) {
      throw new BadRequestException('password too long (max 128 chars)');
    }
    if (!body.tenantId || body.tenantId.length !== 32) {
      throw new BadRequestException('tenantId must be 32-char ULID');
    }
    const result = await this.phoneLookup.lookupByPhone(body.phone);
    const activeBUsers = result.bUsers.filter(
      (u) => u.status === '启用' && u.deletedAt === null,
    );

    const phoneMask = `***${body.phone.slice(-4)}`;

    // 选定 tenant 必须在反查结果中（D4 不信前端，重新校验）
    const selected = activeBUsers.find((u) => u.tenantId === body.tenantId);
    if (!selected) {
      // timing 防御：dummy verify
      await this.passwordHasher.verify(body.password, '');
      await this.tryAuditLogin('', 'auth.login.failed', null, 'system', phoneMask, {
        reason: 'TENANT_ID_NOT_IN_CANDIDATES',
        attemptedTenantId: body.tenantId,
      }, req);
      throw new UnauthorizedException('INVALID_CREDENTIALS');
    }

    const ok = await this.passwordHasher.verify(body.password, selected.passwordHash);
    if (!ok) {
      await this.tryAuditLogin(
        `tenant_${selected.tenantId.toLowerCase()}`,
        'auth.login.failed', selected.userId, selected.role, phoneMask,
        { reason: 'BCRYPT_MISMATCH', tenantId: selected.tenantId, endpoint: 'login-confirm' }, req,
      );
      throw new UnauthorizedException('INVALID_CREDENTIALS');
    }
    // Sprint X.2 round 2: audit success
    await this.tryAuditLogin(
      `tenant_${selected.tenantId.toLowerCase()}`,
      'auth.login.success', selected.userId, selected.role, selected.userId,
      { tenantId: selected.tenantId, role: selected.role, campusId: selected.campusId, endpoint: 'login-confirm', phoneLast4: body.phone.slice(-4) },
      req,
    );
    return this.signBUserToken(req, selected, body.phone);
  }

  /**
   * 签 B-user token + refresh（login / login-confirm 共享）
   *
   * 5/15 A-2 拍板：删 'sales_director'（不在拍板权威 9 角色清单 fields-by-role.md L6-17）
   *   - 应用层校验：DB 历史 row 如有 sales_director → 401（不发新 JWT）
   *
   * V10 拍板：跨校组 (admin/hr) campusId 可空；单校组必须 32 字符 ULID
   *   - 应用层信任 DB schema CHECK（不再二次校验，DB 已强约束）
   */
  private async signBUserToken(
    req: AuthenticatedRequest,
    match: BUserMatch,
    phone: string,
  ): Promise<{
    token: string;
    refreshToken: string;
    tokenType: 'Bearer';
    expiresIn: number;
    refreshExpiresIn: number;
    payload: JwtPayload;
  }> {
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
    if (!validRoles.includes(match.role)) {
      this.logger.warn(
        `[auth.login.role-rejected] userId=${match.userId} role=${match.role} not in validRoles (5/15 A-2 删 sales_director)`,
      );
      throw new UnauthorizedException('INVALID_CREDENTIALS');
    }
    // V10 + 5/15 A-2: 跨校组 campusId 可 null, 单校组必须 32-char
    //   DB 已强约束 (V2 schema CHECK campus_id NOT NULL except cross-campus)
    //   应用层兜底防数据漂移
    let campusId: string | null;
    if (isCrossCampusRole(match.role)) {
      campusId = match.campusId && match.campusId.length === 32 ? match.campusId : null;
    } else {
      if (!match.campusId || match.campusId.length !== 32) {
        this.logger.warn(
          `[auth.login.campus-invalid] userId=${match.userId} role=${match.role} campusId=${match.campusId} — DB integrity violation`,
        );
        throw new UnauthorizedException('INVALID_CREDENTIALS');
      }
      campusId = match.campusId;
    }

    // SPRINT-E.1(2026-05-13) jti for logout blacklist
    const jti = ulid();
    const signPayload: Omit<JwtPayload, 'jti' | 'aud'> = {
      sub: match.userId,
      tenantId: match.tenantId,
      role: match.role as TenantRole,
      campusId,
      // 2026-05-22 (SSOT §14.2 佐证 mine 页 fallback 占位):
      //   BUserMatch 已带 userName/tenantName/campusName (phone-lookup.service.ts L29-50)
      //   campusName 跨校 role (admin/hr campusId=null) 时为空串 → undefined 让前端走「全部校区」
      name: match.userName,
      tenantName: match.tenantName,
      campusName: match.campusName || undefined,
      phone,
    };
    // T6a B 端 token aud='b-app'
    const token = this.jwt.sign(signPayload, { jwtid: jti, audience: AUDIENCE_B_APP });
    const payload: JwtPayload = { ...signPayload, jti, aud: AUDIENCE_B_APP };
    // T11 refresh token (7d B 端)
    const refresh = await this.refreshTokenService.issue({
      subjectType: 'b-user',
      subjectId: match.userId,
      tenantId: match.tenantId,
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
   * 2026-05-23 P0 T2 安全改造（取代旧 body.parentId mock）:
   *   Body: { code }
   *     code = 前端 wx.login() 拿到的 5min 一次性 code
   *
   *   流程:
   *     1. wxCodeSession.exchange(code) → openid (走微信 jscode2session)
   *     2. parentRepo.findParentByOpenid(openid) → Parent | null
   *     3. null OR parent.status !== '启用' → 401 WECHAT_LOGIN_FAILED
   *        (不透传 openid 未绑 vs status 停用, 防枚举)
   *     4. 命中 → sign ParentJwt (aud='parent-app') + refresh
   *
   *   安全:
   *     - 删 body.parentId (旧漏洞: 任意 client 伪造 parentId 签 token 跨 parent 越权)
   *     - openid 仅服务端从微信换得, 不接受 client 传 (防伪造)
   *     - status='停用' / 不存在统一 401 同 message (防 openid 枚举)
   *     - audit_log V33 失败时 mask openid 后 8 位 (openid 是身份标识, 不入 audit_log 全文)
   *
   *   兼容:
   *     - 旧 client 传 body.parentId 会被忽略 (TS 接口已删该字段)
   *     - 返同结构 { token, refreshToken, tokenType, expiresIn, refreshExpiresIn, payload }
   *
   * SPRINT-E.1(2026-05-13) 限流: 微信登录 10 次/分钟
   *
   * @returns { token (ParentJwt), refreshToken, tokenType: 'Bearer', expiresIn, payload }
   */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('wechat-login')
  @HttpCode(HttpStatus.OK)
  async wechatLogin(
    @Req() req: AuthenticatedRequest,
    @Body()
    body: {
      code: string;
    },
  ): Promise<{
    token: string;
    refreshToken: string;
    tokenType: 'Bearer';
    expiresIn: number;
    refreshExpiresIn: number;
    // P1-2 (2026-05-23): payload 删 openid — 微信 openid 是身份标识 (与 sessionKey 同等),
    //   不透传客户端 (OWASP A02). 完整 openid 仅用于服务端 ParentJwt sign 内部, 不返 client.
    payload: { parentId: string; type: 'parent' };
  }> {
    // 1. 校验 body.code 形态 (jscode2session 期望 5-200 char)
    if (!body || !body.code || typeof body.code !== 'string') {
      throw new BadRequestException('code is required');
    }
    if (body.code.length < 5 || body.code.length > 200) {
      throw new BadRequestException('code length must be 5-200');
    }

    // 2. wx-jscode2session 换 openid (服务端调微信 API, client 不可伪造)
    //    wxCodeSession.exchange 抛错时 (500 WX_CODE2SESSION_*) 直接透传给 client
    //    — 微信 errcode 已被 service 内层吞掉只透传通用 message
    const session = await this.wxCodeSession.exchange(body.code);
    const openid = session.openid;

    // 3. openid 反查 parents 表
    const parent = await this.parentRepo.findParentByOpenid(openid);
    const openidMask = openid.length > 8 ? `***${openid.slice(-8)}` : '***';

    if (!parent || parent.status !== '启用') {
      // 失败 audit (不透传 openid 全文, mask 后 8 位)
      //   tenantSchema='' fail-open: parent 未识别 → 无 tenant 上下文, audit 走 platform-level
      //   AuditLogRepository.log 内部 catch 兜底失败 (空 schema 不写表只走 pino warn)
      try {
        await this.auditLog.log('', {
          actorUserId: null,
          actorRole: normalizeActorRole('parent'),
          action: 'auth.parent-login.failed',
          targetType: 'parent',
          targetId: parent?.id ?? null,
          before: null,
          after: {
            reason: !parent ? 'OPENID_NOT_BOUND' : 'PARENT_DEACTIVATED',
            openidMask,
          },
          ip: this.getIp(req),
          userAgent: this.getUserAgent(req),
          requestId: this.getRequestId(req),
        });
      } catch {
        // fail-open: audit 失败不阻断主流程
      }
      throw new UnauthorizedException('WECHAT_LOGIN_FAILED');
    }

    // 4. 命中 + 启用 → sign ParentJwt (aud='parent-app' 强制) + refresh
    const token = this.parentJwt.sign({
      parentId: parent.id,
      openid,
    });
    const refresh = await this.refreshTokenService.issue({
      subjectType: 'parent',
      subjectId: parent.id,
      tenantId: null, // C 端 parent 跨租户身份 (V10 拍板)
      userAgent: this.getUserAgent(req),
      ip: this.getIp(req),
    });

    // 成功 audit (tenantSchema='' parent 跨机构身份 — 不归属任一 tenant)
    try {
      await this.auditLog.log('', {
        actorUserId: parent.id,
        actorRole: normalizeActorRole('parent'),
        action: 'auth.parent-login.wechat',
        targetType: 'parent',
        targetId: parent.id,
        before: null,
        after: { openidMask },
        ip: this.getIp(req),
        userAgent: this.getUserAgent(req),
        requestId: this.getRequestId(req),
      });
    } catch {
      // fail-open
    }

    return {
      token,
      refreshToken: refresh.refreshToken,
      tokenType: 'Bearer',
      expiresIn: 30 * 86400,
      refreshExpiresIn: refresh.refreshExpiresIn,
      payload: { parentId: parent.id, type: 'parent' },
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
      // 2026-05-22 (SSOT §14.2): refresh 补完整 4 字段防 UX 突变
      //   user.repository 已有 name + mobile，tenantName + campusName 走
      //   phoneLookup.getUserContextById fail-open 兜底（任一查询失败返空串）
      const userCtx = await this.phoneLookup.getUserContextById(
        oldRow.tenantId,
        realUser.campusId ?? null,
      );
      const signPayload: Omit<JwtPayload, 'jti' | 'aud'> = {
        sub: oldRow.subjectId,
        tenantId: oldRow.tenantId,
        role: realUser.role,
        // realUser.campusId 类型为 string（user.repository.ts:25），但 JwtPayload.campusId
        // 允许 null（跨校 role 如 boss / admin / hr）— V2 schema users.campus_id 可空
        campusId: realUser.campusId ?? null,
        name: realUser.name,
        tenantName: userCtx.tenantName || undefined,
        campusName: userCtx.campusName || undefined,
        phone: realUser.mobile,
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
