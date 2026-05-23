import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  RecommendationRepository,
  ParentRecommendation,
} from './recommendation.repository';
import { ReferralRepository } from './referral.repository';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';

/**
 * RecommendationController — V17 家长推荐 HTTP 暴露
 *
 * 路由：
 *   POST /api/db/recommendations/:id/toggle             - 老师 toggle 是否展示
 *   POST /api/db/teachers/:teacherId/recommendations/list - 列出该老师所有推荐
 *   POST /api/db/teachers/:teacherId/recommendations/invite - 邀请家长留推荐
 *   POST /api/db/recommendations                        - 家长提交推荐
 *
 * 鉴权：x-tenant-schema header
 */
@UseGuards(TenantScopeGuard)
@Controller('db')
export class RecommendationController {
  constructor(
    private readonly recRepo: RecommendationRepository,
    private readonly referrals: ReferralRepository,
  ) {}

  @Post('recommendations')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Headers('x-tenant-schema') tenantSchema: string,
    @Body()
    body: {
      id: string;
      teacherId: string;
      parentId: string;
      studentId: string;
      stars: number;
      content?: string;
      tags?: string[];
      parentAuthorized?: boolean;
    },
  ): Promise<ParentRecommendation> {
    if (!tenantSchema) {
      throw new BadRequestException('x-tenant-schema header required');
    }
    if (!body.id || body.id.length !== 32) {
      throw new BadRequestException('id must be 32-char ULID');
    }
    if (typeof body.stars !== 'number' || body.stars < 1 || body.stars > 5) {
      throw new BadRequestException('stars must be 1-5');
    }
    const created = await this.recRepo.insert(tenantSchema, {
      id: body.id,
      teacherId: body.teacherId,
      parentId: body.parentId,
      studentId: body.studentId,
      stars: body.stars,
      content: body.content,
      tags: body.tags || [],
      parentAuthorized: body.parentAuthorized ?? false,
      displayed: false,
      submittedAt: new Date(),
      createdAt: new Date(),
    });

    // V22: 若该家长是 referral 的 referee 且 status=trialed → 触发计数 +1
    // markRated 内部判断不存在则 no-op，所以失败也不阻塞主流程
    try {
      await this.referrals.markRated(tenantSchema, body.parentId, body.teacherId, {
        id: body.id,
        source: 'parent_recommendation',
      });
    } catch (e) {
      // log 但不抛错（V22 推荐计数失败不阻塞家长评价）
    }

    return created;
  }

  @Post('recommendations/:recommendationId/toggle')
  @HttpCode(HttpStatus.OK)
  async toggle(
    @Param('recommendationId') recommendationId: string,
    @Headers('x-tenant-schema') tenantSchema: string,
    @Body() body: { displayed: boolean },
  ): Promise<ParentRecommendation> {
    if (!tenantSchema) {
      throw new BadRequestException('x-tenant-schema header required');
    }
    if (typeof body.displayed !== 'boolean') {
      throw new BadRequestException('displayed must be boolean');
    }
    return this.recRepo.toggleDisplayed(tenantSchema, recommendationId, body.displayed);
  }

  @Post('teachers/:teacherId/recommendations/list')
  @HttpCode(HttpStatus.OK)
  async listByTeacher(
    @Param('teacherId') teacherId: string,
    @Headers('x-tenant-schema') tenantSchema: string,
  ): Promise<{
    items: ParentRecommendation[];
    displayedCount: number;
  }> {
    if (!tenantSchema) {
      throw new BadRequestException('x-tenant-schema header required');
    }
    const items = await this.recRepo.listByTeacher(tenantSchema, teacherId);
    const displayedCount = items.filter((r) => r.displayed).length;
    return { items, displayedCount };
  }

  @Post('teachers/:teacherId/recommendations/invite')
  @HttpCode(HttpStatus.OK)
  async inviteParent(
    @Param('teacherId') teacherId: string,
    @Headers('x-tenant-schema') tenantSchema: string,
    @Body() body: { studentId: string },
  ): Promise<{ ok: true; msg: string }> {
    if (!tenantSchema) {
      throw new BadRequestException('x-tenant-schema header required');
    }
    if (!body.studentId) {
      throw new BadRequestException('studentId required');
    }
    return this.recRepo.inviteParent(tenantSchema, teacherId, body.studentId);
  }
}
