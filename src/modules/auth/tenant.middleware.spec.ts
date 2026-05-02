import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import { TenantMiddleware } from './tenant.middleware';
import { JwtStrategy } from './jwt.strategy';
import { ParentJwtStrategy } from './parent-jwt.strategy';

const TEST_SECRET = 'test-secret';

describe('TenantMiddleware (W1 BE-W1-4 routing分发)', () => {
  let middleware: TenantMiddleware;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: TEST_SECRET })],
      providers: [
        TenantMiddleware,
        JwtStrategy,
        ParentJwtStrategy,
        { provide: ConfigService, useValue: { get: (k: string) => (k === 'JWT_SECRET' ? TEST_SECRET : undefined) } },
      ],
    }).compile();
    middleware = module.get<TenantMiddleware>(TenantMiddleware);
  });

  function makeReq(originalUrl: string, headers: Record<string, string> = {}): any {
    return { originalUrl, url: originalUrl, path: originalUrl, headers };
  }

  describe('public path resolution (regression: 实测 2026-04-30 401 缺陷)', () => {
    it('passes /api/public/health without Authorization', (done) => {
      const req = makeReq('/api/public/health');
      middleware.use(req, {} as any, () => done());
    });

    it('passes /api/public/health?ts=1 (strips query string)', (done) => {
      const req = makeReq('/api/public/health?ts=1');
      middleware.use(req, {} as any, () => done());
    });

    it('passes /api/checkout/anything without Authorization', (done) => {
      const req = makeReq('/api/checkout/orders');
      middleware.use(req, {} as any, () => done());
    });
  });

  describe('admin path enforcement', () => {
    it('rejects /api/admin/* without Authorization', () => {
      const req = makeReq('/api/admin/tenants');
      expect(() => middleware.use(req, {} as any, () => {})).toThrow(UnauthorizedException);
    });
  });

  describe('default path (business)', () => {
    it('rejects /api/leads without Authorization', () => {
      const req = makeReq('/api/leads');
      expect(() => middleware.use(req, {} as any, () => {})).toThrow(UnauthorizedException);
    });
  });
});
