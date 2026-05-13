import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Get,
  Delete,
  Param,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { TenantProvisionService } from './tenant-provision.service';
import { PgPoolService } from './pg-pool.service';
import { SecurityService } from '../security/security.service';

// F-08 round 2 (business validator P1 + security validator P2) 2026-05-13:
//   campuses 数组长度 + content 字段长度上限 — 防 DoS amplification 攻击微信 access_token QPS
const MAX_CAMPUSES = 20;
const MAX_TEXT_LEN = 2000; // 微信 msg_sec_check v1 限制 2500 字，留 500 字 buffer

/**
 * OnboardingController — 租户开通 + DB 健康检查（公开路径，无需 token）
 *
 * 路由前缀：/api/public/onboarding 和 /api/public/db
 *
 * 用户 2026-05-02「做啊」触发：
 *   - 让 mock 后端真接 PG，打通"机构开通 → 真存盘"完整链路
 *
 * SPRINT-E.x F-08 (2026-05-13): provisionTenant 接入 server-side msgSecCheck（v1 免 openid）
 *   - 前端 wizard.js 12+ 自由文本输入点 0 msgSecCheck 覆盖（无 openid，公开页 skipAuth）
 *   - 后端拦截：机构名 / 校区名 / 校区地址 / 课程线
 *   - fail-open：微信侧故障返 review 不阻塞注册；明确 87014 才拦 400
 */
@Controller('public')
export class OnboardingController {
  private readonly logger = new Logger(OnboardingController.name);

  constructor(
    private readonly provision: TenantProvisionService,
    private readonly pg: PgPoolService,
    private readonly security: SecurityService,
  ) {}

  /**
   * GET /api/public/db/ping — 数据库健康检查
   */
  @Get('db/ping')
  @HttpCode(HttpStatus.OK)
  async dbPing(): Promise<{ ok: boolean; database: string; ts: string }> {
    const ok = await this.pg.ping();
    return { ok, database: 'edu', ts: new Date().toISOString() };
  }

  /**
   * POST /api/public/onboarding/provision-tenant
   *
   * 一键开通租户：建 schema + 跑 11 个 migration + INSERT public.tenants
   *
   * Body: { tenantId, name, sku }
   */
  @Post('onboarding/provision-tenant')
  @HttpCode(HttpStatus.CREATED)
  // F-08 round 2 (business validator P1) 2026-05-13:
  //   公开 endpoint 默认 60/min throttle 过宽 — 攻击者可放大微信 access_token QPS
  //   注册场景 5/min/IP 足够（人工 1-2 次试错），收紧防 DoS amplification
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async provisionTenant(
    @Body()
    body: {
      tenantId: string;
      name: string;
      sku: 'trial' | 'standard_1999' | 'school_pro' | 'growth';
      // V29 R5 多校区开通（OOUX：Tenant 1:N Campus）
      campuses?: Array<{
        id: string;
        name: string;
        address?: string;
        courseLines?: string;
      }>;
    },
  ): Promise<{
    tenantId: string;
    tenantSchema: string;
    ranMigrations: string[];
    campusIds?: string[];
  }> {
    // F-08 round 2 (business + security validator P2) 2026-05-13:
    //   campuses 数组上限 20 — 防恶意请求 N 个 campus 放大微信 API 调用 (1 + N*3 次)
    if (Array.isArray(body?.campuses) && body.campuses.length > MAX_CAMPUSES) {
      throw new BadRequestException({
        code: 'TOO_MANY_CAMPUSES',
        message: `校区数量超出上限（${MAX_CAMPUSES}）`,
      });
    }

    // SPRINT-E.x F-08 (2026-05-13): server-side msgSecCheck（v1 免 openid）
    //   - 收集所有自由文本字段（机构名 / 校区名 / 校区地址 / 课程线）
    //   - 逐个调微信 v1 msg_sec_check
    //   - 命中违规 87014 → 400 CONTENT_RISKY（不返 errcode 给 client，A05 内部 ID 暴露规避）
    //   - review / 网络异常 → 视为通过（fail-open，不阻塞用户注册）
    //
    // F-08 round 2 (security validator P2-content maxLength) 2026-05-13:
    //   各字段 trim 后超长截断 MAX_TEXT_LEN (2000 字)，防超长 content 被微信侧拒后走 fail-open
    //   实际放行；同时减少微信 API 单次请求带宽
    const truncate = (s: string) => (s.length > MAX_TEXT_LEN ? s.slice(0, MAX_TEXT_LEN) : s);
    const textFieldsToCheck: string[] = [];
    if (body?.name && typeof body.name === 'string' && body.name.trim().length > 0) {
      textFieldsToCheck.push(truncate(body.name.trim()));
    }
    if (Array.isArray(body?.campuses)) {
      for (const c of body.campuses) {
        if (c?.name && typeof c.name === 'string' && c.name.trim().length > 0) {
          textFieldsToCheck.push(truncate(c.name.trim()));
        }
        if (c?.address && typeof c.address === 'string' && c.address.trim().length > 0) {
          textFieldsToCheck.push(truncate(c.address.trim()));
        }
        if (
          c?.courseLines &&
          typeof c.courseLines === 'string' &&
          c.courseLines.trim().length > 0
        ) {
          textFieldsToCheck.push(truncate(c.courseLines.trim()));
        }
      }
    }

    for (const text of textFieldsToCheck) {
      let result: Awaited<ReturnType<SecurityService['serverSideCheckContent']>>;
      try {
        result = await this.security.serverSideCheckContent(text);
      } catch (err) {
        // 微信 access_token 失败（network / errcode）→ fail-open，让 onboarding 继续
        //   理由：注册阻塞 = 用户体验灾难；违规内容仍可通过 audit_log 事后追溯
        this.logger.warn(
          `provisionTenant security check 失败 fail-open: ${(err as Error).message}`,
        );
        continue;
      }
      if (result.ok === false && result.suggest === 'risky') {
        this.logger.warn(
          `provisionTenant content blocked: label=${String(result.label)} errcode=${result.errcode}`,
        );
        throw new BadRequestException({
          code: 'CONTENT_RISKY',
          message: '机构信息含违规内容，请修改后重试',
          suggest: 'risky',
        });
      }
      // suggest='review' / 'pass' / undefined 视为通过（fail-open）
    }

    return this.provision.provisionTenant(body);
  }

  /**
   * GET /api/public/onboarding/tenants — 列出已开通租户
   */
  @Get('onboarding/tenants')
  @HttpCode(HttpStatus.OK)
  async listTenants() {
    return this.provision.listTenants();
  }

  /**
   * DELETE /api/public/onboarding/tenants/:id — 删除租户（仅测试用）
   */
  @Delete('onboarding/tenants/:id')
  @HttpCode(HttpStatus.OK)
  async deleteTenant(@Param('id') id: string): Promise<{ ok: true }> {
    await this.provision.deleteTenant(id);
    return { ok: true };
  }
}
