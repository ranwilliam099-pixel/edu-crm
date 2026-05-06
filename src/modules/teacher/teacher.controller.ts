import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { TeacherService, Teacher } from './teacher.service';
import { CreateTeacherDto, TeacherStatus } from './dto/create-teacher.dto';
import { TeacherRepository, TeacherArchiveResult } from '../db/teacher.repository';
import { Roles } from '../../guards/rbac.decorator';
import { RbacGuard } from '../../guards/rbac.guard';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';

/**
 * TeacherController — V7 教师独立档案 HTTP 暴露 BE-V7-1
 *
 * 路由前缀：/api/teachers
 *
 * RBAC（按 V2 8 枚举）：
 *   - 创建/状态变更：admin / boss / hr（管理类）
 *   - 查询：admin / boss / hr / sales_manager / sales_director（管理可视）
 *
 * USER-AUTH(2026-05-02): 条目 29 方向 B + 条目 31 #2 + 条目 32 L1
 */
@Controller('teachers')
export class TeacherController {
  constructor(
    private readonly service: TeacherService,
    private readonly repo: TeacherRepository,
  ) {}

  /**
   * POST /api/teachers — 创建教师档案
   */
  @Post()
  @UseGuards(RbacGuard)
  @Roles('admin', 'boss', 'hr')
  @HttpCode(HttpStatus.CREATED)
  createTeacher(@Body() dto: CreateTeacherDto): Teacher {
    return this.service.createTeacher(dto);
  }

  /**
   * POST /api/teachers/:id/status — 教师状态机转换
   */
  @Post(':id/status')
  @UseGuards(RbacGuard)
  @Roles('admin', 'boss', 'hr')
  @HttpCode(HttpStatus.OK)
  changeStatus(
    @Param('id') _id: string,
    @Body() body: { teacher: Teacher; newStatus: TeacherStatus },
  ): Teacher {
    return this.service.changeStatus(body.teacher, body.newStatus);
  }

  /**
   * POST /api/teachers/filter-schedulable — 跨校区资源池查询
   *
   * 业务豁免点（用户原文「A 校区可以给 B 校区的老师排课程」）：
   *   返回租户内全部 active 教师，不限 campus_id
   */
  @Post('filter-schedulable')
  @HttpCode(HttpStatus.OK)
  filterSchedulable(@Body() body: { teachers: Teacher[] }): Teacher[] {
    return this.service.filterSchedulableTeachers(body.teachers);
  }

  /**
   * POST /api/teachers/db — 真 PG 持久化版（用户 2026-05-02「做啊」）
   *
   * Body: CreateTeacherDto + { tenantSchema: 'tenant_xxx' }
   */
  @Post('db')
  @UseGuards(RbacGuard)
  @Roles('admin', 'boss', 'hr')
  @HttpCode(HttpStatus.CREATED)
  async createTeacherInDb(
    @Body() body: CreateTeacherDto & { tenantSchema: string },
  ): Promise<Teacher> {
    const { tenantSchema, ...dto } = body;
    return this.service.createTeacherInDb(dto, tenantSchema);
  }

  /**
   * POST /api/teachers/db/list — 真 PG 查询全部 active 教师
   */
  @Post('db/list')
  @UseGuards(RbacGuard)
  @Roles('admin', 'boss', 'hr', 'sales_manager', 'sales_director')
  @HttpCode(HttpStatus.OK)
  async listFromDb(@Body() body: { tenantSchema: string }): Promise<Teacher[]> {
    return this.service.listFromDb(body.tenantSchema);
  }

  /**
   * GET /api/teachers/:id/profile-type — 判断老师类型（含登录账号 / 纯档案）
   *
   * 由调用方传入 teacher 对象（应用层接口），无 DB 查询
   */
  @Post(':id/profile-type')
  @HttpCode(HttpStatus.OK)
  profileType(
    @Param('id') _id: string,
    @Body() body: { teacher: Teacher },
  ): { hasLoginAccount: boolean; isPureArchive: boolean; isSchedulable: boolean } {
    return {
      hasLoginAccount: this.service.hasLoginAccount(body.teacher),
      isPureArchive: this.service.isPureArchive(body.teacher),
      isSchedulable: this.service.isSchedulable(body.teacher),
    };
  }

  /**
   * V28 注销老师（归档）+ 关联学生主带老师转给同 campus 其他在职老师
   *
   * 用户 2026-05-07：「校长也应该可以注销老师和销售」
   *
   * 路由：POST /api/teachers/db/:id/archive
   *   Body: { tenantId, tenantSchema }
   *   Returns: { teacher, transferToTeacherId, transferToTeacherName, studentsReassigned }
   *
   * RBAC：admin / boss / hr
   */
  @Post('db/:id/archive')
  @UseGuards(TenantScopeGuard, RbacGuard)
  @Roles('admin', 'boss', 'hr')
  @HttpCode(HttpStatus.OK)
  async archive(
    @Param('id') id: string,
    @Body() body: { tenantId: string; tenantSchema: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<TeacherArchiveResult> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    const operator = req.user?.sub || 'system';
    return this.repo.archive(body.tenantSchema, id, operator);
  }
}
