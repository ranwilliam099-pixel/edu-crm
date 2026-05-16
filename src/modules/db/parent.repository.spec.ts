import { Test } from '@nestjs/testing';
import { ParentRepository } from './parent.repository';
import { PgPoolService } from './pg-pool.service';
import { FieldEncryptor } from '../../common/crypto/field-encryptor';
import { HmacHasher } from '../../common/crypto/hmac-hasher';
import { Parent } from '../parent/parent.service';

describe('ParentRepository (V40 phone hash+encrypted 双列加密)', () => {
  let repo: ParentRepository;
  let pg: { query: jest.Mock; tenantQuery: jest.Mock; transaction: jest.Mock };
  let encryptor: { encrypt: jest.Mock; decrypt: jest.Mock };
  let hasher: { hash: jest.Mock };

  const MOCK_CIPHER = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);
  const MOCK_HASH = Buffer.alloc(32, 0x55);
  const MOCK_PHONE = '13800138000';
  const PARENT_ID = 'parentA00000000000000000000A0001'; // 32 char

  /**
   * 标准 row：phone 明文 + phone_hash + phone_encrypted 三列均已就位（V40 双写后正常态）
   */
  const parentRow = (
    overrides: Partial<{
      id: string;
      phone: string | null;
      phone_hash: Buffer | null;
      phone_encrypted: Buffer | null;
      wechat_openid: string | null;
      name: string | null;
      status: string;
    }> = {},
  ) => ({
    id: overrides.id ?? PARENT_ID,
    phone: overrides.phone !== undefined ? overrides.phone : MOCK_PHONE,
    phone_hash: overrides.phone_hash !== undefined ? overrides.phone_hash : MOCK_HASH,
    phone_encrypted:
      overrides.phone_encrypted !== undefined ? overrides.phone_encrypted : MOCK_CIPHER,
    wechat_openid: overrides.wechat_openid !== undefined ? overrides.wechat_openid : 'oWxOpenid001',
    wechat_unionid: null,
    name: overrides.name !== undefined ? overrides.name : '张爸爸',
    avatar_url: null,
    status: overrides.status ?? 'active',
  });

  beforeEach(async () => {
    pg = {
      query: jest.fn(),
      tenantQuery: jest.fn(),
      transaction: jest.fn(),
    };
    encryptor = {
      encrypt: jest.fn((plain: string | null | undefined) =>
        plain === null || plain === undefined ? null : MOCK_CIPHER,
      ),
      decrypt: jest.fn(() => MOCK_PHONE),
    };
    hasher = {
      hash: jest.fn((plain: string | null | undefined) =>
        plain === null || plain === undefined ? null : MOCK_HASH,
      ),
    };

    const m = await Test.createTestingModule({
      providers: [
        ParentRepository,
        { provide: PgPoolService, useValue: pg },
        { provide: FieldEncryptor, useValue: encryptor },
        { provide: HmacHasher, useValue: hasher },
      ],
    }).compile();
    repo = m.get(ParentRepository);
  });

  describe('insertParent (V40 三写)', () => {
    it('INSERT 同时写 phone / phone_hash / phone_encrypted 三列', async () => {
      pg.query.mockResolvedValueOnce([parentRow()]);
      const parent: Parent = {
        id: PARENT_ID,
        phone: MOCK_PHONE,
        wechatOpenid: 'oWxOpenid001',
        name: '张爸爸',
        status: 'active',
      };
      const out = await repo.insertParent(parent);

      // hash + encrypt 都被调用
      expect(hasher.hash).toHaveBeenCalledWith(MOCK_PHONE);
      expect(encryptor.encrypt).toHaveBeenCalledWith(MOCK_PHONE);

      // SQL 同时写三列（命名）
      const sql = pg.query.mock.calls[0][0];
      expect(sql).toContain('phone');
      expect(sql).toContain('phone_hash');
      expect(sql).toContain('phone_encrypted');

      // params 顺序：id, phone, phone_hash, phone_encrypted, wechat_openid, ...
      const params = pg.query.mock.calls[0][1];
      expect(params[0]).toBe(PARENT_ID);
      expect(params[1]).toBe(MOCK_PHONE);
      expect(params[2]).toEqual(MOCK_HASH);
      expect(params[3]).toEqual(MOCK_CIPHER);

      // 返回的 phone 是解密后明文
      expect(out.phone).toBe(MOCK_PHONE);
      expect(out.id).toBe(PARENT_ID);
    });

    it('ON CONFLICT (id) DO UPDATE 同步更新 hash / encrypted', async () => {
      pg.query.mockResolvedValueOnce([parentRow()]);
      const parent: Parent = {
        id: PARENT_ID,
        phone: MOCK_PHONE,
        status: 'active',
      };
      await repo.insertParent(parent);
      const sql = pg.query.mock.calls[0][0];
      expect(sql).toContain('ON CONFLICT (id) DO UPDATE');
      expect(sql).toContain('phone = EXCLUDED.phone');
      expect(sql).toContain('phone_hash = EXCLUDED.phone_hash');
      expect(sql).toContain('phone_encrypted = EXCLUDED.phone_encrypted');
    });
  });

  describe('findParentByPhone (V40 双读：hash 优先 + 明文 fallback)', () => {
    it('hash 列查到 → 直接返回（不再查明文）', async () => {
      pg.query.mockResolvedValueOnce([parentRow()]); // hash 路径命中
      const out = await repo.findParentByPhone(MOCK_PHONE);
      expect(out).not.toBeNull();
      expect(out!.id).toBe(PARENT_ID);
      expect(out!.phone).toBe(MOCK_PHONE);

      // hasher 被调用
      expect(hasher.hash).toHaveBeenCalledWith(MOCK_PHONE);

      // 只查询了 1 次（hash 路径），未走 fallback
      expect(pg.query).toHaveBeenCalledTimes(1);
      const sql1 = pg.query.mock.calls[0][0];
      expect(sql1).toContain('WHERE phone_hash =');
    });

    it('hash 列 miss → fallback 走明文 WHERE phone', async () => {
      pg.query.mockResolvedValueOnce([]); // hash 路径 miss
      pg.query.mockResolvedValueOnce([parentRow({ phone_hash: null, phone_encrypted: null })]); // 明文路径命中（旧数据）
      const out = await repo.findParentByPhone(MOCK_PHONE);
      expect(out).not.toBeNull();
      expect(out!.phone).toBe(MOCK_PHONE); // mapRow 解密失败 → fallback 明文

      // 两次查询：一次 hash，一次明文
      expect(pg.query).toHaveBeenCalledTimes(2);
      expect(pg.query.mock.calls[0][0]).toContain('WHERE phone_hash =');
      expect(pg.query.mock.calls[1][0]).toContain('WHERE phone =');
    });

    it('两条路径都 miss → 返回 null', async () => {
      pg.query.mockResolvedValueOnce([]); // hash miss
      pg.query.mockResolvedValueOnce([]); // 明文 miss
      const out = await repo.findParentByPhone(MOCK_PHONE);
      expect(out).toBeNull();
      expect(pg.query).toHaveBeenCalledTimes(2);
    });

    it('查询参数：hash 路径用 Buffer，明文路径用 string', async () => {
      pg.query.mockResolvedValueOnce([]); // hash miss
      pg.query.mockResolvedValueOnce([]); // 明文 miss
      await repo.findParentByPhone(MOCK_PHONE);
      expect(pg.query.mock.calls[0][1]).toEqual([MOCK_HASH]);
      expect(pg.query.mock.calls[1][1]).toEqual([MOCK_PHONE]);
    });
  });

  describe('findParentById (V40 解密 fallback)', () => {
    it('phone_encrypted 存在 → 解密返回明文', async () => {
      pg.query.mockResolvedValueOnce([parentRow()]);
      const out = await repo.findParentById(PARENT_ID);
      expect(out).not.toBeNull();
      expect(encryptor.decrypt).toHaveBeenCalledWith(MOCK_CIPHER);
      expect(out!.phone).toBe(MOCK_PHONE);
    });

    it('phone_encrypted = NULL（旧数据未 backfill）→ fallback 明文 phone', async () => {
      pg.query.mockResolvedValueOnce([
        parentRow({ phone_encrypted: null, phone: '13911111111' }),
      ]);
      const out = await repo.findParentById(PARENT_ID);
      expect(out).not.toBeNull();
      // decrypt 不会被调用（encrypted 为 null）
      expect(encryptor.decrypt).not.toHaveBeenCalled();
      expect(out!.phone).toBe('13911111111');
    });

    it('decrypt 抛错 → fail-open fallback 明文 + 不抛错', async () => {
      encryptor.decrypt.mockImplementationOnce(() => {
        throw new Error('AuthTag mismatch');
      });
      pg.query.mockResolvedValueOnce([parentRow({ phone: '13922222222' })]);
      const out = await repo.findParentById(PARENT_ID);
      expect(out).not.toBeNull();
      expect(out!.phone).toBe('13922222222'); // 走明文 fallback
    });

    it('行不存在 → 返回 null', async () => {
      pg.query.mockResolvedValueOnce([]);
      const out = await repo.findParentById(PARENT_ID);
      expect(out).toBeNull();
    });
  });

  describe('SELECT 字段命名（确保不会漏读 hash/encrypted 列）', () => {
    it('findParentById SELECT 包含 phone_hash + phone_encrypted', async () => {
      pg.query.mockResolvedValueOnce([parentRow()]);
      await repo.findParentById(PARENT_ID);
      const sql = pg.query.mock.calls[0][0];
      expect(sql).toContain('phone_hash');
      expect(sql).toContain('phone_encrypted');
    });

    it('findParentByPhone hash 路径 SELECT 包含 phone_hash + phone_encrypted', async () => {
      pg.query.mockResolvedValueOnce([parentRow()]);
      await repo.findParentByPhone(MOCK_PHONE);
      const sql = pg.query.mock.calls[0][0];
      expect(sql).toContain('phone_hash');
      expect(sql).toContain('phone_encrypted');
    });
  });

  describe('binding 操作（V40 不涉及，保持原行为）', () => {
    it('insertBinding 写表 + 触发器兜底（应用层不重复查 3 上限）', async () => {
      const bindingRow = {
        id: 'bndId00000000000000000000000001',
        parent_id: PARENT_ID,
        student_id: 'studId00000000000000000000000001',
        tenant_id: 'tnt00000000000000000000000000A1',
        is_primary: true,
        relationship: 'father',
        binding_status: 'active',
        bound_at: new Date('2026-05-13T00:00:00Z'),
        unbound_at: null,
      };
      pg.query.mockResolvedValueOnce([bindingRow]);
      const out = await repo.insertBinding({
        id: bindingRow.id,
        parentId: bindingRow.parent_id,
        studentId: bindingRow.student_id,
        tenantId: bindingRow.tenant_id,
        isPrimary: true,
        relationship: 'father',
        bindingStatus: 'active',
        boundAt: bindingRow.bound_at,
      });
      expect(out.id).toBe(bindingRow.id);
      expect(out.isPrimary).toBe(true);
    });

    it('findChildrenByParent 只取 active 绑定', async () => {
      pg.query.mockResolvedValueOnce([]);
      await repo.findChildrenByParent(PARENT_ID);
      const sql = pg.query.mock.calls[0][0];
      expect(sql).toContain('binding_status =');
      expect(sql).toMatch(/['"]active['"]/);
    });
  });

  // ============================================================
  // V44 软删除联动 — expireBindingsForDeletedStudents
  // 来源：2026-05-16 T12 spec §3.3 §4 / R1 audit P0-3
  // ============================================================
  describe('expireBindingsForDeletedStudents (V44 软删除联动)', () => {
    const TENANT_ID = 'tnt00000000000000000000000000A1';
    const STUDENT_1 = 'stu00000000000000000000000000001';
    const STUDENT_2 = 'stu00000000000000000000000000002';

    it('独立连接（无 client）→ pg.query 写 + 返回 unbounded 行数', async () => {
      pg.query.mockResolvedValueOnce([{ id: 'b1' }, { id: 'b2' }]);
      const r = await repo.expireBindingsForDeletedStudents(TENANT_ID, [STUDENT_1, STUDENT_2]);
      expect(r.unbounded).toBe(2);
      const [sql, params] = pg.query.mock.calls[0];
      expect(sql).toContain('UPDATE public.parent_student_bindings');
      expect(sql).toContain(`binding_status = 'unbound'`);
      expect(sql).toContain('unbound_at = COALESCE(unbound_at, NOW())'); // 幂等保留首次时间
      expect(sql).toContain('student_id = ANY($1::varchar[])');
      expect(sql).toContain('tenant_id = $2');
      expect(sql).toContain(`binding_status = 'active'`);
      expect(params).toEqual([[STUDENT_1, STUDENT_2], TENANT_ID]);
    });

    it('同事务（传 client）→ 不调 pg.query，调 client.query', async () => {
      const client = { query: jest.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'b1' }] }) };
      const r = await repo.expireBindingsForDeletedStudents(TENANT_ID, [STUDENT_1], client as any);
      expect(r.unbounded).toBe(1);
      expect(pg.query).not.toHaveBeenCalled();
      expect(client.query).toHaveBeenCalledTimes(1);
    });

    it('空 studentIds → 直接返回 0，不发 SQL', async () => {
      const r = await repo.expireBindingsForDeletedStudents(TENANT_ID, []);
      expect(r.unbounded).toBe(0);
      expect(pg.query).not.toHaveBeenCalled();
    });

    it('空 tenantId → 直接返回 0，不发 SQL', async () => {
      const r = await repo.expireBindingsForDeletedStudents('', [STUDENT_1]);
      expect(r.unbounded).toBe(0);
      expect(pg.query).not.toHaveBeenCalled();
    });

    it('同 tenant + 同 student 重复调（cron 兜底）→ 已 unbound 行不再变化（WHERE binding_status=active 兜底幂等）', async () => {
      // 二次调用 0 行受影响
      pg.query.mockResolvedValueOnce([]);
      const r = await repo.expireBindingsForDeletedStudents(TENANT_ID, [STUDENT_1]);
      expect(r.unbounded).toBe(0);
      const sql = pg.query.mock.calls[0][0];
      expect(sql).toContain(`binding_status = 'active'`);
    });
  });
});
