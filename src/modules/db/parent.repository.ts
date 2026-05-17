import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { PgPoolService, PgRow } from './pg-pool.service';
import { Parent, ParentStudentBinding, Relationship } from '../parent/parent.service';
import { FieldEncryptor } from '../../common/crypto/field-encryptor';
import { HmacHasher } from '../../common/crypto/hmac-hasher';

/**
 * ParentRepository — V10 家长 + 学员绑定持久化层（public schema 跨租户）
 *
 * V40 双列加密改造（A02-3，2026-05-13）：
 *   - INSERT/UPDATE：明文 phone（兼容期）+ phone_hash（HMAC 等值查询用）+ phone_encrypted（AES-GCM 存储）三写
 *   - findParentByPhone：phone_hash 等值查询优先；miss 时 fallback 明文 WHERE phone（兼容旧数据）
 *   - findParentById：mapRow 解密 phone_encrypted；失败 fallback 明文 phone
 *   - 对外接口（Parent.phone）始终是明文，前端 / 上层无感
 *   - 解密失败 logger.warn 不阻塞主流程（fail-open）
 *
 * 为什么需要双列（hash + encrypted），与 V34（teacher/customer）不同：
 *   - parents.phone 是 C 端登录唯一身份（UNIQUE 等值查询）
 *   - AES-GCM 随机 IV 不能等值查询 → 必须 HMAC hash 列做索引
 *   - 详见 migrations/V40__parents_phone_hash_and_encrypted.sql
 */
@Injectable()
export class ParentRepository {
  private readonly logger = new Logger(ParentRepository.name);

  constructor(
    private readonly pg: PgPoolService,
    private readonly encryptor: FieldEncryptor,
    private readonly hasher: HmacHasher,
  ) {}

