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
      createdByRole: 'teacher' | 'sales';
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
   */
  async insertWithStudents(
    tenantSchema: string,
    schedule: Schedule,
    studentIds: ReadonlyArray<string>,
  ): Promise<{ schedule: Schedule; students: ScheduleStudent[] }> {
    return this.pg.transaction(async (client) => {
      await client.query(
        `INSERT INTO schedules (
           id, course_product_id, teacher_id, start_at, duration_min, end_at,
           status, source, recurring_schedule_id, created_by_user_id, created_by_role, notes
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
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
      createdByRole: row.created_by_role,
      notes: row.notes || undefined,
    };
  }
}
