import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { TeacherService, Teacher } from './teacher.service';
import { CreateTeacherDto, TeacherStatus } from './dto/create-teacher.dto';
import { Roles } from '../../guards/rbac.decorator';
import { RbacGuard } from '../../guards/rbac.guard';

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
  constructor(private readonly service: TeacherService) {}

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
}
