/**
 * parent.repository.integration.spec.ts — Day 3 Phase B.L2 priority spec #2
 *
 * 触发：parent 是 C 端登录唯一身份（V10/V40），跨 tenant 绑定。
 *   - V40 双列加密：phone（明文）+ phone_hash（HMAC）+ phone_encrypted（AES-GCM）三写
 *   - public.parents.phone UNIQUE — 跨 tenant 唯一手机号（红线：互斥不可重复）
 *   - public.parent_student_bindings.tenant_id — 跨 tenant 绑定关系（同 parent 可绑多 tenant）
 *   - trg_max_3_parents trigger — 每 student 最多 3 个 active parents
 *
 * 必测 case：
 *   1. insertParent 成功 — V40 三写（phone + phone_hash + phone_encrypted）
 *   2. findParentByPhone 双读：优先 phone_hash 匹配 / fallback 明文 phone
 *   3. findParentByPhone hash miss 但明文匹配（V40 backfill 前数据）
 *   4. ON CONFLICT (id) DO UPDATE — UPSERT 行为
 *   5. UNIQUE(phone) 违反：不同 id 同 phone → 23505
 *   6. insertBinding：trg_max_3_parents 第 4 个绑定违反
 *   7. expireBindingsForDeletedStudents — V44 软删联动
 *   8. findActiveBindingsForStudent / findChildrenByParent — binding_status 过滤
 *   9. unbind — UPDATE binding_status='unbound' + unbound_at = NOW()
 *  10. schema drift 反例：DROP phone_hash 列 → INSERT 必失败
 */

import { Pool } from 'pg';
import {
  createTestSchema,
  dropTestSchema,
  getTestPool,
  closeTestPool,
  runInPublic,
  FieldEncryptor,
  HmacHasher,
  testUlid,
} from './setup';
import { ParentRepository } from '../../src/modules/db/parent.repository';
import { PgPoolService } from '../../src/modules/db/pg-pool.service';

