import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ulid } from 'ulid';
import { PgPoolService, PgRow } from '../db/pg-pool.service';
import { FieldEncryptor } from '../../common/crypto/field-encryptor';
import { HmacHasher } from '../../common/crypto/hmac-hasher';
import { Invoice, InvoiceStatus, PendingContractView } from './invoice.dto';

/**
 * InvoiceRepository — Wave 4A B 端 finance 域开票持久化层
 *
 * 来源：用户 2026-05-14 Wave 4 P0-2 拍板
 *
 * 表：invoices（V42 migration） + contracts（V42 ADD invoice_issued 列）
 *
 * 关键设计：
 *   1. 与 checkout/invoice.service 完全独立（B 端 finance 手动开票 vs C 端自助）
 *   2. PII 三写模式（A02-3/A02-4 同型）：
 *      - invoice_title：明文 + invoice_title_encrypted（不 hash，无等值查询需求）
 *      - tax_id：明文 + tax_id_encrypted（同上）
 *      - receive_phone：明文 + receive_phone_hash + receive_phone_encrypted（三写）
 *   3. 事务原子性：INSERT invoices + UPDATE contracts.invoice_issued 同事务
 *   4. UNIQUE partial index：1 contract = 1 active invoice（pending/issued 唯一，cancelled 允许多）
 *      防重复开票走 409 (DB 层 + app 层双重防御)
 *
 * 查询 fallback：
 *   - 解密失败 logger.warn + fallback 明文（与 V34 customer.repository 同型）
 *   - 兼容期旧数据 *_encrypted/*_hash=NULL 走明文 fallback
 */

@Injectable()
export class InvoiceRepository {
  private readonly logger = new Logger(InvoiceRepository.name);

  constructor(
    private readonly pg: PgPoolService,
    private readonly encryptor: FieldEncryptor,
    private readonly hasher: HmacHasher,
  ) {}

  /**
   * Map PG row → Invoice（解密 PII）
   */
  mapRow(r: PgRow): Invoice {
    return {
      id: r.id,
      contractId: r.contract_id,
      studentId: r.student_id ?? null,
      customerId: r.customer_id ?? null,
      titleType: r.title_type,
      invoiceTitle: this.decryptField(
        r.id,
        'invoice_title',
        r.invoice_title_encrypted,
        r.invoice_title,
      ) ?? '',
      taxId: this.decryptField(
        r.id,
        'tax_id',
        r.tax_id_encrypted,
        r.tax_id,
      ),
      receiveEmail: r.receive_email ?? null,
      receivePhone: this.decryptField(
        r.id,
        'receive_phone',
        r.receive_phone_encrypted,
        r.receive_phone,
      ),
      amount: Number(r.amount),
      remark: r.remark ?? null,
      status: r.status as InvoiceStatus,
      createdByUserId: r.created_by_user_id,
      issuedAt: r.issued_at ? new Date(r.issued_at).toISOString() : null,
      cancelledAt: r.cancelled_at ? new Date(r.cancelled_at).toISOString() : null,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
      // P1 业务流 S2 (V54) — mark-paid 字段（旧 invoice 数据 NULL fallback）
      paidAt: r.paid_at ? new Date(r.paid_at).toISOString() : null,
      paymentMethod: r.payment_method ?? null,
    };
  }

