import { Test } from '@nestjs/testing';
import { AuditLogRepository, AuditEntry, normalizeActorRole, VALID_ACTOR_ROLES } from './audit-log.repository';
import { PgPoolService } from './pg-pool.service';

describe('AuditLogRepository', () => {
  let repo: AuditLogRepository;
  let pg: { tenantQuery: jest.Mock; query: jest.Mock; withClient: jest.Mock };

  const TENANT = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const ENTRY: AuditEntry = {
    actorUserId: 'usr00000000000000000000000000A001',
    actorRole: 'sales',
    action: 'student.transfer-sales',
    targetType: 'student',
    targetId: 'stu00000000000000000000000000A001',
    before: { ownerSalesId: 'usr00000000000000000000000000A001' },
    after: { ownerSalesId: 'usr00000000000000000000000000A002' },
    ip: '1.2.3.4',
    userAgent: 'WeChatMP/8.0.45',
    requestId: 'req-abc-123',
  };

  beforeEach(async () => {
    pg = { tenantQuery: jest.fn(), query: jest.fn(), withClient: jest.fn() };
    const m = await Test.createTestingModule({
      providers: [
        AuditLogRepository,
        { provide: PgPoolService, useValue: pg },
      ],
    }).compile();
    repo = m.get(AuditLogRepository);
  });

  describe('log()', () => {
    it('正常写入一条审计日志', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.log(TENANT, ENTRY);

      expect(pg.tenantQuery).toHaveBeenCalledTimes(1);
      const [schema, sql, params] = pg.tenantQuery.mock.calls[0];
      expect(schema).toBe(TENANT);
      expect(sql).toMatch(/INSERT INTO audit_log/);
      expect(params).toEqual([
        ENTRY.actorUserId,
        ENTRY.actorRole,
        ENTRY.action,
        ENTRY.targetType,
        ENTRY.targetId,
        JSON.stringify(ENTRY.before),
        JSON.stringify(ENTRY.after),
        ENTRY.ip,
        ENTRY.userAgent,
        ENTRY.requestId,
      ]);
    });

    it('actorUserId 为空（系统动作）→ NULL 占位', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.log(TENANT, {
        actorRole: 'system',
        action: 'cron.expire-quota',
        targetType: 'promotion_audit',
      });
      const [, , params] = pg.tenantQuery.mock.calls[0];
      expect(params[0]).toBeNull(); // actorUserId
      expect(params[4]).toBeNull(); // targetId
      expect(params[5]).toBeNull(); // before
      expect(params[6]).toBeNull(); // after
    });

    it('before/after 为对象 → JSON 序列化', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.log(TENANT, {
        actorRole: 'admin',
        action: 'tenant.upgrade',
        targetType: 'tenant',
        before: { planTier: 'standard_1999' },
        after: { planTier: 'school_pro' },
      });
      const [, , params] = pg.tenantQuery.mock.calls[0];
      expect(typeof params[5]).toBe('string');
      expect(JSON.parse(params[5] as string)).toEqual({ planTier: 'standard_1999' });
    });

    it('PG 报错 → 不抛出（catch 内部，主业务不阻塞）', async () => {
      pg.tenantQuery.mockRejectedValueOnce(new Error('PG connection lost'));
      // 不应抛出
      await expect(repo.log(TENANT, ENTRY)).resolves.toBeUndefined();
    });
  });

  describe('listRecent()', () => {
    it('返回时间倒序的 audit_log 条目', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        {
          id: 1,
          actor_user_id: ENTRY.actorUserId,
          actor_role: ENTRY.actorRole,
          action: ENTRY.action,
          target_type: ENTRY.targetType,
          target_id: ENTRY.targetId,
          before: ENTRY.before,
          after: ENTRY.after,
          ip: ENTRY.ip,
          user_agent: ENTRY.userAgent,
          request_id: ENTRY.requestId,
          created_at: new Date('2026-05-10T10:00:00Z'),
        },
      ]);
      const out = await repo.listRecent(TENANT, 10);
      expect(out).toHaveLength(1);
      expect(out[0].action).toBe(ENTRY.action);
      expect(out[0].before).toEqual(ENTRY.before);

      const [, sql, params] = pg.tenantQuery.mock.calls[0];
      expect(sql).toMatch(/ORDER BY created_at DESC/);
      expect(params).toEqual([10]);
    });

    it('默认 limit 50', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.listRecent(TENANT);
      expect(pg.tenantQuery.mock.calls[0][2]).toEqual([50]);
    });
  });

  describe('listByActor()', () => {
    it('查某用户操作历史 + WHERE actor_user_id', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.listByActor(TENANT, 'usr00000000000000000000000000A001', 20);
      const [, sql, params] = pg.tenantQuery.mock.calls[0];
      expect(sql).toMatch(/WHERE actor_user_id = \$1/);
      expect(params).toEqual(['usr00000000000000000000000000A001', 20]);
    });
  });

  describe('listByTarget()', () => {
    it('OOUX 场景：查某 student 变更历史', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.listByTarget(TENANT, 'student', 'stu00000000000000000000000000A001', 100);
      const [, sql, params] = pg.tenantQuery.mock.calls[0];
      expect(sql).toMatch(/WHERE target_type = \$1 AND target_id = \$2/);
      expect(params).toEqual(['student', 'stu00000000000000000000000000A001', 100]);
    });
  });

  describe('list() 自由组合过滤', () => {
    it('无过滤 → 不带 WHERE', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.list(TENANT);
      const [, sql] = pg.tenantQuery.mock.calls[0];
      expect(sql).not.toMatch(/WHERE/);
      expect(sql).toMatch(/LIMIT/);
    });

    it('多条件组合（actor + targetType + action）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.list(TENANT, {
        actorUserId: 'usr00000000000000000000000000A001',
        targetType: 'contract',
        action: 'contract.activate',
        limit: 30,
        offset: 60,
      });
      const [, sql, params] = pg.tenantQuery.mock.calls[0];
      expect(sql).toMatch(/WHERE actor_user_id = \$1 AND target_type = \$2 AND action = \$3/);
      expect(params).toEqual([
        'usr00000000000000000000000000A001',
        'contract',
        'contract.activate',
        30,
        60,
      ]);
    });
  });

  describe('count()', () => {
    it('统计某动作发生次数', async () => {
      pg.tenantQuery.mockResolvedValueOnce([{ cnt: '42' }]);
      const n = await repo.count(TENANT, { action: 'student.transfer-sales' });
      expect(n).toBe(42);
      const [, sql] = pg.tenantQuery.mock.calls[0];
      expect(sql).toMatch(/COUNT\(\*\)/);
      expect(sql).toMatch(/WHERE action = \$1/);
    });

    it('空表 → 返回 0', async () => {
      pg.tenantQuery.mockResolvedValueOnce([{ cnt: '0' }]);
      expect(await repo.count(TENANT)).toBe(0);
    });
  });

  // Sprint E #3 round 5 (A09 FINDING-1 修复)：normalizeActorRole 运行时白名单校验
  describe('normalizeActorRole — A09 FINDING-1 防护', () => {
    it('已知 ActorRole 透传', () => {
      expect(normalizeActorRole('admin')).toBe('admin');
      expect(normalizeActorRole('teacher')).toBe('teacher');
      expect(normalizeActorRole('sales')).toBe('sales');
      expect(normalizeActorRole('parent')).toBe('parent');
      expect(normalizeActorRole('system')).toBe('system');
      expect(normalizeActorRole('platform_admin')).toBe('platform_admin');
    });

    it('TenantRole 含但 ActorRole 不含的 marketing → fallback system（A09 修复关键）', () => {
      // marketing 在 TenantRole 但不在 ActorRole / V33 CHECK 内
      // 旧实现直接 as ActorRole 强转 → INSERT 违反 CHECK constraint → audit 静默丢失
      expect(normalizeActorRole('marketing')).toBe('system');
    });

    it('PlatformRole 含但 ActorRole 不含的 finance_admin → fallback system', () => {
      // finance_admin 在 PlatformRole 但不在 ActorRole / V33 CHECK 内
      expect(normalizeActorRole('finance_admin')).toBe('system');
    });

    it('未知字符串 → fallback system', () => {
      expect(normalizeActorRole('hacker_role')).toBe('system');
      expect(normalizeActorRole('SUPER_USER')).toBe('system');
    });

    it('null / undefined / 空字符串 → fallback system', () => {
      expect(normalizeActorRole(null)).toBe('system');
      expect(normalizeActorRole(undefined)).toBe('system');
      expect(normalizeActorRole('')).toBe('system');
    });

    it('VALID_ACTOR_ROLES 集合包含 15 个值，与 V33 CHECK constraint 对齐', () => {
      expect(VALID_ACTOR_ROLES.size).toBe(15);
      expect(VALID_ACTOR_ROLES.has('admin')).toBe(true);
      expect(VALID_ACTOR_ROLES.has('system')).toBe(true);
      // 不应包含 TenantRole-only 或 PlatformRole-only 的 role
      expect((VALID_ACTOR_ROLES as ReadonlySet<string>).has('marketing')).toBe(false);
      expect((VALID_ACTOR_ROLES as ReadonlySet<string>).has('finance_admin')).toBe(false);
    });
  });
});
