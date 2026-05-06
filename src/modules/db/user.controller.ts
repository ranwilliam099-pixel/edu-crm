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
import {
  UserRepository,
  DeactivateResult,
  HandoverResult,
  InactiveWithPending,
  User,
} from './user.repository';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';
import { Roles } from '../../guards/rbac.decorator';
import { RbacGuard } from '../../guards/rbac.guard';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';

/**
 * UserController — V27 员工离职 + 数据交接 HTTP 暴露
 *
 * 路径前缀 /api/db/users/*
 *
 * Endpoints:
 *   GET  /db/users/:id                       查 user（admin/boss/hr）
 *   GET  /db/users/inactive-with-pending     校长视角「待交接」清单
 *   POST /db/users/:userId/deactivate        离职 + 自动转交（admin/boss/hr）
 *   POST /db/users/:fromUserId/handover      校长二次手动转交（admin/boss）
 *                                            支持转给在职 / 离职销售；toUserId 可 = 校长自己
 *
 * 鉴权：TenantScopeGuard 强制 tenantId 一致 + RbacGuard 限定可操作 role
 */
@Controller('db/users')
@UseGuards(TenantScopeGuard)
export class UserController {
  constructor(private readonly repo: UserRepository) {}

  @Get('inactive-with-pending')
  @UseGuards(RbacGuard)
  @Roles('admin', 'boss', 'hr')
  @HttpCode(HttpStatus.OK)
  async listInactive(
    @Query('tenantSchema') tenantSchema: string,
  ): Promise<{ items: InactiveWithPending[] }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const items = await this.repo.listInactiveWithPending(tenantSchema);
    return { items };
  }

  /**
   * 列 active 用户（toUser 选择器）
   * @query roles 可选，逗号分隔（如 'boss,sales,sales_manager'）
   * @query campusId 可选，同校区过滤
   */
  @Get('list')
  @UseGuards(RbacGuard)
  @Roles('admin', 'boss', 'hr')
  @HttpCode(HttpStatus.OK)
  async listActive(
    @Query('tenantSchema') tenantSchema: string,
    @Query('roles') roles?: string,
    @Query('campusId') campusId?: string,
  ): Promise<{ items: User[] }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const roleArr = roles
      ? (roles.split(',').map((r) => r.trim()).filter(Boolean) as any[])
      : undefined;
    const items = await this.repo.listActive(tenantSchema, {
      roles: roleArr,
      campusId,
    });
    return { items };
  }

  /**
   * 列出 active 但名下有数据的用户（校长「主动转交」起点）
   */
  @Get('active-with-data')
  @UseGuards(RbacGuard)
  @Roles('admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async listActiveWithData(
    @Query('tenantSchema') tenantSchema: string,
  ): Promise<{ items: InactiveWithPending[] }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const items = await this.repo.listActiveWithData(tenantSchema);
    return { items };
  }

  @Get(':id')
  @UseGuards(RbacGuard)
  @Roles('admin', 'boss', 'hr')
  @HttpCode(HttpStatus.OK)
  async detail(
    @Param('id') id: string,
    @Query('tenantSchema') tenantSchema: string,
  ): Promise<User | { found: false }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const u = await this.repo.findById(tenantSchema, id);
    if (!u) return { found: false };
    return u;
  }

  /**
   * 离职：UPDATE users.status='停用' + 自动转交 owner_user_id 给「接棒人」（V10 5 分支规则）
   *
   * 执行者：admin（老板）/ boss（校长）/ hr（人事）— 跨校或同校决策由调用方 RBAC 判
   *
   * Body:
   *   tenantId      jwt 一致校验
   *   tenantSchema  租户 schema
   */
  @Post(':userId/deactivate')
  @UseGuards(RbacGuard)
  @Roles('admin', 'boss', 'hr')
  @HttpCode(HttpStatus.OK)
  async deactivate(
    @Param('userId') userId: string,
    @Body() body: { tenantId: string; tenantSchema: string; operatorLabel?: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<DeactivateResult> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    const operatorUserId = req.user?.sub;
    if (!operatorUserId) throw new BadRequestException('user sub required');
    if (operatorUserId === userId) {
      throw new BadRequestException('不能自己离职自己');
    }
    return this.repo.deactivate(body.tenantSchema, userId, {
      userId: operatorUserId,
      label: body.operatorLabel || `操作员 ${operatorUserId.slice(0, 6)}`,
    });
  }

  /**
   * 校长二次手动转交：把 fromUser 名下数据包转给 toUser
   *
   * 用户拍板 2026-05-07：
   *   - 校长可主动将「在职」或「离职」员工的数据全部转移到另外一个人（可选校长自己）
   *
   * Body:
   *   toUserId       接棒人 user.id；null = 退回池（owner=NULL）
   *   scope          'all' = 全部；'select' = 精确列表
   *   opportunityIds scope='select' 时的客户 id 列表
   *   contractIds    scope='select' 时的签约 id 列表
   *   operatorLabel  审计显示名
   */
  @Post(':fromUserId/handover')
  @UseGuards(RbacGuard)
  @Roles('admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async handover(
    @Param('fromUserId') fromUserId: string,
    @Body()
    body: {
      tenantId: string;
      tenantSchema: string;
      toUserId: string | null;
      scope: 'all' | 'select';
      opportunityIds?: string[];
      contractIds?: string[];
      operatorLabel?: string;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<HandoverResult> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    if (body.scope !== 'all' && body.scope !== 'select') {
      throw new BadRequestException('scope must be "all" or "select"');
    }
    const operatorUserId = req.user?.sub;
    if (!operatorUserId) throw new BadRequestException('user sub required');
    return this.repo.handover(body.tenantSchema, {
      fromUserId,
      toUserId: body.toUserId === undefined ? null : body.toUserId,
      scope: body.scope,
      opportunityIds: body.opportunityIds,
      contractIds: body.contractIds,
      operator: {
        userId: operatorUserId,
        label: body.operatorLabel || `操作员 ${operatorUserId.slice(0, 6)}`,
      },
    });
  }
}
