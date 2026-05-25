import { Injectable, Logger } from '@nestjs/common';
import { PgPoolService, PgRow } from '../db/pg-pool.service';

/**
 * CSideRepository — P4-Y C 端家长聚合查询 2026-05-20
 *
 * 用途：
 *   - GET /api/c/home：children + todayLessons + unreadCount 一站式
 *   - GET /api/c/students/:studentId/profile：C 端学员档案（家长视角脱敏）
 *   - GET /api/c/messages：消息中心（lesson_feedbacks + monthly_reports 推送）
 *
 * 单 tenant scope（家长 ParentJwt 跨多机构时由 controller 分别调多次，与中间件单 tenant 守护对齐）
 */

// SSOT §4.1 parent C 端字段红线：仅看「姓名 + 头像 + 校区 + 主带老师」
// 5/20 round 2 BLOCKER-1 修：删 gender/gradeOrAge/schoolName 不在 §4.1 允许范围
export interface ChildBrief {
  id: string;
  name: string;
  // 主带老师（assigned_teacher_id → teachers.name）
  mainTeacherId?: string | null;
  mainTeacherName?: string | null;
  // 主带老师所在校区（teachers.campus_id → campuses.name）
  campusId?: string | null;
  campusName?: string | null;
}

export interface TodayLesson {
  id: string;
  startAt: string;
  endAt: string;
  durationMin: number;
  status: string;
  teacherId: string;
  teacherName: string;
  studentId: string;
  // 课程产品名（如 'K12 数学一对一'）
  courseProductName?: string | null;
  campusId?: string | null;
  campusName?: string | null;
}

export interface UnreadCount {
  feedbacks: number;
  monthlyReports: number;
  /** 总计 = feedbacks + monthlyReports */
  total: number;
}

export type MessageType = 'feedback' | 'monthly-report';

export interface MessageItem {
  id: string;
  type: MessageType;
  studentId: string;
  studentName: string;
  /** UI 标题 — feedback 走「课后反馈 - {学生}」/ monthly-report 走「{月份}月报 - {学生}」 */
  title: string;
  /** 内容摘要 ≤ 80 char — 不返完整 PII 内容 */
  content: string;
  senderId?: string | null;
  senderName?: string | null;
  read: boolean;
  /** ISO 8601 字符串 */
  createdAt: string;
}

@Injectable()
export class CSideRepository {
  private readonly logger = new Logger(CSideRepository.name);

  constructor(private readonly pg: PgPoolService) {}

