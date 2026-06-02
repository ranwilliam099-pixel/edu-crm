import { Injectable, NotFoundException } from '@nestjs/common';
import { PgPoolService, PgRow } from './pg-pool.service';

/**
 * TrialRepository — V64 (Phase 4) 试听课持久化层
 *
 * 来源：../edu-mp-sandbox/docs/2026-06-01-业务链方案-试听激活分配反馈.md Phase 4（#9）
 *
 * 表：trials（tenant schema，V64）
 *   id / customer_id / student_name(反范式快照) / subject / preferred_time /
 *   scheduled_at / status(pending_assign→pending_teacher→scheduled→done→converted/lost) /
 *   assigned_academic_id / teacher_id / campus_id / initiated_by /
 *   result_note / converted_contract_id / created_at / updated_at
 *
 * 职责：
 *   - create(): 建试听（pending_assign，分配 side-effect 由 TrialAssignmentService 接管）
 *   - findById(): 详情（含 mapRow）
 *   - 列表查询（按 status / campus / assigned_academic / teacher，参数化）
 *   - 状态机推进（assignAcademic / arrange / complete / setResult）—— 写动作均带条件
 *     防越级（如 arrange 仅 status='pending_teacher' 才生效），状态机由 controller 先校验，
 *     repo 层 UPDATE WHERE status 二次兜底（并发安全）。
 *   - findTeacherConflicts(): decision 3 老师时段冲突，同时查 schedules + trials 两表。
 *
 * 安全：全部 pg.tenantQuery（自动 SET search_path tenant_xxx, public）；
 *   campusId 由 controller 从 JWT 取（禁信前端），repo 不做权限只做数据。
 */

export type TrialStatus =
  | 'pending_assign'
  | 'pending_teacher'
  | 'scheduled'
  | 'done'
  | 'converted'
  | 'lost';

export interface Trial {
  id: string;
  customerId: string;
  studentName: string | null;
  subject: string | null;
  preferredTime: string | null;
  scheduledAt: string | null;
  status: TrialStatus;
  assignedAcademicId: string | null;
  teacherId: string | null;
  campusId: string;
  initiatedBy: string;
  resultNote: string | null;
  convertedContractId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 老师时段冲突命中（schedules 正式课 / trials 其他试听） */
export interface TeacherConflict {
  source: 'schedule' | 'trial';
  id: string;
  startAt: string;
  endAt: string;
}

@Injectable()
export class TrialRepository {
  constructor(private readonly pg: PgPoolService) {}

  private static mapRow(row: PgRow): Trial {
    return {
      id: row.id,
      customerId: row.customer_id,
      studentName: row.student_name ?? null,
      subject: row.subject ?? null,
      preferredTime: row.preferred_time ?? null,
      scheduledAt: row.scheduled_at ? new Date(row.scheduled_at).toISOString() : null,
      status: row.status as TrialStatus,
      assignedAcademicId: row.assigned_academic_id ?? null,
      teacherId: row.teacher_id ?? null,
      campusId: row.campus_id,
      initiatedBy: row.initiated_by,
      resultNote: row.result_note ?? null,
      convertedContractId: row.converted_contract_id ?? null,
      createdAt: row.created_at
        ? new Date(row.created_at).toISOString()
        : new Date(0).toISOString(),
      updatedAt: row.updated_at
        ? new Date(row.updated_at).toISOString()
        : new Date(0).toISOString(),
    };
  }

  private static readonly COLS = `id, customer_id, student_name, subject, preferred_time,
              scheduled_at, status, assigned_academic_id, teacher_id, campus_id,
              initiated_by, result_note, converted_contract_id, created_at, updated_at`;

  // ============================================================
  // 写：create（销售发起，初始 pending_assign）
  // ============================================================
  /**
   * 建试听。初始 status='pending_assign'（分配由 TrialAssignmentService 在创建后触发推进）。
   * assigned_academic_id/teacher_id/scheduled_at 均 NULL（待分配/排课）。
   */
  async create(
    tenantSchema: string,
    input: {
      id: string;
      customerId: string;
      studentName: string | null;
      subject: string | null;
      preferredTime: string | null;
      campusId: string;
      initiatedBy: string;
    },
  ): Promise<Trial> {
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `INSERT INTO trials
         (id, customer_id, student_name, subject, preferred_time,
          status, campus_id, initiated_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'pending_assign', $6, $7, NOW(), NOW())
       RETURNING ${TrialRepository.COLS}`,
      [
        input.id,
        input.customerId,
        input.studentName,
        input.subject,
        input.preferredTime,
        input.campusId,
        input.initiatedBy,
      ],
    );
    return TrialRepository.mapRow(rows[0]);
  }

