import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  describe('check()', () => {
    it('returns ok=true', () => {
      const result = controller.check();
      expect(result.ok).toBe(true);
    });

    it('returns version=v1', () => {
      const result = controller.check();
      expect(result.version).toBe('v1');
    });

    it('returns ISO-8601 timestamp', () => {
      const result = controller.check();
      expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('timestamp is fresh (within 1s of now)', () => {
      const before = Date.now();
      const result = controller.check();
      const after = Date.now();
      const tsMs = new Date(result.timestamp).getTime();
      expect(tsMs).toBeGreaterThanOrEqual(before);
      expect(tsMs).toBeLessThanOrEqual(after);
    });

    it('matches FE-SANDBOX-04 expected schema (ok|version|timestamp)', () => {
      const result = controller.check();
      expect(Object.keys(result).sort()).toEqual(['ok', 'timestamp', 'version']);
    });
  });
});
