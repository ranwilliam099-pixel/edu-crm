import {
  Body,
  Controller,
  Optional,
  Param,
  Post,
  HttpCode,
  HttpStatus,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  CourseBalanceService,
  CoursePackage,
  StudentCoursePackage,
} from './course-balance.service';
import { TenantScopeGuard } from '../../guards/tenant-scope.guard';
// 2026-05-29 全面检测 P0: 课时包「金钱」端点必须 RBAC（manifest §390 update=admin/boss/finance）
//   RbacGuard 对无 @Roles 的方法放行，故只锁 mutating 端点，读端点不受影响
import { RbacGuard } from '../../guards/rbac.guard';
import { Roles } from '../../guards/rbac.decorator';
// 2026-06-02 走查 D 安全审：db/students/:id/packages 缺 @Roles（fail-open）→ 补白名单 + by-student owner-scope。
//   该端点是 B/C 共享（B 端学员档案课时余额 / C 端家长看孩子余额），owner-scope 复用统一 helper。
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';
import { StudentRepository } from '../db/student.repository';
import { TeacherRepository } from '../db/teacher.repository';
import { ParentRepository } from '../db/parent.repository';
import { assertStudentByStudentScope } from '../../common/student-scope/student-by-student-scope';

/**
 * CourseBalanceController — V12 课时包 + 余额 HTTP 暴露 BE-V12-1
 *
 * 路由前缀：/api/course-balance
 *
 * USER-AUTH(2026-05-02): 教学链路 §1
 *
 * Sprint B.6 mini (2026-05-11) 深度防御：
 *   - class-level @UseGuards(TenantScopeGuard) — 兜底所有 /db endpoint 跨租户校验
 */
@UseGuards(TenantScopeGuard, RbacGuard)
@Controller('course-balance')
export class CourseBalanceController {
  constructor(
    private readonly service: CourseBalanceService,
    // 2026-06-02 走查 D：by-student owner-scope 需查学员归属 + teacher 反查 + parent 绑定。
    //   @Optional + 构造末尾：现有 service spec 直接 new(service) 不破坏；@Global DbModule 生产/e2e 必有。
    @Optional() private readonly studentRepo?: StudentRepository,
    @Optional() private readonly teacherRepo?: TeacherRepository,
    @Optional() private readonly parentRepo?: ParentRepository,
  ) {}

  /**
   * POST /api/course-balance/activate — 合同签约时激活课时包
   */
  @Post('activate')
  @Roles('admin', 'boss', 'finance')
  @HttpCode(HttpStatus.CREATED)
  activatePackage(
    @Body()
    body: {
      id: string;
      studentId: string;
      coursePackage: CoursePackage;
      contractId?: string;
      activatedAtMs?: number;
    },
  ): StudentCoursePackage {
    return this.service.activatePackage({
      id: body.id,
      studentId: body.studentId,
      coursePackage: body.coursePackage,
      contractId: body.contractId,
      activatedAt: body.activatedAtMs ? new Date(body.activatedAtMs) : undefined,
    });
  }

  /**
   * POST /api/course-balance/:packageId/deduct — schedule.complete 触发扣 1 课时
   */
  @Post(':packageId/deduct')
  @Roles('admin', 'boss', 'finance')
  @HttpCode(HttpStatus.OK)
  deduct(
    @Param('packageId') _id: string,
    @Body() body: { scp: StudentCoursePackage },
  ): { updated: StudentCoursePackage; lowBalanceAlertNow: boolean } {
    return this.service.deductOnConsumption(this.deserialize(body.scp));
  }

  /**
   * POST /api/course-balance/:packageId/refund — 退费冲减
   */
  @Post(':packageId/refund')
  @Roles('admin', 'boss', 'finance')
  @HttpCode(HttpStatus.OK)
  refund(
    @Param('packageId') _id: string,
    @Body() body: { scp: StudentCoursePackage; count: number },
  ): StudentCoursePackage {
    return this.service.refundLessons(this.deserialize(body.scp), body.count);
  }

  /**
   * POST /api/course-balance/check-schedulable — 排课前余额校验
   */
  @Post('check-schedulable')
  @HttpCode(HttpStatus.OK)
  checkSchedulable(
    @Body() body: { scp?: StudentCoursePackage; nowMs?: number },
  ): { canSchedule: boolean; reason?: string } {
    return this.service.checkSchedulable(
      body.scp ? this.deserialize(body.scp) : undefined,
      body.nowMs ? new Date(body.nowMs) : new Date(),
    );
  }

  /**
   * POST /api/course-balance/scan-expired — cron 每天扫到期
   */
  @Post('scan-expired')
  @HttpCode(HttpStatus.OK)
  scanExpired(
    @Body() body: { packages: StudentCoursePackage[]; nowMs?: number },
  ): StudentCoursePackage[] {
    return this.service.scanExpired(
      body.packages.map((p) => this.deserialize(p)),
      body.nowMs ? new Date(body.nowMs) : new Date(),
    );
  }

