import { Controller, Get, Param, Headers, BadRequestException, UseGuards } from '@nestjs/common';
import { TeacherShowcaseRepository, TeacherShowcaseSummary } from './teacher-showcase.repository';
import { TeacherRepository } from './teacher.repository';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';

/**
 * TeacherShowcaseController — 老师业务展示卡数据接入
 *
 * 来源：用户 2026-05-04 Phase 2 后端聚合
 *
 * 路由：
 *   GET /api/db/teachers/:id/showcase  — 11 项指标聚合查询
 *
 * 鉴权：
 *   - x-tenant-schema header（与其他 /db 路由一致）
 *   - A01 红线：@UseGuards(TenantScopeGuard) 校验 JWT.tenantId === x-tenant-schema
 *     防止 tenant_A 用户持自己 JWT + 改 header 读取 tenant_B 数据
 */
@UseGuards(TenantScopeGuard)
@Controller('db/teachers')
export class TeacherShowcaseController {
  constructor(
    private readonly showcaseRepo: TeacherShowcaseRepository,
    private readonly teacherRepo: TeacherRepository,
  ) {}

  @Get(':id/showcase')
  async getShowcase(
    @Param('id') teacherId: string,
    @Headers('x-tenant-schema') tenantSchema: string,
  ): Promise<{
    teacher: {
      id: string;
      name: string;
      subjects: string[];
    } | null;
    summary: TeacherShowcaseSummary;
  }> {
    if (!tenantSchema) {
      throw new BadRequestException('x-tenant-schema header required');
    }

    // 基础资料
    const teacher = await this.teacherRepo.findById(tenantSchema, teacherId);
    if (!teacher) {
      throw new BadRequestException(`teacher ${teacherId} not found`);
    }

    // 聚合数据
    const summary = await this.showcaseRepo.getSummary(tenantSchema, teacherId);

    return {
      teacher: {
        id: teacher.id,
        name: teacher.name,
        subjects: [...(teacher.subjects || [])],
      },
      summary,
    };
  }
}