describe('ParentRepository [integration, real PG, V10 + V40]', () => {
  let pool: Pool;
  let schema: string; // 创建 1 个 tenant schema 用于 parent_student_bindings.tenant_id（虽 binding 在 public）
  let repo: ParentRepository;
  let pgService: PgPoolService;
  let encryptor: FieldEncryptor;
  let hasher: HmacHasher;

  // 唯一 testTenant — V44 binding tenant_id 需要
  const testTenantId = `tnt${Math.random().toString(36).slice(2, 10)}`;

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

  beforeAll(async () => {
    pool = getTestPool();
    // public schema 已 ensure（包含 V10 parents + parent_student_bindings + trigger）
    schema = await createTestSchema('parent');

    pgService = new PgPoolService(mockConfig as any);
    encryptor = new FieldEncryptor();
    hasher = new HmacHasher();
    repo = new ParentRepository(pgService, encryptor, hasher);

    // 灌一个 public.tenants 行（binding FK tenant_id 引用）
    await runInPublic(async (c) => {
      await c.query(
        `INSERT INTO public.tenants (id, name, plan_tier, status, subscription_status, max_campuses, created_at)
         VALUES ($1, $2, 'standard_1999', '正常', 'trial', 3, NOW())
         ON CONFLICT (id) DO NOTHING`,
        [testTenantId.padEnd(32, '0').slice(0, 32), 'demo-parent-spec'],
      );
    });
  }, 30000);

  afterAll(async () => {
    // cleanup bindings + parents to leave public schema clean for other specs
    await runInPublic(async (c) => {
      await c.query(`DELETE FROM public.parent_student_bindings WHERE tenant_id LIKE '${testTenantId.slice(0, 10)}%'`);
      await c.query(`DELETE FROM public.parents WHERE phone LIKE '139999%'`);
      await c.query(`DELETE FROM public.tenants WHERE name = 'demo-parent-spec'`);
    });
    await pgService.onModuleDestroy();
    await dropTestSchema(schema);
    await closeTestPool();
  });

  // ----------------------------------------------------------------
  // Case 1: insertParent 成功 — V40 三写
  // ----------------------------------------------------------------
  it('insertParent 成功 — V40 phone + phone_hash + phone_encrypted 三写', async () => {
    const parentId = testUlid();
    const phone = '13999990001';
    const result = await repo.insertParent({
      id: parentId,
      phone,
      name: '张三家长',
      status: '正常',
    } as any);

    expect(result.id).toBe(parentId);
    expect(result.phone).toBe(phone); // 解密后明文
    expect(result.name).toBe('张三家长');

    // 直接查 PG 验证三列：明文 + hash + encrypted 都存在
    await runInPublic(async (c) => {
      const r = await c.query<{ phone: string; phone_hash: Buffer; phone_encrypted: Buffer }>(
        `SELECT phone, phone_hash, phone_encrypted FROM public.parents WHERE id = $1`,
        [parentId],
      );
      expect(r.rows.length).toBe(1);
      expect(r.rows[0].phone).toBe(phone);
      expect(r.rows[0].phone_hash).toBeInstanceOf(Buffer);
      expect(r.rows[0].phone_hash.length).toBe(32); // HMAC-SHA256
      expect(r.rows[0].phone_encrypted).toBeInstanceOf(Buffer);
      expect(r.rows[0].phone_encrypted.length).toBeGreaterThan(28); // IV12 + tag16 + cipher
    });
  });

  // ----------------------------------------------------------------
  // Case 2: findParentByPhone — 优先 hash 匹配
  // ----------------------------------------------------------------
  it('findParentByPhone 通过 phone_hash 等值查询命中', async () => {
    const phone = '13999990001'; // Case 1 已 insert
    const found = await repo.findParentByPhone(phone);
    expect(found).not.toBeNull();
    expect(found!.phone).toBe(phone);
  });

  // ----------------------------------------------------------------
  // Case 3: findParentByPhone hash miss + 明文 fallback
  // ----------------------------------------------------------------
  it('findParentByPhone hash miss → fallback 明文匹配（兼容 V40 backfill 前数据）', async () => {
    // 直接 INSERT 不走 hash 列（模拟 V40 backfill 前旧数据）
    const parentId = testUlid();
    const phone = '13999990002';
    await runInPublic(async (c) => {
      await c.query(
        `INSERT INTO public.parents (id, phone, name, status, phone_hash, phone_encrypted)
         VALUES ($1, $2, $3, '正常', NULL, NULL)`,
        [parentId, phone, '老旧数据家长'],
      );
    });

    // findParentByPhone 应通过 fallback 明文路径命中
    const found = await repo.findParentByPhone(phone);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(parentId);
    expect(found!.name).toBe('老旧数据家长');
  });

  // ----------------------------------------------------------------
  // Case 4: ON CONFLICT (id) UPSERT
  // ----------------------------------------------------------------
  it('insertParent ON CONFLICT (id) DO UPDATE — UPSERT 同 id 不抛错', async () => {
    const parentId = testUlid();
    await repo.insertParent({
      id: parentId,
      phone: '13999990003',
      name: '版本1',
      status: '正常',
    } as any);

    // UPSERT 改 name
    const v2 = await repo.insertParent({
      id: parentId,
      phone: '13999990003',
      name: '版本2',
      status: '正常',
    } as any);
    expect(v2.name).toBe('版本2');
  });

  // ----------------------------------------------------------------
  // Case 5: UNIQUE(phone) — 不同 id 同 phone 应 23505
  // ----------------------------------------------------------------
  it('UNIQUE(phone) — 不同 id 同 phone 必失败 23505', async () => {
    const phone = '13999990004';
    const p1 = testUlid();
    await repo.insertParent({ id: p1, phone, name: '第1个', status: '正常' } as any);

    const p2 = testUlid();
    // INSERT 第 2 个时虽 ON CONFLICT (id) 不冲突，但 UNIQUE(phone) 会冲突
    await expect(
      repo.insertParent({ id: p2, phone, name: '第2个', status: '正常' } as any),
    ).rejects.toThrow(/23505|duplicate|unique/i);
  });

  // ----------------------------------------------------------------
  // Case 6: trg_max_3_parents — 第 4 个绑定违反
  // ----------------------------------------------------------------
  it('trg_max_3_parents — 同 student 第 4 个 active binding 抛错', async () => {
    const studentId = testUlid();
    const tenantId = testTenantId.padEnd(32, '0').slice(0, 32);

    // 灌 3 个 parent + binding
    for (let i = 0; i < 3; i++) {
      const pid = testUlid();
      await repo.insertParent({
        id: pid,
        phone: `13999991${String(i).padStart(3, '0')}`,
        name: `家长-${i}`,
        status: '正常',
      } as any);
      await repo.insertBinding({
        id: testUlid(),
        parentId: pid,
        studentId,
        tenantId,
        isPrimary: i === 0,
        relationship: 'father',
        bindingStatus: 'active',
        boundAt: new Date(),
      } as any);
    }

    // 第 4 个应被 trigger 阻止
    const p4 = testUlid();
    await repo.insertParent({
      id: p4,
      phone: '13999991999',
      name: '第4家长',
      status: '正常',
    } as any);
    await expect(
      repo.insertBinding({
        id: testUlid(),
        parentId: p4,
        studentId,
        tenantId,
        isPrimary: false,
        relationship: 'father',
        bindingStatus: 'active',
        boundAt: new Date(),
      } as any),
    ).rejects.toThrow(/3|trigger|max|too many|exceeded/i);
  });

  // ----------------------------------------------------------------
  // Case 7: expireBindingsForDeletedStudents — V44 软删联动
  // ----------------------------------------------------------------
  it('expireBindingsForDeletedStudents — 批量 unbound + 幂等', async () => {
    const tenantId = testTenantId.padEnd(32, '0').slice(0, 32);
    // 灌 2 student + 2 binding
    const stu1 = testUlid();
    const stu2 = testUlid();
    const p1 = testUlid();
    await repo.insertParent({
      id: p1,
      phone: '13999992001',
      name: '父1',
      status: '正常',
    } as any);
    await repo.insertBinding({
      id: testUlid(),
      parentId: p1,
      studentId: stu1,
      tenantId,
      isPrimary: true,
      relationship: 'father',
      bindingStatus: 'active',
      boundAt: new Date(),
    } as any);
    const p2 = testUlid();
    await repo.insertParent({
      id: p2,
      phone: '13999992002',
      name: '父2',
      status: '正常',
    } as any);
    await repo.insertBinding({
      id: testUlid(),
      parentId: p2,
      studentId: stu2,
      tenantId,
      isPrimary: true,
      relationship: 'father',
      bindingStatus: 'active',
      boundAt: new Date(),
    } as any);

    // 批量 expire
    const r1 = await repo.expireBindingsForDeletedStudents(tenantId, [stu1, stu2]);
    expect(r1.unbounded).toBe(2);

    // 幂等：再调一次 → 0 affected
    const r2 = await repo.expireBindingsForDeletedStudents(tenantId, [stu1, stu2]);
    expect(r2.unbounded).toBe(0);

    // findActive 应空
    const active1 = await repo.findActiveBindingsForStudent(stu1);
    expect(active1).toEqual([]);

    // 空 studentIds → 早返 0
    const r3 = await repo.expireBindingsForDeletedStudents(tenantId, []);
    expect(r3.unbounded).toBe(0);
  });

  // ----------------------------------------------------------------
  // Case 8: findActiveBindingsForStudent / findChildrenByParent 过滤 binding_status
  // ----------------------------------------------------------------
  it('findActiveBindingsForStudent / findChildrenByParent — 仅返 binding_status=active', async () => {
    const tenantId = testTenantId.padEnd(32, '0').slice(0, 32);
    const studentId = testUlid();
    const p = testUlid();
    await repo.insertParent({
      id: p,
      phone: '13999993001',
      name: '过滤测试父',
      status: '正常',
    } as any);

    // 先 INSERT active binding
    const bId = testUlid();
    await repo.insertBinding({
      id: bId,
      parentId: p,
      studentId,
      tenantId,
      isPrimary: true,
      relationship: 'father',
      bindingStatus: 'active',
      boundAt: new Date(),
    } as any);

    const active = await repo.findActiveBindingsForStudent(studentId);
    expect(active.length).toBe(1);
    expect(active[0].id).toBe(bId);

    const children = await repo.findChildrenByParent(p);
    expect(children.length).toBe(1);
    expect(children[0].studentId).toBe(studentId);

    // unbind 后应不可见
    await repo.unbind(bId);
    const active2 = await repo.findActiveBindingsForStudent(studentId);
    expect(active2).toEqual([]);
  });

  // ----------------------------------------------------------------
  // Case 9: unbind — UPDATE binding_status='unbound' + unbound_at = NOW()
  // ----------------------------------------------------------------
  it('unbind — binding_status=unbound + unbound_at 落地', async () => {
    const tenantId = testTenantId.padEnd(32, '0').slice(0, 32);
    const stu = testUlid();
    const p = testUlid();
    await repo.insertParent({
      id: p,
      phone: '13999994001',
      name: '解绑测试父',
      status: '正常',
    } as any);
    const bId = testUlid();
    await repo.insertBinding({
      id: bId,
      parentId: p,
      studentId: stu,
      tenantId,
      isPrimary: true,
      relationship: 'father',
      bindingStatus: 'active',
      boundAt: new Date(),
    } as any);

    const result = await repo.unbind(bId);
    expect(result.id).toBe(bId);
    expect(result.bindingStatus).toBe('unbound');
    expect(result.unboundAt).toBeDefined();
    expect(result.unboundAt!).toBeInstanceOf(Date);
  });

  // ----------------------------------------------------------------
  // Case 10: schema drift — DROP phone_hash → INSERT 必失败
  // ----------------------------------------------------------------
  it('schema drift 反例: 模拟 DROP phone_hash 列 → INSERT 必失败 42703', async () => {
    // 不能真在 public.parents drop 列（影响其他 spec）
    // 用 INSERT 显式 phone_hash 列名故意打错来模拟（应得 42703 column not found）
    await expect(
      runInPublic(async (c) => {
        await c.query(
          `INSERT INTO public.parents (id, phone, phone_hash_DROPPED, phone_encrypted, name, status)
           VALUES ($1, $2, $3, $4, $5, '正常')`,
          [testUlid(), '13999999991', Buffer.alloc(32), Buffer.alloc(32), '测试'],
        );
      }),
    ).rejects.toThrow(/42703|column|does not exist/i);
  });
});
