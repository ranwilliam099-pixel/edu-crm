/**
 * InvoiceRepository 单元测试 — Wave 4A.2-T3
 *
 * 覆盖：
 *   - mapRow：解密 invoice_title_encrypted / tax_id_encrypted / receive_phone_encrypted
 *   - decryptField fallback：encrypted=null → 明文；encrypted 解密抛错 → 明文 fallback + logger.warn
 *   - createInvoiceAndMarkContract：
 *     - 入参校验 (32-char ULID / titleType / email / phone)
 *     - 事务原子性（INSERT invoices + UPDATE contracts.invoice_issued 同事务）
 *     - 404 (合同不存在 / 合同已删除)
 *     - 409 (合同已开票)
 *     - PII 三写：encrypt + hash 调用次数 + 参数
 *   - findById：透传 mapRow 结果
 *   - listPendingContracts：WHERE 子句过滤 + LEFT JOIN + 不带 mask（service 层做 mask）
 *
 * 模式：mock PgPoolService.transaction + tenantQuery；mock FieldEncryptor + HmacHasher
 */

import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { InvoiceRepository } from './invoice.repository';
import { PgPoolService } from '../db/pg-pool.service';
import { FieldEncryptor } from '../../common/crypto/field-encryptor';
import { HmacHasher } from '../../common/crypto/hmac-hasher';

const TENANT = 'tenant_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const INVOICE_ID = '01HRX5INVOICE0000000000000000A03';
const CONTRACT_ID = '01HRX5CONTRACT00000000000000A003';
const STUDENT_ID = 'stu0000000000000000000000000000A3';
const CUSTOMER_ID = 'cus0000000000000000000000000000A3';
const USER_FINANCE = 'usrFinance00000000000000000000A3';
const CAMPUS_A = 'campus_A00000000000000000000000A3';

const MOCK_CIPHER_TITLE = Buffer.from([0xaa, 0xbb, 0x01]);
const MOCK_CIPHER_TAXID = Buffer.from([0xaa, 0xbb, 0x02]);
const MOCK_CIPHER_PHONE = Buffer.from([0xaa, 0xbb, 0x03]);
const MOCK_HASH_PHONE = Buffer.alloc(32, 0x55);

const MOCK_TITLE_PLAIN = '某某科技有限公司';
const MOCK_TAXID_PLAIN = '91500000XXXXXXXXXX';
const MOCK_PHONE_PLAIN = '13800001234';

function invoiceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: INVOICE_ID,
    contract_id: CONTRACT_ID,
    student_id: STUDENT_ID,
    customer_id: CUSTOMER_ID,
    title_type: '企业',
    invoice_title: MOCK_TITLE_PLAIN,
    invoice_title_encrypted: MOCK_CIPHER_TITLE,
    tax_id: MOCK_TAXID_PLAIN,
    tax_id_encrypted: MOCK_CIPHER_TAXID,
    receive_email: 'finance@example.com',
    receive_phone: MOCK_PHONE_PLAIN,
    receive_phone_hash: MOCK_HASH_PHONE,
    receive_phone_encrypted: MOCK_CIPHER_PHONE,
    amount: '9999.00',
    remark: null,
    status: 'pending',
    created_by_user_id: USER_FINANCE,
    issued_at: null,
    cancelled_at: null,
    paid_at: null,
    payment_method: null,
    created_at: new Date('2026-05-15T00:00:00.000Z'),
    updated_at: new Date('2026-05-15T00:00:00.000Z'),
    ...overrides,
  };
}

