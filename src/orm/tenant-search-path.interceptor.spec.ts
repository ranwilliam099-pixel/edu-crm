import { TenantSearchPathInterceptor } from './tenant-search-path.interceptor';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of } from 'rxjs';

describe('TenantSearchPathInterceptor (W1 BE-W1-4)', () => {
  let interceptor: TenantSearchPathInterceptor;

  beforeEach(() => {
    interceptor = new TenantSearchPathInterceptor();
  });

  describe('isValidSchemaName (static)', () => {
    it('accepts tenant_<32-char Crockford Base32 lowercase>', () => {
      expect(
        TenantSearchPathInterceptor.isValidSchemaName('tenant_01hrx5y3k2nqvwgt7abcdefghjkmnp00'),
      ).toBe(true);
    });

    it('rejects missing tenant_ prefix', () => {
      expect(
        TenantSearchPathInterceptor.isValidSchemaName('01hrx5y3k2nqvwgt7abcdefghjkmnp00'),
      ).toBe(false);
    });

    it('rejects uppercase chars', () => {
      expect(
        TenantSearchPathInterceptor.isValidSchemaName('tenant_01HRX5Y3K2NQVWGT7ABCDEFGHJKMNP00'),
      ).toBe(false);
    });

    it('rejects wrong length (31 chars after prefix)', () => {
      expect(
        TenantSearchPathInterceptor.isValidSchemaName('tenant_01hrx5y3k2nqvwgt7abcdefghjkmnp0'),
      ).toBe(false);
    });

    it('rejects forbidden Crockford chars (i, l, o, u)', () => {
      // 'l' (lowercase L) is excluded
      expect(
        TenantSearchPathInterceptor.isValidSchemaName('tenant_01hrxly3k2nqvwgt7abcdefghjkmnp00'),
      ).toBe(false);
    });

    it('rejects SQL injection attempt', () => {
      expect(
        TenantSearchPathInterceptor.isValidSchemaName('tenant_a; DROP TABLE tenants; --'),
      ).toBe(false);
    });

    it('rejects empty string', () => {
      expect(TenantSearchPathInterceptor.isValidSchemaName('')).toBe(false);
    });
  });

  describe('intercept', () => {
    function ctx(tenantSchema?: string): ExecutionContext {
      const req = { tenantSchema, path: '/api/leads' };
      return {
        switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
      } as unknown as ExecutionContext;
    }

    const next: CallHandler = { handle: () => of('OK') };

    it('passes through when no tenantSchema (public path)', (done) => {
      const result = interceptor.intercept(ctx(undefined), next);
      result.subscribe({
        next: (v) => expect(v).toBe('OK'),
        complete: done,
      });
    });

    it('passes through with valid tenantSchema (placeholder log only)', (done) => {
      const result = interceptor.intercept(
        ctx('tenant_01hrx5y3k2nqvwgt7abcdefghjkmnp00'),
        next,
      );
      result.subscribe({
        next: (v) => expect(v).toBe('OK'),
        complete: done,
      });
    });

    it('throws on invalid tenantSchema (SQL injection guard)', () => {
      expect(() =>
        interceptor.intercept(ctx('tenant_a; DROP TABLE'), next),
      ).toThrow(/Invalid tenant schema/);
    });
  });
});
