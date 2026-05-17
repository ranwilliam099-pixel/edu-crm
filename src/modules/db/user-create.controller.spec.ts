/**
 * UserController.createUser 单测 — Sprint X.2 (2026-05-17)
 *
 * 验证（SSOT §12.4 + D2/D6）：
 *   - admin 唯一创建权 (boss/sales 403 由 RbacGuard 守, 本 unit 测 controller 逻辑)
 *   - 跨表 phone 唯一性 pre-check (互斥红线)
 *   - bcrypt + initialPassword 返一次
 *   - audit_log V33 留痕
 *
 * 注: 本 spec 直接 new UserController, 绕过 RbacGuard / TenantScopeGuard (Guard 单测另有)
 */
import {
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { UserController } from './user.controller';
import { UserRepository, User } from './user.repository';
import { PhoneLookupService } from '../auth/phone-lookup.service';
import { PasswordHasher } from '../../common/crypto/password-hasher';
import { RedisService } from '../redis/redis.service';
import { RefreshTokenService } from '../auth/refresh-token.service';
import { AuditLogRepository } from './audit-log.repository';
import type { AuthenticatedRequest } from '../auth/jwt-payload.interface';

const ULID32_T = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNT1';
const ULID32_C = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNC1';
const ULID32_ADMIN = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNA1';

function makeReq(role: string = 'admin'): AuthenticatedRequest {
  return {
    user: {
      sub: ULID32_ADMIN,
      role: role as never,
      tenantId: ULID32_T,
      campusId: ULID32_C,
    },
    headers: { 'user-agent': 'jest', 'x-request-id': 'rid-1' },
    ip: '1.2.3.4',
  } as AuthenticatedRequest;
}

describe('UserController.createUser - Sprint X.2 (D2 SSOT §12.4)', () => {
  let controller: UserController;
  let repo: { createUser: jest.Mock };
  let phoneLookup: { lookupByPhone: jest.Mock };
  let passwordHasher: { hash: jest.Mock; generateRandomPassword: jest.Mock };
  let redis: { set: jest.Mock };
  let refreshToken: { revokeAllBySubject: jest.Mock };
  let auditLog: { log: jest.Mock };

  beforeEach(() => {
    repo = {
      createUser: jest.fn().mockResolvedValue({
        id: 'newU'.padEnd(32, '0'),
        name: 'NewEmployee',
        mobile: '13900001111',
        role: 'sales',
        campusId: ULID32_C,
        status: '启用',
        createdAt: '2026-05-17T00:00:00Z',
        updatedAt: '2026-05-17T00:00:00Z',
      } as User),
    };
    phoneLookup = {
      lookupByPhone: jest.fn().mockResolvedValue({ bUsers: [], parent: null }),
    };
    passwordHasher = {
      hash: jest.fn().mockResolvedValue('$2b$12$mock_hash_60_chars_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx'),
      generateRandomPassword: jest.fn().mockReturnValue('Abcd2345'),
    };
    redis = { set: jest.fn().mockResolvedValue(undefined) };
    refreshToken = { revokeAllBySubject: jest.fn().mockResolvedValue(0) };
    auditLog = { log: jest.fn().mockResolvedValue(undefined) };

    controller = new UserController(
      repo as unknown as UserRepository,
      phoneLookup as unknown as PhoneLookupService,
      passwordHasher as unknown as PasswordHasher,
      redis as unknown as RedisService,
      refreshToken as unknown as RefreshTokenService,
      auditLog as unknown as AuditLogRepository,
    );
  });

  const validBody = () => ({
    tenantId: ULID32_T,
    tenantSchema: `tenant_${ULID32_T.toLowerCase()}`,
    phone: '13900001111',
    role: 'sales',
    name: 'NewEmployee',
    campusId: ULID32_C,
  });

  it('happy path → bcrypt hash + initialPassword 返一次 + audit_log', async () => {
    const res = await controller.createUser(validBody(), makeReq());
    expect(res.initialPassword).toBe('Abcd2345');
    expect(res.user.id).toBe('newU'.padEnd(32, '0'));
    expect(repo.createUser).toHaveBeenCalledWith(
      `tenant_${ULID32_T.toLowerCase()}`,
      expect.objectContaining({
        mobile: '13900001111',
        role: 'sales',
        passwordHash: '$2b$12$mock_hash_60_chars_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        createdBy: ULID32_ADMIN,
      }),
    );
    expect(auditLog.log).toHaveBeenCalledWith(
      `tenant_${ULID32_T.toLowerCase()}`,
      expect.objectContaining({
        action: 'user.created-by-admin',
        targetType: 'user',
        actorRole: 'admin',
      }),
    );
  });

  it('phone 非法 → 400', async () => {
    await expect(
      controller.createUser({ ...validBody(), phone: '12345' }, makeReq()),
    ).rejects.toThrow(BadRequestException);
  });

  it('tenantSchema 缺失 → 400', async () => {
    await expect(
      controller.createUser({ ...validBody(), tenantSchema: '' }, makeReq()),
    ).rejects.toThrow(BadRequestException);
  });

  it('name 空 → 400', async () => {
    await expect(
      controller.createUser({ ...validBody(), name: '   ' }, makeReq()),
    ).rejects.toThrow(BadRequestException);
  });

  it('role="admin" 拒绝 (SSOT §12.4 admin 唯一不能再创)', async () => {
    await expect(
      controller.createUser({ ...validBody(), role: 'admin' }, makeReq()),
    ).rejects.toThrow(BadRequestException);
  });

  it('role 非 9 B 端 → 400', async () => {
    await expect(
      controller.createUser({ ...validBody(), role: 'unknown' }, makeReq()),
    ).rejects.toThrow(BadRequestException);
  });

  it('跨表 phone 命中 B 端 → 400 PHONE_ALREADY_REGISTERED', async () => {
    phoneLookup.lookupByPhone.mockResolvedValueOnce({
      bUsers: [
        {
          userId: 'u1'.padEnd(32, '0'),
          tenantId: ULID32_T,
          tenantName: 'T1',
          role: 'sales',
          campusId: ULID32_C,
          userName: 'Alice',
          passwordHash: 'h',
          status: '启用',
          deletedAt: null,
          campusName: 'C1',
        },
      ],
      parent: null,
    });
    await expect(
      controller.createUser(validBody(), makeReq()),
    ).rejects.toThrow(/PHONE_ALREADY_REGISTERED/);
  });

  it('跨表 phone 命中 C 端 parent → 400 PHONE_ALREADY_REGISTERED', async () => {
    phoneLookup.lookupByPhone.mockResolvedValueOnce({
      bUsers: [],
      parent: { parentId: 'p1'.padEnd(32, '0'), status: '启用' },
    });
    await expect(
      controller.createUser(validBody(), makeReq()),
    ).rejects.toThrow(/PHONE_ALREADY_REGISTERED/);
  });

  it('campusId 非 32-char → 400', async () => {
    await expect(
      controller.createUser({ ...validBody(), campusId: 'short' }, makeReq()),
    ).rejects.toThrow(BadRequestException);
  });

  it('campusId 未传 + req.user.campusId fallback', async () => {
    await controller.createUser({ ...validBody(), campusId: undefined }, makeReq());
    expect(repo.createUser).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ campusId: ULID32_C }),
    );
  });

  it('DB 抛 ConflictException (UNIQUE mobile 23505) → 透传', async () => {
    repo.createUser.mockRejectedValueOnce(
      new ConflictException('USER_MOBILE_DUPLICATE'),
    );
    await expect(
      controller.createUser(validBody(), makeReq()),
    ).rejects.toThrow(ConflictException);
  });
});

