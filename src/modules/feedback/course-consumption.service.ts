import { Injectable, BadRequestException, Logger } from '@nestjs/common';

/**
 * CourseConsumptionService — V9 课消候补 BE-V9-2
 *
 * 来源：
 *   - 《PD设计稿-排课-教学反馈-家长订阅-V1-2026-05-02.md》§4.2
 *   - PD 硬规则 P6（24h 必填 → 课消锁定 → 老师工资不算）
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

  /**
   * schedule.completed 时为每个 present/late 学员创建一条 course_consumptions
   *
   * @param scheduleEndAt 排课结束时间（用于计算 feedback_due_at = end_at + 24h）
   * @param amountYuan 课时单价（来自 teacher.hourly_rate_yuan × duration_hour）
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
   * 反馈提交时把课消标记为 confirmed（老师工资计入）
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
   * cron 每 10 分钟扫一次：超期未填反馈 → status=locked（老师工资暂不算）
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
   * 老师超期补填反馈 → 从 locked 恢复 confirmed（下个工资周期补发）
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

  /**
   * 老师工资统计：仅 confirmed 状态的课消纳入计算
   */
  sumPayrollForTeacher(
    teacherId: string,
    consumptions: ReadonlyArray<CourseConsumption>,
  ): number {
    return consumptions
      .filter((c) => c.teacherId === teacherId && c.status === 'confirmed')
      .reduce((sum, c) => sum + (c.amountYuan ?? 0), 0);
  }
}
