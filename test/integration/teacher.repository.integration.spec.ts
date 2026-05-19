/**
 * teacher.repository.integration.spec.ts — Day 2 Phase B.L2 真 PG 集成
 *
 * 触发：V50 (2026-05-19) 物理删 teachers.hourly_price_yuan 列
 *   单测 mock 永远抓不到「INSERT 仍含废弃字段 → column does not exist」类 drift
 *
 * 必测 case（X1 重构验证 + V34 双写）：
 *   1. V50 schema 不应有 hourly_price_yuan 列（DROP 已生效）
 *   2. INSERT teacher 不带 hourly_price_yuan 字段 — 成功
 *   3. schema drift 反例：如果 INSERT 含 hourly_price_yuan 必失败 (V50 真实场景)
 *   4. V34 双写：phone 明文 + phone_encrypted 双写一致性
 *   5. V34 双读：encrypted=NULL 时 fallback 明文 phone
 *   6. status CHECK constraint：非 '在职'/'请假'/'归档' 必拒
 */

import { Pool } from 'pg';
import {
  createTestSchema,
  dropTestSchema,
  getTestPool,
  closeTestPool,
  runInSchema,
  seedCampus,
  seedAdminUser,
  FieldEncryptor,
  testUlid,
} from './setup';
import { TeacherRepository } from '../../src/modules/db/teacher.repository';
import { PgPoolService } from '../../src/modules/db/pg-pool.service';

