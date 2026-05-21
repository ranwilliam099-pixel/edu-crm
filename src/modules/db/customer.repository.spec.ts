import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { CustomerRepository } from './customer.repository';
import { PgPoolService } from './pg-pool.service';
import { FieldEncryptor } from '../../common/crypto/field-encryptor';
import { HmacHasher } from '../../common/crypto/hmac-hasher';

/**
 * CustomerRepository spec — V25 销售客户 + V34 字段加密双写双读（A02-2）
 *                                          + V41 customers.primary_mobile 三写（A02-4）
 *
 * 2026-05-11 新建（A02-2）：覆盖
 *   - createWithOpportunity：INSERT 时 phone 明文 + phone_encrypted 密文双写
 *   - mapCustomerRow：SELECT 时优先 decrypt phone_encrypted / wechat_encrypted
 *   - decrypt 失败 → logger.warn + fallback 明文（fail-open）
 *   - claim / release / markLost 验证 RETURNING * 经 mapCustomerRow 后字段透传
 *
 * 2026-05-13 扩充（A02-4）：覆盖
 *   - createWithOpportunity 写 customers 表三列（primary_mobile + *_hash + *_encrypted）
 *   - HmacHasher 注入校验（与 ParentRepository V40 同模式）
 */
describe('CustomerRepository (V25 + V34 字段加密双写双读 + V41 customers.primary_mobile 三写)', () => {
  let repo: CustomerRepository;
  let pg: {
    tenantQuery: jest.Mock;
    query: jest.Mock;
    withClient: jest.Mock;
    transaction: jest.Mock;
  };
  let txClient: { query: jest.Mock };
  let encryptor: { encrypt: jest.Mock; decrypt: jest.Mock };
  let hasher: { hash: jest.Mock };

  const MOCK_CIPHER_PHONE = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0x01]);
  const MOCK_CIPHER_WECHAT = Buffer.from([0x11, 0x22, 0x33, 0x44, 0x02]);
  const MOCK_HASH_MOBILE = Buffer.alloc(32, 0x55);
  const MOCK_PHONE_PLAIN = '13800001234';
  const MOCK_WECHAT_PLAIN = 'wx_user_abc';

  const TENANT = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const CAMPUS_A = 'campus_A_00000000000000000000A001';
  const SALES_A = 'salesA00000000000000000000000A001';
  const CUSTOMER_ID = 'cust00000000000000000000000C0001';
  const OPPORTUNITY_ID = 'oppo00000000000000000000000O0001';
  const STUDENT_ID = 'stud00000000000000000000000S0001';

  /**
   * 默认 row 行：phone_encrypted + wechat_encrypted 已就位（V34 后常态）
   * 测试可通过 overrides 覆写以验证 fallback 路径
   */
  const oppoRow = (
    overrides: Partial<{
      id: string;
      student_id: string;
      phone: string | null;
      phone_encrypted: Buffer | null;
      wechat: string | null;
      wechat_encrypted: Buffer | null;
      owner_user_id: string | null;
      stage: string;
      source: string | null;
    }> = {},
  ) => ({
    id: overrides.id || OPPORTUNITY_ID,
    student_id: overrides.student_id || STUDENT_ID,
    student_name: '王同学',
    grade_or_age: '小学三年级',
    intended_subject: '数学',
    owner_user_id: overrides.owner_user_id !== undefined ? overrides.owner_user_id : SALES_A,
    stage: overrides.stage || '初步接触',
    source: overrides.source !== undefined ? overrides.source : '销售自建',
    phone: overrides.phone !== undefined ? overrides.phone : MOCK_PHONE_PLAIN,
    phone_encrypted:
      overrides.phone_encrypted !== undefined ? overrides.phone_encrypted : MOCK_CIPHER_PHONE,
    wechat: overrides.wechat !== undefined ? overrides.wechat : MOCK_WECHAT_PLAIN,
    wechat_encrypted:
      overrides.wechat_encrypted !== undefined ? overrides.wechat_encrypted : MOCK_CIPHER_WECHAT,
    intent_level: '中',
    urgent: false,
    note: null,
    entered_pool_at: null,
    enter_pool_reason: null,
    last_contact_at: new Date('2026-05-11T03:00:00Z'),
    signed_at: null,
    lost_reason: null,
    campus_id: CAMPUS_A,
    created_at: new Date('2026-05-10T00:00:00Z'),
    updated_at: new Date('2026-05-11T00:00:00Z'),
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
      encrypt: jest.fn((plain: string | null | undefined) => {
        if (plain === null || plain === undefined) return null;
        // 简单 mock：phone-like → MOCK_CIPHER_PHONE；wx-like → MOCK_CIPHER_WECHAT；else 通用 cipher
        if (typeof plain === 'string' && /^1\d{10}$/.test(plain)) return MOCK_CIPHER_PHONE;
        if (typeof plain === 'string' && plain.startsWith('wx_')) return MOCK_CIPHER_WECHAT;
        return Buffer.from([0xff]);
      }),
      // 默认 decrypt 通用响应；test case 可 mockReturnValueOnce 覆写
      decrypt: jest.fn((cipher: Buffer) => {
        if (cipher === MOCK_CIPHER_PHONE) return MOCK_PHONE_PLAIN;
        if (cipher === MOCK_CIPHER_WECHAT) return MOCK_WECHAT_PLAIN;
        return MOCK_PHONE_PLAIN; // fallback
      }),
    };
    hasher = {
      hash: jest.fn((plain: string | null | undefined) =>
        plain === null || plain === undefined ? null : MOCK_HASH_MOBILE,
      ),
    };
    const m = await Test.createTestingModule({
      providers: [
        CustomerRepository,
        { provide: PgPoolService, useValue: pg },
        { provide: FieldEncryptor, useValue: encryptor },
        { provide: HmacHasher, useValue: hasher },
      ],
    }).compile();
    repo = m.get(CustomerRepository);
  });

  // =====================================================================
  // V34 INSERT 双写 phone + phone_encrypted（A02-2）
  //   + V41 INSERT 三写 customers.primary_mobile (A02-4)
  // =====================================================================
  describe('V34 + V41 createWithOpportunity 三写 customers + 双写 opportunities', () => {
    it('销售即时建客户（含 student）→ V41 customers 三写 + V34 opportunity 双写', async () => {
      // 3 个 INSERT 顺序：customers, students, opportunities
      txClient.query
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // customers
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // students
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // opportunities

      const r = await repo.createWithOpportunity(TENANT, {
        customerId: CUSTOMER_ID,
        opportunityId: OPPORTUNITY_ID,
        parentName: '王爸爸',
        primaryMobile: MOCK_PHONE_PLAIN,
        campusId: CAMPUS_A,
        ownerSalesId: SALES_A,
        studentId: STUDENT_ID,
        studentName: '王同学',
        gradeOrAge: '小学三年级',
        intendedSubject: '数学',
      });

      expect(r.customerId).toBe(CUSTOMER_ID);
      expect(r.opportunityId).toBe(OPPORTUNITY_ID);
      expect(r.studentId).toBe(STUDENT_ID);

      // V41: hash 调用 1 次（customers.primary_mobile）
      expect(hasher.hash).toHaveBeenCalledTimes(1);
      expect(hasher.hash).toHaveBeenCalledWith(MOCK_PHONE_PLAIN);

      // encrypt 调用 2 次：V41 customers.primary_mobile + V34 opportunities.phone
      expect(encryptor.encrypt).toHaveBeenCalledTimes(2);
      expect(encryptor.encrypt).toHaveBeenNthCalledWith(1, MOCK_PHONE_PLAIN);
      expect(encryptor.encrypt).toHaveBeenNthCalledWith(2, MOCK_PHONE_PLAIN);

      // V41 customers INSERT 的 SQL 含 primary_mobile_hash + primary_mobile_encrypted 列
      const customersCall = txClient.query.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO customers'),
      );
      expect(customersCall).toBeDefined();
      expect(customersCall![0]).toMatch(/primary_mobile_hash/);
      expect(customersCall![0]).toMatch(/primary_mobile_encrypted/);
      // 2026-05-21 V55 加 parent_gender 列后 params 顺序：
      //   customerId, parentName, parentGender, primary_mobile,
      //   primary_mobile_hash, primary_mobile_encrypted, campusId, ownerSalesId
      const cParams = customersCall![1];
      expect(cParams[0]).toBe(CUSTOMER_ID);
      expect(cParams[1]).toBe('王爸爸');
      expect(cParams[2]).toBeNull(); // parentGender 未传 → null（V55）
      expect(cParams[3]).toBe(MOCK_PHONE_PLAIN); // primary_mobile 明文
      expect(cParams[4]).toEqual(MOCK_HASH_MOBILE); // primary_mobile_hash
      expect(cParams[5]).toEqual(MOCK_CIPHER_PHONE); // primary_mobile_encrypted
      expect(cParams[6]).toBe(CAMPUS_A);
      expect(cParams[7]).toBe(SALES_A);

      // V34 opportunity INSERT 的 SQL 含 phone_encrypted 列（原 A02-2 不变）
      const oppoCall = txClient.query.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO opportunities'),
      );
      expect(oppoCall).toBeDefined();
      expect(oppoCall![0]).toMatch(/phone_encrypted/);
      // params 顺序：id, student_id, stage, ownerSalesId, campus_id, source, phone, phone_encrypted, note
      const params = oppoCall![1];
      expect(params[6]).toBe(MOCK_PHONE_PLAIN); // phone 明文
      expect(params[7]).toEqual(MOCK_CIPHER_PHONE); // phone_encrypted Buffer
    });

    it('销售即时建客户（无 student）→ V41 customers 三写 + 不写 opportunity', async () => {
      txClient.query.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // 只有 customers

      const r = await repo.createWithOpportunity(TENANT, {
        customerId: CUSTOMER_ID,
        opportunityId: OPPORTUNITY_ID,
        parentName: '王爸爸',
        primaryMobile: MOCK_PHONE_PLAIN,
        campusId: CAMPUS_A,
        ownerSalesId: SALES_A,
      });

      expect(r.studentId).toBeNull();
      expect(r.opportunityId).toBe(''); // 无 student → opportunity 跳过 → 返回空字符串

      // V41 customers 仍三写 → hash + encrypt 各 1 次
      expect(hasher.hash).toHaveBeenCalledTimes(1);
      expect(encryptor.encrypt).toHaveBeenCalledTimes(1);

      // customers SQL 含三列
      const customersCall = txClient.query.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO customers'),
      );
      expect(customersCall).toBeDefined();
      expect(customersCall![0]).toMatch(/primary_mobile_hash/);
      expect(customersCall![0]).toMatch(/primary_mobile_encrypted/);
    });

    it('入参非法 → 提前抛 BadRequest，不进事务、不 hash、不 encrypt', async () => {
      await expect(
        repo.createWithOpportunity(TENANT, {
          customerId: CUSTOMER_ID,
          opportunityId: OPPORTUNITY_ID,
          parentName: '王爸爸',
          primaryMobile: '123', // 非合法手机号
          campusId: CAMPUS_A,
          ownerSalesId: SALES_A,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(hasher.hash).not.toHaveBeenCalled();
      expect(encryptor.encrypt).not.toHaveBeenCalled();
      expect(pg.transaction).not.toHaveBeenCalled();
    });
  });

  // =====================================================================
  // V34 SELECT 双读：mapCustomerRow 解密 phone_encrypted / wechat_encrypted（A02-2）
  // =====================================================================
  describe('V34 mapCustomerRow 双读：phone_encrypted / wechat_encrypted 优先', () => {
    it('findById 行含 phone_encrypted + wechat_encrypted → 各 decrypt 1 次 + 返回明文', async () => {
      pg.tenantQuery.mockResolvedValueOnce([oppoRow()]);
      const c = await repo.findById(TENANT, OPPORTUNITY_ID);
      expect(c).not.toBeNull();
      expect(c!.phone).toBe(MOCK_PHONE_PLAIN);
      expect(c!.wechat).toBe(MOCK_WECHAT_PLAIN);
      // 2 次 decrypt（phone + wechat）
      expect(encryptor.decrypt).toHaveBeenCalledTimes(2);
      expect(encryptor.decrypt).toHaveBeenCalledWith(MOCK_CIPHER_PHONE);
      expect(encryptor.decrypt).toHaveBeenCalledWith(MOCK_CIPHER_WECHAT);
    });

    it('findById 行 phone_encrypted=null / wechat_encrypted=null → 不 decrypt + fallback 明文', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        oppoRow({
          phone_encrypted: null,
          phone: '13911112222',
          wechat_encrypted: null,
          wechat: 'wx_fallback',
        }),
      ]);
      const c = await repo.findById(TENANT, OPPORTUNITY_ID);
      expect(encryptor.decrypt).not.toHaveBeenCalled();
      expect(c!.phone).toBe('13911112222');
      expect(c!.wechat).toBe('wx_fallback');
    });

    it('findById 行 phone_encrypted=null + phone=null → Customer.phone = null（旧空字段）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        oppoRow({
          phone_encrypted: null,
          phone: null,
          wechat_encrypted: null,
          wechat: null,
        }),
      ]);
      const c = await repo.findById(TENANT, OPPORTUNITY_ID);
      expect(c!.phone).toBeNull();
      expect(c!.wechat).toBeNull();
    });

    it('findById decrypt 抛错 → logger.warn + fallback 明文（不阻塞 fail-open）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        oppoRow({
          phone_encrypted: MOCK_CIPHER_PHONE,
          phone: '13988889999',
          wechat_encrypted: MOCK_CIPHER_WECHAT,
          wechat: 'wx_origin',
        }),
      ]);
      encryptor.decrypt
        .mockImplementationOnce(() => {
          throw new Error('GCM auth tag mismatch (phone)');
        })
        .mockImplementationOnce(() => {
          throw new Error('GCM auth tag mismatch (wechat)');
        });
      const warnSpy = jest
        .spyOn(repo['logger'], 'warn')
        .mockImplementation(() => undefined as any);
      const c = await repo.findById(TENANT, OPPORTUNITY_ID);
      expect(c!.phone).toBe('13988889999');
      expect(c!.wechat).toBe('wx_origin');
      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(warnSpy.mock.calls[0][0]).toMatch(/V34-decrypt-fallback/);
      expect(warnSpy.mock.calls[0][0]).toMatch(/phone_encrypted/);
      expect(warnSpy.mock.calls[1][0]).toMatch(/wechat_encrypted/);
      warnSpy.mockRestore();
    });

    it('listMine 多行 → 每行各 decrypt 2 次（phone+wechat）+ 返回明文', async () => {
      pg.tenantQuery.mockResolvedValueOnce([oppoRow({ id: 'oppo1' }), oppoRow({ id: 'oppo2' })]);
      const list = await repo.listMine(TENANT, SALES_A);
      expect(list).toHaveLength(2);
      // 2 行 × 2 字段 = 4 次 decrypt
      expect(encryptor.decrypt).toHaveBeenCalledTimes(4);
      list.forEach((c) => {
        expect(c.phone).toBe(MOCK_PHONE_PLAIN);
        expect(c.wechat).toBe(MOCK_WECHAT_PLAIN);
      });
    });

    it('listPool / listAllForBoss / findById SELECT 不需 explicit phone_encrypted 列名（o.* 自动覆盖）', async () => {
      // 三个 list 的 SELECT 都用 o.* 通配，新加的 BYTEA 列自动包含在结果中
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.listPool(TENANT);
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.listAllForBoss(TENANT);
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.findById(TENANT, OPPORTUNITY_ID);
      const sqls = pg.tenantQuery.mock.calls.map((c) => c[1] as string);
      sqls.forEach((sql) => {
        // 确保 SELECT o.* 仍然存在（这样 PG 会返回 phone_encrypted/wechat_encrypted 列）
        expect(sql).toMatch(/SELECT o\.\*/);
      });
    });

    it('claim 后 RETURNING * 经 mapCustomerRow → 解密返回明文 phone/wechat', async () => {
      // 1) cnt 查询返回 0（未到上限）
      txClient.query.mockResolvedValueOnce({ rows: [{ cnt: '0' }] });
      // 2) UPDATE opportunities RETURNING *
      txClient.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [oppoRow({ owner_user_id: SALES_A })],
      });
      // 3) INSERT customer_follow_log
      txClient.query.mockResolvedValueOnce({ rowCount: 1, rows: [] });

      const c = await repo.claim(TENANT, OPPORTUNITY_ID, SALES_A, '销售小王');
      expect(c.phone).toBe(MOCK_PHONE_PLAIN);
      expect(c.wechat).toBe(MOCK_WECHAT_PLAIN);
      expect(c.ownerUserId).toBe(SALES_A);
      expect(encryptor.decrypt).toHaveBeenCalledTimes(2); // phone + wechat
    });

    it('claim 失败（已被占用）→ ConflictException + 不调 decrypt', async () => {
      txClient.query.mockResolvedValueOnce({ rows: [{ cnt: '0' }] });
      txClient.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
      // 二次 check：customer 存在但被占用
      txClient.query.mockResolvedValueOnce({ rows: [{ owner_user_id: 'other-sales' }] });
      await expect(repo.claim(TENANT, OPPORTUNITY_ID, SALES_A, '销售小王')).rejects.toThrow(
        ConflictException,
      );
      expect(encryptor.decrypt).not.toHaveBeenCalled();
    });

    it('claim 上限达 50 → ConflictException POOL_LIMIT_REACHED', async () => {
      txClient.query.mockResolvedValueOnce({ rows: [{ cnt: '50' }] });
      await expect(repo.claim(TENANT, OPPORTUNITY_ID, SALES_A, '销售小王')).rejects.toThrow(
        /POOL_LIMIT_REACHED/,
      );
    });

    it('findById 不存在 → 返回 null + 0 次 decrypt', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      const c = await repo.findById(TENANT, OPPORTUNITY_ID);
      expect(c).toBeNull();
      expect(encryptor.decrypt).not.toHaveBeenCalled();
    });
  });

  // =====================================================================
  // 业务行为残留 sanity（确保改造不破坏 V25 业务）
  // =====================================================================
  describe('V25 业务行为 sanity（不被 V34 加密改造影响）', () => {
    it('markLost 校验失单原因白名单', async () => {
      await expect(
        repo.markLost(TENANT, OPPORTUNITY_ID, SALES_A, '销售小王', '非法原因'),
      ).rejects.toThrow(/lost_reason must be one of/);
    });

    it('markLost 成功 → stage=已失单 + Customer.phone/wechat 解密透传', async () => {
      // UPDATE opportunities RETURNING *
      txClient.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [oppoRow({ stage: '已失单' })],
      });
      // INSERT customer_follow_log
      txClient.query.mockResolvedValueOnce({ rowCount: 1, rows: [] });

      const c = await repo.markLost(TENANT, OPPORTUNITY_ID, SALES_A, '销售小王', '价格高');
      expect(c.stage).toBe('已失单');
      expect(c.phone).toBe(MOCK_PHONE_PLAIN);
      expect(c.wechat).toBe(MOCK_WECHAT_PLAIN);
    });

    it('markLost 客户未归属当前销售 → NotFoundException', async () => {
      txClient.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
      await expect(
        repo.markLost(TENANT, OPPORTUNITY_ID, SALES_A, '销售小王', '价格高'),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
