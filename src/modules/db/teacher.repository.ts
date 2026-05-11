import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { PgPoolService, PgRow } from './pg-pool.service';
import { Teacher } from '../teacher/teacher.service';
import { FieldEncryptor } from '../../common/crypto/field-encryptor';

/**
 * V28 老师归档结果（注销老师 + 关联学生主带老师转移）
 */
export interface TeacherArchiveResult {
  teacher: Teacher;
  transferToTeacherId: string | null;
  transferToTeacherName: string;
  studentsReassigned: number;
}

/**
 * TeacherRepository — 教师档案 PG 持久化层
 *
 * 来源：用户 2026-05-02「做啊」（首个真接 PG 的 Repository）
 *
 * tenant schema 内的 teachers 表（V7 已建 + V34 加 phone_encrypted）：
 *   id / campus_id / name / phone / phone_encrypted (V34) / user_id / subjects(JSONB)
 *   bio / hourly_price_yuan (V39 RENAMED from hourly_rate_yuan) / status / created_at / updated_at / created_by / updated_by
 *
 * V34 双写双读模式（A02-1，2026-05-11）：
 *   - INSERT/UPDATE：phone 明文列 + phone_encrypted BYTEA 列同时写
 *   - SELECT：优先解密 phone_encrypted；解密失败或为 NULL → fallback 明文 phone
 *   - 对外接口（Teacher.phone）始终是解密后的明文，前端透明
 *   - 解密失败 logger.warn，不抛主流程（fail-open）
 *   - 旧数据（V38 backfill 前 phone_encrypted=NULL）走明文 fallback
 *   - 灰度完毕 + V38 backfill 全量后，V35+ DROP 明文列
 */
@Injectable()
export class TeacherRepository {
  private readonly logger = new Logger(TeacherRepository.name);

  constructor(
    private readonly pg: PgPoolService,
    private readonly encryptor: FieldEncryptor,
  ) {}

  /**
   * INSERT 一行 teacher 到 tenant_xxx.teachers
   *
   * V34 双写：phone 明文 + phone_encrypted 密文（同事务，保证一致）
   */
  async insert(
    tenantSchema: string,
    teacher: Teacher,
    operator: string,
  ): Promise<Teacher> {
    const phonePlain = teacher.phone || null;
    const phoneEncrypted = this.encryptPhone(phonePlain);
    const sql = `
      INSERT INTO teachers (
        id, campus_id, name, phone, phone_encrypted, user_id, subjects,
        hourly_price_yuan, status, created_by, updated_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id, campus_id, name, phone, phone_encrypted, user_id, subjects, hourly_price_yuan, status
    `;
    const params = [
      teacher.id,
      teacher.campusId,
      teacher.name,
      phonePlain,
      phoneEncrypted,
      teacher.userId || null,
      JSON.stringify(teacher.subjects || []),
      teacher.hourlyPriceYuan ?? null,
      teacher.status,
      operator,
      operator,
    ];
    const rows = await this.pg.tenantQuery<any>(tenantSchema, sql, params);
    return this.mapRow(rows[0]);
  }