  /**
   * 创建 invoice + 翻转 contracts.invoice_issued = true（事务原子性）
   *
   * 流程：
   *   1. 校验 contract 存在 + 未删除
   *   2. 校验 contract.invoice_issued = false（409 防重复）
   *   3. INSERT invoices（明文 + encrypted + hash 三写）
   *   4. UPDATE contracts.invoice_issued = true
   *
   * 异常路径：
   *   - contract 不存在 → NotFoundException
   *   - contract.invoice_issued = true → ConflictException（含 existedInvoiceId 提示）
   *   - DB UNIQUE 冲突（并发场景）→ ConflictException（兜底）
   */
  async createInvoiceAndMarkContract(
    tenantSchema: string,
    payload: {
      invoiceId: string;
      contractId: string;
      titleType: '个人' | '企业';
      invoiceTitle: string;
      taxId?: string;
      receiveEmail: string;
      receivePhone?: string;
      remark?: string;
      createdByUserId: string;
    },
  ): Promise<Invoice> {
    if (!payload.invoiceId || payload.invoiceId.length !== 32) {
      throw new BadRequestException('invoiceId must be 32-char ULID');
    }
    if (!payload.contractId || payload.contractId.length !== 32) {
      throw new BadRequestException('contractId must be 32-char ULID');
    }
    if (!payload.titleType || (payload.titleType !== '个人' && payload.titleType !== '企业')) {
      throw new BadRequestException('titleType must be 个人 or 企业');
    }
    if (!payload.invoiceTitle || payload.invoiceTitle.trim().length === 0) {
      throw new BadRequestException('invoiceTitle required');
    }
    if (payload.invoiceTitle.length > 80) {
      throw new BadRequestException('invoiceTitle exceeds 80 chars');
    }
    if (payload.titleType === '企业' && (!payload.taxId || payload.taxId.length < 5)) {
      throw new BadRequestException('taxId required for 企业 (min 5 chars)');
    }
    if (payload.taxId && payload.taxId.length > 32) {
      throw new BadRequestException('taxId exceeds 32 chars');
    }
    if (!payload.receiveEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.receiveEmail)) {
      throw new BadRequestException('receiveEmail must be valid email');
    }
    if (payload.receivePhone && !/^1[3-9]\d{9}$/.test(payload.receivePhone)) {
      throw new BadRequestException('receivePhone must be 11-digit Chinese mobile');
    }
    if (payload.remark && payload.remark.length > 200) {
      throw new BadRequestException('remark exceeds 200 chars');
    }
    if (!payload.createdByUserId || payload.createdByUserId.length !== 32) {
      throw new BadRequestException('createdByUserId must be 32-char ULID');
    }

    // PII 加密（事务外算好，事务内只 INSERT 减少持锁）
    const titleEncrypted = this.encryptor.encrypt(payload.invoiceTitle);
    const taxIdEncrypted = this.encryptor.encrypt(payload.taxId ?? null);
    const phoneHash = this.hasher.hash(payload.receivePhone ?? null);
    const phoneEncrypted = this.encryptor.encrypt(payload.receivePhone ?? null);

