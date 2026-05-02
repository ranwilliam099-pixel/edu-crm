import {
  Body,
  Controller,
  Param,
  Post,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  RecurringScheduleService,
  StudentTeacherBinding,
  RecurringSchedule,
  WeekDay,
} from './recurring-schedule.service';

/**
 * RecurringScheduleController — V8.1 学员-老师绑定 + 周期性课表 HTTP 暴露 BE-V8-2
 *
 * 路由前缀：/api/recurring
 *
 * USER-AUTH(2026-05-02): PD §3.6 + P12 学员-老师固定绑定 + 周期性模板
 */
@Controller('recurring')
export class RecurringScheduleController {
  constructor(private readonly service: RecurringScheduleService) {}

  /**
   * POST /api/recurring/bindings — 创建学员-老师绑定（按科目）
   */
  @Post('bindings')
  @HttpCode(HttpStatus.CREATED)
  createBinding(
    @Body()
    body: {
      id: string;
      studentId: string;
      teacherId: string;
      subject?: string;
      boundByUserId: string;
    },
  ): StudentTeacherBinding {
    return this.service.createBinding(body);
  }

  /**
   * POST /api/recurring/bindings/:id/unbind
   */
  @Post('bindings/:id/unbind')
  @HttpCode(HttpStatus.OK)
  unbindBinding(
    @Param('id') _id: string,
    @Body() body: { binding: StudentTeacherBinding },
  ): StudentTeacherBinding {
    return this.service.unbindBinding(this.deserializeBinding(body.binding));
  }

  /**
   * POST /api/recurring/schedules — 创建周期性模板（含 90 天预检）
   *
   * @returns active 模板（创建时未来 N 天展开预检通过）
   */
  @Post('schedules')
  @HttpCode(HttpStatus.CREATED)
  createRecurring(
    @Body()
    body: {
      input: {
        id: string;
        bindingId: string;
        studentId: string;
        teacherId: string;
        courseProductId?: string;
        byDay: WeekDay[];
        startMinutes: number;
        durationMin: number;
        startDate: string;
        endDate?: string;
        createdByUserId: string;
        createdByRole: 'teacher' | 'sales';
      };
      expandRangeDays: number;
      existingSchedules: Array<{
        teacherId: string;
        studentIds: string[];
        startAt: string;
        endAt: string;
        status: string;
      }>;
    },
  ): RecurringSchedule {
    return this.service.createRecurring(
      {
        ...body.input,
        startDate: new Date(body.input.startDate),
        endDate: body.input.endDate ? new Date(body.input.endDate) : undefined,
      },
      body.expandRangeDays,
      body.existingSchedules.map((s) => ({
        ...s,
        startAt: new Date(s.startAt),
        endAt: new Date(s.endAt),
      })),
    );
  }

  /**
   * POST /api/recurring/schedules/:id/archive — 归档模板
   */
  @Post('schedules/:id/archive')
  @HttpCode(HttpStatus.OK)
  archiveRecurring(
    @Param('id') _id: string,
    @Body() body: { recurring: RecurringSchedule },
  ): RecurringSchedule {
    return this.service.archiveRecurring(this.deserializeRecurring(body.recurring));
  }

  /**
   * POST /api/recurring/schedules/expand-preview
   *
   * 用于前端创建模板前预览展开时段（不写入 DB）
   */
  @Post('schedules/expand-preview')
  @HttpCode(HttpStatus.OK)
  expandPreview(
    @Body()
    body: {
      byDay: WeekDay[];
      startMinutes: number;
      durationMin: number;
      startDate: string;
      endDate?: string;
      rangeDays: number;
      nowMs?: number;
    },
  ): Array<{ startAt: Date; endAt: Date }> {
    return this.service.expandToCandidates(
      body.byDay,
      body.startMinutes,
      body.durationMin,
      new Date(body.startDate),
      body.endDate ? new Date(body.endDate) : undefined,
      body.rangeDays,
      body.nowMs ? new Date(body.nowMs) : new Date(),
    );
  }

  // -- helpers --

  private deserializeBinding(b: StudentTeacherBinding): StudentTeacherBinding {
    return {
      ...b,
      boundAt: new Date(b.boundAt as unknown as string),
      unboundAt: b.unboundAt ? new Date(b.unboundAt as unknown as string) : undefined,
    };
  }

  private deserializeRecurring(r: RecurringSchedule): RecurringSchedule {
    return {
      ...r,
      startDate: new Date(r.startDate as unknown as string),
      endDate: r.endDate ? new Date(r.endDate as unknown as string) : undefined,
      createdAt: new Date(r.createdAt as unknown as string),
      archivedAt: r.archivedAt ? new Date(r.archivedAt as unknown as string) : undefined,
    };
  }
}
