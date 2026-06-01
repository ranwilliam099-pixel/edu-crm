import { Injectable } from '@nestjs/common';
import { PgPoolService, PgRow } from './pg-pool.service';

/**
 * CampusAssignmentConfigRepository — V63 (Phase 3) 校区学员分配配置
 *
 * 来源：../edu-mp-sandbox/docs/2026-06-01-业务链方案-试听激活分配反馈.md Phase 3（#8）
 *
 * 表：campus_assignment_config（tenant schema，V63）
 *   campus_id            PK（public.campuses.id）
 *   auto_assign_academic 是否自动分配教务（默认 false = 校长手动）
 *   rr_last_academic_id  round-robin 游标（上次发到的 academic.id；NULL = 从头）
 *   updated_by / updated_at
 *
 * 职责：
 *   - get(): 读配置（无行 → 视为 auto=false 默认，返 null 由调用方兜默认）
 *   - upsertAutoAssign(): 校长改开关（INSERT ... ON CONFLICT DO UPDATE）
 *   - 注：round-robin 游标推进（SELECT FOR UPDATE）在 StudentAssignmentService
 *     的事务内做（需与 students.assigned_academic_id 同事务），本 repo 不单独暴露写游标。
 */

export interface CampusAssignmentConfig {
  campusId: string;
  autoAssignAcademic: boolean;
  rrLastAcademicId: string | null;
  updatedBy: string | null;
  updatedAt: string;
}

@Injectable()
export class CampusAssignmentConfigRepository {
  constructor(private readonly pg: PgPoolService) {}

  private static mapRow(row: PgRow): CampusAssignmentConfig {
    return {
      campusId: row.campus_id,
      autoAssignAcademic: row.auto_assign_academic === true,
      rrLastAcademicId: row.rr_last_academic_id ?? null,
      updatedBy: row.updated_by ?? null,
      updatedAt: row.updated_at
        ? new Date(row.updated_at).toISOString()
        : new Date(0).toISOString(),
    };
  }

  /**
   * 读某校区配置。无行 → null（调用方兜默认 auto=false）。
   */
  async get(
    tenantSchema: string,
    campusId: string,
  ): Promise<CampusAssignmentConfig | null> {
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT campus_id, auto_assign_academic, rr_last_academic_id, updated_by, updated_at
         FROM campus_assignment_config
        WHERE campus_id = $1`,
      [campusId],
    );
    return rows.length === 0 ? null : CampusAssignmentConfigRepository.mapRow(rows[0]);
  }

  /**
   * 校长设「是否自动分配」开关（upsert）。
   *   - INSERT 新行（默认 rr_last_academic_id 留 NULL，游标由分配时推进）
   *   - 冲突（同 campus_id 已有行）→ 仅更新 auto_assign_academic + updated_by/at
   *     （不动 rr_last_academic_id，保留发牌游标连续性）
   */
  async upsertAutoAssign(
    tenantSchema: string,
    campusId: string,
    autoAssignAcademic: boolean,
    updatedBy: string,
  ): Promise<CampusAssignmentConfig> {
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `INSERT INTO campus_assignment_config
         (campus_id, auto_assign_academic, updated_by, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (campus_id) DO UPDATE
         SET auto_assign_academic = EXCLUDED.auto_assign_academic,
             updated_by = EXCLUDED.updated_by,
             updated_at = NOW()
       RETURNING campus_id, auto_assign_academic, rr_last_academic_id, updated_by, updated_at`,
      [campusId, autoAssignAcademic, updatedBy],
    );
    return CampusAssignmentConfigRepository.mapRow(rows[0]);
  }
}
