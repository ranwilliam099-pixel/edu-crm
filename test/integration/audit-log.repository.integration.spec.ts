/**
 * audit-log.repository.integration.spec.ts — Day 3 Phase B.L2 priority spec #3
 *
 * 触发：V33 audit_log（生产架构 P0 第 1 项 — 2026-05-10）
 *   - actor_user_id UUID + target_id UUID（NOT VARCHAR — 业务 ID 必须 cast）
 *   - actor_role CHECK 强约束 15 个枚举（admin/boss/sales/...）
 *   - before/after JSONB（PII 脱敏在调用层做，repository 仅持久化）
 *   - log() 内部 try-catch fail-open（错误吞掉 + Logger.error）
 *
 * 必测 case：
 *   1. log() 成功 — 全字段持久化 + JSONB 序列化
 *   2. log() fail-open — actor_role 非法枚举（'invalid' / 'marketing'）→ 内部 catch，主流程不抛
 *   3. listRecent ORDER BY created_at DESC + LIMIT
 *   4. listByActor — actor_user_id 过滤
 *   5. listByTarget — (target_type, target_id) 过滤
 *   6. list 组合过滤 + count
 *   7. PII redact 调用层（不在 repo） — 验证 before/after JSONB 原样保存（脱敏在 service）
 *   8. 跨 tenant 隔离 — schema A 的 audit_log 不可在 schema B 查到
 *   9. normalizeActorRole helper — 'marketing'/'finance_admin' fallback 'system'
 *  10. schema drift 反例：DROP actor_role 列 → INSERT 必失败（fail-open Logger.error）
 */

import { Pool } from 'pg';
import {
  createTestSchema,
  dropTestSchema,
  getTestPool,
  closeTestPool,
  runInSchema,
  testUlid,
} from './setup';
import { randomUUID } from 'crypto';
import {
  AuditLogRepository,
  normalizeActorRole,
  VALID_ACTOR_ROLES,
} from '../../src/modules/db/audit-log.repository';
import { PgPoolService } from '../../src/modules/db/pg-pool.service';

