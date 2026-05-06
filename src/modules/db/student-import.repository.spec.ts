import { Test } from '@nestjs/testing';
import {
  StudentImportRepository,
  StudentImportRow,
} from './student-import.repository';
import { PgPoolService } from './pg-pool.service';

describe('StudentImportRepository', () => {
  let repo: StudentImportRepository;
  let pg: { tenantQuery: jest.Mock; query: jest.Mock; withClient: jest.Mock; transaction: jest.Mock };

  const TENANT = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const CAMPUS_ID = 'cam0000000000000000000000000A001';
  const OP_ID = 'usr0000000000000000000000000A001';

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
    const m = await Test.createTestingModule({
      providers: [
        StudentImportRepository,
        { provide: PgPoolService, useValue: pg },
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

    it('inserts new customer + student in transaction', async () => {
      const calls: { sql: string; params?: any[] }[] = [];
      pg.withClient.mockImplementationOnce(async (fn: any) => {
        const client = {
          query: jest.fn(async (sql: string, params?: any[]) => {
            calls.push({ sql, params });
            // SELECT customer 返回空 → 走 INSERT
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
    });

    it('reuses existing customer when phone matches', async () => {
      pg.withClient.mockImplementationOnce(async (fn: any) => {
        const inserted: string[] = [];
        const client = {
          query: jest.fn(async (sql: string) => {
            if (sql.includes('SELECT id FROM customers')) {
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
