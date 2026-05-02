/**
 * ParentJwtStrategy 单测 — V10 BE-V10-3
 */
import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { ParentJwtStrategy } from './parent-jwt.strategy';

const ULID32_P1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMPR1';

describe('ParentJwtStrategy - V10 BE-V10-3', () => {
  let strategy: ParentJwtStrategy;
  let jwtService: JwtService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: 'test-secret-for-parent' })],
      providers: [
        ParentJwtStrategy,
        {
          provide: ConfigService,
          useValue: { get: (k: string) => (k === 'JWT_SECRET' ? 'test-secret-for-parent' : undefined) },
        },
      ],
    }).compile();
    strategy = module.get<ParentJwtStrategy>(ParentJwtStrategy);
    jwtService = module.get<JwtService>(JwtService);
  });

  describe('sign / parse 闭环', () => {
    it('合法 sign + parse → 取回 parentId / openid / type', () => {
      const token = strategy.sign({ parentId: ULID32_P1, openid: 'oWxXX' });
      const payload = strategy.parse(token);
      expect(payload.parentId).toBe(ULID32_P1);
      expect(payload.openid).toBe('oWxXX');
      expect(payload.type).toBe('parent');
    });

    it('sign parentId 长度非 32 → UnauthorizedException', () => {
      expect(() => strategy.sign({ parentId: 'short' })).toThrow(UnauthorizedException);
    });
  });

  describe('parse - 错误处理', () => {
    it('空 token → UnauthorizedException(Missing parent token)', () => {
      expect(() => strategy.parse('')).toThrow(UnauthorizedException);
    });

    it('过期 token → UnauthorizedException', () => {
      const expired = jwtService.sign(
        { parentId: ULID32_P1, type: 'parent' },
        { secret: 'test-secret-for-parent', expiresIn: '0s' },
      );
      // 等 1ms 让 token 过期
      const verify = () => strategy.parse(expired);
      // 直接 parse 时会抛 TokenExpiredError → UnauthorizedException
      try {
        verify();
        fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(UnauthorizedException);
      }
    });

    it('错签名 token → UnauthorizedException(invalid signature)', () => {
      const bogus = 'eyJhbGciOiJIUzI1NiJ9.eyJ4eHgiOjF9.invalid';
      expect(() => strategy.parse(bogus)).toThrow(UnauthorizedException);
    });

    it('B 端 token（type≠parent）→ UnauthorizedException(type mismatch)', () => {
      const bToken = jwtService.sign(
        { sub: ULID32_P1, tenantId: '01HX7Y6P5K9N3M2QABCDEFGHIJKLMTNT', role: 'sales' },
        { secret: 'test-secret-for-parent' },
      );
      expect(() => strategy.parse(bToken)).toThrow(UnauthorizedException);
    });

    it('parent token 缺 parentId → UnauthorizedException', () => {
      const tok = jwtService.sign(
        { type: 'parent' }, // 无 parentId
        { secret: 'test-secret-for-parent' },
      );
      expect(() => strategy.parse(tok)).toThrow(UnauthorizedException);
    });
  });
});
