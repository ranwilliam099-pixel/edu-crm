/**
 * CustomerController — Sprint B.3 字段级权限过滤 controller 单测
 *
 * 范围：
 *   - GET /db/customers/:id：scope filter（403）+ field mask
 *   - GET /db/customers/mine：listMine 已 SQL 过滤，验证 mask 应用
 *   - GET /db/customers/all：admin/sales_manager 字段一致（5/15 A-2 删 sales_director）
 *   - GET /db/customers/pool：pool 路径 isOwnerSelf=true（销售可见 phone 抢占）
 *
 * 红线（fields-by-role.md #3）：
 *   - sales 自己客户：phone/wechat ✅
 *   - sales 别人客户：直接 403（侧信道阻断）
 *   - finance：phone/wechat null
 *   - academic：phone/wechat ✅ 但 source/note null
 */

import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { CustomerController } from './customer.controller';
import { CustomerRepository, Customer, CreateCustomerResult } from './customer.repository';
import { AuthenticatedRequest, JwtPayload, TenantRole } from '../auth/jwt-payload.interface';
import { AuditLogRepository } from './audit-log.repository';

describe('CustomerController (Sprint B.3 字段级权限)', () => {
  let controller: CustomerController;
  let repo: {
    findById: jest.Mock;
    listMine: jest.Mock;
    listAllForBoss: jest.Mock;
    listPool: jest.Mock;
    listFollowLog: jest.Mock;
  };

  const TENANT_A = 'TENANTA00000000000000000000000A1';
  const TENANT_SCHEMA = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const CAMPUS_A = 'campus_A0000000000000000000000A01';
  const SALES_A = 'salesA00000000000000000000000A01';
  const SALES_B = 'salesB00000000000000000000000A02';
  const CUSTOMER_ID = 'opp00000000000000000000000000A01';

  function jwt(role: TenantRole, sub = SALES_A): JwtPayload {
    return { sub, tenantId: TENANT_A, role, campusId: CAMPUS_A };
  }

  function req(user?: JwtPayload): AuthenticatedRequest {
    return { user, headers: {}, body: {}, query: {}, params: {} };
  }

  function customerFixture(overrides: Partial<Customer> = {}): Customer {
    return {
      id: CUSTOMER_ID,
      studentId: 'student00000000000000000000A001',
      studentName: '小明',
      gradeOrAge: '三年级',
      intendedSubject: '英语',
      ownerUserId: SALES_A,
      stage: '初步接触',
      source: '抖音',
      phone: '13800138000',
      wechat: 'wx_parent_abc',
      intentLevel: '高',
      urgent: false,
      note: '内部跟进备注',
      enteredPoolAt: null,
      enterPoolReason: null,
      lastContactAt: '2026-05-10T10:00:00.000Z',
      signedAt: null,
      lostReason: null,
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-10T10:00:00.000Z',
      ...overrides,
    };
  }

  beforeEach(() => {
    repo = {
      findById: jest.fn(),
      listMine: jest.fn(),
      listAllForBoss: jest.fn(),
      listPool: jest.fn(),
      listFollowLog: jest.fn(),
    } as any;
    controller = new CustomerController(repo as unknown as CustomerRepository);
  });

  // ============================================================
  // detail() GET /db/customers/:id — scope + field
  // ============================================================
  describe('detail() — scope + field', () => {
    it('admin → 全字段（phone/wechat/source/note 全保留）', async () => {
      repo.findById.mockResolvedValueOnce(customerFixture());
      const r = (await controller.detail(CUSTOMER_ID, TENANT_SCHEMA, req(jwt('admin')))) as Customer;
      expect(r.phone).toBe('13800138000');
      expect(r.wechat).toBe('wx_parent_abc');
      expect(r.source).toBe('抖音');
      expect(r.note).toBe('内部跟进备注');
    });

    it('boss 同 admin → 全字段', async () => {
      repo.findById.mockResolvedValueOnce(customerFixture());
      const r = (await controller.detail(CUSTOMER_ID, TENANT_SCHEMA, req(jwt('boss')))) as Customer;
      expect(r.phone).toBe('13800138000');
    });

    it('sales 自己客户（owner=me）→ 全字段', async () => {
      repo.findById.mockResolvedValueOnce(customerFixture({ ownerUserId: SALES_A }));
      const r = (await controller.detail(
        CUSTOMER_ID,
        TENANT_SCHEMA,
        req(jwt('sales', SALES_A)),
      )) as Customer;
      expect(r.phone).toBe('13800138000');
      expect(r.wechat).toBe('wx_parent_abc');
    });

    it('sales 别人客户（owner=他）→ 403 ForbiddenException', async () => {
      repo.findById.mockResolvedValueOnce(customerFixture({ ownerUserId: SALES_B }));
      await expect(
        controller.detail(CUSTOMER_ID, TENANT_SCHEMA, req(jwt('sales', SALES_A))),
      ).rejects.toThrow(ForbiddenException);
    });

    it('sales 池客户（owner=null）→ phone/wechat 可见（FCFS claim 需要）', async () => {
      repo.findById.mockResolvedValueOnce(customerFixture({ ownerUserId: null }));
      const r = (await controller.detail(
        CUSTOMER_ID,
        TENANT_SCHEMA,
        req(jwt('sales', SALES_A)),
      )) as Customer;
      expect(r.phone).toBe('13800138000');
      expect(r.wechat).toBe('wx_parent_abc');
    });

    // 5/15 A-2：sales_director 应用层已删（不在拍板角色清单）
    //   - jwt.role='sales_director' 不应再发生（login validRoles 已删）
    //   - 历史数据若仍有 sales_director claim 通过 jwt → actorGroupOf → unknown group
    //     → canAccessCustomer 兜底返 false → 403 ForbiddenException（scope filter 优先于 field mask）
    //   - 双层安全：即使 RbacGuard 漏过，controller scope filter 仍拦截
    it('sales_director (legacy, 5/15 A-2 已删) → 403 ForbiddenException（unknown group 拒绝访问）', async () => {
      const { ForbiddenException } = require('@nestjs/common');
      repo.findById.mockResolvedValueOnce(customerFixture({ ownerUserId: SALES_B }));
      await expect(
        controller.detail(
          CUSTOMER_ID,
          TENANT_SCHEMA,
          req(jwt('sales_director' as never, SALES_A)),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('sales_manager → 全字段（销售校内主管收口）', async () => {
      repo.findById.mockResolvedValueOnce(customerFixture({ ownerUserId: SALES_B }));
      const r = (await controller.detail(
        CUSTOMER_ID,
        TENANT_SCHEMA,
        req(jwt('sales_manager', SALES_A)),
      )) as Customer;
      expect(r.phone).toBe('13800138000');
    });

    it('academic → phone/wechat 可见，source/note null', async () => {
      repo.findById.mockResolvedValueOnce(customerFixture());
      const r = (await controller.detail(
        CUSTOMER_ID,
        TENANT_SCHEMA,
        req(jwt('academic')),
      )) as Customer;
      expect(r.phone).toBe('13800138000');
      expect(r.wechat).toBe('wx_parent_abc');
      expect(r.source).toBeNull();
    });

    it('academic_admin 同 academic', async () => {
      repo.findById.mockResolvedValueOnce(customerFixture());
      const r = (await controller.detail(
        CUSTOMER_ID,
        TENANT_SCHEMA,
        req(jwt('academic_admin')),
      )) as Customer;
      expect(r.phone).toBe('13800138000');
      expect(r.source).toBeNull();
    });

    it('finance → phone/wechat/note/source 全 null（仅作账）', async () => {
      repo.findById.mockResolvedValueOnce(customerFixture());
      const r = (await controller.detail(
        CUSTOMER_ID,
        TENANT_SCHEMA,
        req(jwt('finance')),
      )) as Customer;
      expect(r.phone).toBeNull();
      expect(r.wechat).toBeNull();
      expect(r.note).toBeNull();
      // 但 stage/signedAt 保留作账
      expect(r.stage).toBe('初步接触');
    });

    it('teacher → 403（不该看 customer）', async () => {
      repo.findById.mockResolvedValueOnce(customerFixture());
      await expect(
        controller.detail(CUSTOMER_ID, TENANT_SCHEMA, req(jwt('teacher'))),
      ).rejects.toThrow(ForbiddenException);
    });

    it('hr → 403（不参与客户线索）', async () => {
      repo.findById.mockResolvedValueOnce(customerFixture());
      await expect(
        controller.detail(CUSTOMER_ID, TENANT_SCHEMA, req(jwt('hr'))),
      ).rejects.toThrow(ForbiddenException);
    });

    it('客户不存在 → {found:false}', async () => {
      repo.findById.mockResolvedValueOnce(null);
      const r = await controller.detail(CUSTOMER_ID, TENANT_SCHEMA, req(jwt('admin')));
      expect(r).toEqual({ found: false });
    });

    it('tenantSchema 缺失 → BadRequest', async () => {
      await expect(controller.detail(CUSTOMER_ID, '', req(jwt('admin')))).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ============================================================
  // listMine()
  // ============================================================
  describe('listMine() — 自己客户列表（已 SQL 过滤 + field mask）', () => {
    it('sales 自己 → phone/wechat 都返', async () => {
      repo.listMine.mockResolvedValueOnce([customerFixture({ ownerUserId: SALES_A })]);
      const r = await controller.listMine(
        TENANT_SCHEMA,
        undefined,
        undefined,
        undefined,
        req(jwt('sales', SALES_A)),
      );
      expect(r.items).toHaveLength(1);
      expect(r.items[0].phone).toBe('13800138000');
      expect(r.items[0].wechat).toBe('wx_parent_abc');
    });

    it('admin 调 mine → 自己持有的客户全字段', async () => {
      const adminUid = 'adminUid000000000000000000000A01';
      repo.listMine.mockResolvedValueOnce([customerFixture({ ownerUserId: adminUid })]);
      const r = await controller.listMine(
        TENANT_SCHEMA,
        undefined,
        undefined,
        undefined,
        req(jwt('admin', adminUid)),
      );
      expect(r.items[0].phone).toBe('13800138000');
    });
  });

  // ============================================================
  // listAllForBoss()
  // ============================================================
  describe('listAllForBoss() — admin/sales_manager (5/15 A-2 删 sales_director)', () => {
    it('admin 看到所有客户 phone/wechat', async () => {
      repo.listAllForBoss.mockResolvedValueOnce([
        customerFixture({ ownerUserId: SALES_A }),
        customerFixture({ id: 'other', ownerUserId: SALES_B }),
      ]);
      const r = await controller.listAllForBoss(
        TENANT_SCHEMA,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        req(jwt('admin', 'adminUid000000000000000000000A01')),
      );
      expect(r.items).toHaveLength(2);
      expect(r.items[0].phone).toBe('13800138000');
      expect(r.items[1].phone).toBe('13800138000');
    });

    it('sales_manager 看到所有客户 phone（销售校内主管收口）— 5/15 A-2 sales_director 已删', async () => {
      repo.listAllForBoss.mockResolvedValueOnce([
        customerFixture({ ownerUserId: SALES_A }),
        customerFixture({ id: 'other', ownerUserId: SALES_B }),
      ]);
      const r = await controller.listAllForBoss(
        TENANT_SCHEMA,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        req(jwt('sales_manager', SALES_A)),
      );
      expect(r.items[0].phone).toBe('13800138000');
      expect(r.items[1].phone).toBe('13800138000');
    });
  });

  // ============================================================
  // listPool()
  // ============================================================
  describe('listPool() — 公共池 isOwnerSelf=true（销售可见 phone 抢占）', () => {
    it('sales 看池 → 全部 phone 可见（FCFS claim 需要）', async () => {
      repo.listPool.mockResolvedValueOnce([
        customerFixture({ ownerUserId: null }),
        customerFixture({ id: 'other', ownerUserId: null }),
      ]);
      const r = await controller.listPool(
        TENANT_SCHEMA,
        undefined,
        undefined,
        undefined,
        req(jwt('sales', SALES_A)),
      );
      expect(r.items[0].phone).toBe('13800138000');
      expect(r.items[1].phone).toBe('13800138000');
    });

    it('admin 看池 → 全字段', async () => {
      repo.listPool.mockResolvedValueOnce([customerFixture({ ownerUserId: null })]);
      const r = await controller.listPool(
        TENANT_SCHEMA,
        undefined,
        undefined,
        undefined,
        req(jwt('admin')),
      );
      expect(r.items[0].phone).toBe('13800138000');
    });
  });

  // ============================================================
  // listFollows() GET /db/customers/:id/follows
  // Sprint B.3 复审 修 2：canAccessCustomer scope filter
  // ============================================================
  describe('listFollows() — 修 2 scope filter (canAccessCustomer)', () => {
    const FOLLOW_FIXTURE = {
      id: 'follow0000000000000000000000000A1',
      followType: 'remark',
      label: '电话沟通',
      byUserId: SALES_A,
      byLabel: '销售 A',
      createdAt: '2026-05-10T10:00:00.000Z',
    };

    it('admin → 放行（全字段跟进时间轴）', async () => {
      repo.findById.mockResolvedValueOnce(customerFixture());
      repo.listFollowLog.mockResolvedValueOnce([FOLLOW_FIXTURE]);
      const r = await controller.listFollows(
        CUSTOMER_ID,
        TENANT_SCHEMA,
        undefined,
        req(jwt('admin')),
      );
      expect(r.items).toHaveLength(1);
      expect(repo.listFollowLog).toHaveBeenCalledWith(TENANT_SCHEMA, CUSTOMER_ID, 100);
    });

    it('boss → 放行', async () => {
      repo.findById.mockResolvedValueOnce(customerFixture());
      repo.listFollowLog.mockResolvedValueOnce([]);
      await controller.listFollows(
        CUSTOMER_ID,
        TENANT_SCHEMA,
        undefined,
        req(jwt('boss')),
      );
      // boss 放行 = listFollowLog 调一次 + 参数同 TENANT/CUSTOMER/默认 limit 100
      expect(repo.listFollowLog).toHaveBeenCalledTimes(1);
      expect(repo.listFollowLog).toHaveBeenCalledWith(TENANT_SCHEMA, CUSTOMER_ID, 100);
    });

    it('sales 自己客户（owner=me）→ 放行', async () => {
      repo.findById.mockResolvedValueOnce(customerFixture({ ownerUserId: SALES_A }));
      repo.listFollowLog.mockResolvedValueOnce([FOLLOW_FIXTURE]);
      const r = await controller.listFollows(
        CUSTOMER_ID,
        TENANT_SCHEMA,
        undefined,
        req(jwt('sales', SALES_A)),
      );
      expect(r.items).toHaveLength(1);
    });

    it('sales 别人客户（owner=他）→ 403 ForbiddenException', async () => {
      repo.findById.mockResolvedValueOnce(customerFixture({ ownerUserId: SALES_B }));
      await expect(
        controller.listFollows(
          CUSTOMER_ID,
          TENANT_SCHEMA,
          undefined,
          req(jwt('sales', SALES_A)),
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(repo.listFollowLog).not.toHaveBeenCalled();
    });

    it('sales 池客户（owner=null）→ 放行（FCFS 抢占前需看跟进史）', async () => {
      repo.findById.mockResolvedValueOnce(customerFixture({ ownerUserId: null }));
      repo.listFollowLog.mockResolvedValueOnce([]);
      await controller.listFollows(
        CUSTOMER_ID,
        TENANT_SCHEMA,
        undefined,
        req(jwt('sales', SALES_A)),
      );
      // sales 看池客户跟进 = 调用一次 listFollowLog
      expect(repo.listFollowLog).toHaveBeenCalledTimes(1);
      expect(repo.listFollowLog).toHaveBeenCalledWith(TENANT_SCHEMA, CUSTOMER_ID, 100);
    });

    it('sales_manager → admin group 放行（5/15 A-2 删 sales_director）', async () => {
      repo.findById.mockResolvedValueOnce(customerFixture({ ownerUserId: SALES_B }));
      repo.listFollowLog.mockResolvedValueOnce([]);
      await controller.listFollows(
        CUSTOMER_ID,
        TENANT_SCHEMA,
        undefined,
        req(jwt('sales_manager', SALES_A)),
      );
      // sales_manager 可跨自己看（admin group）— 同 boss 路径一次调用
      expect(repo.listFollowLog).toHaveBeenCalledTimes(1);
      expect(repo.listFollowLog).toHaveBeenCalledWith(TENANT_SCHEMA, CUSTOMER_ID, 100);
    });

    it('academic → 放行（拍板教务可看本校客户）', async () => {
      repo.findById.mockResolvedValueOnce(customerFixture());
      repo.listFollowLog.mockResolvedValueOnce([]);
      await controller.listFollows(
        CUSTOMER_ID,
        TENANT_SCHEMA,
        undefined,
        req(jwt('academic')),
      );
      // academic 可看本校 = 调一次（拍板 SSOT 教务全只读）
      expect(repo.listFollowLog).toHaveBeenCalledTimes(1);
      expect(repo.listFollowLog).toHaveBeenCalledWith(TENANT_SCHEMA, CUSTOMER_ID, 100);
    });

    it('finance → 放行（拍板财务可看本校客户）', async () => {
      repo.findById.mockResolvedValueOnce(customerFixture());
      repo.listFollowLog.mockResolvedValueOnce([]);
      await controller.listFollows(
        CUSTOMER_ID,
        TENANT_SCHEMA,
        undefined,
        req(jwt('finance')),
      );
      // finance 看本校客户 = 调一次（含 contracts/invoices 上下文）
      expect(repo.listFollowLog).toHaveBeenCalledTimes(1);
      expect(repo.listFollowLog).toHaveBeenCalledWith(TENANT_SCHEMA, CUSTOMER_ID, 100);
    });

    it('teacher → 403（拍板教学线不参与销售）', async () => {
      repo.findById.mockResolvedValueOnce(customerFixture());
      await expect(
        controller.listFollows(
          CUSTOMER_ID,
          TENANT_SCHEMA,
          undefined,
          req(jwt('teacher')),
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(repo.listFollowLog).not.toHaveBeenCalled();
    });

    it('parent → 403（拍板家长不该看销售跟进史）', async () => {
      repo.findById.mockResolvedValueOnce(customerFixture());
      await expect(
        controller.listFollows(
          CUSTOMER_ID,
          TENANT_SCHEMA,
          undefined,
          req(jwt('parent' as TenantRole)),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('hr → 403（拍板 hr 不参与客户线索）', async () => {
      repo.findById.mockResolvedValueOnce(customerFixture());
      await expect(
        controller.listFollows(
          CUSTOMER_ID,
          TENANT_SCHEMA,
          undefined,
          req(jwt('hr')),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('客户不存在 → 空列表（侧信道防护）', async () => {
      repo.findById.mockResolvedValueOnce(null);
      const r = await controller.listFollows(
        CUSTOMER_ID,
        TENANT_SCHEMA,
        undefined,
        req(jwt('admin')),
      );
      expect(r.items).toEqual([]);
      expect(repo.listFollowLog).not.toHaveBeenCalled();
    });

    it('tenantSchema 缺失 → BadRequest', async () => {
      await expect(
        controller.listFollows(CUSTOMER_ID, '', undefined, req(jwt('admin'))),
      ).rejects.toThrow(BadRequestException);
    });
  });
});

// ============================================================
// Sprint B.5 (2026-05-11): audit_log 业务写 + 拒绝路径
// ============================================================
describe('CustomerController (Sprint B.5 audit_log)', () => {
  let controller: CustomerController;
  let repo: {
    findById: jest.Mock;
    listMine: jest.Mock;
    listAllForBoss: jest.Mock;
    listPool: jest.Mock;
    listFollowLog: jest.Mock;
    createWithOpportunity: jest.Mock;
    claim: jest.Mock;
    release: jest.Mock;
    markLost: jest.Mock;
  };
  let auditLog: { log: jest.Mock };

  const TENANT_A = 'TENANTA00000000000000000000000A1';
  const TENANT_SCHEMA = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const CAMPUS_A = 'campus_A0000000000000000000000A01';
  const SALES_A = 'salesA00000000000000000000000A01';
  const SALES_B = 'salesB00000000000000000000000A02';
  const CUSTOMER_ID = 'opp00000000000000000000000000A01';
  const OPPORTUNITY_ID = 'oppor00000000000000000000000A01';
  const STUDENT_ID = 'student00000000000000000000A001';

  function jwt(role: TenantRole, sub = SALES_A): JwtPayload {
    return { sub, tenantId: TENANT_A, role, campusId: CAMPUS_A };
  }

  function req(user?: JwtPayload): AuthenticatedRequest {
    return {
      user,
      headers: { 'user-agent': 'WeChatMP/8.x', 'x-request-id': 'req-test-001' },
      body: {},
      query: {},
      params: {},
      ip: '127.0.0.1',
    };
  }

  function customerFixture(overrides: Partial<Customer> = {}): Customer {
    return {
      id: CUSTOMER_ID,
      studentId: STUDENT_ID,
      studentName: '小明',
      gradeOrAge: '三年级',
      intendedSubject: '英语',
      ownerUserId: SALES_A,
      stage: '初步接触',
      source: '抖音',
      phone: '13800138000',
      wechat: 'wx_parent_abc',
      intentLevel: '高',
      urgent: false,
      note: '内部跟进备注',
      enteredPoolAt: null,
      enterPoolReason: null,
      lastContactAt: '2026-05-10T10:00:00.000Z',
      signedAt: null,
      lostReason: null,
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-10T10:00:00.000Z',
      ...overrides,
    };
  }

  beforeEach(() => {
    repo = {
      findById: jest.fn(),
      listMine: jest.fn(),
      listAllForBoss: jest.fn(),
      listPool: jest.fn(),
      listFollowLog: jest.fn(),
      createWithOpportunity: jest.fn(),
      claim: jest.fn(),
      release: jest.fn(),
      markLost: jest.fn(),
    } as any;
    auditLog = { log: jest.fn().mockResolvedValue(undefined) };
    controller = new CustomerController(
      repo as unknown as CustomerRepository,
      auditLog as unknown as AuditLogRepository,
    );
  });

  // ============================================================
  // createSelfBuilt() → audit_log 'customer.create'
  // ============================================================
  describe('createSelfBuilt() — audit customer.create', () => {
    it('销售即时建客户 → audit_log 调 1 次, action="customer.create", phone 脱敏', async () => {
      const result: CreateCustomerResult = {
        customerId: CUSTOMER_ID,
        opportunityId: OPPORTUNITY_ID,
        studentId: STUDENT_ID,
      };
      repo.createWithOpportunity.mockResolvedValueOnce(result);

      await controller.createSelfBuilt(
        {
          tenantId: TENANT_A,
          tenantSchema: TENANT_SCHEMA,
          customerId: CUSTOMER_ID,
          opportunityId: OPPORTUNITY_ID,
          parentName: '小明妈妈',
          primaryMobile: '13800138000',
          campusId: CAMPUS_A,
          studentId: STUDENT_ID,
          studentName: '小明',
          intendedSubject: '英语',
          gradeOrAge: '三年级',
        },
        req(jwt('sales', SALES_A)),
      );

      expect(auditLog.log).toHaveBeenCalledTimes(1);
      const [schema, entry] = auditLog.log.mock.calls[0];
      expect(schema).toBe(TENANT_SCHEMA);
      expect(entry.action).toBe('customer.create');
      expect(entry.targetType).toBe('customer');
      expect(entry.targetId).toBe(CUSTOMER_ID);
      expect(entry.before).toBeNull();
      expect(entry.actorUserId).toBe(SALES_A);
      expect(entry.actorRole).toBe('sales');
      // PII mask check: primaryMobile '13800138000' → '138****8000'
      expect(entry.after.primaryMobileMask).toBe('138****8000');
      // raw phone 不应出现在 after
      expect(entry.after.primaryMobile).toBeUndefined();
      // 业务关键字段保留
      expect(entry.after.parentName).toBe('小明妈妈');
      expect(entry.after.ownerSalesId).toBe(SALES_A);
      expect(entry.after.studentId).toBe(STUDENT_ID);
    });

    it('audit_log.log 抛错 → 不阻塞主业务（fail-open）', async () => {
      const result: CreateCustomerResult = {
        customerId: CUSTOMER_ID,
        opportunityId: OPPORTUNITY_ID,
        studentId: null,
      };
      repo.createWithOpportunity.mockResolvedValueOnce(result);
      auditLog.log.mockRejectedValueOnce(new Error('audit_log write fail'));

      // 主业务不应抛 — audit 失败 try-catch 兜住
      const r = await controller.createSelfBuilt(
        {
          tenantId: TENANT_A,
          tenantSchema: TENANT_SCHEMA,
          customerId: CUSTOMER_ID,
          opportunityId: OPPORTUNITY_ID,
          parentName: '小明妈妈',
          primaryMobile: '13800138000',
          campusId: CAMPUS_A,
        },
        req(jwt('sales', SALES_A)),
      );
      expect(r.customerId).toBe(CUSTOMER_ID);
      expect(auditLog.log).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // claim() → audit_log 'customer.claim'
  // ============================================================
  describe('claim() — audit customer.claim', () => {
    it('销售抢池客户 → audit_log 调 1 次, before owner=null, after owner=me', async () => {
      repo.findById.mockResolvedValueOnce(customerFixture({ ownerUserId: null }));
      repo.claim.mockResolvedValueOnce(customerFixture({ ownerUserId: SALES_A }));

      await controller.claim(
        CUSTOMER_ID,
        { tenantId: TENANT_A, tenantSchema: TENANT_SCHEMA },
        req(jwt('sales', SALES_A)),
      );

      expect(auditLog.log).toHaveBeenCalledTimes(1);
      const entry = auditLog.log.mock.calls[0][1];
      expect(entry.action).toBe('customer.claim');
      expect(entry.targetType).toBe('customer');
      expect(entry.targetId).toBe(CUSTOMER_ID);
      expect(entry.before).toEqual({ ownerUserId: null, stage: '初步接触' });
      expect(entry.after.ownerUserId).toBe(SALES_A);
      // PII 不入 audit
      expect(entry.after.phone).toBeUndefined();
    });
  });

  // ============================================================
  // release() → audit_log 'customer.release'
  // ============================================================
  describe('release() — audit customer.release', () => {
    it('销售退池 → audit_log 调 1 次, before owner=me, after owner=null', async () => {
      repo.findById.mockResolvedValueOnce(customerFixture({ ownerUserId: SALES_A }));
      repo.release.mockResolvedValueOnce(customerFixture({ ownerUserId: null }));

      await controller.release(
        CUSTOMER_ID,
        {
          tenantId: TENANT_A,
          tenantSchema: TENANT_SCHEMA,
          reason: 'not_engaged',
        },
        req(jwt('sales', SALES_A)),
      );

      expect(auditLog.log).toHaveBeenCalledTimes(1);
      const entry = auditLog.log.mock.calls[0][1];
      expect(entry.action).toBe('customer.release');
      expect(entry.targetId).toBe(CUSTOMER_ID);
      expect(entry.before.ownerUserId).toBe(SALES_A);
      expect(entry.after.ownerUserId).toBeNull();
      expect(entry.after.reason).toBe('not_engaged');
    });
  });

  // ============================================================
  // markLost() → audit_log 'customer.mark-lost'
  // ============================================================
  describe('markLost() — audit customer.mark-lost', () => {
    it('销售标失单 → audit_log 调 1 次, stage 流转记录', async () => {
      repo.findById.mockResolvedValueOnce(
        customerFixture({ ownerUserId: SALES_A, stage: '谈单中' }),
      );
      repo.markLost.mockResolvedValueOnce(
        customerFixture({
          ownerUserId: SALES_A,
          stage: '已失单',
          lostReason: '价格高',
        }),
      );

      await controller.markLost(
        CUSTOMER_ID,
        {
          tenantId: TENANT_A,
          tenantSchema: TENANT_SCHEMA,
          lostReason: '价格高',
        },
        req(jwt('sales', SALES_A)),
      );

      expect(auditLog.log).toHaveBeenCalledTimes(1);
      const entry = auditLog.log.mock.calls[0][1];
      expect(entry.action).toBe('customer.mark-lost');
      expect(entry.before).toEqual({ stage: '谈单中', lostReason: null });
      expect(entry.after).toEqual({ stage: '已失单', lostReason: '价格高' });
    });
  });

  // ============================================================
  // detail() 拒绝路径 → audit_log 'customer.access-denied'
  // ============================================================
  describe('detail() — 拒绝路径 audit customer.access-denied', () => {
    it('sales 越权看他人客户 → audit access-denied 调 1 次 + 403', async () => {
      repo.findById.mockResolvedValueOnce(
        customerFixture({ ownerUserId: SALES_B }),
      );
      await expect(
        controller.detail(CUSTOMER_ID, TENANT_SCHEMA, req(jwt('sales', SALES_A))),
      ).rejects.toThrow(ForbiddenException);
      expect(auditLog.log).toHaveBeenCalledTimes(1);
      const entry = auditLog.log.mock.calls[0][1];
      expect(entry.action).toBe('customer.access-denied');
      expect(entry.targetType).toBe('customer');
      expect(entry.targetId).toBe(CUSTOMER_ID);
      expect(entry.after.attempted_role).toBe('sales');
      expect(entry.after.attempted_owner).toBe(SALES_A);
      expect(entry.after.actual_owner).toBe(SALES_B);
      expect(entry.after.endpoint).toBe('detail');
    });

    it('teacher 看 customer → audit access-denied 调 1 次 + 403', async () => {
      repo.findById.mockResolvedValueOnce(customerFixture());
      await expect(
        controller.detail(CUSTOMER_ID, TENANT_SCHEMA, req(jwt('teacher'))),
      ).rejects.toThrow(ForbiddenException);
      expect(auditLog.log).toHaveBeenCalledTimes(1);
      expect(auditLog.log.mock.calls[0][1].after.attempted_role).toBe('teacher');
    });

    it('audit_log.log 抛错 → 主 403 仍抛（fail-open）', async () => {
      repo.findById.mockResolvedValueOnce(
        customerFixture({ ownerUserId: SALES_B }),
      );
      auditLog.log.mockRejectedValueOnce(new Error('audit fail'));
      await expect(
        controller.detail(CUSTOMER_ID, TENANT_SCHEMA, req(jwt('sales', SALES_A))),
      ).rejects.toThrow(ForbiddenException);
      expect(auditLog.log).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // listFollows() 拒绝路径 → audit_log 'customer.access-denied'
  // ============================================================
  describe('listFollows() — 拒绝路径 audit customer.access-denied', () => {
    it('sales 看他人客户跟进 → audit access-denied + 403', async () => {
      repo.findById.mockResolvedValueOnce(
        customerFixture({ ownerUserId: SALES_B }),
      );
      await expect(
        controller.listFollows(
          CUSTOMER_ID,
          TENANT_SCHEMA,
          undefined,
          req(jwt('sales', SALES_A)),
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(auditLog.log).toHaveBeenCalledTimes(1);
      const entry = auditLog.log.mock.calls[0][1];
      expect(entry.action).toBe('customer.access-denied');
      expect(entry.after.endpoint).toBe('follows');
    });
  });
});
