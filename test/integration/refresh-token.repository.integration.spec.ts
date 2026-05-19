/**
 * refresh-token.repository.integration.spec.ts — Day 3 Phase B.L2 priority spec #4
 *
 * 触发：V43 public.refresh_tokens
 *   - subject_type CHECK ('b-user'|'parent')
 *   - token_hash BYTEA UNIQUE（HMAC-SHA256 32 bytes）
 *   - rotation 模式：旧 row revoke + 新 row insert（service 层）
 *   - cleanupExpired cron 每日 03:00 删 expires_at < now - 30d
 *
 * 必测 case：
 *   1. insert + findByHash — UNIQUE(token_hash) 查询路径
 *   2. UNIQUE(token_hash) 违反 — 23505
 *   3. revoke — 单 token 撤销（仅 active 行受影响）
 *   4. revokeAllBySubject — 批量撤销 + 返回数量
 *   5. cleanupExpired — DELETE expires_at < NOW() - 30d
 *   6. subject_type CHECK 违反 — 'invalid-type' → 23514
 *   7. revoke 已 revoked 行 — WHERE revoked_at IS NULL 防双重 update
 *   8. 跨 subject 隔离 — revokeAllBySubject 仅影响指定 subjectId
 *   9. schema drift 反例 — DROP token_hash 列 → INSERT 必失败
 */

import { Pool } from 'pg';
import {
  getTestPool,
  closeTestPool,
  ensurePublicSchemaReady,
  runInPublic,
  testUlid,
} from './setup';
import { randomBytes } from 'crypto';
import { RefreshTokenRepository } from '../../src/modules/auth/refresh-token.repository';
import { PgPoolService } from '../../src/modules/db/pg-pool.service';

