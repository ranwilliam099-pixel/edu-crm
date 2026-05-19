import { Injectable } from '@nestjs/common';
import { PgPoolService } from './pg-pool.service';

/**
 * TeacherShowcaseRepository — 老师业务展示卡聚合查询
 *
 * 来源：用户 2026-05-04「依靠历史数据，给销售用于给客户展示的老师的业务逻辑」
 *
 * 11 项指标（全部从历史数据自动算）：
 *   规模：累计课时 / 累计学员 / 在管学员 / 月度课时
 *   口碑：综合评分 / 评价人次 / 推荐率 / Top 5 标签
 *   结果：续费率 / 月报 A 率
 *   案例：3 条脱敏学员故事
 *
 * 数据源：
 *   - schedules（status='已结束'）→ 课时数
 *   - schedule_students → 累计/在管学员
 *   - lesson_feedbacks → 教学痕迹
 *   - monthly_reports（grade='A'/'A+'）→ 月报 A 率 + 学员故事
 *   - course_packages → 续费率
 *   - teacher_ratings（V16 待建表）→ 评分 + 标签 + 推荐率（暂返 null，前端冷启动 fallback）
 */

export interface TeacherShowcaseSummary {
  // 教学规模
  totalLessons: number;
  totalStudents: number;
  activeStudents: number;
  monthlyLessons: number;
  // 教学口碑
  avgStars: number | null;
  ratingCount: number;
  recommendRate: number | null;
  topTags: string[];
  // 教学结果
  renewalRate: number | null;
  monthlyAReportRate: number | null;
  // 真实案例（脱敏）
  cases: Array<{
    anonName: string;
    grade: string;
    story: string;
  }>;
  // 是否冷启动（数据 < 30 节判断）
  isColdStart: boolean;
}

@Injectable()
export class TeacherShowcaseRepository {
  constructor(private readonly pg: PgPoolService) {}

