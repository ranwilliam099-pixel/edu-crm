import { Injectable, BadRequestException, ConflictException, Logger } from '@nestjs/common';

/**
 * CourseBalanceService — V12 课时包 + 学员课时余额 BE-V12-1
 *
 * 来源：
 *   - 《教学链路完整设计-V1-2026-05-02.md》§1
 *   - 用户拍板「完成整个教学链路从开始到结束」
 *
 * 业务规则（默认值见设计稿 §9，等用户后续二次明示）：
 *   - 课时包有效期默认 12 个月
 *   - 余额低于 5 节触发提醒（low_balance_alerted 幂等）
 *   - 余额 = 0 → status='depleted'，无法再排课
 */
export type CoursePackageStatus = 'active' | 'archived';
export type StudentCoursePackageStatus =
  | 'active'
  | 'expired'
  | 'depleted'
  | 'frozen'
  | 'refunded';

export const LOW_BALANCE_THRESHOLD = 5;

export interface CoursePackage {
  id: string;
  courseProductId: string;
  name: string;
  totalLessons: number;
  unitPriceYuan: number;
  totalPriceYuan: number;
  validityMonths: number;
  status: CoursePackageStatus;
}

export interface StudentCoursePackage {
  id: string;
  studentId: string;
  coursePackageId: string;
  contractId?: string;
  totalLessons: number;
  usedLessons: number;
  refundedLessons: number;
  remainingLessons: number; // 计算字段
  activatedAt: Date;
  expiresAt: Date;
  status: StudentCoursePackageStatus;
  lowBalanceAlerted: boolean;
}

@Injectable()
export class CourseBalanceService {
  private readonly logger = new Logger(CourseBalanceService.name);

  /**
   * 激活学员课时包（contract 签约后触发）
   */
  activatePackage(input: {
    id: string;
    studentId: string;
    coursePackage: CoursePackage;
    contractId?: string;
    activatedAt?: Date;
  }): StudentCoursePackage {
    if (!input.id || input.id.length !== 32) {
      throw new BadRequestException('id must be 32-char ULID');
    }
    if (!input.studentId || input.studentId.length !== 32) {
      throw new BadRequestException('studentId must be 32-char ULID');
    }
    if (!input.coursePackage || input.coursePackage.totalLessons <= 0) {
      throw new BadRequestException('coursePackage.totalLessons must be > 0');
    }
    if (input.coursePackage.status !== 'active') {
      throw new BadRequestException('coursePackage must be active to activate');
    }
    const activatedAt = input.activatedAt ?? new Date();
    const expiresAt = new Date(
      activatedAt.getTime() +
        input.coursePackage.validityMonths * 30 * 24 * 60 * 60 * 1000,
    );
    this.logger.log(
      `[BE-V12-1] activatePackage student=${input.studentId} package=${input.coursePackage.id} ` +
        `total=${input.coursePackage.totalLessons} expires=${expiresAt.toISOString()}`,
    );
    return {
      id: input.id,
      studentId: input.studentId,
      coursePackageId: input.coursePackage.id,
      contractId: input.contractId,
      totalLessons: input.coursePackage.totalLessons,
      usedLessons: 0,
      refundedLessons: 0,
      remainingLessons: input.coursePackage.totalLessons,
      activatedAt,
      expiresAt,
      status: 'active',
      lowBalanceAlerted: false,
    };
  }

  /**
   * schedule.complete 时扣 1 课时
   *
   * @returns 更新后的余额 + 是否触发低余额提醒
   * @throws ConflictException 若状态不可扣或余额不足
   */
  deductOnConsumption(scp: StudentCoursePackage): {
    updated: StudentCoursePackage;
    lowBalanceAlertNow: boolean;
  } {
    if (scp.status !== 'active') {
      throw new ConflictException(
        `cannot deduct: package status=${scp.status} (only active allowed)`,
      );
    }
    if (scp.remainingLessons <= 0) {
      throw new ConflictException('PACKAGE_DEPLETED: no lessons remaining');
    }

    const newUsed = scp.usedLessons + 1;
    const newRemaining = scp.totalLessons - newUsed - scp.refundedLessons;

    let newStatus: StudentCoursePackageStatus = scp.status;
    if (newRemaining === 0) {
      newStatus = 'depleted';
    }

    const lowBalanceAlertNow =
      !scp.lowBalanceAlerted &&
      newRemaining > 0 &&
      newRemaining <= LOW_BALANCE_THRESHOLD;

    return {
      updated: {
        ...scp,
        usedLessons: newUsed,
        remainingLessons: newRemaining,
        status: newStatus,
        lowBalanceAlerted: lowBalanceAlertNow ? true : scp.lowBalanceAlerted,
      },
      lowBalanceAlertNow,
    };
  }

