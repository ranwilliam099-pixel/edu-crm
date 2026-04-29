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

    it('rejects tenant-role token without campusId (A08)', () => {
      const token = jwt.sign({ sub: ULID_32, tenantId: ULID_32_B, role: 'sales', campusId: null });
      expect(() => strategy.parse(token)).toThrow(/campusId.*A08/);
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