  // ============================================================
  // 读：findById
  // ============================================================
  async findById(tenantSchema: string, id: string): Promise<Trial | null> {
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT ${TrialRepository.COLS} FROM trials WHERE id = $1`,
      [id],
    );
    return rows.length === 0 ? null : TrialRepository.mapRow(rows[0]);
  }

  // ============================================================
  // 读：列表（按 status / campus / assigned_academic / teacher 任意组合，参数化）
  // ============================================================
  /**
   * 通用列表查询。所有过滤条件均为可选，参数化拼接（防注入）。
   *   - campusId：本校隔离（校长/admin 列表）
   *   - assignedAcademicId：教务「我的试听」
   *   - teacherId：某老师的试听
   *   - status：单个状态过滤
   *   - assignedIsNull=true：待分配（assigned_academic_id IS NULL）
   * ORDER BY created_at DESC（最新优先）；limit 默认 100 上限 200。
   */
  async list(
    tenantSchema: string,
    filter: {
      campusId?: string;
      assignedAcademicId?: string;
      teacherId?: string;
      initiatedBy?: string;
      status?: TrialStatus;
      assignedIsNull?: boolean;
      limit?: number;
      offset?: number;
    },
  ): Promise<Trial[]> {
    const where: string[] = [];
    const params: unknown[] = [];

    if (filter.campusId) {
      params.push(filter.campusId);
      where.push(`campus_id = $${params.length}`);
    }
    if (filter.assignedAcademicId) {
      params.push(filter.assignedAcademicId);
      where.push(`assigned_academic_id = $${params.length}`);
    }
    if (filter.assignedIsNull) {
      where.push(`assigned_academic_id IS NULL`);
    }
    if (filter.teacherId) {
      params.push(filter.teacherId);
      where.push(`teacher_id = $${params.length}`);
    }
    if (filter.initiatedBy) {
      params.push(filter.initiatedBy);
      where.push(`initiated_by = $${params.length}`);
    }
    if (filter.status) {
      params.push(filter.status);
      where.push(`status = $${params.length}`);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = filter.limit ? Math.min(filter.limit, 200) : 100;
    const offset = filter.offset ?? 0;
    params.push(limit);
    const limitIdx = params.length;
    params.push(offset);
    const offsetIdx = params.length;

    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT ${TrialRepository.COLS} FROM trials
         ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    );
    return rows.map((r) => TrialRepository.mapRow(r));
  }

  // ============================================================
  // 写：分配教务（pending_assign → pending_teacher）
  // ============================================================
  /**
   * 设 assigned_academic_id + status='pending_teacher'。
   *   WHERE status='pending_assign' 二次兜底（仅待分配可派；并发安全）。
   *   返回 null = 行不存在 或 状态非 pending_assign（controller 转 400）。
   */
  async assignAcademic(
    tenantSchema: string,
    id: string,
    academicId: string,
  ): Promise<Trial | null> {
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `UPDATE trials
          SET assigned_academic_id = $1, status = 'pending_teacher', updated_at = NOW()
        WHERE id = $2 AND status = 'pending_assign'
      RETURNING ${TrialRepository.COLS}`,
      [academicId, id],
    );
    return rows.length === 0 ? null : TrialRepository.mapRow(rows[0]);
  }

  // ============================================================
  // 写：排老师（pending_teacher → scheduled）
  // ============================================================
  /**
   * 设 teacher_id + scheduled_at + status='scheduled'。
   *   WHERE status='pending_teacher' 二次兜底（仅待排老师可排；并发安全）。
   *   老师时段冲突校验由 controller 先调 findTeacherConflicts（本方法只落库）。
   */
  async arrange(
    tenantSchema: string,
    id: string,
    teacherId: string,
    scheduledAt: Date,
  ): Promise<Trial | null> {
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `UPDATE trials
          SET teacher_id = $1, scheduled_at = $2, status = 'scheduled', updated_at = NOW()
        WHERE id = $3 AND status = 'pending_teacher'
      RETURNING ${TrialRepository.COLS}`,
      [teacherId, scheduledAt, id],
    );
    return rows.length === 0 ? null : TrialRepository.mapRow(rows[0]);
  }

  // ============================================================
  // 写：标记已试听（scheduled → done）
  // ============================================================
  async complete(tenantSchema: string, id: string): Promise<Trial | null> {
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `UPDATE trials
          SET status = 'done', updated_at = NOW()
        WHERE id = $1 AND status = 'scheduled'
      RETURNING ${TrialRepository.COLS}`,
      [id],
    );
    return rows.length === 0 ? null : TrialRepository.mapRow(rows[0]);
  }

  // ============================================================
  // 写：试听结果（done → converted / lost）
  // ============================================================
  /**
   * 设终态 converted / lost + result_note。
   *   WHERE status='done' 二次兜底（仅已试听可定结果；并发安全）。
   *   转化签约走既有签约流（不在此自动建合同），converted_contract_id 预留 NULL。
   */
  async setResult(
    tenantSchema: string,
    id: string,
    result: 'converted' | 'lost',
    note: string | null,
  ): Promise<Trial | null> {
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `UPDATE trials
          SET status = $1, result_note = $2, updated_at = NOW()
        WHERE id = $3 AND status = 'done'
      RETURNING ${TrialRepository.COLS}`,
      [result, note, id],
    );
    return rows.length === 0 ? null : TrialRepository.mapRow(rows[0]);
  }

  // ============================================================
  // 读：decision 3 老师时段冲突（schedules + trials 两表 overlap）
  // ============================================================
  /**
   * 查某老师在 [startAt, endAt) 时段是否已被占用，同时查：
   *   1. schedules（正式课，teacher_id = teachers.id，排除 status='已取消'）
   *   2. trials（其他试听，teacher_id = teachers.id，status='scheduled' 即已排定的试听）
   *
   * overlap 判定：existing.start < new.end AND existing.end > new.start（半开区间）。
   *   - schedules 有 end_at 列，直接比。
   *   - trials 无 end_at 列 → 用 scheduled_at + durationMin 推算 end（参数 durationMin）。
   *     默认试听时长 60 分钟（controller 传入；与正式课 durationMin 口径对齐做冲突）。
   *
   * @param excludeTrialId  排课时排除自身（重排场景，避免和自己冲突）；可空。
   * @returns 命中的冲突列表（空 = 无冲突）。
   */
  async findTeacherConflicts(
    tenantSchema: string,
    teacherId: string,
    startAt: Date,
    endAt: Date,
    durationMin: number,
    excludeTrialId?: string,
  ): Promise<TeacherConflict[]> {
    // 1. 正式课冲突（schedules）
    const schedRows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT id, start_at, end_at
         FROM schedules
        WHERE teacher_id = $1
          AND status != '已取消'
          AND start_at < $3
          AND end_at > $2`,
      [teacherId, startAt, endAt],
    );

