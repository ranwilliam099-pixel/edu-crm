import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Optional,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { StudentRepository, StudentBrief, StudentDetail, StudentTransferResult } from './student.repository';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';
import { Roles } from '../../guards/rbac.decorator';
import { RbacGuard } from '../../guards/rbac.guard';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';
// Sprint B.3 (2026-05-11): student 范围过滤
//   - sales 只看 owner_sales_id=me
//   - teacher 只看 assigned_teacher_id=ownTeacherId（OOUX 主带）
//   - admin / boss / academic / sales_manager：全部（5/15 A-2 删 sales_director）
// 注：student 现 schema 无 phone/家庭住址等 PII（仅 brief 字段），不做字段 mask
import { actorGroupOf } from '../../common/role-field-filter';
import { TeacherRepository } from './teacher.repository';
// Sprint B.3 复审 (2026-05-11) 修 4 OOUX:
//   - POST /db/students/:id/contracts 新 endpoint（contract 是 student 子对象）
//   - 复用 ContractRepository.create，保持业务规则一致
//   - 旧 POST /db/contracts 保留向后兼容（前端迁移完才删）
import { ContractRepository, Contract, OrderType } from './contract.repository';
// Sprint B.5 (2026-05-11): audit_log 业务写
//   - create / transferSales / transferTeacher / createContract 写 audit_log
//   - student 表无 phone/PII（仅 studentName 等 brief 字段），snapshot 直接入
import { ActorRole, AuditLogRepository, normalizeActorRole } from './audit-log.repository';

/**
 * StudentController — V28 学生归属转移 HTTP 暴露
 *
 * 路径前缀 /api/db/students/*
 *
 * 来源：用户 2026-05-07「学生也可以切换给别的老师和销售」
 *
 * Endpoints:
 *   POST /db/students/:id/transfer-sales   学生 → 另一个销售（admin/boss/sales 自己转）
 *   POST /db/students/:id/transfer-teacher 学生主带老师 → 另一个老师（admin/boss/hr）
 *
 * RBAC：
 *   transfer-sales：admin / boss / sales / sales_manager（销售可主动转给同事，校长可调整归属）
 *   transfer-teacher：admin / boss / hr（教学主管类决策）
 */
@Controller('db/students')
@UseGuards(TenantScopeGuard)
export class StudentController {
  constructor(
    private readonly repo: StudentRepository,
    // Sprint B.3：teacher role 范围过滤需要把 req.user.sub (users.id) 映射回 teachers.id
    private readonly teacherRepo: TeacherRepository,
    // Sprint B.3 复审：OOUX POST /db/students/:id/contracts 复用合同写入
    private readonly contractRepo: ContractRepository,
    // Sprint B.5 (2026-05-11): audit_log 业务写
    //   - @Optional：unit spec 直接 new 不传也能跑（兼容现有 spec 测试）
    //   - fail-open：log() 写失败不阻塞主业务
    @Optional() private readonly auditLog?: AuditLogRepository,
  ) {}

