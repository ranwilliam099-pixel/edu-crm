import { Controller, Get } from '@nestjs/common';

/**
 * BE-W0-6 健康检查接口
 * GET /api/public/health
 * 验收标准：返回 200 + { ok: true, version: 'v1' }
 */
@Controller('public/health')
export class HealthController {
  @Get()
  check(): { ok: true; version: string; timestamp: string } {
    return {
      ok: true,
      version: 'v1',
      timestamp: new Date().toISOString(),
    };
  }
}
