import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PgPoolService, PgRow } from './pg-pool.service';
import { FieldEncryptor } from '../../common/crypto/field-encryptor';
import { HmacHasher } from '../../common/crypto/hmac-hasher';

/**
 * CustomerRepository — V25 销售客户管理（基于 V2 opportunities + V25 ALTER）
 *
 * 业务流：
 *   1. 新线索（owner_user_id=NULL）入公共池
 *   2. 销售 claim → owner_user_id = me
 *   3. 销售跟进（addFollow 写 customer_follow_log）
 *   4. 销售 release → owner_user_id 回 NULL
 *   5. 30 天无跟进 cron → 自动回池
 *
 * V34 双写双读模式（A02-2，2026-05-11）：
 *   - opportunities.phone + phone_encrypted 双轨；opportunities.wechat + wechat_encrypted 双轨
 *   - INSERT/UPDATE：明文列 + *_encrypted BYTEA 列同事务一并写
 *   - SELECT：优先解密 *_encrypted；解密失败或 NULL → fallback 明文
 *   - 对外接口（Customer.phone/wechat）始终是解密后的明文，前端透明
 *   - 解密失败 logger.warn + fallback 明文（fail-open，不阻塞主流程）
 *   - opportunities 表无 WHERE phone=? 等值查询、无 UNIQUE 索引 → GCM 随机 IV 不影响功能
 *   - 旧数据（V40 backfill 前 *_encrypted=NULL）走明文 fallback
 *   - 灰度完毕 + V40 backfill 全量后，V41+ DROP 明文列
 *
 * V41 三写模式（A02-4，2026-05-13）：
 *   - customers.primary_mobile + primary_mobile_hash + primary_mobile_encrypted 三轨
 *   - createWithOpportunity INSERT customers：三列同事务一并写
 *   - 兼容期：旧行 *_hash/*_encrypted=NULL，新行三写
 *   - 查重路径（StudentImportRepository）：hash 列优先 + 明文 fallback
 *   - 注意：customers 表的 INSERT 当前只在 createWithOpportunity + StudentImport，
 *     SELECT 路径不在 CustomerRepository（CustomerRepository 操作的是 opportunities 表）
 */

export type CustomerStage =
  | '初步接触' | '需求诊断' | '已预约试听' | '已试听待转化'
  | '已出方案' | '谈单中' | '已报名' | '已失单';

export type FollowType =
  | 'lead' | 'consult' | 'trial_invited' | 'trial_done'
  | 'signed' | 'lost' | 'remark' | 'released' | 'claimed';

export interface Customer {
  id: string;
  studentId: string;
  // V25 JOIN students 真姓名 + 年级（mapCustomerRow 只在 SELECT 含 join 字段时填充）
  studentName: string | null;
  gradeOrAge: string | null;
  intendedSubject: string | null;
  ownerUserId: string | null;
  stage: CustomerStage;
  source: string | null;
  phone: string | null;
  wechat: string | null;
  intentLevel: '高' | '中' | '低' | null;
  urgent: boolean;
  note: string | null;
  enteredPoolAt: string | null;
  enterPoolReason: string | null;
  lastContactAt: string | null;
  signedAt: string | null;
  lostReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FollowEntry {
  id: string;
  opportunityId: string;
  followType: FollowType;
  label: string;
  byUserId: string | null;
  byLabel: string;
  occurredAt: string;
  extra: Record<string, unknown> | null;
}

const POOL_LIMIT_PER_SALES = 50;
const POOL_RESET_REASON = {
  newLead: 'new_lead',
  released: 'released_by_sales',
  cold: 'cold_30d',
  salesQuit: 'sales_quit',
};

/**
 * V29 R2 销售即时建客户结果（含 customer + opportunity + 可选 student）
 */
export interface CreateCustomerResult {
  customerId: string;
  opportunityId: string;
  studentId: string | null;
}

@Injectable()
export class CustomerRepository {
  private readonly logger = new Logger(CustomerRepository.name);

