import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Optional,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ContractRepository,
  Contract,
  ContractStatus,
  OrderType,
  SalesPerformance,
} from './contract.repository';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';
import { Roles } from '../../guards/rbac.decorator';
import { RbacGuard } from '../../guards/rbac.guard';
// Sprint B.3 (2026-05-11): contract 字段级权限（教学人员不看金额；sales 不看他人合同金额）
import {
  maskContract,
  canAccessContract,
  actorGroupOf,
} from '../../common/role-field-filter';
// Sprint B.3 复审 (2026-05-11) — 修 3 by-student scope filter:
//   - 用 studentRepo.findBrief 拿 ownerSalesId / assignedTeacherId
//   - sales 只看自己 owner 的学生合同；teacher 只看自己 assigned 的；其他 admin/finance/academic 放行
import { StudentRepository } from './student.repository';
import { TeacherRepository } from './teacher.repository';
// Sprint B.5 (2026-05-11): audit_log 业务写 + 拒绝路径
//   - create 写 audit_log（金额详情入 audit 用于变更溯源 — 不脱敏，财务/审计场景必需）
//   - canAccessContract 失败前 audit 'contract.access-denied'
import { ActorRole, AuditLogRepository, normalizeActorRole } from './audit-log.repository';

/**
 * ContractController — V25 签约管理 HTTP 暴露（业绩数据源头）
 *
 * 路径前缀 /api/db/contracts/*
 *
 * Endpoints:
 *   GET  /db/contracts/mine                  我的签约列表（按 owner_user_id）
 *   GET  /db/contracts/performance           我的业绩 KPI（本月 + 累计）
 *   GET  /db/contracts/:contractId           详情
 *   POST /db/contracts                       新增签约（业绩录入入口）
 *   POST /db/contracts/:contractId/activate  激活（pending → active）
 *
 * P1-T8 (2026-05-23): @Param('id') → @Param('contractId') 语义化重命名
 *   - URL 完全不变（NestJS 位置匹配；前端 0 改动）
 *   - 仅 controller decorator + 局部变量重命名
 *   - 配套 docs/API-接口参数规范-2026-05-23.md §3.1
 */
@Controller('db/contracts')
@UseGuards(TenantScopeGuard, RbacGuard)
export class ContractController {
  constructor(
    private readonly repo: ContractRepository,
    // Sprint B.3 复审: by-student scope filter 需查 student 归属
    private readonly studentRepo: StudentRepository,
    // Sprint B.3 复审: teacher role 反查 ownTeacherId
    private readonly teacherRepo: TeacherRepository,
    // Sprint B.5 (2026-05-11): audit_log 业务写 + 拒绝路径
    //   - @Optional：unit spec 直接 new 不传也能跑（兼容现有 spec 测试）
    //   - fail-open：log() 写失败仅 logger.warn 不抛主业务
    @Optional() private readonly auditLog?: AuditLogRepository,
  ) {}

  /**
   * Sprint B.5 helper：从 req 取 audit 上下文（ip/ua/req-id + actorRole）
   */
  private auditCtx(req: AuthenticatedRequest): {
    actorRole: ActorRole;
    ip: string | null;
    userAgent: string | null;
    requestId: string | null;
  } {
    return {
      // T-DEADCODE-CLEANUP H4 (2026-05-17): normalizeActorRole 替换 unsafe cast
      actorRole: normalizeActorRole(req.user?.role),
      ip: req.ip ?? null,
      userAgent: (req.headers?.['user-agent'] as string | undefined) ?? null,
      requestId: (req.headers?.['x-request-id'] as string | undefined) ?? null,
    };
  }

  /**
   * Sprint B.5 helper：写 audit_log，try-catch 不阻塞主业务
   */
  private async tryAudit(
    tenantSchema: string,
    entry: {
      actorUserId: string | null;
      actorRole: ActorRole;
      action: string;
      targetType: string;
      targetId: string | null;
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
      ip: string | null;
      userAgent: string | null;
      requestId: string | null;
    },
  ): Promise<void> {
    try {
      await this.auditLog?.log(tenantSchema, entry);
    } catch {
      // fail-open
    }
  }

