import { Injectable, NotFoundException } from '@nestjs/common';
import { PgPoolService, PgRow } from './pg-pool.service';
import {
  CoursePackage,
  StudentCoursePackage,
  StudentCoursePackageStatus,
} from '../course-balance/course-balance.service';

/**
 * CoursePackageRepository — V12 课时包 + 学员课时余额持久化层（tenant schema）
 *
 * 表：
 *   course_packages（V12 §12.1）— 机构课包定义
 *   student_course_packages（V12 §12.2）— 学员账户（remaining_lessons 是 GENERATED ALWAYS）
 */
@Injectable()
export class CoursePackageRepository {
  constructor(private readonly pg: PgPoolService) {}

  // ===== course_packages =====

  async insertPackage(
    tenantSchema: string,
    pkg: CoursePackage,
    operator: string,
  ): Promise<CoursePackage> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `INSERT INTO course_packages (
         id, course_product_id, name, total_lessons, unit_price_yuan,
         total_price_yuan, validity_months, status, created_by, updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, course_product_id, name, total_lessons, unit_price_yuan,
                 total_price_yuan, validity_months, status`,
      [
        pkg.id,
        pkg.courseProductId,
        pkg.name,
        pkg.totalLessons,
        pkg.unitPriceYuan,
        pkg.totalPriceYuan,
        pkg.validityMonths,
        pkg.status,
        operator,
        operator,
      ],
    );
    return this.mapPackageRow(rows[0]);
  }

  async findPackageById(
    tenantSchema: string,
    id: string,
  ): Promise<CoursePackage | null> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, course_product_id, name, total_lessons, unit_price_yuan,
              total_price_yuan, validity_months, status
       FROM course_packages WHERE id = $1`,
      [id],
    );
    return rows.length === 0 ? null : this.mapPackageRow(rows[0]);
  }

  async listActivePackages(
    tenantSchema: string,
    courseProductId?: string,
  ): Promise<CoursePackage[]> {
    if (courseProductId) {
      const rows = await this.pg.tenantQuery<any>(
        tenantSchema,
        `SELECT id, course_product_id, name, total_lessons, unit_price_yuan,
                total_price_yuan, validity_months, status
         FROM course_packages
         WHERE status = 'active' AND course_product_id = $1
         ORDER BY created_at DESC`,
        [courseProductId],
      );
      return rows.map((r) => this.mapPackageRow(r));
    }
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, course_product_id, name, total_lessons, unit_price_yuan,
              total_price_yuan, validity_months, status
       FROM course_packages
       WHERE status = 'active'
       ORDER BY created_at DESC`,
    );
    return rows.map((r) => this.mapPackageRow(r));
  }

  async archivePackage(
    tenantSchema: string,
    id: string,
    operator: string,
  ): Promise<CoursePackage> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `UPDATE course_packages
       SET status = 'archived', updated_by = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, course_product_id, name, total_lessons, unit_price_yuan,
                 total_price_yuan, validity_months, status`,
      [operator, id],
    );
    if (rows.length === 0) throw new NotFoundException(`course_package ${id} not found`);
    return this.mapPackageRow(rows[0]);
  }

  // ===== student_course_packages =====

  async insertStudentPackage(
    tenantSchema: string,
    scp: StudentCoursePackage,
  ): Promise<StudentCoursePackage> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `INSERT INTO student_course_packages (
         id, student_id, course_package_id, contract_id,
         total_lessons, used_lessons, refunded_lessons,
         activated_at, expires_at, status, low_balance_alerted
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, student_id, course_package_id, contract_id,
                 total_lessons, used_lessons, refunded_lessons, remaining_lessons,
                 activated_at, expires_at, status, low_balance_alerted`,
      [
        scp.id,
        scp.studentId,
        scp.coursePackageId,
        scp.contractId || null,
        scp.totalLessons,
        scp.usedLessons,
        scp.refundedLessons,
        scp.activatedAt,
        scp.expiresAt,
        scp.status,
        scp.lowBalanceAlerted,
      ],
    );
    return this.mapStudentPackageRow(rows[0]);
  }

  async findStudentPackageById(
    tenantSchema: string,
    id: string,
  ): Promise<StudentCoursePackage | null> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, student_id, course_package_id, contract_id,
              total_lessons, used_lessons, refunded_lessons, remaining_lessons,
              activated_at, expires_at, status, low_balance_alerted
       FROM student_course_packages WHERE id = $1`,
      [id],
    );
    return rows.length === 0 ? null : this.mapStudentPackageRow(rows[0]);
  }

  async listActiveByStudent(
    tenantSchema: string,
    studentId: string,
  ): Promise<StudentCoursePackage[]> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, student_id, course_package_id, contract_id,
              total_lessons, used_lessons, refunded_lessons, remaining_lessons,
              activated_at, expires_at, status, low_balance_alerted
       FROM student_course_packages
       WHERE student_id = $1 AND status = 'active'
       ORDER BY activated_at DESC`,
      [studentId],
    );
    return rows.map((r) => this.mapStudentPackageRow(r));
  }

  /**
   * 扣 1 课时（事务保证 used_lessons 单调递增）
   * 失败：余额不足 / 状态非 active → NotFoundException
   */
  async deductOneLesson(
    tenantSchema: string,
    id: string,
  ): Promise<StudentCoursePackage> {
    return this.pg.transaction(async (client) => {
      const updRes = await client.query(
        `UPDATE student_course_packages
         SET used_lessons = used_lessons + 1, updated_at = NOW()
         WHERE id = $1 AND status = 'active' AND total_lessons - used_lessons - refunded_lessons > 0
         RETURNING id, student_id, course_package_id, contract_id,
                   total_lessons, used_lessons, refunded_lessons, remaining_lessons,
                   activated_at, expires_at, status, low_balance_alerted`,
        [id],
      );
      if (updRes.rowCount === 0) {
        throw new NotFoundException(`student_course_package ${id} not deductible`);
      }
      const row = updRes.rows[0];
      if (row.remaining_lessons === 0) {
        await client.query(
          `UPDATE student_course_packages SET status = 'depleted' WHERE id = $1`,
          [id],
        );
        row.status = 'depleted';
      }
      return this.mapStudentPackageRow(row);
    }, { tenantSchema });
  }

  async refundLessons(
    tenantSchema: string,
    id: string,
    count: number,
  ): Promise<StudentCoursePackage> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `UPDATE student_course_packages
       SET refunded_lessons = refunded_lessons + $1,
           updated_at = NOW()
       WHERE id = $2
         AND used_lessons + refunded_lessons + $1 <= total_lessons
       RETURNING id, student_id, course_package_id, contract_id,
                 total_lessons, used_lessons, refunded_lessons, remaining_lessons,
                 activated_at, expires_at, status, low_balance_alerted`,
      [count, id],
    );
    if (rows.length === 0) throw new NotFoundException(`student_course_package ${id} refund overflow or not found`);
    return this.mapStudentPackageRow(rows[0]);
  }

  async setStatus(
    tenantSchema: string,
    id: string,
    status: StudentCoursePackageStatus,
  ): Promise<StudentCoursePackage> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `UPDATE student_course_packages
       SET status = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, student_id, course_package_id, contract_id,
                 total_lessons, used_lessons, refunded_lessons, remaining_lessons,
                 activated_at, expires_at, status, low_balance_alerted`,
      [status, id],
    );
    if (rows.length === 0) throw new NotFoundException(`student_course_package ${id} not found`);
    return this.mapStudentPackageRow(rows[0]);
  }

  async markLowBalanceAlerted(
    tenantSchema: string,
    id: string,
  ): Promise<StudentCoursePackage> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `UPDATE student_course_packages
       SET low_balance_alerted = TRUE, updated_at = NOW()
       WHERE id = $1
       RETURNING id, student_id, course_package_id, contract_id,
                 total_lessons, used_lessons, refunded_lessons, remaining_lessons,
                 activated_at, expires_at, status, low_balance_alerted`,
      [id],
    );
    if (rows.length === 0) throw new NotFoundException(`student_course_package ${id} not found`);
    return this.mapStudentPackageRow(rows[0]);
  }

  async extendExpiry(
    tenantSchema: string,
    id: string,
    additionalDays: number,
  ): Promise<StudentCoursePackage> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `UPDATE student_course_packages
       SET expires_at = expires_at + ($1 || ' days')::interval, updated_at = NOW()
       WHERE id = $2
       RETURNING id, student_id, course_package_id, contract_id,
                 total_lessons, used_lessons, refunded_lessons, remaining_lessons,
                 activated_at, expires_at, status, low_balance_alerted`,
      [additionalDays.toString(), id],
    );
    if (rows.length === 0) throw new NotFoundException(`student_course_package ${id} not found`);
    return this.mapStudentPackageRow(rows[0]);
  }

  /**
   * cron：扫到期未处理的 active 包
   */
  async findExpired(
    tenantSchema: string,
    now: Date,
  ): Promise<StudentCoursePackage[]> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, student_id, course_package_id, contract_id,
              total_lessons, used_lessons, refunded_lessons, remaining_lessons,
              activated_at, expires_at, status, low_balance_alerted
       FROM student_course_packages
       WHERE status = 'active' AND expires_at < $1
       ORDER BY expires_at ASC`,
      [now],
    );
    return rows.map((r) => this.mapStudentPackageRow(r));
  }

  /**
   * cron：扫待发低余额提醒
   */
  async findPendingLowBalanceAlerts(
    tenantSchema: string,
    threshold: number,
  ): Promise<StudentCoursePackage[]> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, student_id, course_package_id, contract_id,
              total_lessons, used_lessons, refunded_lessons, remaining_lessons,
              activated_at, expires_at, status, low_balance_alerted
       FROM student_course_packages
       WHERE status = 'active' AND low_balance_alerted = FALSE
         AND remaining_lessons > 0 AND remaining_lessons <= $1
       ORDER BY remaining_lessons ASC`,
      [threshold],
    );
    return rows.map((r) => this.mapStudentPackageRow(r));
  }

  // ===== helpers =====

  private mapPackageRow(row: PgRow): CoursePackage {
    return {
      id: row.id,
      courseProductId: row.course_product_id,
      name: row.name,
      totalLessons: row.total_lessons,
      unitPriceYuan: Number(row.unit_price_yuan),
      totalPriceYuan: Number(row.total_price_yuan),
      validityMonths: row.validity_months,
      status: row.status,
    };
  }

  private mapStudentPackageRow(row: PgRow): StudentCoursePackage {
    return {
      id: row.id,
      studentId: row.student_id,
      coursePackageId: row.course_package_id,
      contractId: row.contract_id || undefined,
      totalLessons: row.total_lessons,
      usedLessons: row.used_lessons,
      refundedLessons: row.refunded_lessons,
      remainingLessons: row.remaining_lessons,
      activatedAt: row.activated_at,
      expiresAt: row.expires_at,
      status: row.status,
      lowBalanceAlerted: row.low_balance_alerted,
    };
  }
}
