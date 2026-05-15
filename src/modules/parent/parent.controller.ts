import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  HttpCode,
  HttpStatus,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import {
  ParentService,
  Parent,
  ParentStudentBinding,
  Relationship,
} from './parent.service';
import { ParentSelfGuard } from '../auth/parent-self.guard';

type ParentRequest = Request & {
  parent?: { sub?: string; parentId?: string; role?: string };
};

/**
 * ParentController — V10 家长身份 + 学员绑定 HTTP 暴露 BE-V10-1
 *
 * 路由前缀：/api/parents
 *
 * RBAC：C 端家长走自己的 OAuth token（family-owner），不在 @Roles 装饰器范围
 *   B 端管理（如销售生成绑定二维码）走 sales / admin / boss 角色（生成 QR 码不在本 Controller）
 *
 * T6b (2026-05-16)：class-level ParentSelfGuard 守门（req.parent.sub === req.params.parentId）
 *   + service 二道防御（assertOwnership）。/register 无 :parentId → guard 自动跳过；
 *   bindings/:bindingId/unbind 无 :parentId → service 层用 callerParentId 校验绑定归属。
 *
 * USER-AUTH(2026-05-02): 条目 31 #3 跨机构共享 + 条目 32 #10 退订保留绑定
 */
@Controller('parents')
@UseGuards(ParentSelfGuard)
export class ParentController {
  constructor(private readonly service: ParentService) {}

  /**
   * POST /api/parents/register — 家长注册（小程序 OAuth 后调）
   */
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  register(
    @Body()
    body: {
      id: string;
      phone: string;
      wechatOpenid?: string;
      wechatUnionid?: string;
      name?: string;
      avatarUrl?: string;
    },
  ): Parent {
    return this.service.registerParent(body);
  }

  /**
   * POST /api/parents/:parentId/bindings — 绑定学员
   *
   * 应用层 + DB 触发器双校验单孩最多 3 家长（P8）
   */
  @Post(':parentId/bindings')
  @HttpCode(HttpStatus.CREATED)
  createBinding(
    @Param('parentId') parentId: string,
    @Body()
    body: {
      id: string;
      studentId: string;
      tenantId: string;
      isPrimary?: boolean;
      relationship: Relationship;
      existingActiveBindings: ParentStudentBinding[];
    },
  ): ParentStudentBinding {
    return this.service.createBinding(
      {
        id: body.id,
        parentId,
        studentId: body.studentId,
        tenantId: body.tenantId,
        isPrimary: body.isPrimary,
        relationship: body.relationship,
      },
      body.existingActiveBindings,
    );
  }

  /**
   * POST /api/parents/bindings/:bindingId/unbind — 解绑（条目 32 #10 保留行）
   */
  @Post('bindings/:bindingId/unbind')
  @HttpCode(HttpStatus.OK)
  unbind(
    @Param('bindingId') _bindingId: string,
    @Body() body: { binding: ParentStudentBinding },
  ): ParentStudentBinding {
    return this.service.unbindStudent(body.binding);
  }

  /**
   * POST /api/parents/:parentId/children — 我的孩子列表（跨机构共享）
   */
  @Post(':parentId/children')
  @HttpCode(HttpStatus.OK)
  listMyChildren(
    @Param('parentId') parentId: string,
    @Body() body: { allBindings: ParentStudentBinding[] },
  ): ParentStudentBinding[] {
    return this.service.listMyChildren(parentId, body.allBindings);
  }

  /**
   * POST /api/parents/db/register — 真存盘
   */
  @Post('db/register')
  @HttpCode(HttpStatus.CREATED)
  async registerInDb(
    @Body()
    body: {
      id: string;
      phone: string;
      wechatOpenid?: string;
      name?: string;
    },
  ): Promise<Parent> {
    return this.service.registerParentInDb(body);
  }

  @Post('db/:parentId/bindings')
  @HttpCode(HttpStatus.CREATED)
  async createBindingInDb(
    @Param('parentId') parentId: string,
    @Body()
    body: {
      id: string;
      studentId: string;
      tenantId: string;
      isPrimary?: boolean;
      relationship: Relationship;
    },
    @Req() req: ParentRequest,
  ): Promise<ParentStudentBinding> {
    // T6b 二道防御：service 层再断言 parentId === req.parent.sub
    // （Guard 已校验，service 层用于覆盖非 HTTP 直接调用 / 未来 cron 等场景）
    return this.service.createBindingInDb(
      { ...body, parentId },
      req.parent?.sub,
    );
  }

  @Post('db/:parentId/children')
  @HttpCode(HttpStatus.OK)
  async listChildrenInDb(
    @Param('parentId') parentId: string,
    @Req() req: ParentRequest,
  ): Promise<ParentStudentBinding[]> {
    return this.service.listMyChildrenInDb(parentId, req.parent?.sub);
  }

  @Post('db/bindings/:bindingId/unbind')
  @HttpCode(HttpStatus.OK)
  async unbindInDb(
    @Param('bindingId') bindingId: string,
    @Req() req: ParentRequest,
  ): Promise<ParentStudentBinding> {
    // T6b：unbind 无 :parentId path param → Guard 跳过 → service 层用 callerParentId
    // 反查 binding 归属（防一个 parent 解绑另一个 parent 的 binding）
    return this.service.unbindBindingInDb(bindingId, req.parent?.sub);
  }

  /**
   * POST /api/parents/students/:studentId/active-parents-count
   *
   * 用于 C-02 显示"当前家长数 / 3"
   */
  @Post('students/:studentId/active-parents-count')
  @HttpCode(HttpStatus.OK)
  countActiveParents(
    @Param('studentId') studentId: string,
    @Body() body: { allBindings: ParentStudentBinding[] },
  ): { count: number; max: number } {
    return {
      count: this.service.countActiveParentsForStudent(studentId, body.allBindings),
      max: 3,
    };
  }
}
