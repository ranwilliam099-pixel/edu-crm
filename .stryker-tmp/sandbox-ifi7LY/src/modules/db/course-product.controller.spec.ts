/**
 * CourseProductController — 5/15 拍板 GET /db/course-products/:id/stats 单测
 *
 * 范围：
 *   - getStats 200 正常路径：返回完整聚合（productId / counts / students / teachers / weeklyConsumedYuan）
 *   - getStats 400：缺 tenantSchema / 缺 productId / productId 非 32 char
 *   - getStats 404：findStats 返回 null（product 不存在或跨 tenant）
 *   - getStats audit_log 404 路径写入 'course-product.stats-not-found'
 *   - getStats audit_log fail-open：log 抛错不阻塞主业务
 *
 * 备注：
 *   - RBAC 由 RbacGuard 在 framework 层校验（admin/boss/academic），单测不展开
 *   - TenantScopeGuard 校验在 framework 层（class @UseGuards），单测不展开
 *   - 本 spec 聚焦 controller handler 业务逻辑 + audit_log 行为
 */

import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { CourseProductController } from './course-product.controller';
import { CourseProductRepository, CourseProductStats } from './course-product.repository';
import { AuditLogRepository } from './audit-log.repository';
import { AuthenticatedRequest, JwtPayload, TenantRole } from '../auth/jwt-payload.interface';

