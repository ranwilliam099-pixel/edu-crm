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
import { ContentModerationService } from '../security/content-moderation.service';
import { CampusRepository } from './campus.repository';

describe('CustomerController (Sprint B.3 字段级权限)', () => {
  let controller: CustomerController;
  let repo: {
    findById: jest.Mock;
    listMine: jest.Mock;
    listAllForBoss: jest.Mock;
    listPool: jest.Mock;
    listFollowLog: jest.Mock;
  };
  let contentModeration: { enforceStaffText: jest.Mock };
  // 2026-06-02 SSOT §3.-2 D 全局校区筛选（增量 2）：admin override ∈ 本租户 campuses 校验
  let campusRepo: { findById: jest.Mock };

  const TENANT_A = 'TENANTA00000000000000000000000A1';
  const TENANT_SCHEMA = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const CAMPUS_A = 'campus_A0000000000000000000000A01';
  const CAMPUS_B = 'campusB00000000000000000000000B1';
  const SALES_A = 'salesA00000000000000000000000A01';
  const SALES_B = 'salesB00000000000000000000000A02';
  const CUSTOMER_ID = 'opp00000000000000000000000000A01';

  function jwt(
    role: TenantRole,
    sub = SALES_A,
    campusId: string | null = CAMPUS_A,
  ): JwtPayload {
    return { sub, tenantId: TENANT_A, role, campusId };
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
    contentModeration = { enforceStaffText: jest.fn().mockResolvedValue(undefined) };
    // §3.-2 D: 默认 findById 命中本租户校区 → admin override 校验通过；
    //   不存在/跨租户场景在用例内 mockResolvedValueOnce(null)。
    campusRepo = {
      findById: jest.fn().mockImplementation((tenantId: string, id: string) =>
        Promise.resolve(
          tenantId === TENANT_A
            ? { id, tenantId: TENANT_A, name: '分校区', status: 'active' }
            : null,
        ),
      ),
    };
    controller = new CustomerController(
      repo as unknown as CustomerRepository,
      contentModeration as unknown as ContentModerationService,
      // auditLog @Optional (位置 3) — 本批不验 / parentService @Optional (位置 4)
      undefined,
      undefined,
      campusRepo as unknown as CampusRepository,
    );
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

    it('academic → phone 明文（2026-06-01 §4.1 ① 逆转脱敏），wechat 可见，source/note null', async () => {
      // ⚠️ 行为变更（2026-06-01 §4.1 ①）：除 teacher/finance 外所有岗位看联系人手机明文 → academic 明文。
      repo.findById.mockResolvedValueOnce(customerFixture());
      const r = (await controller.detail(
        CUSTOMER_ID,
        TENANT_SCHEMA,
        req(jwt('academic')),
      )) as Customer;
      expect(r.phone).toBe('13800138000'); // 明文（§4.1 ① 逆转 5/31 脱敏）
      expect(r.wechat).toBe('wx_parent_abc'); // 微信非一级 PII，本校可见
      expect(r.source).toBeNull();
    });

    it('academic_admin 同 academic（phone 明文）', async () => {
      repo.findById.mockResolvedValueOnce(customerFixture());
      const r = (await controller.detail(
        CUSTOMER_ID,
        TENANT_SCHEMA,
        req(jwt('academic_admin')),
      )) as Customer;
      expect(r.phone).toBe('13800138000');
      expect(r.source).toBeNull();
    });

    it('marketing → 比照 academic：phone 明文 + wechat 可见 + source null（§4.1 ① 2026-06-01）', async () => {
      repo.findById.mockResolvedValueOnce(customerFixture());
      const r = (await controller.detail(
        CUSTOMER_ID,
        TENANT_SCHEMA,
        req(jwt('marketing')),
      )) as Customer;
      expect(r.phone).toBe('13800138000'); // 明文（§4.1 ① 市场除外名单）
      expect(r.wechat).toBe('wx_parent_abc');
      expect(r.source).toBeNull();
    });

    it('finance → phone/wechat/note/source 全 null（§4.1 ① finance 不看联系人明文，仅作账）', async () => {
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
        undefined, // source
        undefined, // campusId (§3.-2 D 增量 2)
        undefined, // limit
        undefined, // offset
        req(jwt('sales', SALES_A)),
      );
      expect(r.items[0].phone).toBe('13800138000');
      expect(r.items[1].phone).toBe('13800138000');
    });

    it('admin 看池 → 全字段', async () => {
      repo.listPool.mockResolvedValueOnce([customerFixture({ ownerUserId: null })]);
      const r = await controller.listPool(
        TENANT_SCHEMA,
        undefined, // source
        undefined, // campusId (§3.-2 D 增量 2)
        undefined, // limit
        undefined, // offset
        req(jwt('admin')),
      );
      expect(r.items[0].phone).toBe('13800138000');
    });
  });

  // ============================================================
  // 2026-06-02 SSOT §3.-2 D 全局校区筛选（增量 2）
  //   - admin 经 @Query('campusId') 选具体校区 override（校验 ∈ 本租户 campuses）
  //   - 非 admin（含 sales_manager/sales/boss）恒用 JWT.campusId（A04 防越权选他校）
  //   验证 repo 收到的 effective campusId（all/pool 两端点）。
  // ============================================================
  describe('§3.-2 D campus override (listAllForBoss / listPool)', () => {
    it('listAllForBoss admin override 单校（∈ 本租户）→ repo 收 campusId=override（查 repo）', async () => {
      repo.listAllForBoss.mockResolvedValueOnce([]);
      await controller.listAllForBoss(
        TENANT_SCHEMA,
        undefined, // ownerFilter
        undefined, // stage
        CAMPUS_B, // campusId override
        undefined, // limit
        undefined, // offset
        req(jwt('admin', 'adminUid000000000000000000000A01', CAMPUS_A)),
      );
      expect(campusRepo.findById).toHaveBeenCalledWith(TENANT_A, CAMPUS_B);
      expect(repo.listAllForBoss).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        expect.objectContaining({ campusId: CAMPUS_B }),
      );
    });

    it('listAllForBoss admin override 校区不存在（findById null）→ 回退 JWT.campusId', async () => {
      campusRepo.findById.mockResolvedValueOnce(null);
      repo.listAllForBoss.mockResolvedValueOnce([]);
      await controller.listAllForBoss(
        TENANT_SCHEMA,
        undefined,
        undefined,
        CAMPUS_B,
        undefined,
        undefined,
        req(jwt('admin', 'adminUid000000000000000000000A01', CAMPUS_A)),
      );
      expect(repo.listAllForBoss).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        expect.objectContaining({ campusId: CAMPUS_A }),
      );
    });

    it('listAllForBoss admin JWT.campusId=null + 无 override → repo 收 campusId=undefined（全返兜底）', async () => {
      repo.listAllForBoss.mockResolvedValueOnce([]);
      await controller.listAllForBoss(
        TENANT_SCHEMA,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        req(jwt('admin', 'adminUid000000000000000000000A01', null)),
      );
      expect(repo.listAllForBoss).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        expect.objectContaining({ campusId: undefined }),
      );
    });

    it('listAllForBoss sales_manager 传 override → 忽略 override 恒 JWT.campusId（不查 repo）', async () => {
      repo.listAllForBoss.mockResolvedValueOnce([]);
      await controller.listAllForBoss(
        TENANT_SCHEMA,
        undefined,
        undefined,
        CAMPUS_B, // sales_manager 传他校 campusId
        undefined,
        undefined,
        req(jwt('sales_manager', SALES_A, CAMPUS_A)),
      );
      expect(campusRepo.findById).not.toHaveBeenCalled();
      expect(repo.listAllForBoss).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        expect.objectContaining({ campusId: CAMPUS_A }),
      );
    });

    it('listPool admin override 单校（∈ 本租户）→ repo 收 campusId=override（查 repo）', async () => {
      repo.listPool.mockResolvedValueOnce([]);
      await controller.listPool(
        TENANT_SCHEMA,
        undefined, // source
        CAMPUS_B, // campusId override
        undefined, // limit
        undefined, // offset
        req(jwt('admin', 'adminUid000000000000000000000A01', CAMPUS_A)),
      );
      expect(campusRepo.findById).toHaveBeenCalledWith(TENANT_A, CAMPUS_B);
      expect(repo.listPool).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        expect.objectContaining({ campusId: CAMPUS_B }),
      );
    });

    it('listPool sales 传 override → 忽略 override 恒 JWT.campusId（本校公海，不查 repo）', async () => {
      repo.listPool.mockResolvedValueOnce([]);
      await controller.listPool(
        TENANT_SCHEMA,
        undefined,
        CAMPUS_B, // sales 传他校 campusId
        undefined,
        undefined,
        req(jwt('sales', SALES_A, CAMPUS_A)),
      );
      expect(campusRepo.findById).not.toHaveBeenCalled();
      expect(repo.listPool).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        expect.objectContaining({ campusId: CAMPUS_A }),
      );
    });

    it('listPool admin JWT.campusId=null + 无 override → repo 收 campusId=undefined（全返兜底）', async () => {
      repo.listPool.mockResolvedValueOnce([]);
      await controller.listPool(
        TENANT_SCHEMA,
        undefined,
        undefined,
        undefined,
        undefined,
        req(jwt('admin', 'adminUid000000000000000000000A01', null)),
      );
      expect(repo.listPool).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        expect.objectContaining({ campusId: undefined }),
      );
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
    promoteToStudent: jest.Mock;
    addFollow: jest.Mock;
  };
  let auditLog: { log: jest.Mock };
  let contentModeration: { enforceStaffText: jest.Mock };

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
      promoteToStudent: jest.fn(),
      addFollow: jest.fn(),
    } as any;
    auditLog = { log: jest.fn().mockResolvedValue(undefined) };
    contentModeration = { enforceStaffText: jest.fn().mockResolvedValue(undefined) };
    controller = new CustomerController(
      repo as unknown as CustomerRepository,
      contentModeration as unknown as ContentModerationService,
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

  // ============================================================
  // 2026-05-22 SSOT §6.1 B 方案：promoteToStudent() — 自动 promote customer → student
  // ============================================================
  describe('promoteToStudent() — SSOT §6.1 B 方案', () => {
    it('happy: customer.studentId 空 → INSERT students + UPDATE customers + audit_log auto-promoted', async () => {
      repo.promoteToStudent.mockResolvedValueOnce({
        studentId: STUDENT_ID,
        alreadyPromoted: false,
      });

      const result = await controller.promoteToStudent(
        CUSTOMER_ID,
        {
          tenantSchema: TENANT_SCHEMA,
          childName: '张小宝',
          childGender: 'male',
          childAgeOrGrade: '小学二年级',
        },
        req(jwt('sales', SALES_A)),
      );

      expect(result.studentId).toBe(STUDENT_ID);
      expect(result.alreadyPromoted).toBe(false);
      expect(repo.promoteToStudent).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        CUSTOMER_ID,
        expect.objectContaining({
          childName: '张小宝',
          childGender: 'male',
          childAgeOrGrade: '小学二年级',
          operatorUserId: SALES_A,
        }),
      );
      expect(auditLog.log).toHaveBeenCalledTimes(1);
      const entry = auditLog.log.mock.calls[0][1];
      expect(entry.action).toBe('customer.auto-promoted-by-sale');
      expect(entry.targetType).toBe('customer');
      expect(entry.targetId).toBe(CUSTOMER_ID);
      expect(entry.after.studentId).toBe(STUDENT_ID);
      expect(entry.after.childName).toBe('张小宝');
    });

    it('幂等: customer.studentId 已存在 → alreadyPromoted=true + audit_log skipped-already', async () => {
      repo.promoteToStudent.mockResolvedValueOnce({
        studentId: STUDENT_ID,
        alreadyPromoted: true,
      });

      const result = await controller.promoteToStudent(
        CUSTOMER_ID,
        { tenantSchema: TENANT_SCHEMA, childName: '张小宝' },
        req(jwt('academic', SALES_A)),
      );

      expect(result.alreadyPromoted).toBe(true);
      expect(auditLog.log.mock.calls[0][1].action).toBe('customer.promote.skipped-already');
    });

    it('tenantSchema 缺失 → BadRequest（不调 repo）', async () => {
      await expect(
        controller.promoteToStudent(
          CUSTOMER_ID,
          { tenantSchema: '', childName: '张小宝' },
          req(jwt('sales', SALES_A)),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(repo.promoteToStudent).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // #24 (2026-05-30): B 端自由文本内容安全（ContentModerationService.enforceStaffText）
  //   - happy path：断言以正确 texts/action/targetId 调用
  //   - risky path：mock rejects BadRequestException → 端点抛 400 且不写库
  // ============================================================
  describe('#24 内容安全 — createSelfBuilt() POST db/customers (note/source)', () => {
    const baseBody = {
      tenantId: TENANT_A,
      tenantSchema: TENANT_SCHEMA,
      customerId: CUSTOMER_ID,
      opportunityId: OPPORTUNITY_ID,
      parentName: '小明妈妈',
      primaryMobile: '13800138000',
      campusId: CAMPUS_A,
      source: '抖音',
      note: '客户很有意向',
    };

    it('happy: enforceStaffText 以 [note, source] / action=customer / targetId=customerId 调用', async () => {
      repo.createWithOpportunity.mockResolvedValueOnce({
        customerId: CUSTOMER_ID,
        opportunityId: OPPORTUNITY_ID,
        studentId: null,
      });

      await controller.createSelfBuilt({ ...baseBody }, req(jwt('sales', SALES_A)));

      expect(contentModeration.enforceStaffText).toHaveBeenCalledTimes(1);
      const [schema, texts, ctx] = contentModeration.enforceStaffText.mock.calls[0];
      expect(schema).toBe(TENANT_SCHEMA);
      expect(texts).toEqual(['客户很有意向', '抖音']);
      expect(ctx.action).toBe('customer');
      expect(ctx.targetType).toBe('customer');
      expect(ctx.targetId).toBe(CUSTOMER_ID);
      // mode 用默认 reject（不传第 4 参）
      expect(contentModeration.enforceStaffText.mock.calls[0][3]).toBeUndefined();
      // 写库发生在内容安全之后
      expect(repo.createWithOpportunity).toHaveBeenCalledTimes(1);
    });

    it('risky: enforceStaffText rejects 400 → 端点抛 400 且不写库（createWithOpportunity not called）', async () => {
      contentModeration.enforceStaffText.mockRejectedValueOnce(
        new BadRequestException('content violates content policy'),
      );

      await expect(
        controller.createSelfBuilt({ ...baseBody }, req(jwt('sales', SALES_A))),
      ).rejects.toThrow(BadRequestException);
      expect(repo.createWithOpportunity).not.toHaveBeenCalled();
    });
  });

  describe('#24 内容安全 — markLost() POST db/customers/:id/mark-lost (lostReason)', () => {
    it('happy: enforceStaffText 以 [lostReason] / action=customer / targetId=customerId 调用', async () => {
      repo.findById.mockResolvedValueOnce(
        customerFixture({ ownerUserId: SALES_A, stage: '谈单中' }),
      );
      repo.markLost.mockResolvedValueOnce(
        customerFixture({ ownerUserId: SALES_A, stage: '已失单', lostReason: '价格高' }),
      );

      await controller.markLost(
        CUSTOMER_ID,
        { tenantId: TENANT_A, tenantSchema: TENANT_SCHEMA, lostReason: '价格高' },
        req(jwt('sales', SALES_A)),
      );

      expect(contentModeration.enforceStaffText).toHaveBeenCalledTimes(1);
      const [schema, texts, ctx] = contentModeration.enforceStaffText.mock.calls[0];
      expect(schema).toBe(TENANT_SCHEMA);
      expect(texts).toEqual(['价格高']);
      expect(ctx.action).toBe('customer');
      expect(ctx.targetType).toBe('customer');
      expect(ctx.targetId).toBe(CUSTOMER_ID);
      expect(repo.markLost).toHaveBeenCalledTimes(1);
    });

    it('risky: enforceStaffText rejects 400 → 端点抛 400 且不写库（findById/markLost not called）', async () => {
      contentModeration.enforceStaffText.mockRejectedValueOnce(
        new BadRequestException('content violates content policy'),
      );

      await expect(
        controller.markLost(
          CUSTOMER_ID,
          { tenantId: TENANT_A, tenantSchema: TENANT_SCHEMA, lostReason: '违规失单原因' },
          req(jwt('sales', SALES_A)),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(repo.findById).not.toHaveBeenCalled();
      expect(repo.markLost).not.toHaveBeenCalled();
    });
  });

  describe('#24 内容安全 — release() POST db/customers/:id/release (reason)', () => {
    it('happy: enforceStaffText 以 [reason] / action=customer / targetId=customerId 调用', async () => {
      repo.findById.mockResolvedValueOnce(customerFixture({ ownerUserId: SALES_A }));
      repo.release.mockResolvedValueOnce(customerFixture({ ownerUserId: null }));

      await controller.release(
        CUSTOMER_ID,
        { tenantId: TENANT_A, tenantSchema: TENANT_SCHEMA, reason: '长期未跟进' },
        req(jwt('sales', SALES_A)),
      );

      expect(contentModeration.enforceStaffText).toHaveBeenCalledTimes(1);
      const [schema, texts, ctx] = contentModeration.enforceStaffText.mock.calls[0];
      expect(schema).toBe(TENANT_SCHEMA);
      expect(texts).toEqual(['长期未跟进']);
      expect(ctx.action).toBe('customer');
      expect(ctx.targetType).toBe('customer');
      expect(ctx.targetId).toBe(CUSTOMER_ID);
      expect(repo.release).toHaveBeenCalledTimes(1);
    });

    it('risky: enforceStaffText rejects 400 → 端点抛 400 且不写库（findById/release not called）', async () => {
      contentModeration.enforceStaffText.mockRejectedValueOnce(
        new BadRequestException('content violates content policy'),
      );

      await expect(
        controller.release(
          CUSTOMER_ID,
          { tenantId: TENANT_A, tenantSchema: TENANT_SCHEMA, reason: '违规退池原因' },
          req(jwt('sales', SALES_A)),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(repo.findById).not.toHaveBeenCalled();
      expect(repo.release).not.toHaveBeenCalled();
    });
  });

  describe('#24 内容安全 — addFollow() POST db/customers/:id/follow (label)', () => {
    it('happy: enforceStaffText 以 [label] / action=customer.follow / targetId=customerId 调用', async () => {
      repo.addFollow.mockResolvedValueOnce({
        id: 'follow0000000000000000000000000A1',
        followType: 'remark',
        label: '电话沟通',
        byUserId: SALES_A,
        byLabel: '销售 A',
        createdAt: '2026-05-30T10:00:00.000Z',
      });

      await controller.addFollow(
        CUSTOMER_ID,
        {
          tenantId: TENANT_A,
          tenantSchema: TENANT_SCHEMA,
          followType: 'remark',
          label: '电话沟通已加微信',
        },
        req(jwt('sales', SALES_A)),
      );

      expect(contentModeration.enforceStaffText).toHaveBeenCalledTimes(1);
      const [schema, texts, ctx] = contentModeration.enforceStaffText.mock.calls[0];
      expect(schema).toBe(TENANT_SCHEMA);
      expect(texts).toEqual(['电话沟通已加微信']);
      expect(ctx.action).toBe('customer.follow');
      expect(ctx.targetType).toBe('customer');
      expect(ctx.targetId).toBe(CUSTOMER_ID);
      expect(repo.addFollow).toHaveBeenCalledTimes(1);
    });

    it('risky: enforceStaffText rejects 400 → 端点抛 400 且不写库（addFollow not called）', async () => {
      contentModeration.enforceStaffText.mockRejectedValueOnce(
        new BadRequestException('content violates content policy'),
      );

      await expect(
        controller.addFollow(
          CUSTOMER_ID,
          {
            tenantId: TENANT_A,
            tenantSchema: TENANT_SCHEMA,
            followType: 'remark',
            label: '违规跟进内容',
          },
          req(jwt('sales', SALES_A)),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(repo.addFollow).not.toHaveBeenCalled();
    });
  });
});

// ============================================================
// 阶段 B (2026-05-31 SSOT §6 customer.bulkUpload，市场独有)
//   POST /api/db/customers/bulk-pool-import
//   市场批量入公海：owner=NULL + entered_pool_at + enter_pool_reason='市场批量导入' + campus 从 JWT
//   覆盖：marketing 成功批量入池 / phone 去重 skip / 非法 phone 入 errors /
//         sales 403（@Roles 不含；此处验逻辑层，Guard 由 e2e 覆盖）/
//         campus 从 JWT 不被 body 覆盖 / 内容违规行入 errors / 上限 200 防 DoS / audit_log
// ============================================================
describe('CustomerController (阶段 B bulk-pool-import 市场入公海)', () => {
  let controller: CustomerController;
  let repo: { importOnePoolRow: jest.Mock };
  let auditLog: { log: jest.Mock };
  let contentModeration: { enforceStaffText: jest.Mock };

  const TENANT_A = 'TENANTA00000000000000000000000A1';
  const TENANT_SCHEMA = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const CAMPUS_JWT = 'campusJWT0000000000000000000J001';
  const CAMPUS_FORGED = 'campusFORGED00000000000000F00001';
  const MKT_USER = 'mktA00000000000000000000000M001';

  function jwt(role: TenantRole, sub = MKT_USER, campusId: string | null = CAMPUS_JWT): JwtPayload {
    return { sub, tenantId: TENANT_A, role, campusId };
  }

  function req(user?: JwtPayload): AuthenticatedRequest {
    return {
      user,
      headers: { 'user-agent': 'WeChatMP/8.x', 'x-request-id': 'req-bulk-001' },
      body: {},
      query: {},
      params: {},
      ip: '127.0.0.1',
    } as any;
  }

  const validRow = {
    parentName: '小明妈妈',
    phone: '13800138000',
    studentName: '小明',
    gradeOrAge: '三年级',
    intendedSubject: '英语',
    sourceLevel1: '地推',
  };

  beforeEach(() => {
    repo = { importOnePoolRow: jest.fn() } as any;
    auditLog = { log: jest.fn().mockResolvedValue(undefined) };
    contentModeration = { enforceStaffText: jest.fn().mockResolvedValue(undefined) };
    controller = new CustomerController(
      repo as unknown as CustomerRepository,
      contentModeration as unknown as ContentModerationService,
      auditLog as unknown as AuditLogRepository,
    );
  });

  it('marketing 成功批量入池 → importOnePoolRow 调用 owner=NULL（campus 从 JWT）+ created 计数 + audit', async () => {
    repo.importOnePoolRow
      .mockResolvedValueOnce({ index: 0, status: 'created' })
      .mockResolvedValueOnce({ index: 1, status: 'created' });

    const result = await controller.bulkPoolImport(
      {
        tenantId: TENANT_A,
        tenantSchema: TENANT_SCHEMA,
        customers: [validRow, { ...validRow, phone: '13900139000', studentName: '小红' }],
      },
      req(jwt('marketing')),
    );

    expect(result.created).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toEqual([]);
    expect(repo.importOnePoolRow).toHaveBeenCalledTimes(2);
    // campus 从 JWT 透传给 repo（owner=NULL 入池由 repo 内部保证）
    const [, , opts] = repo.importOnePoolRow.mock.calls[0];
    expect(opts.campusId).toBe(CAMPUS_JWT);
    expect(opts.operatorUserId).toBe(MKT_USER);
    // audit_log customer.bulk_pool_import
    expect(auditLog.log).toHaveBeenCalledTimes(1);
    const [schema, entry] = auditLog.log.mock.calls[0];
    expect(schema).toBe(TENANT_SCHEMA);
    expect(entry.action).toBe('customer.bulk_pool_import');
    expect(entry.targetType).toBe('customer');
    expect(entry.after.created).toBe(2);
    expect(entry.after.total).toBe(2);
    expect(entry.after.campusId).toBe(CAMPUS_JWT);
  });

  it('phone 去重 → repo 返 skipped → 计入 skipped 不计 created', async () => {
    repo.importOnePoolRow
      .mockResolvedValueOnce({ index: 0, status: 'created' })
      .mockResolvedValueOnce({ index: 1, status: 'skipped' });

    const result = await controller.bulkPoolImport(
      {
        tenantId: TENANT_A,
        tenantSchema: TENANT_SCHEMA,
        customers: [validRow, { ...validRow }],
      },
      req(jwt('marketing')),
    );

    expect(result.created).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it('非法 phone → repo 返 error → 入 errors[{index, reason}]', async () => {
    repo.importOnePoolRow.mockResolvedValueOnce({
      index: 0,
      status: 'error',
      reason: 'phone 必须是 11 位中国手机号',
    });

    const result = await controller.bulkPoolImport(
      {
        tenantId: TENANT_A,
        tenantSchema: TENANT_SCHEMA,
        customers: [{ ...validRow, phone: '123' }],
      },
      req(jwt('marketing')),
    );

    expect(result.created).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].index).toBe(0);
    expect(result.errors[0].reason).toContain('phone');
  });

  it('campus 从 JWT，不被 body 覆盖（body 无 campusId 字段也按 JWT 走）', async () => {
    repo.importOnePoolRow.mockResolvedValueOnce({ index: 0, status: 'created' });

    // body 即使被攻击者塞 campusId（类型外字段），controller 也只读 req.user.campusId
    await controller.bulkPoolImport(
      {
        tenantId: TENANT_A,
        tenantSchema: TENANT_SCHEMA,
        customers: [validRow],
        // @ts-expect-error 故意塞伪造字段验证不被采用
        campusId: CAMPUS_FORGED,
      },
      req(jwt('marketing')),
    );

    const [, , opts] = repo.importOnePoolRow.mock.calls[0];
    expect(opts.campusId).toBe(CAMPUS_JWT);
    expect(opts.campusId).not.toBe(CAMPUS_FORGED);
  });

  it('内容违规行 → enforceStaffText reject → 该行 errors 且不写库（importOnePoolRow not called），其它行继续', async () => {
    // 第 0 行违规 reject；第 1 行通过
    contentModeration.enforceStaffText
      .mockRejectedValueOnce(new BadRequestException('content violates content policy'))
      .mockResolvedValueOnce(undefined);
    repo.importOnePoolRow.mockResolvedValueOnce({ index: 1, status: 'created' });

    const result = await controller.bulkPoolImport(
      {
        tenantId: TENANT_A,
        tenantSchema: TENANT_SCHEMA,
        customers: [
          { ...validRow, parentName: '违规广告内容' },
          { ...validRow, phone: '13700137000', studentName: '小刚' },
        ],
      },
      req(jwt('marketing')),
    );

    expect(result.created).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].index).toBe(0);
    expect(result.errors[0].reason).toBe('内容不合规');
    // 违规行不进 repo；只有第 1 行进
    expect(repo.importOnePoolRow).toHaveBeenCalledTimes(1);
    const [, rowPassed] = repo.importOnePoolRow.mock.calls[0];
    expect(rowPassed.studentName).toBe('小刚');
  });

  it('上限 200 防 DoS → 超出整批 400（任何写库前）', async () => {
    const rows = Array.from({ length: 201 }, (_, i) => ({
      ...validRow,
      phone: `138${String(i).padStart(8, '0')}`,
      studentName: `学员${i}`,
    }));

    await expect(
      controller.bulkPoolImport(
        { tenantId: TENANT_A, tenantSchema: TENANT_SCHEMA, customers: rows },
        req(jwt('marketing')),
      ),
    ).rejects.toThrow(BadRequestException);
    expect(repo.importOnePoolRow).not.toHaveBeenCalled();
    expect(contentModeration.enforceStaffText).not.toHaveBeenCalled();
  });

  it('空数组 / 非数组 → 400（不写库）', async () => {
    await expect(
      controller.bulkPoolImport(
        { tenantId: TENANT_A, tenantSchema: TENANT_SCHEMA, customers: [] },
        req(jwt('marketing')),
      ),
    ).rejects.toThrow(BadRequestException);
    expect(repo.importOnePoolRow).not.toHaveBeenCalled();
  });

  it('JWT 无 campusId（如 admin 跨校无单一 campus）→ 400（不写库）', async () => {
    await expect(
      controller.bulkPoolImport(
        { tenantId: TENANT_A, tenantSchema: TENANT_SCHEMA, customers: [validRow] },
        req(jwt('admin', MKT_USER, null)),
      ),
    ).rejects.toThrow(BadRequestException);
    expect(repo.importOnePoolRow).not.toHaveBeenCalled();
  });

  it('tenantSchema 缺失 → 400（不写库）', async () => {
    await expect(
      controller.bulkPoolImport(
        { tenantId: TENANT_A, tenantSchema: '', customers: [validRow] },
        req(jwt('marketing')),
      ),
    ).rejects.toThrow(BadRequestException);
    expect(repo.importOnePoolRow).not.toHaveBeenCalled();
  });

  it('audit_log 抛错 → 不阻塞主业务（fail-open，仍返结果）', async () => {
    repo.importOnePoolRow.mockResolvedValueOnce({ index: 0, status: 'created' });
    auditLog.log.mockRejectedValueOnce(new Error('audit write fail'));

    const result = await controller.bulkPoolImport(
      { tenantId: TENANT_A, tenantSchema: TENANT_SCHEMA, customers: [validRow] },
      req(jwt('marketing')),
    );
    expect(result.created).toBe(1);
  });
});