  constructor(
    private readonly pg: PgPoolService,
    private readonly encryptor: FieldEncryptor,
    private readonly hasher: HmacHasher,
  ) {}

  /**
   * V29 R2 销售即时建客户（家长） + opportunity + 可选 student（一并）
   *
   * 来源：用户 2026-05-07「全做」— 销售自己开拓的客户能即时录入，不必等公共池
   *
   * 事务内：
   *   1. INSERT customers（家长）
   *   2. INSERT students（如 studentName 提供）
   *   3. INSERT opportunities（owner_user_id = 销售自己，stage='初步接触'）
   *
   * RBAC：sales / sales_manager / boss / admin（销售口可建）— 5/15 A-2 删 sales_director
   */
  async createWithOpportunity(
    tenantSchema: string,
    payload: {
      customerId: string;
      opportunityId: string;
      parentName: string;
      primaryMobile: string;
      campusId: string;
      ownerSalesId: string;
      // student 可选 — 提供则一并建学生（关联 customer + opportunity）
      studentId?: string;
      studentName?: string;
      gradeOrAge?: string;
      intendedSubject?: string;
      // opportunity 字段
      stage?: string;
      source?: string;
      note?: string;
    },
  ): Promise<CreateCustomerResult> {
    if (!payload.customerId || payload.customerId.length !== 32) {
      throw new BadRequestException('customerId must be 32-char ULID');
    }
    if (!payload.opportunityId || payload.opportunityId.length !== 32) {
      throw new BadRequestException('opportunityId must be 32-char ULID');
    }
    if (!payload.parentName) throw new BadRequestException('parentName required');
    if (!payload.primaryMobile || !/^1[3-9]\d{9}$/.test(payload.primaryMobile)) {
      throw new BadRequestException('primaryMobile must be 11-digit Chinese mobile');
    }
    if (!payload.campusId) throw new BadRequestException('campusId required');
    if (!payload.ownerSalesId) throw new BadRequestException('ownerSalesId required');
    if (payload.studentName && (!payload.studentId || payload.studentId.length !== 32)) {
      throw new BadRequestException('当传 studentName 时必须传 32-char studentId');
    }

    return this.pg.transaction(
      async (client) => {
        // 1. customer（家长）
        //    V41 A02-4：primary_mobile 明文 + primary_mobile_hash（HMAC 等值查询）
        //                + primary_mobile_encrypted（AES-GCM 存储）三写（同事务保证一致）
        //    旧数据兼容期 *_hash/*_encrypted=NULL；新写入三列同时落
        const mobilePlain = payload.primaryMobile;
        const mobileHash = this.hashMobile(mobilePlain);
        const mobileEncrypted = this.encryptMobile(mobilePlain);
        await client.query(
          `INSERT INTO customers (
             id, parent_name,
             primary_mobile, primary_mobile_hash, primary_mobile_encrypted,
             campus_id, owner_id, created_by, updated_by
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $7)`,
          [
            payload.customerId,
            payload.parentName,
            mobilePlain,
            mobileHash,
            mobileEncrypted,
            payload.campusId,
            payload.ownerSalesId,
          ],
        );

        // 2. student（可选）
        let createdStudentId: string | null = null;
        if (payload.studentName && payload.studentId) {
          await client.query(
            `INSERT INTO students
               (id, student_name, customer_id, grade_or_age, intended_subject,
                owner_sales_id, created_by, updated_by)
             VALUES ($1, $2, $3, $4, $5, $6, $6, $6)`,
            [
              payload.studentId,
              payload.studentName,
              payload.customerId,
              payload.gradeOrAge || null,
              payload.intendedSubject || null,
              payload.ownerSalesId,
            ],
          );
          createdStudentId = payload.studentId;
        }

        // 3. opportunity（销售线索 — 必须 student_id 已存在；如无 student 则跳过）
        //    V34 A02-2：phone 明文 + phone_encrypted 密文双写（同事务保证一致）
        //    wechat 在此方法暂无入参（前端流程未传），保留 null；后续如新增编辑接口时双写
        if (createdStudentId) {
          const phonePlain = payload.primaryMobile;
          const phoneEncrypted = this.encryptPhone(phonePlain);
          await client.query(
            `INSERT INTO opportunities
               (id, student_id, course_product_id, stage, owner_user_id, campus_id,
                source, phone, phone_encrypted, last_contact_at, note,
                created_by, updated_by)
             VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, NOW(), $9, $4, $4)`,
            [
              payload.opportunityId,
              createdStudentId,
              payload.stage || '初步接触',
              payload.ownerSalesId,
              payload.campusId,
              payload.source || '销售自建',
              phonePlain,
              phoneEncrypted,
              payload.note || null,
            ],
          );
        }

        return {
          customerId: payload.customerId,
          opportunityId: createdStudentId ? payload.opportunityId : '',
          studentId: createdStudentId,
        };
      },
      { tenantSchema },
    );
  }

