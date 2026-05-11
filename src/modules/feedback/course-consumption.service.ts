import { Injectable, BadRequestException, Logger, Optional, NotFoundException } from '@nestjs/common';
import { CourseConsumptionRepository } from '../db/course-consumption.repository';

/**
 * CourseConsumptionService — V9 课消候补 BE-V9-2
 *
 * 来源：
 *   - 《PD设计稿-排课-教学反馈-家长订阅-V1-2026-05-02.md》§4.2
 *   - PD 硬规则 P6（24h 必填 → 课消锁定 → 课消金额暂不计入机构账面；V37/V38 后薪资已下线）
 */
export type ConsumptionStatus = 'pending_feedback' | 'confirmed' | 'locked' | 'cancelled';

export interface CourseConsumption {
  id: string;
  scheduleId: string;
  studentId: string;
  teacherId: string;
  status: ConsumptionStatus;
  amountYuan?: number;
  feedbackId?: string;
  feedbackDueAt: Date;
  confirmedAt?: Date;
  lockedAt?: Date;
  createdAt: Date;
}

@Injectable()
export class CourseConsumptionService {
  private readonly logger = new Logger(CourseConsumptionService.name);

  constructor(@Optional() private readonly repo?: CourseConsumptionRepository) {}

  /**
   * schedule.completed 时为每个 present/late 学员创建一条 course_consumptions
   *
   * @param scheduleEndAt 排课结束时间（用于计算 feedback_due_at = end_at + 24h）
   * @param amountYuan 课消金额（来自 teacher.hourly_price_yuan × duration_hour；V39 列已 RENAME from hourly_rate_yuan）
   */
  createConsumption(input: {
    id: string;
    scheduleId: string;
    studentId: string;
    teacherId: string;
    scheduleEndAt: Date;
    amountYuan?: number;
  }): CourseConsumption {
    if (!input.id || input.id.length !== 32) {
      throw new BadRequestException('consumption id must be 32-char ULID');
    }
    const feedbackDueAt = new Date(input.scheduleEndAt.getTime() + 24 * 60 * 60 * 1000);
    return {
      id: input.id,
      scheduleId: input.scheduleId,
      studentId: input.studentId,
      teacherId: input.teacherId,
      status: 'pending_feedback',
      amountYuan: input.amountYuan,
      feedbackDueAt,
      createdAt: new Date(),
    };
  }

  /**
   * 反馈提交时把课消标记为 confirmed（课消金额计入机构账面，V37/V38 后薪资业务已下线，仅留课消金额聚合）
   */
  confirmByFeedback(
    consumption: CourseConsumption,
    feedbackId: string,
    now: Date = new Date(),
  ): CourseConsumption {
    if (consumption.status === 'cancelled') {
      throw new BadRequestException('consumption already cancelled');
    }
    return {
      ...consumption,
      status: 'confirmed',
      feedbackId,
      confirmedAt: now,
      lockedAt: undefined, // 超期补填恢复
    };
  }

  /**
   * cron 每 10 分钟扫一次：超期未填反馈 → status=locked（课消金额暂不计入机构账面）
   *
   * @returns 应被锁定的 consumption ID 列表（外部更新 DB）
   */
  scanAndLock(
    consumptions: ReadonlyArray<CourseConsumption>,
    now: Date = new Date(),
  ): CourseConsumption[] {
    const toLock = consumptions.filter(
      (c) =>
        c.status === 'pending_feedback' &&
        c.feedbackDueAt.getTime() < now.getTime(),
    );
    return toLock.map((c) => ({
      ...c,
      status: 'locked' as const,
      lockedAt: now,
    }));
  }

  /**
   * 老师超期补填反馈 → 从 locked 恢复 confirmed（课消金额恢复计入机构账面）
   */
  unlockByLateFeedback(
    consumption: CourseConsumption,
    feedbackId: string,
    now: Date = new Date(),
  ): CourseConsumption {
    if (consumption.status !== 'locked') {
      throw new BadRequestException('only locked consumption can be unlocked');
    }
    return {
      ...consumption,
      status: 'confirmed',
      feedbackId,
      confirmedAt: now,
      lockedAt: undefined,
    };
  }

