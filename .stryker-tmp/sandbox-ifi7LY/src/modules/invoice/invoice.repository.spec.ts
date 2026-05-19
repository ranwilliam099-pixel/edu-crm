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
});
