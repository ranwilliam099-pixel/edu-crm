import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PgPoolService } from './pg-pool.service';
import { ulid } from 'ulid';

/**
 * TeacherChangeRequestService — SSOT §6.5「改老师 = 家长同意」流程
 *
 * 4 操作：
 *   1. request(): 教务发起 → INSERT pending
 *   2. listPending(): 教务/家长查待办
 *   3. parentDecide(): 家长 C 端同意/拒绝 → UPDATE + (approved 时) 同事务 update student + schedules
 *   4. cancel(): 教务撤回 pending 请求
 *
 * 唯一约束：1 student 同时 1 pending (V58 partial unique index 保护并发)
 *
 * approved 时副作用 (同事务原子)：
 *   - UPDATE students.assigned_teacher_id = to_teacher_id
 *   - UPDATE schedules SET teacher_id = to_teacher_id
 *     WHERE teacher_id = from_teacher_id
 *       AND id IN (SELECT schedule_id FROM schedule_students WHERE student_id = $studentId)
 *       AND status = '已排课'   -- 只改未来未 attended (SSOT §6.5 Q2)
 *
 * 注: 已 attended 历史 schedule.teacher_id 保留原 from_teacher_id (历史不动)
 */

export interface TeacherChangeRequest {
  id: string;
  studentId: string;
  fromTeacherId: string;
  toTeacherId: string;
  requestedByUserId: string;
  reason: string | null;
  parentId: string;
  campusId: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  parentDecidedAt: string | null;
  parentRejectReason: string | null;
  appliedAt: string | null;
  schedulesUpdatedCount: number | null;
  requestedAt: string;
  // 关联人名字 (page 显示用, 可选填)
  studentName?: string;
  fromTeacherName?: string;
  toTeacherName?: string;
}

export interface CreateChangeRequestDto {
  tenantSchema: string;
  studentId: string;
  toTeacherId: string;
  reason?: string;
  requestedByUserId: string;  // 来自 JWT.sub
  campusId: string;           // 来自 JWT.campusId (academic 必有)
}

@Injectable()
export class TeacherChangeRequestService {
  private readonly logger = new Logger(TeacherChangeRequestService.name);

  constructor(private readonly pg: PgPoolService) {}

  /**
   * 1. 教务发起变更请求
   *
   * 校验：
   *   - student 存在 + assigned_teacher_id 非空 (首次分配不需家长同意)
   *   - to_teacher_id 存在 + 与 from 不同 (CHECK 约束兜底)
   *   - parent_id 从 student.customer → parent_student_bindings 查到
   *   - V58 partial unique index 自动拦截「同 student 已有 pending」
   *
   * @returns 新创建的 request id
   */
  async request(dto: CreateChangeRequestDto): Promise<{ id: string }> {
    return this.pg.transaction(
      async (client) => {
        // a. 查 student.assigned_teacher_id (作为 from_teacher_id)
        const stRows = await client.query<{ assigned_teacher_id: string | null; campus_id: string | null }>(
          `SELECT s.assigned_teacher_id, c.campus_id
             FROM students s
             JOIN customers c ON c.id = s.customer_id
            WHERE s.id = $1 AND s.deleted_at IS NULL
            LIMIT 1`,
          [dto.studentId],
        );
        const st = stRows.rows[0];
        if (!st) throw new NotFoundException(`student ${dto.studentId} not found`);
        if (!st.assigned_teacher_id) {
          throw new BadRequestException(
            'STUDENT_NO_TEACHER: 学员未绑定老师，首次分配不需家长同意 — 教务直接 update student.assigned_teacher_id 即可',
          );
        }
        if (st.assigned_teacher_id === dto.toTeacherId) {
          throw new BadRequestException('SAME_TEACHER: from == to, 无需变更');
        }
        // 校验 to_teacher 存在
        const toRows = await client.query<{ id: string }>(
          `SELECT id FROM teachers WHERE id = $1 AND status = '在职' LIMIT 1`,
          [dto.toTeacherId],
        );
        if (toRows.rows.length === 0) {
          throw new NotFoundException(`to_teacher ${dto.toTeacherId} not found or 已归档`);
        }

        // b. 查 parent_id (V10 public.parent_student_bindings 跨 schema)
        // 注: parent_student_bindings 在 public schema, 不在 tenant
        const parentRows = await client.query<{ parent_id: string }>(
          `SELECT parent_id FROM public.parent_student_bindings
             WHERE student_id = $1 AND binding_status = 'active' AND is_primary = TRUE
             LIMIT 1`,
          [dto.studentId],
        );
        const parentId = parentRows.rows[0]?.parent_id;
        if (!parentId) {
          throw new BadRequestException(
            'NO_PRIMARY_PARENT: 学员未绑定主家长 — 请先在 C 端家长绑定流程完成主家长设定',
          );
        }

        // c. INSERT (V58 partial unique 自动拦「同 student 已有 pending」)
        const id = ulid().padEnd(32, '0').slice(0, 32);
        try {
          await client.query(
            `INSERT INTO teacher_change_requests
               (id, student_id, from_teacher_id, to_teacher_id, requested_by_user_id,
                reason, parent_id, campus_id, status, requested_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', NOW())`,
            [
              id,
              dto.studentId,
              st.assigned_teacher_id,
              dto.toTeacherId,
              dto.requestedByUserId,
              dto.reason || null,
              parentId,
              dto.campusId,
            ],
          );
        } catch (e: any) {
          // partial unique conflict → 23505
          if (e?.code === '23505') {
            throw new BadRequestException(
              'PENDING_EXISTS: 此学员已有 pending 变更请求，请等家长决定或撤回后再发起',
            );
          }
          throw e;
        }
        return { id };
      },
      { tenantSchema: dto.tenantSchema },
    );
  }

