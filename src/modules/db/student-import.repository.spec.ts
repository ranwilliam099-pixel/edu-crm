import { Test } from '@nestjs/testing';
import {
  StudentImportRepository,
  StudentImportRow,
} from './student-import.repository';
import { PgPoolService } from './pg-pool.service';
import { FieldEncryptor } from '../../common/crypto/field-encryptor';
import { HmacHasher } from '../../common/crypto/hmac-hasher';

/**
 * StudentImportRepository spec
 *   - V18 基础导入逻辑（validateRow / importStudents 流程）
 *   - V41 customers.primary_mobile 三写双读（A02-4，2026-05-13）：
 *     - 查重路径：primary_mobile_hash 优先（生产路径）+ fallback 明文（兼容期）
 *     - 新建路径：primary_mobile + primary_mobile_hash + primary_mobile_encrypted 三写
 */
describe('StudentImportRepository (V18 + V41 primary_mobile 三写双读)', () => {
  let repo: StudentImportRepository;
  let pg: { tenantQuery: jest.Mock; query: jest.Mock; withClient: jest.Mock; transaction: jest.Mock };
  let encryptor: { encrypt: jest.Mock; decrypt: jest.Mock };
  let hasher: { hash: jest.Mock };

  const TENANT = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const CAMPUS_ID = 'cam0000000000000000000000000A001';
  const OP_ID = 'usr0000000000000000000000000A001';

  const MOCK_CIPHER = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee]);
  const MOCK_HASH = Buffer.alloc(32, 0x55);

  const VALID: StudentImportRow = {
    name: '张小明',
    parentName: '张爸爸',
    parentPhone: '13800138000',
    grade: '初一',
    school: '中关村小学',
    subjects: '英语',
  };

  beforeEach(async () => {
    pg = { tenantQuery: jest.fn(), query: jest.fn(), withClient: jest.fn(), transaction: jest.fn() };
    encryptor = {
      encrypt: jest.fn((plain: string | null | undefined) =>
        plain === null || plain === undefined ? null : MOCK_CIPHER,
      ),
      decrypt: jest.fn(() => '13800138000'),
    };
    hasher = {
      hash: jest.fn((plain: string | null | undefined) =>
        plain === null || plain === undefined ? null : MOCK_HASH,
      ),
    };
    const m = await Test.createTestingModule({
      providers: [
        StudentImportRepository,
        { provide: PgPoolService, useValue: pg },
        { provide: FieldEncryptor, useValue: encryptor },
        { provide: HmacHasher, useValue: hasher },
      ],
    }).compile();
    repo = m.get(StudentImportRepository);
  });

  describe('validateRow', () => {
    it('returns null for valid row', () => {
      expect(repo.validateRow(VALID)).toBeNull();
    });
    it('rejects missing name', () => {
      expect(repo.validateRow({ ...VALID, name: '' })).toContain('name');
    });
    it('rejects missing parentName', () => {
      expect(repo.validateRow({ ...VALID, parentName: '' })).toContain(
        'parentName',
      );
    });
    it('rejects missing parentPhone', () => {
      expect(repo.validateRow({ ...VALID, parentPhone: '' })).toContain(
        'parentPhone',
      );
    });
    it('rejects 10-digit phone', () => {
      expect(
        repo.validateRow({ ...VALID, parentPhone: '1380013800' }),
      ).toContain('11 位');
    });
    it('rejects phone starting with 2', () => {
      expect(
        repo.validateRow({ ...VALID, parentPhone: '23800138000' }),
      ).toContain('11 位');
    });
  });

  describe('importStudents', () => {
    it('returns 0 successCount when rows empty', async () => {
      const r = await repo.importStudents(TENANT, [], {
        operatorUserId: OP_ID,
        campusId: CAMPUS_ID,
      });
      expect(r.successCount).toBe(0);
      expect(r.errorRows).toEqual([]);
    });

    it('rejects > 500 rows', async () => {
      const rows = new Array(501).fill(VALID);
      const r = await repo.importStudents(TENANT, rows, {
        operatorUserId: OP_ID,
        campusId: CAMPUS_ID,
      });
      expect(r.successCount).toBe(0);
      expect(r.errorRows[0].error).toContain('500');
    });

    it('inserts new customer + student in transaction (V41 三写 primary_mobile + hash + encrypted)', async () => {
      const calls: { sql: string; params?: any[] }[] = [];
      pg.withClient.mockImplementationOnce(async (fn: any) => {
        const client = {
          query: jest.fn(async (sql: string, params?: any[]) => {
            calls.push({ sql, params });
            // SELECT customer（hash 路径 + 明文 fallback）→ 都返回空 → 走 INSERT
            if (sql.includes('SELECT id FROM customers')) {
              return { rows: [], rowCount: 0 };
            }
            return { rows: [], rowCount: 1 };
          }),
        };
        return fn(client);
      });

      const r = await repo.importStudents(TENANT, [VALID], {
        operatorUserId: OP_ID,
        campusId: CAMPUS_ID,
      });
      expect(r.successCount).toBe(1);
      expect(r.errorRows).toEqual([]);
      expect(calls.some((c) => c.sql.includes('INSERT INTO customers'))).toBe(true);
      expect(calls.some((c) => c.sql.includes('INSERT INTO students'))).toBe(true);

      // V41 hash + encrypt 各调用 1 次
      expect(hasher.hash).toHaveBeenCalledTimes(1);
      expect(hasher.hash).toHaveBeenCalledWith('13800138000');
      expect(encryptor.encrypt).toHaveBeenCalledTimes(1);
      expect(encryptor.encrypt).toHaveBeenCalledWith('13800138000');

      // INSERT INTO customers SQL 含三列
      const insertCall = calls.find(
        (c) => c.sql.includes('INSERT INTO customers'),
      );
      expect(insertCall).toBeDefined();
      expect(insertCall!.sql).toMatch(/primary_mobile_hash/);
      expect(insertCall!.sql).toMatch(/primary_mobile_encrypted/);
      // params 顺序：id, parentName, primary_mobile, primary_mobile_hash, primary_mobile_encrypted,
      //              campusId, operatorUserId
      const insertParams = insertCall!.params!;
      expect(insertParams[2]).toBe('13800138000');
      expect(insertParams[3]).toEqual(MOCK_HASH);
      expect(insertParams[4]).toEqual(MOCK_CIPHER);
    });

    it('V41 查重路径：hash 列查到 → 复用 customer（不走明文 fallback / 不 INSERT）', async () => {
      const sqls: string[] = [];
      pg.withClient.mockImplementationOnce(async (fn: any) => {
        const client = {
          query: jest.fn(async (sql: string, params?: any[]) => {
            sqls.push(sql);
            // hash 路径命中
            if (sql.includes('SELECT id FROM customers') && sql.includes('primary_mobile_hash')) {
              return { rows: [{ id: 'existing-cust-id-hash' }], rowCount: 1 };
            }
            return { rows: [], rowCount: 1 };
          }),
        };
        return fn(client);
      });

      const r = await repo.importStudents(TENANT, [VALID], {
        operatorUserId: OP_ID,
        campusId: CAMPUS_ID,
      });
      expect(r.successCount).toBe(1);

      // hash 路径 SELECT 被调用
      expect(sqls.some((s) => s.includes('WHERE primary_mobile_hash ='))).toBe(true);
      // fallback 明文路径 SELECT 未被调用
      expect(sqls.some((s) => s.includes('WHERE primary_mobile ='))).toBe(false);
      // 既然复用 customer，INSERT customers 不应被调用
      expect(sqls.some((s) => s.includes('INSERT INTO customers'))).toBe(false);
      // 学生 INSERT 仍执行
      expect(sqls.some((s) => s.includes('INSERT INTO students'))).toBe(true);
    });

    it('V41 查重路径：hash miss → fallback 明文查到 → 复用 customer', async () => {
      const sqls: string[] = [];
      pg.withClient.mockImplementationOnce(async (fn: any) => {
        const client = {
          query: jest.fn(async (sql: string, params?: any[]) => {
            sqls.push(sql);
            // hash 路径 miss
            if (sql.includes('SELECT id FROM customers') && sql.includes('primary_mobile_hash')) {
              return { rows: [], rowCount: 0 };
            }
            // 明文 fallback 命中（旧 backfill 未覆盖行）
            if (sql.includes('SELECT id FROM customers') && sql.includes('WHERE primary_mobile =')) {
              return { rows: [{ id: 'existing-cust-id-plain' }], rowCount: 1 };
            }
            return { rows: [], rowCount: 1 };
          }),
        };
        return fn(client);
      });

      const r = await repo.importStudents(TENANT, [VALID], {
        operatorUserId: OP_ID,
        campusId: CAMPUS_ID,
      });
      expect(r.successCount).toBe(1);

      // 两条 SELECT 都被调用
      expect(sqls.some((s) => s.includes('WHERE primary_mobile_hash ='))).toBe(true);
      expect(sqls.some((s) => s.includes('WHERE primary_mobile ='))).toBe(true);
      // 复用 customer → INSERT customers 不应被调用
      expect(sqls.some((s) => s.includes('INSERT INTO customers'))).toBe(false);
      // 学生 INSERT 仍执行
      expect(sqls.some((s) => s.includes('INSERT INTO students'))).toBe(true);
    });

    it('reuses existing customer when phone matches (hash 路径默认)', async () => {
      pg.withClient.mockImplementationOnce(async (fn: any) => {
        const inserted: string[] = [];
        const client = {
          query: jest.fn(async (sql: string) => {
            if (sql.includes('SELECT id FROM customers') && sql.includes('primary_mobile_hash')) {
              return { rows: [{ id: 'existing-cust-id' }], rowCount: 1 };
            }
            inserted.push(sql);
            return { rows: [], rowCount: 1 };
          }),
        };
        const result = await fn(client);
        // 验证 INSERT customers 没有被调用
        expect(inserted.some((s) => s.includes('INSERT INTO customers'))).toBe(false);
        expect(inserted.some((s) => s.includes('INSERT INTO students'))).toBe(true);
        return result;
      });

      const r = await repo.importStudents(TENANT, [VALID], {
        operatorUserId: OP_ID,
        campusId: CAMPUS_ID,
      });
      expect(r.successCount).toBe(1);
    });

    it('skips invalid rows but continues', async () => {
      pg.withClient.mockImplementationOnce(async (fn: any) => {
        const client = {
          query: jest.fn(async (sql: string) => {
            if (sql.includes('SELECT id FROM customers')) {
              return { rows: [], rowCount: 0 };
            }
            return { rows: [], rowCount: 1 };
          }),
        };
        return fn(client);
      });

      const r = await repo.importStudents(
        TENANT,
        [
          VALID,
          { ...VALID, parentPhone: 'bad' }, // invalid
          VALID,
        ],
        { operatorUserId: OP_ID, campusId: CAMPUS_ID },
      );
      expect(r.successCount).toBe(2);
      expect(r.errorRows).toHaveLength(1);
      expect(r.errorRows[0].row).toBe(2);
      expect(r.errorRows[0].error).toContain('11 位');
    });

    it('catches insert errors per-row without aborting batch', async () => {
      let count = 0;
      pg.withClient.mockImplementationOnce(async (fn: any) => {
        const client = {
          query: jest.fn(async (sql: string) => {
            if (sql.includes('SELECT id FROM customers')) {
              return { rows: [], rowCount: 0 };
            }
            if (sql.includes('INSERT INTO students')) {
              count++;
              if (count === 2) throw new Error('FK violation');
              return { rows: [], rowCount: 1 };
            }
            return { rows: [], rowCount: 1 };
          }),
        };
        return fn(client);
      });

      const r = await repo.importStudents(TENANT, [VALID, VALID, VALID], {
        operatorUserId: OP_ID,
        campusId: CAMPUS_ID,
      });
      expect(r.successCount).toBe(2);
      expect(r.errorRows).toHaveLength(1);
      expect(r.errorRows[0].row).toBe(2);
    });
  });
});