    return this.pg.transaction(
      async (client) => {
        // 1. 校验 contract 存在 + 未删除 + 未开票 + 取 snapshot 字段
        //    JOIN students 拿 customer_id（OOUX 派生 snapshot）
        const contractCheck = await client.query<{
          id: string;
          student_id: string;
          customer_id: string | null;
          total_amount: string;
          invoice_issued: boolean;
          deleted_at: string | null;
        }>(
          `SELECT c.id, c.student_id, c.total_amount, c.invoice_issued, c.deleted_at,
                  s.customer_id
             FROM contracts c
             LEFT JOIN students s ON s.id = c.student_id
            WHERE c.id = $1`,
          [payload.contractId],
        );

        if (contractCheck.rows.length === 0) {
          throw new NotFoundException(
            `INVOICE_CONTRACT_NOT_FOUND: contractId=${payload.contractId}`,
          );
        }
        const ctRow = contractCheck.rows[0];
        if (ctRow.deleted_at) {
          throw new NotFoundException(
            `INVOICE_CONTRACT_NOT_FOUND: contractId=${payload.contractId} (deleted)`,
          );
        }
        if (ctRow.invoice_issued) {
          // 409 防重复开票（partial UNIQUE 兜底，但 app 层先给 user-friendly 错）
          // 查现存 invoice id 给前端展示
          const existedQ = await client.query<{ id: string; issued_at: string | null }>(
            `SELECT id, issued_at FROM invoices
              WHERE contract_id = $1 AND status IN ('pending','issued')
              LIMIT 1`,
            [payload.contractId],
          );
          const existed = existedQ.rows[0];
          throw new ConflictException({
            error: 'INVOICE_ALREADY_ISSUED',
            contractId: payload.contractId,
            existedInvoiceId: existed?.id ?? null,
            issuedAt: existed?.issued_at ?? null,
          });
        }

        // 2. INSERT invoices（三写 PII；amount snapshot from contract）
        const ins = await client.query<PgRow>(
          `INSERT INTO invoices (
             id, contract_id, student_id, customer_id,
             title_type, invoice_title, invoice_title_encrypted,
             tax_id, tax_id_encrypted,
             receive_email,
             receive_phone, receive_phone_hash, receive_phone_encrypted,
             amount, remark, status, created_by_user_id
           ) VALUES (
             $1, $2, $3, $4,
             $5, $6, $7,
             $8, $9,
             $10,
             $11, $12, $13,
             $14, $15, 'pending', $16
           )
           RETURNING *`,
          [
            payload.invoiceId,
            payload.contractId,
            ctRow.student_id,
            ctRow.customer_id,
            payload.titleType,
            payload.invoiceTitle,
            titleEncrypted,
            payload.taxId ?? null,
            taxIdEncrypted,
            payload.receiveEmail,
            payload.receivePhone ?? null,
            phoneHash,
            phoneEncrypted,
            Number(ctRow.total_amount),
            payload.remark ?? null,
            payload.createdByUserId,
          ],
        );

        // 3. UPDATE contracts.invoice_issued = true（同事务，确保原子性）
        await client.query(
          `UPDATE contracts
              SET invoice_issued = TRUE,
                  updated_at = NOW(),
                  updated_by = $2
            WHERE id = $1`,
          [payload.contractId, payload.createdByUserId],
        );

        return this.mapRow(ins.rows[0]);
      },
      { tenantSchema },
    );
  }

  /**
   * P1 业务流闭环 S2 (2026-05-20) — mark-paid 全链路（5 步事务原子性）
   *
   * 流程：
   *   1. SELECT FOR UPDATE invoice + 验证 status='pending'（否则 409）
   *   2. SELECT FOR UPDATE contract + 取 snapshot 字段（验证 status 非 cancelled/expired，否则 409）
   *   3. UPDATE invoice: status='issued', paid_at, payment_method, issued_at=NOW()
   *   4. UPDATE contract: status='active', activated_at=NOW(), updated_by
   *      （手写 SQL 而非调 ContractRepository.setStatus — 因为本方法在事务内必须用 client 不是 pool）
   *   5. INSERT course_package（自动建机构课包 snapshot）
   *   6. INSERT student_course_package（自动建学员账户）
   *
   * @returns { invoice, contract, studentCoursePackage } 全部最新 snapshot
   *
   * 异常路径：
   *   - invoice 不存在 → NotFoundException
   *   - invoice.status != 'pending' → ConflictException（含 currentStatus）
   *   - contract 不存在（合同被软删但 invoice 未删）→ NotFoundException
   *   - contract.status='cancelled'/'expired' → ConflictException（不允许激活已撤销/过期合同）
   *   - contract.lessonHours + giftHours <= 0 → BadRequestException（防 0 课时包）
   */
  async markPaid(
    tenantSchema: string,
    invoiceId: string,
    payload: {
      paidAt: string;                                            // ISO8601
      paymentMethod: string;                                     // 应用层 enum 已校验
      operatorUserId: string;                                    // finance.sub
    },
  ): Promise<{
    invoice: Invoice;
    contract: {
      id: string;
      studentId: string;
      status: 'active';
      activatedAt: string;
      totalAmount: number;
      lessonHours: number;
      giftHours: number;
    };
    studentCoursePackage: {
      id: string;
      studentId: string;
      coursePackageId: string;
      contractId: string;
      totalLessons: number;
      usedLessons: 0;
      refundedLessons: 0;
      remainingLessons: number;
      activatedAt: string;
      expiresAt: string;
      status: 'active';
    };
  }> {
    if (!invoiceId || invoiceId.length !== 32) {
      throw new BadRequestException('invoiceId must be 32-char ULID');
    }
    if (!payload.paidAt) {
      throw new BadRequestException('paidAt required (ISO8601)');
    }
    const parsedPaidAt = new Date(payload.paidAt);
    if (Number.isNaN(parsedPaidAt.getTime())) {
      throw new BadRequestException('paidAt must be valid ISO8601 datetime');
    }
    if (!payload.paymentMethod || payload.paymentMethod.length === 0) {
      throw new BadRequestException('paymentMethod required');
    }
    if (payload.paymentMethod.length > 16) {
      throw new BadRequestException('paymentMethod exceeds 16 chars');
    }
    if (!payload.operatorUserId || payload.operatorUserId.length !== 32) {
      throw new BadRequestException('operatorUserId must be 32-char ULID');
    }

    return this.pg.transaction(
      async (client) => {
        // ----------------------------------------------------------
        // 1. SELECT FOR UPDATE invoice + 验证 status='pending'
        // ----------------------------------------------------------
        const invQ = await client.query<PgRow>(
          `SELECT * FROM invoices WHERE id = $1 FOR UPDATE`,
          [invoiceId],
        );
        if (invQ.rows.length === 0) {
          throw new NotFoundException(
            `INVOICE_MARK_PAID_NOT_FOUND: invoiceId=${invoiceId}`,
          );
        }
        const invRow = invQ.rows[0];
        if (invRow.status !== 'pending') {
          throw new ConflictException({
            error: 'INVOICE_NOT_PENDING',
            invoiceId,
            currentStatus: invRow.status,
          });
        }
        const contractId = invRow.contract_id as string;

        // ----------------------------------------------------------
        // 2. SELECT FOR UPDATE contract + 取 snapshot 字段
        // ----------------------------------------------------------
        const ctQ = await client.query<PgRow>(
          `SELECT id, student_id, course_product_id, course_product_name,
                  lesson_hours, gift_hours, total_amount, standard_price,
                  status, deleted_at
             FROM contracts
            WHERE id = $1
            FOR UPDATE`,
          [contractId],
        );
        if (ctQ.rows.length === 0 || ctQ.rows[0].deleted_at) {
          throw new NotFoundException(
            `INVOICE_MARK_PAID_CONTRACT_NOT_FOUND: contractId=${contractId}`,
          );
        }
        const ctRow = ctQ.rows[0];
        if (ctRow.status === 'cancelled' || ctRow.status === 'expired') {
          throw new ConflictException({
            error: 'CONTRACT_NOT_ACTIVATABLE',
            contractId,
            currentStatus: ctRow.status,
          });
        }
        const lessonHours = Number(ctRow.lesson_hours);
        const giftHours = Number(ctRow.gift_hours);
        const totalLessons = lessonHours + giftHours;
        if (totalLessons <= 0) {
          throw new BadRequestException(
            `INVOICE_MARK_PAID_ZERO_LESSONS: contract has 0 total lessons (lessonHours=${lessonHours} giftHours=${giftHours})`,
          );
        }
        const contractTotalAmount = Number(ctRow.total_amount);
        const contractStandardPrice = Number(ctRow.standard_price);
        const unitPriceYuan = lessonHours > 0
          ? Number((contractStandardPrice / lessonHours).toFixed(2))
          : 0;
        // courseProductId 可能为 null（V29 销售自填合同）
        // 自动建 course_package 时 courseProductId NULL → DB 层 NOT NULL constraint 会失败
        // 兜底：用 'CUSTOM_PRODUCT_FALLBACK_' + 后 8 位 contractId 作为占位（应用层用 fallback id）
        // 注：V12 course_packages.course_product_id 是 NOT NULL — 必须给值
        //     销售自填合同的 courseProductName 在 contract 上已有，此处不强加 FK 约束 cascade
        const rawCourseProductId = ctRow.course_product_id as string | null;
        const fallbackCourseProductId = rawCourseProductId
          ? rawCourseProductId
          : `cprod_custom_${contractId.slice(-22)}`.padEnd(32, '0').slice(0, 32);
        const coursePackageName = (
          (ctRow.course_product_name as string | null) ||
          `合同 ${contractId.slice(-8).toUpperCase()}`
        ) + ' 课时包';
        const validityMonths = 12; // 默认 12 个月有效期（拍板）

        // ----------------------------------------------------------
        // 3. UPDATE invoice: status='issued' + paid_at + payment_method + issued_at
        // ----------------------------------------------------------
        const updInvQ = await client.query<PgRow>(
          `UPDATE invoices
              SET status = 'issued',
                  paid_at = $2,
                  payment_method = $3,
                  issued_at = NOW(),
                  updated_at = NOW()
            WHERE id = $1 AND status = 'pending'
        RETURNING *`,
          [invoiceId, parsedPaidAt, payload.paymentMethod],
        );
        if (updInvQ.rows.length === 0) {
          // 并发场景兜底（理论上 FOR UPDATE 已挡，留兜底防御）
          throw new ConflictException({
            error: 'INVOICE_NOT_PENDING_RACE',
            invoiceId,
          });
        }

        // ----------------------------------------------------------
        // 4. UPDATE contract: status='active' + activated_at=NOW()
        // ----------------------------------------------------------
        const updCtQ = await client.query<PgRow>(
          `UPDATE contracts
              SET status = 'active',
                  activated_at = NOW(),
                  updated_at = NOW(),
                  updated_by = $2
            WHERE id = $1 AND deleted_at IS NULL
        RETURNING id, student_id, status, activated_at, total_amount, lesson_hours, gift_hours`,
          [contractId, payload.operatorUserId],
        );
        if (updCtQ.rows.length === 0) {
          throw new NotFoundException(
            `INVOICE_MARK_PAID_CONTRACT_UPDATE_FAILED: contractId=${contractId}`,
          );
        }
        const updCtRow = updCtQ.rows[0];

        // ----------------------------------------------------------
        // 5. INSERT course_packages（自动建机构课包 snapshot）
        // ----------------------------------------------------------
        const newCoursePackageId = ulid().padEnd(32, '0').slice(0, 32);
        await client.query(
          `INSERT INTO course_packages (
             id, course_product_id, name, total_lessons, unit_price_yuan,
             total_price_yuan, validity_months, status, created_by, updated_by
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$8)`,
          [
            newCoursePackageId,
            fallbackCourseProductId,
            coursePackageName,
            totalLessons,
            unitPriceYuan,
            contractTotalAmount,
            validityMonths,
            payload.operatorUserId,
          ],
        );

        // ----------------------------------------------------------
        // 6. INSERT student_course_packages（自动建学员账户）
        // ----------------------------------------------------------
        const newStudentPackageId = ulid().padEnd(32, '0').slice(0, 32);
        const activatedAt = new Date();
        const expiresAt = new Date(
          activatedAt.getTime() + validityMonths * 30 * 24 * 60 * 60 * 1000,
        );
        const studentId = ctRow.student_id as string;
        const scpQ = await client.query<PgRow>(
          `INSERT INTO student_course_packages (
             id, student_id, course_package_id, contract_id,
             total_lessons, used_lessons, refunded_lessons,
             activated_at, expires_at, status, low_balance_alerted
           ) VALUES ($1,$2,$3,$4,$5,0,0,$6,$7,'active',FALSE)
       RETURNING id, student_id, course_package_id, contract_id,
                 total_lessons, used_lessons, refunded_lessons, remaining_lessons,
                 activated_at, expires_at, status`,
          [
            newStudentPackageId,
            studentId,
            newCoursePackageId,
            contractId,
            totalLessons,
            activatedAt,
            expiresAt,
          ],
        );
        const scpRow = scpQ.rows[0];

        return {
          invoice: this.mapRow(updInvQ.rows[0]),
          contract: {
            id: updCtRow.id as string,
            studentId: updCtRow.student_id as string,
            status: 'active' as const,
            activatedAt: new Date(updCtRow.activated_at).toISOString(),
            totalAmount: Number(updCtRow.total_amount),
            lessonHours: Number(updCtRow.lesson_hours),
            giftHours: Number(updCtRow.gift_hours),
          },
          studentCoursePackage: {
            id: scpRow.id as string,
            studentId: scpRow.student_id as string,
            coursePackageId: scpRow.course_package_id as string,
            contractId: scpRow.contract_id as string,
            totalLessons: Number(scpRow.total_lessons),
            usedLessons: 0 as const,
            refundedLessons: 0 as const,
            remainingLessons: Number(scpRow.remaining_lessons),
            activatedAt: new Date(scpRow.activated_at).toISOString(),
            expiresAt: new Date(scpRow.expires_at).toISOString(),
            status: 'active' as const,
          },
        };
      },
      { tenantSchema },
    );
  }

  /**
   * 查 invoice 详情（解密 PII）
   */
  async findById(tenantSchema: string, id: string): Promise<Invoice | null> {
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT * FROM invoices WHERE id = $1`,
      [id],
    );
    return rows.length === 0 ? null : this.mapRow(rows[0]);
  }

  /**
   * 2026-05-25 #7 闭环：列发票（B 端 finance/list 「已开票」「全部」tab 用）
   *
   * 过滤：
   *   - status?: 'pending' | 'issued' | 'cancelled' (省略 = 全部)
   *   - limit / offset 分页（默认 50 / 0）
   *
   * 排序：created_at DESC（最新优先）
   *
   * ⚠️ invoices 无软删列（V42 建表用 status 状态机 pending/issued/cancelled + cancelled_at，
   *    无 deleted_at；deleted_at 是 contracts 的列）。原实现误抄 contracts 的
   *    `deleted_at IS NULL` 过滤 → SELECT 报「列不存在」→ /db/invoices 全 500（生产事故）。
   *    撤销发票用 status='cancelled' 表达，不软删；故此处不再过滤 deleted_at。
   */
  async listInvoices(
    tenantSchema: string,
    options: { status?: string; limit?: number; offset?: number } = {},
  ): Promise<Invoice[]> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const params: unknown[] = [];
    const where: string[] = [];
    if (options.status) {
      params.push(options.status);
      where.push(`status = $${params.length}`);
    }
    params.push(limit);
    params.push(offset);
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT * FROM invoices
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * 列待开票合同（B 端 finance/new sheet 用）
   *
   * 过滤：
   *   - contracts.status = 'active' OR 'pending'（已签或激活）
   *     注：设计契约用 'signed'，但 V25 ContractStatus 是 'pending'|'active'，'pending' = 已签未激活
   *         此处过滤「已签合同」用 status IN ('pending','active')
   *   - contracts.invoice_issued = FALSE
   *   - contracts.deleted_at IS NULL
   *   - contracts.signed_at IS NOT NULL（签约的才能开票）
   *
   * JOIN students + customers 拿展示字段（学员名 + 家长名 mask 在 service 层做）
   */
  async listPendingContracts(
    tenantSchema: string,
    options: { campusId?: string; limit?: number; offset?: number } = {},
  ): Promise<Array<{
    id: string;
    studentId: string;
    studentName: string | null;
    parentName: string | null;       // 未 mask 原值（service 层 mask 后转 parentNameMasked）
    totalAmount: number;
    signedAt: string | null;
  }>> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const params: unknown[] = [];
    const where: string[] = [
      `c.invoice_issued = FALSE`,
      `c.deleted_at IS NULL`,
      `c.signed_at IS NOT NULL`,
      `c.status IN ('pending','active')`,
    ];
    if (options.campusId) {
      params.push(options.campusId);
      where.push(`c.campus_id = $${params.length}`);
    }
    params.push(limit, offset);
    const rows = await this.pg.tenantQuery<PgRow>(
      tenantSchema,
      `SELECT c.id, c.student_id, c.total_amount, c.signed_at,
              s.student_name,
              cu.parent_name
         FROM contracts c
         LEFT JOIN students s ON s.id = c.student_id
         LEFT JOIN customers cu ON cu.id = s.customer_id
        WHERE ${where.join(' AND ')}
        ORDER BY c.signed_at DESC NULLS LAST, c.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return rows.map((r) => ({
      id: r.id,
      studentId: r.student_id,
      studentName: r.student_name ?? null,
      parentName: r.parent_name ?? null,
      totalAmount: Number(r.total_amount),
      signedAt: r.signed_at ? new Date(r.signed_at).toISOString() : null,
    }));
  }

  /**
   * Helper：解密 PII 字段 with fallback 明文（V34/V41 同型）
   *   - encrypted = null/undefined/非 Buffer/空 → 返回明文 fallback
   *   - encrypted 解密抛错（key 不匹配 / 数据损坏）→ logger.warn + 返回明文 fallback
   *   - 都没有 → null
   */
  private decryptField(
    rowId: string,
    fieldName: string,
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
          `[V42-decrypt-fallback] invoice ${rowId} ${fieldName}_encrypted decrypt failed: ${(err as Error).message}; using plaintext fallback`,
        );
      }
    }
    return fallbackPlain ?? null;
  }
}
