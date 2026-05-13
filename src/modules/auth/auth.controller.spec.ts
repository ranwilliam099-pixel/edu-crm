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

const ULID32 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMN01';
const ULID32_T = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNTN';
const ULID32_C = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNCM';

describe('AuthController - 登录接口 + Sprint E.1 logout', () => {
  let controller: AuthController;
  let jwt: JwtService;
  let redisSetSpy: jest.Mock<Promise<void>, [string, string, number?]>;

  beforeEach(async () => {
    redisSetSpy = jest.fn().mockResolvedValue(undefined);
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
      ],
    }).compile();
    controller = module.get<AuthController>(AuthController);
    jwt = module.get<JwtService>(JwtService);
  });

  describe('login - B 端员工登录', () => {
    it('合法登录 → 返回 JWT', () => {
      const result = controller.login({
        phone: '13800001111',
        tenantId: ULID32_T,
        role: 'sales',
        campusId: ULID32_C,
        userId: ULID32,
      });
      expect(result.token).toBeTruthy();
      expect(result.tokenType).toBe('Bearer');
      expect(result.payload.role).toBe('sales');
    });

    it('phone 非法 → BadRequestException', () => {
      expect(() =>
        controller.login({
          phone: '12345',
          tenantId: ULID32_T,
          role: 'sales',
          campusId: ULID32_C,
          userId: ULID32,
        }),
      ).toThrow(BadRequestException);
    });

    it('userId 长度非 32 → BadRequestException', () => {
      expect(() =>
        controller.login({
          phone: '13800001111',
          tenantId: ULID32_T,
          role: 'sales',
          campusId: ULID32_C,
          userId: 'short',
        }),
      ).toThrow(BadRequestException);
    });

    it('未知 role → BadRequestException', () => {
      expect(() =>
        controller.login({
          phone: '13800001111',
          tenantId: ULID32_T,
          role: 'unknown',
          campusId: ULID32_C,
          userId: ULID32,
        }),
      ).toThrow(BadRequestException);
    });

    it('admin (跨校 / 老板) 不传 campusId → 接受，payload.campusId=null', () => {
      const result = controller.login({
        phone: '13800001111',
        tenantId: ULID32_T,
        role: 'admin',
        userId: ULID32,
      });
      expect(result.payload.campusId).toBeNull();
      expect(result.payload.role).toBe('admin');
    });

    it('admin 显式给 32 字符 campusId（主校区视角）→ 接受', () => {
      const result = controller.login({
        phone: '13800001111',
        tenantId: ULID32_T,
        role: 'admin',
        campusId: ULID32_C,
        userId: ULID32,
      });
      expect(result.payload.campusId).toBe(ULID32_C);
    });

    it('admin 给非 32 字符 campusId → BadRequestException', () => {
      expect(() =>
        controller.login({
          phone: '13800001111',
          tenantId: ULID32_T,
          role: 'admin',
          campusId: 'short',
          userId: ULID32,
        }),
      ).toThrow(/cross-campus.*null.*32-char/);
    });

    it('sales_director (跨校 / 大区经理) 不传 campusId → 接受', () => {
      const result = controller.login({
        phone: '13800001111',
        tenantId: ULID32_T,
        role: 'sales_director',
        userId: ULID32,
      });
      expect(result.payload.campusId).toBeNull();
    });

    it('hr (跨校) 不传 campusId → 接受', () => {
      const result = controller.login({
        phone: '13800001111',
        tenantId: ULID32_T,
        role: 'hr',
        userId: ULID32,
      });
      expect(result.payload.campusId).toBeNull();
    });

    it('boss (单校 / 校长) 不传 campusId → BadRequestException — V10 单校强校验', () => {
      expect(() =>
        controller.login({
          phone: '13800001111',
          tenantId: ULID32_T,
          role: 'boss',
          userId: ULID32,
        }),
      ).toThrow(/single-campus.*boss.*32-char campusId/);
    });

    it('boss 给非 32 字符 campusId → BadRequestException', () => {
      expect(() =>
        controller.login({
          phone: '13800001111',
          tenantId: ULID32_T,
          role: 'boss',
          campusId: 'short',
          userId: ULID32,
        }),
      ).toThrow(/single-campus.*boss/);
    });

    it('sales (单校) 不传 campusId → BadRequestException', () => {
      expect(() =>
        controller.login({
          phone: '13800001111',
          tenantId: ULID32_T,
          role: 'sales',
          userId: ULID32,
        }),
      ).toThrow(/single-campus.*sales/);
    });

    it('marketing (单校) 不传 campusId → BadRequestException', () => {
      expect(() =>
        controller.login({
          phone: '13800001111',
          tenantId: ULID32_T,
          role: 'marketing',
          userId: ULID32,
        }),
      ).toThrow(/single-campus.*marketing/);
    });

    it('finance (单校) 不传 campusId → BadRequestException', () => {
      expect(() =>
        controller.login({
          phone: '13800001111',
          tenantId: ULID32_T,
          role: 'finance',
          userId: ULID32,
        }),
      ).toThrow(/single-campus.*finance/);
    });

    // Sprint B (2026-05-11) — TenantRole 加 teacher / academic / academic_admin
    it('teacher (单校) 合法登录 → 返回 JWT — Sprint B', () => {
      const result = controller.login({
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

    it('teacher (单校) 不传 campusId → BadRequestException — Sprint B', () => {
      expect(() =>
        controller.login({
          phone: '13800001111',
          tenantId: ULID32_T,
          role: 'teacher',
          userId: ULID32,
        }),
      ).toThrow(/single-campus.*teacher/);
    });

    it('academic (单校 普通教务) 合法登录 → 返回 JWT — Sprint B', () => {
      const result = controller.login({
        phone: '13800001111',
        tenantId: ULID32_T,
        role: 'academic',
        campusId: ULID32_C,
        userId: ULID32,
      });
      expect(result.payload.role).toBe('academic');
    });

    it('academic_admin (单校 教务主管) 合法登录 → 返回 JWT — Sprint B', () => {
      const result = controller.login({
        phone: '13800001111',
        tenantId: ULID32_T,
        role: 'academic_admin',
        campusId: ULID32_C,
        userId: ULID32,
      });
      expect(result.payload.role).toBe('academic_admin');
    });

    it('academic 不传 campusId → BadRequestException — Sprint B', () => {
      expect(() =>
        controller.login({
          phone: '13800001111',
          tenantId: ULID32_T,
          role: 'academic',
          userId: ULID32,
        }),
      ).toThrow(/single-campus.*academic/);
    });
  });

  describe('wechatLogin - C 端家长微信登录', () => {
    it('合法登录 → 返回 ParentJwt', () => {
      const result = controller.wechatLogin({
        parentId: ULID32,
        openid: 'oWxXXX',
      });
      expect(result.token).toBeTruthy();
      expect(result.payload.type).toBe('parent');
      expect(result.payload.parentId).toBe(ULID32);
    });

    it('parentId 长度非 32 → BadRequestException', () => {
      expect(() =>
        controller.wechatLogin({ parentId: 'short' }),
      ).toThrow(BadRequestException);
    });
  });

  // ============================================================
  // Sprint E.1 (2026-05-13) — login 含 jti claim（JWT 黑名单基础）
  // ============================================================
  describe('login - jti claim (Sprint E.1)', () => {
    it('login 返回的 payload 含 jti（26-char ULID）', () => {
      const result = controller.login({
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

    it('login 返回的 token decode 后含 jti 等于 payload.jti', () => {
      const result = controller.login({
        phone: '13800001111',
        tenantId: ULID32_T,
        role: 'sales',
        campusId: ULID32_C,
        userId: ULID32,
      });
      const decoded = jwt.decode(result.token) as { jti?: string };
      expect(decoded.jti).toBe(result.payload.jti);
    });

    it('两次连续 login → 两个不同 jti（唯一性）', () => {
      const r1 = controller.login({
        phone: '13800001111',
        tenantId: ULID32_T,
        role: 'sales',
        campusId: ULID32_C,
        userId: ULID32,
      });
      const r2 = controller.login({
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
  describe('logout - JWT 黑名单（Sprint E.1）', () => {
    /** 构造一个带 jti 的真实 token（用 controller.login） */
    const issueToken = () => {
      const result = controller.login({
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
      const { token, jti } = issueToken();
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
      const { token } = issueToken();
      const result = await controller.logout(buildReq(`Bearer ${token}`));
      expect(result).toEqual({ ok: true });
      expect(redisSetSpy).toHaveBeenCalledTimes(1);
    });
  });
});
