import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';
import { JwtPayload } from './jwt-payload.interface';

const TEST_SECRET = 'test-secret-do-not-use-in-prod';
const ULID_32 = '01HRX5Y3K2NQVWGT7ABCDEFGHJKMNP00';
const ULID_32_B = '01HRX5Y3K2NQVWGT7ABCDEFGHJKMNP01';
const ULID_32_C = '01HRX5Y3K2NQVWGT7ABCDEFGHJKMNP02';

describe('JwtStrategy (W1 BE-W1-3 real)', () => {
  let strategy: JwtStrategy;
  let jwt: JwtService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        JwtModule.register({ secret: TEST_SECRET, signOptions: { expiresIn: '1h' } }),
      ],
      providers: [
        JwtStrategy,
        { provide: ConfigService, useValue: { get: (k: string) => (k === 'JWT_SECRET' ? TEST_SECRET : undefined) } },
      ],
    }).compile();

    strategy = module.get<JwtStrategy>(JwtStrategy);
    jwt = module.get<JwtService>(JwtService);
  });

  describe('parse() — token presence', () => {
    it('rejects empty token', () => {
      expect(() => strategy.parse('')).toThrow(UnauthorizedException);
    });

    it('rejects unsigned / malformed token', () => {
      expect(() => strategy.parse('not-a-jwt')).toThrow(UnauthorizedException);
    });
  });

  describe('parse() — claims validation', () => {
    it('accepts valid tenant-scoped token', () => {
      const payload: JwtPayload = {
        sub: ULID_32,
        tenantId: ULID_32_B,
        role: 'sales',
        campusId: ULID_32_C,
      };
      const token = jwt.sign(payload);
      const result = strategy.parse(token);
      expect(result.sub).toBe(ULID_32);
      expect(result.role).toBe('sales');
    });

    it('rejects tenant-role token without tenantId', () => {
      const token = jwt.sign({ sub: ULID_32, tenantId: null, role: 'sales', campusId: ULID_32_B });
      expect(() => strategy.parse(token)).toThrow(/tenantId/);
    });

    it('rejects single-campus tenant role (sales) without campusId (A08)', () => {
      const token = jwt.sign({ sub: ULID_32, tenantId: ULID_32_B, role: 'sales', campusId: null });
      expect(() => strategy.parse(token)).toThrow(/single-campus.*sales.*campusId/);
    });

    it('rejects boss (校长 / single-campus) without campusId — V10 单校强校验', () => {
      const token = jwt.sign({ sub: ULID_32, tenantId: ULID_32_B, role: 'boss', campusId: null });
      expect(() => strategy.parse(token)).toThrow(/single-campus.*boss.*campusId/);
    });

    it('accepts admin (老板 / cross-campus) with campusId=null — V10 跨校', () => {
      const token = jwt.sign({ sub: ULID_32, tenantId: ULID_32_B, role: 'admin', campusId: null });
      const result = strategy.parse(token);
      expect(result.role).toBe('admin');
      expect(result.campusId).toBeNull();
    });

    it('accepts sales_director (大区经理 / cross-campus) with campusId=null', () => {
      const token = jwt.sign({
        sub: ULID_32,
        tenantId: ULID_32_B,
        role: 'sales_director',
        campusId: null,
      });
      expect(strategy.parse(token).campusId).toBeNull();
    });

    it('accepts hr (cross-campus) with campusId=null', () => {
      const token = jwt.sign({ sub: ULID_32, tenantId: ULID_32_B, role: 'hr', campusId: null });
      expect(strategy.parse(token).campusId).toBeNull();
    });

    it('accepts cross-campus admin with explicit 32-char campusId (主校区视角)', () => {
      const token = jwt.sign({
        sub: ULID_32,
        tenantId: ULID_32_B,
        role: 'admin',
        campusId: ULID_32_C,
      });
      const result = strategy.parse(token);
      expect(result.role).toBe('admin');
      expect(result.campusId).toBe(ULID_32_C);
    });

    it('rejects cross-campus admin with malformed campusId (non-32 length)', () => {
      const token = jwt.sign({
        sub: ULID_32,
        tenantId: ULID_32_B,
        role: 'admin',
        campusId: 'too-short',
      });
      expect(() => strategy.parse(token)).toThrow(/cross-campus.*null.*32/);
    });

    it('accepts platform_admin with tenantId=null (A11)', () => {
      const token = jwt.sign({ sub: ULID_32, tenantId: null, role: 'platform_admin', campusId: null });
      const result = strategy.parse(token);
      expect(result.role).toBe('platform_admin');
    });

    it('rejects platform_admin with non-null tenantId', () => {
      const token = jwt.sign({
        sub: ULID_32,
        tenantId: ULID_32_B,
        role: 'platform_admin',
        campusId: null,
      });
      expect(() => strategy.parse(token)).toThrow(/platform.*tenantId=null/);
    });

    it('rejects sub with wrong length', () => {
      const token = jwt.sign({ sub: 'short', tenantId: ULID_32, role: 'sales', campusId: ULID_32_B });
      expect(() => strategy.parse(token)).toThrow(/sub.*ULID/);
    });

    // Sprint B (2026-05-11) — TenantRole 加 teacher / academic / academic_admin
    //   - 三者均为 single-campus role：campusId 必填 32-char ULID
    //   - 与 boss / sales 等同分支处理（默认 fall-through 到 single-campus 校验）
    it('accepts teacher (single-campus) with valid campusId — Sprint B', () => {
      const token = jwt.sign({
        sub: ULID_32,
        tenantId: ULID_32_B,
        role: 'teacher',
        campusId: ULID_32_C,
      });
      const result = strategy.parse(token);
      expect(result.role).toBe('teacher');
      expect(result.campusId).toBe(ULID_32_C);
    });

    it('rejects teacher (single-campus) without campusId — Sprint B', () => {
      const token = jwt.sign({ sub: ULID_32, tenantId: ULID_32_B, role: 'teacher', campusId: null });
      expect(() => strategy.parse(token)).toThrow(/single-campus.*teacher.*campusId/);
    });

    it('accepts academic (single-campus 普通教务) with valid campusId — Sprint B', () => {
      const token = jwt.sign({
        sub: ULID_32,
        tenantId: ULID_32_B,
        role: 'academic',
        campusId: ULID_32_C,
      });
      expect(strategy.parse(token).role).toBe('academic');
    });

    it('rejects academic without campusId — Sprint B', () => {
      const token = jwt.sign({ sub: ULID_32, tenantId: ULID_32_B, role: 'academic', campusId: null });
      expect(() => strategy.parse(token)).toThrow(/single-campus.*academic.*campusId/);
    });

    it('accepts academic_admin (教务主管) with valid campusId — Sprint B', () => {
      const token = jwt.sign({
        sub: ULID_32,
        tenantId: ULID_32_B,
        role: 'academic_admin',
        campusId: ULID_32_C,
      });
      expect(strategy.parse(token).role).toBe('academic_admin');
    });

    it('rejects academic_admin without campusId — Sprint B', () => {
      const token = jwt.sign({
        sub: ULID_32,
        tenantId: ULID_32_B,
        role: 'academic_admin',
        campusId: null,
      });
      expect(() => strategy.parse(token)).toThrow(/single-campus.*academic_admin.*campusId/);
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
      expect(() => strategy.parse(expiredToken)).toThrow(/expired/i);
    });
  });
});
