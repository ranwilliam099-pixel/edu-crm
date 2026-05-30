import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TeacherRepository } from './teacher.repository';
import { PgPoolService } from './pg-pool.service';
import { FieldEncryptor } from '../../common/crypto/field-encryptor';

describe('TeacherRepository (V28 archive + V34 字段加密双写双读)', () => {
  let repo: TeacherRepository;
  let pg: {
    tenantQuery: jest.Mock;
    query: jest.Mock;
    withClient: jest.Mock;
    transaction: jest.Mock;
  };
  let txClient: { query: jest.Mock };
  // V34 mock: 短确定 buffer 便于断言（不需真正加解密）
  let encryptor: { encrypt: jest.Mock; decrypt: jest.Mock };
  const MOCK_CIPHER = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);
  const MOCK_PHONE_PLAINTEXT = '13800000000';

  const TENANT = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const CAMPUS_A = 'campus_A_00000000000000000000A001';
  const TEACHER_A = 'teacherA00000000000000000000A001';
  const TEACHER_B = 'teacherB00000000000000000000A002';

  /**
   * V34: 默认 row 含 phone_encrypted = MOCK_CIPHER（双轨已就位的常态行）。
   * 测试可通过 overrides 覆写 phone / phone_encrypted 验证不同 fallback 路径。
   */
  const teacherRow = (
    overrides: Partial<{
      id: string;
      status: string;
      campus_id: string;
      name: string;
      phone: string | null;
      phone_encrypted: Buffer | null;
    }> = {},
  ) => ({
    id: overrides.id || TEACHER_A,
    campus_id: overrides.campus_id || CAMPUS_A,
    name: overrides.name || '王老师',
    phone: overrides.phone !== undefined ? overrides.phone : MOCK_PHONE_PLAINTEXT,
    phone_encrypted:
      overrides.phone_encrypted !== undefined
        ? overrides.phone_encrypted
        : MOCK_CIPHER,
    user_id: null,
    subjects: ['数学'],
    // V50 (2026-05-19 X1 拍板): hourly_price_yuan 列已物理删除 — 老师视图零财务字段
    status: overrides.status || '在职',
  });

  beforeEach(async () => {
    txClient = { query: jest.fn() };
    pg = {
      tenantQuery: jest.fn(),
      query: jest.fn(),
      withClient: jest.fn(),
      transaction: jest.fn().mockImplementation(async (fn: any) => fn(txClient)),
    };
    encryptor = {
      encrypt: jest.fn((plain: string | null | undefined) =>
        plain === null || plain === undefined ? null : MOCK_CIPHER,
      ),
      decrypt: jest.fn(() => MOCK_PHONE_PLAINTEXT),
    };
    const m = await Test.createTestingModule({
      providers: [
        TeacherRepository,
        { provide: PgPoolService, useValue: pg },
        { provide: FieldEncryptor, useValue: encryptor },
      ],
    }).compile();
    repo = m.get(TeacherRepository);
  });

  describe('archive (V28)', () => {
    it('归档老师 + 转关联学生 assigned_teacher_id 给同 campus 接棒老师', async () => {
      // findById
      pg.tenantQuery.mockResolvedValueOnce([teacherRow({ id: TEACHER_A })]);
      // 找接棒人（同 campus 其他在职老师）
      pg.tenantQuery.mockResolvedValueOnce([{ id: TEACHER_B, name: '李老师' }]);
      // 事务：UPDATE teachers / UPDATE students
      txClient.query
        .mockResolvedValueOnce({ rowCount: 1, rows: [teacherRow({ id: TEACHER_A, status: '归档' })] })
        .mockResolvedValueOnce({ rowCount: 7, rows: [] });
      const r = await repo.archive(TENANT, TEACHER_A, 'admin01');
      expect(r.teacher.status).toBe('归档');
      expect(r.transferToTeacherId).toBe(TEACHER_B);
      expect(r.transferToTeacherName).toBe('李老师');
      expect(r.studentsReassigned).toBe(7);
      // 事务被调用
      expect(pg.transaction).toHaveBeenCalledTimes(1);
      // students UPDATE 调用并写入 reason='老师归档'
      const studentsCall = txClient.query.mock.calls.find((c) =>
        typeof c[0] === 'string' && c[0].includes('UPDATE students'),
      );
      expect(studentsCall).toBeDefined();
      expect(studentsCall[0]).toContain('owner_change_reason');
    });

    it('同 campus 无其他在职老师 → students.assigned_teacher_id = NULL', async () => {
      pg.tenantQuery.mockResolvedValueOnce([teacherRow({ id: TEACHER_A })]);
      pg.tenantQuery.mockResolvedValueOnce([]); // 无候选
      txClient.query
        .mockResolvedValueOnce({ rowCount: 1, rows: [teacherRow({ id: TEACHER_A, status: '归档' })] })
        .mockResolvedValueOnce({ rowCount: 3, rows: [] });
      const r = await repo.archive(TENANT, TEACHER_A, 'admin01');
      expect(r.transferToTeacherId).toBeNull();
      expect(r.transferToTeacherName).toContain('无接棒人');
      expect(r.studentsReassigned).toBe(3);
      // students UPDATE params 第 2 个应为 null
      const studentsCall = txClient.query.mock.calls.find((c) =>
        typeof c[0] === 'string' && c[0].includes('UPDATE students'),
      );
      expect(studentsCall[1][1]).toBeNull();
    });

    it('已归档老师 → BadRequestException', async () => {
      pg.tenantQuery.mockResolvedValueOnce([teacherRow({ id: TEACHER_A, status: '归档' })]);
      await expect(repo.archive(TENANT, TEACHER_A, 'admin01')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('老师不存在 → NotFoundException', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await expect(repo.archive(TENANT, TEACHER_A, 'admin01')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('接棒人查询排除自己（id <> $2）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([teacherRow({ id: TEACHER_A })]);
      pg.tenantQuery.mockResolvedValueOnce([]);
      txClient.query
        .mockResolvedValueOnce({ rowCount: 1, rows: [teacherRow({ id: TEACHER_A, status: '归档' })] })
        .mockResolvedValueOnce({ rowCount: 0, rows: [] });
      await repo.archive(TENANT, TEACHER_A, 'admin01');
      const candidateCall = pg.tenantQuery.mock.calls[1];
      expect(candidateCall[1]).toContain('id <> $2');
      expect(candidateCall[2]).toEqual([CAMPUS_A, TEACHER_A]);
    });
  });

  describe('archive RBAC 边界 (V28 R2)', () => {
    const CAMPUS_OTHER = 'campus_OTHER000000000000000A099';

    it('admin (跨校) → 任意 campus 老师：✓', async () => {
      pg.tenantQuery.mockResolvedValueOnce([teacherRow({ campus_id: CAMPUS_OTHER })]);
      pg.tenantQuery.mockResolvedValueOnce([]);
      txClient.query
        .mockResolvedValueOnce({ rowCount: 1, rows: [teacherRow({ status: '归档' })] })
        .mockResolvedValueOnce({ rowCount: 0, rows: [] });
      await expect(
        repo.archive(TENANT, TEACHER_A, 'admin01', { role: 'admin', campusId: null }),
      ).resolves.toBeDefined();
    });

    it('boss → 同 campus 老师：✓', async () => {
      pg.tenantQuery.mockResolvedValueOnce([teacherRow({ campus_id: CAMPUS_A })]);
      pg.tenantQuery.mockResolvedValueOnce([]);
      txClient.query
        .mockResolvedValueOnce({ rowCount: 1, rows: [teacherRow({ status: '归档' })] })
        .mockResolvedValueOnce({ rowCount: 0, rows: [] });
      await expect(
        repo.archive(TENANT, TEACHER_A, 'boss01', { role: 'boss', campusId: CAMPUS_A }),
      ).resolves.toBeDefined();
    });

    it('boss → 跨 campus 老师：✗ BadRequest', async () => {
      pg.tenantQuery.mockResolvedValueOnce([teacherRow({ campus_id: CAMPUS_OTHER })]);
      await expect(
        repo.archive(TENANT, TEACHER_A, 'boss01', { role: 'boss', campusId: CAMPUS_A }),
      ).rejects.toThrow(/校长.*同校区老师/);
    });

    // Day 2 BLOCKER 4 (2026-05-19): SSOT §1「❌ hr 5/14 Wave 1 删」
    //   原 spec 验证 hr 可归档；删除 hr 角色后 hr 应抛 BadRequestException
    it('hr → 任意 campus 老师：✗ 无权（SSOT §1 hr 5/14 Wave 1 删）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([teacherRow({ campus_id: CAMPUS_OTHER })]);
      await expect(
        repo.archive(TENANT, TEACHER_A, 'hr01', { role: 'hr', campusId: null }),
      ).rejects.toThrow(/hr.*无老师归档权限/);
    });

    it('sales → 任意：✗ 无权', async () => {
      pg.tenantQuery.mockResolvedValueOnce([teacherRow()]);
      await expect(
        repo.archive(TENANT, TEACHER_A, 'sales01', { role: 'sales', campusId: CAMPUS_A }),
      ).rejects.toThrow(/sales.*无老师归档权限/);
    });
  });

  // =====================================================================
  // V34 字段加密双写双读 — A02-1
  // =====================================================================
  describe('V34 INSERT 双写 phone + phone_encrypted', () => {
    it('insert 一行带 phone → 调 encrypt 1 次 + SQL 含 phone_encrypted 列', async () => {
      pg.tenantQuery.mockResolvedValueOnce([teacherRow({ id: TEACHER_A })]);
      const teacher = {
        id: TEACHER_A,
        campusId: CAMPUS_A,
        name: '王老师',
        phone: MOCK_PHONE_PLAINTEXT,
        subjects: ['数学'],
        status: '在职' as const,
      };
      await repo.insert(TENANT, teacher, 'admin01');
      // encrypt 被调用 1 次 + 传入明文
      expect(encryptor.encrypt).toHaveBeenCalledTimes(1);
      expect(encryptor.encrypt).toHaveBeenCalledWith(MOCK_PHONE_PLAINTEXT);
      // SQL 含 phone_encrypted 列名 + params 含密文 buffer
      const [, sql, params] = pg.tenantQuery.mock.calls[0];
      expect(sql).toMatch(/phone_encrypted/);
      // params 顺序：id, campusId, name, phone, phone_encrypted, user_id, ...
      expect(params[3]).toBe(MOCK_PHONE_PLAINTEXT); // phone 明文
      expect(params[4]).toEqual(MOCK_CIPHER); // phone_encrypted Buffer
    });

    it('insert 无 phone（undefined）→ encrypt 收 null → params 全 null', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        teacherRow({ id: TEACHER_A, phone: null, phone_encrypted: null }),
      ]);
      const teacher = {
        id: TEACHER_A,
        campusId: CAMPUS_A,
        name: '王老师',
        subjects: ['数学'],
        status: '在职' as const,
      };
      await repo.insert(TENANT, teacher, 'admin01');
      expect(encryptor.encrypt).toHaveBeenCalledWith(null);
      const [, , params] = pg.tenantQuery.mock.calls[0];
      expect(params[3]).toBeNull(); // phone
      expect(params[4]).toBeNull(); // phone_encrypted
    });
  });

  describe('V34 SELECT 双读 phone_encrypted 优先', () => {
    it('findById 行带 phone_encrypted → 调 decrypt + Teacher.phone = 解密结果', async () => {
      pg.tenantQuery.mockResolvedValueOnce([teacherRow()]);
      const t = await repo.findById(TENANT, TEACHER_A);
      expect(encryptor.decrypt).toHaveBeenCalledTimes(1);
      expect(encryptor.decrypt).toHaveBeenCalledWith(MOCK_CIPHER);
      expect(t!.phone).toBe(MOCK_PHONE_PLAINTEXT);
    });

    it('findById 行 phone_encrypted=null → 不调 decrypt + Teacher.phone = 明文 fallback', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        teacherRow({ phone_encrypted: null, phone: '13911111111' }),
      ]);
      const t = await repo.findById(TENANT, TEACHER_A);
      expect(encryptor.decrypt).not.toHaveBeenCalled();
      expect(t!.phone).toBe('13911111111');
    });

    it('findById 行 phone_encrypted=null + phone=null → Teacher.phone = undefined', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        teacherRow({ phone_encrypted: null, phone: null }),
      ]);
      const t = await repo.findById(TENANT, TEACHER_A);
      expect(t!.phone).toBeUndefined();
    });

    it('findById decrypt 抛错 → logger.warn + fallback 明文 phone（不阻塞）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        teacherRow({ phone_encrypted: MOCK_CIPHER, phone: '13988888888' }),
      ]);
      encryptor.decrypt.mockImplementationOnce(() => {
        throw new Error('GCM auth tag mismatch');
      });
      const warnSpy = jest.spyOn(repo['logger'], 'warn').mockImplementation(() => undefined as any);
      const t = await repo.findById(TENANT, TEACHER_A);
      expect(t!.phone).toBe('13988888888');
      // 必须 warn 一次（且仅一次），消息匹配 V34-decrypt-fallback tag
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/V34-decrypt-fallback/));
      warnSpy.mockRestore();
    });

    it('listActiveInTenant 多行 → 每行解密 + 全部返回明文 phone', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        teacherRow({ id: TEACHER_A }),
        teacherRow({ id: TEACHER_B, phone: '13900000000' }),
      ]);
      // 第二次 decrypt 返回第二个号码
      encryptor.decrypt
        .mockReturnValueOnce(MOCK_PHONE_PLAINTEXT)
        .mockReturnValueOnce('13900000000');
      const list = await repo.listActiveInTenant(TENANT);
      expect(list).toHaveLength(2);
      expect(encryptor.decrypt).toHaveBeenCalledTimes(2);
      expect(list[0].phone).toBe(MOCK_PHONE_PLAINTEXT);
      expect(list[1].phone).toBe('13900000000');
    });

    it('SELECT 语句中包含 phone_encrypted 列（findById / list / listActive）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.findById(TENANT, TEACHER_A);
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.list(TENANT);
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.listActiveInTenant(TENANT);
      const sqls = pg.tenantQuery.mock.calls.map((c) => c[1] as string);
      sqls.forEach((sql) => {
        expect(sql).toMatch(/phone_encrypted/);
      });
    });
  });

  // ============================================================
  // Sprint B (2026-05-11) — findByUserId（teacher self-check 反查）
  // ============================================================
  describe('findByUserId (Sprint B self-check 反查)', () => {
    const USER_X = 'usr00000000000000000000000000U00X';

    it('user_id 命中 → 返回 Teacher（mapRow 走 phone 解密链）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        { ...teacherRow({ id: TEACHER_A }), user_id: USER_X },
      ]);
      const t = await repo.findByUserId(TENANT, USER_X);
      expect(t).not.toBeNull();
      expect(t!.id).toBe(TEACHER_A);
      expect(t!.userId).toBe(USER_X);
    });

    it('user_id 未命中（0 行）→ 返回 null', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      const t = await repo.findByUserId(TENANT, 'usr_no_match_xxxxxxxxxxxxxxxxxxxx');
      expect(t).toBeNull();
    });

    it('SQL 用 user_id = $1 + LIMIT 1（兜底多绑情况取最早一条）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.findByUserId(TENANT, USER_X);
      const [schema, sql, params] = pg.tenantQuery.mock.calls[0];
      expect(schema).toBe(TENANT);
      expect(sql).toMatch(/WHERE user_id = \$1/);
      expect(sql).toMatch(/LIMIT 1/);
      expect(params).toEqual([USER_X]);
    });
  });

  // ============================================================
  // V44 软删除 — filter 回归
  // 来源：2026-05-16 T12 spec / R1 audit P0-3
  // ============================================================
  describe('V44 软删除 filter 回归', () => {
    it('findById SQL 包含 deleted_at IS NULL（已软删教师返回 null）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.findById(TENANT, TEACHER_A);
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toMatch(/deleted_at IS NULL/);
    });

    it('findByUserId SQL 包含 deleted_at IS NULL', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.findByUserId(TENANT, 'usr00000000000000000000000000U00X');
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toMatch(/deleted_at IS NULL/);
    });

    it('listActiveInTenant SQL 包含 deleted_at IS NULL（与 status=在职 联合）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.listActiveInTenant(TENANT);
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain(`status = '在职'`);
      expect(sql).toContain('deleted_at IS NULL');
    });

    // 2026-05-30 #18: 校区看师生 — listActiveInTenant 可选 campusId 过滤
    describe('campusId 过滤 (#18)', () => {
      it('不传 campusId → 无 campus_id WHERE，无额外 params（向后兼容）', async () => {
        pg.tenantQuery.mockResolvedValueOnce([]);
        await repo.listActiveInTenant(TENANT);
        const [, sql, params] = pg.tenantQuery.mock.calls[0];
        expect(sql).not.toContain('campus_id = $');
        // 旧无参调用方：params 为空数组（无占位符）
        expect(params).toEqual([]);
      });

      it('传 campusId → 加 campus_id = $1 WHERE + 仍保留 status/deleted_at', async () => {
        pg.tenantQuery.mockResolvedValueOnce([]);
        await repo.listActiveInTenant(TENANT, { campusId: CAMPUS_A });
        const [, sql, params] = pg.tenantQuery.mock.calls[0];
        expect(sql).toContain('campus_id = $1');
        expect(sql).toContain(`status = '在职'`);
        expect(sql).toContain('deleted_at IS NULL');
        expect(params).toEqual([CAMPUS_A]);
      });
    });

    it('list SQL 包含 WHERE deleted_at IS NULL（分页列表）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.list(TENANT);
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toMatch(/WHERE deleted_at IS NULL/);
    });

    it('countInTenant SQL 包含 WHERE deleted_at IS NULL', async () => {
      pg.tenantQuery.mockResolvedValueOnce([{ count: '5' }]);
      const n = await repo.countInTenant(TENANT);
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toMatch(/WHERE deleted_at IS NULL/);
      expect(n).toBe(5);
    });

    it('archive 内查接棒人 SQL 含 deleted_at IS NULL（不转交给已软删教师）', async () => {
      // findById 拿目标教师
      pg.tenantQuery.mockResolvedValueOnce([teacherRow({ id: TEACHER_A })]);
      // candidates 查询
      pg.tenantQuery.mockResolvedValueOnce([{ id: TEACHER_B, name: '李老师' }]);
      // 事务内：UPDATE teachers RETURNING + UPDATE students RETURNING
      txClient.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [teacherRow({ id: TEACHER_A, status: '归档' })],
      });
      txClient.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

      await repo.archive(TENANT, TEACHER_A, 'op-id', {
        role: 'admin',
        campusId: CAMPUS_A,
      });

      const candidatesSql = pg.tenantQuery.mock.calls[1][1] as string;
      expect(candidatesSql).toMatch(/status = '在职' AND deleted_at IS NULL/);
    });
  });
});
