import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ReferralRepository, ParentReferral, ReferralStatus } from './referral.repository';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';

/**
 * ReferralController — V22 家长推荐家长（V10 策略 #17-22）
 *
 * 路径：/api/db/referrals/*  命中 TenantMiddleware「其他业务」 + TenantScopeGuard
 *
 * Endpoints:
 *   POST   /db/referrals                    创建推荐（A 调用）
 *   GET    /db/referrals/by-code/:code      按 code 查（B 扫码后预览）
 *   POST   /db/referrals/by-code/:code/trial 标记 B 已试听
 *   POST   /db/referrals/mark-rated         标记 B 已评价（feedback service 触发）
 *   GET    /db/referrals/teacher/:id/stats  老师推荐计数
 *   GET    /db/referrals/by-referrer        A 自己的推荐列表
 */
@Controller('db/referrals')
@UseGuards(TenantScopeGuard)
export class ReferralController {
  constructor(private readonly repo: ReferralRepository) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body()
    body: {
      tenantId: string;
      tenantSchema: string;
      id: string;
      teacherId: string;
      referrerParentId: string;
      referrerStudentId: string;
      referralCode: string;
      note?: string;
    },
    @Req() _req: AuthenticatedRequest,
  ): Promise<ParentReferral> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    if (!body.teacherId) throw new BadRequestException('teacherId required');

    // 必须 A 是该老师学员家长
    await this.repo.assertReferrerIsTeacherStudentParent(
      body.tenantSchema,
      body.teacherId,
      body.referrerParentId,
      body.referrerStudentId,
    );

    return this.repo.create(body.tenantSchema, body);
  }

  @Get('by-code/:code')
  @HttpCode(HttpStatus.OK)
  async byCode(
    @Param('code') code: string,
    @Query('tenantSchema') tenantSchema: string,
  ): Promise<ParentReferral | { found: false }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const r = await this.repo.findByCode(tenantSchema, code);
    if (!r) return { found: false };
    return r;
  }

  @Post('by-code/:code/trial')
  @HttpCode(HttpStatus.OK)
  async markTrialed(
    @Param('code') code: string,
    @Body()
    body: {
      tenantId: string;
      tenantSchema: string;
      refereeParentId: string;
      refereeStudentId: string;
      trialScheduleId: string;
    },
  ): Promise<ParentReferral> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    return this.repo.markTrialed(body.tenantSchema, code, body);
  }

  @Post('mark-rated')
  @HttpCode(HttpStatus.OK)
  async markRated(
    @Body()
    body: {
      tenantId: string;
      tenantSchema: string;
      refereeParentId: string;
      teacherId: string;
      ratingId: string;
      ratingSource: 'lesson_feedback' | 'parent_recommendation';
    },
  ): Promise<{ ok: true; updated: boolean; referral: ParentReferral | null }> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    const r = await this.repo.markRated(
      body.tenantSchema,
      body.refereeParentId,
      body.teacherId,
      { id: body.ratingId, source: body.ratingSource },
    );
    return { ok: true, updated: r !== null, referral: r };
  }

  @Get('teacher/:teacherId/stats')
  @HttpCode(HttpStatus.OK)
  async teacherStats(
    @Param('teacherId') teacherId: string,
    @Query('tenantSchema') tenantSchema: string,
  ): Promise<{ rated: number; trialed: number; pending: number; expired: number }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    return this.repo.getTeacherStats(tenantSchema, teacherId);
  }

  @Get('by-referrer')
  @HttpCode(HttpStatus.OK)
  async byReferrer(
    @Query('tenantSchema') tenantSchema: string,
    @Query('referrerParentId') referrerParentId: string,
    @Query('limit') limit?: string,
    @Query('status') status?: ReferralStatus,
  ): Promise<{ items: ParentReferral[] }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    if (!referrerParentId) throw new BadRequestException('referrerParentId required');
    const items = await this.repo.listByReferrer(
      tenantSchema,
      referrerParentId,
      limit ? Math.min(parseInt(limit, 10), 200) : 50,
    );
    return { items: status ? items.filter((i) => i.status === status) : items };
  }
}
