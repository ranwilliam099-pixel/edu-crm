import { Injectable, NotFoundException } from '@nestjs/common';
import { PgPoolService, PgRow } from './pg-pool.service';
import { Schedule, ScheduleStudent, ScheduleStatus, AttendanceStatus } from '../schedule/schedule.service';

/**
 * ScheduleRepository — V8 排课持久化层
 *
 * 写入 tenant_xxx.schedules + schedule_students 双表（事务保证一致性）
 */
@Injectable()
export class ScheduleRepository {
  constructor(private readonly pg: PgPoolService) {}

  /**
   * V8 周期模板展开 → 幂等 upsert 多条排课 + 学员绑定
   *
   * 用 UNIQUE INDEX `uniq_recurring_expansion(recurring_schedule_id, start_at)`
   * 实现幂等：同一 recurring + start_at 重复展开 ON CONFLICT DO NOTHING
   *
   * @returns inserted（新插入的）+ skipped（已存在的）
   */
  async bulkUpsertFromRecurring(
    tenantSchema: string,
    recurring: {
      id: string;
      teacherId: string;
      studentId: string;
      durationMin: number;
      createdByUserId: string;
      /**
       * Wave 11 拍板修复：仅 'academic' 合法
       * （cron 展开历史记录可能含 'teacher' | 'sales'，类型放宽到 string 避免 cron job
       *   读旧记录时类型不兼容；service / controller 层已收紧到 'academic'）
       */
      createdByRole: string;
      courseProductId?: string;
    },
    candidates: ReadonlyArray<{ startAt: Date; endAt: Date }>,
    idGenerator: (i: number) => string,
  ): Promise<{ inserted: number; skipped: number }> {
    if (candidates.length === 0) return { inserted: 0, skipped: 0 };

    return this.pg.transaction(
      async (client) => {
        let inserted = 0;
        let skipped = 0;

        for (let i = 0; i < candidates.length; i++) {
          const c = candidates[i];
          const scheduleId = idGenerator(i);

          const r = await client.query(
            `INSERT INTO schedules (
               id, course_product_id, teacher_id, start_at, duration_min, end_at,
               status, source, recurring_schedule_id, created_by_user_id, created_by_role
             ) VALUES ($1, $2, $3, $4, $5, $6, '已排课', 'recurring_expansion', $7, $8, $9)
             ON CONFLICT (recurring_schedule_id, start_at)
             WHERE source = 'recurring_expansion'
             DO NOTHING
             RETURNING id`,
            [
              scheduleId,
              recurring.courseProductId || null,
              recurring.teacherId,
              c.startAt,
              recurring.durationMin,
              c.endAt,
              recurring.id,
              recurring.createdByUserId,
              recurring.createdByRole,
            ],
          );

          if (r.rowCount === 0) {
            skipped++;
            continue;
          }
          inserted++;

          // 绑定学员到这节排课
          await client.query(
            `INSERT INTO schedule_students (schedule_id, student_id, attendance_status, joined_at)
             VALUES ($1, $2, '待出勤', NOW())
             ON CONFLICT DO NOTHING`,
            [scheduleId, recurring.studentId],
          );
        }

        return { inserted, skipped };
      },
      { tenantSchema },
    );
  }

