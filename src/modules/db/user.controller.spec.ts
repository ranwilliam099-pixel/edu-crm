/**
 * user.controller.spec.ts (5/20 stryker 28% → 目标 > 70%)
 *
 * 来源：5/20 stryker 报 user.controller.ts 28.62% (77 killed / 54 survived)
 *   核心员工管理 endpoint — RBAC + audit_log + Redis JWT 黑名单 + refresh token rotation
 *
 * 9 endpoints:
 *   1. POST   /db/users                        createUser
 *   2. GET    /db/users/inactive-with-pending  listInactive
 *   3. GET    /db/users/list                   listActive
 *   4. GET    /db/users/active-with-data       listActiveWithData
 *   5. GET    /db/users/:id                    detail
 *   6. POST   /db/users/:userId/deactivate     deactivate
 *   7. POST   /db/users/:userId/reset-password resetPassword
 *   8. POST   /db/users/:fromUserId/handover   handover
 */
import { UserController } from './user.controller';
import { BadRequestException } from '@nestjs/common';

describe('UserController', () => {
  let controller: UserController;
  let mockRepo: any;
  let mockPhoneLookup: any;
  let mockPasswordHasher: any;
  let mockRedis: any;
  let mockRefreshTokenService: any;
  let mockAuditLog: any;

  const adminReq = {
    user: { sub: 'admin000000000000000000000000001', role: 'admin', campusId: null },
    ip: '127.0.0.1',
    headers: { 'user-agent': 'jest', 'x-request-id': 'req-001' },
  };
  const bossReq = {
    user: { sub: 'boss0000000000000000000000000001', role: 'boss', campusId: 'cam00000000000000000000000000001' },
    ip: '127.0.0.1',
    headers: { 'user-agent': 'jest' },
  };

  beforeEach(() => {
    mockRepo = {
      createUser: jest.fn().mockResolvedValue({
        id: 'usr00000000000000000000000000001',
        name: '小王',
        role: 'sales',
        campusId: 'cam00000000000000000000000000001',
        status: '启用',
      }),
      findById: jest.fn().mockResolvedValue(null),
      listInactiveWithPending: jest.fn().mockResolvedValue([]),
      listActive: jest.fn().mockResolvedValue([]),
      listActiveWithData: jest.fn().mockResolvedValue([]),
      deactivate: jest.fn().mockResolvedValue({
        user: { id: 'usr1', status: '停用' },
        transferToUserId: 'usr2',
        transferToUserLabel: '小李',
        opportunitiesMoved: 2,
        contractsMoved: 1,
        studentsMoved: 0,
        reason: '离职转交',
      }),
      resetPassword: jest.fn().mockResolvedValue({
        id: 'usr1',
        name: '小王',
        role: 'sales',
        campusId: 'cam0',
      }),
      handover: jest.fn().mockResolvedValue({
        fromUserId: 'usr1',
        toUserId: 'usr2',
        opportunitiesMoved: 2,
        contractsMoved: 1,
        studentsMoved: 0,
        reason: '校长再分配',
      }),
    };
    mockPhoneLookup = {
      lookupByPhone: jest.fn().mockResolvedValue({
        bUsers: [],
        parent: null,
      }),
    };
    mockPasswordHasher = {
      generateRandomPassword: jest.fn().mockReturnValue('Abc12345'),
      hash: jest.fn().mockResolvedValue('$2b$12$hashhashhashhashhashhashhashhashhashhashhashhashhashhash'),
    };
    mockRedis = { set: jest.fn().mockResolvedValue(undefined) };
    mockRefreshTokenService = { revokeAllBySubject: jest.fn().mockResolvedValue(undefined) };
    mockAuditLog = { log: jest.fn().mockResolvedValue(undefined) };

    controller = new UserController(
      mockRepo,
      mockPhoneLookup,
      mockPasswordHasher,
      mockRedis,
      mockRefreshTokenService,
      mockAuditLog,
      // 2026-05-22 (SSOT §6.7): admin 建 teacher 联动 — mock 简单 spy
      { insert: jest.fn().mockResolvedValue(undefined) } as any,
    );
  });

  afterEach(() => jest.clearAllMocks());

  // =============== createUser ===============
  describe('createUser', () => {
    const validBody = {
      tenantId: 'tnt00000000000000000000000000001',
      tenantSchema: 'tenant_tnt00000000000000000000000000001',
      phone: '13800001234',
      role: 'sales',
      name: '小王',
      campusId: 'cam00000000000000000000000000001',
    };

    it('happy path: admin 创建 sales — 返 user + initialPassword + 调 audit_log', async () => {
      const res = await controller.createUser(validBody, adminReq as any);
      expect(res.user.id).toBe('usr00000000000000000000000000001');
      expect(res.initialPassword).toBe('Abc12345');
      expect(mockRepo.createUser).toHaveBeenCalledWith(validBody.tenantSchema, expect.objectContaining({
        name: '小王',
        mobile: '13800001234',
        role: 'sales',
        campusId: validBody.campusId,
        passwordHash: expect.stringMatching(/^\$2b\$12\$/),
        createdBy: adminReq.user.sub,
      }));
      expect(mockAuditLog.log).toHaveBeenCalledWith(
        validBody.tenantSchema,
        expect.objectContaining({
          actorUserId: adminReq.user.sub,
          action: 'user.created-by-admin',
          targetType: 'user',
        }),
      );
    });

    it('缺 tenantSchema → BadRequest', async () => {
      await expect(
        controller.createUser({ ...validBody, tenantSchema: '' } as any, adminReq as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('tenantId 非 32 字符 → BadRequest', async () => {
      await expect(
        controller.createUser({ ...validBody, tenantId: 'short' }, adminReq as any),
      ).rejects.toThrow(/tenantId must be 32-char/);
    });

    it('phone 格式不合规 → BadRequest', async () => {
      await expect(
        controller.createUser({ ...validBody, phone: '12345' }, adminReq as any),
      ).rejects.toThrow(/phone must be valid 11-digit/);
    });

    it('name 空 → BadRequest', async () => {
      await expect(
        controller.createUser({ ...validBody, name: '   ' }, adminReq as any),
      ).rejects.toThrow(/name required/);
    });

    it('name > 32 字符 → BadRequest', async () => {
      await expect(
        controller.createUser({ ...validBody, name: 'x'.repeat(33) }, adminReq as any),
      ).rejects.toThrow(/name too long/);
    });

    it('role 非合法 sub-role → BadRequest（不允许 admin）', async () => {
      await expect(
        controller.createUser({ ...validBody, role: 'admin' }, adminReq as any),
      ).rejects.toThrow(/role must be one of/);
    });

    it('boss 创建另一个 boss → BadRequest', async () => {
      await expect(
        controller.createUser({ ...validBody, role: 'boss' }, bossReq as any),
      ).rejects.toThrow(/boss 不可创建 admin 或另一个 boss/);
    });

    it('boss 创建跨校区员工 → BadRequest', async () => {
      await expect(
        controller.createUser({ ...validBody, campusId: 'cam00000000000000000000000000999' }, bossReq as any),
      ).rejects.toThrow(/boss 只能创建本校区员工/);
    });

    it('boss 缺 campusId → BadRequest', async () => {
      const bossNoCam = { user: { sub: 'b1', role: 'boss', campusId: null } };
      await expect(
        controller.createUser(validBody, bossNoCam as any),
      ).rejects.toThrow(/boss 缺 campusId/);
    });

    it('campusId 非 32 字符 → BadRequest', async () => {
      await expect(
        controller.createUser({ ...validBody, campusId: 'short' }, adminReq as any),
      ).rejects.toThrow(/campusId must be 32-char/);
    });

    it('req.user.sub 缺 → BadRequest', async () => {
      await expect(
        controller.createUser(validBody, { user: { role: 'admin' } } as any),
      ).rejects.toThrow(/user sub required/);
    });

    it('phone 已注册 B 端 active → BadRequest PHONE_ALREADY_REGISTERED', async () => {
      mockPhoneLookup.lookupByPhone.mockResolvedValueOnce({
        bUsers: [{ status: '启用', deletedAt: null, tenantId: 'other' }],
        parent: null,
      });
      await expect(
        controller.createUser(validBody, adminReq as any),
      ).rejects.toThrow(/PHONE_ALREADY_REGISTERED/);
    });

    it('phone 已注册 active parent → BadRequest', async () => {
      mockPhoneLookup.lookupByPhone.mockResolvedValueOnce({
        bUsers: [],
        parent: { status: '启用' },
      });
      await expect(
        controller.createUser(validBody, adminReq as any),
      ).rejects.toThrow(/PHONE_ALREADY_REGISTERED/);
    });

    it('phone 已注册但 deletedAt 非 null → 视为未注册，允许', async () => {
      mockPhoneLookup.lookupByPhone.mockResolvedValueOnce({
        bUsers: [{ status: '启用', deletedAt: new Date(), tenantId: 'old' }],
        parent: null,
      });
      const res = await controller.createUser(validBody, adminReq as any);
      expect(res.user).toBeTruthy();
    });

    it('campusId 缺 + admin 没 campusId → BadRequest', async () => {
      const noCampusBody = { ...validBody, campusId: undefined } as any;
      delete noCampusBody.campusId;
      await expect(
        controller.createUser(noCampusBody, adminReq as any),
      ).rejects.toThrow(/campusId required/);
    });
  });

  // =============== listInactive ===============
  describe('listInactive', () => {
    it('happy: 调 repo + 返 items', async () => {
      mockRepo.listInactiveWithPending.mockResolvedValueOnce([{ id: 'u1' }]);
      const res = await controller.listInactive('tenant_x');
      expect(res.items).toEqual([{ id: 'u1' }]);
      expect(mockRepo.listInactiveWithPending).toHaveBeenCalledWith('tenant_x');
    });

    it('缺 tenantSchema → BadRequest', async () => {
      await expect(controller.listInactive('')).rejects.toThrow(BadRequestException);
    });
  });

  // =============== listActive ===============
  describe('listActive', () => {
    it('roles 解析 csv → 数组传给 repo', async () => {
      await controller.listActive('tenant_x', 'sales,boss', 'cam1');
      expect(mockRepo.listActive).toHaveBeenCalledWith('tenant_x', {
        roles: ['sales', 'boss'],
        campusId: 'cam1',
      });
    });

    it('roles 缺 → undefined', async () => {
      await controller.listActive('tenant_x');
      expect(mockRepo.listActive).toHaveBeenCalledWith('tenant_x', {
        roles: undefined,
        campusId: undefined,
      });
    });

    it('缺 tenantSchema → BadRequest', async () => {
      await expect(controller.listActive('')).rejects.toThrow(BadRequestException);
    });

    it('roles 含空格 → trim', async () => {
      await controller.listActive('tenant_x', ' sales , boss ');
      expect(mockRepo.listActive).toHaveBeenCalledWith('tenant_x', {
        roles: ['sales', 'boss'],
        campusId: undefined,
      });
    });

    it('roles 全是空字符串 → filter Boolean 过滤', async () => {
      await controller.listActive('tenant_x', ',,,');
      expect(mockRepo.listActive).toHaveBeenCalledWith('tenant_x', {
        roles: [],
        campusId: undefined,
      });
    });
  });

  // =============== listActiveWithData ===============
  describe('listActiveWithData', () => {
    it('happy + 缺 schema 400', async () => {
      mockRepo.listActiveWithData.mockResolvedValueOnce([{ id: 'u1' }]);
      const res = await controller.listActiveWithData('tenant_x');
      expect(res.items).toEqual([{ id: 'u1' }]);
      await expect(controller.listActiveWithData('')).rejects.toThrow(BadRequestException);
    });
  });

  // =============== detail ===============
  describe('detail', () => {
    it('happy: 返 user', async () => {
      mockRepo.findById.mockResolvedValueOnce({ id: 'u1', name: '小王' });
      const res = await controller.detail('u1', 'tenant_x');
      expect(res).toEqual({ id: 'u1', name: '小王' });
    });

    it('user 不存在 → { found: false }', async () => {
      mockRepo.findById.mockResolvedValueOnce(null);
      const res = await controller.detail('uX', 'tenant_x');
      expect(res).toEqual({ found: false });
    });

    it('缺 tenantSchema → BadRequest', async () => {
      await expect(controller.detail('u1', '')).rejects.toThrow(BadRequestException);
    });
  });

  // =============== deactivate ===============
  describe('deactivate', () => {
    const body = { tenantId: 'tnt0', tenantSchema: 'tenant_x' };

    it('happy: 调 repo + Redis 写黑名单 + refresh revoke + audit_log', async () => {
      const res = await controller.deactivate('usr1', body, adminReq as any);
      expect(res.transferToUserId).toBe('usr2');
      expect(mockRedis.set).toHaveBeenCalledWith(
        'auth:user-revoked-at:usr1',
        expect.stringMatching(/^\d+$/),
        expect.any(Number),
      );
      expect(mockRefreshTokenService.revokeAllBySubject).toHaveBeenCalledWith('b-user', 'usr1');
      expect(mockAuditLog.log).toHaveBeenCalledWith(
        'tenant_x',
        expect.objectContaining({
          action: 'user.deactivated.jwt-revoked',
          targetId: 'usr1',
        }),
      );
    });

    it('缺 tenantSchema → BadRequest', async () => {
      await expect(
        controller.deactivate('usr1', { tenantId: 'tnt0', tenantSchema: '' } as any, adminReq as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('缺 user sub/role → BadRequest', async () => {
      await expect(
        controller.deactivate('usr1', body, { user: {} } as any),
      ).rejects.toThrow(/sub\/role required/);
    });

    it('自己离职自己 → BadRequest', async () => {
      await expect(
        controller.deactivate(adminReq.user.sub, body, adminReq as any),
      ).rejects.toThrow(/不能自己离职自己/);
    });

    it('Redis 抛错 → fail-open (不阻 deactivate)', async () => {
      mockRedis.set.mockRejectedValueOnce(new Error('redis down'));
      const res = await controller.deactivate('usr1', body, adminReq as any);
      expect(res.transferToUserId).toBe('usr2'); // 主流程仍返
      expect(mockAuditLog.log).toHaveBeenCalled();
    });

    it('refresh revoke 抛错 → fail-open', async () => {
      mockRefreshTokenService.revokeAllBySubject.mockRejectedValueOnce(new Error('pg down'));
      const res = await controller.deactivate('usr1', body, adminReq as any);
      expect(res.transferToUserId).toBe('usr2');
    });

    it('JWT_TTL_SEC env 缺 → 默认 86400 + 60 buffer', async () => {
      delete process.env.JWT_TTL_SEC;
      await controller.deactivate('usr1', body, adminReq as any);
      const ttl = mockRedis.set.mock.calls[0][2];
      expect(ttl).toBeGreaterThanOrEqual(86460);
    });

    it('JWT_TTL_SEC 极小 → 兜底 900 秒', async () => {
      process.env.JWT_TTL_SEC = '60';
      await controller.deactivate('usr1', body, adminReq as any);
      const ttl = mockRedis.set.mock.calls[0][2];
      expect(ttl).toBe(900);
      delete process.env.JWT_TTL_SEC;
    });

    it('operatorLabel 缺 → fallback 操作员 ${sub前6}', async () => {
      await controller.deactivate('usr1', body, adminReq as any);
      expect(mockRepo.deactivate).toHaveBeenCalledWith(
        'tenant_x',
        'usr1',
        expect.objectContaining({
          label: expect.stringMatching(/^操作员 admin0/),
        }),
      );
    });
  });

  // =============== resetPassword ===============
  describe('resetPassword', () => {
    const body = { tenantId: 'tnt0', tenantSchema: 'tenant_x' };

    it('admin happy: 重置 + Redis/refresh + audit_log', async () => {
      const res = await controller.resetPassword('usr1', body, adminReq as any);
      expect(res.initialPassword).toBe('00000000');
      expect(mockPasswordHasher.hash).toHaveBeenCalledWith('00000000');
      expect(mockRepo.resetPassword).toHaveBeenCalledWith('tenant_x', 'usr1', expect.any(String));
      expect(mockRedis.set).toHaveBeenCalled();
      expect(mockRefreshTokenService.revokeAllBySubject).toHaveBeenCalledWith('b-user', 'usr1');
      expect(mockAuditLog.log).toHaveBeenCalledWith(
        'tenant_x',
        expect.objectContaining({ action: 'user.password-reset-by-admin' }),
      );
    });

    it('自己重置自己 → BadRequest', async () => {
      await expect(
        controller.resetPassword(adminReq.user.sub, body, adminReq as any),
      ).rejects.toThrow(/不能重置自己的密码/);
    });

    it('boss 重置 admin → BadRequest', async () => {
      mockRepo.findById.mockResolvedValueOnce({ id: 'usr1', role: 'admin', campusId: bossReq.user.campusId });
      await expect(
        controller.resetPassword('usr1', body, bossReq as any),
      ).rejects.toThrow(/boss 不可重置 admin/);
    });

    it('boss 重置另一个 boss → BadRequest', async () => {
      mockRepo.findById.mockResolvedValueOnce({ id: 'usr1', role: 'boss', campusId: bossReq.user.campusId });
      await expect(
        controller.resetPassword('usr1', body, bossReq as any),
      ).rejects.toThrow(/boss 不可重置.*boss/);
    });

    it('boss 重置非本校区员工 → BadRequest', async () => {
      mockRepo.findById.mockResolvedValueOnce({ id: 'usr1', role: 'sales', campusId: 'cam_other' });
      await expect(
        controller.resetPassword('usr1', body, bossReq as any),
      ).rejects.toThrow(/boss 只能重置本校区/);
    });

    it('boss + 目标 user 不存在 → BadRequest USER_NOT_FOUND', async () => {
      mockRepo.findById.mockResolvedValueOnce(null);
      await expect(
        controller.resetPassword('usr_missing', body, bossReq as any),
      ).rejects.toThrow(/USER_NOT_FOUND/);
    });

    it('repo.resetPassword 返 null → BadRequest USER_NOT_FOUND', async () => {
      mockRepo.resetPassword.mockResolvedValueOnce(null);
      await expect(
        controller.resetPassword('usr1', body, adminReq as any),
      ).rejects.toThrow(/USER_NOT_FOUND/);
    });

    it('缺 sub/role → BadRequest', async () => {
      await expect(
        controller.resetPassword('usr1', body, { user: {} } as any),
      ).rejects.toThrow(/sub\/role required/);
    });

    it('Redis/refresh fail-open 不阻主流程', async () => {
      mockRedis.set.mockRejectedValueOnce(new Error('boom'));
      mockRefreshTokenService.revokeAllBySubject.mockRejectedValueOnce(new Error('boom'));
      const res = await controller.resetPassword('usr1', body, adminReq as any);
      expect(res.initialPassword).toBe('00000000');
    });

    it('缺 tenantSchema → BadRequest', async () => {
      await expect(
        controller.resetPassword('usr1', { tenantSchema: '' } as any, adminReq as any),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // =============== handover ===============
  describe('handover', () => {
    const body = {
      tenantId: 'tnt0',
      tenantSchema: 'tenant_x',
      toUserId: 'usr2',
      scope: 'all' as const,
    };

    it('happy: scope=all 转给 toUserId', async () => {
      const res = await controller.handover('usr1', body, adminReq as any);
      expect(res.fromUserId).toBe('usr1');
      expect(res.toUserId).toBe('usr2');
      expect(res.opportunitiesMoved).toBe(2);
      expect(mockRepo.handover).toHaveBeenCalledWith('tenant_x', expect.objectContaining({
        fromUserId: 'usr1',
        toUserId: 'usr2',
        scope: 'all',
        operator: expect.objectContaining({ userId: adminReq.user.sub }),
      }));
    });

    it('scope=select + 显式 ids', async () => {
      await controller.handover('usr1', {
        ...body,
        scope: 'select',
        opportunityIds: ['op1', 'op2'],
        contractIds: ['ct1'],
      }, adminReq as any);
      expect(mockRepo.handover).toHaveBeenCalledWith('tenant_x', expect.objectContaining({
        scope: 'select',
        opportunityIds: ['op1', 'op2'],
        contractIds: ['ct1'],
      }));
    });

    it('scope 非法 → BadRequest', async () => {
      await expect(
        controller.handover('usr1', { ...body, scope: 'bogus' as any }, adminReq as any),
      ).rejects.toThrow(/scope must be/);
    });

    it('toUserId = null（退回池）', async () => {
      await controller.handover('usr1', { ...body, toUserId: null }, adminReq as any);
      expect(mockRepo.handover).toHaveBeenCalledWith('tenant_x', expect.objectContaining({
        toUserId: null,
      }));
    });

    it('toUserId undefined → null（退回池）', async () => {
      const noToUser = { ...body, toUserId: undefined } as any;
      await controller.handover('usr1', noToUser, adminReq as any);
      expect(mockRepo.handover).toHaveBeenCalledWith('tenant_x', expect.objectContaining({
        toUserId: null,
      }));
    });

    it('缺 tenantSchema → BadRequest', async () => {
      await expect(
        controller.handover('usr1', { ...body, tenantSchema: '' } as any, adminReq as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('缺 operator sub → BadRequest', async () => {
      await expect(
        controller.handover('usr1', body, { user: {} } as any),
      ).rejects.toThrow(/user sub required/);
    });

    it('operatorLabel 缺 → fallback', async () => {
      await controller.handover('usr1', body, adminReq as any);
      const opLabel = mockRepo.handover.mock.calls[0][1].operator.label;
      expect(opLabel).toMatch(/^操作员 admin0/);
    });
  });
});