  /**
   * V34 A02-2：mapCustomerRow 改为 instance 方法以便注入 FieldEncryptor 用于解密
   * phone / wechat：优先解密 *_encrypted；NULL/失败 → fallback 明文
   */
  mapCustomerRow(r: PgRow): Customer {
    return {
      id: r.id,
      studentId: r.student_id,
      // JOIN 字段（仅 listMine/listPool/findById 包含）
      studentName: r.student_name || null,
      gradeOrAge: r.grade_or_age || null,
      intendedSubject: r.intended_subject || null,
      ownerUserId: r.owner_user_id,
      stage: r.stage as CustomerStage,
      source: r.source,
      phone: this.decryptPhone(r.id, r.phone_encrypted, r.phone),
      wechat: this.decryptWechat(r.id, r.wechat_encrypted, r.wechat),
      intentLevel: r.intent_level as Customer['intentLevel'],
      urgent: !!r.urgent,
      note: r.note,
      enteredPoolAt: r.entered_pool_at ? new Date(r.entered_pool_at).toISOString() : null,
      enterPoolReason: r.enter_pool_reason,
      lastContactAt: r.last_contact_at ? new Date(r.last_contact_at).toISOString() : null,
      signedAt: r.signed_at ? new Date(r.signed_at).toISOString() : null,
      lostReason: r.lost_reason,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
    };
  }

  static mapFollowRow(r: PgRow): FollowEntry {
    return {
      id: r.id,
      opportunityId: r.opportunity_id,
      followType: r.follow_type as FollowType,
      label: r.label,
      byUserId: r.by_user_id,
      byLabel: r.by_label,
      occurredAt: new Date(r.occurred_at).toISOString(),
      extra: r.extra_json || null,
    };
  }

  // ===== 列表查询 =====

