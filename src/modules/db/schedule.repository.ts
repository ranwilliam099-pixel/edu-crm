import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PgPoolService, PgRow } from './pg-pool.service';
import {
  Schedule,
  ScheduleCalendarItem,
  ScheduleStudent,
  ScheduleStatus,
  AttendanceStatus,
  SchedulerRole,
} from '../schedule/schedule.service';

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
            // V52 campus_id ← teachers.campus_id 子查询（同事务，主校区源头）
            // 显式 cast $3::varchar 防 PG 多处引用相同 placeholder 推断 inconsistent types
            `INSERT INTO schedules (
               id, course_product_id, teacher_id, start_at, duration_min, end_at,
               status, source, recurring_schedule_id, created_by_user_id, created_by_role,
               campus_id
             ) VALUES ($1, $2, $3::varchar, $4, $5, $6, '已排课', 'recurring_expansion', $7, $8, $9,
                       (SELECT campus_id FROM teachers WHERE id = $3::varchar))
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
        // V52 campus_id ← teachers.campus_id 子查询（同事务，主校区源头）
        // 显式 cast $3::varchar 防 PG 多处引用相同 placeholder 推断 inconsistent types
        `INSERT INTO schedules (
           id, course_product_id, teacher_id, start_at, duration_min, end_at,
           status, source, recurring_schedule_id, created_by_user_id, created_by_role, notes,
           class_type, max_students, campus_id
         ) VALUES ($1,$2,$3::varchar,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
                   (SELECT campus_id FROM teachers WHERE id = $3::varchar))`,
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

  /**
   * 2026-05-22 业务事件链关键缺口修复 (用户拍板「每数据有业务来源最小颗粒度」):
   *   老师上完课 → 同事务:
   *     1. UPDATE schedule.status='已完成'
   *     2. UPDATE schedule_students.attendance_status='出勤' (默认, 老师后可改)
   *     3. INSERT N 条 course_consumptions (pending_feedback)
   *
   *   这是 Step 2 — 之前缺这个 endpoint, seed 时只能直接 INSERT 终态 (违反业务事件原则)
   */
  async completeWithConsumptions(
    tenantSchema: string,
    scheduleId: string,
    options: {
      consumptionIdPrefix: string;     // ULID 前缀 (调用方提供, 服务端补 student_id hash)
      feedbackDueAtHours?: number;     // 默认 24h (V9 锁定窗口)
      requireTeacherUserId?: string;   // 2026-05-29 §12C.1: 传则校验 schedule.teacher 属于此 user（老师只能完成自己的课）
    },
  ): Promise<{ schedule: Schedule; consumptionsCreated: number; alreadyComplete: boolean }> {
    return this.pg.transaction(
      async (client) => {
        // 1. 取 schedule (validate 状态)
        const schRows = await client.query<any>(
          `SELECT id, status, teacher_id FROM schedules WHERE id = $1 FOR UPDATE`,
          [scheduleId],
        );
        if (schRows.rows.length === 0) {
          throw new NotFoundException(`schedule ${scheduleId} not found`);
        }
        const cur = schRows.rows[0];
        // 2026-05-29 全面检测 P0 (§12C.1): 老师只能完成「自己任教」的课（事务内 FOR UPDATE 锁下校验）。
        //   admin/boss/academic 代操作时不传 requireTeacherUserId → 跳过此校验。
        if (options.requireTeacherUserId) {
          const ownRows = await client.query<{ id: string }>(
            `SELECT id FROM teachers WHERE id = $1 AND user_id = $2`,
            [cur.teacher_id, options.requireTeacherUserId],
          );
          if (ownRows.rows.length === 0) {
            throw new ForbiddenException('只能完成自己任教的课次');
          }
        }
        if (cur.status === '已完成') {
          // 幂等: 已经完成过, 不重复创建 consumption
          const fullRows = await client.query<any>(
            `SELECT id, course_product_id, teacher_id, start_at, duration_min, end_at,
                    status, source, recurring_schedule_id, created_by_user_id, created_by_role, notes
             FROM schedules WHERE id = $1`,
            [scheduleId],
          );
          return {
            schedule: this.mapRow(fullRows.rows[0]),
            consumptionsCreated: 0,
            alreadyComplete: true,
          };
        }
        if (cur.status !== '已排课') {
          throw new NotFoundException(`schedule ${scheduleId} status=${cur.status}, 只能完成已排课的课`);
        }

        // 2. 取该 schedule 所有学员
        const stuRows = await client.query<{ student_id: string }>(
          `SELECT student_id FROM schedule_students WHERE schedule_id = $1`,
          [scheduleId],
        );
        const studentIds = stuRows.rows.map((r) => r.student_id);
        if (studentIds.length === 0) {
          throw new NotFoundException(`schedule ${scheduleId} 无学员关联, 不能完成`);
        }

        // 3. UPDATE schedule.status='已完成'
        const upd = await client.query<any>(
          `UPDATE schedules SET status='已完成', updated_at=NOW() WHERE id = $1
           RETURNING id, course_product_id, teacher_id, start_at, duration_min, end_at,
                     status, source, recurring_schedule_id, created_by_user_id, created_by_role, notes`,
          [scheduleId],
        );

        // 4. UPDATE schedule_students.attendance_status='待出勤' → '出勤' (默认)
        //    老师后续可在 roster 改个别学员状态
        await client.query(
          `UPDATE schedule_students SET attendance_status='出勤'
             WHERE schedule_id = $1 AND attendance_status = '待出勤'`,
          [scheduleId],
        );

        // 5. INSERT N consumption (pending_feedback)
        const dueHours = options.feedbackDueAtHours ?? 24;
        const feedbackDueAt = new Date(Date.now() + dueHours * 3600 * 1000);
        for (let i = 0; i < studentIds.length; i++) {
          const studentId = studentIds[i];
          const ccId = (options.consumptionIdPrefix + i).padEnd(32, '0').slice(0, 32);
          // 防重复: 如果该 schedule+student 已有 consumption, ON CONFLICT 跳过
          await client.query(
            `INSERT INTO course_consumptions (
               id, schedule_id, student_id, teacher_id, status,
               amount_yuan, feedback_id, feedback_due_at, created_at
             ) VALUES ($1, $2, $3, $4, 'pending_feedback', NULL, NULL, $5, NOW())
             ON CONFLICT (schedule_id, student_id) DO NOTHING`,
            [ccId, scheduleId, studentId, cur.teacher_id, feedbackDueAt],
          );
        }

        return {
          schedule: this.mapRow(upd.rows[0]),
          consumptionsCreated: studentIds.length,
          alreadyComplete: false,
        };
      },
      { tenantSchema },
    );
  }

  /**
   * 2026-05-22 老师 lesson roster 数据源:
   *   GET /db/schedules/:id JOIN schedule_students + students + teachers + course_products
   *   返完整 lesson meta + 学员 list, 替代前端 mock data
   */
  async findByIdWithRoster(
    tenantSchema: string,
    scheduleId: string,
  ): Promise<{
    schedule: Schedule & {
      teacherName: string | null;
      courseProductName: string | null;
      classType: string | null;
    };
    roster: Array<{
      studentId: string;
      studentName: string;
      attendanceStatus: AttendanceStatus;
      feedbackFilled: boolean;
    }>;
  } | null> {
    const schRows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT s.id, s.course_product_id, s.teacher_id, s.start_at, s.duration_min, s.end_at,
              s.status, s.source, s.recurring_schedule_id, s.created_by_user_id, s.created_by_role, s.notes,
              t.name AS teacher_name,
              cp.product_name AS course_product_name,
              cp.class_type
         FROM schedules s
         LEFT JOIN teachers t ON t.id = s.teacher_id
         LEFT JOIN course_products cp ON cp.id = s.course_product_id
        WHERE s.id = $1`,
      [scheduleId],
    );
    if (schRows.length === 0) return null;
    const row = schRows[0];

    // roster (含每学员是否已填反馈)
    const rosterRows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT ss.student_id, ss.attendance_status,
              st.student_name,
              EXISTS(SELECT 1 FROM lesson_feedbacks lf
                       WHERE lf.schedule_id = ss.schedule_id AND lf.student_id = ss.student_id) AS feedback_filled
         FROM schedule_students ss
         JOIN students st ON st.id = ss.student_id
        WHERE ss.schedule_id = $1
        ORDER BY st.student_name ASC`,
      [scheduleId],
    );

    return {
      schedule: {
        ...this.mapRow(row),
        teacherName: row.teacher_name || null,
        courseProductName: row.course_product_name || null,
        classType: row.class_type || null,
      },
      roster: rosterRows.map((r) => ({
        studentId: r.student_id,
        studentName: r.student_name,
        attendanceStatus: r.attendance_status,
        feedbackFilled: r.feedback_filled === true,
      })),
    };
  }

  /**
   * 2026-06-02 「从学员页写反馈」页中页数据源（Sprint Y by-student 排课接口缺口补齐）
   *
   * 列某学员的所有课次（schedule_students JOIN schedules）+ 每节是否已写该生反馈：
   *   - LEFT JOIN lesson_feedbacks (同 schedule_id + student_id) → hasFeedback / feedbackId
   *     （lesson_feedbacks UNIQUE(schedule_id, student_id)，故 LEFT JOIN 至多 1 行，不放大行数）
   *   - LEFT JOIN teachers 取 teacherName（schedules.teacher_id → teachers.id，仿 findByIdWithRoster；
   *     teacher 档案被删/缺失 → teacher_name NULL → teacherName=null，前端显「—」）
   *   - subject 取课程产品名（COALESCE(course_products.product_name)；临时辅导无产品 → null），
   *     与 lesson roster / 预览的「科目/课程」口径一致（schedules 表本身无独立 subject 列）
   *
   * 排序 start_at DESC（最近的课在前，前端从学员页选最近一节去补反馈）。
   * 已取消课（status='已取消'）一并返回（老师可能要看历史；如需过滤前端按 status 处理）。
   *
   * 安全：owner-scope 在 controller 层（assertStudentByStudentScope）已收口，repo 仅按 studentId
   *   参数化查询；tenantQuery 保证租户 schema 隔离。limit/offset 由 controller 钳制（默认 50 / 上限 200）。
   */
  async listLessonsByStudent(
    tenantSchema: string,
    studentId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<
    Array<{
      scheduleId: string;
      startAt: Date;
      subject: string | null;
      teacherName: string | null;
      durationMin: number;
      hasFeedback: boolean;
      feedbackId: string | null;
    }>
  > {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT s.id,
              s.start_at,
              s.duration_min,
              t.name AS teacher_name,
              cp.product_name AS subject,
              lf.id AS feedback_id
         FROM schedule_students ss
         JOIN schedules s ON s.id = ss.schedule_id
         LEFT JOIN teachers t ON t.id = s.teacher_id
         LEFT JOIN course_products cp ON cp.id = s.course_product_id
         LEFT JOIN lesson_feedbacks lf
                ON lf.schedule_id = ss.schedule_id
               AND lf.student_id = ss.student_id
        WHERE ss.student_id = $1
        ORDER BY s.start_at DESC
        LIMIT $2 OFFSET $3`,
      [studentId, limit, offset],
    );
    return rows.map((r) => ({
      scheduleId: r.id,
      startAt: r.start_at,
      subject: r.subject ?? null,
      teacherName: r.teacher_name ?? null,
      durationMin: Number(r.duration_min),
      hasFeedback: r.feedback_id != null,
      feedbackId: r.feedback_id ?? null,
    }));
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

  async listByTeacherUserIdWithSummary(
    tenantSchema: string,
    userId: string,
    fromDate: Date,
    toDate: Date,
  ): Promise<ScheduleCalendarItem[]> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT s.id, s.course_product_id, s.teacher_id, s.start_at, s.duration_min, s.end_at,
              s.status, s.source, s.recurring_schedule_id, s.created_by_user_id, s.created_by_role,
              s.notes, s.class_type, s.max_students,
              t.name AS teacher_name,
              cp.product_name AS course_product_name,
              COALESCE(s.class_type, cp.class_type) AS display_class_type,
              COUNT(ss.student_id)::int AS student_count
       FROM schedules s
       JOIN teachers t ON t.id = s.teacher_id
       LEFT JOIN course_products cp ON cp.id = s.course_product_id
       LEFT JOIN schedule_students ss ON ss.schedule_id = s.id
       WHERE t.user_id = $1
         AND t.status != '归档'
         AND s.start_at >= $2
         AND s.start_at < $3
         AND s.status != '已取消'
       GROUP BY s.id, t.name, cp.product_name, cp.class_type
       ORDER BY s.start_at ASC`,
      [userId, fromDate, toDate],
    );

    return rows.map((r) => ({
      ...this.mapRow(r),
      classType: r.display_class_type || r.class_type || undefined,
      maxStudents: r.max_students || undefined,
      teacherName: r.teacher_name || undefined,
      courseProductName: r.course_product_name || undefined,
      studentCount: Number(r.student_count || 0),
    }));
  }

  /**
   * 2026-06-01 教务/老板/admin 周课表（本校或全校）数据源
   *
   * 与 listByTeacherUserIdWithSummary 同一 ScheduleCalendarItem 结构（含 teacherName），
   * 但范围按校区过滤（教务/校长本校），admin 全租户（campusId 传 null 不加过滤）。
   *
   * 安全：campusId 由 controller 从 JWT.campusId 取（禁信前端传参）；
   *   TenantScopeGuard 已保证租户隔离，此处只做租户内 campus 范围收敛。
   *
   * 已取消课（status='已取消'）排除，与老师本人课表口径一致。
   */
  async listCampusCalendarInDb(
    tenantSchema: string,
    campusId: string | null,
    fromDate: Date,
    toDate: Date,
  ): Promise<ScheduleCalendarItem[]> {
    // campusId 为 null → admin 全租户视图（不加 campus 过滤）；否则严格本校
    const campusClause = campusId ? 'AND s.campus_id = $3' : '';
    const params: unknown[] = campusId
      ? [fromDate, toDate, campusId]
      : [fromDate, toDate];
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT s.id, s.course_product_id, s.teacher_id, s.start_at, s.duration_min, s.end_at,
              s.status, s.source, s.recurring_schedule_id, s.created_by_user_id, s.created_by_role,
              s.notes, s.class_type, s.max_students,
              t.name AS teacher_name,
              cp.product_name AS course_product_name,
              COALESCE(s.class_type, cp.class_type) AS display_class_type,
              COUNT(ss.student_id)::int AS student_count
       FROM schedules s
       JOIN teachers t ON t.id = s.teacher_id
       LEFT JOIN course_products cp ON cp.id = s.course_product_id
       LEFT JOIN schedule_students ss ON ss.schedule_id = s.id
       WHERE s.start_at >= $1
         AND s.start_at < $2
         AND s.status != '已取消'
         ${campusClause}
       GROUP BY s.id, t.name, cp.product_name, cp.class_type
       ORDER BY s.start_at ASC`,
      params,
    );

    return rows.map((r) => ({
      ...this.mapRow(r),
      classType: r.display_class_type || r.class_type || undefined,
      maxStudents: r.max_students || undefined,
      teacherName: r.teacher_name || undefined,
      courseProductName: r.course_product_name || undefined,
      studentCount: Number(r.student_count || 0),
    }));
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
      // 历史 row.created_by_role 可能含 'teacher' / 'sales'（5/12-5/15 写入）；
      // 类型断言为 SchedulerRole（'academic' | 'academic_admin'，2026-05-30 SSOT §5.3），
      // 运行时仍保持原值用于审计 / 兼容显示，新建必走 academic / academic_admin
      createdByRole: row.created_by_role as SchedulerRole,
      notes: row.notes || undefined,
    };
  }
}