    // 2. 其他已排定试听冲突（trials）。end = scheduled_at + durationMin（trials 无 end 列）。
    //    overlap：scheduled_at < new.end AND (scheduled_at + durationMin) > new.start
    //    excludeTrialId 排除自身（重排同一条不算冲突）。
    const trialParams: unknown[] = [teacherId, startAt, endAt, durationMin];
    let excludeClause = '';
    if (excludeTrialId) {
      trialParams.push(excludeTrialId);
      excludeClause = `AND id != $${trialParams.length}`;
    }
    const trialRows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT id, scheduled_at,
              (scheduled_at + ($4 || ' minutes')::interval) AS end_at
         FROM trials
        WHERE teacher_id = $1
          AND status = 'scheduled'
          AND scheduled_at IS NOT NULL
          AND scheduled_at < $3
          AND (scheduled_at + ($4 || ' minutes')::interval) > $2
          ${excludeClause}`,
      trialParams,
    );

    const conflicts: TeacherConflict[] = [];
    for (const r of schedRows) {
      conflicts.push({
        source: 'schedule',
        id: r.id,
        startAt: new Date(r.start_at).toISOString(),
        endAt: new Date(r.end_at).toISOString(),
      });
    }
    for (const r of trialRows) {
      conflicts.push({
        source: 'trial',
        id: r.id,
        startAt: new Date(r.scheduled_at).toISOString(),
        endAt: new Date(r.end_at).toISOString(),
      });
    }
    return conflicts;
  }

  // ============================================================
  // 读（事务内，分配用）：取试听当前 assigned + status FOR UPDATE
  // ============================================================
  /**
   * 仅供 TrialAssignmentService 事务内调用（已在 client 上下文）。
   * 这里提供非事务版本仅作单元可测兜底；分配主流程用 client.query 直接锁行。
   */
  async findAssignBrief(
    tenantSchema: string,
    id: string,
  ): Promise<{ assignedAcademicId: string | null; status: TrialStatus } | null> {
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT assigned_academic_id, status FROM trials WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) return null;
    return {
      assignedAcademicId: rows[0].assigned_academic_id ?? null,
      status: rows[0].status as TrialStatus,
    };
  }

  /** 存在性兜底（controller 状态机校验前用，统一 NotFound 语义） */
  async requireExists(tenantSchema: string, id: string): Promise<Trial> {
    const t = await this.findById(tenantSchema, id);
    if (!t) throw new NotFoundException(`trial ${id} not found`);
    return t;
  }
}
