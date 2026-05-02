import {
  Body,
  Controller,
  Param,
  Post,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  CourseBalanceService,
  CoursePackage,
  StudentCoursePackage,
} from './course-balance.service';

/**
 * CourseBalanceController — V12 课时包 + 余额 HTTP 暴露 BE-V12-1
 *
 * 路由前缀：/api/course-balance
 *
 * USER-AUTH(2026-05-02): 教学链路 §1
 */
@Controller('course-balance')
export class CourseBalanceController {
  constructor(private readonly service: CourseBalanceService) {}

  /**
   * POST /api/course-balance/activate — 合同签约时激活课时包
   */
  @Post('activate')
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

  private deserialize(scp: StudentCoursePackage): StudentCoursePackage {
    return {
      ...scp,
      activatedAt: new Date(scp.activatedAt as unknown as string),
      expiresAt: new Date(scp.expiresAt as unknown as string),
    };
  }
}