  /**
   * 2. 家长 C 端同意/拒绝
   *
   * approved 时同事务副作用：
   *   - UPDATE students.assigned_teacher_id = to_teacher_id
   *   - UPDATE schedules.teacher_id = to_teacher_id
   *     WHERE teacher_id = from_teacher_id
   *       AND status = '已排课'   -- 只改未来未 attended
   *       AND id IN (SELECT schedule_id FROM schedule_students WHERE student_id = $studentId)
   *
   * 校验：
   *   - request 存在 + status='pending'
   *   - parent_id = 传入 parentId (防越权 — C 端家长只能决定自己的)
   */
  async parentDecide(
    tenantSchema: string,
    id: string,
    parentId: string,
    decision: 'approved' | 'rejected',
    rejectReason?: string,
  ): Promise<{ schedulesUpdated: number }> {
    if (decision !== 'approved' && decision !== 'rejected') {
      throw new BadRequestException(`decision must be 'approved' or 'rejected'`);
    }
    return this.pg.transaction(
      async (client) => {
        // a. lock request row + 校验 parent_id 一致
        const reqRows = await client.query<{
          student_id: string;
          from_teacher_id: string;
          to_teacher_id: string;
          parent_id: string;
          status: string;
        }>(
          `SELECT student_id, from_teacher_id, to_teacher_id, parent_id, status
             FROM teacher_change_requests
            WHERE id = $1
            FOR UPDATE`,
          [id],
        );
        const r = reqRows.rows[0];
        if (!r) throw new NotFoundException(`request ${id} not found`);
        if (r.parent_id !== parentId) {
          throw new BadRequestException('PARENT_MISMATCH: 此请求不属于当前家长');
        }
        if (r.status !== 'pending') {
          throw new BadRequestException(`STATUS_NOT_PENDING: request status='${r.status}'`);
        }

        if (decision === 'rejected') {
          await client.query(
            `UPDATE teacher_change_requests
                SET status = 'rejected',
                    parent_decided_at = NOW(),
                    parent_reject_reason = $2,
                    updated_at = NOW()
              WHERE id = $1`,
            [id, rejectReason || null],
          );
          return { schedulesUpdated: 0 };
        }

        // approved → 副作用 1: UPDATE students.assigned_teacher_id
        await client.query(
          `UPDATE students SET assigned_teacher_id = $2, updated_at = NOW()
            WHERE id = $1`,
          [r.student_id, r.to_teacher_id],
        );

        // approved → 副作用 2: UPDATE 未来 未 attended schedules.teacher_id
        const schedRes = await client.query<{ id: string }>(
          `UPDATE schedules
              SET teacher_id = $3, updated_at = NOW()
            WHERE teacher_id = $2
              AND status = '已排课'
              AND id IN (SELECT schedule_id FROM schedule_students WHERE student_id = $1)
            RETURNING id`,
          [r.student_id, r.from_teacher_id, r.to_teacher_id],
        );
        const updated = schedRes.rowCount || 0;

        // approved → 副作用 3: UPDATE request status + applied
        await client.query(
          `UPDATE teacher_change_requests
              SET status = 'approved',
                  parent_decided_at = NOW(),
                  applied_at = NOW(),
                  schedules_updated_count = $2,
                  updated_at = NOW()
            WHERE id = $1`,
          [id, updated],
        );

        this.logger.log(
          `[tcr] approved id=${id} student=${r.student_id} schedules_updated=${updated}`,
        );
        return { schedulesUpdated: updated };
      },
      { tenantSchema },
    );
  }

