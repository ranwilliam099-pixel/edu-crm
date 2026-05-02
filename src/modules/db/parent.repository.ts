import { Injectable, NotFoundException } from '@nestjs/common';
import { PgPoolService } from './pg-pool.service';
import { Parent, ParentStudentBinding, Relationship } from '../parent/parent.service';

/**
 * ParentRepository — V10 家长 + 学员绑定持久化层（public schema 跨租户）
 */
@Injectable()
export class ParentRepository {
  constructor(private readonly pg: PgPoolService) {}

  async insertParent(parent: Parent): Promise<Parent> {
    const rows = await this.pg.query<any>(
      `INSERT INTO public.parents (id, phone, wechat_openid, wechat_unionid, name, avatar_url, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         phone = EXCLUDED.phone,
         wechat_openid = COALESCE(EXCLUDED.wechat_openid, public.parents.wechat_openid),
         name = COALESCE(EXCLUDED.name, public.parents.name),
         updated_at = NOW()
       RETURNING id, phone, wechat_openid, wechat_unionid, name, avatar_url, status`,
      [
        parent.id,
        parent.phone,
        parent.wechatOpenid || null,
        parent.wechatUnionid || null,
        parent.name || null,
        parent.avatarUrl || null,
        parent.status,
      ],
    );
    return this.mapParentRow(rows[0]);
  }

  async findParentById(id: string): Promise<Parent | null> {
    const rows = await this.pg.query<any>(
      `SELECT id, phone, wechat_openid, wechat_unionid, name, avatar_url, status
       FROM public.parents WHERE id = $1`,
      [id],
    );
    return rows.length === 0 ? null : this.mapParentRow(rows[0]);
  }

  async findParentByPhone(phone: string): Promise<Parent | null> {
    const rows = await this.pg.query<any>(
      `SELECT id, phone, wechat_openid, wechat_unionid, name, avatar_url, status
       FROM public.parents WHERE phone = $1`,
      [phone],
    );
    return rows.length === 0 ? null : this.mapParentRow(rows[0]);
  }

  // ===== bindings =====

  /**
   * INSERT 绑定（DB 触发器 trg_max_3_parents 会兜底校验上限）
   */
  async insertBinding(b: ParentStudentBinding): Promise<ParentStudentBinding> {
    const rows = await this.pg.query<any>(
      `INSERT INTO public.parent_student_bindings (
         id, parent_id, student_id, tenant_id, is_primary, relationship, binding_status, bound_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, parent_id, student_id, tenant_id, is_primary, relationship,
                 binding_status, bound_at, unbound_at`,
      [
        b.id,
        b.parentId,
        b.studentId,
        b.tenantId,
        b.isPrimary,
        b.relationship,
        b.bindingStatus,
        b.boundAt,
      ],
    );
    return this.mapBindingRow(rows[0]);
  }

  async findActiveBindingsForStudent(studentId: string): Promise<ParentStudentBinding[]> {
    const rows = await this.pg.query<any>(
      `SELECT id, parent_id, student_id, tenant_id, is_primary, relationship,
              binding_status, bound_at, unbound_at
       FROM public.parent_student_bindings
       WHERE student_id = $1 AND binding_status = 'active'`,
      [studentId],
    );
    return rows.map((r) => this.mapBindingRow(r));
  }

  async findChildrenByParent(parentId: string): Promise<ParentStudentBinding[]> {
    const rows = await this.pg.query<any>(
      `SELECT id, parent_id, student_id, tenant_id, is_primary, relationship,
              binding_status, bound_at, unbound_at
       FROM public.parent_student_bindings
       WHERE parent_id = $1 AND binding_status = 'active'`,
      [parentId],
    );
    return rows.map((r) => this.mapBindingRow(r));
  }

  async unbind(bindingId: string): Promise<ParentStudentBinding> {
    const rows = await this.pg.query<any>(
      `UPDATE public.parent_student_bindings
       SET binding_status = 'unbound', unbound_at = NOW()
       WHERE id = $1
       RETURNING id, parent_id, student_id, tenant_id, is_primary, relationship,
                 binding_status, bound_at, unbound_at`,
      [bindingId],
    );
    if (rows.length === 0) throw new NotFoundException(`binding ${bindingId} not found`);
    return this.mapBindingRow(rows[0]);
  }

  // ===== helpers =====

  private mapParentRow(row: any): Parent {
    return {
      id: row.id,
      phone: row.phone,
      wechatOpenid: row.wechat_openid || undefined,
      wechatUnionid: row.wechat_unionid || undefined,
      name: row.name || undefined,
      avatarUrl: row.avatar_url || undefined,
      status: row.status,
    };
  }

  private mapBindingRow(row: any): ParentStudentBinding {
    return {
      id: row.id,
      parentId: row.parent_id,
      studentId: row.student_id,
      tenantId: row.tenant_id,
      isPrimary: row.is_primary,
      relationship: row.relationship as Relationship,
      bindingStatus: row.binding_status,
      boundAt: row.bound_at,
      unboundAt: row.unbound_at || undefined,
    };
  }
}