  /**
   * POST /api/course-balance/scan-low-balance — cron 扫低余额
   */
  @Post('scan-low-balance')
  @HttpCode(HttpStatus.OK)
  scanLowBalance(
    @Body() body: { packages: StudentCoursePackage[] },
  ): StudentCoursePackage[] {
    return this.service.scanLowBalanceAlerts(
      body.packages.map((p) => this.deserialize(p)),
    );
  }

  /**
   * POST /api/course-balance/:packageId/freeze — 学员请长假冻结
   */
  @Post(':packageId/freeze')
  @Roles('admin', 'boss', 'finance')
  @HttpCode(HttpStatus.OK)
  freeze(
    @Param('packageId') _id: string,
    @Body() body: { scp: StudentCoursePackage },
  ): StudentCoursePackage {
    return this.service.freeze(this.deserialize(body.scp));
  }

  /**
   * POST /api/course-balance/:packageId/unfreeze — 复课，到期日按冻结天数顺延
   */
  @Post(':packageId/unfreeze')
  @Roles('admin', 'boss', 'finance')
  @HttpCode(HttpStatus.OK)
  unfreeze(
    @Param('packageId') _id: string,
    @Body()
    body: { scp: StudentCoursePackage; frozenDays: number; nowMs?: number },
  ): StudentCoursePackage {
    return this.service.unfreeze(
      this.deserialize(body.scp),
      body.frozenDays,
      body.nowMs ? new Date(body.nowMs) : new Date(),
    );
  }

  // ================ /db 真存盘版 ================

  @Post('db/packages')
  @Roles('admin', 'boss', 'finance')
  @HttpCode(HttpStatus.CREATED)
  async insertPackageInDb(
    @Body()
    body: {
      package: CoursePackage;
      operator: string;
      tenantSchema: string;
    },
  ): Promise<CoursePackage> {
    return this.service.insertPackageInDb(body.package, body.operator, body.tenantSchema);
  }

  @Post('db/packages/list')
  @HttpCode(HttpStatus.OK)
  async listPackagesInDb(
    @Body() body: { tenantSchema: string; courseProductId?: string },
  ): Promise<CoursePackage[]> {
    return this.service.listActivePackagesInDb(body.tenantSchema, body.courseProductId);
  }

  @Post('db/activate')
  @Roles('admin', 'boss', 'finance')
  @HttpCode(HttpStatus.CREATED)
  async activateStudentPackageInDb(
    @Body()
    body: {
      id: string;
      studentId: string;
      coursePackageId: string;
      contractId?: string;
      tenantSchema: string;
    },
  ): Promise<StudentCoursePackage> {
    const { tenantSchema, ...rest } = body;
    return this.service.activateStudentPackageInDb(rest, tenantSchema);
  }

  @Post('db/:packageId/deduct')
  @Roles('admin', 'boss', 'finance')
  @HttpCode(HttpStatus.OK)
  async deductInDb(
    @Param('packageId') id: string,
    @Body() body: { tenantSchema: string },
  ): Promise<{ updated: StudentCoursePackage; lowBalanceAlertNow: boolean }> {
    return this.service.deductOnConsumptionInDb(id, body.tenantSchema);
  }

  @Post('db/:packageId/refund')
  @Roles('admin', 'boss', 'finance')
  @HttpCode(HttpStatus.OK)
  async refundInDb(
    @Param('packageId') id: string,
    @Body() body: { count: number; tenantSchema: string },
  ): Promise<StudentCoursePackage> {
    return this.service.refundLessonsInDb(id, body.count, body.tenantSchema);
  }