describe('AuditLogRepository [integration, real PG, V33]', () => {
  let pool: Pool;
  let schemaA: string;
  let schemaB: string;
  let repo: AuditLogRepository;
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

  // 用真 UUID — audit_log.actor_user_id / target_id 是 UUID 类型
  const actorUserId = randomUUID();
  const otherActorUserId = randomUUID();
  const targetCustomerId = randomUUID();
  const targetContractId = randomUUID();

  beforeAll(async () => {
    pool = getTestPool();
    schemaA = await createTestSchema('auditlog-a');
    schemaB = await createTestSchema('auditlog-b');

    pgService = new PgPoolService(mockConfig as any);
    repo = new AuditLogRepository(pgService);
  }, 30000);

  afterAll(async () => {
    await pgService.onModuleDestroy();
    await dropTestSchema(schemaA);
    await dropTestSchema(schemaB);
    await closeTestPool();
  });

  // ----------------------------------------------------------------
  // Case 1: log() 成功 — 全字段持久化
  // ----------------------------------------------------------------
  it('log() 成功 — INSERT 全字段 + JSONB before/after 序列化', async () => {
    await repo.log(schemaA, {
      actorUserId,
      actorRole: 'sales',
      action: 'customer.create',
      targetType: 'customer',
      targetId: targetCustomerId,
      before: null,
      after: { customerId: targetCustomerId, name: '张三', mobile: '139****1234' },
      ip: '192.168.1.1',
      userAgent: 'WeChatMP/8.0',
      requestId: 'req-001',
    });

    // 直查 PG 验证字段
    const rows = await runInSchema(schemaA, async (c) => {
      const r = await c.query<any>(
        `SELECT actor_user_id, actor_role, action, target_type, target_id,
                before, after, ip, user_agent, request_id
           FROM audit_log
           WHERE action = 'customer.create' AND request_id = 'req-001'`,
      );
      return r.rows;
    });
    expect(rows.length).toBe(1);
    expect(rows[0].actor_user_id).toBe(actorUserId);
    expect(rows[0].actor_role).toBe('sales');
    expect(rows[0].action).toBe('customer.create');
    expect(rows[0].target_type).toBe('customer');
    expect(rows[0].target_id).toBe(targetCustomerId);
    expect(rows[0].before).toBeNull();
    // PG JSONB 反序列化
    expect(rows[0].after).toEqual({
      customerId: targetCustomerId,
      name: '张三',
      mobile: '139****1234',
    });
    expect(rows[0].ip).toBe('192.168.1.1');
    expect(rows[0].user_agent).toBe('WeChatMP/8.0');
  });

  // ----------------------------------------------------------------
  // Case 2: log() fail-open — actor_role 非法枚举不抛错
  // ----------------------------------------------------------------
  it('log() fail-open — actor_role 非法（"invalid"）内部 catch + 不抛主流程', async () => {
    // 直传不合法的 actor_role，应不抛错（PG CHECK 违反 → repo 内部 catch + Logger.error）
    await expect(
      repo.log(schemaA, {
        actorUserId,
        actorRole: 'invalid' as any,
        action: 'test.invalid-role',
        targetType: 'customer',
        targetId: targetCustomerId,
        after: { x: 1 },
      }),
    ).resolves.toBeUndefined();

    // 应该没写入这条（CHECK 违反 ROLLBACK）
    const cnt = await repo.count(schemaA, { action: 'test.invalid-role' });
    expect(cnt).toBe(0);
  });

  // ----------------------------------------------------------------
  // Case 3: listRecent ORDER BY created_at DESC + LIMIT
  // ----------------------------------------------------------------
  it('listRecent ORDER BY created_at DESC + LIMIT 限制', async () => {
    // 灌 5 条
    for (let i = 0; i < 5; i++) {
      await repo.log(schemaA, {
        actorUserId,
        actorRole: 'admin',
        action: `test.list.${i}`,
        targetType: 'tenant',
        targetId: targetContractId,
        after: { idx: i },
      });
      // 让 created_at 有 1ms 差
      await new Promise((res) => setTimeout(res, 5));
    }

    const recent3 = await repo.listRecent(schemaA, 3);
    expect(recent3.length).toBe(3);
    // 单调递减 created_at
    for (let i = 1; i < recent3.length; i++) {
      expect(recent3[i - 1].createdAt!.getTime()).toBeGreaterThanOrEqual(
        recent3[i].createdAt!.getTime(),
      );
    }
  });

  // ----------------------------------------------------------------
  // Case 4: listByActor — actor_user_id 过滤
  // ----------------------------------------------------------------
  it('listByActor — 仅返回该 actor_user_id 的 entry', async () => {
    // 灌 1 条 otherActorUserId
    await repo.log(schemaA, {
      actorUserId: otherActorUserId,
      actorRole: 'boss',
      action: 'tenant.subscription.update',
      targetType: 'tenant',
      targetId: targetContractId,
      after: { plan: 'standard_1999' },
    });

    const items = await repo.listByActor(schemaA, otherActorUserId, 50);
    expect(items.length).toBe(1);
    expect(items[0].actorUserId).toBe(otherActorUserId);
    expect(items[0].action).toBe('tenant.subscription.update');
  });

  // ----------------------------------------------------------------
  // Case 5: listByTarget — (target_type, target_id) 过滤
  // ----------------------------------------------------------------
  it('listByTarget — 仅返回该 target 的变更历史', async () => {
    const items = await repo.listByTarget(schemaA, 'customer', targetCustomerId, 50);
    expect(items.length).toBeGreaterThanOrEqual(1);
    items.forEach((e) => {
      expect(e.targetType).toBe('customer');
      expect(e.targetId).toBe(targetCustomerId);
    });
  });

  // ----------------------------------------------------------------
  // Case 6: 自由组合过滤 + count
  // ----------------------------------------------------------------
  it('list 组合过滤 (actor + targetType + action) + count', async () => {
    const items = await repo.list(schemaA, {
      actorUserId,
      targetType: 'customer',
      action: 'customer.create',
    });
    expect(items.length).toBe(1);
    expect(items[0].action).toBe('customer.create');

    const c = await repo.count(schemaA, { actorUserId });
    expect(c).toBeGreaterThanOrEqual(5); // Case 3 灌 5 条 admin + Case 1 灌 1 条 sales
  });

  // ----------------------------------------------------------------
  // Case 7: PII 不在 repo 层 redact — JSONB 原样持久化
  // ----------------------------------------------------------------
  it('PII redact 在调用层做 — repo 不动 before/after JSONB', async () => {
    const sensitivePayload = {
      phone: '13900008888', // 明文 — 调用方未脱敏
      idNumber: '500232199003158888',
      token: 'jwt.fake.token',
    };
    await repo.log(schemaA, {
      actorUserId,
      actorRole: 'admin',
      action: 'pii.test',
      targetType: 'customer',
      targetId: targetCustomerId,
      after: sensitivePayload,
    });

    const rows = await runInSchema(schemaA, async (c) => {
      const r = await c.query<{ after: any }>(
        `SELECT after FROM audit_log WHERE action = 'pii.test'`,
      );
      return r.rows;
    });
    expect(rows.length).toBe(1);
    // PG 返回 JSONB 原样（调用方未脱敏 → repo 原样保存）
    expect(rows[0].after).toEqual(sensitivePayload);
  });

  // ----------------------------------------------------------------
  // Case 8: 跨 tenant 隔离 — schema A audit_log 不可在 schema B 查到
  // ----------------------------------------------------------------
  it('跨 tenant 隔离 — schema A 写入不可在 schema B 查到', async () => {
    // schema A 已灌入数据 (Case 1)
    const itemsA = await repo.listByTarget(schemaA, 'customer', targetCustomerId, 50);
    expect(itemsA.length).toBeGreaterThanOrEqual(1);

    // schema B 同 target_id 应空
    const itemsB = await repo.listByTarget(schemaB, 'customer', targetCustomerId, 50);
    expect(itemsB).toEqual([]);
  });

  // ----------------------------------------------------------------
  // Case 9: normalizeActorRole — fallback 'system'
  // ----------------------------------------------------------------
  it('normalizeActorRole — marketing/finance_admin/未知 → system fallback', async () => {
    expect(normalizeActorRole('admin')).toBe('admin');
    expect(normalizeActorRole('sales')).toBe('sales');
    expect(normalizeActorRole('marketing' as any)).toBe('system'); // 不在 ActorRole 内
    expect(normalizeActorRole('finance_admin' as any)).toBe('system');
    expect(normalizeActorRole('unknown_role')).toBe('system');
    expect(normalizeActorRole(null)).toBe('system');
    expect(normalizeActorRole(undefined)).toBe('system');
    expect(normalizeActorRole('')).toBe('system');

    // VALID_ACTOR_ROLES 应含所有合法
    expect(VALID_ACTOR_ROLES.has('admin')).toBe(true);
    expect(VALID_ACTOR_ROLES.has('platform_admin')).toBe(true);
    expect(VALID_ACTOR_ROLES.has('system')).toBe(true);
    expect(VALID_ACTOR_ROLES.has('sales_director')).toBe(true); // 历史 row 兼容
    expect((VALID_ACTOR_ROLES as ReadonlySet<string>).has('marketing')).toBe(false);
  });

  // ----------------------------------------------------------------
  // Case 10: schema drift 反例 — DROP actor_role 列 → log fail-open 吞错
  // ----------------------------------------------------------------
  it('schema drift 反例: DROP actor_role 列 → log fail-open 不抛主流程', async () => {
    const driftSchema = await createTestSchema('auditlog-drift');
    try {
      // DROP 列
      await runInSchema(driftSchema, async (c) => {
        await c.query(`ALTER TABLE ${driftSchema}.audit_log DROP COLUMN actor_role`);
      });

      // log() fail-open — PG 抛 42703 但 repo 内部 catch 不抛
      await expect(
        repo.log(driftSchema, {
          actorUserId,
          actorRole: 'admin',
          action: 'drift.test',
          targetType: 'customer',
          targetId: targetCustomerId,
          after: { x: 1 },
        }),
      ).resolves.toBeUndefined();
    } finally {
      await dropTestSchema(driftSchema);
    }
  });
});
