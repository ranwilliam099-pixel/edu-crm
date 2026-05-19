import { Test } from '@nestjs/testing';
import {
  RefreshTokenRepository,
  InsertRefreshTokenInput,
} from './refresh-token.repository';
import { PgPoolService } from '../db/pg-pool.service';

describe('RefreshTokenRepository (T11 V43)', () => {
  let repo: RefreshTokenRepository;
  let pg: { query: jest.Mock };

  const TOKEN_HASH = Buffer.alloc(32, 0xaa);
  const SUBJECT_ID = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMN01';
  const TENANT_ID = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMN02';
  const ROW_ID = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMN03';

  beforeEach(async () => {
    pg = { query: jest.fn() };
    const m = await Test.createTestingModule({
      providers: [
        RefreshTokenRepository,
        { provide: PgPoolService, useValue: pg },
      ],
    }).compile();
    repo = m.get(RefreshTokenRepository);
  });

  // --------------------------------------------------------------
  // findByHash() — spec §2.2 step 3
  // --------------------------------------------------------------
  describe('findByHash()', () => {
    it('行存在 → 返 RefreshTokenRow（snake_case → camelCase）', async () => {
      const expiresAt = new Date(Date.now() + 604800 * 1000);
      const createdAt = new Date();
      pg.query.mockResolvedValueOnce([
        {
          id: ROW_ID,
          subject_type: 'b-user',
          subject_id: SUBJECT_ID,
          tenant_id: TENANT_ID,
          token_hash: TOKEN_HASH,
          jti: '01HX7Y6P5K9N3M2QABCDEFGHIJ',
          expires_at: expiresAt,
          revoked_at: null,
          created_at: createdAt,
          last_used_at: null,
          user_agent: 'WeChatMP/8.0',
          ip: '1.2.3.4',
        },
      ]);
      const row = await repo.findByHash(TOKEN_HASH);
      expect(row).not.toBeNull();
      expect(row!.id).toBe(ROW_ID);
      expect(row!.subjectType).toBe('b-user');
      expect(row!.subjectId).toBe(SUBJECT_ID);
      expect(row!.tenantId).toBe(TENANT_ID);
      expect(row!.tokenHash).toBe(TOKEN_HASH);
      expect(row!.revokedAt).toBeNull();
      // 单测断言 SQL 用了 public.refresh_tokens（不切 tenant schema）
      const [sql, params] = pg.query.mock.calls[0];
      expect(sql).toMatch(/FROM\s+public\.refresh_tokens/);
      expect(sql).toMatch(/WHERE\s+token_hash\s+=\s+\$1/);
      expect(sql).toMatch(/LIMIT\s+1/);
      expect(params).toEqual([TOKEN_HASH]);
    });

    it('行不存在 → 返 null', async () => {
      pg.query.mockResolvedValueOnce([]);
      const row = await repo.findByHash(TOKEN_HASH);
      expect(row).toBeNull();
    });

    it('parent 行（tenant_id NULL）→ tenantId null', async () => {
      pg.query.mockResolvedValueOnce([
        {
          id: ROW_ID,
          subject_type: 'parent',
          subject_id: SUBJECT_ID,
          tenant_id: null,
          token_hash: TOKEN_HASH,
          jti: '01HX7Y6P5K9N3M2QABCDEFGHIJ',
          expires_at: new Date(Date.now() + 2592000 * 1000),
          revoked_at: null,
          created_at: new Date(),
          last_used_at: null,
          user_agent: null,
          ip: null,
        },
      ]);
      const row = await repo.findByHash(TOKEN_HASH);
      expect(row!.subjectType).toBe('parent');
      expect(row!.tenantId).toBeNull();
    });
  });

  // --------------------------------------------------------------
  // insert() — spec §2.2 step 5
  // --------------------------------------------------------------
  describe('insert()', () => {
    const baseInput: InsertRefreshTokenInput = {
      id: ROW_ID,
      subjectType: 'b-user',
      subjectId: SUBJECT_ID,
      tenantId: TENANT_ID,
      tokenHash: TOKEN_HASH,
      jti: '01HX7Y6P5K9N3M2QABCDEFGHIJ',
      expiresAt: new Date(Date.now() + 604800 * 1000),
      userAgent: 'JestTest/1.0',
      ip: '1.2.3.4',
    };

    it('B 端正常 INSERT 9 字段', async () => {
      pg.query.mockResolvedValueOnce([]);
      await repo.insert(baseInput);
      expect(pg.query).toHaveBeenCalledTimes(1);
      const [sql, params] = pg.query.mock.calls[0];
      expect(sql).toMatch(/INSERT INTO\s+public\.refresh_tokens/);
      expect(params).toEqual([
        baseInput.id,
        baseInput.subjectType,
        baseInput.subjectId,
        baseInput.tenantId,
        baseInput.tokenHash,
        baseInput.jti,
        baseInput.expiresAt,
        baseInput.userAgent,
        baseInput.ip,
      ]);
    });

    it('parent (tenantId=null) INSERT → tenant_id 占位 null（V43 CHECK 强制 parent.tenant_id IS NULL）', async () => {
      pg.query.mockResolvedValueOnce([]);
      await repo.insert({ ...baseInput, subjectType: 'parent', tenantId: null });
      const [, params] = pg.query.mock.calls[0];
      expect(params[1]).toBe('parent');
      expect(params[3]).toBeNull();
    });

    it('userAgent / ip 为 null → 占位 null', async () => {
      pg.query.mockResolvedValueOnce([]);
      await repo.insert({ ...baseInput, userAgent: null, ip: null });
      const [, params] = pg.query.mock.calls[0];
      expect(params[7]).toBeNull();
      expect(params[8]).toBeNull();
    });
  });

  // --------------------------------------------------------------
  // revoke() — spec §3.1
  // --------------------------------------------------------------
  describe('revoke()', () => {
    it('UPDATE revoked_at + last_used_at（只对 revoked_at IS NULL 的行）', async () => {
      pg.query.mockResolvedValueOnce([]);
      await repo.revoke(ROW_ID);
      const [sql, params] = pg.query.mock.calls[0];
      expect(sql).toMatch(/UPDATE\s+public\.refresh_tokens/);
      expect(sql).toMatch(/SET\s+revoked_at\s+=\s+NOW\(\)/);
      expect(sql).toMatch(/last_used_at\s+=\s+NOW\(\)/);
      expect(sql).toMatch(/WHERE\s+id\s+=\s+\$1\s+AND\s+revoked_at\s+IS\s+NULL/);
      expect(params).toEqual([ROW_ID]);
    });
  });

  // --------------------------------------------------------------
  // revokeAllBySubject() — spec §3.3 重放检测
  // --------------------------------------------------------------
  describe('revokeAllBySubject()', () => {
    it('B 端：撤销该 subject 全部 active token，返撤销数', async () => {
      pg.query.mockResolvedValueOnce([{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }]);
      const n = await repo.revokeAllBySubject('b-user', SUBJECT_ID);
      expect(n).toBe(3);
      const [sql, params] = pg.query.mock.calls[0];
      expect(sql).toMatch(/UPDATE\s+public\.refresh_tokens/);
      expect(sql).toMatch(/SET\s+revoked_at\s+=\s+NOW\(\)/);
      expect(sql).toMatch(/subject_type\s+=\s+\$1/);
      expect(sql).toMatch(/subject_id\s+=\s+\$2/);
      expect(sql).toMatch(/revoked_at\s+IS\s+NULL/);
      expect(sql).toMatch(/RETURNING\s+id/);
      expect(params).toEqual(['b-user', SUBJECT_ID]);
    });

    it('C 端 parent：撤销返 0（无 active token）', async () => {
      pg.query.mockResolvedValueOnce([]);
      const n = await repo.revokeAllBySubject('parent', SUBJECT_ID);
      expect(n).toBe(0);
    });
  });

  // --------------------------------------------------------------
  // cleanupExpired() — spec §7 cron 每日 03:00
  // --------------------------------------------------------------
  describe('cleanupExpired()', () => {
    it('DELETE expires_at < NOW() - 30 days，返删除数', async () => {
      pg.query.mockResolvedValueOnce([
        { id: 'r1' },
        { id: 'r2' },
      ]);
      const n = await repo.cleanupExpired(30);
      expect(n).toBe(2);
      const [sql, params] = pg.query.mock.calls[0];
      expect(sql).toMatch(/DELETE FROM\s+public\.refresh_tokens/);
      expect(sql).toMatch(/expires_at\s+<\s+NOW\(\)\s+-\s+\(\$1\s+\|\|\s+' days'\)::INTERVAL/);
      expect(sql).toMatch(/RETURNING\s+id/);
      expect(params).toEqual(['30']);
    });

    it('retentionDays 默认 30', async () => {
      pg.query.mockResolvedValueOnce([]);
      await repo.cleanupExpired();
      const [, params] = pg.query.mock.calls[0];
      expect(params).toEqual(['30']);
    });

    it('retentionDays 自定义（7）→ 传 7', async () => {
      pg.query.mockResolvedValueOnce([]);
      await repo.cleanupExpired(7);
      const [, params] = pg.query.mock.calls[0];
      expect(params).toEqual(['7']);
    });
  });
});
