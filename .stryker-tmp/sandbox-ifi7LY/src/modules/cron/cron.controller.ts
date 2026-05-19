import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CronJobsService } from './cron-jobs.service';
import { Roles } from '../../guards/rbac.decorator';
import { RbacGuard } from '../../guards/rbac.guard';

/**
 * CronController — V20-V23 cron 入口（外部调度器 HTTP 触发）
 *
 * 路径：/api/admin/cron/*  命中 TenantMiddleware admin 白名单（platform_admin 强制）
 *
 * 端点：
 *   POST /admin/cron/expire-promotions          每天 02:00 — committed → expired
 *   POST /admin/cron/expire-pending-referrals   每天 03:00 — created 30天 → expired
 *   POST /admin/cron/expire-free-slots          每天 04:00 — occupied 3月 → expired
 *
 * 调度方式（生产）：
 *   - 当前用 launchd plist / systemd timer 通过 curl 调用
 *   - 长期可改 @Cron decorator（@nestjs/schedule）
 *
 * 安全：必须 platform_admin token + Bearer auth
 */
@Controller('admin/cron')
@UseGuards(RbacGuard)
@Roles('platform_admin')
export class CronController {
  constructor(private readonly cron: CronJobsService) {}

  @Post('expire-promotions')
  @HttpCode(HttpStatus.OK)
  async expirePromotions(): Promise<{ expired: number }> {
    return this.cron.expirePromotions();
  }

  @Post('expire-pending-referrals')
  @HttpCode(HttpStatus.OK)
  async expirePendingReferrals(
    @Body() body: { tenantSchemas: string[] },
  ): Promise<{ expired: number }> {
    if (!Array.isArray(body?.tenantSchemas)) {
      throw new BadRequestException('tenantSchemas array required');
    }
    return this.cron.expirePendingReferrals(body.tenantSchemas);
  }

  @Post('expire-free-slots')
  @HttpCode(HttpStatus.OK)
  async expireFreeSlots(): Promise<{ expired: number }> {
    return this.cron.expireFreeSlots();
  }
}
