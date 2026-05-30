import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ulid } from 'ulid';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';
import { Roles } from '../../guards/rbac.decorator';
import { RbacGuard } from '../../guards/rbac.guard';
import { IdempotencyInterceptor } from '../../common/idempotency/idempotency.interceptor';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';
import { ParentRepository, ParentForCustomerDetail } from './parent.repository';
import { StudentRepository } from './student.repository';
import { PhoneLookupService } from '../auth/phone-lookup.service';
import { AuditLogRepository, normalizeActorRole } from './audit-log.repository';
import { Parent, ParentStudentBinding, Relationship } from '../parent/parent.service';

/**
 * ParentBindingController — Sprint X.2 (2026-05-17) 教务/销售 staff 端家长账户管理
 *
 * 来源：
 *   - SSOT §12.5 教务/销售在学员页绑定家长 (≤ 3 家长 V10 触发器硬约束)
 *   - SSOT §12.7 失效逻辑统一: parents.status='停用' (V47)
 *   - 用户拍板 D10 parent unbound 仅写 audit_log, 不本 Sprint 加 parent.status='停用'
 *
 * 路由前缀: /api/db/parents 和 /api/db/parent-bindings
 *
 * 与 ParentController (modules/parent/parent.controller.ts) 的切分:
 *   - ParentController = C 端家长 self (parents/register, /:parentId/bindings, ParentSelfGuard)
 *   - 本 controller    = B 端 staff (admin/boss/sales/academic) 在学员页代家长操作
 *
 * RBAC: TenantScopeGuard + RbacGuard + @Roles(staff cohort)
 */
@Controller()
@UseGuards(TenantScopeGuard)
export class ParentBindingController {
  private readonly logger = new Logger(ParentBindingController.name);

  constructor(
    private readonly parentRepo: ParentRepository,
    private readonly studentRepo: StudentRepository,
    private readonly phoneLookup: PhoneLookupService,
    private readonly auditLog: AuditLogRepository,
  ) {}