  /**
   * 查询 tenant 内全部 active 教师（用于 V8 排课 schedulableTeachers）
   */
  async listActiveInTenant(tenantSchema: string): Promise<Teacher[]> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, campus_id, name, phone, phone_encrypted, user_id, subjects, hourly_price_yuan, status
       FROM teachers
       WHERE status = '在职'
       ORDER BY created_at DESC`,
    );
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * 按 ID 取
   */
  async findById(tenantSchema: string, id: string): Promise<Teacher | null> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, campus_id, name, phone, phone_encrypted, user_id, subjects, hourly_price_yuan, status
       FROM teachers WHERE id = $1`,
      [id],
    );
    return rows.length === 0 ? null : this.mapRow(rows[0]);
  }

  /**
   * Sprint B (2026-05-11): 按 user_id 反查老师档案
   *
   * 用途：
   *   - feedback / homework / assessment / learning-profile 等老师线 endpoint 的 self-check
   *   - JWT.sub（= users.id）→ teachers.user_id → teachers.id
   *
   * 规则：
   *   - user_id 在 schema 中 nullable（V7），未绑定老师档案的 user 查不到
   *   - 同一 user_id 应唯一绑定一个 teacher 行；上层不应假设多行（teachers.user_id 应建唯一索引；
   *     如未建则该方法返回第一条，多绑情况记 WARN）
   *
   * 注意：本方法不解密 phone（self-check 只看 id 不看敏感字段）
   *   — 但 mapRow 仍走解密链路（V34 fail-open），所以无副作用
   */
  async findByUserId(tenantSchema: string, userId: string): Promise<Teacher | null> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, campus_id, name, phone, phone_encrypted, user_id, subjects, hourly_price_yuan, status
       FROM teachers WHERE user_id = $1
       ORDER BY created_at ASC
       LIMIT 1`,
      [userId],
    );
    return rows.length === 0 ? null : this.mapRow(rows[0]);
  }

  /**
   * 列表（分页）
   */
  async list(
    tenantSchema: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<Teacher[]> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `SELECT id, campus_id, name, phone, phone_encrypted, user_id, subjects, hourly_price_yuan, status
       FROM teachers
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * 状态推进（状态机由 Service 校验，本层只 UPDATE）
   *
   * V34：状态更新不改 phone，所以无需重新加密；RETURNING 仍读 phone_encrypted 保持解密路径
   */
  async updateStatus(
    tenantSchema: string,
    id: string,
    newStatus: '在职' | '请假' | '归档',
    operator: string,
  ): Promise<Teacher> {
    const rows = await this.pg.tenantQuery<any>(
      tenantSchema,
      `UPDATE teachers
       SET status = $1, updated_by = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING id, campus_id, name, phone, phone_encrypted, user_id, subjects, hourly_price_yuan, status`,
      [newStatus, operator, id],
    );
    if (rows.length === 0) {
      throw new NotFoundException(`teacher ${id} not found`);
    }
    return this.mapRow(rows[0]);
  }

  /**
   * V28 老师归档（注销）+ 关联学生主带老师转移
   *
   * 来源：用户 2026-05-07「校长也应该可以注销老师和销售」
   *
   * 行为：
   *   1. teacher.status = '归档'
   *   2. 该老师 assigned_teacher_id 的所有学生 → 同 campus 其他在职老师
   *      - 找不到同 campus 在职老师 → 学生 assigned_teacher_id = NULL（待校长再分配）
   *   3. 全部在事务内
   *
   * 边界：
   *   - 已归档的老师 → BadRequestException
   *   - 老师不存在 → NotFoundException
   */
  async archive(
    tenantSchema: string,
    teacherId: string,
    operator: string,
    operatorContext?: { role?: string | null; campusId?: string | null },
  ): Promise<TeacherArchiveResult> {
    const target = await this.findById(tenantSchema, teacherId);
    if (!target) throw new NotFoundException(`teacher ${teacherId} not found`);
    if (target.status === '归档') {
      throw new BadRequestException(`teacher ${teacherId} 已归档`);
    }
    // V28 R2 RBAC 边界（用户 2026-05-07「老板也可以同样处理校长」+ 边界精化）
    // - admin / hr：任意校区老师
    // - boss：仅同校老师
    if (operatorContext) {
      const role = operatorContext.role;
      const campusId = operatorContext.campusId;
      if (role === 'boss' && campusId && target.campusId !== campusId) {
        throw new BadRequestException(
          `校长（boss）仅能归档同校区老师（operator=${campusId} / target=${target.campusId}）`,
        );
      }
      if (role && role !== 'admin' && role !== 'boss' && role !== 'hr') {
        throw new BadRequestException(`role=${role} 无老师归档权限`);
      }
    }

    // 找同 campus 其他 active 老师作接棒人（排除自己）
    const candidates = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT id, name FROM teachers
         WHERE campus_id = $1 AND id <> $2 AND status = '在职'
         ORDER BY created_at ASC LIMIT 1`,
      [target.campusId, teacherId],
    );
    const transferToId = candidates.length > 0 ? candidates[0].id : null;
    const transferToName = candidates.length > 0
      ? candidates[0].name
      : '无接棒人（待校长再分配）';

    return this.pg.transaction(
      async (client) => {
        const teacherRows = await client.query<PgRow>(
          `UPDATE teachers
              SET status = '归档', updated_by = $2, updated_at = NOW()
            WHERE id = $1 AND status <> '归档'
          RETURNING id, campus_id, name, phone, phone_encrypted, user_id, subjects, hourly_price_yuan, status`,
          [teacherId, operator],
        );
        if (teacherRows.rowCount === 0) {
          throw new BadRequestException(
            `teacher ${teacherId} 状态变更失败（可能并发已归档）`,
          );
        }

        const studentsRes = await client.query<{ id: string }>(
          `UPDATE students
              SET assigned_teacher_id = $2,
                  owner_changed_at = NOW(),
                  owner_change_reason = '老师归档'
            WHERE assigned_teacher_id = $1
            RETURNING id`,
          [teacherId, transferToId],
        );

        return {
          teacher: this.mapRow(teacherRows.rows[0]),
          transferToTeacherId: transferToId,
          transferToTeacherName: transferToName,
          studentsReassigned: studentsRes.rowCount || 0,
        };
      },
      { tenantSchema },
    );
  }

  /**
   * 计数
   */
  async countInTenant(tenantSchema: string): Promise<number> {
    const rows = await this.pg.tenantQuery<{ count: string }>(
      tenantSchema,
      `SELECT COUNT(*) as count FROM teachers`,
    );
    return parseInt(rows[0]?.count || '0', 10);
  }

  // ---- helpers ----

  /**
   * V34: 加密 phone 明文 → BYTEA Buffer（fail-fast；plaintext null → null）
   * encrypt 自身不会抛（FieldEncryptor.encrypt 对 null/undefined 返回 null），
   * 异常仅可能在 ENCRYPTION_KEY 错误时抛构造器，已在 module 启动期挡住
   */
  private encryptPhone(plaintext: string | null): Buffer | null {
    return this.encryptor.encrypt(plaintext);
  }

  /**
   * V34: 解密 phone_encrypted → 明文。fallback 路径：
   *   - phone_encrypted = null/undefined → 返回明文 phone
   *   - phone_encrypted 解密抛错（key 不匹配 / 数据损坏）→ logger.warn + 返回明文 phone
   *   - 都没有 → undefined
   *
   * 注：PG node-pg 驱动会把 BYTEA 自动转为 Buffer，但部分代码路径（如老 spec mock）
   * 可能传 null/undefined/string。一律安全处理。
   */
  private decryptPhone(
    rowId: string,
    encrypted: Buffer | null | undefined,
    fallbackPlain: string | null | undefined,
  ): string | undefined {
    if (encrypted && Buffer.isBuffer(encrypted) && encrypted.length > 0) {
      try {
        const decoded = this.encryptor.decrypt(encrypted);
        if (decoded !== null && decoded !== undefined) {
          return decoded;
        }
      } catch (err) {
        // V34 fail-open：解密失败不阻塞业务，logger.warn + 走明文 fallback
        this.logger.warn(
          `[V34-decrypt-fallback] teacher ${rowId} phone_encrypted decrypt failed: ${(err as Error).message}; using plaintext fallback`,
        );
      }
    }
    return fallbackPlain || undefined;
  }

  private mapRow(row: PgRow): Teacher {
    return {
      id: row.id,
      campusId: row.campus_id,
      name: row.name,
      phone: this.decryptPhone(row.id, row.phone_encrypted, row.phone),
      userId: row.user_id || undefined,
      subjects: typeof row.subjects === 'string' ? JSON.parse(row.subjects) : row.subjects || [],
      hourlyPriceYuan: row.hourly_price_yuan !== null ? Number(row.hourly_price_yuan) : undefined,
      status: row.status,
    };
  }
}
