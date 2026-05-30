import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PgPoolService, PgRow } from './pg-pool.service';

/**
 * CampusRepository — V19 SaaS 平台层校区列表（public schema）
 *
 * 来源：用户 2026-05-04 endpoint #5（boss/campuses）
 *
 * 表：public.campuses（V19 §19.1）
 *
 * 业务约束：create() 前检查 tenants.max_campuses 上限（超额抛 BadRequestException）
 */

export interface Campus {
  id: string;
  tenantId: string;
  name: string;
  city?: string;
  district?: string;
  address?: string;
  studentCount: number;
  teacherCount: number;
  status: 'active' | 'suspended';
  isHq: boolean;
  createdAt: Date;
}

@Injectable()
export class CampusRepository {
  constructor(private readonly pg: PgPoolService) {}

  async list(tenantId: string): Promise<Campus[]> {
    const rows = await this.pg.query<any>(
      `SELECT id, tenant_id, name, city, district, address,
              student_count, teacher_count, status, is_hq, created_at
       FROM public.campuses
       WHERE tenant_id = $1
       ORDER BY is_hq DESC, created_at ASC`,
      [tenantId],
    );
    return rows.map((r) => this.mapRow(r));
  }

  async create(
    tenantId: string,
    dto: {
      id: string;
      name: string;
      city?: string;
      district?: string;
      address?: string;
      isHq?: boolean;
    },
  ): Promise<Campus> {
    // 业务约束：检查 max_campuses 上限
    const tenantRows = await this.pg.query<{ max_campuses: number }>(
      `SELECT max_campuses FROM public.tenants WHERE id = $1`,
      [tenantId],
    );
    if (tenantRows.length === 0) {
      throw new NotFoundException(`tenant ${tenantId} not found`);
    }
    const maxCampuses = tenantRows[0].max_campuses;

    const countRows = await this.pg.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM public.campuses WHERE tenant_id = $1`,
      [tenantId],
    );
    const currentCount = parseInt(countRows[0]?.count || '0', 10);

    if (currentCount >= maxCampuses) {
      throw new BadRequestException(
        `CAMPUS_LIMIT_REACHED: max ${maxCampuses}, current ${currentCount}`,
      );
    }

    const rows = await this.pg.query<any>(
      `INSERT INTO public.campuses (
         id, tenant_id, name, city, district, address, is_hq
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, tenant_id, name, city, district, address,
                 student_count, teacher_count, status, is_hq, created_at`,
      [
        dto.id,
        tenantId,
        dto.name,
        dto.city || null,
        dto.district || null,
        dto.address || null,
        dto.isHq || false,
      ],
    );
    return this.mapRow(rows[0]);
  }

  /**
   * 更新校区基本信息（SSOT §5.3 校区写=老板）
   *
   * PATCH 语义：仅更新非空字段（undefined 跳过）；name/city/district/address 可改
   *   - tenant_id WHERE 保持租户隔离（防跨租户改他人校区）
   *   - 无任何 patch 字段 → BadRequestException
   *   - 目标校区不存在 / 不属于该 tenant → NotFoundException
   */
  async update(
    tenantId: string,
    id: string,
    patch: {
      name?: string;
      city?: string;
      district?: string;
      address?: string;
    },
  ): Promise<Campus> {
    const sets: string[] = [];
    const params: any[] = [];
    const push = (col: string, val: unknown) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };
    if (patch.name !== undefined) push('name', patch.name);
    if (patch.city !== undefined) push('city', patch.city);
    if (patch.district !== undefined) push('district', patch.district);
    if (patch.address !== undefined) push('address', patch.address);

    if (sets.length === 0) {
      throw new BadRequestException('至少传一个 patch 字段 (name/city/district/address)');
    }

    // tenant_id + id 双条件 WHERE：跨租户隔离
    params.push(id);
    const idIdx = params.length;
    params.push(tenantId);
    const tenantIdx = params.length;
    const rows = await this.pg.query<any>(
      `UPDATE public.campuses
          SET ${sets.join(', ')}
        WHERE id = $${idIdx} AND tenant_id = $${tenantIdx}
       RETURNING id, tenant_id, name, city, district, address,
                 student_count, teacher_count, status, is_hq, created_at`,
      params,
    );
    if (rows.length === 0) {
      throw new NotFoundException(
        `campus ${id} not found for tenant ${tenantId}`,
      );
    }
    return this.mapRow(rows[0]);
  }

  /**
   * 30 天聚合统计（每个校区 student_count / teacher_count + 总计）
   */
  async getStats30d(tenantId: string): Promise<{
    totalCampuses: number;
    totalStudents: number;
    totalTeachers: number;
    perCampus: Array<{
      campusId: string;
      name: string;
      studentCount: number;
      teacherCount: number;
    }>;
  }> {
    const rows = await this.pg.query<{
      id: string;
      name: string;
      student_count: number;
      teacher_count: number;
    }>(
      `SELECT id, name, student_count, teacher_count
       FROM public.campuses
       WHERE tenant_id = $1 AND status = 'active'`,
      [tenantId],
    );
    const totalStudents = rows.reduce((s, r) => s + (r.student_count || 0), 0);
    const totalTeachers = rows.reduce((s, r) => s + (r.teacher_count || 0), 0);
    return {
      totalCampuses: rows.length,
      totalStudents,
      totalTeachers,
      perCampus: rows.map((r) => ({
        campusId: r.id,
        name: r.name,
        studentCount: r.student_count || 0,
        teacherCount: r.teacher_count || 0,
      })),
    };
  }

  // ===== helpers =====
  private mapRow(row: PgRow): Campus {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      name: row.name,
      city: row.city || undefined,
      district: row.district || undefined,
      address: row.address || undefined,
      studentCount: row.student_count || 0,
      teacherCount: row.teacher_count || 0,
      status: row.status,
      isHq: row.is_hq,
      createdAt: row.created_at,
    };
  }
}