  async insertParent(parent: Parent): Promise<Parent> {
    const phonePlain = parent.phone;
    const phoneHash = this.hashPhone(phonePlain);
    const phoneEncrypted = this.encryptPhone(phonePlain);
    const rows = await this.pg.query<any>(
      `INSERT INTO public.parents (id, phone, phone_hash, phone_encrypted, wechat_openid, wechat_unionid, name, avatar_url, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET
         phone = EXCLUDED.phone,
         phone_hash = EXCLUDED.phone_hash,
         phone_encrypted = EXCLUDED.phone_encrypted,
         wechat_openid = COALESCE(EXCLUDED.wechat_openid, public.parents.wechat_openid),
         name = COALESCE(EXCLUDED.name, public.parents.name),
         updated_at = NOW()
       RETURNING id, phone, phone_hash, phone_encrypted, wechat_openid, wechat_unionid, name, avatar_url, status`,
      [
        parent.id,
        phonePlain,
        phoneHash,
        phoneEncrypted,
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
      `SELECT id, phone, phone_hash, phone_encrypted, wechat_openid, wechat_unionid, name, avatar_url, status
       FROM public.parents WHERE id = $1`,
      [id],
    );
    return rows.length === 0 ? null : this.mapParentRow(rows[0]);
  }

  /**
   * V40 双读：
   *   1. 优先用 phone_hash 等值查询（生产正常路径）
   *   2. miss 时 fallback 明文 WHERE phone（兼容 backfill 未完成的旧数据 / 测试库）
   *
   * 返回的 Parent.phone 是解密后的明文（由 mapParentRow 处理）。
   */
  async findParentByPhone(phone: string): Promise<Parent | null> {
    const phoneHash = this.hashPhone(phone);

    // 1. hash 列查询（新路径）
    if (phoneHash) {
      const hashRows = await this.pg.query<any>(
        `SELECT id, phone, phone_hash, phone_encrypted, wechat_openid, wechat_unionid, name, avatar_url, status
         FROM public.parents WHERE phone_hash = $1
         LIMIT 1`,
        [phoneHash],
      );
      if (hashRows.length > 0) {
        return this.mapParentRow(hashRows[0]);
      }
    }

    // 2. fallback 明文（兼容期：旧行 phone_hash=NULL，新行已双写）
    const plainRows = await this.pg.query<any>(
      `SELECT id, phone, phone_hash, phone_encrypted, wechat_openid, wechat_unionid, name, avatar_url, status
       FROM public.parents WHERE phone = $1
       LIMIT 1`,
      [phone],
    );
    return plainRows.length === 0 ? null : this.mapParentRow(plainRows[0]);
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

  /**
   * Sprint X.2 (2026-05-17) — 按 binding id 反查 (PATCH unbind 用)
   *
   * 来源: Endpoint 8 PATCH /db/parent-bindings/:id (需要校验 tenant_id 防跨 tenant)
   * 返 null 表示 binding 不存在 (controller 层抛 404)
   */
  async findBindingById(bindingId: string): Promise<ParentStudentBinding | null> {
    const rows = await this.pg.query<any>(
      `SELECT id, parent_id, student_id, tenant_id, is_primary, relationship,
              binding_status, bound_at, unbound_at
         FROM public.parent_student_bindings
        WHERE id = $1
        LIMIT 1`,
      [bindingId],
    );
    return rows.length === 0 ? null : this.mapBindingRow(rows[0]);
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

  /**
   * V44 软删除联动（2026-05-16 T12）
   *
   * 来源：R1 audit P0-3 / spec §3.3 §4 — student 软删后 binding 应用层主动 + cron 兜底双层
   *
   * 行为：把指定 tenant 内、指定 studentIds 列表的 active binding 批量改为 unbound。
   *   - WHERE student_id = ANY($1) AND tenant_id = $2 AND binding_status = 'active'
   *   - SET binding_status='unbound', unbound_at = COALESCE(unbound_at, NOW())（幂等：保留首次 unbound 时间）
   *
   * 调用方：
   *   - student.repository.softDelete 同事务内调用（应用层主动）
   *   - T-CRON-BINDING-SYNC backlog cron 每日扫 deleted_at NOT NULL 学员后兜底调用
   *
   * @param tenantId   raw tenant id（public.parent_student_bindings.tenant_id 字段）
   * @param studentIds 学员 id 列表（32-char ULID）
   * @param client     可选 PoolClient — 若传则在该 client/事务内执行（softDelete 同事务）；
   *                   否则用 pg.query（cron 兜底独立连接）
   * @returns { unbounded: number } 受影响行数
   */
  async expireBindingsForDeletedStudents(
    tenantId: string,
    studentIds: string[],
    client?: PoolClient,
  ): Promise<{ unbounded: number }> {
    if (!tenantId || !studentIds || studentIds.length === 0) {
      return { unbounded: 0 };
    }
    const sql = `UPDATE public.parent_student_bindings
                    SET binding_status = 'unbound',
                        unbound_at = COALESCE(unbound_at, NOW())
                  WHERE student_id = ANY($1::varchar[])
                    AND tenant_id = $2
                    AND binding_status = 'active'
                  RETURNING id`;
    const params: any[] = [studentIds, tenantId];
    if (client) {
      const res = await client.query<{ id: string }>(sql, params);
      return { unbounded: res.rowCount || 0 };
    }
    const rows = await this.pg.query<{ id: string }>(sql, params);
    return { unbounded: rows.length };
  }

  // ===== helpers (V40 加密辅助) =====

  /**
   * V40 计算 phone HMAC-SHA256 hash → BYTEA Buffer
   * plaintext 空字符串也会哈希（hash('')）；null/undefined → null
   * 实际 service 层会校验 phone 必填非空，此处的 null 分支仅用于 UPDATE 部分场景兜底
   */
  private hashPhone(plaintext: string | null | undefined): Buffer | null {
    return this.hasher.hash(plaintext);
  }

  /**
   * V40 加密 phone 明文 → BYTEA Buffer（AES-256-GCM）
   * encrypt 内部对 null/undefined 返回 null
   */
  private encryptPhone(plaintext: string | null | undefined): Buffer | null {
    return this.encryptor.encrypt(plaintext);
  }

  /**
   * V40 解密 phone_encrypted → 明文。fallback 路径（fail-open）：
   *   - phone_encrypted = null / 非 Buffer / 长度 0 → 返回明文 phone
   *   - phone_encrypted 解密抛错（key 不匹配 / 数据损坏）→ logger.warn + 返回明文 phone
   *   - 都没有 → 返回明文 phone（极端兜底）
   *
   * 注意：返回 string（不是 string | undefined），因为 Parent.phone 是非可选字段
   * 兜底 fallback 即使明文为空字符串也算合法（数据库层 NOT NULL 已保证不为 null）
   */
  private decryptPhone(
    rowId: string,
    encrypted: Buffer | null | undefined,
    fallbackPlain: string,
  ): string {
    if (encrypted && Buffer.isBuffer(encrypted) && encrypted.length > 0) {
      try {
        const decoded = this.encryptor.decrypt(encrypted);
        if (decoded !== null && decoded !== undefined) {
          return decoded;
        }
      } catch (err) {
        // V40 fail-open：解密失败不阻塞业务，logger.warn + 走明文 fallback
        this.logger.warn(
          `[V40-decrypt-fallback] parent ${rowId} phone_encrypted decrypt failed: ${(err as Error).message}; using plaintext fallback`,
        );
      }
    }
    return fallbackPlain;
  }

  private mapParentRow(row: PgRow): Parent {
    const plainPhone: string = row.phone || '';
    return {
      id: row.id,
      phone: this.decryptPhone(row.id, row.phone_encrypted, plainPhone),
      wechatOpenid: row.wechat_openid || undefined,
      wechatUnionid: row.wechat_unionid || undefined,
      name: row.name || undefined,
      avatarUrl: row.avatar_url || undefined,
      status: row.status,
    };
  }

  private mapBindingRow(row: PgRow): ParentStudentBinding {
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
