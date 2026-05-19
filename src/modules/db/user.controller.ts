import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ulid } from 'ulid';
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
// Sprint X.2 (2026-05-17) — admin 创建 B 端子账户 + JWT 黑名单联动 (D2 / D6)
import { IdempotencyInterceptor } from '../../common/idempotency/idempotency.interceptor';
import { PhoneLookupService } from '../auth/phone-lookup.service';
import { PasswordHasher } from '../../common/crypto/password-hasher';
import { RedisService } from '../redis/redis.service';
import { RefreshTokenService } from '../auth/refresh-token.service';
import { AuditLogRepository, normalizeActorRole } from './audit-log.repository';

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
  private readonly logger = new Logger(UserController.name);

  constructor(
    private readonly repo: UserRepository,
    // Sprint X.2 (2026-05-17) — D2 admin 创建子账户 + D6 JWT 黑名单联动
    private readonly phoneLookup: PhoneLookupService,
    private readonly passwordHasher: PasswordHasher,
    private readonly redis: RedisService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly auditLog: AuditLogRepository,
  ) {}

  /**
   * POST /api/db/users — Sprint X.2 admin 创建 B 端子账户
   *
   * 来源：
   *   - SSOT §12.4 admin 唯一创建 B 端子账户权（boss 也不能）
   *   - 用户拍板 D2 admin 手动设密码 + modal 显示一次 + 复制告知员工 + bcrypt 8 位
   *
   * Body: { tenantId, tenantSchema, phone, role, name, campusId?, email? }
   * Response: { user: User, initialPassword: string }  ← initialPassword 仅返一次
   *
   * RBAC: @Roles('admin') 唯一（boss 也不能, SSOT §12.4）
   *
   * 跨表 phone 唯一性 pre-check:
   *   - 跨所有 tenant.users + public.parents 反查
   *   - 命中 → 409 PHONE_ALREADY_REGISTERED (互斥红线 SSOT §12.1)
   *
   * 业务校验:
   *   - role ∈ 10 B 端角色 (sales / sales_manager / marketing / finance /
   *     boss / hr / teacher / academic / academic_admin); 不允许再创 admin
   *     (SSOT §12.4 admin 唯一, 不能再创 admin)
   *   - campusId 单校 role 必填, 跨校 role (hr) 可空但需 fallback 主校区
   */
  // Sprint X.2 round 12 (2026-05-18 用户拍板): boss 可创建本校区员工
  //   SSOT §12.4 修订: admin (跨校) + boss (本校区, 不可创建另一个 boss/admin)
  @Post()
  @UseGuards(RbacGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @Roles('admin', 'boss')
  @HttpCode(HttpStatus.CREATED)
  async createUser(
    @Body()
    body: {
      tenantId: string;
      tenantSchema: string;
      phone: string;
      role: string;
      name: string;
      campusId?: string | null;
      email?: string;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<{ user: User; initialPassword: string }> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    if (!body.tenantId || body.tenantId.length !== 32) {
      throw new BadRequestException('tenantId must be 32-char ULID');
    }
    if (!body.phone || !/^1[3-9]\d{9}$/.test(body.phone)) {
      throw new BadRequestException('phone must be valid 11-digit Chinese mobile');
    }
    if (!body.name || body.name.trim().length === 0) {
      throw new BadRequestException('name required');
    }
    if (body.name.length > 32) {
      throw new BadRequestException('name too long (max 32 chars)');
    }
    // D2 + SSOT §12.4 — 不允许再创建 admin (admin 唯一, 是机构注册者)
    // Day 2 BLOCKER 4 (2026-05-19): SSOT §1「❌ hr 5/14 Wave 1 删」— 删 'hr' 角色
    const validSubRoles = [
      'sales',
      'sales_manager',
      'marketing',
      'finance',
      'boss',
      'teacher',
      'academic',
      'academic_admin',
    ];
    if (!validSubRoles.includes(body.role)) {
      throw new BadRequestException(
        `role must be one of ${validSubRoles.join('/')} (admin 不可再创建, SSOT §12.4)`,
      );
    }
    // Sprint X.2 round 14 (2026-05-18 用户拍板修订):
    //   SSOT §12.4: admin 全部校区可选 (机构主跨校), boss 仅本校区 (校长每校区唯一)
    const operatorRoleForBoss = req.user?.role;
    if (operatorRoleForBoss === 'boss') {
      if (body.role === 'boss' || body.role === 'admin') {
        throw new BadRequestException(
          'boss 不可创建 admin 或另一个 boss (SSOT §12.4 boss 每校区唯一)',
        );
      }
      const bossCampusId = req.user?.campusId;
      if (!bossCampusId) {
        throw new BadRequestException('boss 缺 campusId, 无法创建员工');
      }
      if (body.campusId && body.campusId !== bossCampusId) {
        throw new BadRequestException(
          `boss 只能创建本校区员工 (本校区=${bossCampusId.slice(0, 8)}...)`,
        );
      }
    }
    // admin: 不限校区 (机构主, SSOT §12.4 round 14 拍板)
    if (body.campusId !== undefined && body.campusId !== null) {
      if (body.campusId.length !== 32) {
        throw new BadRequestException('campusId must be 32-char ULID');
      }
    }
    const operatorUserId = req.user?.sub;
    if (!operatorUserId) throw new BadRequestException('user sub required');

    // 跨表 phone 唯一性 pre-check (D2 + SSOT §12.1 互斥红线)
    const lookup = await this.phoneLookup.lookupByPhone(body.phone);
    const activeBUsers = lookup.bUsers.filter(
      (u) => u.status === '启用' && u.deletedAt === null,
    );
    const activeParent =
      lookup.parent && lookup.parent.status === '启用' ? lookup.parent : null;
    if (activeBUsers.length > 0 || activeParent) {
      throw new BadRequestException(
        'PHONE_ALREADY_REGISTERED: 该手机号已注册 (B 端员工或 C 端家长)',
      );
    }

    // D2 — 生成 8 位随机密码 + bcrypt cost=12 → password_hash 60 char
    const initialPassword = this.passwordHasher.generateRandomPassword(8);
    const passwordHash = await this.passwordHasher.hash(initialPassword);

    // campusId 兜底 (跨校 role hr 仍要写一个 campusId 满足 V2 schema NOT NULL)
    //   admin (req.user.campusId) 可能为 null (admin 跨校), controller 兜底要求传入
    const finalCampusId = body.campusId ?? req.user?.campusId ?? null;
    if (!finalCampusId) {
      throw new BadRequestException(
        'campusId required (跨校 role 仍需指定一个 campusId 满足 schema NOT NULL)',
      );
    }
    const userId = ulid().padEnd(32, '0').slice(0, 32);
    const created = await this.repo.createUser(body.tenantSchema, {
      id: userId,
      name: body.name.trim(),
      mobile: body.phone,
      role: body.role,
      campusId: finalCampusId,
      passwordHash,
      createdBy: operatorUserId,
    });

    // audit_log V33 (D2 admin 创建必留痕)
    await this.auditLog.log(body.tenantSchema, {
      actorUserId: operatorUserId,
      actorRole: normalizeActorRole(req.user?.role),
      action: 'user.created-by-admin',
      targetType: 'user',
      targetId: created.id,
      before: null,
      after: { name: created.name, role: created.role, campusId: created.campusId },
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      requestId: (req.headers['x-request-id'] as string | undefined) ?? null,
    });

    return { user: created, initialPassword };
  }

  @Get('inactive-with-pending')
  @UseGuards(RbacGuard)
  // Day 2 BLOCKER 4 (2026-05-19): SSOT §1「❌ hr 5/14 Wave 1 删」
  @Roles('admin', 'boss')
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
  // Day 2 BLOCKER 4 (2026-05-19): SSOT §1「❌ hr 5/14 Wave 1 删」
  @Roles('admin', 'boss')
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
  // Day 2 BLOCKER 4 (2026-05-19): SSOT §1「❌ hr 5/14 Wave 1 删」
  @Roles('admin', 'boss')
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
  // Day 2 BLOCKER 4 (2026-05-19): SSOT §1「❌ hr 5/14 Wave 1 删」
  @Roles('admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async deactivate(
    @Param('userId') userId: string,
    @Body() body: { tenantId: string; tenantSchema: string; operatorLabel?: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<DeactivateResult> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    const operatorUserId = req.user?.sub;
    const operatorRole = req.user?.role;
    if (!operatorUserId || !operatorRole) {
      throw new BadRequestException('user sub/role required');
    }
    if (operatorUserId === userId) {
      throw new BadRequestException('不能自己离职自己');
    }
    const result = await this.repo.deactivate(body.tenantSchema, userId, {
      userId: operatorUserId,
      label: body.operatorLabel || `操作员 ${operatorUserId.slice(0, 6)}`,
      role: operatorRole,
      campusId: req.user?.campusId ?? null,
    });

    // Sprint X.2 Endpoint 9 (D6 2026-05-17) — JWT 黑名单联动
    //   SSOT §12.6「失效逻辑统一: 全部账户不可登录」
    //
    //   1. Redis auth:user-revoked-at:{userId} 写时间戳 (TTL 15min = access token TTL 上限)
    //      jwt.strategy.ts parse 时校验 token.iat * 1000 < userRevokedAt → 401
    //      15min 后该 user 所有旧 access token 自然过期, key 也过期 - 防内存泄漏
    //   2. refresh_tokens 全部撤销 (rotate 后旧 row revoke + 新 row insert 模式失效)
    //   3. audit_log user.deactivated.jwt-revoked
    //
    //   fail-open 哲学: Redis / refresh 撤销失败不阻塞主业务 (停用已写 DB)
    //   旧 token 自然过期窗口 ≤ 15min, 业务可接受
    const revokedAt = Date.now();
    // Sprint X.2 round 2 (2026-05-17 security A07-W1): Redis TTL 与 JWT access token TTL 对齐
    //   原 900s (15min) 让停用后 JWT TTL > 900s 窗口期内旧 token 仍生效 (默认 JWT 86400s = 23h45min 窗口)
    //   改用 process.env.JWT_TTL_SEC + 60s buffer (auth.module.ts:43 default 86400) 自然过期覆盖
    const jwtTtlSec = parseInt(process.env.JWT_TTL_SEC || '86400', 10);
    const redisTtlSec = Math.max(jwtTtlSec + 60, 900); // 至少 900s 兜底
    try {
      await this.redis.set(
        `auth:user-revoked-at:${userId}`,
        String(revokedAt),
        redisTtlSec,
      );
    } catch (err) {
      this.logger.warn(
        `[user.deactivate.redis-fail-open] userId=${userId} err=${(err as Error).message}`,
      );
    }
    try {
      await this.refreshTokenService.revokeAllBySubject('b-user', userId);
    } catch (err) {
      this.logger.warn(
        `[user.deactivate.refresh-fail-open] userId=${userId} err=${(err as Error).message}`,
      );
    }
    // audit_log V33 — 离职瞬间 JWT/refresh 失效留痕
    await this.auditLog.log(body.tenantSchema, {
      actorUserId: operatorUserId,
      actorRole: normalizeActorRole(operatorRole),
      action: 'user.deactivated.jwt-revoked',
      targetType: 'user',
      targetId: userId,
      before: { status: '启用' },
      after: {
        status: '停用',
        revokedAt: new Date(revokedAt).toISOString(),
        transferToUserId: result.transferToUserId,
      },
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      requestId: (req.headers['x-request-id'] as string | undefined) ?? null,
    });

    return result;
  }

  /**
   * Sprint X.2 round 11 (2026-05-18) — admin 重置员工密码
   *
   * 用户拍板: 员工管理页加「重置密码」按钮, 默认密码 '00000000'
   *
   * 行为:
   *   - bcrypt(default password) → UPDATE password_hash
   *   - Redis user-revoked-at 写时间戳 (同 deactivate, 让员工旧 token 立失效)
   *   - refresh_tokens revoke (员工必须用新密码重登)
   *   - audit_log V33 'user.password-reset-by-admin'
   *   - 返 { user, initialPassword: '00000000' } (前端 modal 显示一次, 同创建员工 D2 模式)
   */
  @Post(':userId/reset-password')
  @UseGuards(RbacGuard)
  @Roles('admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async resetPassword(
    @Param('userId') userId: string,
    @Body() body: { tenantId: string; tenantSchema: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<{ user: User; initialPassword: string }> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    const operatorUserId = req.user?.sub;
    const operatorRole = req.user?.role;
    if (!operatorUserId || !operatorRole) {
      throw new BadRequestException('user sub/role required');
    }
    // 防自己重置自己 (会导致自己被踢出登录)
    if (operatorUserId === userId) {
      throw new BadRequestException('不能重置自己的密码, 请用「修改密码」流程');
    }
    // Sprint X.2 round 15 (2026-05-18 用户拍板): boss 也可重置密码但有限制
    //   - boss 不能重置 admin / 另一个 boss
    //   - boss 只能重置本校区员工 (target.campusId === boss.campusId)
    //   - admin 不限 (机构主跨校重置)
    if (operatorRole === 'boss') {
      const target = await this.repo.findById(body.tenantSchema, userId);
      if (!target) {
        throw new BadRequestException('USER_NOT_FOUND: 员工不存在或已删除');
      }
      if (target.role === 'admin' || target.role === 'boss') {
        throw new BadRequestException('boss 不可重置 admin / 另一个 boss 的密码');
      }
      const bossCampusId = req.user?.campusId;
      if (!bossCampusId || target.campusId !== bossCampusId) {
        throw new BadRequestException(
          `boss 只能重置本校区员工的密码 (本校区=${(bossCampusId || '').slice(0, 8)}...)`,
        );
      }
    }
    const defaultPassword = '00000000';
    const passwordHash = await this.passwordHasher.hash(defaultPassword);
    const user = await this.repo.resetPassword(body.tenantSchema, userId, passwordHash);
    if (!user) {
      throw new BadRequestException('USER_NOT_FOUND: 员工不存在或已删除');
    }

    // JWT 黑名单联动 (同 deactivate, SSOT §12.6 失效逻辑)
    const revokedAt = Date.now();
    const jwtTtlSec = parseInt(process.env.JWT_TTL_SEC || '86400', 10);
    const redisTtlSec = Math.max(jwtTtlSec + 60, 900);
    try {
      await this.redis.set(`auth:user-revoked-at:${userId}`, String(revokedAt), redisTtlSec);
    } catch (err) {
      this.logger.warn(
        `[user.reset-password.redis-fail-open] userId=${userId} err=${(err as Error).message}`,
      );
    }
    try {
      await this.refreshTokenService.revokeAllBySubject('b-user', userId);
    } catch (err) {
      this.logger.warn(
        `[user.reset-password.refresh-fail-open] userId=${userId} err=${(err as Error).message}`,
      );
    }

    // audit_log V33 — 重置密码留痕
    await this.auditLog.log(body.tenantSchema, {
      actorUserId: operatorUserId,
      actorRole: normalizeActorRole(operatorRole),
      action: 'user.password-reset-by-admin',
      targetType: 'user',
      targetId: userId,
      before: null,
      after: {
        passwordUpdatedAt: new Date(revokedAt).toISOString(),
        revokedAt: new Date(revokedAt).toISOString(),
      },
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      requestId: (req.headers['x-request-id'] as string | undefined) ?? null,
    });

    return { user, initialPassword: defaultPassword };
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