  /**
   * POST /api/db/parents — staff 在学员页创建家长账户 + 绑定关系
   *
   * 来源: SSOT §12.5 + 用户拍板 D3 (家长本 Sprint 不带 password_hash, 走 wx-jscode2session)
   *
   * Body: { tenantId, tenantSchema, phone, name, relationship, studentId, isPrimary? }
   *
   * 业务流程 (事务):
   *   1. 跨表 phone 唯一性校验 (B/C 互斥红线 SSOT §12.1)
   *      - 命中 B 端任意 tenant.users → 拒 (互斥)
   *      - 命中 C 端 public.parents → 允许 (一个家长绑多孩子 SSOT §12.5)
   *   2. 校验 studentId 在当前 tenant schema 内 (防伪造跨 tenant 学员)
   *   3. 校验 binding ≤ 3 家长 (应用层 pre-check 友好错误)
   *   4. 校验 (parent, student) 未重复绑定 (防双绑 → 409)
   *   5. INSERT parents (如不存在; D3 不带 password_hash) + INSERT parent_student_bindings
   *   6. audit_log parent.bound-by-staff (V33 留痕)
   *
   * RBAC: sales / sales_manager / academic / academic_admin / admin / boss (SSOT §12.5)
   *
   * V10 触发器 trg_max_3_parents 兜底硬约束 (应用层 pre-check 给友好错误, DB 兜底防并发)
   */
  @Post('db/parents')
  @UseGuards(RbacGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @Roles('sales', 'sales_manager', 'academic', 'academic_admin', 'admin', 'boss')
  @HttpCode(HttpStatus.CREATED)
  async createParent(
    @Body()
    body: {
      tenantId: string;
      tenantSchema: string;
      phone: string;
      name: string;
      relationship: Relationship;
      studentId: string;
      isPrimary?: boolean;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<{ parent: Parent; binding: ParentStudentBinding }> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    if (!body.tenantId || body.tenantId.length !== 32) {
      throw new BadRequestException('tenantId must be 32-char ULID');
    }
    if (!body.phone || !/^1[3-9]\d{9}$/.test(body.phone)) {
      throw new BadRequestException('phone must be valid 11-digit Chinese mobile');
    }
    if (!body.name || body.name.trim().length === 0 || body.name.length > 64) {
      throw new BadRequestException('name required (max 64 chars)');
    }
    if (!body.studentId || body.studentId.length !== 32) {
      throw new BadRequestException('studentId must be 32-char ULID');
    }
    const validRel: Relationship[] = [
      'father',
      'mother',
      'grandfather',
      'grandmother',
      'guardian',
      'other',
    ];
    if (!validRel.includes(body.relationship)) {
      throw new BadRequestException(
        `relationship must be one of ${validRel.join('/')}`,
      );
    }
    const operatorUserId = req.user?.sub;
    if (!operatorUserId) throw new BadRequestException('user sub required');

    // 1. studentId 在当前 tenant schema 内 (防伪造跨 tenant 学员)
    //    findBrief 内部 deleted_at IS NULL 过滤 (V44 软删)
    const student = await this.studentRepo.findBrief(body.tenantSchema, body.studentId);
    if (!student) {
      throw new NotFoundException(`student ${body.studentId} not found in current tenant`);
    }

    // 2. 跨表 phone 唯一性 (B 端互斥红线 SSOT §12.1)
    //    - 任何 tenant.users 命中 → 拒 (B/C 互斥)
    //    - public.parents 命中 → 允许 (D3 + SSOT §12.5 一家长多孩子)
    const lookup = await this.phoneLookup.lookupByPhone(body.phone);
    const activeBUsers = lookup.bUsers.filter(
      (u) => u.status === '启用' && u.deletedAt === null,
    );
    if (activeBUsers.length > 0) {
      throw new ConflictException(
        'PHONE_ALREADY_REGISTERED_AS_STAFF: 该手机号已注册为 B 端员工 (B/C 互斥)',
      );
    }

    // 3. 单孩 ≤ 3 家长 (应用层 pre-check + V10 触发器兜底)
    const existing = await this.parentRepo.findActiveBindingsForStudent(body.studentId);
    if (existing.length >= 3) {
      throw new ConflictException('STUDENT_MAX_3_PARENTS_EXCEEDED');
    }

    // 4. 复用现有 parent (按 phone 反查), 否则新建
    //    D3: 不带 password_hash; 本 Sprint 家长走 wx-jscode2session 旧路径
    let parent = lookup.parent
      ? await this.parentRepo.findParentById(lookup.parent.parentId)
      : null;
    if (!parent) {
      const parentId = ulid().padEnd(32, '0').slice(0, 32);
      parent = await this.parentRepo.insertParent({
        id: parentId,
        phone: body.phone,
        name: body.name.trim(),
        // V47 (Sprint X.2 2026-05-17) — parents.status 中文双态默认 '启用'
        status: '启用',
      });
    }

    // 5. (parent, student) 已绑 → 409 防双绑
    //    parent_student_bindings.UNIQUE (parent_id, student_id) 兜底
    const dup = existing.find((b) => b.parentId === parent!.id);
    if (dup) {
      throw new ConflictException('PARENT_ALREADY_BOUND_TO_STUDENT');
    }

    // 6. INSERT binding (V10 trg_max_3_parents 兜底兼容并发)
    const bindingId = ulid().padEnd(32, '0').slice(0, 32);
    let binding: ParentStudentBinding;
    try {
      binding = await this.parentRepo.insertBinding({
        id: bindingId,
        parentId: parent.id,
        studentId: body.studentId,
        tenantId: body.tenantId,
        isPrimary: body.isPrimary ?? false,
        relationship: body.relationship,
        bindingStatus: 'active',
        boundAt: new Date(),
      });
    } catch (err) {
      // V10 触发器 P0001 STUDENT_MAX_3_PARENTS_EXCEEDED (应用层 pre-check 已挡, 并发兜底)
      const e = err as { code?: string; message?: string };
      if (e.message?.includes('STUDENT_MAX_3_PARENTS_EXCEEDED')) {
        throw new ConflictException('STUDENT_MAX_3_PARENTS_EXCEEDED');
      }
      // public.parent_student_bindings.UNIQUE (parent_id, student_id) 兜底 (代码 23505)
      if (e.code === '23505') {
        throw new ConflictException('PARENT_ALREADY_BOUND_TO_STUDENT');
      }
      throw err;
    }

    // 7. audit_log V33 (D2 staff 创建家长账户留痕)
    await this.auditLog.log(body.tenantSchema, {
      actorUserId: operatorUserId,
      actorRole: normalizeActorRole(req.user?.role),
      action: 'parent.bound-by-staff',
      targetType: 'parent_student_binding',
      targetId: binding.id,
      before: null,
      after: {
        parentId: parent.id,
        studentId: body.studentId,
        relationship: body.relationship,
        isPrimary: binding.isPrimary,
      },
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      requestId: (req.headers['x-request-id'] as string | undefined) ?? null,
    });

    return { parent, binding };
  }

  /**
   * POST /api/db/parents/by-student — 按学员查家长列表（客户详情页 _loadParents）
   *
   * 来源：Phase 3 (2026-05-30 item #3) — 前端 b/sales-customers/detail._loadParents
   *   现 mock 空数组 + TODO，需补真值。
   *
   * Body: { tenantId, tenantSchema?, studentId }
   *   - tenantId（必填，TenantScopeGuard 校验 === jwt.tenantId）
   *   - tenantSchema（可选；若传 TenantScopeGuard 也校验；用于校验 studentId 确在本 tenant schema）
   *   - studentId（必填，32-char ULID）
   *
   * 跨租户硬隔离（双层）：
   *   1. TenantScopeGuard 校验 body.tenantId / tenantSchema === jwt（防伪造 tenant 标识）
   *   2. repo.findParentsForStudent 查询 WHERE bindings.tenant_id = jwt.tenantId
   *      （binding 在 public 跨租户表，必须按 tenant_id 过滤，防 sales 传他 tenant 的 studentId
   *       套出绑定关系 / 家长姓名）
   *   3. 若传 tenantSchema，额外 findBrief 校验 studentId 确属本 tenant（友好 404，且防探测）
   *
   * RBAC（SSOT §4.1 联系人信息 = 家长姓名/手机/微信）:
   *   sales / sales_manager / academic / academic_admin / admin / boss —
   *   **不含 teacher**（teacher ❌ 联系人信息，SSOT §4.1 / §2 一级 PII；
   *   teacher 看学员走 /db/students/:id 已硬脱敏家长字段）。
   *
   * PII：phone 强制脱敏（138****8000），不返明文 / openid / wechat。
   *   家长姓名对 sales/academic/admin/boss 合法可见（SSOT §4.1 自己客户/本校/全权）。
   *
   * 只读 → 不写 audit_log（无敏感变更），不加 Idempotency（无副作用）。
   */
  @Post('db/parents/by-student')
  @UseGuards(RbacGuard)
  @Roles('sales', 'sales_manager', 'academic', 'academic_admin', 'admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async listParentsForStudent(
    @Body()
    body: { tenantId: string; tenantSchema?: string; studentId: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<{ items: ParentForCustomerDetail[] }> {
    if (!body.tenantId || body.tenantId.length !== 32) {
      throw new BadRequestException('tenantId must be 32-char ULID');
    }
    if (!body.studentId || body.studentId.length !== 32) {
      throw new BadRequestException('studentId must be 32-char ULID');
    }

    // 跨租户兜底：TenantScopeGuard 已校验 body.tenantId===jwt，但 repo 查询仍以 jwt.tenantId
    //   为准（不信 body），双保险。jwt.tenantId 在 TenantScopeGuard 已确保非 null（tenant role）。
    const jwtTenantId = req.user?.tenantId;
    if (!jwtTenantId) {
      throw new ForbiddenException('tenant role requires non-null tenantId');
    }

    // 若提供 tenantSchema，校验 studentId 确属本 tenant schema（友好 404 + 防探测）。
    //   findBrief 内部 deleted_at IS NULL 过滤（V44 软删）。
    if (body.tenantSchema) {
      const student = await this.studentRepo.findBrief(body.tenantSchema, body.studentId);
      if (!student) {
        throw new NotFoundException(
          `student ${body.studentId} not found in current tenant`,
        );
      }
    }

    const items = await this.parentRepo.findParentsForStudent(
      body.studentId,
      jwtTenantId,
    );
    return { items };
  }

  /**
   * PATCH /api/db/parent-bindings/:bindingId — staff 解绑家长
   *
   * 来源: SSOT §12.5 解绑流程 + 用户拍板 D10 (仅写 audit_log, 不设 parent.status='停用')
   *
   * Body: { tenantId, tenantSchema, action: 'unbind' }
   *
   * 行为:
   *   - 校验 binding.tenant_id === jwt.tenantId (防跨 tenant 操作)
   *   - 调用 parentRepo.unbind: SET binding_status='unbound', unbound_at=NOW()
   *   - audit_log parent.unbound-by-staff
   *   - 不动 parent (parent 可能仍绑其他孩子 / 跨 tenant 共享 SSOT §12.5)
   *
   * RBAC: 同 createParent
   */
  @Patch('db/parent-bindings/:bindingId')
  @UseGuards(RbacGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @Roles('sales', 'sales_manager', 'academic', 'academic_admin', 'admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async unbindBinding(
    @Param('bindingId') bindingId: string,
    @Body() body: { tenantId: string; tenantSchema: string; action: 'unbind' },
    @Req() req: AuthenticatedRequest,
  ): Promise<{ binding: ParentStudentBinding }> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    if (!body.tenantId || body.tenantId.length !== 32) {
      throw new BadRequestException('tenantId must be 32-char ULID');
    }
    if (body.action !== 'unbind') {
      throw new BadRequestException('action must be "unbind"');
    }
    if (!bindingId || bindingId.length !== 32) {
      throw new BadRequestException('bindingId must be 32-char ULID');
    }
    const operatorUserId = req.user?.sub;
    if (!operatorUserId) throw new BadRequestException('user sub required');

    // 校验 binding.tenant_id === jwt.tenantId (跨 tenant 防御)
    //   parent_student_bindings 在 public schema; findChildrenByParent 不便, 直接 SQL
    //   走 ParentRepository 的 helper 不存在 → 用 parentRepo.unbind 内部错误兜底
    //   但需要 pre-check 防 unbind 别人 tenant 的 binding
    //
    //   实施: 直接调 unbind, 内部用 RETURNING 拿 tenant_id 比对
    //   不存在 → NotFoundException; 跨 tenant → ForbiddenException + audit
    const target = await this.findBindingForTenantOrFail(bindingId, body.tenantId, req);

    // 幂等: 已 unbound 直接返 (audit 不重复写)
    if (target.bindingStatus === 'unbound') {
      return { binding: target };
    }

    const unbound = await this.parentRepo.unbind(bindingId);

    // audit_log V33 (D10 仅写 log, 不动 parents.status)
    await this.auditLog.log(body.tenantSchema, {
      actorUserId: operatorUserId,
      actorRole: normalizeActorRole(req.user?.role),
      action: 'parent.unbound-by-staff',
      targetType: 'parent_student_binding',
      targetId: unbound.id,
      before: { bindingStatus: 'active' },
      after: { bindingStatus: 'unbound', unboundAt: unbound.unboundAt?.toISOString() },
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      requestId: (req.headers['x-request-id'] as string | undefined) ?? null,
    });

    return { binding: unbound };
  }

  /**
   * Helper: 反查 binding + 校验 tenant_id 匹配 (防跨 tenant 操作)
   *
   * - binding 不存在 → 404
   * - binding.tenant_id !== jwt.tenantId → 403 + pino warn ops
   */
  private async findBindingForTenantOrFail(
    bindingId: string,
    expectedTenantId: string,
    req: AuthenticatedRequest,
  ): Promise<ParentStudentBinding> {
    const binding = await this.parentRepo.findBindingById(bindingId);
    if (!binding) {
      throw new NotFoundException(`binding ${bindingId} not found`);
    }
    if (binding.tenantId !== expectedTenantId) {
      this.logger.warn(
        `[parent-unbind.cross-tenant-denied] operator=${req.user?.sub} expected=${expectedTenantId} actual=${binding.tenantId} bindingId=${bindingId}`,
      );
      throw new ForbiddenException('binding does not belong to current tenant');
    }
    return binding;
  }
}
