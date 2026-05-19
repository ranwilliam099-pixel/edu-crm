import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
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