  /**
   * 聚合查询老师的展示卡数据
   *
   * @param tenantSchema 机构 schema
   * @param teacherId   老师 ID
   * @returns 完整 11 项指标
   */
  async getSummary(
    tenantSchema: string,
    teacherId: string,
  ): Promise<TeacherShowcaseSummary> {
    // 1. 教学规模 — 一次查询合并多个 count
    const scaleQuery = `
      WITH schedule_stats AS (
        SELECT
          COUNT(*) FILTER (WHERE status = '已结束') as total_lessons,
          COUNT(*) FILTER (
            WHERE status = '已结束'
              AND start_at >= date_trunc('month', NOW())
          ) as monthly_lessons
        FROM schedules
        WHERE teacher_id = $1
      ),
      student_stats AS (
        SELECT
          COUNT(DISTINCT student_id) as total_students
        FROM schedule_students ss
        INNER JOIN schedules s ON s.id = ss.schedule_id
        WHERE s.teacher_id = $1 AND s.status = '已结束'
      ),
      active_stats AS (
        SELECT
          COUNT(DISTINCT student_id) as active_students
        FROM bindings
        WHERE teacher_id = $1 AND active = true
      )
      SELECT
        COALESCE(ss.total_lessons, 0)::int as total_lessons,
        COALESCE(ss.monthly_lessons, 0)::int as monthly_lessons,
        COALESCE(stu.total_students, 0)::int as total_students,
        COALESCE(act.active_students, 0)::int as active_students
      FROM schedule_stats ss
      CROSS JOIN student_stats stu
      CROSS JOIN active_stats act
    `;
    const scaleRows = await this.pg.tenantQuery<{
      total_lessons: number;
      monthly_lessons: number;
      total_students: number;
      active_students: number;
    }>(tenantSchema, scaleQuery, [teacherId]).catch(() => [
      { total_lessons: 0, monthly_lessons: 0, total_students: 0, active_students: 0 },
    ]);
    const scale = scaleRows[0] || {
      total_lessons: 0,
      monthly_lessons: 0,
      total_students: 0,
      active_students: 0,
    };

    const isColdStart = scale.total_lessons < 30;

    // 2. 月报 A 率 — V14 monthly_reports
    let monthlyAReportRate: number | null = null;
    try {
      const arRows = await this.pg.tenantQuery<{
        total: string;
        a_count: string;
      }>(
        tenantSchema,
        `SELECT
           COUNT(*) as total,
           COUNT(*) FILTER (WHERE grade IN ('A', 'A+')) as a_count
         FROM monthly_reports
         WHERE teacher_id = $1`,
        [teacherId],
      );
      const total = parseInt(arRows[0]?.total || '0', 10);
      const aCount = parseInt(arRows[0]?.a_count || '0', 10);
      if (total > 0) {
        monthlyAReportRate = Math.round((aCount * 100) / total);
      }
    } catch (e) {
      // 表不存在或字段缺失 → 保留 null
    }

    // 3. 续费率 — V12 course_packages（同学员存在多个 package = 续费）
    let renewalRate: number | null = null;
    try {
      const renewRows = await this.pg.tenantQuery<{
        total_students: string;
        renewed_students: string;
      }>(
        tenantSchema,
        `WITH student_packages AS (
           SELECT scp.student_id, COUNT(*) as pkg_count
           FROM student_course_packages scp
           INNER JOIN course_packages cp ON cp.id = scp.package_id
           WHERE scp.teacher_id = $1
           GROUP BY scp.student_id
         )
         SELECT
           COUNT(*) as total_students,
           COUNT(*) FILTER (WHERE pkg_count >= 2) as renewed_students
         FROM student_packages`,
        [teacherId],
      );
      const total = parseInt(renewRows[0]?.total_students || '0', 10);
      const renewed = parseInt(renewRows[0]?.renewed_students || '0', 10);
      if (total > 0) {
        renewalRate = Math.round((renewed * 100) / total);
      }
    } catch (e) {
      // 表不存在 → 保留 null
    }

    // 4. 真实案例（脱敏）— 取 monthly_reports.grade=A 的最近 3 条
    let cases: TeacherShowcaseSummary['cases'] = [];
    try {
      const caseRows = await this.pg.tenantQuery<{
        student_name: string;
        grade: string;
        summary: string;
      }>(
        tenantSchema,
        `SELECT
           s.name as student_name,
           s.grade,
           mr.summary
         FROM monthly_reports mr
         INNER JOIN students s ON s.id = mr.student_id
         WHERE mr.teacher_id = $1 AND mr.grade IN ('A', 'A+')
         ORDER BY mr.created_at DESC
         LIMIT 3`,
        [teacherId],
      );
      cases = caseRows.map((r) => ({
        anonName: this.anonymizeName(r.student_name),
        grade: r.grade,
        story: r.summary || '本月持续进步',
      }));
    } catch (e) {
      // 表不存在 → 空数组
    }

    // 5. 教学口碑（teacher_ratings 表 V16 待建）— 暂返 null
    // 前端 isColdStart 自动 fallback 到 bio + 资质展示
    const avgStars: number | null = null;
    const ratingCount = 0;
    const recommendRate: number | null = null;
    const topTags: string[] = [];

    return {
      totalLessons: scale.total_lessons,
      totalStudents: scale.total_students,
      activeStudents: scale.active_students,
      monthlyLessons: scale.monthly_lessons,
      avgStars,
      ratingCount,
      recommendRate,
      topTags,
      renewalRate,
      monthlyAReportRate,
      cases,
      isColdStart,
    };
  }

  /**
   * 学员姓名脱敏：「张小明」→「张同学」
   *
   * 隐私：销售给家长展示时，不能暴露其他学员的真实姓名
   */
  private anonymizeName(realName: string): string {
    if (!realName || realName.length === 0) return '某同学';
    return realName.charAt(0) + '同学';
  }
}