describe('CourseProductController.getStats (5/15 拍板 OOUX 聚合)', () => {
  let controller: CourseProductController;
  let repo: {
    list: jest.Mock;
    findById: jest.Mock;
    findStats: jest.Mock;
    create: jest.Mock;
    setStatus: jest.Mock;
  };
  let auditLog: { log: jest.Mock };

  const TENANT_A = 'TENANTA00000000000000000000000A1';
  const TENANT_SCHEMA = 'tenant_tenanta00000000000000000000000a1';
  const CAMPUS_A = 'campus_A0000000000000000000000A01';
  const ADMIN_USER = 'adminA00000000000000000000000A001';
  const PRODUCT_ID = 'product000000000000000000000P001';
  const STUDENT_ID = 'studentX0000000000000000000000A1';
  const TEACHER_ID = 'teacherY0000000000000000000000B2';
  const TEACHER_USER_ID = 'userZ00000000000000000000000000C3';

  function jwt(role: TenantRole, sub = ADMIN_USER): JwtPayload {
    return { sub, tenantId: TENANT_A, role, campusId: CAMPUS_A };
  }

  function req(
    user?: JwtPayload,
    headers: Record<string, string> = {},
  ): AuthenticatedRequest {
    return {
      user,
      headers,
      body: {},
      query: {},
      params: {},
      ip: '1.2.3.4',
    } as AuthenticatedRequest;
  }

  function statsFixture(overrides: Partial<CourseProductStats> = {}): CourseProductStats {
    return {
      productId: PRODUCT_ID,
      productName: '英语 1v1 30 课时',
      studentCount: 1,
      teacherCount: 1,
      weeklyConsumedYuan: 600,
      students: [
        {
          id: STUDENT_ID,
          name: '小明',
          contractStatus: 'active',
          remainingHours: 12,
        },
      ],
      teachers: [
        {
          id: TEACHER_ID,
          userId: TEACHER_USER_ID,
          name: '张老师',
          weeklyLessonCount: 3,
        },
      ],
      ...overrides,
    };
  }

  beforeEach(() => {
    repo = {
      list: jest.fn(),
      findById: jest.fn(),
      findStats: jest.fn(),
      create: jest.fn(),
      setStatus: jest.fn(),
    } as any;
    auditLog = { log: jest.fn().mockResolvedValue(undefined) };
    controller = new CourseProductController(
      repo as unknown as CourseProductRepository,
      auditLog as unknown as AuditLogRepository,
    );
  });

  // ============================================================
  // 输入校验
  // ============================================================
  describe('input validation', () => {
    it('缺 tenantSchema → BadRequest', async () => {
      await expect(
        controller.getStats(PRODUCT_ID, '', req(jwt('admin'))),
      ).rejects.toThrow(BadRequestException);
    });

    it('缺 productId → BadRequest（id must be 32-char ULID）', async () => {
      await expect(
        controller.getStats('', TENANT_SCHEMA, req(jwt('admin'))),
      ).rejects.toThrow(BadRequestException);
    });

    it('productId 非 32 char → BadRequest', async () => {
      await expect(
        controller.getStats('short', TENANT_SCHEMA, req(jwt('admin'))),
      ).rejects.toThrow(BadRequestException);
    });

    it('校验提示信息含 32-char ULID', async () => {
      await expect(
        controller.getStats('short', TENANT_SCHEMA, req(jwt('admin'))),
      ).rejects.toThrow(/32-char ULID/);
    });
  });

  // ============================================================
  // 200 正常路径
  // ============================================================
  describe('200 success', () => {
    it('admin → 完整聚合 returned', async () => {
      repo.findStats.mockResolvedValueOnce(statsFixture());
      const r = await controller.getStats(PRODUCT_ID, TENANT_SCHEMA, req(jwt('admin')));
      expect(r.productId).toBe(PRODUCT_ID);
      expect(r.productName).toBe('英语 1v1 30 课时');
      expect(r.studentCount).toBe(1);
      expect(r.teacherCount).toBe(1);
      expect(r.weeklyConsumedYuan).toBe(600);
      expect(r.students).toHaveLength(1);
      expect(r.teachers).toHaveLength(1);
    });

    it('boss → 同 admin（fields-by-role 老板 ✅ / 校长 ✅ 本校）', async () => {
      repo.findStats.mockResolvedValueOnce(statsFixture());
      const r = await controller.getStats(PRODUCT_ID, TENANT_SCHEMA, req(jwt('boss')));
      expect(r.productId).toBe(PRODUCT_ID);
    });

    it('academic → 同 admin（fields-by-role 教务 👁）', async () => {
      repo.findStats.mockResolvedValueOnce(statsFixture());
      const r = await controller.getStats(PRODUCT_ID, TENANT_SCHEMA, req(jwt('academic')));
      expect(r.productId).toBe(PRODUCT_ID);
    });

    it('repo 调用：传入 tenantSchema + productId + 默认 scope（admin 不限制）', async () => {
      repo.findStats.mockResolvedValueOnce(statsFixture());
      await controller.getStats(PRODUCT_ID, TENANT_SCHEMA, req(jwt('admin')));
      expect(repo.findStats).toHaveBeenCalledTimes(1);
      // 5/15 r2 A-3/A-4：admin 不限制 owner / campus（null/null）
      expect(repo.findStats).toHaveBeenCalledWith(TENANT_SCHEMA, PRODUCT_ID, {
        callerOwnerSalesId: null,
        callerCampusId: null,
      });
    });

    it('200 成功路径不写 audit_log（高频读，不污染）', async () => {
      repo.findStats.mockResolvedValueOnce(statsFixture());
      await controller.getStats(PRODUCT_ID, TENANT_SCHEMA, req(jwt('admin')));
      expect(auditLog.log).not.toHaveBeenCalled();
    });

    it('students[] 不含 phone / 家庭住址 字段（PII 检查）', async () => {
      repo.findStats.mockResolvedValueOnce(statsFixture());
      const r = await controller.getStats(PRODUCT_ID, TENANT_SCHEMA, req(jwt('admin')));
      // 类型层面也禁止（CourseProductStatsStudent 只有 id/name/contractStatus/remainingHours）
      const keys = Object.keys(r.students[0]);
      expect(keys).toEqual(
        expect.arrayContaining(['id', 'name', 'contractStatus', 'remainingHours']),
      );
      expect(keys).not.toContain('phone');
      expect(keys).not.toContain('idNumber');
      expect(keys).not.toContain('familyAddress');
    });

    it('teachers[] 不含 phone / hourlyPriceYuan 字段（PII 检查）', async () => {
      repo.findStats.mockResolvedValueOnce(statsFixture());
      const r = await controller.getStats(PRODUCT_ID, TENANT_SCHEMA, req(jwt('admin')));
      const keys = Object.keys(r.teachers[0]);
      expect(keys).toEqual(
        expect.arrayContaining(['id', 'userId', 'name', 'weeklyLessonCount']),
      );
      expect(keys).not.toContain('phone');
      expect(keys).not.toContain('hourlyPriceYuan');
      expect(keys).not.toContain('idNumber');
    });

    it('students/teachers 空数组 → counts 0', async () => {
      repo.findStats.mockResolvedValueOnce(
        statsFixture({
          studentCount: 0,
          teacherCount: 0,
          weeklyConsumedYuan: 0,
          students: [],
          teachers: [],
        }),
      );
      const r = await controller.getStats(PRODUCT_ID, TENANT_SCHEMA, req(jwt('admin')));
      expect(r.studentCount).toBe(0);
      expect(r.teacherCount).toBe(0);
      expect(r.weeklyConsumedYuan).toBe(0);
    });
  });

  // ============================================================
  // 404 not-found
  // ============================================================
  describe('404 not-found', () => {
    it('repo.findStats 返 null → NotFoundException', async () => {
      repo.findStats.mockResolvedValueOnce(null);
      await expect(
        controller.getStats(PRODUCT_ID, TENANT_SCHEMA, req(jwt('admin'))),
      ).rejects.toThrow(NotFoundException);
    });

    it('NotFound 错误消息不回显 productId（Wave 11 r2 security P2 防扫描枚举）', async () => {
      // productId 已写入 audit_log targetId, 排查无需依赖 response body
      repo.findStats.mockResolvedValueOnce(null);
      const err = await controller
        .getStats(PRODUCT_ID, TENANT_SCHEMA, req(jwt('admin')))
        .catch((e) => e);
      expect(err).toBeInstanceOf(NotFoundException);
      expect(err.message).toBe('COURSE_PRODUCT_NOT_FOUND');
      expect(err.message).not.toContain(PRODUCT_ID);
    });

    it('404 → audit_log 写入 1 次, action="course-product.stats-not-found"', async () => {
      repo.findStats.mockResolvedValueOnce(null);
      await expect(
        controller.getStats(PRODUCT_ID, TENANT_SCHEMA, req(jwt('boss'))),
      ).rejects.toThrow(NotFoundException);
      expect(auditLog.log).toHaveBeenCalledTimes(1);
      const [schema, entry] = auditLog.log.mock.calls[0];
      expect(schema).toBe(TENANT_SCHEMA);
      expect(entry.action).toBe('course-product.stats-not-found');
      expect(entry.targetType).toBe('course-product');
      expect(entry.targetId).toBe(PRODUCT_ID);
      expect(entry.actorUserId).toBe(ADMIN_USER);
      expect(entry.actorRole).toBe('boss');
      expect(entry.after).toMatchObject({
        attempted_role: 'boss',
        endpoint: 'stats',
        reason: 'product_id_not_found_in_tenant',
      });
    });

    it('audit_log.log 抛错 → 不阻塞 404（fail-open）', async () => {
      repo.findStats.mockResolvedValueOnce(null);
      auditLog.log.mockRejectedValueOnce(new Error('audit_log write fail'));
      // 仍然抛 NotFoundException（不是 audit 错）
      await expect(
        controller.getStats(PRODUCT_ID, TENANT_SCHEMA, req(jwt('admin'))),
      ).rejects.toThrow(NotFoundException);
    });

    it('audit_log 未注入（@Optional）→ 404 仍正常抛', async () => {
      const ctrlNoAudit = new CourseProductController(
        repo as unknown as CourseProductRepository,
      );
      repo.findStats.mockResolvedValueOnce(null);
      await expect(
        ctrlNoAudit.getStats(PRODUCT_ID, TENANT_SCHEMA, req(jwt('admin'))),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ============================================================
  // audit_log 上下文（ip / userAgent / requestId / actorRole 正常化）
  // ============================================================
  describe('audit_log 上下文', () => {
    it('记录 ip / user-agent / x-request-id', async () => {
      repo.findStats.mockResolvedValueOnce(null);
      const headers = {
        'user-agent': 'WeChatMP/8.0.42',
        'x-request-id': 'req-abc-123',
      };
      await expect(
        controller.getStats(
          PRODUCT_ID,
          TENANT_SCHEMA,
          req(jwt('admin'), headers),
        ),
      ).rejects.toThrow(NotFoundException);
      const entry = auditLog.log.mock.calls[0][1];
      expect(entry.ip).toBe('1.2.3.4');
      expect(entry.userAgent).toBe('WeChatMP/8.0.42');
      expect(entry.requestId).toBe('req-abc-123');
    });

    it('actorRole 走 normalizeActorRole（V33 CHECK 白名单内）', async () => {
      repo.findStats.mockResolvedValueOnce(null);
      // academic 在 V33 白名单内 → 直接保留
      await expect(
        controller.getStats(PRODUCT_ID, TENANT_SCHEMA, req(jwt('academic'))),
      ).rejects.toThrow(NotFoundException);
      const entry = auditLog.log.mock.calls[0][1];
      expect(entry.actorRole).toBe('academic');
    });
  });

  // ============================================================
  // 跨 tenant 防御（repo 层：tenantQuery 已被 PgPoolService 限定 schema）
  // ============================================================
  describe('跨 tenant 防御', () => {
    it('repo 收到的 tenantSchema 来自 query 参数（TenantScopeGuard 已校验一致）', async () => {
      // 单测层面验证 controller 不私自篡改 schema
      repo.findStats.mockResolvedValueOnce(statsFixture());
      await controller.getStats(PRODUCT_ID, TENANT_SCHEMA, req(jwt('admin')));
      expect(repo.findStats.mock.calls[0][0]).toBe(TENANT_SCHEMA);
    });

    it('repo 返 null（跨 tenant 看不到别人 product 的等价情况）→ 404 而非 500', async () => {
      // schema-per-tenant 架构下，跨 tenant 查询会因 schema 不匹配返回空
      // controller 应一律返回 404 不区分「不存在」vs「跨 tenant」（避免侧信道泄漏）
      repo.findStats.mockResolvedValueOnce(null);
      await expect(
        controller.getStats(PRODUCT_ID, TENANT_SCHEMA, req(jwt('admin'))),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ============================================================
  // 5/15 r2 A-3: sales scope + 反伪造校验
  // ============================================================
  describe('A-3 sales scope + 反伪造校验', () => {
    const SALES_A = 'salesA00000000000000000000000A01';
    const SALES_B = 'salesB00000000000000000000000A02';

    it('sales 调 → callerOwnerSalesId 强制 = jwt.sub（不传 query）', async () => {
      repo.findStats.mockResolvedValueOnce(statsFixture());
      await controller.getStats(
        PRODUCT_ID,
        TENANT_SCHEMA,
        req(jwt('sales', SALES_A)),
      );
      expect(repo.findStats).toHaveBeenCalledWith(TENANT_SCHEMA, PRODUCT_ID, {
        callerOwnerSalesId: SALES_A, // 强制 jwt.sub
        callerCampusId: null, // sales 不走 campus path
      });
    });

    it('sales 调 + query.ownerSalesId === jwt.sub → 放行', async () => {
      repo.findStats.mockResolvedValueOnce(statsFixture());
      await controller.getStats(
        PRODUCT_ID,
        TENANT_SCHEMA,
        req(jwt('sales', SALES_A)),
        SALES_A, // query.ownerSalesId 等于 jwt.sub
      );
      expect(repo.findStats).toHaveBeenCalledWith(TENANT_SCHEMA, PRODUCT_ID, {
        callerOwnerSalesId: SALES_A,
        callerCampusId: null,
      });
    });

    it('sales 调 + query.ownerSalesId !== jwt.sub → 403 FORBIDDEN_OWNER_MISMATCH', async () => {
      await expect(
        controller.getStats(
          PRODUCT_ID,
          TENANT_SCHEMA,
          req(jwt('sales', SALES_A)),
          SALES_B, // 伪造他人 ownerSalesId
        ),
      ).rejects.toThrow(ForbiddenException);
      // repo 不应被调用（已在 403 前拦截）
      expect(repo.findStats).not.toHaveBeenCalled();
    });

    it('sales 伪造路径 → audit_log 写入 stats-owner-mismatch', async () => {
      await expect(
        controller.getStats(
          PRODUCT_ID,
          TENANT_SCHEMA,
          req(jwt('sales', SALES_A)),
          SALES_B,
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(auditLog.log).toHaveBeenCalledTimes(1);
      const entry = auditLog.log.mock.calls[0][1];
      expect(entry.action).toBe('course-product.stats-owner-mismatch');
      expect(entry.targetType).toBe('course-product');
      expect(entry.targetId).toBe(PRODUCT_ID);
      expect(entry.actorUserId).toBe(SALES_A);
      expect(entry.actorRole).toBe('sales');
      expect(entry.after).toMatchObject({
        attempted_role: 'sales',
        attempted_owner_sales_id: SALES_B,
        actual_jwt_sub: SALES_A,
        reason: 'sales_role_cannot_query_other_owner',
      });
    });

    it('admin 调 → callerOwnerSalesId = null（不限制 owner，看全部）', async () => {
      repo.findStats.mockResolvedValueOnce(statsFixture());
      await controller.getStats(
        PRODUCT_ID,
        TENANT_SCHEMA,
        req(jwt('admin', ADMIN_USER)),
        SALES_B, // admin 传 query 也不强制（看全部仍是 default null）
      );
      expect(repo.findStats).toHaveBeenCalledWith(TENANT_SCHEMA, PRODUCT_ID, {
        callerOwnerSalesId: null, // admin 不限制
        callerCampusId: null,
      });
    });

    it('boss 调 → callerOwnerSalesId = null（不限制 owner，按本校 campus 看全销售）', async () => {
      repo.findStats.mockResolvedValueOnce(statsFixture());
      await controller.getStats(
        PRODUCT_ID,
        TENANT_SCHEMA,
        req(jwt('boss', ADMIN_USER)),
      );
      const call = repo.findStats.mock.calls[0][2];
      expect(call.callerOwnerSalesId).toBeNull();
    });
  });

  // ============================================================
  // 5/15 r2 A-4: campus scope（boss/academic 多校隔离）
  // ============================================================
  describe('A-4 campus scope（boss/academic 多校隔离）', () => {
    const CAMPUS_B = 'campus_B0000000000000000000000A02';

    it('boss + jwt.campusId → callerCampusId 注入', async () => {
      repo.findStats.mockResolvedValueOnce(statsFixture());
      await controller.getStats(
        PRODUCT_ID,
        TENANT_SCHEMA,
        req(jwt('boss', ADMIN_USER)),
      );
      expect(repo.findStats).toHaveBeenCalledWith(TENANT_SCHEMA, PRODUCT_ID, {
        callerOwnerSalesId: null,
        callerCampusId: CAMPUS_A, // jwt fixture 默认 CAMPUS_A
      });
    });

    it('academic + jwt.campusId → callerCampusId 注入', async () => {
      repo.findStats.mockResolvedValueOnce(statsFixture());
      await controller.getStats(
        PRODUCT_ID,
        TENANT_SCHEMA,
        req(jwt('academic', ADMIN_USER)),
      );
      expect(repo.findStats).toHaveBeenCalledWith(TENANT_SCHEMA, PRODUCT_ID, {
        callerOwnerSalesId: null,
        callerCampusId: CAMPUS_A,
      });
    });

    it('admin 跨校 → callerCampusId = null（不注入 campus 过滤，看全 campus 聚合）', async () => {
      repo.findStats.mockResolvedValueOnce(statsFixture());
      // admin jwt fixture 用了 CAMPUS_A，但 controller 不读 admin 的 campusId 注入
      await controller.getStats(
        PRODUCT_ID,
        TENANT_SCHEMA,
        req(jwt('admin', ADMIN_USER)),
      );
      expect(repo.findStats).toHaveBeenCalledWith(TENANT_SCHEMA, PRODUCT_ID, {
        callerOwnerSalesId: null,
        callerCampusId: null, // admin 看全
      });
    });

    it('boss 不同校 (CAMPUS_B) → callerCampusId = CAMPUS_B', async () => {
      repo.findStats.mockResolvedValueOnce(statsFixture());
      const bossOtherCampus: JwtPayload = {
        sub: ADMIN_USER,
        tenantId: TENANT_A,
        role: 'boss',
        campusId: CAMPUS_B,
      };
      await controller.getStats(
        PRODUCT_ID,
        TENANT_SCHEMA,
        req(bossOtherCampus),
      );
      expect(repo.findStats.mock.calls[0][2].callerCampusId).toBe(CAMPUS_B);
    });

    it('boss 无 campusId（边界） → callerCampusId = null', async () => {
      repo.findStats.mockResolvedValueOnce(statsFixture());
      // V10 拍板 boss 必须有 campusId，但 controller 兜底 if (campusId) 检查
      const bossNoCampus: JwtPayload = {
        sub: ADMIN_USER,
        tenantId: TENANT_A,
        role: 'boss',
        campusId: null,
      };
      await controller.getStats(
        PRODUCT_ID,
        TENANT_SCHEMA,
        req(bossNoCampus),
      );
      expect(repo.findStats.mock.calls[0][2].callerCampusId).toBeNull();
    });
  });
});
