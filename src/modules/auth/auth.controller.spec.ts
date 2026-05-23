/**
 * AuthController 单测 — Sprint X.2 (2026-05-17) login 改造 + check-phone / login-confirm 新增
 *
 * 改造内容（SSOT §12 + 用户拍板 D1-D10）：
 *   - login 删 role/tenantId/userId 自报 → phone+password → 跨表反查 + bcrypt
 *   - check-phone 新增（5/min/IP throttle）
 *   - login-confirm 新增（D4 无 session 多 tenant 候选确认）
 *   - logout / refresh / wechatLogin 行为不变（spec 旧用例保留）
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
import { UserRepository } from '../db/user.repository';
import { PhoneLookupService, BUserMatch } from './phone-lookup.service';
import { PasswordHasher } from '../../common/crypto/password-hasher';
// Sprint X.2 round 2 (2026-05-17 business NOGO-BLOCKER 修复): audit_log 注入
import { AuditLogRepository } from '../db/audit-log.repository';
// 2026-05-23 P0 T2 wechat-login 安全改造: openid 反查 parents 表
import { ParentRepository } from '../db/parent.repository';
import { Parent } from '../parent/parent.service';

const ULID32 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMN01';
const ULID32_T = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNTN';
const ULID32_T2 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNT2';
const ULID32_C = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNCM';

// 60-char bcrypt hash 占位（spec mock 用，不真跑 bcrypt 计算）
const FAKE_BCRYPT_HASH =
  '$2b$12$abcdefghijklmnopqrstuuKzCvg5LZTktJiNJq1.UpgQ8RG5xRYL.';

const makeBUser = (overrides: Partial<BUserMatch> = {}): BUserMatch => ({
  userId: ULID32,
  tenantId: ULID32_T,
  tenantName: 'TestTenant',
  role: 'sales',
  campusId: ULID32_C,
  userName: 'Alice',
  passwordHash: FAKE_BCRYPT_HASH,
  status: '启用',
  deletedAt: null,
  campusName: '主校区',
  ...overrides,
});

describe('AuthController - Sprint X.2 + 既有 endpoint 回归', () => {
  let controller: AuthController;
  let jwt: JwtService;
  let redisSetSpy: jest.Mock<Promise<void>, [string, string, number?]>;
  let wxCodeSessionExchangeSpy: jest.Mock;
  let refreshIssueSpy: jest.Mock;
  let refreshRotateSpy: jest.Mock;
  let refreshRevokeByRawSpy: jest.Mock;
  let userRepoFindByIdSpy: jest.Mock;
  let phoneLookupSpy: jest.Mock;
  let passwordVerifySpy: jest.Mock;
  // Sprint X.2 round 2 (2026-05-17): audit_log fail-open mock
  let auditLogSpy: jest.Mock;
  // 2026-05-23 P0 T2 wechat-login: openid 反查 parent mock
  let parentRepoFindByOpenidSpy: jest.Mock;

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
    userRepoFindByIdSpy = jest.fn().mockResolvedValue({
      id: ULID32,
      name: 'mock user',
      mobile: '13800138000',
      role: 'admin',
      campusId: ULID32_C,
      status: '启用',
      createdAt: '2026-05-16T00:00:00Z',
      updatedAt: '2026-05-16T00:00:00Z',
    });
    // 默认: phone 不存在 (0 row)
    phoneLookupSpy = jest.fn().mockResolvedValue({ bUsers: [], parent: null });
    passwordVerifySpy = jest.fn().mockResolvedValue(true);
    auditLogSpy = jest.fn().mockResolvedValue(undefined);
    // 2026-05-23 T2: 默认 parent 命中且 '启用' (happy path 用; 失败用例 mockResolvedValueOnce 覆盖)
    parentRepoFindByOpenidSpy = jest.fn().mockResolvedValue({
      id: ULID32,
      phone: '13800138000',
      wechatOpenid: 'oTestOpenidExchangedSuccessfully',
      name: 'TestParent',
      status: '启用',
    } as Parent);

    const module: TestingModule = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: 'test-secret', signOptions: { expiresIn: '1d' } })],
      controllers: [AuthController],
      providers: [
        ParentJwtStrategy,
        { provide: ConfigService, useValue: { get: () => 'test-secret' } },
        { provide: RedisService, useValue: { set: redisSetSpy } },
        { provide: WxCodeSessionService, useValue: { exchange: wxCodeSessionExchangeSpy } },
        {
          provide: RefreshTokenService,
          useValue: {
            issue: refreshIssueSpy,
            rotate: refreshRotateSpy,
            revokeByRaw: refreshRevokeByRawSpy,
          },
        },
        { provide: UserRepository, useValue: { findById: userRepoFindByIdSpy } },
        // Sprint X.2 — 新 dependency
        {
          provide: PhoneLookupService,
          useValue: {
            lookupByPhone: phoneLookupSpy,
            // 2026-05-22 refresh endpoint 新依赖（拿 tenantName + campusName 补完整 4 字段）
            getUserContextById: jest
              .fn()
              .mockResolvedValue({ tenantName: 'TestOrg', campusName: 'TestCampus' }),
          },
        },
        { provide: PasswordHasher, useValue: { verify: passwordVerifySpy } },
        // Sprint X.2 round 2: audit_log mock (fail-open, 不阻断登录主流程)
        { provide: AuditLogRepository, useValue: { log: auditLogSpy } },
        // 2026-05-23 T2: parent.repository.findParentByOpenid mock (wechatLogin 新依赖)
        {
          provide: ParentRepository,
          useValue: { findParentByOpenid: parentRepoFindByOpenidSpy },
        },
      ],
    }).compile();
    controller = module.get<AuthController>(AuthController);
    jwt = module.get<JwtService>(JwtService);
  });

  // ============================================================
  // Sprint X.2 — POST /api/public/auth/check-phone (SSOT §12.1)
  // ============================================================
  describe('check-phone - 路由分支 (SSOT §12.1)', () => {
    it('phone 缺失 → 400', async () => {
      await expect(
        controller.checkPhone({ phone: '' } as never),
      ).rejects.toThrow(BadRequestException);
      expect(phoneLookupSpy).not.toHaveBeenCalled();
    });

    it('phone 格式非法 → 400', async () => {
      await expect(
        controller.checkPhone({ phone: '12345' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('phone 未注册 → { exists:false, accountType:null }', async () => {
      phoneLookupSpy.mockResolvedValueOnce({ bUsers: [], parent: null });
      const result = await controller.checkPhone({ phone: '13800001111' });
      expect(result).toEqual({ exists: false, accountType: null });
    });

    it('phone 命中单 B-user → { exists:true, accountType:"b" }', async () => {
      phoneLookupSpy.mockResolvedValueOnce({ bUsers: [makeBUser()], parent: null });
      const result = await controller.checkPhone({ phone: '13800001111' });
      expect(result).toEqual({ exists: true, accountType: 'b' });
    });

    it('phone 命中 parent → { exists:true, accountType:"c" }', async () => {
      phoneLookupSpy.mockResolvedValueOnce({
        bUsers: [],
        parent: { parentId: ULID32, status: '启用' },
      });
      const result = await controller.checkPhone({ phone: '13800001111' });
      expect(result).toEqual({ exists: true, accountType: 'c' });
    });

    it('D5 互斥违反: B + C 同 phone 命中 → { exists:false, accountType:null }', async () => {
      phoneLookupSpy.mockResolvedValueOnce({
        bUsers: [makeBUser()],
        parent: { parentId: ULID32, status: '启用' },
      });
      const result = await controller.checkPhone({ phone: '13800001111' });
      // D5: 不透传细节, 返 null 防枚举
      expect(result).toEqual({ exists: false, accountType: null });
    });

    it('B-user status="停用" → 视为未命中 (失效逻辑 SSOT §12.6)', async () => {
      phoneLookupSpy.mockResolvedValueOnce({
        bUsers: [makeBUser({ status: '停用' })],
        parent: null,
      });
      const result = await controller.checkPhone({ phone: '13800001111' });
      expect(result).toEqual({ exists: false, accountType: null });
    });

    it('B-user deleted_at !== null → 视为未命中 (V44 软删)', async () => {
      phoneLookupSpy.mockResolvedValueOnce({
        bUsers: [makeBUser({ deletedAt: new Date() })],
        parent: null,
      });
      const result = await controller.checkPhone({ phone: '13800001111' });
      expect(result).toEqual({ exists: false, accountType: null });
    });

    it('parent status="停用" → 视为未命中', async () => {
      phoneLookupSpy.mockResolvedValueOnce({
        bUsers: [],
        parent: { parentId: ULID32, status: '停用' },
      });
      const result = await controller.checkPhone({ phone: '13800001111' });
      expect(result).toEqual({ exists: false, accountType: null });
    });
  });

  // ============================================================
  // Sprint X.2 — POST /api/public/auth/login (SSOT §12.3)
  // ============================================================
  describe('login - B/C 密码登录 (SSOT §12.3)', () => {
    it('phone 格式非法 → 400', async () => {
      await expect(
        controller.login(buildReqWithMeta(), { phone: '12345', password: 'p123' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('password 缺失 → 400', async () => {
      await expect(
        controller.login(buildReqWithMeta(), { phone: '13800001111', password: '' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('password 超长 (>128) → 400', async () => {
      await expect(
        controller.login(buildReqWithMeta(), {
          phone: '13800001111',
          password: 'a'.repeat(129),
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('phone 未注册 (0 B-user + 0 parent) → 401 INVALID_CREDENTIALS', async () => {
      phoneLookupSpy.mockResolvedValueOnce({ bUsers: [], parent: null });
      await expect(
        controller.login(buildReqWithMeta(), {
          phone: '13800001111',
          password: 'wrong',
        }),
      ).rejects.toThrow(UnauthorizedException);
      // timing 防御: dummy verify 必调
      expect(passwordVerifySpy).toHaveBeenCalledWith('wrong', '');
    });

    it('D3 C 端 parent 命中 → 401 PARENT_USE_WECHAT', async () => {
      phoneLookupSpy.mockResolvedValueOnce({
        bUsers: [],
        parent: { parentId: ULID32, status: '启用' },
      });
      await expect(
        controller.login(buildReqWithMeta(), {
          phone: '13800001111',
          password: 'whatever',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('D5 互斥违反: B + C 同时命中 → 401 INVALID_CREDENTIALS', async () => {
      phoneLookupSpy.mockResolvedValueOnce({
        bUsers: [makeBUser()],
        parent: { parentId: ULID32, status: '启用' },
      });
      await expect(
        controller.login(buildReqWithMeta(), {
          phone: '13800001111',
          password: 'whatever',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('1 B-user + 密码错 → 401', async () => {
      phoneLookupSpy.mockResolvedValueOnce({ bUsers: [makeBUser()], parent: null });
      passwordVerifySpy.mockResolvedValueOnce(false);
      await expect(
        controller.login(buildReqWithMeta(), {
          phone: '13800001111',
          password: 'wrong',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('1 B-user + 密码对 → 签 JWT + refresh (B 端 b-app)', async () => {
      phoneLookupSpy.mockResolvedValueOnce({ bUsers: [makeBUser()], parent: null });
      passwordVerifySpy.mockResolvedValueOnce(true);
      const result = await controller.login(buildReqWithMeta(), {
        phone: '13800001111',
        password: 'correct',
      });
      expect('token' in result).toBe(true);
      if ('token' in result) {
        expect(result.token).toBeTruthy();
        expect(result.tokenType).toBe('Bearer');
        expect(result.payload.role).toBe('sales');
        expect(result.payload.tenantId).toBe(ULID32_T);
        expect(result.payload.sub).toBe(ULID32);
        expect(result.payload.aud).toBe('b-app');
        expect(result.refreshToken).toBeTruthy();
      }
      expect(refreshIssueSpy).toHaveBeenCalledWith({
        subjectType: 'b-user',
        subjectId: ULID32,
        tenantId: ULID32_T,
        userAgent: 'JestTest/1.0',
        ip: '127.0.0.1',
      });
    });

    it('2+ B-user (跨 tenant 多绑) → 返 candidates 不签 token', async () => {
      const u1 = makeBUser({ tenantId: ULID32_T, tenantName: 'Tenant1' });
      const u2 = makeBUser({
        userId: ULID32.slice(0, -2) + 'X2',
        tenantId: ULID32_T2,
        tenantName: 'Tenant2',
        role: 'teacher',
      });
      phoneLookupSpy.mockResolvedValueOnce({ bUsers: [u1, u2], parent: null });
      const result = await controller.login(buildReqWithMeta(), {
        phone: '13800001111',
        password: 'correct',
      });
      expect('needTenantSelection' in result).toBe(true);
      if ('needTenantSelection' in result) {
        expect(result.needTenantSelection).toBe(true);
        expect(result.candidates).toHaveLength(2);
        // 防细粒度枚举: 仅 tenantId/tenantName/campusName/role
        expect(result.candidates[0]).toEqual({
          tenantId: ULID32_T,
          tenantName: 'Tenant1',
          campusName: '主校区',
          role: 'sales',
        });
        // 不含 userId / sub / passwordHash
        expect(Object.keys(result.candidates[0])).toEqual([
          'tenantId',
          'tenantName',
          'campusName',
          'role',
        ]);
      }
      // 2+ row 不调 bcrypt verify (等 login-confirm 重发)
      expect(passwordVerifySpy).not.toHaveBeenCalled();
      // 不签 refresh
      expect(refreshIssueSpy).not.toHaveBeenCalled();
    });

    it('B-user role 不在 validRoles (DB 历史 sales_director) → 401', async () => {
      phoneLookupSpy.mockResolvedValueOnce({
        bUsers: [makeBUser({ role: 'sales_director' })],
        parent: null,
      });
      passwordVerifySpy.mockResolvedValueOnce(true);
      await expect(
        controller.login(buildReqWithMeta(), {
          phone: '13800001111',
          password: 'whatever',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('单校 role 但 campusId 非 32-char (DB 完整性错) → 401', async () => {
      phoneLookupSpy.mockResolvedValueOnce({
        bUsers: [makeBUser({ campusId: 'short' })],
        parent: null,
      });
      passwordVerifySpy.mockResolvedValueOnce(true);
      await expect(
        controller.login(buildReqWithMeta(), {
          phone: '13800001111',
          password: 'whatever',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('跨校 role admin + null campusId → 接受 (V10 拍板)', async () => {
      phoneLookupSpy.mockResolvedValueOnce({
        bUsers: [makeBUser({ role: 'admin', campusId: null })],
        parent: null,
      });
      passwordVerifySpy.mockResolvedValueOnce(true);
      const result = await controller.login(buildReqWithMeta(), {
        phone: '13800001111',
        password: 'correct',
      });
      if ('payload' in result) {
        expect(result.payload.role).toBe('admin');
        expect(result.payload.campusId).toBeNull();
      }
    });

    it('teacher (单校) 合法登录 → b-app token', async () => {
      phoneLookupSpy.mockResolvedValueOnce({
        bUsers: [makeBUser({ role: 'teacher' })],
        parent: null,
      });
      passwordVerifySpy.mockResolvedValueOnce(true);
      const result = await controller.login(buildReqWithMeta(), {
        phone: '13800001111',
        password: 'correct',
      });
      if ('payload' in result) {
        expect(result.payload.role).toBe('teacher');
      }
    });

    it('academic (单校 普通教务) 合法登录', async () => {
      phoneLookupSpy.mockResolvedValueOnce({
        bUsers: [makeBUser({ role: 'academic' })],
        parent: null,
      });
      passwordVerifySpy.mockResolvedValueOnce(true);
      const result = await controller.login(buildReqWithMeta(), {
        phone: '13800001111',
        password: 'correct',
      });
      if ('payload' in result) {
        expect(result.payload.role).toBe('academic');
      }
    });
  });

  // ============================================================
  // Sprint X.2 — POST /api/public/auth/login-confirm (D4 无 session)
  // ============================================================
  describe('login-confirm - 多 tenant 候选确认 (D4)', () => {
    it('phone 缺失 → 400', async () => {
      await expect(
        controller.loginConfirm(buildReqWithMeta(), {
          phone: '',
          password: 'p',
          tenantId: ULID32_T,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('password 缺失 → 400', async () => {
      await expect(
        controller.loginConfirm(buildReqWithMeta(), {
          phone: '13800001111',
          password: '',
          tenantId: ULID32_T,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('tenantId 长度非 32 → 400', async () => {
      await expect(
        controller.loginConfirm(buildReqWithMeta(), {
          phone: '13800001111',
          password: 'p',
          tenantId: 'short',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('D4 tenantId 不在反查结果中 (伪造) → 401', async () => {
      const u1 = makeBUser({ tenantId: ULID32_T });
      phoneLookupSpy.mockResolvedValueOnce({ bUsers: [u1], parent: null });
      await expect(
        controller.loginConfirm(buildReqWithMeta(), {
          phone: '13800001111',
          password: 'whatever',
          tenantId: ULID32_T2, // 反查结果只有 ULID32_T
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('D4 选定 tenant + 密码错 → 401', async () => {
      phoneLookupSpy.mockResolvedValueOnce({ bUsers: [makeBUser()], parent: null });
      passwordVerifySpy.mockResolvedValueOnce(false);
      await expect(
        controller.loginConfirm(buildReqWithMeta(), {
          phone: '13800001111',
          password: 'wrong',
          tenantId: ULID32_T,
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('D4 选定 tenant + 密码对 → 签 b-app token', async () => {
      const u1 = makeBUser({ tenantId: ULID32_T, role: 'boss' });
      const u2 = makeBUser({
        userId: ULID32.slice(0, -2) + 'X2',
        tenantId: ULID32_T2,
        role: 'teacher',
      });
      phoneLookupSpy.mockResolvedValueOnce({ bUsers: [u1, u2], parent: null });
      passwordVerifySpy.mockResolvedValueOnce(true);
      const result = await controller.loginConfirm(buildReqWithMeta(), {
        phone: '13800001111',
        password: 'correct',
        tenantId: ULID32_T2,
      });
      expect(result.token).toBeTruthy();
      expect(result.payload.tenantId).toBe(ULID32_T2);
      expect(result.payload.role).toBe('teacher');
      expect(result.payload.aud).toBe('b-app');
    });
  });

  // ============================================================
  // 2026-05-23 P0 T2 wechatLogin - 安全改造 (openid 反查 parents 表)
  //   旧 body.parentId mock 已删 (任意 client 可伪造 parentId 越权高危漏洞)
  //   改造后: body.code → wx-jscode2session → openid → findParentByOpenid → sign ParentJwt
  // ============================================================
  describe('wechatLogin - C 端家长微信登录 (T2 安全改造)', () => {
    it('缺 body.code → 400', async () => {
      await expect(
        controller.wechatLogin(buildReqWithMeta(), {} as never),
      ).rejects.toThrow(BadRequestException);
      // 失败短路: 不应调微信 / 不应查 parents 表 / 不应签 refresh
      expect(wxCodeSessionExchangeSpy).not.toHaveBeenCalled();
      expect(parentRepoFindByOpenidSpy).not.toHaveBeenCalled();
      expect(refreshIssueSpy).not.toHaveBeenCalled();
    });

    it('code 有效但 openid 未绑 → 401 WECHAT_LOGIN_FAILED (防枚举)', async () => {
      parentRepoFindByOpenidSpy.mockResolvedValueOnce(null);
      await expect(
        controller.wechatLogin(buildReqWithMeta(), {
          code: '0a3xyzAbC1234567890',
        }),
      ).rejects.toThrow(UnauthorizedException);
      // 微信换 openid 调过 + parent 查询过 + 不发 refresh
      expect(wxCodeSessionExchangeSpy).toHaveBeenCalledTimes(1);
      expect(parentRepoFindByOpenidSpy).toHaveBeenCalledTimes(1);
      expect(refreshIssueSpy).not.toHaveBeenCalled();
      // audit 失败路径写入 (mask openid 后 8 位)
      expect(auditLogSpy).toHaveBeenCalledTimes(1);
      const [, entry] = auditLogSpy.mock.calls[0];
      expect(entry.action).toBe('auth.parent-login.failed');
      expect(entry.after.reason).toBe('OPENID_NOT_BOUND');
      expect(entry.after.openidMask).toMatch(/^\*\*\*/);
    });

    it('openid 绑定但 parent.status="停用" → 401 (同 message 不透传)', async () => {
      parentRepoFindByOpenidSpy.mockResolvedValueOnce({
        id: ULID32,
        phone: '13800138000',
        wechatOpenid: 'oTestOpenidExchangedSuccessfully',
        name: 'TestParent',
        status: '停用',
      } as Parent);
      await expect(
        controller.wechatLogin(buildReqWithMeta(), {
          code: '0a3xyzAbC1234567890',
        }),
      ).rejects.toThrow(UnauthorizedException);
      expect(refreshIssueSpy).not.toHaveBeenCalled();
      // audit 停用走 PARENT_DEACTIVATED reason (与 OPENID_NOT_BOUND 区分仅 server 内部可见)
      const [, entry] = auditLogSpy.mock.calls[0];
      expect(entry.action).toBe('auth.parent-login.failed');
      expect(entry.after.reason).toBe('PARENT_DEACTIVATED');
    });

    it('happy path: openid 命中 + status="启用" → 200 含 ParentJwt + refresh', async () => {
      const result = await controller.wechatLogin(buildReqWithMeta(), {
        code: '0a3xyzAbC1234567890',
      });
      expect(result.token).toBeTruthy();
      expect(result.payload.type).toBe('parent');
      // parentId 来自服务端 findParentByOpenid 结果, 不是 client 自报
      expect(result.payload.parentId).toBe(ULID32);
      // P1-2 (2026-05-23): payload 不返 openid (A02 微信 openid 等同 sessionKey 不透传 client)
      expect((result.payload as { openid?: string }).openid).toBeUndefined();
      expect(result.refreshToken).toBeTruthy();
      expect(refreshIssueSpy).toHaveBeenCalledWith({
        subjectType: 'parent',
        subjectId: ULID32,
        tenantId: null,
        userAgent: 'JestTest/1.0',
        ip: '127.0.0.1',
      });
      // 成功 audit 写入 (action='auth.parent-login.wechat')
      expect(auditLogSpy).toHaveBeenCalledTimes(1);
      const [, entry] = auditLogSpy.mock.calls[0];
      expect(entry.action).toBe('auth.parent-login.wechat');
      expect(entry.targetId).toBe(ULID32);
      expect(entry.after.openidMask).toMatch(/^\*\*\*/);
    });
  });

  // ============================================================
  // login - JWT audience (T6a 回归)
  // ============================================================
  describe('audience 切分 (T6a 回归)', () => {
    it('login 产生的 token aud=b-app', async () => {
      phoneLookupSpy.mockResolvedValueOnce({ bUsers: [makeBUser()], parent: null });
      passwordVerifySpy.mockResolvedValueOnce(true);
      const result = await controller.login(buildReqWithMeta(), {
        phone: '13800001111',
        password: 'correct',
      });
      if ('token' in result) {
        const decoded: { aud?: string } = jwt.verify(result.token);
        expect(decoded.aud).toBe('b-app');
      }
    });

    it('wechatLogin 产生的 token aud=parent-app', async () => {
      // 2026-05-23 T2: 用 code 触发 → 走 mock (parentRepoFindByOpenidSpy 默认返启用 parent)
      const result = await controller.wechatLogin(buildReqWithMeta(), {
        code: '0a3xyzAbC1234567890',
      });
      const decoded: { aud?: string } = jwt.verify(result.token);
      expect(decoded.aud).toBe('parent-app');
    });
  });

  // ============================================================
  // logout - JWT 黑名单 + T11 refresh 撤销 (回归)
  // ============================================================
  describe('logout - JWT 黑名单 + T11 refresh 撤销 (回归)', () => {
    const issueToken = async () => {
      phoneLookupSpy.mockResolvedValueOnce({ bUsers: [makeBUser()], parent: null });
      passwordVerifySpy.mockResolvedValueOnce(true);
      const result = await controller.login(buildReqWithMeta(), {
        phone: '13800001111',
        password: 'correct',
      });
      if (!('token' in result)) throw new Error('expected token result');
      return { token: result.token, jti: result.payload.jti! };
    };

    const buildReq = (auth?: string): AuthenticatedRequest =>
      ({ headers: auth ? { authorization: auth } : {} }) as AuthenticatedRequest;

    it('无 Authorization header → 401', async () => {
      await expect(controller.logout(buildReq())).rejects.toThrow(UnauthorizedException);
      expect(redisSetSpy).not.toHaveBeenCalled();
    });

    it('Authorization 格式不对 → 401', async () => {
      await expect(controller.logout(buildReq('NotBearer xxx'))).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('合法 token + jti → 写 Redis 黑名单', async () => {
      const { token, jti } = await issueToken();
      const result = await controller.logout(buildReq(`Bearer ${token}`));
      expect(result).toEqual({ ok: true });
      expect(redisSetSpy).toHaveBeenCalledTimes(1);
      const [key] = redisSetSpy.mock.calls[0];
      expect(key).toBe(`auth:revoked:${jti}`);
    });

    it('Redis fail-open: Redis.set 抛错 → logout 仍返回 ok', async () => {
      redisSetSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const { token } = await issueToken();
      const result = await controller.logout(buildReq(`Bearer ${token}`));
      expect(result).toEqual({ ok: true });
    });

    it('T11: logout body 带 refreshToken → 同时撤销 refresh', async () => {
      const { token } = await issueToken();
      await controller.logout(buildReq(`Bearer ${token}`), {
        refreshToken: 'rt_some_valid_raw_token_xxxxxxxxxxxxxxxx',
      });
      expect(refreshRevokeByRawSpy).toHaveBeenCalledTimes(1);
    });

    it('T11: logout body 不带 refreshToken → 不调用 revokeByRaw', async () => {
      const { token } = await issueToken();
      await controller.logout(buildReq(`Bearer ${token}`));
      expect(refreshRevokeByRawSpy).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // T11 refresh endpoint (回归)
  // ============================================================
  describe('T11 refresh (回归)', () => {
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

    it('happy path B 端', async () => {
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
      expect(result.tokenType).toBe('Bearer');
    });

    it('body.refreshToken 形态错 → 400', async () => {
      await expect(
        controller.refresh(buildReqWithMeta(), { refreshToken: 'short' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // 2026-05-14 wxpay code → openid (回归)
  describe('wxJscode2Session (回归)', () => {
    const VALID_CODE = '0a3xyzAbC1234567890';

    it('happy path: 返 openid (不返 sessionKey)', async () => {
      const result = await controller.wxJscode2Session({ code: VALID_CODE });
      expect(result).toEqual({ openid: 'oTestOpenidExchangedSuccessfully' });
    });

    it('code 缺失 → 400', async () => {
      await expect(
        controller.wxJscode2Session({ code: '' } as never),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
