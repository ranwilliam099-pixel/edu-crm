import {
  Body,
  Controller,
  Param,
  Post,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ScheduleService,
  Schedule,
  ScheduleStudent,
  CreateScheduleInput,
  AttendanceStatus,
} from './schedule.service';

/**
 * ScheduleController — V8 排课核心 HTTP 暴露 BE-V8-1
 *
 * 路由前缀：/api/schedules
 *
 * RBAC 在 ScheduleService 内做（callerRole='teacher' / 'sales' 二选一）
 *
 * USER-AUTH(2026-05-02): PD §3 + 条目 31 #2 + 条目 32 L2
 */
@Controller('schedules')
export class ScheduleController {
  constructor(private readonly service: ScheduleService) {}

  /**
   * POST /api/schedules — 创建排课
   *
   * Body 中需提供：
   *   - input: CreateScheduleInput
   *   - existingSchedules / existingStudentsAttachment（用于冲突检测，由调用方注入）
   *   - studentResponsibleSalesPairs（销售校验 P3）
   *   - schedulableTeachers（跨校豁免 P4 + status=在职）
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  createSchedule(
    @Body()
    body: {
      input: CreateScheduleInput;
      existingSchedules: Schedule[];
      existingStudentsAttachment: ScheduleStudent[];
      studentResponsibleSalesPairs: Array<[string, string]>;
      schedulableTeachers: Array<{ id: string; userId?: string }>;
    },
  ): { schedule: Schedule; students: ScheduleStudent[] } {
    return this.service.createSchedule(
      this.deserializeInput(body.input),
      body.existingSchedules.map((s) => this.deserializeSchedule(s)),
      body.existingStudentsAttachment,
      new Map(body.studentResponsibleSalesPairs),
      body.schedulableTeachers,
    );
  }

  /**
   * POST /api/schedules/:id/cancel — 取消排课
   */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancelSchedule(
    @Param('id') _id: string,
    @Body() body: { schedule: Schedule; reason?: string },
  ): Schedule {
    return this.service.cancelSchedule(this.deserializeSchedule(body.schedule), body.reason);
  }

  /**
   * POST /api/schedules/:id/complete — 标记排课完成（触发课消生成）
   */
  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  completeSchedule(
    @Param('id') _id: string,
    @Body() body: { schedule: Schedule },
  ): Schedule {
    return this.service.completeSchedule(this.deserializeSchedule(body.schedule));
  }

  /**
   * POST /api/schedules/db — 真存盘版（自动查 PG 冲突 + 事务 INSERT）
   */
  @Post('db')
  @HttpCode(HttpStatus.CREATED)
  async createScheduleInDb(
    @Body()
    body: {
      input: CreateScheduleInput;
      tenantSchema: string;
      studentResponsibleSalesPairs: Array<[string, string]>;
      schedulableTeachers: Array<{ id: string; userId?: string }>;
    },
  ): Promise<{ schedule: Schedule; students: ScheduleStudent[] }> {
    return this.service.createScheduleInDb(
      this.deserializeInput(body.input),
      body.tenantSchema,
      new Map(body.studentResponsibleSalesPairs),
      body.schedulableTeachers,
    );
  }

  /**
   * POST /api/schedules/db/list-by-teacher
   */
  @Post('db/list-by-teacher')
  @HttpCode(HttpStatus.OK)
  async listByTeacherInDb(
    @Body()
    body: { tenantSchema: string; teacherId: string; fromIso: string; toIso: string },
  ): Promise<Schedule[]> {
    return this.service.listByTeacherInDb(
      body.tenantSchema,
      body.teacherId,
      new Date(body.fromIso),
      new Date(body.toIso),
    );
  }

  /**
   * POST /api/schedules/:scheduleId/students/:studentId/attendance
   */
  @Post(':scheduleId/students/:studentId/attendance')
  @HttpCode(HttpStatus.OK)
  markAttendance(
    @Param('scheduleId') _scheduleId: string,
    @Param('studentId') _studentId: string,
    @Body() body: { scheduleStudent: ScheduleStudent; newStatus: AttendanceStatus },
  ): ScheduleStudent {
    return this.service.markAttendance(body.scheduleStudent, body.newStatus);
  }

  // -- helpers: JSON Date 反序列化 --

  private deserializeInput(input: CreateScheduleInput): CreateScheduleInput {
    return {
      ...input,
      startAt: new Date(input.startAt as unknown as string),
    };
  }

  private deserializeSchedule(s: Schedule): Schedule {
    return {
      ...s,
      startAt: new Date(s.startAt as unknown as string),
      endAt: new Date(s.endAt as unknown as string),
    };
  }
}