  /**
   * POST /api/course-balance/db/students/:studentId/packages — 学员课时余额（B 端学员档案 / C 端家长共享）
   *
   * 2026-06-02 走查 D 安全审修（同租户越权 + IDOR 收口）：
   *   - 原缺 @Roles → RbacGuard fail-open 任意租户角色（含 finance/hr）可读 StudentCoursePackage[]（同租户越权）。
   *   - **不用 @Roles**：本端点 B/C 共享，C 端家长经 tenant.middleware attachParentUser 以 role='parent' 到达，
   *     而 RbacRole 类型不含 'parent'（parent 是 C 端身份非 staff RBAC 角色，加进核心类型会波及 actorGroupOf/manifest）。
   *     故授权统一交 by-student owner-scope helper —— 它比 @Roles 更细：既做角色级拒绝（finance/hr/unknown 落
   *     helper 最终「拒绝」分支），又做归属级收口。
   *   - owner-scope（assertStudentByStudentScope）：admin·boss·sales_manager·academic·academic_admin·marketing 本校 /
   *     sales 仅自己客户学员 / teacher 仅自己班 / parent 仅自己孩子（studentId ∈ active 绑定，非 bypass）/
   *     **finance·hr·unknown 拒绝**。课时包数据无金额（仅 total/used/remaining 课时数），但归属仍须收口。
   */
  @Post('db/students/:studentId/packages')
  @HttpCode(HttpStatus.OK)
  async listActiveByStudentInDb(
    @Param('studentId') studentId: string,
    @Body() body: { tenantSchema: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<StudentCoursePackage[]> {
    await this.assertByStudentScope(
      studentId,
      body.tenantSchema,
      req,
      'course-balance/packages',
    );
    return this.service.listActiveByStudentInDb(studentId, body.tenantSchema);
  }

  /**
   * 2026-06-02 走查 D：by-student owner-scope 校验（同租户 IDOR 收口，复刻 feedback.controller）。
   *   studentRepo.findBrief 拿 ownerSalesId / assignedTeacherId，再按 actorGroup / parent 绑定判定。
   *   fail-open 兜底：studentRepo/teacherRepo 未注入（isolated unit spec）→ 跳过（仅 @Roles 兜底）。
   *   学员不存在 → 放行（service 返空，避免 enumeration 侧信道，与 feedback/contract by-student 一致）。
   */
  private async assertByStudentScope(
    studentId: string,
    tenantSchema: string,
    req: AuthenticatedRequest,
    endpoint: string,
  ): Promise<void> {
    if (!this.studentRepo || !this.teacherRepo) return; // isolated unit spec 兜底（生产 @Global 必有）
    const student = await this.studentRepo.findBrief(tenantSchema, studentId);
    if (!student) return; // 不存在 → 不泄露存在性，service 自然返空
    await assertStudentByStudentScope(
      student,
      req,
      tenantSchema,
      (schema, userId) =>
        this.teacherRepo!.findByUserId(schema, userId).then((t) => t?.id ?? null),
      { endpoint, studentId },
      this.buildParentChildIdsResolver(req, tenantSchema),
    );
  }

  /**
   * 2026-06-02 parent↔student 绑定 IDOR 校验闭包（复刻 feedback.controller）。
   *   非 parent 流（无 req.parent）→ undefined（helper parent 分支不触发，省 DB IO）。
   *   parent 流但 parentRepo 未注入（isolated unit spec）→ undefined → helper 保守拒绝（fail-safe）。
   *   闭包查 parentRepo.findChildrenByParent（SQL 已过滤 binding_status='active'），再按当前
   *   tenantSchema 派生 tenantId 过滤（跨机构家长可能绑多租户），映射出 student id 列表。
   */
  private buildParentChildIdsResolver(
    req: AuthenticatedRequest,
    tenantSchema: string,
  ): (() => Promise<string[]>) | undefined {
    if (!req.parent || !this.parentRepo) return undefined;
    const parentRepo = this.parentRepo;
    const parentId = req.parent.parentId ?? req.parent.sub;
    const tenantId = tenantSchema.replace(/^tenant_/, '').toLowerCase();
    return async () => {
      if (!parentId) return [];
      const bindings = await parentRepo.findChildrenByParent(parentId);
      return bindings
        .filter(
          (b) => b.bindingStatus === 'active' && b.tenantId.toLowerCase() === tenantId,
        )
        .map((b) => b.studentId);
    };
  }

  @Post('db/scan-expired')
  @HttpCode(HttpStatus.OK)
  async scanExpiredInDb(
    @Body() body: { tenantSchema: string; nowMs?: number },
  ): Promise<{ expired: number; ids: string[] }> {
    return this.service.scanExpiredInDb(
      body.tenantSchema,
      body.nowMs ? new Date(body.nowMs) : new Date(),
    );
  }

  @Post('db/scan-low-balance')
  @HttpCode(HttpStatus.OK)
  async scanLowBalanceInDb(
    @Body() body: { tenantSchema: string },
  ): Promise<StudentCoursePackage[]> {
    return this.service.listPendingLowBalanceAlertsInDb(body.tenantSchema);
  }

  @Post('db/:packageId/freeze')
  @Roles('admin', 'boss', 'finance')
  @HttpCode(HttpStatus.OK)
  async freezeInDb(
    @Param('packageId') id: string,
    @Body() body: { tenantSchema: string },
  ): Promise<StudentCoursePackage> {
    return this.service.freezeInDb(id, body.tenantSchema);
  }

  @Post('db/:packageId/unfreeze')
  @Roles('admin', 'boss', 'finance')
  @HttpCode(HttpStatus.OK)
  async unfreezeInDb(
    @Param('packageId') id: string,
    @Body() body: { frozenDays: number; tenantSchema: string },
  ): Promise<StudentCoursePackage> {
    return this.service.unfreezeInDb(id, body.frozenDays, body.tenantSchema);
  }

  // ===== helpers =====

  private deserialize(scp: StudentCoursePackage): StudentCoursePackage {
    return {
      ...scp,
      activatedAt: new Date(scp.activatedAt as unknown as string),
      expiresAt: new Date(scp.expiresAt as unknown as string),
    };
  }
}
