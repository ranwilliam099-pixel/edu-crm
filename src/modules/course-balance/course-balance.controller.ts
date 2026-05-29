import {
  Body,
  Controller,
  Param,
  Post,
  HttpCode,
  HttpStatus,
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
  constructor(private readonly service: CourseBalanceService) {}

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

  @Post('db/students/:studentId/packages')
  @HttpCode(HttpStatus.OK)
  async listActiveByStudentInDb(
    @Param('studentId') studentId: string,
    @Body() body: { tenantSchema: string },
  ): Promise<StudentCoursePackage[]> {
    return this.service.listActiveByStudentInDb(studentId, body.tenantSchema);
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