// ============================================================
// UserController.deactivate - Sprint X.2 D6 JWT 黑名单联动
// ============================================================
describe('UserController.deactivate - Sprint X.2 (D6 JWT 黑名单)', () => {
  let controller: UserController;
  let repo: { deactivate: jest.Mock };
  let phoneLookup: { lookupByPhone: jest.Mock };
  let passwordHasher: { hash: jest.Mock; generateRandomPassword: jest.Mock };
  let redis: { set: jest.Mock };
  let refreshToken: { revokeAllBySubject: jest.Mock };
  let auditLog: { log: jest.Mock };

  beforeEach(() => {
    repo = {
      deactivate: jest.fn().mockResolvedValue({
        user: { id: 'targetU'.padEnd(32, '0'), status: '停用' },
        transferToUserId: 'newOwner'.padEnd(32, '0'),
        transferToUserLabel: '王校长（校长）',
        opportunitiesMoved: 3,
        contractsMoved: 2,
        studentsMoved: 1,
        reason: '离职转交',
      }),
    };
    phoneLookup = { lookupByPhone: jest.fn() };
    passwordHasher = { hash: jest.fn(), generateRandomPassword: jest.fn() };
    redis = { set: jest.fn().mockResolvedValue(undefined) };
    refreshToken = { revokeAllBySubject: jest.fn().mockResolvedValue(2) };
    auditLog = { log: jest.fn().mockResolvedValue(undefined) };

    controller = new UserController(
      repo as unknown as UserRepository,
      phoneLookup as unknown as PhoneLookupService,
      passwordHasher as unknown as PasswordHasher,
      redis as unknown as RedisService,
      refreshToken as unknown as RefreshTokenService,
      auditLog as unknown as AuditLogRepository,
    );
  });

  it('deactivate 后 Redis 写 user-revoked-at + refresh revoke + audit', async () => {
    const targetUserId = 'targetU'.padEnd(32, '0');
    const result = await controller.deactivate(
      targetUserId,
      { tenantId: ULID32_T, tenantSchema: `tenant_${ULID32_T.toLowerCase()}` },
      makeReq('admin'),
    );
    expect(result.user.status).toBe('停用');
    // D6: Redis 写时间戳
    // Sprint X.2 round 2 (2026-05-17 security A07-W1): TTL 改用 JWT_TTL_SEC + 60s buffer
    //   原 900s (15min) 让停用后旧 JWT 仍在 TTL 窗口内可用 (默认 JWT 86400s = 23h45min 漏洞)
    //   改为 Number 兜底 (Number 范围内任意 > 900s, 默认 86460s)
    expect(redis.set).toHaveBeenCalledWith(
      `auth:user-revoked-at:${targetUserId}`,
      expect.any(String),
      expect.any(Number),
    );
    // D6: refresh 全撤销
    expect(refreshToken.revokeAllBySubject).toHaveBeenCalledWith('b-user', targetUserId);
    // audit_log V33
    expect(auditLog.log).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        action: 'user.deactivated.jwt-revoked',
        targetId: targetUserId,
      }),
    );
  });

  it('自己离职自己 → 400', async () => {
    await expect(
      controller.deactivate(
        ULID32_ADMIN,
        { tenantId: ULID32_T, tenantSchema: `tenant_${ULID32_T.toLowerCase()}` },
        makeReq('admin'),
      ),
    ).rejects.toThrow(/不能自己离职自己/);
  });

  it('Redis 抛错 → fail-open, deactivate 仍成功', async () => {
    redis.set.mockRejectedValueOnce(new Error('Redis down'));
    const targetUserId = 'targetU'.padEnd(32, '0');
    const result = await controller.deactivate(
      targetUserId,
      { tenantId: ULID32_T, tenantSchema: `tenant_${ULID32_T.toLowerCase()}` },
      makeReq('admin'),
    );
    expect(result.user.status).toBe('停用');
    // refresh + audit 仍跑
    expect(refreshToken.revokeAllBySubject).toHaveBeenCalled();
    expect(auditLog.log).toHaveBeenCalled();
  });

  it('refresh revoke 抛错 → fail-open, deactivate 仍成功', async () => {
    refreshToken.revokeAllBySubject.mockRejectedValueOnce(new Error('DB down'));
    const targetUserId = 'targetU'.padEnd(32, '0');
    const result = await controller.deactivate(
      targetUserId,
      { tenantId: ULID32_T, tenantSchema: `tenant_${ULID32_T.toLowerCase()}` },
      makeReq('admin'),
    );
    expect(result.user.status).toBe('停用');
    // redis + audit 仍跑
    expect(redis.set).toHaveBeenCalled();
    expect(auditLog.log).toHaveBeenCalled();
  });
});
