import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';
import { JwtPayload } from './jwt-payload.interface';
import { RedisService } from '../redis/redis.service';

const TEST_SECRET = 'test-secret-do-not-use-in-prod';
const ULID_32 = '01HRX5Y3K2NQVWGT7ABCDEFGHJKMNP00';
const ULID_32_B = '01HRX5Y3K2NQVWGT7ABCDEFGHJKMNP01';
const ULID_32_C = '01HRX5Y3K2NQVWGT7ABCDEFGHJKMNP02';

/**
 * SPRINT-E.1(2026-05-13): parse() 由 sync → async
 *   - 现有同步 .toThrow 全部改为 await expect(...).rejects.toThrow
 *   - 现有同步 .sub / .role / .campusId 改为 await result + 解构
 *   - 新增 jti 黑名单 mock 用例（RedisService.get 返 '1' → TOKEN_REVOKED）
 */
describe('JwtStrategy (W1 BE-W1-3 real + Sprint E.1 async + jti blacklist)', () => {
  let strategy: JwtStrategy;
  let jwt: JwtService;
  let redisGetSpy: jest.Mock<Promise<string | null>, [string]>;

  beforeEach(async () => {
    redisGetSpy = jest.fn().mockResolvedValue(null);
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        JwtModule.register({ secret: TEST_SECRET, signOptions: { expiresIn: '1h' } }),
      ],
      providers: [
        JwtStrategy,
        { provide: ConfigService, useValue: { get: (k: string) => (k === 'JWT_SECRET' ? TEST_SECRET : undefined) } },
        { provide: RedisService, useValue: { get: redisGetSpy } },
      ],
    }).compile();

    strategy = module.get<JwtStrategy>(JwtStrategy);
    jwt = module.get<JwtService>(JwtService);
  });

  describe('parse() — token presence', () => {
    it('rejects empty token', async () => {
      await expect(strategy.parse('')).rejects.toThrow(UnauthorizedException);
    });

    it('rejects unsigned / malformed token', async () => {
      await expect(strategy.parse('not-a-jwt')).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('parse() — claims validation', () => {
    it('accepts valid tenant-scoped token', async () => {
      const payload: JwtPayload = {
        sub: ULID_32,
        tenantId: ULID_32_B,
        role: 'sales',
        campusId: ULID_32_C,
      };
      const token = jwt.sign(payload);
      const result = await strategy.parse(token);
      expect(result.sub).toBe(ULID_32);
      expect(result.role).toBe('sales');
    });

    it('rejects tenant-role token without tenantId', async () => {
      const token = jwt.sign({ sub: ULID_32, tenantId: null, role: 'sales', campusId: ULID_32_B });
      await expect(strategy.parse(token)).rejects.toThrow(/tenantId/);
    });

    it('rejects single-campus tenant role (sales) without campusId (A08)', async () => {
      const token = jwt.sign({ sub: ULID_32, tenantId: ULID_32_B, role: 'sales', campusId: null });
      await expect(strategy.parse(token)).rejects.toThrow(/single-campus.*sales.*campusId/);
    });

    it('rejects boss (校长 / single-campus) without campusId — V10 单校强校验', async () => {
      const token = jwt.sign({ sub: ULID_32, tenantId: ULID_32_B, role: 'boss', campusId: null });
      await expect(strategy.parse(token)).rejects.toThrow(/single-campus.*boss.*campusId/);
    });

    it('accepts admin (老板 / cross-campus) with campusId=null — V10 跨校', async () => {
      const token = jwt.sign({ sub: ULID_32, tenantId: ULID_32_B, role: 'admin', campusId: null });
      const result = await strategy.parse(token);
      expect(result.role).toBe('admin');
      expect(result.campusId).toBeNull();
    });

    // 5/15 A-2：sales_director 应用层已删（jwt.strategy CROSS_CAMPUS_ROLES 删此值）
    //   - 旧 token 签发 role='sales_director' + campusId=null：
    //     parse 时 isCrossCampusRole('sales_director') === false（不在 CROSS_CAMPUS_ROLES 列表）
    //     → 走 single-campus 分支 → campusId=null 抛 single-campus.*sales_director.*campusId
    //   - 验证拒绝路径生效（5/15 A-2 红线 — 历史 sales_director token 不再被识别为跨校）
    it('rejects sales_director (legacy 5/15 A-2 已删) with campusId=null — 不再识别跨校', async () => {
      const token = jwt.sign({
        sub: ULID_32,
        tenantId: ULID_32_B,
        role: 'sales_director', // 历史 schema 允许，但应用层 jwt parse 不再识别
        campusId: null,
      });
      await expect(strategy.parse(token)).rejects.toThrow(/single-campus.*sales_director.*campusId/);
    });

    it('accepts hr (cross-campus) with campusId=null', async () => {
      const token = jwt.sign({ sub: ULID_32, tenantId: ULID_32_B, role: 'hr', campusId: null });
      const result = await strategy.parse(token);
      expect(result.campusId).toBeNull();
    });

    it('accepts cross-campus admin with explicit 32-char campusId (主校区视角)', async () => {
      const token = jwt.sign({
        sub: ULID_32,
        tenantId: ULID_32_B,
        role: 'admin',
        campusId: ULID_32_C,
      });
      const result = await strategy.parse(token);
      expect(result.role).toBe('admin');
      expect(result.campusId).toBe(ULID_32_C);
    });

    it('rejects cross-campus admin with malformed campusId (non-32 length)', async () => {
      const token = jwt.sign({
        sub: ULID_32,
        tenantId: ULID_32_B,
        role: 'admin',
        campusId: 'too-short',
      });
      await expect(strategy.parse(token)).rejects.toThrow(/cross-campus.*null.*32/);
    });

    it('accepts platform_admin with tenantId=null (A11)', async () => {
      const token = jwt.sign({ sub: ULID_32, tenantId: null, role: 'platform_admin', campusId: null });
      const result = await strategy.parse(token);
      expect(result.role).toBe('platform_admin');
    });

    it('rejects platform_admin with non-null tenantId', async () => {
      const token = jwt.sign({
        sub: ULID_32,
        tenantId: ULID_32_B,
        role: 'platform_admin',
        campusId: null,
      });
      await expect(strategy.parse(token)).rejects.toThrow(/platform.*tenantId=null/);
    });

    it('rejects sub with wrong length', async () => {
      const token = jwt.sign({ sub: 'short', tenantId: ULID_32, role: 'sales', campusId: ULID_32_B });
      await expect(strategy.parse(token)).rejects.toThrow(/sub.*ULID/);
    });

    // Sprint B (2026-05-11) — TenantRole 加 teacher / academic / academic_admin
    //   - 三者均为 single-campus role：campusId 必填 32-char ULID
    //   - 与 boss / sales 等同分支处理（默认 fall-through 到 single-campus 校验）
    it('accepts teacher (single-campus) with valid campusId — Sprint B', async () => {
      const token = jwt.sign({
        sub: ULID_32,
        tenantId: ULID_32_B,
        role: 'teacher',
        campusId: ULID_32_C,
      });
      const result = await strategy.parse(token);
      expect(result.role).toBe('teacher');
      expect(result.campusId).toBe(ULID_32_C);
    });

    it('rejects teacher (single-campus) without campusId — Sprint B', async () => {
      const token = jwt.sign({ sub: ULID_32, tenantId: ULID_32_B, role: 'teacher', campusId: null });
      await expect(strategy.parse(token)).rejects.toThrow(/single-campus.*teacher.*campusId/);
    });

    it('accepts academic (single-campus 普通教务) with valid campusId — Sprint B', async () => {
      const token = jwt.sign({
        sub: ULID_32,
        tenantId: ULID_32_B,
        role: 'academic',
        campusId: ULID_32_C,
      });
      const result = await strategy.parse(token);
      expect(result.role).toBe('academic');
    });

    it('rejects academic without campusId — Sprint B', async () => {
      const token = jwt.sign({ sub: ULID_32, tenantId: ULID_32_B, role: 'academic', campusId: null });
      await expect(strategy.parse(token)).rejects.toThrow(/single-campus.*academic.*campusId/);
    });

    it('accepts academic_admin (教务主管) with valid campusId — Sprint B', async () => {
      const token = jwt.sign({
        sub: ULID_32,
        tenantId: ULID_32_B,
        role: 'academic_admin',
        campusId: ULID_32_C,
      });
      const result = await strategy.parse(token);
      expect(result.role).toBe('academic_admin');
    });

    it('rejects academic_admin without campusId — Sprint B', async () => {
      const token = jwt.sign({
        sub: ULID_32,
        tenantId: ULID_32_B,
        role: 'academic_admin',
        campusId: null,
      });
      await expect(strategy.parse(token)).rejects.toThrow(/single-campus.*academic_admin.*campusId/);
    });
  });

  describe('parse() — expiration', () => {
    it('rejects expired token', async () => {
      const expiredToken = jwt.sign(
        { sub: ULID_32, tenantId: ULID_32_B, role: 'sales', campusId: ULID_32_C },
        { expiresIn: '1ms' },
      );
      // wait past expiration
      await new Promise((r) => setTimeout(r, 50));
      await expect(strategy.parse(expiredToken)).rejects.toThrow(/expired/i);
    });
  });

  // ============================================================
  // SPRINT-E.1(2026-05-13) JWT 黑名单 — Redis auth:revoked:{jti} 查询
  // ============================================================
  describe('parse() — jti blacklist (Sprint E.1)', () => {
    it('accepts token with no jti claim (legacy token, skip blacklist)', async () => {
      const token = jwt.sign({
        sub: ULID_32,
        tenantId: ULID_32_B,
        role: 'sales',
        campusId: ULID_32_C,
      });
      const result = await strategy.parse(token);
      expect(result.sub).toBe(ULID_32);
      // 旧 token 无 jti → 不查 Redis
      expect(redisGetSpy).not.toHaveBeenCalled();
    });

    it('accepts token with jti when Redis says NOT revoked', async () => {
      redisGetSpy.mockResolvedValueOnce(null);
      const token = jwt.sign(
        { sub: ULID_32, tenantId: ULID_32_B, role: 'sales', campusId: ULID_32_C },
        { jwtid: 'jti-active' },
      );
      const result = await strategy.parse(token);
      expect(result.sub).toBe(ULID_32);
      expect(redisGetSpy).toHaveBeenCalledWith('auth:revoked:jti-active');
    });

    it('rejects token with jti when Redis says REVOKED (logout case)', async () => {
      redisGetSpy.mockResolvedValueOnce('1');
      const token = jwt.sign(
        { sub: ULID_32, tenantId: ULID_32_B, role: 'sales', campusId: ULID_32_C },
        { jwtid: 'jti-revoked' },
      );
      await expect(strategy.parse(token)).rejects.toThrow(/TOKEN_REVOKED/);
      expect(redisGetSpy).toHaveBeenCalledWith('auth:revoked:jti-revoked');
    });

    it('fail-open: accepts token if Redis throws (Redis down)', async () => {
      redisGetSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const token = jwt.sign(
        { sub: ULID_32, tenantId: ULID_32_B, role: 'sales', campusId: ULID_32_C },
        { jwtid: 'jti-redis-down' },
      );
      const result = await strategy.parse(token);
      expect(result.sub).toBe(ULID_32);
      // Redis 异常 → fail-open，token 仍通过（不阻塞用户）
    });
  });

  // ============================================================
  // SPRINT-E.1(2026-05-13) Redis 未注入（@Optional fallback）
  // ============================================================
  describe('parse() — Redis @Optional fallback', () => {
    it('parse works without RedisService (legacy DI)', async () => {
      const legacyModule: TestingModule = await Test.createTestingModule({
        imports: [
          JwtModule.register({ secret: TEST_SECRET, signOptions: { expiresIn: '1h' } }),
        ],
        providers: [
          JwtStrategy,
          { provide: ConfigService, useValue: { get: (k: string) => (k === 'JWT_SECRET' ? TEST_SECRET : undefined) } },
          // 不注入 RedisService
        ],
      }).compile();
      const legacyStrategy = legacyModule.get<JwtStrategy>(JwtStrategy);
      const legacyJwt = legacyModule.get<JwtService>(JwtService);
      const token = legacyJwt.sign(
        { sub: ULID_32, tenantId: ULID_32_B, role: 'sales', campusId: ULID_32_C },
        { jwtid: 'jti-no-redis' },
      );
      const result = await legacyStrategy.parse(token);
      expect(result.sub).toBe(ULID_32);
    });
  });
});