  @Get('mine')
  // 2026-05-29 §12C.2 拍板：finance 可看合同列表（作账用）。Contract 仅含金额/学员ID/状态，
  //   无联系人字段（无 PII 泄露面）；maskContract 按 owner/角色控金额可见性。finance 角色正式保留。
  @Roles('sales', 'sales_manager', 'boss', 'admin', 'finance')
  @HttpCode(HttpStatus.OK)
  async listMine(
    @Query('tenantSchema') tenantSchema: string,
    @Query('status') status?: ContractStatus,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Req() req?: AuthenticatedRequest,
  ): Promise<{ items: Contract[] }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const ownerUserId = req?.user?.sub;
    if (!ownerUserId) throw new BadRequestException('user sub required');
    const items = await this.repo.listByOwner(tenantSchema, ownerUserId, {
      status,
      limit: limit ? Math.min(parseInt(limit, 10), 200) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
    });
    // Sprint B.3：listByOwner 已 SQL 过滤 owner=me，全字段
    //   sales 自己合同 → isOwnerSelf=true → 全字段
    //   admin/finance 调 mine（罕见）→ 走 admin/finance 路径自动全字段
    const items_masked = items.map((c) =>
      maskContract(c, req?.user, { isOwnerSelf: c.ownerUserId === ownerUserId }),
    );
    return { items: items_masked };
  }

  @Get('performance')
  @Roles('sales_manager', 'boss', 'admin') // T-NEW-1 defense-in-depth (Roles 待 SSOT 拍板, Sprint B backlog)
  @HttpCode(HttpStatus.OK)
  async myPerformance(
    @Query('tenantSchema') tenantSchema: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<SalesPerformance> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const ownerUserId = req.user?.sub;
    if (!ownerUserId) throw new BadRequestException('user sub required');
    return this.repo.getOwnerPerformance(tenantSchema, ownerUserId);
  }

  /**
   * 老板视角：团队业绩排行
   * admin（老板）/ boss（校长）/ sales_manager（销售主管）可调 — 5/30 §12D.4 加 boss
   * @query campusId V26 校区切换过滤
   */
  @Get('team-performance')
  @UseGuards(RbacGuard)
  @Roles('admin', 'boss', 'sales_manager') // 5/30 §12D.4：boss(校长) 可看团队业绩
  @HttpCode(HttpStatus.OK)
  async teamPerformance(
    @Query('tenantSchema') tenantSchema: string,
    @Query('campusId') campusId?: string,
  ): Promise<{
    items: Array<{
      ownerUserId: string;
      ownerName: string;
      totalCount: number;
      totalAmount: number;
      thisMonthCount: number;
      thisMonthAmount: number;
    }>;
  }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const items = await this.repo.getTeamPerformance(tenantSchema, campusId);
    return { items };
  }

  @Get(':contractId')
  @Roles('sales', 'sales_manager', 'boss', 'admin', 'academic', 'academic_admin', 'finance') // T-NEW-1 defense-in-depth (Roles 待 SSOT 拍板, Sprint B backlog)
  @HttpCode(HttpStatus.OK)
  async detail(
    @Param('contractId') contractId: string,
    @Query('tenantSchema') tenantSchema: string,
    @Req() req?: AuthenticatedRequest,
  ): Promise<Contract | { found: false }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    const c = await this.repo.findById(tenantSchema, contractId);
    if (!c) return { found: false };

    // Sprint B.3：scope filter 优先 — sales 别人合同 403
    //   admin/finance/academic/teacher/parent 都允许（具体字段在 mask 层裁剪）
    //   - teacher/parent 走 controller-level 学生关系校验交由调用方（OOUX 入口）
    //   - 此处只挡 sales other-owner 一个常见侧信道
    //
    // Sprint B.5 (2026-05-11) — 拒绝路径 audit_log：A09 安全留证
    if (!canAccessContract(c, req?.user)) {
      if (req) {
        await this.tryAudit(tenantSchema, {
          actorUserId: req.user?.sub ?? null,
          ...this.auditCtx(req),
          action: 'contract.access-denied',
          targetType: 'contract',
          targetId: contractId,
          before: null,
          after: {
            attempted_role: req.user?.role ?? 'unknown',
            attempted_owner: req.user?.sub ?? null,
            actual_owner: c.ownerUserId ?? null,
            endpoint: 'detail',
          },
        });
      }
      throw new ForbiddenException(
        `CONTRACT_ACCESS_DENIED: role=${req?.user?.role ?? 'unknown'} ` +
          `contractId=${contractId} owner=${c.ownerUserId ?? 'null'}`,
      );
    }

    // 字段级 mask
    const isOwnerSelf =
      req?.user?.sub !== undefined && c.ownerUserId === req.user.sub;
    return maskContract(c, req?.user, { isOwnerSelf });
  }

  /**
   * V29 R3 学员视角：列该学员所有合同（OOUX student → contracts[]）
   *
   * 用户 2026-05-07「合同也在学员里面」
   * 学员详情页 Section 6 真接此 endpoint。
   *
   * RBAC（Sprint B.3 复审 2026-05-11 红线 A01 收紧）：
   *   - scope filter：
   *     - admin / boss / finance / academic / academic_admin：放行
   *     - sales / sales_manager：student.ownerSalesId === req.user.sub 才放行
   *       （sales_manager 走 admin group 收口，全放行 — 5/15 A-2 删 sales_director）
   *     - teacher：student.assignedTeacherId === ownTeacherId 才放行
   *     - parent / hr：403（拍板 hr 不参与；parent 走 c 端独立 endpoint）
   *   - 失败 → ForbiddenException
   */
  @Get('by-student/:studentId')
  @Roles('sales', 'sales_manager', 'boss', 'admin', 'academic', 'academic_admin', 'finance') // T-NEW-1 defense-in-depth (Roles 待 SSOT 拍板, Sprint B backlog)
  @HttpCode(HttpStatus.OK)
  async listByStudent(
    @Param('studentId') studentId: string,
    @Query('tenantSchema') tenantSchema: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Req() req?: AuthenticatedRequest,
  ): Promise<{ items: Contract[] }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    if (!studentId || studentId.length !== 32) {
      throw new BadRequestException('studentId must be 32-char ULID');
    }

    // Sprint B.3 复审：scope filter 优先于字段过滤
    //   1. 查 student brief 拿 ownerSalesId / assignedTeacherId
    //   2. 按 role 判定可否访问
    //   3. 不在范围 → 403
    const student = await this.studentRepo.findBrief(tenantSchema, studentId);
    if (!student) {
      // 学生不存在 → 空数组（避免侧信道）
      return { items: [] };
    }

    const role = req?.user?.role;
    const group = actorGroupOf(role);
    const subId = req?.user?.sub;

    // admin / academic / finance group 全放行（拍板「老板校长 + 教务 + 财务 ✅」）
    // sales 个人（sales/marketing）：必须 student.ownerSalesId === me
    // teacher：必须 student.assignedTeacherId === ownTeacherId（反查 teachers.user_id）
    // parent / hr / unknown：403
    let allowed = false;
    if (group === 'admin' || group === 'academic' || group === 'finance') {
      allowed = true;
    } else if (group === 'sales' && subId) {
      allowed = student.ownerSalesId === subId;
    } else if (group === 'teacher' && subId) {
      const ownTeacher = await this.teacherRepo.findByUserId(tenantSchema, subId);
      if (ownTeacher) {
        allowed = student.assignedTeacherId === ownTeacher.id;
      }
    }
    // parent / hr / unknown 留 allowed=false

    if (!allowed) {
      // Sprint B.5: 拒绝路径 audit_log（endpoint='by-student'）
      if (req) {
        await this.tryAudit(tenantSchema, {
          actorUserId: subId ?? null,
          ...this.auditCtx(req),
          action: 'contract.access-denied',
          targetType: 'student',
          targetId: studentId,
          before: null,
          after: {
            attempted_role: role ?? 'unknown',
            attempted_owner: subId ?? null,
            actual_owner_sales: student.ownerSalesId ?? null,
            actual_assigned_teacher: student.assignedTeacherId ?? null,
            endpoint: 'by-student',
          },
        });
      }
      throw new ForbiddenException(
        `CONTRACT_BY_STUDENT_ACCESS_DENIED: role=${role ?? 'unknown'} ` +
          `studentId=${studentId} ownerSales=${student.ownerSalesId ?? 'null'} ` +
          `assignedTeacher=${student.assignedTeacherId ?? 'null'}`,
      );
    }

    const items = await this.repo.listByStudent(tenantSchema, studentId, {
      limit: limit ? Math.min(parseInt(limit, 10), 200) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
    });
    // Sprint B.3：from student/detail OOUX 进入
    //   teacher 主带学生合同 → 走 teacher path（金额全 0）
    //   sales 自己客户的孩子合同 → owner=me ✅，他 owner ❌ 0
    //   admin/finance/academic 走各自路径
    //   parent 自己孩子合同 → totalAmount 保留 + discountAmount/giftHours 0
    const items_masked = items.map((c) => {
      const isOwnerSelf = subId !== undefined && c.ownerUserId === subId;
      return maskContract(c, req?.user, { isOwnerSelf });
    });
    return { items: items_masked };
  }

  // Day 2 BLOCKER 5 (2026-05-19): 删 POST /api/db/contracts 独立端点
  //   SSOT §2 全局规则 1「OOUX 中心化：contract 是 student 的子对象」
  //   - 拍板「从 student/detail 一站式发起 action」— contract 必须从 student 子路径创建
  //   - 旧路径 POST /api/db/contracts 违反 OOUX 资源归属语义
  //   - 唯一合法路径：POST /api/db/students/:id/contracts（student.controller.ts:324）
  //   - 前端 miniprogram/pages/b/sales-contract/new/new.js:294 已迁移到子资源路径
  //
  // 验证：grep miniprogram/ 无非子路径调用本端点
  //   miniprogram/pages/b/sales-contract/new/new.js:294 用 /db/students/:id/contracts ✅
  //   miniprogram/pages/b/student/detail/detail.js:345 用 /db/contracts/by-student/:id (GET) ✅
  //   miniprogram/utils/openapi-schema.json:1592 旧 baseline，需重 gen

  // 2026-05-31 §6 权限矩阵 contract.activate 收口：@Roles 从误含
  //   sales/sales_manager/boss/admin → 仅 finance（销售不可绕财务把合同翻 active）。
  //   正途仍是 markPaid 派生激活（同事务建课时包）；本端点仅 finance 兜底，
  //   **不建课时包**，须配 audit_log（action='contract.activate'，记 before/after status）。
  @Post(':contractId/activate')
  @Roles('finance')
  @HttpCode(HttpStatus.OK)
  async activate(
    @Param('contractId') contractId: string,
    @Body() body: { tenantId: string; tenantSchema: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<Contract> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    const tenantSchema = body.tenantSchema;
    const userId = req.user?.sub;
    if (!userId) throw new BadRequestException('user sub required');

    // setStatus 前先取 before 状态用于 audit（NotFound 抛 setStatus 自带）
    const before = await this.repo.findById(tenantSchema, contractId);
    const result = await this.repo.setStatus(
      tenantSchema,
      contractId,
      'active',
      userId,
    );

    // audit_log：finance 激活留证（before.status / after.status）
    await this.tryAudit(tenantSchema, {
      actorUserId: userId,
      ...this.auditCtx(req),
      action: 'contract.activate',
      targetType: 'contract',
      targetId: contractId,
      before: { status: before?.status ?? null },
      after: { status: result.status },
    });

    return result;
  }
}