  /**
   * Sprint B.5 helper：从 req 取 audit 上下文
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

  /**
   * V29 R2 销售即时建学生（替代仅 batch import）
   *
   * 来源：用户 2026-05-07「全做」— 销售签约前临时新增学员
   *
   * Body:
   *   id            32-char ULID（前端生成）
   *   studentName   学员名 *
   *   customerId    家长 customer.id *（FK，必须已存在）
   *   gradeOrAge / intendedSubject / schoolName / gender / assignedTeacherId — 可选
   *   ownerSalesId 自动 = req.user.sub（销售自己创建归自己）
   *
   * RBAC：sales / sales_manager / boss / admin（5/15 A-2 删 sales_director）
   */
  @Post()
  @UseGuards(RbacGuard)
  @Roles('sales', 'sales_manager', 'boss', 'admin')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body()
    body: {
      tenantId: string;
      tenantSchema: string;
      id: string;
      studentName: string;
      customerId: string;
      gradeOrAge?: string;
      intendedSubject?: string;
      schoolName?: string;
      gender?: '男' | '女' | '未知';
      assignedTeacherId?: string;
    },
    @Req() req: AuthenticatedRequest,
  ) {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    const operatorUserId = req.user?.sub;
    if (!operatorUserId) throw new BadRequestException('user sub required');
    const result = await this.repo.create(body.tenantSchema, {
      id: body.id,
      studentName: body.studentName,
      customerId: body.customerId,
      gradeOrAge: body.gradeOrAge,
      intendedSubject: body.intendedSubject,
      schoolName: body.schoolName,
      gender: body.gender,
      ownerSalesId: operatorUserId, // 销售自建归自己
      assignedTeacherId: body.assignedTeacherId,
      operatorUserId,
    });

    // Sprint B.5: audit_log student.create（student brief 无 PII，全字段入 audit）
    await this.tryAudit(body.tenantSchema, {
      actorUserId: operatorUserId,
      ...this.auditCtx(req),
      action: 'student.create',
      targetType: 'student',
      targetId: result.id,
      before: null,
      after: {
        id: result.id,
        studentName: result.studentName,
        customerId: result.customerId,
        ownerSalesId: result.ownerSalesId,
        assignedTeacherId: result.assignedTeacherId,
        gradeOrAge: result.gradeOrAge,
        intendedSubject: result.intendedSubject,
      },
    });

    return result;
  }

  /**
   * V29 R4 老师视角：列该老师主带学生（OOUX teacher → students[]）
   *
   * 用户 2026-05-07 OOUX 哲学 — 老师详情一站式
   *
   * RBAC（Sprint B.3 复审 2026-05-11 红线 A01 收紧）：
   *   - teacher / admin / boss / academic / academic_admin /
   *     sales / sales_manager 7 role 读权限（5/15 A-2 删 sales_director）
   *   - 拍板「sales 看老师推荐」需可看主带学生列表
   *   - finance / hr / parent 不该看（教学线对象，不参与作账/HR）
   *
   * teacher self-cover（拍板 OOUX 老师只看自己主带学生）：
   *   - 若 req.user.role === 'teacher'，强制覆盖 path teacherId 为 ownTeacherId
   *     （teacherRepo.findByUserId 反查 users.id → teachers.id）
   *   - UX 友好：不抛 403，自动改为查"自己"（一致 listAll 设计）
   *   - 未绑定 teachers.user_id 的 teacher → 空列表（fail-safe，不抛错）
   */
  /**
   * 2026-05-21 销售可随时编辑学员字段（V55 新增 + 已有 6 字段）
   *   PATCH /db/students/:id?tenantSchema=
   *   Body: { studentName?, gradeOrAge?, intendedSubject?, gender?, school?, phone?, availableTime? }
   *   RBAC: sales/sales_manager/boss/admin/academic/academic_admin 可改
   *         （RbacGuard 已挡 finance/teacher/parent；service 层暂不校验 owner_sales_id 收紧, Sprint Y 补）
   */
  @Patch(':id')
  @UseGuards(RbacGuard)
  @Roles('sales', 'sales_manager', 'boss', 'admin', 'academic', 'academic_admin')
  @HttpCode(HttpStatus.OK)
  async updateStudent(
    @Param('id') id: string,
    @Query('tenantSchema') tenantSchema: string,
    @Body()
    body: {
      studentName?: string;
      gradeOrAge?: string | null;
      intendedSubject?: string | null;
      gender?: string | null;
      school?: string | null;
      phone?: string | null;
      availableTime?: string[] | null;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<{ ok: true }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    if (!id || id.length !== 32) {
      throw new BadRequestException('studentId must be 32-char ULID');
    }
    const operatorUserId = req.user?.sub;
    if (!operatorUserId) throw new BadRequestException('user sub required');
    await this.repo.update(tenantSchema, id, operatorUserId, body);
    return { ok: true };
  }

  /**
   * 2026-05-21 新增 — 学员档案完整详情（b/student/detail page 用）
   *   GET /db/students/:id?tenantSchema=tenant_xxx
   *   返回 StudentDetail (学员 + 主家长 + 校区 + owner 销售 + 主带老师 JOIN)
   *   RBAC: admin/boss/sales/sales_manager/academic/academic_admin/teacher 都可读
   *     - finance 角色禁访（学员档案不涉及财务）
   *     - parent 走 c/student-profile 不走 B 端
   *   注：parentPhone 前端 maskPhone 处理，finance role 此处禁访所以无需后端 mask
   */
  @Get(':id')
  @UseGuards(RbacGuard)
  @Roles(
    'admin',
    'boss',
    'sales',
    'sales_manager',
    'academic',
    'academic_admin',
    'teacher',
  )
  @HttpCode(HttpStatus.OK)
  async findById(
    @Param('id') id: string,
    @Query('tenantSchema') tenantSchema: string,
  ): Promise<StudentDetail> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    if (!id || id.length !== 32) {
      throw new BadRequestException('studentId must be 32-char ULID');
    }
    const detail = await this.repo.findFullDetail(tenantSchema, id);
    if (!detail) {
      throw new NotFoundException(`student ${id} not found`);
    }
    return detail;
  }

  @Get('by-teacher/:teacherId')
  @UseGuards(RbacGuard)
  @Roles(
    'teacher',
    'admin',
    'boss',
    'academic',
    'academic_admin',
    'sales',
    'sales_manager',
    // 5/15 A-2：删 'sales_director'（不在拍板角色清单）
  )
  @HttpCode(HttpStatus.OK)
  async listByTeacher(
    @Param('teacherId') teacherId: string,
    @Query('tenantSchema') tenantSchema: string,
    @Req() req?: AuthenticatedRequest,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<{ items: StudentBrief[] }> {
    if (!tenantSchema) throw new BadRequestException('tenantSchema required');
    if (!teacherId || teacherId.length !== 32) {
      throw new BadRequestException('teacherId must be 32-char ULID');
    }

    // Sprint B.3 复审：teacher self-cover
    //   - teacher role → 强制改为查自己（不论 path 传什么 teacherId）
    //   - 未绑定 teachers 行 → 空列表（不抛 403，UX 友好）
    let effectiveTeacherId = teacherId;
    if (req?.user?.role === 'teacher' && req.user.sub) {
      const ownTeacher = await this.teacherRepo.findByUserId(
        tenantSchema,
        req.user.sub,
      );
      if (!ownTeacher) {
        // 未绑定 teachers.user_id 的 teacher → 空列表（一致 listAll）
        return { items: [] };
      }
      effectiveTeacherId = ownTeacher.id;
    }

    const items = await this.repo.listByTeacher(tenantSchema, effectiveTeacherId, {
      limit: limit ? Math.min(parseInt(limit, 10), 200) : 100,
      offset: offset ? parseInt(offset, 10) : 0,
    });
    return { items };
  }

  @Post('list')
  @UseGuards(RbacGuard)
  // Day 2 BLOCKER 4 (2026-05-19): SSOT §1「❌ hr 5/14 Wave 1 删」+ 5/15 A-2「删 sales_director」
  @Roles(
    'sales',
    'sales_manager',
    'boss',
    'admin',
    'teacher',
    'academic',
    'academic_admin',
  )
  @HttpCode(HttpStatus.OK)
  async listAll(
    @Body()
    body: {
      tenantSchema: string;
      limit?: number;
      offset?: number;
      ownerSalesId?: string;
      assignedTeacherId?: string;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<{ items: StudentBrief[] }> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');

    // Sprint B.3：范围过滤
    //   - sales（个人）：强制 ownerSalesId = req.user.sub（即便 body 传别人也覆盖）
    //   - teacher：强制 assignedTeacherId = ownTeacherId（反查 teachers.user_id）
    //   - admin / boss / academic / sales_manager / hr：按 body 传的过滤（或全部）
    //     5/15 A-2 删 sales_director
    let ownerSalesId = body.ownerSalesId;
    let assignedTeacherId = body.assignedTeacherId;
    const group = actorGroupOf(req.user?.role);
    if (group === 'sales' && req.user?.sub) {
      // 个人销售强制 owner=me；UX 友好：忽略 body 传的 ownerSalesId
      ownerSalesId = req.user.sub;
    }
    if (req.user?.role === 'teacher') {
      // 老师反查自己的 teachers.id
      const ownTeacher = await this.teacherRepo.findByUserId(
        body.tenantSchema,
        req.user.sub,
      );
      if (!ownTeacher) {
        // 未绑定老师档案 → 空列表（不拒绝，因为 home 可能仍调）
        return { items: [] };
      }
      assignedTeacherId = ownTeacher.id;
    }

    const items = await this.repo.listAll(body.tenantSchema, {
      limit: body.limit ? Math.min(body.limit, 200) : 100,
      offset: body.offset || 0,
      ownerSalesId,
      assignedTeacherId,
    });
    return { items };
  }

  /**
   * Sprint B.3 复审 (2026-05-11) — 修 4 OOUX：POST /db/students/:id/contracts
   *
   * 拍板：contract 是 student 子对象（OOUX 中心：student → contracts[]）
   *   - 旧路径 POST /db/contracts 保留向后兼容（前端迁移完才删）
   *   - 新路径 POST /db/students/:id/contracts 符合资源归属语义
   *
   * Body（同旧 POST /db/contracts，但 studentId 来自 path）：
   *   tenantId / tenantSchema / id（合同 ULID）
   *   courseProductId | courseProductName （二选一）
   *   lessonHours / standardPrice / totalAmount
   *   opportunityId / campusId / classType / discountAmount / giftHours / orderType / signedAt / note 可选
   *
   * RBAC：sales / sales_manager / boss / admin（拍板「销售签约」）— 5/15 A-2 删 sales_director
   * ownerUserId 自动 = req.user.sub（签约归签约销售）
   */
  @Post(':id/contracts')
  @UseGuards(RbacGuard)
  @Roles('sales', 'sales_manager', 'boss', 'admin')
  @HttpCode(HttpStatus.CREATED)
  async createContract(
    @Param('id') studentId: string,
    @Body()
    body: {
      tenantId: string;
      tenantSchema: string;
      id: string;
      courseProductId?: string;
      courseProductName?: string;
      opportunityId?: string;
      campusId?: string;
      classType?: string;
      lessonHours: number;
      standardPrice: number;
      discountAmount?: number;
      giftHours?: number;
      totalAmount: number;
      orderType?: OrderType;
      signedAt?: string;
      note?: string;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<Contract> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    if (!studentId || studentId.length !== 32) {
      throw new BadRequestException('studentId must be 32-char ULID');
    }
    if (!body.courseProductId && !body.courseProductName) {
      throw new BadRequestException(
        'courseProductId 与 courseProductName 至少传一个（销售自填或选既有产品）',
      );
    }
    if (typeof body.totalAmount !== 'number') {
      throw new BadRequestException('totalAmount required');
    }
    const ownerUserId = req.user?.sub;
    if (!ownerUserId) throw new BadRequestException('user sub required');
    // V26 校区归属：跨校 role（admin/hr，5/15 A-2 删 sales_director）允许 body.campusId 显式传，
    // 单校 role 从 jwt.campusId 自动填
    const campusId = body.campusId || req.user?.campusId || null;
    const result = await this.contractRepo.create(body.tenantSchema, {
      id: body.id,
      studentId, // path → repo（OOUX 子对象归属）
      courseProductId: body.courseProductId,
      courseProductName: body.courseProductName,
      ownerUserId,
      opportunityId: body.opportunityId,
      campusId,
      classType: body.classType,
      lessonHours: body.lessonHours,
      standardPrice: body.standardPrice,
      discountAmount: body.discountAmount,
      giftHours: body.giftHours,
      totalAmount: body.totalAmount,
      orderType: body.orderType,
      signedAt: body.signedAt,
      note: body.note,
    });

    // Sprint B.5: audit_log contract.create（OOUX 子对象路径 — 同 contract.create action）
    //   金额字段不脱敏：合同变更追溯需要 totalAmount/standardPrice/discountAmount
    await this.tryAudit(body.tenantSchema, {
      actorUserId: ownerUserId,
      ...this.auditCtx(req),
      action: 'contract.create',
      targetType: 'contract',
      targetId: result.id,
      before: null,
      after: {
        id: result.id,
        studentId: result.studentId,
        ownerUserId: result.ownerUserId,
        opportunityId: result.opportunityId,
        campusId: result.campusId,
        courseProductId: result.courseProductId,
        courseProductName: result.courseProductName,
        classType: result.classType,
        lessonHours: result.lessonHours,
        standardPrice: result.standardPrice,
        discountAmount: result.discountAmount,
        giftHours: result.giftHours,
        totalAmount: result.totalAmount,
        orderType: result.orderType,
        status: result.status,
        signedAt: result.signedAt,
        // OOUX 入口标识：区分 POST /db/contracts vs POST /db/students/:id/contracts
        sourceEndpoint: 'student-children',
      },
    });

    return result;
  }

  @Post(':id/transfer-sales')
  @UseGuards(RbacGuard)
  @Roles('admin', 'boss', 'sales', 'sales_manager') // 5/15 A-2：删 'sales_director'
  @HttpCode(HttpStatus.OK)
  async transferSales(
    @Param('id') id: string,
    @Body()
    body: {
      tenantId: string;
      tenantSchema: string;
      toSalesId: string | null;
      reason?: string;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<StudentTransferResult> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    const operatorRole = req.user?.role || 'sales';
    const reason =
      body.reason ||
      (operatorRole === 'admin' || operatorRole === 'boss'
        ? '校长再分配'
        : '销售主动转交');
    const result = await this.repo.transferSales(
      body.tenantSchema,
      id,
      body.toSalesId === undefined ? null : body.toSalesId,
      reason,
    );

    // Sprint B.5: audit_log student.transfer-sales（高敏感转移 — 学生归属变更）
    await this.tryAudit(body.tenantSchema, {
      actorUserId: req.user?.sub ?? null,
      ...this.auditCtx(req),
      action: 'student.transfer-sales',
      targetType: 'student',
      targetId: id,
      before: { ownerSalesId: result.fromUserId },
      after: {
        ownerSalesId: result.toUserId,
        field: result.field,
        reason: result.reason,
      },
    });

    return result;
  }

  @Post(':id/transfer-teacher')
  @UseGuards(RbacGuard)
  // Day 2 BLOCKER 4 (2026-05-19): SSOT §1「❌ hr 5/14 Wave 1 删」
  @Roles('admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async transferTeacher(
    @Param('id') id: string,
    @Body()
    body: {
      tenantId: string;
      tenantSchema: string;
      toTeacherId: string | null;
      reason?: string;
    },
    @Req() req?: AuthenticatedRequest,
  ): Promise<StudentTransferResult> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    const result = await this.repo.transferTeacher(
      body.tenantSchema,
      id,
      body.toTeacherId === undefined ? null : body.toTeacherId,
      body.reason || '校长再分配',
    );

    // Sprint B.5: audit_log student.transfer-teacher（高敏感 — 主带老师变更）
    if (req) {
      await this.tryAudit(body.tenantSchema, {
        actorUserId: req.user?.sub ?? null,
        ...this.auditCtx(req),
        action: 'student.transfer-teacher',
        targetType: 'student',
        targetId: id,
        before: { assignedTeacherId: result.fromUserId },
        after: {
          assignedTeacherId: result.toUserId,
          field: result.field,
          reason: result.reason,
        },
      });
    }

    return result;
  }
}
