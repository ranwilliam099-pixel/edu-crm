import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { RefreshTokenService } from './refresh-token.service';
import {
  RefreshTokenRepository,
  RefreshTokenRow,
} from './refresh-token.repository';
import { HmacHasher } from '../../common/crypto/hmac-hasher';
import { AuditLogRepository } from '../db/audit-log.repository';

describe('RefreshTokenService (T11 spec §2 / §3 / §6 / §7)', () => {
  let service: RefreshTokenService;
  let repo: {
    findByHash: jest.Mock;
    insert: jest.Mock;
    revoke: jest.Mock;
    revokeAllBySubject: jest.Mock;
    cleanupExpired: jest.Mock;
  };
  let hasher: { hash: jest.Mock };
  let auditLog: { log: jest.Mock };
  let config: { get: jest.Mock };

  const SUBJECT_ID = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMN01';
  const TENANT_ID = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMN02';
  const ROW_ID = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMN03';
  const HASH_BUF = Buffer.alloc(32, 0xbb);

  const makeBUserRow = (overrides?: Partial<RefreshTokenRow>): RefreshTokenRow => ({
    id: ROW_ID,
    subjectType: 'b-user',
    subjectId: SUBJECT_ID,
    tenantId: TENANT_ID,
    tokenHash: HASH_BUF,
    jti: '01HX7Y6P5K9N3M2QABCDEFGHIJ',
    expiresAt: new Date(Date.now() + 604800 * 1000),
    revokedAt: null,
    createdAt: new Date(),
    lastUsedAt: null,
    userAgent: null,
    ip: null,
    ...overrides,
  });

  const makeParentRow = (overrides?: Partial<RefreshTokenRow>): RefreshTokenRow => ({
    id: ROW_ID,
    subjectType: 'parent',
    subjectId: SUBJECT_ID,
    tenantId: null,
    tokenHash: HASH_BUF,
    jti: '01HX7Y6P5K9N3M2QABCDEFGHIJ',
    expiresAt: new Date(Date.now() + 2592000 * 1000),
    revokedAt: null,
    createdAt: new Date(),
    lastUsedAt: null,
    userAgent: null,
    ip: null,
    ...overrides,
  });

  const CTX = { userAgent: 'JestTest/1.0', ip: '1.2.3.4', requestId: 'req-test' };

  beforeEach(async () => {
    repo = {
      findByHash: jest.fn(),
      insert: jest.fn().mockResolvedValue(undefined),
      revoke: jest.fn().mockResolvedValue(undefined),
      revokeAllBySubject: jest.fn().mockResolvedValue(0),
      cleanupExpired: jest.fn().mockResolvedValue(0),
    };
    hasher = { hash: jest.fn().mockReturnValue(HASH_BUF) };
    auditLog = { log: jest.fn().mockResolvedValue(undefined) };
    config = {
      get: jest.fn((key: string, defaultVal?: unknown) => {
        if (key === 'JWT_REFRESH_TTL_B_SEC') return 604800;
        if (key === 'JWT_REFRESH_TTL_PARENT_SEC') return 2592000;
        return defaultVal;
      }),
    };
    const m = await Test.createTestingModule({
      providers: [
        RefreshTokenService,
        { provide: ConfigService, useValue: config },
        { provide: HmacHasher, useValue: hasher },
        { provide: RefreshTokenRepository, useValue: repo },
        { provide: AuditLogRepository, useValue: auditLog },
      ],
    }).compile();
    service = m.get(RefreshTokenService);
  });

  // --------------------------------------------------------------
  // isWellFormedRawToken — spec §2.2 step 1
  // --------------------------------------------------------------
  describe('isWellFormedRawToken (static)', () => {
    it('string length 20-200 → true', () => {
      expect(RefreshTokenService.isWellFormedRawToken('a'.repeat(20))).toBe(true);
      expect(RefreshTokenService.isWellFormedRawToken('a'.repeat(43))).toBe(true);
      expect(RefreshTokenService.isWellFormedRawToken('a'.repeat(200))).toBe(true);
    });

    it('string length < 20 → false', () => {
      expect(RefreshTokenService.isWellFormedRawToken('short')).toBe(false);
      expect(RefreshTokenService.isWellFormedRawToken('a'.repeat(19))).toBe(false);
    });

    it('string length > 200 → false', () => {
      expect(RefreshTokenService.isWellFormedRawToken('a'.repeat(201))).toBe(false);
    });

    it('非 string → false', () => {
      expect(RefreshTokenService.isWellFormedRawToken(null)).toBe(false);
      expect(RefreshTokenService.isWellFormedRawToken(undefined)).toBe(false);
      expect(RefreshTokenService.isWellFormedRawToken(12345)).toBe(false);
      expect(RefreshTokenService.isWellFormedRawToken({})).toBe(false);
    });
  });

  // --------------------------------------------------------------
  // issue() — login / wechat-login 调用
  // --------------------------------------------------------------
  describe('issue()', () => {
    it('B 端：签发 + INSERT + 返 refreshToken/jti/refreshExpiresIn', async () => {
      const out = await service.issue({
        subjectType: 'b-user',
        subjectId: SUBJECT_ID,
        tenantId: TENANT_ID,
        userAgent: 'WeChatMP/8.0',
        ip: '1.2.3.4',
      });
      expect(out.refreshToken).toBeTruthy();
      expect(typeof out.refreshToken).toBe('string');
      // base64url 32-byte random → ≥ 43 字符
      expect(out.refreshToken.length).toBeGreaterThanOrEqual(43);
      expect(out.refreshExpiresIn).toBe(604800);
      expect(out.jti).toBeTruthy();
      expect(out.jti.length).toBe(26); // ULID 26-char

      expect(hasher.hash).toHaveBeenCalledWith(out.refreshToken);
      expect(repo.insert).toHaveBeenCalledTimes(1);
      const dbInput = repo.insert.mock.calls[0][0];
      expect(dbInput.subjectType).toBe('b-user');
      expect(dbInput.subjectId).toBe(SUBJECT_ID);
      expect(dbInput.tenantId).toBe(TENANT_ID);
      expect(dbInput.tokenHash).toBe(HASH_BUF);
      expect(dbInput.jti).toBe(out.jti);
      expect(dbInput.userAgent).toBe('WeChatMP/8.0');
      expect(dbInput.ip).toBe('1.2.3.4');
      // sliding window：expiresAt = now + 7d ± 1s
      const diffMs = dbInput.expiresAt.getTime() - Date.now();
      expect(diffMs).toBeGreaterThan(604800 * 1000 - 1500);
      expect(diffMs).toBeLessThanOrEqual(604800 * 1000 + 100);
    });

    it('C 端 parent：签 30d TTL + tenantId=null', async () => {
      const out = await service.issue({
        subjectType: 'parent',
        subjectId: SUBJECT_ID,
        tenantId: null,
        userAgent: null,
        ip: null,
      });
      expect(out.refreshExpiresIn).toBe(2592000);
      const dbInput = repo.insert.mock.calls[0][0];
      expect(dbInput.subjectType).toBe('parent');
      expect(dbInput.tenantId).toBeNull();
    });

    it('两次连续 issue → 两个不同 raw refreshToken（randomBytes 唯一性）', async () => {
      const a = await service.issue({
        subjectType: 'b-user',
        subjectId: SUBJECT_ID,
        tenantId: TENANT_ID,
        userAgent: null,
        ip: null,
      });
      const b = await service.issue({
        subjectType: 'b-user',
        subjectId: SUBJECT_ID,
        tenantId: TENANT_ID,
        userAgent: null,
        ip: null,
      });
      expect(a.refreshToken).not.toBe(b.refreshToken);
      expect(a.jti).not.toBe(b.jti);
    });

    it('hasher 返 null（理论不可能）→ 抛 Error（防御性）', async () => {
      hasher.hash.mockReturnValueOnce(null);
      await expect(
        service.issue({
          subjectType: 'b-user',
          subjectId: SUBJECT_ID,
          tenantId: TENANT_ID,
          userAgent: null,
          ip: null,
        }),
      ).rejects.toThrow(/hasher returned null/);
    });
  });

  // --------------------------------------------------------------
  // rotate() — POST /auth/refresh 主入口（spec §2.2 完整流程）
  // --------------------------------------------------------------
  describe('rotate()', () => {
    const RAW = 'rt_valid_raw_token_xxxxxxxxxxxxxxxx';

    it('行不存在 → 401 INVALID_REFRESH_TOKEN + pino unknown audit', async () => {
      repo.findByHash.mockResolvedValueOnce(null);
      await expect(service.rotate(RAW, CTX)).rejects.toThrow(UnauthorizedException);
      await expect(service.rotate(RAW, CTX)).rejects.toThrow(/INVALID/);
      // 未知 token 不写 audit_log 表（无 tenant schema 可定位，spec §10）
      expect(auditLog.log).not.toHaveBeenCalled();
      // 不调用 revoke / insert
      expect(repo.revoke).not.toHaveBeenCalled();
      expect(repo.insert).not.toHaveBeenCalled();
    });

    it('行 revoked_at 非空（B 端）→ 触发重放检测：撤销 subject 全部 token + audit replay-detected + 401', async () => {
      const revokedRow = makeBUserRow({ revokedAt: new Date(Date.now() - 60_000) });
      repo.findByHash.mockResolvedValueOnce(revokedRow);
      repo.revokeAllBySubject.mockResolvedValueOnce(2);

      await expect(service.rotate(RAW, CTX)).rejects.toThrow(/REVOKED/);

      expect(repo.revokeAllBySubject).toHaveBeenCalledWith('b-user', SUBJECT_ID);
      // B 端写 audit_log 到 tenant_<tenantId> schema（spec §3.3）
      expect(auditLog.log).toHaveBeenCalledTimes(1);
      const [schema, entry] = auditLog.log.mock.calls[0];
      expect(schema).toBe(`tenant_${TENANT_ID}`);
      expect(entry.action).toBe('auth.refresh.replay-detected');
      expect(entry.actorUserId).toBe(SUBJECT_ID);
      expect(entry.actorRole).toBe('system'); // normalizeActorRole(null)
      expect(entry.targetType).toBe('refresh_token');
      expect(entry.targetId).toBe(ROW_ID);
      expect(entry.after).toEqual({ revokedAllCount: 2 });
      expect(entry.ip).toBe(CTX.ip);
      expect(entry.userAgent).toBe(CTX.userAgent);
      // 不应该签新 token
      expect(repo.insert).not.toHaveBeenCalled();
    });

    it('行 revoked（C 端 parent）→ 重放检测走 pino，不写 audit_log 表', async () => {
      const revokedRow = makeParentRow({ revokedAt: new Date(Date.now() - 60_000) });
      repo.findByHash.mockResolvedValueOnce(revokedRow);
      repo.revokeAllBySubject.mockResolvedValueOnce(1);

      await expect(service.rotate(RAW, CTX)).rejects.toThrow(UnauthorizedException);

      expect(repo.revokeAllBySubject).toHaveBeenCalledWith('parent', SUBJECT_ID);
      // C 端不写 audit_log 表（spec §10「平台级 audit_log 表」不在范围）
      expect(auditLog.log).not.toHaveBeenCalled();
    });

    it('行已过期 → 401 EXPIRED（不写 audit，spec §2.3 表格）', async () => {
      const expiredRow = makeBUserRow({
        expiresAt: new Date(Date.now() - 60_000),
      });
      repo.findByHash.mockResolvedValueOnce(expiredRow);

      await expect(service.rotate(RAW, CTX)).rejects.toThrow(/EXPIRED/);
      expect(auditLog.log).not.toHaveBeenCalled();
      expect(repo.revoke).not.toHaveBeenCalled();
      expect(repo.insert).not.toHaveBeenCalled();
    });

    it('happy path B 端：撤销旧 row + INSERT 新 row + audit success + 返 oldRow/newToken', async () => {
      const validRow = makeBUserRow();
      repo.findByHash.mockResolvedValueOnce(validRow);

      const result = await service.rotate(RAW, CTX);

      // 步骤顺序验证
      expect(repo.revoke).toHaveBeenCalledWith(ROW_ID);
      expect(repo.insert).toHaveBeenCalledTimes(1);
      expect(auditLog.log).toHaveBeenCalledTimes(1);

      const [schema, entry] = auditLog.log.mock.calls[0];
      expect(schema).toBe(`tenant_${TENANT_ID}`);
      expect(entry.action).toBe('auth.refresh.success');
      expect(entry.actorUserId).toBe(SUBJECT_ID);
      expect(entry.targetId).toBe(ROW_ID);

      // 新 token 复用 oldRow 的 subjectType / tenantId
      const insertInput = repo.insert.mock.calls[0][0];
      expect(insertInput.subjectType).toBe('b-user');
      expect(insertInput.subjectId).toBe(SUBJECT_ID);
      expect(insertInput.tenantId).toBe(TENANT_ID);
      // sliding window：新 row TTL 不继承旧 expiresAt
      expect(insertInput.expiresAt.getTime()).toBeGreaterThan(Date.now() + 604700 * 1000);

      // 返值
      expect(result.oldRow.id).toBe(ROW_ID);
      expect(result.newToken.refreshToken).toBeTruthy();
      expect(result.newToken.refreshExpiresIn).toBe(604800);
    });

    it('happy path C 端 parent：撤销旧 + INSERT 新 + 不写 audit_log 表（pino only）', async () => {
      const validRow = makeParentRow();
      repo.findByHash.mockResolvedValueOnce(validRow);

      const result = await service.rotate(RAW, CTX);

      expect(repo.revoke).toHaveBeenCalledWith(ROW_ID);
      expect(repo.insert).toHaveBeenCalledTimes(1);
      // C 端 30d
      expect(result.newToken.refreshExpiresIn).toBe(2592000);
      // audit_log 表不写（spec §10）
      expect(auditLog.log).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------
  // revokeByRaw() — logout 调用 spec §4.3
  // --------------------------------------------------------------
  describe('revokeByRaw()', () => {
    const RAW = 'rt_some_raw_token_xxxxxxxxxxxxxxxx';

    it('行存在 + 未 revoked → 调 repo.revoke', async () => {
      repo.findByHash.mockResolvedValueOnce(makeBUserRow());
      await service.revokeByRaw(RAW);
      expect(repo.revoke).toHaveBeenCalledWith(ROW_ID);
    });

    it('行不存在 → 安静返回（logout 幂等，不抛错）', async () => {
      repo.findByHash.mockResolvedValueOnce(null);
      await expect(service.revokeByRaw(RAW)).resolves.toBeUndefined();
      expect(repo.revoke).not.toHaveBeenCalled();
    });

    it('行已 revoked → 安静返回（不重复 revoke）', async () => {
      repo.findByHash.mockResolvedValueOnce(
        makeBUserRow({ revokedAt: new Date(Date.now() - 60_000) }),
      );
      await service.revokeByRaw(RAW);
      expect(repo.revoke).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------
  // cleanupExpired() — @Cron('0 3 * * *') spec §7
  // --------------------------------------------------------------
  describe('cleanupExpired() — @Cron 每日 03:00', () => {
    it('调 repo.cleanupExpired(30) + 不抛错', async () => {
      repo.cleanupExpired.mockResolvedValueOnce(5);
      await service.cleanupExpired();
      expect(repo.cleanupExpired).toHaveBeenCalledWith(30);
    });

    it('repo 抛错 → fail-open（不抛错向上传，cron job 健壮性）', async () => {
      repo.cleanupExpired.mockRejectedValueOnce(new Error('DB down'));
      await expect(service.cleanupExpired()).resolves.toBeUndefined();
    });
  });

  // --------------------------------------------------------------
  // Sliding window TTL（spec §3.2 — B 7d / C 30d）
  // --------------------------------------------------------------
  describe('sliding window TTL（spec §3.2）', () => {
    it('B 端 issue → expiresAt = now + 604800s', async () => {
      const before = Date.now();
      await service.issue({
        subjectType: 'b-user',
        subjectId: SUBJECT_ID,
        tenantId: TENANT_ID,
        userAgent: null,
        ip: null,
      });
      const dbInput = repo.insert.mock.calls[0][0];
      const diffMs = dbInput.expiresAt.getTime() - before;
      expect(diffMs).toBeGreaterThan(604800 * 1000 - 100);
      expect(diffMs).toBeLessThan(604800 * 1000 + 500);
    });

    it('C 端 issue → expiresAt = now + 2592000s', async () => {
      const before = Date.now();
      await service.issue({
        subjectType: 'parent',
        subjectId: SUBJECT_ID,
        tenantId: null,
        userAgent: null,
        ip: null,
      });
      const dbInput = repo.insert.mock.calls[0][0];
      const diffMs = dbInput.expiresAt.getTime() - before;
      expect(diffMs).toBeGreaterThan(2592000 * 1000 - 100);
      expect(diffMs).toBeLessThan(2592000 * 1000 + 500);
    });

    it('rotation 新 row 不继承旧 row expiresAt（sliding，非 fixed）', async () => {
      const oldExpiresAt = new Date(Date.now() + 60_000); // 旧 row 还有 60s 过期
      const oldRow = makeBUserRow({ expiresAt: oldExpiresAt });
      repo.findByHash.mockResolvedValueOnce(oldRow);

      await service.rotate('a'.repeat(43), CTX);

      const dbInput = repo.insert.mock.calls[0][0];
      // 新 row TTL ≈ 7d，不是 60s（不继承旧 expiresAt）
      const diffMs = dbInput.expiresAt.getTime() - Date.now();
      expect(diffMs).toBeGreaterThan(604700 * 1000);
    });

    it('config 缺省 → 默认 7d / 30d（spec §3.2 default）', async () => {
      // 重新构造 service，config.get 返回 default
      const defaultConfig = {
        get: jest.fn((_key: string, defaultVal?: unknown) => defaultVal),
      };
      const m = await Test.createTestingModule({
        providers: [
          RefreshTokenService,
          { provide: ConfigService, useValue: defaultConfig },
          { provide: HmacHasher, useValue: hasher },
          { provide: RefreshTokenRepository, useValue: repo },
          { provide: AuditLogRepository, useValue: auditLog },
        ],
      }).compile();
      const svc = m.get(RefreshTokenService);
      const out = await svc.issue({
        subjectType: 'b-user',
        subjectId: SUBJECT_ID,
        tenantId: TENANT_ID,
        userAgent: null,
        ip: null,
      });
      expect(out.refreshExpiresIn).toBe(604800);
    });
  });
});
