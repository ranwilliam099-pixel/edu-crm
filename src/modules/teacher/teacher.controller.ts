import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Optional,
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
// Sprint B.5 (2026-05-11): audit_log 业务写
//   - createTeacher / createTeacherInDb / archive 写 audit_log
//   - phone 走 mask 入 audit（避免明文 PII 落 audit_log）
import { ActorRole, AuditLogRepository, normalizeActorRole } from '../db/audit-log.repository';

/**
 * TeacherController — V7 教师独立档案 HTTP 暴露 BE-V7-1
 *
 * 路由前缀：/api/teachers
 *
 * RBAC（按 V2 8 枚举）：
 *   - 创建/状态变更：admin / boss / hr（管理类）
 *   - 查询：admin / boss / hr / sales_manager（管理可视） — 5/15 A-2 删 sales_director
 *
 * Sprint B (2026-05-11) 深度防御：
 *   - class-level @UseGuards(TenantScopeGuard) — 兜底所有 endpoint 跨租户校验
 *   - body.tenantSchema 校验由 TenantScopeGuard 完成（守护 db/list、db/archive 等）
 *
 * USER-AUTH(2026-05-02): 条目 29 方向 B + 条目 31 #2 + 条目 32 L1
 */
@UseGuards(TenantScopeGuard)
@Controller('teachers')
export class TeacherController {
  constructor(
    private readonly service: TeacherService,
    private readonly repo: TeacherRepository,
    // Sprint B.5 (2026-05-11): audit_log 业务写
    //   - @Optional：unit spec 直接 new 不传也能跑（兼容现有 spec 测试）
    //   - fail-open：log() 写失败不阻塞主业务
    @Optional() private readonly auditLog?: AuditLogRepository,
  ) {}

  /**
   * Sprint B.5 helper：PII 脱敏（phone 13800138000 → '138****8000'）
   */
  private maskPhoneForAudit(phone: string | null | undefined): string | null {
    if (!phone || typeof phone !== 'string') return null;
    if (phone.length < 7) return '***';
    return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
  }

  /**
   * Sprint B.5 helper：从 req 取 audit 上下文
   */
  private auditCtx(req: AuthenticatedRequest | undefined): {
    actorRole: ActorRole;
    ip: string | null;
    userAgent: string | null;
    requestId: string | null;
  } {
    return {
      // T-DEADCODE-CLEANUP W1 (2026-05-17 business-rules validator pre-existing finding):
      //   与 H4 同性质合规修 — fallback 'admin' → 'system' (audit-log Sprint E #3 round 5 拍板)
      actorRole: normalizeActorRole(req?.user?.role),
      ip: req?.ip ?? null,
      userAgent: (req?.headers?.['user-agent'] as string | undefined) ?? null,
      requestId: (req?.headers?.['x-request-id'] as string | undefined) ?? null,
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
   * POST /api/teachers — 创建教师档案
   */
  @Post()
  @UseGuards(RbacGuard)
  @Roles('admin', 'boss')
  @HttpCode(HttpStatus.CREATED)
  createTeacher(@Body() dto: CreateTeacherDto): Teacher {
    return this.service.createTeacher(dto);
  }

  /**
   * POST /api/teachers/:id/status — 教师状态机转换
   */
  @Post(':id/status')
  @UseGuards(RbacGuard)
  @Roles('admin', 'boss')
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
   *
   * Sprint B.5: 写 audit_log teacher.create（phone 脱敏入 audit）
   */
  @Post('db')
  @UseGuards(RbacGuard)
  @Roles('admin', 'boss')
  @HttpCode(HttpStatus.CREATED)
  async createTeacherInDb(
    @Body() body: CreateTeacherDto & { tenantSchema: string },
    @Req() req?: AuthenticatedRequest,
  ): Promise<Teacher> {
    const { tenantSchema, ...dto } = body;
    const result = await this.service.createTeacherInDb(dto, tenantSchema);

    // Sprint B.5: audit_log teacher.create（phone 走 mask 入 audit）
    if (req) {
      await this.tryAudit(tenantSchema, {
        actorUserId: req.user?.sub ?? dto.operator ?? null,
        ...this.auditCtx(req),
        action: 'teacher.create',
        targetType: 'teacher',
        targetId: result.id,
        before: null,
        after: {
          id: result.id,
          campusId: result.campusId,
          name: result.name,
          phoneMask: this.maskPhoneForAudit(result.phone),
          userId: result.userId ?? null,
          subjects: result.subjects,
          // Day 2 Phase C X1 (2026-05-19): hourlyPriceYuan 物理删除 — audit 不再记录
          status: result.status,
        },
      });
    }

    return result;
  }

  /**
   * POST /api/teachers/db/list — 真 PG 查询全部 active 教师
   *
   * 2026-05-22: 加 academic — schedule.create = [academic] (SSOT §6) 教务排课必须能看老师清单
   *   academic / academic_admin 教务双层：排课页选老师必备
   *   sales / sales_manager: teacher-showcase/list 销售拉新视角看老师业务展示卡
   */
  @Post('db/list')
  @UseGuards(RbacGuard)
  // Day 2 BLOCKER 4 (2026-05-19): SSOT §1「❌ hr 5/14 Wave 1 删」+ 5/15 A-2「删 sales_director」
  // 2026-05-22 加 academic/academic_admin: 教务排课页选老师场景 + sales: showcase 销售拉新视角
  @Roles('admin', 'boss', 'sales_manager', 'academic', 'academic_admin', 'sales')
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
  @Roles('admin', 'boss')
  @HttpCode(HttpStatus.OK)
  async archive(
    @Param('id') id: string,
    @Body() body: { tenantId: string; tenantSchema: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<TeacherArchiveResult> {
    if (!body.tenantSchema) throw new BadRequestException('tenantSchema required');
    const operator = req.user?.sub || 'system';
    const result = await this.repo.archive(body.tenantSchema, id, operator, {
      role: req.user?.role || null,
      campusId: req.user?.campusId ?? null,
    });

    // Sprint B.5: audit_log teacher.archive（高敏感操作 — 注销老师 + 学生转移）
    //   before status='在职' / '请假'（result.teacher 已是 '归档' 状态）
    //   after 含 transferToTeacherId / studentsReassigned 便于追溯
    await this.tryAudit(body.tenantSchema, {
      actorUserId: req.user?.sub ?? null,
      ...this.auditCtx(req),
      action: 'teacher.archive',
      targetType: 'teacher',
      targetId: id,
      // teacher.archive 在 repo 层已设 status='归档'；before 的 'active' 是逻辑推断
      // （repo.archive 会拒绝 status='归档' 的 teacher，所以 before 必然是 '在职' 或 '请假'）
      before: { status: 'active' },
      after: {
        teacherId: result.teacher.id,
        teacherName: result.teacher.name,
        campusId: result.teacher.campusId,
        status: result.teacher.status, // 应为 '归档'
        transferToTeacherId: result.transferToTeacherId,
        transferToTeacherName: result.transferToTeacherName,
        studentsReassigned: result.studentsReassigned,
      },
    });

    return result;
  }
}
