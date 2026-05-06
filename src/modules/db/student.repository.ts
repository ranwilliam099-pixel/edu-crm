import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PgPoolService, PgRow } from './pg-pool.service';

/**
 * StudentRepository — V28 学生归属字段读写 + 单条学生归属转移
 *
 * 来源：用户 2026-05-07「学生也可以切换给别的老师和销售」
 *
 * 字段（V28 加）：
 *   owner_sales_id        销售归属（FK users）
 *   assigned_teacher_id   主带老师（FK teachers）
 *   owner_changed_at      最近一次归属变更时间
 *   owner_change_reason   变更原因（'老师手动转交' / '销售手动转交' / '老师归档' / ...）
 */

export interface StudentBrief {
  id: string;
  studentName: string;
  customerId: string;
  ownerSalesId: string | null;
  assignedTeacherId: string | null;
  ownerChangedAt: string | null;
  ownerChangeReason: string | null;
}

export interface StudentTransferResult {
  studentId: string;
  fromUserId: string | null;
  toUserId: string | null;
  field: 'owner_sales_id' | 'assigned_teacher_id';
  reason: string;
}

@Injectable()
export class StudentRepository {
  constructor(private readonly pg: PgPoolService) {}

  static mapBrief(r: PgRow): StudentBrief {
    return {
      id: r.id,
      studentName: r.student_name,
      customerId: r.customer_id,
      ownerSalesId: r.owner_sales_id,
      assignedTeacherId: r.assigned_teacher_id,
      ownerChangedAt: r.owner_changed_at ? new Date(r.owner_changed_at).toISOString() : null,
      ownerChangeReason: r.owner_change_reason,
    };
  }

  /**
   * V29 R2 销售即时建学生（替代仅 batch import 的限制）
   *
   * 来源：用户 2026-05-07「全做」— 销售签约前临时新增学员
   *
   * 必填：id（32-char ULID）/ studentName / customerId（FK customers，必须已存在）
   * 可选：gradeOrAge / intendedSubject / ownerSalesId / assignedTeacherId / studentInfo
   */
  async create(
    tenantSchema: string,
    payload: {
      id: string;
      studentName: string;
      customerId: string;
      gradeOrAge?: string;
      intendedSubject?: string;
      schoolName?: string;
      gender?: '男' | '女' | '未知';
      ownerSalesId?: string | null;
      assignedTeacherId?: string | null;
      operatorUserId: string;
    },
  ): Promise<StudentBrief> {
    if (!payload.id || payload.id.length !== 32) {
      throw new BadRequestException('student id must be 32-char ULID');
    }
    if (!payload.studentName || payload.studentName.length > 32) {
      throw new BadRequestException('studentName required and ≤ 32');
    }
    if (!payload.customerId || payload.customerId.length !== 32) {
      throw new BadRequestException('customerId must be 32-char ULID');
    }
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `INSERT INTO students
         (id, student_name, customer_id, grade_or_age, intended_subject, school_name, gender,
          owner_sales_id, assigned_teacher_id, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
       RETURNING id, student_name, customer_id, owner_sales_id, assigned_teacher_id,
                 owner_changed_at, owner_change_reason`,
      [
        payload.id,
        payload.studentName,
        payload.customerId,
        payload.gradeOrAge || null,
        payload.intendedSubject || null,
        payload.schoolName || null,
        payload.gender || null,
        payload.ownerSalesId || null,
        payload.assignedTeacherId || null,
        payload.operatorUserId,
      ],
    );
    return StudentRepository.mapBrief(rows[0]);
  }

  async findBrief(tenantSchema: string, id: string): Promise<StudentBrief | null> {
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT id, student_name, customer_id, owner_sales_id, assigned_teacher_id,
              owner_changed_at, owner_change_reason
         FROM students WHERE id = $1`,
      [id],
    );
    return rows.length === 0 ? null : StudentRepository.mapBrief(rows[0]);
  }

  /**
   * 把学生转给另一个销售（owner_sales_id 改写）
   *
   * @param toSalesId 接棒销售 user.id；null = 退回池（学生归属暂无）
   * @param reason    'sales 主动转交' / '校长再分配' 等可读原因（写 owner_change_reason）
   */
  async transferSales(
    tenantSchema: string,
    studentId: string,
    toSalesId: string | null,
    reason: string,
  ): Promise<StudentTransferResult> {
    if (!reason) throw new BadRequestException('reason required');
    const before = await this.findBrief(tenantSchema, studentId);
    if (!before) throw new NotFoundException(`student ${studentId} not found`);
    if (before.ownerSalesId === toSalesId) {
      throw new BadRequestException('已是该销售归属，无须转交');
    }
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `UPDATE students
          SET owner_sales_id = $2,
              owner_changed_at = NOW(),
              owner_change_reason = $3
        WHERE id = $1
      RETURNING id, owner_sales_id`,
      [studentId, toSalesId, reason],
    );
    return {
      studentId: rows[0].id,
      fromUserId: before.ownerSalesId,
      toUserId: rows[0].owner_sales_id,
      field: 'owner_sales_id',
      reason,
    };
  }

  /**
   * 把学生主带老师转给另一个老师（assigned_teacher_id 改写）
   *
   * @param toTeacherId 接棒老师 teacher.id；null = 暂无
   */
  async transferTeacher(
    tenantSchema: string,
    studentId: string,
    toTeacherId: string | null,
    reason: string,
  ): Promise<StudentTransferResult> {
    if (!reason) throw new BadRequestException('reason required');
    const before = await this.findBrief(tenantSchema, studentId);
    if (!before) throw new NotFoundException(`student ${studentId} not found`);
    if (before.assignedTeacherId === toTeacherId) {
      throw new BadRequestException('已是该老师主带，无须转交');
    }
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `UPDATE students
          SET assigned_teacher_id = $2,
              owner_changed_at = NOW(),
              owner_change_reason = $3
        WHERE id = $1
      RETURNING id, assigned_teacher_id`,
      [studentId, toTeacherId, reason],
    );
    return {
      studentId: rows[0].id,
      fromUserId: before.assignedTeacherId,
      toUserId: rows[0].assigned_teacher_id,
      field: 'assigned_teacher_id',
      reason,
    };
  }
}