  /**
   * 在事务内同时 INSERT schedule + 多条 schedule_students
   *
   * V32 兜底校验（柔性）：
   *   - studentIds 至少 1 个
   *   - 若 schedule.maxStudents 提供，则 studentIds.length ≤ maxStudents
   *
   * V29 R14.6 兜底校验（柔性）：
   *   - 若 schedule.classType 提供，校验所有 studentIds 的最新 pending|active 合同班型一致
   *   - 学员无 active 合同（contract_class_type IS NULL）→ 视为无约束放行（柔性，未签约学员可入任意班型）
   *   - 仅在 contract_class_type 非空且 ≠ schedule.classType 时拒绝
   */
  async insertWithStudents(
    tenantSchema: string,
    schedule: Schedule,
    studentIds: ReadonlyArray<string>,
  ): Promise<{ schedule: Schedule; students: ScheduleStudent[] }> {
    if (!studentIds || studentIds.length === 0) {
      throw new Error('schedule must have at least 1 student');
    }
    if (
      typeof schedule.maxStudents === 'number' &&
      studentIds.length > schedule.maxStudents
    ) {
      throw new Error(
        `studentIds (${studentIds.length}) exceeds maxStudents (${schedule.maxStudents})`,
      );
    }
    return this.pg.transaction(async (client) => {
      if (schedule.classType) {
        // V44: 排课班型校验时排除已软删学员（schedulable 学员必须 active）
        const checkRes = await client.query(
          `SELECT s.id AS student_id,
                  (SELECT c.class_type FROM contracts c
                     WHERE c.student_id = s.id
                       AND c.status IN ('pending', 'active')
                       AND c.deleted_at IS NULL
                     ORDER BY COALESCE(c.signed_at, c.created_at) DESC
                     LIMIT 1) AS contract_class_type
             FROM students s
             WHERE s.id = ANY($1)
               AND s.deleted_at IS NULL`,
          [studentIds as string[]],
        );
        const mismatched = checkRes.rows.filter(
          (r: PgRow) =>
            r.contract_class_type != null &&
            r.contract_class_type !== schedule.classType,
        );
        if (mismatched.length > 0) {
          const ids = mismatched.map((r: PgRow) => r.student_id).join(',');
          throw new Error(
            `studentIds [${ids}] contractClassType mismatch (expected ${schedule.classType})`,
          );
        }
      }

      await client.query(
        `INSERT INTO schedules (
           id, course_product_id, teacher_id, start_at, duration_min, end_at,
           status, source, recurring_schedule_id, created_by_user_id, created_by_role, notes,
           class_type, max_students
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          schedule.id,
          schedule.courseProductId || null,
          schedule.teacherId,
          schedule.startAt,
          schedule.durationMin,
          schedule.endAt,
          schedule.status,
          schedule.source,
          schedule.recurringScheduleId || null,
          schedule.createdByUserId,
          schedule.createdByRole,
          schedule.notes || null,
          schedule.classType || null,
          schedule.maxStudents != null ? schedule.maxStudents : null,
        ],
      );

      const students: ScheduleStudent[] = [];
      for (const sid of studentIds) {
        const joinedAt = new Date();
        await client.query(
          `INSERT INTO schedule_students (schedule_id, student_id, attendance_status, joined_at)
           VALUES ($1, $2, '待出勤', $3)`,
          [schedule.id, sid, joinedAt],
        );
        students.push({
          scheduleId: schedule.id,
          studentId: sid,
          attendanceStatus: '待出勤',
          joinedAt,
        });
      }

      return { schedule, students };
    }, { tenantSchema });
  }

  /**
   * 按 teacher 时间区间查冲突候选（事务前用）
   */
  async findConflictsForTeacher(
    tenantSchema: string,
    teacherId: string,
    startAt: Date,
    endAt: Date,
  ): Promise<Schedule[]> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, teacher_id, start_at, duration_min, end_at, status,
              source, recurring_schedule_id, created_by_user_id, created_by_role, notes
       FROM schedules
       WHERE teacher_id = $1
         AND status != '已取消'
         AND start_at < $3
         AND end_at > $2`,
      [teacherId, startAt, endAt],
    );
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * 按 student 时间区间查冲突候选
   */
  async findConflictsForStudents(
    tenantSchema: string,
    studentIds: ReadonlyArray<string>,
    startAt: Date,
    endAt: Date,
  ): Promise<Array<Schedule & { conflictStudentId: string }>> {
    if (studentIds.length === 0) return [];
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT s.id, s.teacher_id, s.start_at, s.duration_min, s.end_at, s.status,
              s.source, s.recurring_schedule_id, s.created_by_user_id, s.created_by_role, s.notes,
              ss.student_id as conflict_student_id
       FROM schedules s
       JOIN schedule_students ss ON ss.schedule_id = s.id
       WHERE ss.student_id = ANY($1)
         AND s.status != '已取消'
         AND s.start_at < $3
         AND s.end_at > $2`,
      [studentIds as string[], startAt, endAt],
    );
    return rows.map((r) => ({ ...this.mapRow(r), conflictStudentId: r.conflict_student_id }));
  }

  async findById(tenantSchema: string, id: string): Promise<Schedule | null> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, course_product_id, teacher_id, start_at, duration_min, end_at,
              status, source, recurring_schedule_id, created_by_user_id, created_by_role, notes
       FROM schedules WHERE id = $1`,
      [id],
    );
    return rows.length === 0 ? null : this.mapRow(rows[0]);
  }

  async updateStatus(
    tenantSchema: string,
    id: string,
    newStatus: ScheduleStatus,
  ): Promise<Schedule> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `UPDATE schedules SET status = $1, updated_at = NOW() WHERE id = $2
       RETURNING id, course_product_id, teacher_id, start_at, duration_min, end_at,
                 status, source, recurring_schedule_id, created_by_user_id, created_by_role, notes`,
      [newStatus, id],
    );
    if (rows.length === 0) throw new NotFoundException(`schedule ${id} not found`);
    return this.mapRow(rows[0]);
  }

  async listByTeacher(
    tenantSchema: string,
    teacherId: string,
    fromDate: Date,
    toDate: Date,
  ): Promise<Schedule[]> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, course_product_id, teacher_id, start_at, duration_min, end_at,
              status, source, recurring_schedule_id, created_by_user_id, created_by_role, notes
       FROM schedules
       WHERE teacher_id = $1 AND start_at >= $2 AND start_at < $3
       ORDER BY start_at ASC`,
      [teacherId, fromDate, toDate],
    );
    return rows.map((r) => this.mapRow(r));
  }

  async markAttendance(
    tenantSchema: string,
    scheduleId: string,
    studentId: string,
    newStatus: AttendanceStatus,
  ): Promise<ScheduleStudent> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `UPDATE schedule_students SET attendance_status = $1
       WHERE schedule_id = $2 AND student_id = $3
       RETURNING schedule_id, student_id, attendance_status, joined_at`,
      [newStatus, scheduleId, studentId],
    );
    if (rows.length === 0) throw new NotFoundException(`schedule_student not found`);
    return {
      scheduleId: rows[0].schedule_id,
      studentId: rows[0].student_id,
      attendanceStatus: rows[0].attendance_status,
      joinedAt: rows[0].joined_at,
    };
  }

  private mapRow(row: PgRow): Schedule {
    return {
      id: row.id,
      courseProductId: row.course_product_id || undefined,
      teacherId: row.teacher_id,
      startAt: row.start_at,
      durationMin: row.duration_min,
      endAt: row.end_at,
      status: row.status,
      source: row.source,
      recurringScheduleId: row.recurring_schedule_id || undefined,
      createdByUserId: row.created_by_user_id,
      // Wave 11: 历史 row.created_by_role 可能含 'teacher' / 'sales'（5/12-5/15 写入）；
      // 类型断言为 'academic'，运行时仍保持原值用于审计 / 兼容显示，新建必走 'academic'
      createdByRole: row.created_by_role as 'academic',
      notes: row.notes || undefined,
    };
  }
}
