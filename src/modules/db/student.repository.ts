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