  /**
   * 学员请假 / 排课取消 → 课消 cancelled
   */
  cancel(consumption: CourseConsumption): CourseConsumption {
    if (consumption.status === 'cancelled') {
      throw new BadRequestException('already cancelled');
    }
    return { ...consumption, status: 'cancelled' };
  }

  // V38: 删 sumPayrollForTeacher（薪资业务下线）
  //   依据：feedback_教培业务架构-2026-05-10.md「薪资全删」
  //   原 controller 已删 POST /api/teachers/:teacherId/payroll
  //   repository 层 course-consumption.repository.sumPayrollForTeacher 保留
  //   （数据库聚合能力中性，未来日报表可复用，但当前无业务调用）

  // ============= 真存盘版 =============

  async createConsumptionInDb(
    input: Parameters<CourseConsumptionService['createConsumption']>[0],
    tenantSchema: string,
  ): Promise<CourseConsumption> {
    if (!this.repo) throw new BadRequestException('CourseConsumptionRepository not available');
    const memCC = this.createConsumption(input);
    return this.repo.insert(tenantSchema, memCC);
  }

  async confirmByFeedbackInDb(
    id: string,
    feedbackId: string,
    tenantSchema: string,
  ): Promise<CourseConsumption> {
    if (!this.repo) throw new BadRequestException('CourseConsumptionRepository not available');
    return this.repo.confirmByFeedback(tenantSchema, id, feedbackId);
  }

  /**
   * cron：扫超期未填反馈的 pending → locked
   * 返回真锁定的条数
   */
  async scanAndLockInDb(
    tenantSchema: string,
    now: Date = new Date(),
  ): Promise<{ locked: number; ids: string[] }> {
    if (!this.repo) throw new BadRequestException('CourseConsumptionRepository not available');
    const overdue = await this.repo.findOverdueForLock(tenantSchema, now);
    const ids: string[] = [];
    for (const c of overdue) {
      try {
        await this.repo.lock(tenantSchema, c.id);
        ids.push(c.id);
      } catch (e) {
        this.logger.warn(`[BE-V9-2 scanAndLockInDb] skip ${c.id}: ${(e as Error).message}`);
      }
    }
    this.logger.log(`[BE-V9-2 scanAndLockInDb] locked ${ids.length} consumption(s)`);
    return { locked: ids.length, ids };
  }

  async unlockByLateFeedbackInDb(
    id: string,
    feedbackId: string,
    tenantSchema: string,
  ): Promise<CourseConsumption> {
    if (!this.repo) throw new BadRequestException('CourseConsumptionRepository not available');
    const existing = await this.repo.findById(tenantSchema, id);
    if (!existing) throw new NotFoundException(`consumption ${id} not found`);
    // 沿用纯逻辑校验 status=locked
    this.unlockByLateFeedback(existing, feedbackId);
    return this.repo.confirmByFeedback(tenantSchema, id, feedbackId);
  }

  async cancelInDb(id: string, tenantSchema: string): Promise<CourseConsumption> {
    if (!this.repo) throw new BadRequestException('CourseConsumptionRepository not available');
    return this.repo.cancel(tenantSchema, id);
  }

  // V38: 删 sumPayrollForTeacherInDb（薪资业务下线 + A04 R3 跨租户漏洞修复）
  //   原 controller endpoint POST /api/db/teachers/:teacherId/payroll 已删
  //   repository 层 course-consumption.repository.sumPayrollForTeacher 保留

  /**
   * home-teacher 待办 banner：聚合该老师 pending_feedback 课消
   *
   * @returns count（待点评课消数）+ earliestDueAt（最早 24h 到期点；< now = 已超期）
   */
  async pendingFeedbackSummaryByTeacherInDb(
    teacherId: string,
    tenantSchema: string,
  ): Promise<{ teacherId: string; count: number; earliestDueAt: Date | null }> {
    if (!this.repo) throw new BadRequestException('CourseConsumptionRepository not available');
    const r = await this.repo.findPendingFeedbackSummaryByTeacher(tenantSchema, teacherId);
    return { teacherId, count: r.count, earliestDueAt: r.earliestDueAt };
  }
}