describe('TeacherRepository [integration, real PG, V50 DROP hourly_price_yuan]', () => {
  let pool: Pool;
  let schema: string;
  let repo: TeacherRepository;
  let pgService: PgPoolService;
  let encryptor: FieldEncryptor;
  let campusId: string;

  beforeAll(async () => {
    pool = getTestPool();
    schema = await createTestSchema('teacher');
    encryptor = new FieldEncryptor();

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
    pgService = new PgPoolService(mockConfig as any);
    repo = new TeacherRepository(pgService, encryptor);

    const campus = await seedCampus(schema);
    campusId = campus.id;
  }, 30000);

  afterAll(async () => {
    await pgService.onModuleDestroy();
    await dropTestSchema(schema);
    await closeTestPool();
  });

  // ----------------------------------------------------------------
  // Case 1: V50 schema 验证 — teachers 表不应有 hourly_price_yuan 列
  // ----------------------------------------------------------------
  it('V50 schema drift 验证：teachers 表不应有 hourly_price_yuan / hourly_rate_yuan 列', async () => {
    const cols = await runInSchema(schema, async (client) => {
      const q = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'teachers'`,
        [schema],
      );
      return q.rows.map((r) => r.column_name);
    });
    // V50 DROP 后既无 hourly_price_yuan 也无 V39 前的 hourly_rate_yuan
    expect(cols).not.toContain('hourly_price_yuan');
    expect(cols).not.toContain('hourly_rate_yuan');
    // 其他必须存在列
    expect(cols).toContain('id');
    expect(cols).toContain('name');
    expect(cols).toContain('phone');
    expect(cols).toContain('phone_encrypted'); // V34
    expect(cols).toContain('status');
    expect(cols).toContain('deleted_at'); // V44
  });

  // ----------------------------------------------------------------
  // Case 2: INSERT teacher 成功（V50 后不带 hourly_price_yuan 字段）
  // ----------------------------------------------------------------
  it('INSERT teacher 成功 — V50 后 V34 双写 phone + phone_encrypted', async () => {
    const teacherId = testUlid();
    const teacher = await repo.insert(
      schema,
      {
        id: teacherId,
        campusId,
        name: '王老师',
        phone: '13911112222',
        userId: null,
        subjects: ['数学', '物理'],
        bio: null,
        status: '在职',
      } as any,
      'admin-test',
    );

    expect(teacher.id).toBe(teacherId);
    expect(teacher.name).toBe('王老师');
    expect(teacher.phone).toBe('13911112222');

    // 校真 PG 行 — phone + phone_encrypted 双写
    const rows = await runInSchema(schema, async (client) => {
      const q = await client.query<{
        phone: string;
        phone_encrypted: Buffer | null;
      }>(
        `SELECT phone, phone_encrypted FROM teachers WHERE id = $1`,
        [teacherId],
      );
      return q.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].phone).toBe('13911112222');
    expect(rows[0].phone_encrypted).toBeInstanceOf(Buffer);
    expect(rows[0].phone_encrypted!.length).toBe(28 + 11); // IV+Tag+11 char plaintext
    expect(encryptor.decrypt(rows[0].phone_encrypted)).toBe('13911112222');
  });

  // ----------------------------------------------------------------
  // Case 3: V50 真实事故反例 — 应用层若残留 hourly_price_yuan 写入必失败
  //   模拟「forgotten code path」: 直接 SQL INSERT 写废弃列
  // ----------------------------------------------------------------
  it('V50 schema drift 反例：INSERT 含 hourly_price_yuan 列必报 column does not exist', async () => {
    const teacherId = testUlid();
    await expect(
      runInSchema(schema, async (client) => {
        await client.query(
          `INSERT INTO teachers
             (id, campus_id, name, hourly_price_yuan, status, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $6)`,
          [teacherId, campusId, '违规老师', 200.0, '在职', 'test'],
        );
      }),
    ).rejects.toThrow(/hourly_price_yuan|does not exist|42703/);
  });

  // ----------------------------------------------------------------
  // Case 4: V34 双读 fallback — phone_encrypted=NULL 时 mapRow 走 phone 明文
  // ----------------------------------------------------------------
  it('V34 双读 fallback：phone_encrypted=NULL 时 listActiveInTenant 返回明文 phone（V34 backfill 前数据兼容）', async () => {
    const teacherId = testUlid();
    // 直接 SQL INSERT 一行 phone_encrypted=NULL 的「旧数据」teacher
    await runInSchema(schema, async (client) => {
      await client.query(
        `INSERT INTO teachers
           (id, campus_id, name, phone, phone_encrypted, status, subjects, created_by, updated_by)
         VALUES ($1, $2, $3, $4, NULL, '在职', '[]'::jsonb, 'test', 'test')`,
        [teacherId, campusId, '旧数据老师', '13733334444'],
      );
    });

    const list = await repo.listActiveInTenant(schema);
    const t = list.find((x) => x.id === teacherId);
    expect(t).toBeDefined();
    expect(t!.name).toBe('旧数据老师');
    expect(t!.phone).toBe('13733334444'); // 走明文 fallback
  });

  // ----------------------------------------------------------------
  // Case 5: status CHECK constraint — 非合法枚举必报 23514
  // ----------------------------------------------------------------
  it('status CHECK constraint：非法值 INSERT 必报 23514', async () => {
    const teacherId = testUlid();
    await expect(
      runInSchema(schema, async (client) => {
        await client.query(
          `INSERT INTO teachers
             (id, campus_id, name, status, subjects, created_by, updated_by)
           VALUES ($1, $2, $3, $4, '[]'::jsonb, 'test', 'test')`,
          [teacherId, campusId, '错误状态', 'invalid_status'],
        );
      }),
    ).rejects.toThrow(/teachers_status_check|status|23514|check constraint/i);
  });

  // ----------------------------------------------------------------
  // Case 6: FK constraint — campus_id 不存在必报 23503
  // ----------------------------------------------------------------
  it('FK constraint：campus_id 不存在 INSERT 必报 23503', async () => {
    const teacherId = testUlid();
    const nonExistentCampusId = '99999' + '9'.repeat(27);
    await expect(
      repo.insert(
        schema,
        {
          id: teacherId,
          campusId: nonExistentCampusId,
          name: '无校区老师',
          phone: null,
          userId: null,
          subjects: [],
          bio: null,
          status: '在职',
        } as any,
        'admin-test',
      ),
    ).rejects.toThrow(/campus_id|foreign key|23503/);
  });
});
