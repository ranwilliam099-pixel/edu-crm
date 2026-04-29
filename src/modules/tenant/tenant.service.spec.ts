import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import { TenantService } from './tenant.service';

describe('TenantService', () => {
  let service: TenantService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantService,
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();
    service = module.get<TenantService>(TenantService);
  });

  describe('validateTenantId', () => {
    it('rejects empty', () => {
      expect(() => service.validateTenantId('')).toThrow(BadRequestException);
    });

    it('rejects wrong length', () => {
      expect(() => service.validateTenantId('abc')).toThrow(BadRequestException);
    });

    it('rejects invalid Crockford Base32 chars', () => {
      // 'I' / 'L' / 'O' / 'U' are excluded from Crockford Base32
      expect(() => service.validateTenantId('I'.repeat(32))).toThrow(BadRequestException);
      expect(() => service.validateTenantId('U'.repeat(32))).toThrow(BadRequestException);
    });

    it('accepts valid 32-char Crockford Base32', () => {
      expect(() => service.validateTenantId('01HRX5Y3K2NQVWGT7ABCDEFGHJKMNP00')).not.toThrow();
    });
  });

  describe('schemaName', () => {
    it('lowercases and prefixes with tenant_', () => {
      expect(service.schemaName('01HRX5Y3K2NQVWGT7ABCDEFGHJKMNP00')).toBe(
        'tenant_01hrx5y3k2nqvwgt7abcdefghjkmnp00',
      );
    });
  });

  describe('provisionTenant (placeholder)', () => {
    it('returns schema + tablesPlanned=11 (V2 model)', async () => {
      const result = await service.provisionTenant('01HRX5Y3K2NQVWGT7ABCDEFGHJKMNP00', 'ORDER1');
      expect(result.schema).toBe('tenant_01hrx5y3k2nqvwgt7abcdefghjkmnp00');
      expect(result.tablesPlanned).toBe(11);
    });
  });
});
