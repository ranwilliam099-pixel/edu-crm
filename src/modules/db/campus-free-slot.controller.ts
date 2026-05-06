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
  UseGuards,
} from '@nestjs/common';
import {
  CampusFreeSlotRepository,
  CampusFreeSlot,
} from './campus-free-slot.repository';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';

/**
 * CampusFreeSlotController — V23 校区赠送 slot HTTP 暴露
 *
 * 路径：/api/db/campus-free-slots/*
 *
 * 端点：
 *   GET    /db/campus-free-slots/campus/:id        校区 slot 列表
 *   GET    /db/campus-free-slots/campus/:id/stats  占用统计
 *   POST   /db/campus-free-slots/claim             家长抢占（FCFS）
 *   POST   /db/campus-free-slots/release           校区运营释放
 *   GET    /db/campus-free-slots/by-parent/:id     家长查自己 slot
 *
 * 鉴权：TenantScopeGuard（claim/release 校验 body.tenantId）
 */
@Controller('db/campus-free-slots')
@UseGuards(TenantScopeGuard)
export class CampusFreeSlotController {
  constructor(private readonly repo: CampusFreeSlotRepository) {}

  @Get('campus/:campusId')
  @HttpCode(HttpStatus.OK)
  async listByCampus(
    @Param('campusId') campusId: string,
    @Query('tenantId') _tenantId: string,
  ): Promise<{ items: CampusFreeSlot[] }> {
    if (!campusId) throw new BadRequestException('campusId required');
    const items = await this.repo.listByCampus(campusId);
    return { items };
  }

  @Get('campus/:campusId/stats')
  @HttpCode(HttpStatus.OK)
  async stats(
    @Param('campusId') campusId: string,
    @Query('tenantId') _tenantId: string,
  ): Promise<{ total: number; occupied: number; empty: number; expired: number }> {
    if (!campusId) throw new BadRequestException('campusId required');
    return this.repo.getCampusStats(campusId);
  }

  @Post('claim')
  @HttpCode(HttpStatus.OK)
  async claim(
    @Body()
    body: {
      tenantId: string;
      campusId: string;
      parentId: string;
      durationMonths?: number;
    },
  ): Promise<CampusFreeSlot> {
    if (!body.campusId) throw new BadRequestException('campusId required');
    if (!body.parentId) throw new BadRequestException('parentId required');
    const months = body.durationMonths ?? 3;
    if (months < 1 || months > 12) {
      throw new BadRequestException('durationMonths must be 1-12');
    }
    return this.repo.claim(body.campusId, body.parentId, months);
  }

  @Post('release')
  @HttpCode(HttpStatus.OK)
  async release(
    @Body() body: { tenantId: string; slotId: number },
  ): Promise<CampusFreeSlot> {
    if (!body.slotId) throw new BadRequestException('slotId required');
    return this.repo.release(body.slotId);
  }

  @Get('by-parent/:parentId')
  @HttpCode(HttpStatus.OK)
  async byParent(
    @Param('parentId') parentId: string,
    @Query('tenantId') _tenantId: string,
  ): Promise<CampusFreeSlot | { found: false }> {
    if (!parentId) throw new BadRequestException('parentId required');
    const r = await this.repo.findByParent(parentId);
    if (!r) return { found: false };
    return r;
  }
}
