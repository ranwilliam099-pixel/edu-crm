import { Test } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { CampusFreeSlotRepository } from './campus-free-slot.repository';
import { PgPoolService } from './pg-pool.service';

describe('CampusFreeSlotRepository — V23 C 端 slot FCFS', () => {
  let repo: CampusFreeSlotRepository;
  let pg: { tenantQuery: jest.Mock; query: jest.Mock; withClient: jest.Mock; transaction: jest.Mock };

  const CAMPUS = 'cmp00000000000000000000000000C01';
  const PARENT = 'par00000000000000000000000000P01';

  const mkClient = (responses: Record<string, any[]> = {}) => ({
    query: jest.fn().mockImplementation((sql: string) => {
      for (const [pat, rows] of Object.entries(responses)) {
        if (sql.includes(pat)) return Promise.resolve({ rows });
      }
      return Promise.resolve({ rows: [] });
    }),
  });

  beforeEach(async () => {
    pg = { tenantQuery: jest.fn(), query: jest.fn(), withClient: jest.fn(), transaction: jest.fn() };
    const m = await Test.createTestingModule({
      providers: [CampusFreeSlotRepository, { provide: PgPoolService, useValue: pg }],
    }).compile();
    repo = m.get(CampusFreeSlotRepository);
  });

  describe('listByCampus', () => {
    it('returns 10 slots ordered', async () => {
      pg.query.mockResolvedValueOnce([
        { id: 1, campus_id: CAMPUS, slot_index: 1, parent_id: null, status: 'empty', version: 0, created_at: new Date(), updated_at: new Date(), granted_at: null, expires_at: null },
      ]);
      const r = await repo.listByCampus(CAMPUS);
      expect(r).toHaveLength(1);
      expect(r[0].slotIndex).toBe(1);
    });
  });

  describe('getCampusStats', () => {
    it('aggregates by status', async () => {
      pg.query.mockResolvedValueOnce([
        { status: 'occupied', count: '7' },
        { status: 'empty', count: '2' },
        { status: 'expired', count: '1' },
      ]);
      const s = await repo.getCampusStats(CAMPUS);
      expect(s).toEqual({ total: 10, occupied: 7, empty: 2, expired: 1 });
    });
  });

  describe('claim', () => {
    it('FCFS 抢到最小空 slot', async () => {
      const slotRow = {
        id: 5, campus_id: CAMPUS, slot_index: 3, parent_id: null,
        status: 'empty', version: 0, created_at: new Date(), updated_at: new Date(),
        granted_at: null, expires_at: null,
      };
      const occupiedRow = {
        ...slotRow, parent_id: PARENT, status: 'occupied',
        granted_at: new Date(), expires_at: new Date(Date.now() + 90 * 86400000),
        version: 1,
      };
      const client = mkClient({
        "parent_id = $1 AND status = 'occupied'": [],
        "FOR UPDATE SKIP LOCKED": [slotRow],
        "status IN ('empty', 'expired')\n        RETURNING *": [occupiedRow],
      });
      pg.transaction.mockImplementationOnce(async (fn: any) => fn(client));
      const r = await repo.claim(CAMPUS, PARENT, 3);
      expect(r.parentId).toBe(PARENT);
      expect(r.status).toBe('occupied');
      expect(r.slotIndex).toBe(3);
    });

    it('家长已有 slot → ALREADY_HAS_SLOT', async () => {
      const client = mkClient({
        "parent_id = $1 AND status = 'occupied'": [{ id: 1 }],
      });
      pg.transaction.mockImplementationOnce(async (fn: any) => fn(client));
      await expect(repo.claim(CAMPUS, PARENT)).rejects.toThrow(/ALREADY_HAS_SLOT/);
    });

    it('校区已满 → SLOT_EXHAUSTED', async () => {
      const client = mkClient({
        "parent_id = $1 AND status = 'occupied'": [],
        'FOR UPDATE SKIP LOCKED': [],
      });
      pg.transaction.mockImplementationOnce(async (fn: any) => fn(client));
      await expect(repo.claim(CAMPUS, PARENT)).rejects.toThrow(/SLOT_EXHAUSTED/);
    });
  });

  describe('release', () => {
    it('releases occupied slot', async () => {
      pg.query.mockResolvedValueOnce([
        { id: 5, campus_id: CAMPUS, slot_index: 3, parent_id: null, status: 'empty', version: 2, created_at: new Date(), updated_at: new Date(), granted_at: null, expires_at: null },
      ]);
      const r = await repo.release(5);
      expect(r.status).toBe('empty');
    });
    it('not occupied → NotFound', async () => {
      pg.query.mockResolvedValueOnce([]);
      await expect(repo.release(99)).rejects.toThrow(NotFoundException);
    });
  });

  describe('expirePending', () => {
    it('returns expired count', async () => {
      pg.query.mockResolvedValueOnce([{ id: '1' }, { id: '2' }, { id: '3' }]);
      const n = await repo.expirePending();
      expect(n).toBe(3);
    });
  });

  describe('findByParent', () => {
    it('returns null when no slot', async () => {
      pg.query.mockResolvedValueOnce([]);
      expect(await repo.findByParent(PARENT)).toBeNull();
    });
    it('returns row when occupied', async () => {
      pg.query.mockResolvedValueOnce([
        { id: 5, campus_id: CAMPUS, slot_index: 3, parent_id: PARENT, status: 'occupied', version: 1, created_at: new Date(), updated_at: new Date(), granted_at: new Date(), expires_at: new Date() },
      ]);
      const r = await repo.findByParent(PARENT);
      expect(r?.parentId).toBe(PARENT);
    });
  });
});
