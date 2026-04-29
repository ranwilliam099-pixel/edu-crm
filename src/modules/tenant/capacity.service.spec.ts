import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { CapacityService } from './capacity.service';

describe('CapacityService (W1 BE-W1-5)', () => {
  let service: CapacityService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CapacityService],
    }).compile();
    service = module.get<CapacityService>(CapacityService);
  });

  describe('resolveLimits', () => {
    it('returns A07/A08 standard tier (50 accounts, 3 campuses)', () => {
      expect(service.resolveLimits('标准版')).toEqual({ accountLimit: 50, campusLimit: 3 });
    });

    it('returns undefined for 校区版 / 增长版 (waiting D11 batch 2)', () => {
      expect(service.resolveLimits('校区版').accountLimit).toBeUndefined();
      expect(service.resolveLimits('增长版').campusLimit).toBeUndefined();
    });
  });

  describe('guardAccountLimit (A07)', () => {
    it('passes under limit', () => {
      expect(() => service.guardAccountLimit('标准版', 49, 50)).not.toThrow();
    });

    it('rejects at limit', () => {
      expect(() => service.guardAccountLimit('标准版', 50, 50)).toThrow(ForbiddenException);
    });

    it('rejects above limit', () => {
      expect(() => service.guardAccountLimit('标准版', 51, 50)).toThrow(ForbiddenException);
    });

    it('rejects undefined limit (校区版 not yet defined)', () => {
      expect(() => service.guardAccountLimit('校区版', 0, undefined as unknown as number)).toThrow(
        /not yet defined.*D11/,
      );
    });
  });

  describe('guardCampusLimit (A08)', () => {
    it('passes under limit', () => {
      expect(() => service.guardCampusLimit('标准版', 2, 3)).not.toThrow();
    });

    it('rejects at limit (creating 4th campus)', () => {
      expect(() => service.guardCampusLimit('标准版', 3, 3)).toThrow(ForbiddenException);
    });
  });
});