  /**
   * 退费冲减课时（reverse_orders 退费触发）
   *
   * @param count 应退课时数（应用层从 reverse_order.amount 反算）
   */
  refundLessons(
    scp: StudentCoursePackage,
    count: number,
  ): StudentCoursePackage {
    if (count <= 0) {
      throw new BadRequestException('refund count must be > 0');
    }
    if (scp.usedLessons + scp.refundedLessons + count > scp.totalLessons) {
      throw new BadRequestException(
        `refund overflow: used=${scp.usedLessons} refunded=${scp.refundedLessons} count=${count} total=${scp.totalLessons}`,
      );
    }
    const newRefunded = scp.refundedLessons + count;
    const newRemaining = scp.totalLessons - scp.usedLessons - newRefunded;
    let newStatus: StudentCoursePackageStatus = scp.status;
    if (newRemaining === 0 && scp.usedLessons > 0) {
      newStatus = 'depleted';
    }
    if (newRemaining + scp.usedLessons === 0) {
      // 完全退完
      newStatus = 'refunded';
    }
    return {
      ...scp,
      refundedLessons: newRefunded,
      remainingLessons: newRemaining,
      status: newStatus,
    };
  }

  /**
   * 排课前校验余额
   */
  checkSchedulable(scp?: StudentCoursePackage, now: Date = new Date()): {
    canSchedule: boolean;
    reason?: string;
  } {
    if (!scp) {
      return { canSchedule: false, reason: 'NO_PACKAGE' };
    }
    if (scp.status === 'frozen') {
      return { canSchedule: false, reason: 'PACKAGE_FROZEN' };
    }
    if (scp.status === 'refunded') {
      return { canSchedule: false, reason: 'PACKAGE_REFUNDED' };
    }
    if (scp.status === 'depleted') {
      return { canSchedule: false, reason: 'PACKAGE_DEPLETED' };
    }
    if (scp.status === 'expired') {
      return { canSchedule: false, reason: 'PACKAGE_EXPIRED' };
    }
    if (scp.expiresAt.getTime() < now.getTime()) {
      return { canSchedule: false, reason: 'PACKAGE_EXPIRED' };
    }
    if (scp.remainingLessons <= 0) {
      return { canSchedule: false, reason: 'NO_REMAINING_LESSONS' };
    }
    return { canSchedule: true };
  }

  /**
   * cron: 每天 0:00 扫到期
   */
  scanExpired(
    packages: ReadonlyArray<StudentCoursePackage>,
    now: Date = new Date(),
  ): StudentCoursePackage[] {
    return packages
      .filter((p) => p.status === 'active' && p.expiresAt.getTime() < now.getTime())
      .map((p) => ({ ...p, status: 'expired' as const }));
  }

  /**
   * cron: 每天 0:00 扫低余额（未发提醒过）
   */
  scanLowBalanceAlerts(
    packages: ReadonlyArray<StudentCoursePackage>,
  ): StudentCoursePackage[] {
    return packages.filter(
      (p) =>
        p.status === 'active' &&
        !p.lowBalanceAlerted &&
        p.remainingLessons > 0 &&
        p.remainingLessons <= LOW_BALANCE_THRESHOLD,
    );
  }

  /**
   * 冻结课时包（学员请长假）— 期间不扣消，到期日顺延
   */
  freeze(scp: StudentCoursePackage): StudentCoursePackage {
    if (scp.status !== 'active') {
      throw new ConflictException(`cannot freeze: status=${scp.status}`);
    }
    return { ...scp, status: 'frozen' };
  }

  /**
   * 解冻课时包（学员复课）— 到期日按冻结天数顺延
   */
  unfreeze(
    scp: StudentCoursePackage,
    frozenDays: number,
    now: Date = new Date(),
  ): StudentCoursePackage {
    if (scp.status !== 'frozen') {
      throw new ConflictException(`cannot unfreeze: status=${scp.status}`);
    }
    if (frozenDays < 0) {
      throw new BadRequestException('frozenDays must be >= 0');
    }
    const newExpiresAt = new Date(
      scp.expiresAt.getTime() + frozenDays * 24 * 60 * 60 * 1000,
    );
    return { ...scp, status: 'active', expiresAt: newExpiresAt };
  }
}
