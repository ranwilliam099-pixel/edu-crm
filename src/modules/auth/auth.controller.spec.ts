/**
 * AuthController 单测 — 联调收尾两个登录接口 + Sprint E.1 logout
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { ParentJwtStrategy } from './parent-jwt.strategy';
import { RedisService } from '../redis/redis.service';
import { AuthenticatedRequest } from './jwt-payload.interface';
import { WxCodeSessionService } from './wx-code-session.service';
import { RefreshTokenService } from './refresh-token.service';
import { RefreshTokenRow } from './refresh-token.repository';

const ULID32 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMN01';
const ULID32_T = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNTN';
const ULID32_C = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNCM';

describe('AuthController - 登录接口 + Sprint E.1 logout', () => {
  let controller: AuthController;
  let jwt: JwtService;
  let redisSetSpy: jest.Mock<Promise<void>, [string, string, number?]>;
  let wxCodeSessionExchangeSpy: jest.Mock;
  let refreshIssueSpy: jest.Mock;
  let refreshRotateSpy: jest.Mock;
  let refreshRevokeByRawSpy: jest.Mock;

  const buildReqWithMeta = (auth?: string): AuthenticatedRequest =>
    ({
      headers: {
        ...(auth ? { authorization: auth } : {}),
        'user-agent': 'JestTest/1.0',
        'x-request-id': 'req-test-123',
      },
      ip: '127.0.0.1',
    }) as AuthenticatedRequest;

  beforeEach(async () => {
    redisSetSpy = jest.fn().mockResolvedValue(undefined);
    wxCodeSessionExchangeSpy = jest.fn().mockResolvedValue({
      openid: 'oTestOpenidExchangedSuccessfully',
      sessionKey: 'test_session_key_should_not_return',
      unionid: undefined,
    });
    refreshIssueSpy = jest.fn().mockResolvedValue({
      refreshToken: 'rt_mock_raw_token_xxxxxxxxxxxxxxxxxxxxxxx',
      refreshExpiresIn: 604800,
      jti: '01HX7Y6P5K9N3M2QABCDEFGHIJ',
    });
    refreshRotateSpy = jest.fn();
    refreshRevokeByRawSpy = jest.fn().mockResolvedValue(undefined);
    const module: TestingModule = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: 'test-secret', signOptions: { expiresIn: '1d' } })],
      controllers: [AuthController],
      providers: [
        ParentJwtStrategy,
        {
          provide: ConfigService,
          useValue: { get: () => 'test-secret' },
        },
        {
          provide: RedisService,
          useValue: { set: redisSetSpy },
        },
        {
          provide: WxCodeSessionService,
          useValue: { exchange: wxCodeSessionExchangeSpy },
        },
        {
          provide: RefreshTokenService,
          useValue: {
            issue: refreshIssueSpy,
            rotate: refreshRotateSpy,
            revokeByRaw: refreshRevokeByRawSpy,
          },
        },
      ],
    }).compile();
    controller = module.get<AuthController>(AuthController);
    jwt = module.get<JwtService>(JwtService);
  });

  describe('login - B 端员工登录', () => {
    it('合法登录 → 返回 JWT + refreshToken (T11)', async () => {
      const result = await controller.login(buildReqWithMeta(), {
        phone: '13800001111',
        tenantId: ULID32_T,
        role: 'sales',
        campusId: ULID32_C,
        userId: ULID32,
      });
      expect(result.token).toBeTruthy();
      expect(result.tokenType).toBe('Bearer');
      expect(result.payload.role).toBe('sales');
      // T11: login 返回的 refreshToken / refreshExpiresIn
      expect(result.refreshToken).toBe('rt_mock_raw_token_xxxxxxxxxxxxxxxxxxxxxxx');
      expect(result.refreshExpiresIn).toBe(604800);
      expect(refreshIssueSpy).toHaveBeenCalledWith({
        subjectType: 'b-user',
        subjectId: ULID32,
        tenantId: ULID32_T,
        userAgent: 'JestTest/1.0',
        ip: '127.0.0.1',
      });
    });

    it('phone 非法 → BadRequestException', async () => {
      await expect(
        controller.login(buildReqWithMeta(), {
          phone: '12345',
          tenantId: ULID32_T,
          role: 'sales',
          campusId: ULID32_C,
          userId: ULID32,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(refreshIssueSpy).not.toHaveBeenCalled();
    });

    it('userId 长度非 32 → BadRequestException', async () => {
      await expect(
        controller.login(buildReqWithMeta(), {
          phone: '13800001111',
          tenantId: ULID32_T,
          role: 'sales',
          campusId: ULID32_C,
          userId: 'short',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('未知 role → BadRequestException', async () => {
      await expect(
        controller.login(buildReqWithMeta(), {
          phone: '13800001111',
          tenantId: ULID32_T,
          role: 'unknown',
          campusId: ULID32_C,
          userId: ULID32,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('admin (跨校 / 老板) 不传 campusId → 接受，payload.campusId=null', async () => {
      const result = await controller.login(buildReqWithMeta(), {
        phone: '13800001111',
        tenantId: ULID32_T,
        role: 'admin',
        userId: ULID32,
      });
      expect(result.payload.campusId).toBeNull();
      expect(result.payload.role).toBe('admin');
    });

    it('admin 显式给 32 字符 campusId（主校区视角）→ 接受', async () => {
      const result = await controller.login(buildReqWithMeta(), {
        phone: '13800001111',
        tenantId: ULID32_T,
        role: 'admin',
        campusId: ULID32_C,
        userId: ULID32,
      });
      expect(result.payload.campusId).toBe(ULID32_C);
    });

    it('admin 给非 32 字符 campusId → BadRequestException', async () => {
      await expect(
        controller.login(buildReqWithMeta(), {
          phone: '13800001111',
          tenantId: ULID32_T,
          role: 'admin',
          campusId: 'short',
          userId: ULID32,
        }),
      ).rejects.toThrow(/cross-campus.*null.*32-char/);
    });

    // 5/15 A-2：sales_director 应用层已删（不在拍板权威 9 角色清单）
    //   - login validRoles 删 sales_director → BadRequestException(role must be one of ...)
    it('sales_director (5/15 A-2 已删) → BadRequestException（不在 validRoles）', async () => {
      await expect(
        controller.login(buildReqWithMeta(), {
          phone: '13800001111',
          tenantId: ULID32_T,
          role: 'sales_director',
          userId: ULID32,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('hr (跨校) 不传 campusId → 接受', async () => {
      const result = await controller.login(buildReqWithMeta(), {
        phone: '13800001111',
        tenantId: ULID32_T,
        role: 'hr',
        userId: ULID32,
      });
      expect(result.payload.campusId).toBeNull();
    });

    it('boss (单校 / 校长) 不传 campusId → BadRequestException — V10 单校强校验', async () => {
      await expect(
        controller.login(buildReqWithMeta(), {
          phone: '13800001111',
          tenantId: ULID32_T,
          role: 'boss',
          userId: ULID32,
        }),
      ).rejects.toThrow(/single-campus.*boss.*32-char campusId/);
    });

    it('boss 给非 32 字符 campusId → BadRequestException', async () => {
      await expect(
        controller.login(buildReqWithMeta(), {
          phone: '13800001111',
          tenantId: ULID32_T,
          role: 'boss',
          campusId: 'short',
          userId: ULID32,
        }),
      ).rejects.toThrow(/single-campus.*boss/);
    });

    it('sales (单校) 不传 campusId → BadRequestException', async () => {
      await expect(
        controller.login(buildReqWithMeta(), {
          phone: '13800001111',
          tenantId: ULID32_T,
          role: 'sales',
          userId: ULID32,
        }),
      ).rejects.toThrow(/single-campus.*sales/);
    });

    it('marketing (单校) 不传 campusId → BadRequestException', async () => {
      await expect(
        controller.login(buildReqWithMeta(), {
          phone: '13800001111',
          tenantId: ULID32_T,
          role: 'marketing',
          userId: ULID32,
        }),
      ).rejects.toThrow(/single-campus.*marketing/);
    });

    it('finance (单校) 不传 campusId → BadRequestException', async () => {
      await expect(
        controller.login(buildReqWithMeta(), {
          phone: '13800001111',
          tenantId: ULID32_T,
          role: 'finance',
          userId: ULID32,
        }),
      ).rejects.toThrow(/single-campus.*finance/);
    });

    // Sprint B (2026-05-11) — TenantRole 加 teacher / academic / academic_admin
    it('teacher (单校) 合法登录 → 返回 JWT — Sprint B', async () => {
      const result = await controller.login(buildReqWithMeta(), {
        phone: '13800001111',
        tenantId: ULID32_T,
        role: 'teacher',
        campusId: ULID32_C,
        userId: ULID32,
      });
      expect(result.token).toBeTruthy();
      expect(result.payload.role).toBe('teacher');
      expect(result.payload.campusId).toBe(ULID32_C);
    });

    it('teacher (单校) 不传 campusId → BadRequestException — Sprint B', async () => {
      await expect(
        controller.login(buildReqWithMeta(), {
          phone: '13800001111',
          tenantId: ULID32_T,
          role: 'teacher',
          userId: ULID32,
        }),
      ).rejects.toThrow(/single-campus.*teacher/);
    });

    it('academic (单校 普通教务) 合法登录 → 返回 JWT — Sprint B', async () => {
      const result = await controller.login(buildReqWithMeta(), {
        phone: '13800001111',
        tenantId: ULID32_T,
        role: 'academic',
        campusId: ULID32_C,
        userId: ULID32,
      });
      expect(result.payload.role).toBe('academic');
    });

    it('academic_admin (单校 教务主管) 合法登录 → 返回 JWT — Sprint B', async () => {
      const result = await controller.login(buildReqWithMeta(), {
        phone: '13800001111',
        tenantId: ULID32_T,
        role: 'academic_admin',
        campusId: ULID32_C,
        userId: ULID32,
      });
      expect(result.payload.role).toBe('academic_admin');
    });

    it('academic 不传 campusId → BadRequestException — Sprint B', async () => {
      await expect(
        controller.login(buildReqWithMeta(), {
          phone: '13800001111',
          tenantId: ULID32_T,
          role: 'academic',
          userId: ULID32,
        }),
      ).rejects.toThrow(/single-campus.*academic/);
    });
  });

  describe('wechatLogin - C 端家长微信登录', () => {
    it('合法登录 → 返回 ParentJwt + refreshToken (T11)', async () => {
      const result = await controller.wechatLogin(buildReqWithMeta(), {
        parentId: ULID32,
        openid: 'oWxXXX',
      });
      expect(result.token).toBeTruthy();
      expect(result.payload.type).toBe('parent');
      expect(result.payload.parentId).toBe(ULID32);
      // T11: wechatLogin 返回的 refreshToken（C 端 30d，但 mock issue 固定返 604800）
      expect(result.refreshToken).toBeTruthy();
      expect(refreshIssueSpy).toHaveBeenCalledWith({
        subjectType: 'parent',
        subjectId: ULID32,
        tenantId: null,
        userAgent: 'JestTest/1.0',
        ip: '127.0.0.1',
      });
    });

    it('parentId 长度非 32 → BadRequestException', async () => {
      await expect(
        controller.wechatLogin(buildReqWithMeta(), { parentId: 'short' }),
      ).rejects.toThrow(BadRequestException);
      expect(refreshIssueSpy).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // T6a audit A1-r2 P0-NEW-3 (2026-05-16) — audience 切分
  // ============================================================
  describe('login / wechatLogin — JWT audience（T6a）', () => {
    it('login 产生的 token aud=b-app', async () => {
      const result = await controller.login(buildReqWithMeta(), {
        phone: '13800001111',
        tenantId: ULID32_T,
        role: 'sales',
        campusId: ULID32_C,
        userId: ULID32,
      });
      const decoded: any = jwt.verify(result.token);
      expect(decoded.aud).toBe('b-app');
      expect(result.payload.aud).toBe('b-app');
    });

    it('wechatLogin 产生的 token aud=parent-app', async () => {
      const result = await controller.wechatLogin(buildReqWithMeta(), {
        parentId: ULID32,
        openid: 'oWxXXX',
      });
      const decoded: any = jwt.verify(result.token);
      expect(decoded.aud).toBe('parent-app');
    });
  });

  // ============================================================
  // Sprint E.1 (2026-05-13) — login 含 jti claim（JWT 黑名单基础）
  // ============================================================
  describe('login - jti claim (Sprint E.1)', () => {
    it('login 返回的 payload 含 jti（26-char ULID）', async () => {
      const result = await controller.login(buildReqWithMeta(), {
        phone: '13800001111',
        tenantId: ULID32_T,
        role: 'sales',
        campusId: ULID32_C,
        userId: ULID32,
      });
      expect(result.payload.jti).toBeTruthy();
      // ULID 是 26 字符（Crockford base32）
      expect(typeof result.payload.jti).toBe('string');
      expect(result.payload.jti!.length).toBe(26);
    });

    it('login 返回的 token decode 后含 jti 等于 payload.jti', async () => {
      const result = await controller.login(buildReqWithMeta(), {
        phone: '13800001111',
        tenantId: ULID32_T,
        role: 'sales',
        campusId: ULID32_C,
        userId: ULID32,
      });
      const decoded = jwt.decode(result.token) as { jti?: string };
      expect(decoded.jti).toBe(result.payload.jti);
    });

    it('两次连续 login → 两个不同 jti（唯一性）', async () => {
      const r1 = await controller.login(buildReqWithMeta(), {
        phone: '13800001111',
        tenantId: ULID32_T,
        role: 'sales',
        campusId: ULID32_C,
        userId: ULID32,
      });
      const r2 = await controller.login(buildReqWithMeta(), {
        phone: '13800001111',
        tenantId: ULID32_T,
        role: 'sales',
        campusId: ULID32_C,
        userId: ULID32,
      });
      expect(r1.payload.jti).not.toBe(r2.payload.jti);
    });
  });

  // ============================================================
  // Sprint E.1 (2026-05-13) — logout endpoint + Redis 黑名单写入
  // ============================================================
  describe('logout - JWT 黑名单（Sprint E.1）+ T11 refresh 撤销', () => {
    /** 构造一个带 jti 的真实 token（用 controller.login） */
    const issueToken = async () => {
      const result = await controller.login(buildReqWithMeta(), {
        phone: '13800001111',
        tenantId: ULID32_T,
        role: 'sales',
        campusId: ULID32_C,
        userId: ULID32,
      });
      return { token: result.token, jti: result.payload.jti! };
    };

    const buildReq = (auth?: string): AuthenticatedRequest =>
      ({ headers: auth ? { authorization: auth } : {} }) as AuthenticatedRequest;

    it('无 Authorization header → 401', async () => {
      await expect(controller.logout(buildReq())).rejects.toThrow(UnauthorizedException);
      expect(redisSetSpy).not.toHaveBeenCalled();
    });

    it('Authorization 格式不对（无 Bearer 前缀）→ 401', async () => {
      await expect(controller.logout(buildReq('NotBearer xxx'))).rejects.toThrow(
        UnauthorizedException,
      );
      expect(redisSetSpy).not.toHaveBeenCalled();
    });

    it('Bearer 后空字符串 → 401', async () => {
      await expect(controller.logout(buildReq('Bearer '))).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('Bearer 后 token 无效 → 401', async () => {
      await expect(controller.logout(buildReq('Bearer not.a.real.jwt'))).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('合法 token + 含 jti → 写 Redis 黑名单 + 返回 { ok: true }', async () => {
      const { token, jti } = await issueToken();
      const result = await controller.logout(buildReq(`Bearer ${token}`));
      expect(result).toEqual({ ok: true });
      expect(redisSetSpy).toHaveBeenCalledTimes(1);
      const [key, value, ttl] = redisSetSpy.mock.calls[0];
      expect(key).toBe(`auth:revoked:${jti}`);
      expect(value).toBe('1');
      expect(typeof ttl).toBe('number');
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(86400); // 1d 默认 TTL
    });

    it('旧 token 无 jti（jwtid sign 缺失）→ 返回 ok 但不写 Redis', async () => {
      // 直接用 JwtService.sign 不带 jwtid，模拟旧 token
      const legacyToken = jwt.sign({
        sub: ULID32,
        tenantId: ULID32_T,
        role: 'sales',
        campusId: ULID32_C,
      });
      const result = await controller.logout(buildReq(`Bearer ${legacyToken}`));
      expect(result).toEqual({ ok: true });
      expect(redisSetSpy).not.toHaveBeenCalled();
    });

    it('Redis fail-open: Redis.set 抛错 → logout 仍返回 ok（不阻塞用户）', async () => {
      redisSetSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const { token } = await issueToken();
      const result = await controller.logout(buildReq(`Bearer ${token}`));
      expect(result).toEqual({ ok: true });
      expect(redisSetSpy).toHaveBeenCalledTimes(1);
    });

    // T11 (2026-05-16) spec §4.3: logout 同时撤销 refresh token
    it('T11: logout body 带 refreshToken → 同时撤销 refresh + access', async () => {
      const { token } = await issueToken();
      const result = await controller.logout(buildReq(`Bearer ${token}`), {
        refreshToken: 'rt_some_valid_raw_token_xxxxxxxxxxxxxxxx',
      });
      expect(result).toEqual({ ok: true });
      expect(refreshRevokeByRawSpy).toHaveBeenCalledTimes(1);
      expect(refreshRevokeByRawSpy).toHaveBeenCalledWith(
        'rt_some_valid_raw_token_xxxxxxxxxxxxxxxx',
      );
    });

    it('T11: logout body 不带 refreshToken（旧客户端向前兼容）→ 不调用 revokeByRaw', async () => {
      const { token } = await issueToken();
      await controller.logout(buildReq(`Bearer ${token}`));
      expect(refreshRevokeByRawSpy).not.toHaveBeenCalled();
    });

    it('T11: logout body.refreshToken 形态错（短于 20 字符）→ 不调用 revokeByRaw（不报错）', async () => {
      const { token } = await issueToken();
      const result = await controller.logout(buildReq(`Bearer ${token}`), {
        refreshToken: 'short',
      });
      expect(result).toEqual({ ok: true });
      expect(refreshRevokeByRawSpy).not.toHaveBeenCalled();
    });

    it('T11: refreshToken 撤销失败（DB error）→ logout 仍返回 ok（fail-open）', async () => {
      refreshRevokeByRawSpy.mockRejectedValueOnce(new Error('DB down'));
      const { token } = await issueToken();
      const result = await controller.logout(buildReq(`Bearer ${token}`), {
        refreshToken: 'rt_some_valid_raw_token_xxxxxxxxxxxxxxxx',
      });
      expect(result).toEqual({ ok: true });
      expect(refreshRevokeByRawSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // T11 (2026-05-16) refresh endpoint — spec §2 完整流程
  // ============================================================
  describe('T11 refresh - POST /public/auth/refresh', () => {
    const VALID_RAW = 'rt_valid_raw_token_xxxxxxxxxxxxxxxx';

    const makeBUserRow = (overrides?: Partial<RefreshTokenRow>): RefreshTokenRow => ({
      id: '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNROW',
      subjectType: 'b-user',
      subjectId: ULID32,
      tenantId: ULID32_T,
      tokenHash: Buffer.alloc(32),
      jti: '01HX7Y6P5K9N3M2QABCDEFGHIJ',
      expiresAt: new Date(Date.now() + 604800 * 1000),
      revokedAt: null,
      createdAt: new Date(),
      lastUsedAt: null,
      userAgent: null,
      ip: null,
      ...overrides,
    });

    const makeParentRow = (overrides?: Partial<RefreshTokenRow>): RefreshTokenRow => ({
      id: '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNPRT',
      subjectType: 'parent',
      subjectId: ULID32,
      tenantId: null,
      tokenHash: Buffer.alloc(32),
      jti: '01HX7Y6P5K9N3M2QABCDEFGHIJ',
      expiresAt: new Date(Date.now() + 2592000 * 1000),
      revokedAt: null,
      createdAt: new Date(),
      lastUsedAt: null,
      userAgent: null,
      ip: null,
      ...overrides,
    });

    it('happy path B 端: 合法 refresh → 新 access token + 新 refresh token', async () => {
      const oldRow = makeBUserRow();
      refreshRotateSpy.mockResolvedValueOnce({
        oldRow,
        newToken: {
          refreshToken: 'rt_new_b_token_xxxxxxxxxxxxxxxxxxxxxxx',
          refreshExpiresIn: 604800,
          jti: '01HX7Y6P5K9N3M2QABCDEFGHIJ',
        },
      });
      const result = await controller.refresh(buildReqWithMeta(), {
        refreshToken: VALID_RAW,
      });
      expect(result.accessToken).toBeTruthy();
      expect(result.refreshToken).toBe('rt_new_b_token_xxxxxxxxxxxxxxxxxxxxxxx');
      expect(result.tokenType).toBe('Bearer');
      expect(result.expiresIn).toBe(86400);
      expect(result.refreshExpiresIn).toBe(604800);
      // B 端 token 复用旧 row.subjectId/tenantId 续签
      const decoded: any = jwt.verify(result.accessToken);
      expect(decoded.aud).toBe('b-app');
      expect(decoded.sub).toBe(ULID32);
      expect(decoded.tenantId).toBe(ULID32_T);
      // spec §2.2: service.rotate 调用包含 ip/ua/requestId
      expect(refreshRotateSpy).toHaveBeenCalledWith(VALID_RAW, {
        userAgent: 'JestTest/1.0',
        ip: '127.0.0.1',
        requestId: 'req-test-123',
      });
    });

    it('happy path C 端 parent: 合法 refresh → 新 parent access + 新 refresh', async () => {
      const oldRow = makeParentRow();
      refreshRotateSpy.mockResolvedValueOnce({
        oldRow,
        newToken: {
          refreshToken: 'rt_new_parent_token_xxxxxxxxxxxxxxxxxxx',
          refreshExpiresIn: 2592000,
          jti: '01HX7Y6P5K9N3M2QABCDEFGHIJ',
        },
      });
      const result = await controller.refresh(buildReqWithMeta(), {
        refreshToken: VALID_RAW,
      });
      expect(result.refreshExpiresIn).toBe(2592000);
      // C 端 token aud=parent-app
      const decoded: any = jwt.verify(result.accessToken);
      expect(decoded.aud).toBe('parent-app');
      expect(decoded.type).toBe('parent');
      expect(decoded.parentId).toBe(ULID32);
    });

    it('body.refreshToken 缺失 → 400 BadRequest（不调用 rotate）', async () => {
      await expect(
        controller.refresh(buildReqWithMeta(), {} as { refreshToken: string }),
      ).rejects.toThrow(BadRequestException);
      expect(refreshRotateSpy).not.toHaveBeenCalled();
    });

    it('body.refreshToken 形态错（短于 20 字符）→ 400 BadRequest', async () => {
      await expect(
        controller.refresh(buildReqWithMeta(), { refreshToken: 'short' }),
      ).rejects.toThrow(BadRequestException);
      expect(refreshRotateSpy).not.toHaveBeenCalled();
    });

    it('service.rotate 抛 UnauthorizedException (INVALID/REVOKED/EXPIRED) → 透传 401', async () => {
      refreshRotateSpy.mockRejectedValueOnce(new UnauthorizedException('REVOKED'));
      await expect(
        controller.refresh(buildReqWithMeta(), { refreshToken: VALID_RAW }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('refresh body 超长（> 200 字符）→ 400 BadRequest', async () => {
      await expect(
        controller.refresh(buildReqWithMeta(), {
          refreshToken: 'a'.repeat(201),
        }),
      ).rejects.toThrow(BadRequestException);
      expect(refreshRotateSpy).not.toHaveBeenCalled();
    });
  });

  // 2026-05-14 凌晨 wxpay 沙箱集成：code → openid 换取
  describe('wxJscode2Session - 微信 code 换 openid', () => {
    const VALID_CODE = '0a3xyzAbC1234567890';

    it('happy path: code 合法 → 返 openid（不返 sessionKey）', async () => {
      const result = await controller.wxJscode2Session({ code: VALID_CODE });
      expect(result).toEqual({ openid: 'oTestOpenidExchangedSuccessfully' });
      // 安全：sessionKey 不返 client（防 XSS 解密 wx.getUserInfo 加密数据）
      expect((result as Record<string, unknown>).sessionKey).toBeUndefined();
      expect(wxCodeSessionExchangeSpy).toHaveBeenCalledWith(VALID_CODE);
    });

    it('code 缺失 → BadRequest', async () => {
      await expect(
        controller.wxJscode2Session({ code: '' } as never),
      ).rejects.toThrow(BadRequestException);
      expect(wxCodeSessionExchangeSpy).not.toHaveBeenCalled();
    });

    it('body 为 null → BadRequest', async () => {
      await expect(
        controller.wxJscode2Session(null as never),
      ).rejects.toThrow(BadRequestException);
    });

    it('code 非 string → BadRequest', async () => {
      await expect(
        controller.wxJscode2Session({ code: 12345 } as never),
      ).rejects.toThrow(BadRequestException);
    });

    it('code 过短（< 5 字符）→ BadRequest', async () => {
      await expect(
        controller.wxJscode2Session({ code: 'abcd' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('code 过长（> 200 字符）→ BadRequest', async () => {
      await expect(
        controller.wxJscode2Session({ code: 'a'.repeat(201) }),
      ).rejects.toThrow(BadRequestException);
    });

    it('微信 service 抛 InternalServerError → 透传', async () => {
      wxCodeSessionExchangeSpy.mockRejectedValueOnce(
        new Error('jscode2session failed'),
      );
      await expect(
        controller.wxJscode2Session({ code: VALID_CODE }),
      ).rejects.toThrow('jscode2session failed');
    });
  });
});