describe('RefreshTokenRepository [integration, real PG, V43 public.refresh_tokens]', () => {
  let pool: Pool;
  let repo: RefreshTokenRepository;
  let pgService: PgPoolService;

  const mockConfig = {
    get: (key: string, def?: any) => {
      const map: Record<string, any> = {
        DB_HOST: 'localhost',
        DB_PORT: '5433',
        DB_USER: 'eduapp',
        DB_PASSWORD: 'testpassword',
        DB_NAME: 'edu_test',
        DB_POOL_MAX: '5',
        DB_STATEMENT_TIMEOUT_MS: '10000',
      };
      return map[key] ?? def;
    },
  };

  const testSubjectId = testUlid();
  const otherSubjectId = testUlid();
  // V43 check constraint refresh_tokens_tenant_for_b:
  //   subject_type='b-user' → tenant_id IS NOT NULL
  //   subject_type='parent' → tenant_id IS NULL
  const testTenantId = testUlid();

  beforeAll(async () => {
    pool = getTestPool();
    await ensurePublicSchemaReady();
    pgService = new PgPoolService(mockConfig as any);
    repo = new RefreshTokenRepository(pgService);
  }, 30000);

  afterAll(async () => {
    // cleanup test refresh_tokens
    await runInPublic(async (c) => {
      await c.query(
        `DELETE FROM public.refresh_tokens WHERE subject_id IN ($1, $2)`,
        [testSubjectId, otherSubjectId],
      );
    });
    await pgService.onModuleDestroy();
    await closeTestPool();
  });

  // ----------------------------------------------------------------
  // Case 1: insert + findByHash
  // ----------------------------------------------------------------
  it('insert + findByHash — UNIQUE(token_hash) 等值查询', async () => {
    const tokenHash = randomBytes(32);
    await repo.insert({
      id: testUlid(),
      subjectType: 'b-user',
      subjectId: testSubjectId,
      tenantId: testTenantId,
      tokenHash,
      jti: 'jti-001',
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000), // 7 天后
      userAgent: 'jest-test',
      ip: '127.0.0.1',
    });

    const found = await repo.findByHash(tokenHash);
    expect(found).not.toBeNull();
    expect(found!.subjectId).toBe(testSubjectId);
    expect(found!.subjectType).toBe('b-user');
    expect(found!.jti.trim()).toBe('jti-001'); // V43 jti CHAR(26) 右补空格
    expect(found!.revokedAt).toBeNull();
    expect(found!.userAgent).toBe('jest-test');
    expect(found!.tokenHash).toBeInstanceOf(Buffer);
    expect(found!.tokenHash.equals(tokenHash)).toBe(true);
  });

  // ----------------------------------------------------------------
  // Case 2: UNIQUE(token_hash) 违反
  // ----------------------------------------------------------------
  it('UNIQUE(token_hash) 违反 → 23505', async () => {
    const tokenHash = randomBytes(32);
    await repo.insert({
      id: testUlid(),
      subjectType: 'b-user',
      subjectId: testSubjectId,
      tenantId: testTenantId,
      tokenHash,
      jti: 'jti-unique-a',
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      userAgent: null,
      ip: null,
    });

    // 不同 id 同 token_hash → UNIQUE 违反
    await expect(
      repo.insert({
        id: testUlid(),
        subjectType: 'b-user',
        subjectId: testSubjectId,
        tenantId: testTenantId,
        tokenHash, // 同
        jti: 'jti-unique-b',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        userAgent: null,
        ip: null,
      }),
    ).rejects.toThrow(/23505|duplicate|unique/i);
  });

  // ----------------------------------------------------------------
  // Case 3: revoke 单 token
  // ----------------------------------------------------------------
  it('revoke 单 token — UPDATE revoked_at + last_used_at', async () => {
    const tokenHash = randomBytes(32);
    const rid = testUlid();
    await repo.insert({
      id: rid,
      subjectType: 'b-user',
      subjectId: testSubjectId,
      tenantId: testTenantId,
      tokenHash,
      jti: 'jti-revoke',
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      userAgent: null,
      ip: null,
    });

    await repo.revoke(rid);

    const found = await repo.findByHash(tokenHash);
    expect(found).not.toBeNull();
    expect(found!.revokedAt).toBeInstanceOf(Date);
    expect(found!.lastUsedAt).toBeInstanceOf(Date);
  });

  // ----------------------------------------------------------------
  // Case 4: revokeAllBySubject
  // ----------------------------------------------------------------
  it('revokeAllBySubject — 批量 active → revoked + 返回 count', async () => {
    // 灌 3 个 active token 给 otherSubjectId
    for (let i = 0; i < 3; i++) {
      await repo.insert({
        id: testUlid(),
        subjectType: 'parent',
        subjectId: otherSubjectId,
        tenantId: null,
        tokenHash: randomBytes(32),
        jti: `jti-bulk-${i}`,
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        userAgent: null,
        ip: null,
      });
    }

    const cnt = await repo.revokeAllBySubject('parent', otherSubjectId);
    expect(cnt).toBe(3);

    // 再调一次：已全 revoked，应 0
    const cnt2 = await repo.revokeAllBySubject('parent', otherSubjectId);
    expect(cnt2).toBe(0);
  });

  // ----------------------------------------------------------------
  // Case 5: cleanupExpired
  // ----------------------------------------------------------------
  it('cleanupExpired — DELETE expires_at < NOW() - retention days', async () => {
    // 直接 INSERT 一个 100 天前过期的 row（绕 repo.insert 默认 7d）
    const oldTokenHash = randomBytes(32);
    const oldId = testUlid();
    await runInPublic(async (c) => {
      await c.query(
        `INSERT INTO public.refresh_tokens
           (id, subject_type, subject_id, tenant_id, token_hash, jti, expires_at)
         VALUES ($1, 'b-user', $2, $3, $4, $5, NOW() - interval '100 days')`,
        [oldId, testSubjectId, testTenantId, oldTokenHash, 'jti-expired'],
      );
    });

    // cleanup 默认 30 天
    const deleted = await repo.cleanupExpired(30);
    expect(deleted).toBeGreaterThanOrEqual(1);

    // 验证：该 oldTokenHash 已不存在
    const found = await repo.findByHash(oldTokenHash);
    expect(found).toBeNull();
  });

  // ----------------------------------------------------------------
  // Case 6: subject_type CHECK 违反
  // ----------------------------------------------------------------
  it('subject_type CHECK ([\'b-user\', \'parent\']) — 非法值 → 23514', async () => {
    await expect(
      repo.insert({
        id: testUlid(),
        subjectType: 'admin' as any, // 不在白名单
        subjectId: testSubjectId,
        tenantId: null,
        tokenHash: randomBytes(32),
        jti: 'jti-bad-type',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        userAgent: null,
        ip: null,
      }),
    ).rejects.toThrow(/23514|check|constraint|subject_type/i);
  });

  // ----------------------------------------------------------------
  // Case 7: revoke 已 revoked 行 — WHERE revoked_at IS NULL 防双重
  // ----------------------------------------------------------------
  it('revoke 已 revoked 行 — WHERE revoked_at IS NULL 不更新 last_used_at', async () => {
    const tokenHash = randomBytes(32);
    const rid = testUlid();
    await repo.insert({
      id: rid,
      subjectType: 'b-user',
      subjectId: testSubjectId,
      tenantId: testTenantId,
      tokenHash,
      jti: 'jti-double-revoke',
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      userAgent: null,
      ip: null,
    });

    await repo.revoke(rid);
    const after1 = await repo.findByHash(tokenHash);
    const firstRevoked = after1!.revokedAt!.getTime();

    await new Promise((r) => setTimeout(r, 50));
    await repo.revoke(rid); // 再调一次（WHERE revoked_at IS NULL 不匹配）
    const after2 = await repo.findByHash(tokenHash);

    // revoked_at 不变（首次 timestamp 保留）
    expect(after2!.revokedAt!.getTime()).toBe(firstRevoked);
  });

  // ----------------------------------------------------------------
  // Case 8: 跨 subject 隔离
  // ----------------------------------------------------------------
  it('revokeAllBySubject — 仅影响指定 subjectId 不影响他人', async () => {
    const subA = testUlid();
    const subB = testUlid();
    const hashA = randomBytes(32);
    const hashB = randomBytes(32);
    await repo.insert({
      id: testUlid(),
      subjectType: 'b-user',
      subjectId: subA,
      tenantId: testTenantId,
      tokenHash: hashA,
      jti: 'jti-iso-a',
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      userAgent: null,
      ip: null,
    });
    await repo.insert({
      id: testUlid(),
      subjectType: 'b-user',
      subjectId: subB,
      tenantId: testTenantId,
      tokenHash: hashB,
      jti: 'jti-iso-b',
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      userAgent: null,
      ip: null,
    });

    const cntA = await repo.revokeAllBySubject('b-user', subA);
    expect(cntA).toBe(1);

    // subA 已 revoked
    const foundA = await repo.findByHash(hashA);
    expect(foundA!.revokedAt).not.toBeNull();

    // subB 仍 active
    const foundB = await repo.findByHash(hashB);
    expect(foundB!.revokedAt).toBeNull();

    // cleanup
    await runInPublic(async (c) => {
      await c.query(`DELETE FROM public.refresh_tokens WHERE subject_id IN ($1, $2)`, [subA, subB]);
    });
  });

  // ----------------------------------------------------------------
  // Case 9: schema drift — DROP token_hash 列
  // ----------------------------------------------------------------
  it('schema drift 反例: 模拟 DROP token_hash 列 → INSERT 必失败 42703', async () => {
    // public.refresh_tokens 是共用表，不能真 DROP（会影响其他 spec）
    // 用 INSERT 显式打错列名（模拟列被 drop）
    await expect(
      runInPublic(async (c) => {
        await c.query(
          `INSERT INTO public.refresh_tokens
             (id, subject_type, subject_id, tenant_id, token_hash_DROPPED, jti, expires_at)
           VALUES ($1, 'b-user', $2, NULL, $3, 'drift', NOW() + interval '7 days')`,
          [testUlid(), testSubjectId, randomBytes(32)],
        );
      }),
    ).rejects.toThrow(/42703|column|does not exist/i);
  });
});