describe('InvoiceRepository (Wave 4A.2-T3)', () => {
  let repo: InvoiceRepository;
  let pg: {
    tenantQuery: jest.Mock;
    query: jest.Mock;
    withClient: jest.Mock;
    transaction: jest.Mock;
  };
  let txClient: { query: jest.Mock };
  let encryptor: { encrypt: jest.Mock; decrypt: jest.Mock };
  let hasher: { hash: jest.Mock };

  beforeEach(async () => {
    txClient = { query: jest.fn() };
    pg = {
      tenantQuery: jest.fn(),
      query: jest.fn(),
      withClient: jest.fn(),
      transaction: jest.fn().mockImplementation(async (fn: any) => fn(txClient)),
    };
    encryptor = {
      encrypt: jest.fn((plain: string | null | undefined) => {
        if (plain === null || plain === undefined) return null;
        // title-like → MOCK_CIPHER_TITLE
        if (typeof plain === 'string' && plain.includes('科技')) return MOCK_CIPHER_TITLE;
        if (typeof plain === 'string' && plain.startsWith('91')) return MOCK_CIPHER_TAXID;
        if (typeof plain === 'string' && /^1\d{10}$/.test(plain)) return MOCK_CIPHER_PHONE;
        return Buffer.from([0xff]);
      }),
      decrypt: jest.fn((cipher: Buffer) => {
        if (cipher === MOCK_CIPHER_TITLE) return MOCK_TITLE_PLAIN;
        if (cipher === MOCK_CIPHER_TAXID) return MOCK_TAXID_PLAIN;
        if (cipher === MOCK_CIPHER_PHONE) return MOCK_PHONE_PLAIN;
        return '__UNEXPECTED__';
      }),
    };
    hasher = {
      hash: jest.fn((plain: string | null | undefined) =>
        plain === null || plain === undefined ? null : MOCK_HASH_PHONE,
      ),
    };
    const m = await Test.createTestingModule({
      providers: [
        InvoiceRepository,
        { provide: PgPoolService, useValue: pg },
        { provide: FieldEncryptor, useValue: encryptor },
        { provide: HmacHasher, useValue: hasher },
      ],
    }).compile();
    repo = m.get(InvoiceRepository);
  });

  // ============================================================
  // mapRow — 解密 PII 三字段
  // ============================================================
  describe('mapRow() — 解密 invoice_title / tax_id / receive_phone', () => {
    it('encrypted 三列都就位 → 各 decrypt 1 次，返明文', () => {
      const inv = repo.mapRow(invoiceRow());
      expect(inv.invoiceTitle).toBe(MOCK_TITLE_PLAIN);
      expect(inv.taxId).toBe(MOCK_TAXID_PLAIN);
      expect(inv.receivePhone).toBe(MOCK_PHONE_PLAIN);
      // 3 次 decrypt
      expect(encryptor.decrypt).toHaveBeenCalledTimes(3);
    });

    it('encrypted=null → 不 decrypt + fallback 明文', () => {
      const inv = repo.mapRow(
        invoiceRow({
          invoice_title_encrypted: null,
          tax_id_encrypted: null,
          receive_phone_encrypted: null,
        }),
      );
      expect(inv.invoiceTitle).toBe(MOCK_TITLE_PLAIN);
      expect(inv.taxId).toBe(MOCK_TAXID_PLAIN);
      expect(inv.receivePhone).toBe(MOCK_PHONE_PLAIN);
      expect(encryptor.decrypt).not.toHaveBeenCalled();
    });

    it('encrypted 解密抛错 → logger.warn + fallback 明文（不抛主流程）', () => {
      encryptor.decrypt.mockImplementationOnce(() => {
        throw new Error('GCM auth tag mismatch');
      });
      const inv = repo.mapRow(invoiceRow());
      // invoice_title decrypt 失败 → fallback 明文
      expect(inv.invoiceTitle).toBe(MOCK_TITLE_PLAIN);
      // tax_id + phone 解密成功（剩 2 次 decrypt 调用）
      expect(inv.taxId).toBe(MOCK_TAXID_PLAIN);
      expect(inv.receivePhone).toBe(MOCK_PHONE_PLAIN);
    });

    it('tax_id 全空 (encrypted=null + 明文=null) → taxId=null', () => {
      const inv = repo.mapRow(
        invoiceRow({
          tax_id: null,
          tax_id_encrypted: null,
        }),
      );
      expect(inv.taxId).toBeNull();
    });

    it('receive_phone 全空 → receivePhone=null', () => {
      const inv = repo.mapRow(
        invoiceRow({
          receive_phone: null,
          receive_phone_encrypted: null,
        }),
      );
      expect(inv.receivePhone).toBeNull();
    });

    it('amount 字符串 → 数值转换', () => {
      const inv = repo.mapRow(invoiceRow({ amount: '12345.67' }));
      expect(inv.amount).toBe(12345.67);
      expect(typeof inv.amount).toBe('number');
    });

    it('status / customerId / studentId 透传', () => {
      const inv = repo.mapRow(invoiceRow({ status: 'issued' }));
      expect(inv.status).toBe('issued');
      expect(inv.customerId).toBe(CUSTOMER_ID);
      expect(inv.studentId).toBe(STUDENT_ID);
    });

    it('issuedAt / cancelledAt 是 Date 字段 → ISOString', () => {
      const issued = new Date('2026-05-16T08:00:00.000Z');
      const cancelled = new Date('2026-05-17T08:00:00.000Z');
      const inv = repo.mapRow(invoiceRow({ issued_at: issued, cancelled_at: cancelled }));
      expect(inv.issuedAt).toBe(issued.toISOString());
      expect(inv.cancelledAt).toBe(cancelled.toISOString());
    });

    it('encrypted 是空 Buffer (length=0) → fallback 明文', () => {
      const inv = repo.mapRow(invoiceRow({ invoice_title_encrypted: Buffer.alloc(0) }));
      expect(inv.invoiceTitle).toBe(MOCK_TITLE_PLAIN);
      // 不应触发 decrypt
      expect(encryptor.decrypt).toHaveBeenCalledTimes(2); // 仅 tax_id + phone
    });
  });

  // ============================================================
  // createInvoiceAndMarkContract — 入参校验
  // ============================================================
  describe('createInvoiceAndMarkContract() — 入参校验', () => {
    const validPayload = () => ({
      invoiceId: INVOICE_ID,
      contractId: CONTRACT_ID,
      titleType: '企业' as const,
      invoiceTitle: MOCK_TITLE_PLAIN,
      taxId: MOCK_TAXID_PLAIN,
      receiveEmail: 'finance@example.com',
      receivePhone: MOCK_PHONE_PLAIN,
      remark: undefined,
      createdByUserId: USER_FINANCE,
    });

    it('invoiceId 长度 != 32 → BadRequest', async () => {
      await expect(
        repo.createInvoiceAndMarkContract(TENANT, { ...validPayload(), invoiceId: 'short' }),
      ).rejects.toThrow(BadRequestException);
      expect(pg.transaction).not.toHaveBeenCalled();
    });

    it('contractId 长度 != 32 → BadRequest', async () => {
      await expect(
        repo.createInvoiceAndMarkContract(TENANT, { ...validPayload(), contractId: 'too_short' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('titleType 非「个人/企业」 → BadRequest', async () => {
      await expect(
        repo.createInvoiceAndMarkContract(TENANT, {
          ...validPayload(),
          titleType: '其他' as unknown as '企业',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('invoiceTitle 空 → BadRequest', async () => {
      await expect(
        repo.createInvoiceAndMarkContract(TENANT, { ...validPayload(), invoiceTitle: '   ' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('invoiceTitle 超 80 字符 → BadRequest', async () => {
      await expect(
        repo.createInvoiceAndMarkContract(TENANT, {
          ...validPayload(),
          invoiceTitle: 'X'.repeat(81),
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('企业 titleType 但 taxId 缺失 → BadRequest', async () => {
      await expect(
        repo.createInvoiceAndMarkContract(TENANT, {
          ...validPayload(),
          titleType: '企业',
          taxId: undefined,
        }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        repo.createInvoiceAndMarkContract(TENANT, {
          ...validPayload(),
          titleType: '企业',
          taxId: '123',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('个人 titleType 无 taxId → OK', async () => {
      // 个人 + 不带 taxId 应通过校验
      txClient.query
        .mockResolvedValueOnce({
          rows: [
            {
              id: CONTRACT_ID,
              student_id: STUDENT_ID,
              customer_id: CUSTOMER_ID,
              total_amount: '9999.00',
              invoice_issued: false,
              deleted_at: null,
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [invoiceRow({ tax_id: null, tax_id_encrypted: null })] })
        .mockResolvedValueOnce({ rowCount: 1 });
      const r = await repo.createInvoiceAndMarkContract(TENANT, {
        ...validPayload(),
        titleType: '个人',
        taxId: undefined,
      });
      expect(r).toBeDefined();
      expect(r.titleType).toBe('企业'); // mock row 是 '企业'，仅证流程通过
    });

    it('receiveEmail 非法 → BadRequest', async () => {
      await expect(
        repo.createInvoiceAndMarkContract(TENANT, {
          ...validPayload(),
          receiveEmail: 'not-an-email',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('receivePhone 非 11 位中国手机号 → BadRequest', async () => {
      await expect(
        repo.createInvoiceAndMarkContract(TENANT, {
          ...validPayload(),
          receivePhone: '123',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('receivePhone 不传 → OK（可选字段）', async () => {
      txClient.query
        .mockResolvedValueOnce({
          rows: [
            {
              id: CONTRACT_ID,
              student_id: STUDENT_ID,
              customer_id: CUSTOMER_ID,
              total_amount: '9999.00',
              invoice_issued: false,
              deleted_at: null,
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [invoiceRow({ receive_phone: null, receive_phone_encrypted: null })] })
        .mockResolvedValueOnce({ rowCount: 1 });
      const r = await repo.createInvoiceAndMarkContract(TENANT, {
        ...validPayload(),
        receivePhone: undefined,
      });
      expect(r).toBeDefined();
    });

    it('remark > 200 → BadRequest', async () => {
      await expect(
        repo.createInvoiceAndMarkContract(TENANT, {
          ...validPayload(),
          remark: 'X'.repeat(201),
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('createdByUserId 长度 != 32 → BadRequest', async () => {
      await expect(
        repo.createInvoiceAndMarkContract(TENANT, { ...validPayload(), createdByUserId: 'short' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ============================================================
  // createInvoiceAndMarkContract — 事务原子性 + 三写
  // ============================================================
  describe('createInvoiceAndMarkContract() — 事务 + 三写 PII', () => {
    function setContractCheckResult(opts: {
      deletedAt?: string | null;
      invoiceIssued?: boolean;
      customer?: string | null;
    } = {}) {
      txClient.query.mockResolvedValueOnce({
        rows: [
          {
            id: CONTRACT_ID,
            student_id: STUDENT_ID,
            customer_id: opts.customer === undefined ? CUSTOMER_ID : opts.customer,
            total_amount: '9999.00',
            invoice_issued: opts.invoiceIssued ?? false,
            deleted_at: opts.deletedAt ?? null,
          },
        ],
      });
    }

    it('happy path → encrypt 3 次 + hash 1 次 + INSERT 1 + UPDATE 1（同事务）', async () => {
      setContractCheckResult();
      txClient.query.mockResolvedValueOnce({ rows: [invoiceRow()] }); // INSERT
      txClient.query.mockResolvedValueOnce({ rowCount: 1 }); // UPDATE contracts

      const validP = {
        invoiceId: INVOICE_ID,
        contractId: CONTRACT_ID,
        titleType: '企业' as const,
        invoiceTitle: MOCK_TITLE_PLAIN,
        taxId: MOCK_TAXID_PLAIN,
        receiveEmail: 'finance@example.com',
        receivePhone: MOCK_PHONE_PLAIN,
        createdByUserId: USER_FINANCE,
      };
      const r = await repo.createInvoiceAndMarkContract(TENANT, validP);

      expect(r.id).toBe(INVOICE_ID);
      // 3 次 encrypt：title + taxId + phone
      expect(encryptor.encrypt).toHaveBeenCalledTimes(3);
      expect(encryptor.encrypt).toHaveBeenCalledWith(MOCK_TITLE_PLAIN);
      expect(encryptor.encrypt).toHaveBeenCalledWith(MOCK_TAXID_PLAIN);
      expect(encryptor.encrypt).toHaveBeenCalledWith(MOCK_PHONE_PLAIN);
      // 1 次 hash：receivePhone
      expect(hasher.hash).toHaveBeenCalledTimes(1);
      expect(hasher.hash).toHaveBeenCalledWith(MOCK_PHONE_PLAIN);

      // pg.transaction 调一次 + 携带 tenantSchema
      expect(pg.transaction).toHaveBeenCalledTimes(1);
      const opts = pg.transaction.mock.calls[0][1];
      expect(opts.tenantSchema).toBe(TENANT);

      // txClient.query 至少 3 次 (SELECT contract + INSERT invoice + UPDATE contracts)
      expect(txClient.query.mock.calls.length).toBeGreaterThanOrEqual(3);

      // INSERT invoices SQL 含三列
      const insertCall = txClient.query.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO invoices'),
      );
      expect(insertCall).toBeDefined();
      expect(insertCall![0]).toMatch(/invoice_title_encrypted/);
      expect(insertCall![0]).toMatch(/tax_id_encrypted/);
      expect(insertCall![0]).toMatch(/receive_phone_hash/);
      expect(insertCall![0]).toMatch(/receive_phone_encrypted/);

      // INSERT params 含 cipher Buffer + hash Buffer
      const insertParams = insertCall![1] as unknown[];
      expect(insertParams).toContain(MOCK_CIPHER_TITLE);
      expect(insertParams).toContain(MOCK_CIPHER_TAXID);
      expect(insertParams).toContain(MOCK_CIPHER_PHONE);
      expect(insertParams).toContain(MOCK_HASH_PHONE);

      // UPDATE contracts.invoice_issued = TRUE
      const updateCall = txClient.query.mock.calls.find(
        (c) =>
          typeof c[0] === 'string' &&
          c[0].includes('UPDATE contracts') &&
          c[0].includes('invoice_issued = TRUE'),
      );
      expect(updateCall).toBeDefined();
    });

    it('合同不存在 → NotFoundException + 不 INSERT', async () => {
      txClient.query.mockResolvedValueOnce({ rows: [] }); // contract check 空
      await expect(
        repo.createInvoiceAndMarkContract(TENANT, {
          invoiceId: INVOICE_ID,
          contractId: CONTRACT_ID,
          titleType: '个人',
          invoiceTitle: '某人',
          receiveEmail: 'a@b.com',
          createdByUserId: USER_FINANCE,
        }),
      ).rejects.toThrow(NotFoundException);
      // 仅 SELECT 一次，无 INSERT
      const insertCalls = txClient.query.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO invoices'),
      );
      expect(insertCalls).toHaveLength(0);
    });

    it('合同已软删 (deleted_at not null) → NotFoundException', async () => {
      setContractCheckResult({ deletedAt: '2026-05-10T00:00:00Z' });
      await expect(
        repo.createInvoiceAndMarkContract(TENANT, {
          invoiceId: INVOICE_ID,
          contractId: CONTRACT_ID,
          titleType: '个人',
          invoiceTitle: '某人',
          receiveEmail: 'a@b.com',
          createdByUserId: USER_FINANCE,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('合同已开票 → ConflictException 含 existedInvoiceId', async () => {
      setContractCheckResult({ invoiceIssued: true });
      // 查现存 invoice
      txClient.query.mockResolvedValueOnce({
        rows: [{ id: 'EXISTED_INVOICE_ID_0000000000A001', issued_at: '2026-05-09T08:00:00Z' }],
      });
      const promise = repo.createInvoiceAndMarkContract(TENANT, {
        invoiceId: INVOICE_ID,
        contractId: CONTRACT_ID,
        titleType: '个人',
        invoiceTitle: '某人',
        receiveEmail: 'a@b.com',
        createdByUserId: USER_FINANCE,
      });
      await expect(promise).rejects.toThrow(ConflictException);

      // 重新触发 + 检查 ConflictException response
      setContractCheckResult({ invoiceIssued: true });
      txClient.query.mockResolvedValueOnce({
        rows: [{ id: 'EXISTED_INVOICE_ID_0000000000A001', issued_at: '2026-05-09T08:00:00Z' }],
      });
      try {
        await repo.createInvoiceAndMarkContract(TENANT, {
          invoiceId: INVOICE_ID,
          contractId: CONTRACT_ID,
          titleType: '个人',
          invoiceTitle: '某人',
          receiveEmail: 'a@b.com',
          createdByUserId: USER_FINANCE,
        });
      } catch (e) {
        expect(e).toBeInstanceOf(ConflictException);
        const response = (e as ConflictException).getResponse() as {
          error?: string;
          contractId?: string;
          existedInvoiceId?: string | null;
        };
        expect(response.error).toBe('INVOICE_ALREADY_ISSUED');
        expect(response.contractId).toBe(CONTRACT_ID);
        expect(response.existedInvoiceId).toBe('EXISTED_INVOICE_ID_0000000000A001');
      }
    });

    it('合同 customer_id 为 null → INSERT customer_id 为 null', async () => {
      setContractCheckResult({ customer: null });
      txClient.query.mockResolvedValueOnce({ rows: [invoiceRow({ customer_id: null })] });
      txClient.query.mockResolvedValueOnce({ rowCount: 1 });
      const r = await repo.createInvoiceAndMarkContract(TENANT, {
        invoiceId: INVOICE_ID,
        contractId: CONTRACT_ID,
        titleType: '企业',
        invoiceTitle: MOCK_TITLE_PLAIN,
        taxId: MOCK_TAXID_PLAIN,
        receiveEmail: 'a@b.com',
        createdByUserId: USER_FINANCE,
      });
      expect(r.customerId).toBeNull();
      // INSERT params 含 customer_id=null
      const insertCall = txClient.query.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO invoices'),
      );
      const insertParams = insertCall![1] as unknown[];
      // 第 4 个参数是 customer_id（$4）
      expect(insertParams[3]).toBeNull();
    });

    it('入参非法 → 提前抛 BadRequest，不进事务、不 encrypt、不 hash', async () => {
      await expect(
        repo.createInvoiceAndMarkContract(TENANT, {
          invoiceId: 'short',
          contractId: CONTRACT_ID,
          titleType: '企业',
          invoiceTitle: MOCK_TITLE_PLAIN,
          taxId: MOCK_TAXID_PLAIN,
          receiveEmail: 'a@b.com',
          createdByUserId: USER_FINANCE,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(encryptor.encrypt).not.toHaveBeenCalled();
      expect(hasher.hash).not.toHaveBeenCalled();
      expect(pg.transaction).not.toHaveBeenCalled();
    });

    it('taxId 不传（个人 titleType）→ encrypt taxId=null + INSERT tax_id=null', async () => {
      setContractCheckResult();
      txClient.query.mockResolvedValueOnce({
        rows: [invoiceRow({ title_type: '个人', tax_id: null, tax_id_encrypted: null })],
      });
      txClient.query.mockResolvedValueOnce({ rowCount: 1 });

      await repo.createInvoiceAndMarkContract(TENANT, {
        invoiceId: INVOICE_ID,
        contractId: CONTRACT_ID,
        titleType: '个人',
        invoiceTitle: '张三',
        receiveEmail: 'a@b.com',
        receivePhone: MOCK_PHONE_PLAIN,
        createdByUserId: USER_FINANCE,
      });
      // encrypt 应被调 3 次：title + taxId(null) + phone
      expect(encryptor.encrypt).toHaveBeenCalledTimes(3);
      expect(encryptor.encrypt).toHaveBeenCalledWith(null);
    });
  });

  // ============================================================
  // findById — tenantQuery + mapRow
  // ============================================================
  describe('findById()', () => {
    it('行存在 → 返 mapRow 结果', async () => {
      pg.tenantQuery.mockResolvedValueOnce([invoiceRow()]);
      const r = await repo.findById(TENANT, INVOICE_ID);
      expect(r).not.toBeNull();
      expect(r!.id).toBe(INVOICE_ID);
      expect(r!.invoiceTitle).toBe(MOCK_TITLE_PLAIN);
      expect(pg.tenantQuery).toHaveBeenCalledWith(
        TENANT,
        expect.stringContaining('FROM invoices'),
        [INVOICE_ID],
      );
    });

    it('行不存在 → null', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      const r = await repo.findById(TENANT, INVOICE_ID);
      expect(r).toBeNull();
    });
  });

  // ============================================================
  // listPendingContracts — WHERE 子句 + LEFT JOIN
  // ============================================================
  describe('listPendingContracts() — WHERE 子句过滤', () => {
    it('返 raw row 含 parentName 原值（mask 在 service）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        {
          id: CONTRACT_ID,
          student_id: STUDENT_ID,
          total_amount: '9999.00',
          signed_at: new Date('2026-05-10T08:00:00Z'),
          student_name: '王同学',
          parent_name: '王二', // 未 mask 原值
        },
      ]);
      const rows = await repo.listPendingContracts(TENANT);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(CONTRACT_ID);
      expect(rows[0].parentName).toBe('王二'); // 仍是原值
      expect(rows[0].totalAmount).toBe(9999);
      expect(rows[0].signedAt).toBe(new Date('2026-05-10T08:00:00Z').toISOString());
    });

    it('SQL WHERE 含 invoice_issued=FALSE / deleted_at IS NULL / signed_at NOT NULL / status IN active/pending', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.listPendingContracts(TENANT);
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toMatch(/invoice_issued = FALSE/);
      expect(sql).toMatch(/deleted_at IS NULL/);
      expect(sql).toMatch(/signed_at IS NOT NULL/);
      expect(sql).toMatch(/status IN \('pending','active'\)/);
      // LEFT JOIN 学员 + 客户
      expect(sql).toMatch(/LEFT JOIN students/);
      expect(sql).toMatch(/LEFT JOIN customers/);
    });

    it('campusId 透传 → WHERE 子句加 c.campus_id', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.listPendingContracts(TENANT, { campusId: CAMPUS_A });
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toMatch(/c\.campus_id/);
      const params = pg.tenantQuery.mock.calls[0][2] as unknown[];
      // params 顺序：[campusId, limit, offset]
      expect(params[0]).toBe(CAMPUS_A);
      expect(params[1]).toBe(50); // 默认 limit
      expect(params[2]).toBe(0); // 默认 offset
    });

    it('无 campusId → params 仅含 [limit, offset]', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.listPendingContracts(TENANT, { limit: 20, offset: 5 });
      const params = pg.tenantQuery.mock.calls[0][2] as unknown[];
      expect(params).toEqual([20, 5]);
    });

    it('默认 limit=50 + offset=0', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.listPendingContracts(TENANT);
      const params = pg.tenantQuery.mock.calls[0][2] as unknown[];
      expect(params).toEqual([50, 0]);
    });

    it('row 字段缺失 (student_name=null / parent_name=null) → 透传 null', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        {
          id: CONTRACT_ID,
          student_id: STUDENT_ID,
          total_amount: '9999.00',
          signed_at: null,
          student_name: null,
          parent_name: null,
        },
      ]);
      const rows = await repo.listPendingContracts(TENANT);
      expect(rows[0].studentName).toBeNull();
      expect(rows[0].parentName).toBeNull();
      expect(rows[0].signedAt).toBeNull();
    });
  });

  // ============================================================
  // markPaid() — P1 业务流闭环 S2 (2026-05-20)
  // 5 步事务：SELECT FOR UPDATE invoice → SELECT FOR UPDATE contract →
  //          UPDATE invoice → UPDATE contract → INSERT course_packages → INSERT student_course_packages
  // ============================================================
  describe('markPaid() — 5 步事务原子性', () => {
    const baseMarkPaidPayload = () => ({
      paidAt: '2026-05-20T10:30:00.000Z',
      paymentMethod: '微信支付',
      operatorUserId: USER_FINANCE,
    });

    function setupHappyPath(opts: {
      courseProductId?: string | null;
      lessonHours?: number;
      giftHours?: number;
      totalAmount?: string;
      standardPrice?: string;
      contractStatus?: 'pending' | 'active' | 'cancelled' | 'expired';
    } = {}) {
      // Mock 6 txClient.query 调用按顺序（注：repository markPaid 实际调用次数为 6：
      //   1) SELECT FOR UPDATE invoice
      //   2) SELECT FOR UPDATE contract
      //   3) UPDATE invoices
      //   4) UPDATE contracts
      //   5) INSERT course_packages
      //   6) INSERT student_course_packages）
      const courseProductId =
        opts.courseProductId === undefined ? 'cprod_existing_123' : opts.courseProductId;
      const lessonHours = opts.lessonHours ?? 30;
      const giftHours = opts.giftHours ?? 3;
      const totalAmount = opts.totalAmount ?? '9999.00';
      const standardPrice = opts.standardPrice ?? '12000.00';
      const contractStatus = opts.contractStatus ?? 'pending';

      // 1) SELECT FOR UPDATE invoice
      txClient.query.mockResolvedValueOnce({
        rows: [invoiceRow({ status: 'pending' })],
      });
      // 2) SELECT FOR UPDATE contract
      txClient.query.mockResolvedValueOnce({
        rows: [
          {
            id: CONTRACT_ID,
            student_id: STUDENT_ID,
            course_product_id: courseProductId,
            course_product_name: '语文课',
            lesson_hours: lessonHours,
            gift_hours: giftHours,
            total_amount: totalAmount,
            standard_price: standardPrice,
            status: contractStatus,
            deleted_at: null,
          },
        ],
      });
      // 3) UPDATE invoices → 返 updated invoice row
      txClient.query.mockResolvedValueOnce({
        rows: [
          invoiceRow({
            status: 'issued',
            paid_at: new Date('2026-05-20T10:30:00.000Z'),
            payment_method: '微信支付',
            issued_at: new Date('2026-05-20T11:00:00.000Z'),
          }),
        ],
      });
      // 4) UPDATE contracts → 返 contract snapshot
      txClient.query.mockResolvedValueOnce({
        rows: [
          {
            id: CONTRACT_ID,
            student_id: STUDENT_ID,
            status: 'active',
            activated_at: new Date('2026-05-20T11:00:00.000Z'),
            total_amount: totalAmount,
            lesson_hours: lessonHours,
            gift_hours: giftHours,
          },
        ],
      });
      // 5) INSERT course_packages
      txClient.query.mockResolvedValueOnce({ rowCount: 1 });
      // 6) INSERT student_course_packages → 返 scp row
      txClient.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'scp00000000000000000000000000A0A3',
            student_id: STUDENT_ID,
            course_package_id: 'cpkg000000000000000000000000A0A3',
            contract_id: CONTRACT_ID,
            total_lessons: lessonHours + giftHours,
            used_lessons: 0,
            refunded_lessons: 0,
            remaining_lessons: lessonHours + giftHours,
            activated_at: new Date('2026-05-20T11:00:00.000Z'),
            expires_at: new Date('2027-05-15T11:00:00.000Z'),
            status: 'active',
          },
        ],
      });
    }

    // ---------- 入参校验（fail-fast 不进事务）----------
    it('invoiceId 长度 != 32 → BadRequest + 不进事务', async () => {
      await expect(
        repo.markPaid(TENANT, 'short_id', baseMarkPaidPayload()),
      ).rejects.toThrow(BadRequestException);
      expect(pg.transaction).not.toHaveBeenCalled();
    });

    it('paidAt 缺失 → BadRequest', async () => {
      await expect(
        repo.markPaid(TENANT, INVOICE_ID, { ...baseMarkPaidPayload(), paidAt: '' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('paidAt 非合法 ISO8601 → BadRequest', async () => {
      await expect(
        repo.markPaid(TENANT, INVOICE_ID, {
          ...baseMarkPaidPayload(),
          paidAt: 'not-a-date',
        }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        repo.markPaid(TENANT, INVOICE_ID, {
          ...baseMarkPaidPayload(),
          paidAt: 'not-a-date',
        }),
      ).rejects.toThrow(/ISO8601/);
    });

    it('paymentMethod 缺失 → BadRequest', async () => {
      await expect(
        repo.markPaid(TENANT, INVOICE_ID, {
          ...baseMarkPaidPayload(),
          paymentMethod: '',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('paymentMethod 超 16 字符 → BadRequest', async () => {
      await expect(
        repo.markPaid(TENANT, INVOICE_ID, {
          ...baseMarkPaidPayload(),
          paymentMethod: 'X'.repeat(17),
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('operatorUserId 长度 != 32 → BadRequest', async () => {
      await expect(
        repo.markPaid(TENANT, INVOICE_ID, {
          ...baseMarkPaidPayload(),
          operatorUserId: 'short',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    // ---------- Happy path: 5 SQL 调用顺序正确 ----------
    it('happy path → 6 SQL 调用按序：SELECT inv → SELECT ct → UPDATE inv → UPDATE ct → INSERT cp → INSERT scp', async () => {
      setupHappyPath();
      const r = await repo.markPaid(TENANT, INVOICE_ID, baseMarkPaidPayload());

      // pg.transaction 调一次 + 携带 tenantSchema
      expect(pg.transaction).toHaveBeenCalledTimes(1);
      const opts = pg.transaction.mock.calls[0][1];
      expect(opts.tenantSchema).toBe(TENANT);

      // 6 次 SQL 调用
      expect(txClient.query.mock.calls.length).toBe(6);

      // 调用 1: SELECT FOR UPDATE invoice
      const c1 = txClient.query.mock.calls[0];
      expect(c1[0]).toMatch(/SELECT \* FROM invoices/);
      expect(c1[0]).toMatch(/FOR UPDATE/);
      expect(c1[1]).toEqual([INVOICE_ID]);

      // 调用 2: SELECT FOR UPDATE contract
      const c2 = txClient.query.mock.calls[1];
      expect(c2[0]).toMatch(/FROM contracts/);
      expect(c2[0]).toMatch(/FOR UPDATE/);
      expect(c2[1]).toEqual([CONTRACT_ID]);

      // 调用 3: UPDATE invoices
      const c3 = txClient.query.mock.calls[2];
      expect(c3[0]).toMatch(/UPDATE invoices/);
      expect(c3[0]).toMatch(/status = 'issued'/);
      expect(c3[0]).toMatch(/paid_at = \$2/);
      expect(c3[0]).toMatch(/payment_method = \$3/);
      // params: [invoiceId, paidAt Date, paymentMethod]
      expect(c3[1][0]).toBe(INVOICE_ID);
      expect(c3[1][1]).toBeInstanceOf(Date);
      expect(c3[1][2]).toBe('微信支付');

      // 调用 4: UPDATE contracts
      const c4 = txClient.query.mock.calls[3];
      expect(c4[0]).toMatch(/UPDATE contracts/);
      expect(c4[0]).toMatch(/status = 'active'/);
      expect(c4[0]).toMatch(/activated_at = NOW\(\)/);
      expect(c4[1]).toEqual([CONTRACT_ID, USER_FINANCE]);

      // 调用 5: INSERT course_packages
      const c5 = txClient.query.mock.calls[4];
      expect(c5[0]).toMatch(/INSERT INTO course_packages/);
      const c5Params = c5[1] as unknown[];
      // course_package.totalLessons = lessonHours + giftHours = 33
      expect(c5Params[3]).toBe(33);
      // unit_price_yuan = standard_price / lesson_hours = 12000 / 30 = 400
      expect(c5Params[4]).toBe(400);
      // total_price_yuan = contract.total_amount = 9999
      expect(c5Params[5]).toBe(9999);
      // validity_months = 12
      expect(c5Params[6]).toBe(12);
      // created_by / updated_by = USER_FINANCE
      expect(c5Params[7]).toBe(USER_FINANCE);

      // 调用 6: INSERT student_course_packages
      const c6 = txClient.query.mock.calls[5];
      expect(c6[0]).toMatch(/INSERT INTO student_course_packages/);
      const c6Params = c6[1] as unknown[];
      // total_lessons = 33
      expect(c6Params[4]).toBe(33);
      // contract_id = CONTRACT_ID
      expect(c6Params[3]).toBe(CONTRACT_ID);
      // student_id = STUDENT_ID
      expect(c6Params[1]).toBe(STUDENT_ID);

      // 返 3 对象
      expect(r.invoice.status).toBe('issued');
      expect(r.invoice.paymentMethod).toBe('微信支付');
      expect(r.contract.status).toBe('active');
      expect(r.contract.id).toBe(CONTRACT_ID);
      expect(r.studentCoursePackage.totalLessons).toBe(33);
      expect(r.studentCoursePackage.contractId).toBe(CONTRACT_ID);
      expect(r.studentCoursePackage.status).toBe('active');
    });

    // ---------- 404 路径 ----------
    it('invoice 不存在 → NotFoundException + 不进入 UPDATE 阶段', async () => {
      txClient.query.mockResolvedValueOnce({ rows: [] }); // SELECT invoice 空
      await expect(
        repo.markPaid(TENANT, INVOICE_ID, baseMarkPaidPayload()),
      ).rejects.toThrow(NotFoundException);
      // 仅 1 次 SELECT，不会触发后续 UPDATE/INSERT
      expect(txClient.query.mock.calls.length).toBe(1);
    });

    it('contract 不存在 → NotFoundException + 不 UPDATE invoice', async () => {
      // 1) SELECT invoice 找到
      txClient.query.mockResolvedValueOnce({
        rows: [invoiceRow({ status: 'pending' })],
      });
      // 2) SELECT contract 空
      txClient.query.mockResolvedValueOnce({ rows: [] });
      await expect(
        repo.markPaid(TENANT, INVOICE_ID, baseMarkPaidPayload()),
      ).rejects.toThrow(NotFoundException);
      // 应只 2 次（未到 UPDATE）
      expect(txClient.query.mock.calls.length).toBe(2);
    });

    it('contract 已软删（deleted_at not null）→ NotFoundException', async () => {
      txClient.query.mockResolvedValueOnce({
        rows: [invoiceRow({ status: 'pending' })],
      });
      txClient.query.mockResolvedValueOnce({
        rows: [
          {
            id: CONTRACT_ID,
            student_id: STUDENT_ID,
            course_product_id: 'cprod_x',
            course_product_name: '语文课',
            lesson_hours: 30,
            gift_hours: 3,
            total_amount: '9999',
            standard_price: '12000',
            status: 'pending',
            deleted_at: new Date('2026-05-10T00:00:00Z'),
          },
        ],
      });
      await expect(
        repo.markPaid(TENANT, INVOICE_ID, baseMarkPaidPayload()),
      ).rejects.toThrow(NotFoundException);
    });

    // ---------- 409 路径 ----------
    it('invoice.status="issued" → ConflictException INVOICE_NOT_PENDING + currentStatus', async () => {
      txClient.query.mockResolvedValueOnce({
        rows: [invoiceRow({ status: 'issued' })],
      });
      try {
        await repo.markPaid(TENANT, INVOICE_ID, baseMarkPaidPayload());
        fail('expected ConflictException');
      } catch (e) {
        expect(e).toBeInstanceOf(ConflictException);
        const response = (e as ConflictException).getResponse() as {
          error?: string;
          invoiceId?: string;
          currentStatus?: string;
        };
        expect(response.error).toBe('INVOICE_NOT_PENDING');
        expect(response.invoiceId).toBe(INVOICE_ID);
        expect(response.currentStatus).toBe('issued');
      }
    });

    it('invoice.status="cancelled" → ConflictException', async () => {
      txClient.query.mockResolvedValueOnce({
        rows: [invoiceRow({ status: 'cancelled' })],
      });
      await expect(
        repo.markPaid(TENANT, INVOICE_ID, baseMarkPaidPayload()),
      ).rejects.toThrow(ConflictException);
    });

    it('contract.status="cancelled" → ConflictException CONTRACT_NOT_ACTIVATABLE', async () => {
      txClient.query.mockResolvedValueOnce({
        rows: [invoiceRow({ status: 'pending' })],
      });
      txClient.query.mockResolvedValueOnce({
        rows: [
          {
            id: CONTRACT_ID,
            student_id: STUDENT_ID,
            course_product_id: 'cprod_x',
            course_product_name: '语文课',
            lesson_hours: 30,
            gift_hours: 3,
            total_amount: '9999',
            standard_price: '12000',
            status: 'cancelled',
            deleted_at: null,
          },
        ],
      });
      try {
        await repo.markPaid(TENANT, INVOICE_ID, baseMarkPaidPayload());
        fail('expected ConflictException');
      } catch (e) {
        expect(e).toBeInstanceOf(ConflictException);
        const response = (e as ConflictException).getResponse() as {
          error?: string;
          contractId?: string;
          currentStatus?: string;
        };
        expect(response.error).toBe('CONTRACT_NOT_ACTIVATABLE');
        expect(response.contractId).toBe(CONTRACT_ID);
        expect(response.currentStatus).toBe('cancelled');
      }
    });

    it('contract.status="expired" → ConflictException CONTRACT_NOT_ACTIVATABLE', async () => {
      txClient.query.mockResolvedValueOnce({
        rows: [invoiceRow({ status: 'pending' })],
      });
      txClient.query.mockResolvedValueOnce({
        rows: [
          {
            id: CONTRACT_ID,
            student_id: STUDENT_ID,
            course_product_id: 'cprod_x',
            course_product_name: '语文课',
            lesson_hours: 30,
            gift_hours: 3,
            total_amount: '9999',
            standard_price: '12000',
            status: 'expired',
            deleted_at: null,
          },
        ],
      });
      await expect(
        repo.markPaid(TENANT, INVOICE_ID, baseMarkPaidPayload()),
      ).rejects.toThrow(ConflictException);
    });

    // ---------- 0 课时合同（防御）----------
    it('contract.lessonHours + giftHours = 0 → BadRequest（防 0 课时包）', async () => {
      txClient.query.mockResolvedValueOnce({
        rows: [invoiceRow({ status: 'pending' })],
      });
      txClient.query.mockResolvedValueOnce({
        rows: [
          {
            id: CONTRACT_ID,
            student_id: STUDENT_ID,
            course_product_id: 'cprod_x',
            course_product_name: '语文课',
            lesson_hours: 0,
            gift_hours: 0,
            total_amount: '9999',
            standard_price: '0',
            status: 'pending',
            deleted_at: null,
          },
        ],
      });
      // 用 try/catch 而非 double-await（mock queue 只 push 2 个 row，second await 时 query 返 undefined）
      try {
        await repo.markPaid(TENANT, INVOICE_ID, baseMarkPaidPayload());
        fail('expected BadRequestException');
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        expect((e as BadRequestException).message).toMatch(/ZERO_LESSONS/);
      }
    });

    // ---------- V29 销售自填合同（courseProductId NULL）----------
    it('contract.courseProductId NULL (V29 销售自填) → INSERT course_packages 用 fallback id', async () => {
      setupHappyPath({ courseProductId: null });
      await repo.markPaid(TENANT, INVOICE_ID, baseMarkPaidPayload());
      // 调用 5 是 INSERT course_packages
      const c5 = txClient.query.mock.calls[4];
      const c5Params = c5[1] as unknown[];
      // params[1] 是 course_product_id（NULL fallback）
      const fallbackId = c5Params[1] as string;
      expect(fallbackId.length).toBe(32);
      expect(fallbackId).toMatch(/^cprod_custom_/);
    });

    it('contract.courseProductId 存在 → INSERT course_packages 直接用 id', async () => {
      setupHappyPath({ courseProductId: 'cprod_existing_xyz' });
      await repo.markPaid(TENANT, INVOICE_ID, baseMarkPaidPayload());
      const c5 = txClient.query.mock.calls[4];
      const c5Params = c5[1] as unknown[];
      expect(c5Params[1]).toBe('cprod_existing_xyz');
    });

    // ---------- 各课时 / 价格组合 ----------
    it('lessonHours=20 + giftHours=5 + standardPrice=10000 → totalLessons=25 + unitPrice=500', async () => {
      setupHappyPath({
        lessonHours: 20,
        giftHours: 5,
        standardPrice: '10000.00',
        totalAmount: '8000.00',
      });
      await repo.markPaid(TENANT, INVOICE_ID, baseMarkPaidPayload());
      const c5 = txClient.query.mock.calls[4];
      const c5Params = c5[1] as unknown[];
      // total_lessons = 25
      expect(c5Params[3]).toBe(25);
      // unit_price_yuan = 10000 / 20 = 500
      expect(c5Params[4]).toBe(500);
      // total_price_yuan = 8000 (contract.total_amount)
      expect(c5Params[5]).toBe(8000);

      // student_course_packages.total_lessons = 25
      const c6Params = txClient.query.mock.calls[5][1] as unknown[];
      expect(c6Params[4]).toBe(25);
    });

    // ---------- paidAt 时间各字符串 ----------
    it('paidAt 字符串 "2026-05-20T10:30:00Z" → 转 Date 写入 UPDATE invoice', async () => {
      setupHappyPath();
      await repo.markPaid(TENANT, INVOICE_ID, {
        ...baseMarkPaidPayload(),
        paidAt: '2026-05-20T10:30:00Z',
      });
      const c3Params = txClient.query.mock.calls[2][1] as unknown[];
      const paidAtParam = c3Params[1] as Date;
      expect(paidAtParam).toBeInstanceOf(Date);
      expect(paidAtParam.toISOString()).toBe('2026-05-20T10:30:00.000Z');
    });

    // ---------- 并发兜底（UPDATE invoices RETURNING 空）----------
    it('SELECT FOR UPDATE 通过但 UPDATE invoices RETURNING 0 行 → ConflictException 并发兜底', async () => {
      // 1) SELECT invoice 状态 pending
      txClient.query.mockResolvedValueOnce({
        rows: [invoiceRow({ status: 'pending' })],
      });
      // 2) SELECT contract OK
      txClient.query.mockResolvedValueOnce({
        rows: [
          {
            id: CONTRACT_ID,
            student_id: STUDENT_ID,
            course_product_id: 'cprod_x',
            course_product_name: '语文课',
            lesson_hours: 30,
            gift_hours: 3,
            total_amount: '9999',
            standard_price: '12000',
            status: 'pending',
            deleted_at: null,
          },
        ],
      });
      // 3) UPDATE invoices RETURNING 空（并发场景）
      txClient.query.mockResolvedValueOnce({ rows: [] });
      try {
        await repo.markPaid(TENANT, INVOICE_ID, baseMarkPaidPayload());
        fail('expected ConflictException');
      } catch (e) {
        expect(e).toBeInstanceOf(ConflictException);
        const response = (e as ConflictException).getResponse() as { error?: string };
        expect(response.error).toBe('INVOICE_NOT_PENDING_RACE');
      }
    });

    // ---------- 返回值字段完整性 ----------
    it('返回 result.invoice 含 paidAt + paymentMethod + status="issued" + issuedAt', async () => {
      setupHappyPath();
      const r = await repo.markPaid(TENANT, INVOICE_ID, baseMarkPaidPayload());
      expect(r.invoice.status).toBe('issued');
      expect(r.invoice.paymentMethod).toBe('微信支付');
      expect(r.invoice.paidAt).toBeDefined();
      expect(r.invoice.paidAt).not.toBeNull();
      expect(r.invoice.issuedAt).toBeDefined();
      expect(r.invoice.issuedAt).not.toBeNull();
    });

    it('返回 result.contract 含 id/studentId/status/activatedAt/totalAmount/lessonHours/giftHours', async () => {
      setupHappyPath();
      const r = await repo.markPaid(TENANT, INVOICE_ID, baseMarkPaidPayload());
      expect(r.contract.id).toBe(CONTRACT_ID);
      expect(r.contract.studentId).toBe(STUDENT_ID);
      expect(r.contract.status).toBe('active');
      expect(r.contract.activatedAt).toBeDefined();
      expect(r.contract.totalAmount).toBe(9999);
      expect(r.contract.lessonHours).toBe(30);
      expect(r.contract.giftHours).toBe(3);
    });

    it('返回 result.studentCoursePackage 含 id/studentId/coursePackageId/contractId/totalLessons/remainingLessons/usedLessons=0', async () => {
      setupHappyPath();
      const r = await repo.markPaid(TENANT, INVOICE_ID, baseMarkPaidPayload());
      expect(r.studentCoursePackage.id).toBeDefined();
      expect(r.studentCoursePackage.studentId).toBe(STUDENT_ID);
      expect(r.studentCoursePackage.coursePackageId).toBeDefined();
      expect(r.studentCoursePackage.contractId).toBe(CONTRACT_ID);
      expect(r.studentCoursePackage.totalLessons).toBe(33);
      expect(r.studentCoursePackage.remainingLessons).toBe(33);
      expect(r.studentCoursePackage.usedLessons).toBe(0);
      expect(r.studentCoursePackage.refundedLessons).toBe(0);
      expect(r.studentCoursePackage.status).toBe('active');
      expect(r.studentCoursePackage.activatedAt).toBeDefined();
      expect(r.studentCoursePackage.expiresAt).toBeDefined();
    });

    // ---------- mapRow 透传 paid_at / payment_method ----------
    it('mapRow 解析 paid_at + payment_method 列（向后兼容老数据 null）', () => {
      const oldRow = invoiceRow({ paid_at: null, payment_method: null });
      const inv = repo.mapRow(oldRow);
      expect(inv.paidAt).toBeNull();
      expect(inv.paymentMethod).toBeNull();

      const newRow = invoiceRow({
        paid_at: new Date('2026-05-20T10:30:00.000Z'),
        payment_method: '微信支付',
      });
      const inv2 = repo.mapRow(newRow);
      expect(inv2.paidAt).toBe('2026-05-20T10:30:00.000Z');
      expect(inv2.paymentMethod).toBe('微信支付');
    });
  });
});