  /**
   * 按 studentIds 拿基础档案（含主带老师 + 校区）
   *
   * 注：tenant schema 内 students + teachers + campuses JOIN
   * 已过滤 deleted_at IS NULL
   */
  async findChildrenByIds(
    tenantSchema: string,
    studentIds: string[],
  ): Promise<ChildBrief[]> {
    if (studentIds.length === 0) return [];
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT s.id, s.student_name AS name,
              s.assigned_teacher_id AS main_teacher_id,
              t.name              AS main_teacher_name,
              t.campus_id         AS campus_id,
              c.name              AS campus_name
         FROM students s
    LEFT JOIN teachers t ON t.id = s.assigned_teacher_id
    LEFT JOIN campuses c ON c.id = t.campus_id
        WHERE s.id = ANY($1::varchar[])
          AND s.deleted_at IS NULL
        ORDER BY s.created_at ASC`,
      [studentIds],
    );
    return rows.map((r) => this.mapChildRow(r));
  }

  async findChildById(
    tenantSchema: string,
    studentId: string,
  ): Promise<ChildBrief | null> {
    const list = await this.findChildrenByIds(tenantSchema, [studentId]);
    return list.length === 0 ? null : list[0];
  }

  /**
   * 今天 [startUtc, endUtc) 区间内 studentIds 名下的排课
   *
   * 通过 schedule_students 反查 schedule + teacher + campus + course_product
   */
  async findTodayLessons(
    tenantSchema: string,
    studentIds: string[],
    startUtc: Date,
    endUtc: Date,
  ): Promise<TodayLesson[]> {
    if (studentIds.length === 0) return [];
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT sc.id,
              sc.start_at, sc.end_at, sc.duration_min, sc.status,
              sc.teacher_id, t.name AS teacher_name,
              ss.student_id,
              sc.course_product_id,
              cp.product_name      AS course_product_name,
              sc.campus_id,
              ca.name              AS campus_name
         FROM schedule_students ss
         JOIN schedules     sc ON sc.id = ss.schedule_id
         JOIN teachers      t  ON t.id  = sc.teacher_id
    LEFT JOIN campuses     ca ON ca.id = sc.campus_id
    LEFT JOIN course_products cp ON cp.id = sc.course_product_id
        WHERE ss.student_id = ANY($1::varchar[])
          AND sc.start_at >= $2
          AND sc.start_at <  $3
          AND sc.status   != '已取消'
        ORDER BY sc.start_at ASC`,
      [studentIds, startUtc, endUtc],
    );
    return rows.map((r) => ({
      id: r.id,
      startAt: this.toIso(r.start_at),
      endAt: this.toIso(r.end_at),
      durationMin: Number(r.duration_min),
      status: r.status,
      teacherId: r.teacher_id,
      teacherName: r.teacher_name,
      studentId: r.student_id,
      courseProductName: r.course_product_name ?? null,
      campusId: r.campus_id ?? null,
      campusName: r.campus_name ?? null,
    }));
  }

  /**
   * 2026-05-25 #2 闭环：多日课表查询（C 端 GET /api/c/lessons）
   *
   * 复用 findTodayLessons 的 SQL 拓扑，但 WHERE 灵活：
   *   - opts.from / opts.to: 时间窗（任一可省，省略 = 不限）
   *   - opts.status: '待出勤' | '已完成' | '已取消'（省略 = 全部，但默认排除「已取消」与 today 一致）
   *   - opts.studentId: 单指定（必须在 studentIds 内，由 controller 守门）
   *
   * 复用场景：
   *   - c/leave/apply: from=today 拿即将到课（请假选课次）
   *   - c/lessons/list: 多日筛选（本周/已完成/请假）
   */
  async findLessonsForChildren(
    tenantSchema: string,
    studentIds: string[],
    opts: { from?: Date; to?: Date; status?: string; studentId?: string } = {},
  ): Promise<TodayLesson[]> {
    if (studentIds.length === 0) return [];
    const effectiveIds = opts.studentId ? [opts.studentId] : studentIds;
    const params: any[] = [effectiveIds];
    const where: string[] = [`ss.student_id = ANY($1::varchar[])`];
    if (opts.from) {
      params.push(opts.from);
      where.push(`sc.start_at >= $${params.length}`);
    }
    if (opts.to) {
      params.push(opts.to);
      where.push(`sc.start_at < $${params.length}`);
    }
    if (opts.status) {
      params.push(opts.status);
      where.push(`sc.status = $${params.length}`);
    } else {
      // 默认排除「已取消」与 findTodayLessons 一致
      where.push(`sc.status != '已取消'`);
    }
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT sc.id,
              sc.start_at, sc.end_at, sc.duration_min, sc.status,
              sc.teacher_id, t.name AS teacher_name,
              ss.student_id,
              sc.course_product_id,
              cp.product_name      AS course_product_name,
              sc.campus_id,
              ca.name              AS campus_name
         FROM schedule_students ss
         JOIN schedules     sc ON sc.id = ss.schedule_id
         JOIN teachers      t  ON t.id  = sc.teacher_id
    LEFT JOIN campuses     ca ON ca.id = sc.campus_id
    LEFT JOIN course_products cp ON cp.id = sc.course_product_id
        WHERE ${where.join(' AND ')}
        ORDER BY sc.start_at ASC
        LIMIT 200`,
      params,
    );
    return rows.map((r) => ({
      id: r.id,
      startAt: this.toIso(r.start_at),
      endAt: this.toIso(r.end_at),
      durationMin: Number(r.duration_min),
      status: r.status,
      teacherId: r.teacher_id,
      teacherName: r.teacher_name,
      studentId: r.student_id,
      courseProductName: r.course_product_name ?? null,
      campusId: r.campus_id ?? null,
      campusName: r.campus_name ?? null,
    }));
  }

  /**
   * 未读消息统计（lesson_feedbacks + monthly_reports parent_read_at IS NULL）
   */
  async countUnread(
    tenantSchema: string,
    studentIds: string[],
  ): Promise<UnreadCount> {
    if (studentIds.length === 0) {
      return { feedbacks: 0, monthlyReports: 0, total: 0 };
    }
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT
         (SELECT COUNT(*) FROM lesson_feedbacks
            WHERE student_id = ANY($1::varchar[]) AND parent_read_at IS NULL) AS fb_count,
         (SELECT COUNT(*) FROM monthly_reports
            WHERE student_id = ANY($1::varchar[])
              AND status IN ('auto_generated', 'teacher_finalized')
              AND parent_read_at IS NULL) AS mr_count`,
      [studentIds],
    );
    const row = rows[0] ?? { fb_count: 0, mr_count: 0 };
    const feedbacks = Number(row.fb_count) || 0;
    const monthlyReports = Number(row.mr_count) || 0;
    return {
      feedbacks,
      monthlyReports,
      total: feedbacks + monthlyReports,
    };
  }

  /**
   * 消息中心列表（lesson_feedbacks + monthly_reports UNION ALL，按 createdAt 倒序分页）
   *
   * @param studentIds 当前 tenant 下家长绑定的学员 ids
   * @param unreadOnly true → 仅返 parent_read_at IS NULL
   * @param limit / offset 分页
   */
  async listMessages(
    tenantSchema: string,
    studentIds: string[],
    unreadOnly: boolean,
    limit: number,
    offset: number,
  ): Promise<{ items: MessageItem[]; total: number }> {
    if (studentIds.length === 0) {
      return { items: [], total: 0 };
    }
    // feedback + monthly_report 两类来源 UNION ALL
    // teacher_note / parent_blessing 等内容用 LEFT(content, 80) 截断（不返完整 PII）
    const unreadFilter = unreadOnly
      ? 'WHERE base.read = false'
      : '';
    const sql = `
      WITH base AS (
        SELECT
          'feedback'::text       AS type,
          lf.id                  AS id,
          lf.student_id          AS student_id,
          s.student_name         AS student_name,
          COALESCE(LEFT(lf.teacher_note, 80), '') AS content,
          lf.teacher_id          AS sender_id,
          t.name                 AS sender_name,
          (lf.parent_read_at IS NOT NULL) AS read,
          lf.submitted_at        AS created_at
        FROM lesson_feedbacks lf
        JOIN students s ON s.id = lf.student_id
   LEFT JOIN teachers t ON t.id = lf.teacher_id
        WHERE lf.student_id = ANY($1::varchar[])

        UNION ALL

        SELECT
          'monthly-report'::text AS type,
          mr.id                  AS id,
          mr.student_id          AS student_id,
          s.student_name         AS student_name,
          COALESCE(LEFT(mr.parent_blessing, 80), '') AS content,
          mr.teacher_id          AS sender_id,
          t.name                 AS sender_name,
          (mr.parent_read_at IS NOT NULL) AS read,
          COALESCE(mr.finalized_at, mr.generated_at) AS created_at
        FROM monthly_reports mr
        JOIN students s ON s.id = mr.student_id
   LEFT JOIN teachers t ON t.id = mr.teacher_id
        WHERE mr.student_id = ANY($1::varchar[])
          AND mr.status IN ('auto_generated', 'teacher_finalized')
      )
      SELECT type, id, student_id, student_name, content, sender_id, sender_name, read, created_at,
             COUNT(*) OVER () AS total_count
        FROM base
       ${unreadFilter}
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3
    `;
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      sql,
      [studentIds, limit, offset],
    );
    const total = rows.length === 0 ? 0 : Number(rows[0].total_count);
    const items = rows.map((r) => this.mapMessageRow(r));
    return { items, total };
  }

  /**
   * 标记单条 message 已读
   *
   * @param type   'feedback' 或 'monthly-report'
   * @param msgId  消息 ID（lesson_feedback.id 或 monthly_report.id）
   * @param studentIds 当前 tenant 下家长绑定学员 ids（用于 owner 校验）
   * @returns true 表示成功更新；false 表示该 ID 不存在或不归属此家长
   */
  async markMessageRead(
    tenantSchema: string,
    type: MessageType,
    msgId: string,
    studentIds: string[],
  ): Promise<boolean> {
    if (studentIds.length === 0) return false;
    if (type === 'feedback') {
      const rows = await this.pg.tenantQuery<PgRow>(
        tenantSchema,
        `UPDATE lesson_feedbacks
            SET parent_read_at = COALESCE(parent_read_at, NOW())
          WHERE id = $1
            AND student_id = ANY($2::varchar[])
          RETURNING id`,
        [msgId, studentIds],
      );
      return rows.length > 0;
    }
    // monthly-report
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `UPDATE monthly_reports
          SET parent_read_at = COALESCE(parent_read_at, NOW())
        WHERE id = $1
          AND student_id = ANY($2::varchar[])
        RETURNING id`,
      [msgId, studentIds],
    );
    return rows.length > 0;
  }

  // ===== helpers =====

  // SSOT §4.1 parent C 端：仅 姓名 + 头像 + 校区 + 主带老师（5/20 round 2 BLOCKER-1）
  private mapChildRow(r: PgRow): ChildBrief {
    return {
      id: r.id,
      name: r.name,
      mainTeacherId: r.main_teacher_id ?? null,
      mainTeacherName: r.main_teacher_name ?? null,
      campusId: r.campus_id ?? null,
      campusName: r.campus_name ?? null,
    };
  }

  private mapMessageRow(r: PgRow): MessageItem {
    const type: MessageType = r.type as MessageType;
    const title =
      type === 'feedback'
        ? `课后反馈 - ${r.student_name}`
        : `${this.formatReportMonth(r.id, r.created_at)}月报 - ${r.student_name}`;
    return {
      id: r.id,
      type,
      studentId: r.student_id,
      studentName: r.student_name,
      title,
      content: r.content || '',
      senderId: r.sender_id ?? null,
      senderName: r.sender_name ?? null,
      read: Boolean(r.read),
      createdAt: this.toIso(r.created_at),
    };
  }

  /**
   * monthly_report.id 32-char 不含月份信息；title 用 createdAt 推断月份显示
   */
  private formatReportMonth(_id: string, createdAt: any): string {
    const d = createdAt instanceof Date ? createdAt : new Date(createdAt);
    if (isNaN(d.getTime())) return '本';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')} `;
  }

  private toIso(v: any): string {
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'string') return v;
    return new Date(v).toISOString();
  }
}