  async listMine(
    tenantSchema: string,
    ownerUserId: string,
    options: { stage?: CustomerStage; limit?: number; offset?: number } = {},
  ): Promise<Customer[]> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    if (options.stage) {
      const rows = await this.pg.tenantQuery<PgRow>(
        tenantSchema,
        `SELECT o.*, s.student_name, s.grade_or_age, s.intended_subject
           FROM opportunities o
           LEFT JOIN students s ON s.id = o.student_id
          WHERE o.owner_user_id = $1 AND o.stage = $2
          ORDER BY o.urgent DESC, COALESCE(o.last_contact_at, o.created_at) DESC
          LIMIT $3 OFFSET $4`,
        [ownerUserId, options.stage, limit, offset],
      );
      return rows.map((r) => this.mapCustomerRow(r));
    }
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT o.*, s.student_name, s.grade_or_age, s.intended_subject
         FROM opportunities o
         LEFT JOIN students s ON s.id = o.student_id
        WHERE o.owner_user_id = $1
          AND o.stage NOT IN ('已报名','已失单')
        ORDER BY o.urgent DESC, COALESCE(o.last_contact_at, o.created_at) DESC
        LIMIT $2 OFFSET $3`,
      [ownerUserId, limit, offset],
    );
    return rows.map((r) => this.mapCustomerRow(r));
  }

  /**
   * 老板视角（admin / sales_manager）：跨校查看全部客户 — 5/15 A-2 删 sales_director
   *
   * @param ownerFilter undefined = 所有；'unassigned' = 公共池；具体 sub = 某销售
   * @param campusId V26 校区切换过滤；undefined = 全部校区
   */
  async listAllForBoss(
    tenantSchema: string,
    options: {
      ownerFilter?: string;
      stage?: CustomerStage;
      campusId?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<Customer[]> {
    const limit = options.limit ?? 200;
    const offset = options.offset ?? 0;
    const where: string[] = [`o.stage NOT IN ('已报名','已失单')`];
    const params: any[] = [];
    if (options.stage) {
      params.push(options.stage);
      where.push(`o.stage = $${params.length}`);
    }
    if (options.ownerFilter === 'unassigned') {
      where.push(`o.owner_user_id IS NULL`);
    } else if (options.ownerFilter) {
      params.push(options.ownerFilter);
      where.push(`o.owner_user_id = $${params.length}`);
    }
    if (options.campusId) {
      params.push(options.campusId);
      where.push(`o.campus_id = $${params.length}`);
    }
    params.push(limit, offset);
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT o.*, s.student_name, s.grade_or_age, s.intended_subject
         FROM opportunities o
         LEFT JOIN students s ON s.id = o.student_id
        WHERE ${where.join(' AND ')}
        ORDER BY o.urgent DESC, COALESCE(o.last_contact_at, o.created_at) DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return rows.map((r) => this.mapCustomerRow(r));
  }

  async listPool(
    tenantSchema: string,
    options: { source?: string; limit?: number; offset?: number } = {},
  ): Promise<Customer[]> {
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    if (options.source) {
      const rows = await this.pg.tenantQuery<PgRow>(
        tenantSchema,
        `SELECT o.*, s.student_name, s.grade_or_age, s.intended_subject
           FROM opportunities o
           LEFT JOIN students s ON s.id = o.student_id
          WHERE o.owner_user_id IS NULL
            AND o.stage NOT IN ('已报名','已失单')
            AND o.source = $1
          ORDER BY o.urgent DESC, o.entered_pool_at ASC
          LIMIT $2 OFFSET $3`,
        [options.source, limit, offset],
      );
      return rows.map((r) => this.mapCustomerRow(r));
    }
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT o.*, s.student_name, s.grade_or_age, s.intended_subject
         FROM opportunities o
         LEFT JOIN students s ON s.id = o.student_id
        WHERE o.owner_user_id IS NULL
          AND o.stage NOT IN ('已报名','已失单')
        ORDER BY o.urgent DESC, o.entered_pool_at ASC
        LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return rows.map((r) => this.mapCustomerRow(r));
  }

  async findById(tenantSchema: string, id: string): Promise<Customer | null> {
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT o.*, s.student_name, s.grade_or_age, s.intended_subject
         FROM opportunities o
         LEFT JOIN students s ON s.id = o.student_id
        WHERE o.id = $1`,
      [id],
    );
    return rows.length === 0 ? null : this.mapCustomerRow(rows[0]);
  }

  // ===== 公共池操作 =====

  async claim(
    tenantSchema: string,
    customerId: string,
    userId: string,
    userLabel: string,
  ): Promise<Customer> {
    return this.pg.transaction(
      async (client) => {
        // 在跟客户上限校验
        const cntRows = await client.query(
          `SELECT COUNT(*) AS cnt FROM opportunities
             WHERE owner_user_id = $1 AND stage NOT IN ('已报名','已失单')`,
          [userId],
        );
        const myCount = parseInt(cntRows.rows[0]?.cnt || '0', 10);
        if (myCount >= POOL_LIMIT_PER_SALES) {
          throw new ConflictException(
            `POOL_LIMIT_REACHED: ${myCount}/${POOL_LIMIT_PER_SALES}`,
          );
        }

        // FCFS 抢占（必须 owner_user_id IS NULL）
        const upd = await client.query(
          `UPDATE opportunities
              SET owner_user_id = $1,
                  entered_pool_at = NULL,
                  enter_pool_reason = NULL,
                  last_contact_at = NOW(),
                  updated_at = NOW(),
                  updated_by = $1
            WHERE id = $2 AND owner_user_id IS NULL
          RETURNING *`,
          [userId, customerId],
        );
        if (upd.rows.length === 0) {
          // 区分原因
          const check = await client.query(
            `SELECT owner_user_id FROM opportunities WHERE id = $1`,
            [customerId],
          );
          if (check.rows.length === 0) {
            throw new NotFoundException(`customer ${customerId} not found`);
          }
          throw new ConflictException('CUSTOMER_ALREADY_OWNED');
        }

        await client.query(
          `INSERT INTO customer_follow_log
             (id, opportunity_id, follow_type, label, by_user_id, by_label)
           VALUES ($1, $2, 'claimed', $3, $4, $5)`,
          [
            this.genId(),
            customerId,
            `${userLabel} 从公共池捞客户`,
            userId,
            userLabel,
          ],
        );

        return this.mapCustomerRow(upd.rows[0]);
      },
      { tenantSchema },
    );
  }

  async release(
    tenantSchema: string,
    customerId: string,
    userId: string,
    userLabel: string,
    reason?: string,
  ): Promise<Customer> {
    return this.pg.transaction(
      async (client) => {
        const upd = await client.query(
          `UPDATE opportunities
              SET owner_user_id = NULL,
                  entered_pool_at = NOW(),
                  enter_pool_reason = $3,
                  updated_at = NOW(),
                  updated_by = $2
            WHERE id = $1 AND owner_user_id = $2
          RETURNING *`,
          [customerId, userId, reason || POOL_RESET_REASON.released],
        );
        if (upd.rows.length === 0) {
          throw new NotFoundException(`customer ${customerId} not owned by you`);
        }
        await client.query(
          `INSERT INTO customer_follow_log
             (id, opportunity_id, follow_type, label, by_user_id, by_label, extra_json)
           VALUES ($1, $2, 'released', $3, $4, $5, $6::jsonb)`,
          [
            this.genId(),
            customerId,
            `${userLabel} 退回公共池${reason ? ' · ' + reason : ''}`,
            userId,
            userLabel,
            JSON.stringify({ reason: reason || 'no_reason' }),
          ],
        );
        return this.mapCustomerRow(upd.rows[0]);
      },
      { tenantSchema },
    );
  }

  async markLost(
    tenantSchema: string,
    customerId: string,
    userId: string,
    userLabel: string,
    lostReason: string,
  ): Promise<Customer> {
    const validReasons = ['价格高', '时间不合适', '竞品成交', '无需求', '家长放弃'];
    if (!validReasons.includes(lostReason)) {
      throw new BadRequestException(
        `lost_reason must be one of: ${validReasons.join(',')}`,
      );
    }
    return this.pg.transaction(
      async (client) => {
        const upd = await client.query(
          `UPDATE opportunities
              SET stage = '已失单',
                  lost_reason = $3,
                  updated_at = NOW(),
                  updated_by = $2,
                  last_contact_at = NOW()
            WHERE id = $1 AND owner_user_id = $2
          RETURNING *`,
          [customerId, userId, lostReason],
        );
        if (upd.rows.length === 0) {
          throw new NotFoundException(`customer ${customerId} not owned by you`);
        }
        await client.query(
          `INSERT INTO customer_follow_log
             (id, opportunity_id, follow_type, label, by_user_id, by_label, extra_json)
           VALUES ($1, $2, 'lost', $3, $4, $5, $6::jsonb)`,
          [
            this.genId(),
            customerId,
            `标记失单：${lostReason}`,
            userId,
            userLabel,
            JSON.stringify({ lostReason }),
          ],
        );
        return this.mapCustomerRow(upd.rows[0]);
      },
      { tenantSchema },
    );
  }

  // ===== 跟进时间轴 =====

  async listFollowLog(
    tenantSchema: string,
    customerId: string,
    limit = 100,
  ): Promise<FollowEntry[]> {
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT * FROM customer_follow_log
         WHERE opportunity_id = $1
         ORDER BY occurred_at DESC LIMIT $2`,
      [customerId, limit],
    );
    return rows.map((r) => CustomerRepository.mapFollowRow(r));
  }

  async addFollow(
    tenantSchema: string,
    customerId: string,
    args: {
      followType: FollowType;
      label: string;
      byUserId: string;
      byLabel: string;
      extra?: Record<string, unknown>;
    },
  ): Promise<FollowEntry> {
    return this.pg.transaction(
      async (client) => {
        // 校验客户存在
        const cust = await client.query(
          `SELECT id FROM opportunities WHERE id = $1`,
          [customerId],
        );
        if (cust.rows.length === 0) {
          throw new NotFoundException(`customer ${customerId} not found`);
        }
        const ins = await client.query(
          `INSERT INTO customer_follow_log
             (id, opportunity_id, follow_type, label, by_user_id, by_label, extra_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
          RETURNING *`,
          [
            this.genId(),
            customerId,
            args.followType,
            args.label,
            args.byUserId,
            args.byLabel,
            args.extra ? JSON.stringify(args.extra) : null,
          ],
        );
        // 更新 last_contact_at
        await client.query(
          `UPDATE opportunities
              SET last_contact_at = NOW(),
                  updated_at = NOW(),
                  updated_by = $2
            WHERE id = $1`,
          [customerId, args.byUserId],
        );
        return CustomerRepository.mapFollowRow(ins.rows[0]);
      },
      { tenantSchema },
    );
  }

  /**
   * cron 巡检：在跟客户 30 天无 last_contact_at → 自动入池
   */
  async expireColdToPool(tenantSchema: string): Promise<number> {
    const rows = await this.pg.tenantQuery<{ id: string }>(
      tenantSchema,
      `UPDATE opportunities
          SET owner_user_id = NULL,
              entered_pool_at = NOW(),
              enter_pool_reason = $1,
              updated_at = NOW()
        WHERE owner_user_id IS NOT NULL
          AND stage NOT IN ('已报名','已失单')
          AND COALESCE(last_contact_at, created_at) < NOW() - INTERVAL '30 days'
      RETURNING id`,
      [POOL_RESET_REASON.cold],
    );
    return rows.length;
  }

  // ===== Helper =====
  private genId(): string {
    // 32-char ULID-style（与项目其他地方一致）
    const chars = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    let s = '';
    for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  // =====================================================================
  // V34 字段加密 helper（A02-2）
  // =====================================================================

  /**
   * 加密 phone 明文 → BYTEA Buffer。null/undefined → null
   * encryptor.encrypt 内部对 null/undefined 直接返回 null，安全
   */
  private encryptPhone(plaintext: string | null | undefined): Buffer | null {
    return this.encryptor.encrypt(plaintext);
  }

  /**
   * 加密 wechat 明文 → BYTEA Buffer。null/undefined → null
   * 当前 createWithOpportunity 不接收 wechat 入参（保留接口对称性 + 未来扩展）
   */
  private encryptWechat(plaintext: string | null | undefined): Buffer | null {
    return this.encryptor.encrypt(plaintext);
  }

  /**
   * 解密 phone_encrypted → 明文。fallback 路径（V34 fail-open）：
   *   - encrypted = null/undefined/非 Buffer/空 → 返回明文 fallback（phone 列）
   *   - encrypted 解密抛错（key 不匹配 / 数据损坏）→ logger.warn + 返回明文 fallback
   *   - 都没有 → null（Customer.phone 类型是 string | null）
   *
   * 注：PG node-pg 驱动会把 BYTEA 自动转为 Buffer；测试 mock 可能传 null/undefined。
   */
  private decryptPhone(
    rowId: string,
    encrypted: Buffer | null | undefined,
    fallbackPlain: string | null | undefined,
  ): string | null {
    if (encrypted && Buffer.isBuffer(encrypted) && encrypted.length > 0) {
      try {
        const decoded = this.encryptor.decrypt(encrypted);
        if (decoded !== null && decoded !== undefined) {
          return decoded;
        }
      } catch (err) {
        // V34 fail-open：解密失败不阻塞业务，logger.warn + 走明文 fallback
        this.logger.warn(
          `[V34-decrypt-fallback] opportunity ${rowId} phone_encrypted decrypt failed: ${(err as Error).message}; using plaintext fallback`,
        );
      }
    }
    return fallbackPlain ?? null;
  }

  /**
   * 解密 wechat_encrypted → 明文。同 decryptPhone 的 fallback 策略。
   */
  private decryptWechat(
    rowId: string,
    encrypted: Buffer | null | undefined,
    fallbackPlain: string | null | undefined,
  ): string | null {
    if (encrypted && Buffer.isBuffer(encrypted) && encrypted.length > 0) {
      try {
        const decoded = this.encryptor.decrypt(encrypted);
        if (decoded !== null && decoded !== undefined) {
          return decoded;
        }
      } catch (err) {
        this.logger.warn(
          `[V34-decrypt-fallback] opportunity ${rowId} wechat_encrypted decrypt failed: ${(err as Error).message}; using plaintext fallback`,
        );
      }
    }
    return fallbackPlain ?? null;
  }

  // =====================================================================
  // V41 customers.primary_mobile 三写 helper（A02-4，2026-05-13）
  // =====================================================================

  /**
   * V41 计算 primary_mobile HMAC-SHA256 hash → BYTEA Buffer
   * null/undefined → null（防 INSERT 入参为空时崩溃）
   */
  private hashMobile(plaintext: string | null | undefined): Buffer | null {
    return this.hasher.hash(plaintext);
  }

  /**
   * V41 加密 primary_mobile 明文 → BYTEA Buffer（AES-256-GCM）
   * encryptor.encrypt 内部对 null/undefined 返回 null
   */
  private encryptMobile(plaintext: string | null | undefined): Buffer | null {
    return this.encryptor.encrypt(plaintext);
  }

  /**
   * V41 解密 primary_mobile_encrypted → 明文。同 decryptPhone fallback 策略。
   *
   * **当前调用方：0**（mapCustomerRow 不返 primary_mobile，Customer interface 不含此字段）
   * **预防性 helper**（Sprint E backlog #24 闭环 2026-05-13）：
   *   - 未来如新 GET endpoint 需返回客户主联系手机号（如 /db/customers/:id/with-primary-contact），
   *     必须先在 Customer interface 加 `primary_mobile?: string` + mapCustomerRow 加
   *     `primary_mobile: this.decryptPrimaryMobile(...)` 字段填充。
   *   - 直接用 r.primary_mobile 明文绕过解密 = 历史明文 backfill 后 V41+ 数据可能 NULL，字段不全。
   *   - 必须用 decryptPrimaryMobile 才能正确处理 V41 backfill 后的双轨数据（hash 列查询 + encrypted 列存储）。
   *
   * 字段权限红线（fields-by-role.md 5 对象矩阵）：
   *   - admin/boss/sales(owner=me)/academic(已成交) 可见 → mask 由 maskCustomer 处理
   *   - teacher / finance 不可见 → maskCustomer 已 mask 成 null
   *   helper 仅做技术解密，权限由 maskCustomer 守门（双层防御）。
   */
  private decryptPrimaryMobile(
    rowId: string,
    encrypted: Buffer | null | undefined,
    fallbackPlain: string | null | undefined,
  ): string | null {
    if (encrypted && Buffer.isBuffer(encrypted) && encrypted.length > 0) {
      try {
        const decoded = this.encryptor.decrypt(encrypted);
        if (decoded !== null && decoded !== undefined) {
          return decoded;
        }
      } catch (err) {
        // V41 fail-open：解密失败不阻塞业务，logger.warn + 走明文 fallback
        this.logger.warn(
          `[V41-decrypt-fallback] customer ${rowId} primary_mobile_encrypted decrypt failed: ${(err as Error).message}; using plaintext fallback`,
        );
      }
    }
    return fallbackPlain ?? null;
  }
}