  /**
   * 3. 教务/校长查本校 pending 列表 (academic-home todos 数据源)
   */
  async listPendingByCampus(
    tenantSchema: string,
    campusId: string,
    limit = 50,
  ): Promise<TeacherChangeRequest[]> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT tcr.*,
              s.student_name,
              ft.name AS from_teacher_name,
              tt.name AS to_teacher_name
         FROM teacher_change_requests tcr
         LEFT JOIN students s ON s.id = tcr.student_id
         LEFT JOIN teachers ft ON ft.id = tcr.from_teacher_id
         LEFT JOIN teachers tt ON tt.id = tcr.to_teacher_id
        WHERE tcr.campus_id = $1 AND tcr.status = 'pending'
        ORDER BY tcr.requested_at DESC
        LIMIT $2`,
      [campusId, limit],
    );
    return rows.map(this._mapRow);
  }

  /**
   * 4. C 端家长查自己 pending (孩子档案通知)
   */
  async listPendingByParent(
    tenantSchema: string,
    parentId: string,
  ): Promise<TeacherChangeRequest[]> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT tcr.*,
              s.student_name,
              ft.name AS from_teacher_name,
              tt.name AS to_teacher_name
         FROM teacher_change_requests tcr
         LEFT JOIN students s ON s.id = tcr.student_id
         LEFT JOIN teachers ft ON ft.id = tcr.from_teacher_id
         LEFT JOIN teachers tt ON tt.id = tcr.to_teacher_id
        WHERE tcr.parent_id = $1 AND tcr.status = 'pending'
        ORDER BY tcr.requested_at DESC
        LIMIT 50`,
      [parentId],
    );
    return rows.map(this._mapRow);
  }

  /**
   * 5. 教务撤回 pending 请求 (家长还没决定前)
   */
  async cancel(
    tenantSchema: string,
    id: string,
    requestedByUserId: string,
  ): Promise<{ updated: boolean }> {
    const rows = await this.pg.tenantQuery<{ id: string }>(
      tenantSchema,
      `UPDATE teacher_change_requests
          SET status = 'cancelled', updated_at = NOW()
        WHERE id = $1
          AND requested_by_user_id = $2
          AND status = 'pending'
        RETURNING id`,
      [id, requestedByUserId],
    );
    return { updated: rows.length > 0 };
  }

  private _mapRow(r: any): TeacherChangeRequest {
    return {
      id: r.id,
      studentId: r.student_id,
      fromTeacherId: r.from_teacher_id,
      toTeacherId: r.to_teacher_id,
      requestedByUserId: r.requested_by_user_id,
      reason: r.reason,
      parentId: r.parent_id,
      campusId: r.campus_id,
      status: r.status,
      parentDecidedAt: r.parent_decided_at,
      parentRejectReason: r.parent_reject_reason,
      appliedAt: r.applied_at,
      schedulesUpdatedCount: r.schedules_updated_count,
      requestedAt: r.requested_at,
      studentName: r.student_name,
      fromTeacherName: r.from_teacher_name,
      toTeacherName: r.to_teacher_name,
    };
  }
}
