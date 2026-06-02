/**
 * CSideController 单测 — 2026-05-23 P0 T1 tenant-contexts endpoint
 *
 * Scope: GET /api/c/tenant-contexts (parent 登录后「选 tenant」桥梁)
 *
 * 业务覆盖（设计文档 §2 T1）:
 *   - parent 0 binding → { contexts: [] } 空列表
 *   - parent 1 tenant N children → contexts 长度=1 children 长度=N
 *   - parent 2+ tenant 各 N children → contexts 按 tenant 分组正确
 *
 * 安全覆盖:
 *   - 仅信 req.parent.parentId (来自 JWT 签名验证, 不接 body / query)
 *   - parentRepo.findChildrenByParent 已 SQL WHERE parent_id=$1 AND binding_status='active'
 *     PG 参数化查询 → 跨 parent 物理隔离 (本 spec 不重复测仓库层, 测 controller scope 单元)
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { CSideController } from './c-side.controller';
import { CSideRepository, ChildBrief } from './c-side.repository';
import { ParentRepository } from '../db/parent.repository';
import { AuditLogRepository } from '../db/audit-log.repository';
import { ParentSelfGuard } from '../auth/parent-self.guard';
import { PgPoolService } from '../db/pg-pool.service';
import { ParentStudentBinding } from '../parent/parent.service';

// 32-char ULID 测试值
const PARENT_A = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNPA';
const STUDENT_1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNS1';
const STUDENT_2 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNS2';
const STUDENT_3 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNS3';
const TENANT_A = 'tenanta00000000000000000000000a1';
const TENANT_B = 'tenantb00000000000000000000000b1';
const CAMPUS_A = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNCA';
const CAMPUS_B = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNCB';

const makeBinding = (
  studentId: string,
  tenantId: string,
  isPrimary = true,
): ParentStudentBinding => ({
  id: `bind${studentId.slice(0, 28)}`,
  parentId: PARENT_A,
  studentId,
  tenantId,
  isPrimary,
  relationship: 'mother',
  bindingStatus: 'active',
  boundAt: new Date('2026-01-01T00:00:00Z'),
});

const makeChild = (
  id: string,
  name: string,
  campusId: string | null = null,
  campusName: string | null = null,
): ChildBrief => ({
  id,
  name,
  campusId,
  campusName,
});

describe('CSideController.getTenantContexts (P0 T1 2026-05-23)', () => {
  let controller: CSideController;
  let parentRepoMock: { findChildrenByParent: jest.Mock; findParentById: jest.Mock };
  let csideRepoMock: { findChildrenByIds: jest.Mock };
  let pgMock: { query: jest.Mock; tenantQuery: jest.Mock };
  // P1-4 (2026-05-23): tenant-contexts 写 audit_log → 用例需 verify log 调用次数
  let auditLogMock: { log: jest.Mock };

  beforeEach(async () => {
    parentRepoMock = { findChildrenByParent: jest.fn(), findParentById: jest.fn() };
    csideRepoMock = { findChildrenByIds: jest.fn() };
    pgMock = { query: jest.fn(), tenantQuery: jest.fn() };
    auditLogMock = { log: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CSideController],
      providers: [
        { provide: ParentRepository, useValue: parentRepoMock },
        { provide: CSideRepository, useValue: csideRepoMock },
        { provide: AuditLogRepository, useValue: auditLogMock },
        { provide: PgPoolService, useValue: pgMock },
        { provide: ParentSelfGuard, useValue: { canActivate: () => true } },
      ],
    })
      // ParentSelfGuard 是 class-level @UseGuards, override 后避免守卫拦截
      .overrideGuard(ParentSelfGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<CSideController>(CSideController);
  });

  function makeReq(parentId: string | null = PARENT_A): any {
    return {
      // 与 tenant.middleware.attachParentUser 一致挂上 parent 信息
      parent: parentId
        ? { sub: parentId, parentId, role: 'parent' }
        : undefined,
      headers: {},
      ip: '127.0.0.1',
    };
  }

  describe('安全门: parent JWT 必须挂上', () => {
    it('parent JWT 缺失 → ForbiddenException', async () => {
      await expect(
        controller.getTenantContexts(makeReq(null)),
      ).rejects.toThrow(ForbiddenException);
      // 没 parentId → 不应查 binding
      expect(parentRepoMock.findChildrenByParent).not.toHaveBeenCalled();
      // P1-4: 无 parent 上下文 → 不写 audit
      expect(auditLogMock.log).not.toHaveBeenCalled();
    });
  });

  describe('用例 1: 0 binding → 空列表', () => {
    it('parent 没绑过任何孩子 → { contexts: [] }', async () => {
      parentRepoMock.findChildrenByParent.mockResolvedValueOnce([]);
      const result = await controller.getTenantContexts(makeReq());
      expect(result).toEqual({ contexts: [] });
      // 0 binding → 不应继续查 tenant / 不应查 children
      expect(pgMock.query).not.toHaveBeenCalled();
      expect(csideRepoMock.findChildrenByIds).not.toHaveBeenCalled();
      // P1-4: 0 binding 无 tenant 上下文 → 不写 audit (拍板决策)
      expect(auditLogMock.log).not.toHaveBeenCalled();
    });
  });

  describe('用例 2: 1 tenant 含 N children', () => {
    it('contexts 长度=1 / children 长度=N / mapping 正确', async () => {
      parentRepoMock.findChildrenByParent.mockResolvedValueOnce([
        makeBinding(STUDENT_1, TENANT_A, true), // primary
        makeBinding(STUDENT_2, TENANT_A, false), // 非 primary
      ]);
      pgMock.query.mockResolvedValueOnce([
        { id: TENANT_A, name: '机构 A' },
      ]);
      csideRepoMock.findChildrenByIds.mockResolvedValueOnce([
        makeChild(STUDENT_1, '小明', CAMPUS_A, '主校区'),
        makeChild(STUDENT_2, '小红', CAMPUS_B, '分校区'),
      ]);

      const result = await controller.getTenantContexts(makeReq());

      expect(result.contexts).toHaveLength(1);
      const ctx = result.contexts[0];
      expect(ctx.tenantId).toBe(TENANT_A);
      expect(ctx.tenantName).toBe('机构 A');
      expect(ctx.children).toHaveLength(2);

      // 按 studentId join 后顺序与 children SQL 顺序一致 (created_at ASC)
      const s1 = ctx.children.find((c) => c.studentId === STUDENT_1)!;
      const s2 = ctx.children.find((c) => c.studentId === STUDENT_2)!;
      expect(s1).toMatchObject({
        studentId: STUDENT_1,
        studentName: '小明',
        campusId: CAMPUS_A,
        campusName: '主校区',
        bindingStatus: 'active',
        isPrimary: true,
      });
      expect(s2).toMatchObject({
        studentId: STUDENT_2,
        studentName: '小红',
        campusId: CAMPUS_B,
        campusName: '分校区',
        bindingStatus: 'active',
        isPrimary: false,
      });

      // 仅一次 schema 查询 (单 tenant)
      expect(csideRepoMock.findChildrenByIds).toHaveBeenCalledTimes(1);
      expect(csideRepoMock.findChildrenByIds).toHaveBeenCalledWith(
        `tenant_${TENANT_A}`,
        [STUDENT_1, STUDENT_2],
      );

      // P1-4: 1 tenant happy path → audit 写 1 次, schema=tenant_<lower>, action 固定
      expect(auditLogMock.log).toHaveBeenCalledTimes(1);
      const [auditSchema, auditEntry] = auditLogMock.log.mock.calls[0];
      expect(auditSchema).toBe(`tenant_${TENANT_A.toLowerCase()}`);
      expect(auditEntry.action).toBe('c.tenant-contexts.read');
      expect(auditEntry.actorUserId).toBe(PARENT_A);
      expect(auditEntry.actorRole).toBe('parent');
      expect(auditEntry.targetType).toBe('parent');
      expect(auditEntry.targetId).toBe(PARENT_A);
      expect(auditEntry.after).toEqual({ contextCount: 1, tenantCount: 1 });
    });

    it('child campusId/campusName null 时透传 null (非空降级)', async () => {
      parentRepoMock.findChildrenByParent.mockResolvedValueOnce([
        makeBinding(STUDENT_1, TENANT_A),
      ]);
      pgMock.query.mockResolvedValueOnce([
        { id: TENANT_A, name: '机构 A' },
      ]);
      csideRepoMock.findChildrenByIds.mockResolvedValueOnce([
        makeChild(STUDENT_1, '小明'), // campusId/Name 默认 null
      ]);

      const result = await controller.getTenantContexts(makeReq());
      expect(result.contexts[0].children[0]).toMatchObject({
        studentId: STUDENT_1,
        studentName: '小明',
        campusId: null,
        campusName: null,
      });
      // P1-4: happy path → audit 写 1 次
      expect(auditLogMock.log).toHaveBeenCalledTimes(1);
    });
  });

  describe('用例 3: 2+ tenant 各 N children → 跨 tenant 聚合', () => {
    it('contexts 长度=2 / 每 tenant children 正确分组', async () => {
      parentRepoMock.findChildrenByParent.mockResolvedValueOnce([
        makeBinding(STUDENT_1, TENANT_A, true),
        makeBinding(STUDENT_2, TENANT_B, true),
        makeBinding(STUDENT_3, TENANT_B, false),
      ]);
      pgMock.query.mockResolvedValueOnce([
        { id: TENANT_A, name: '机构 A' },
        { id: TENANT_B, name: '机构 B' },
      ]);
      // 按 tenant 调用顺序: A 先 B 后 (Map insertion order = bindings 序)
      csideRepoMock.findChildrenByIds
        .mockResolvedValueOnce([makeChild(STUDENT_1, '小明')]) // tenant A
        .mockResolvedValueOnce([
          makeChild(STUDENT_2, '小红'),
          makeChild(STUDENT_3, '小李'),
        ]); // tenant B

      const result = await controller.getTenantContexts(makeReq());

      expect(result.contexts).toHaveLength(2);
      // tenant A
      const ctxA = result.contexts.find((c) => c.tenantId === TENANT_A)!;
      expect(ctxA.tenantName).toBe('机构 A');
      expect(ctxA.children).toHaveLength(1);
      expect(ctxA.children[0].studentId).toBe(STUDENT_1);
      expect(ctxA.children[0].isPrimary).toBe(true);

      // tenant B
      const ctxB = result.contexts.find((c) => c.tenantId === TENANT_B)!;
      expect(ctxB.tenantName).toBe('机构 B');
      expect(ctxB.children).toHaveLength(2);
      const sB1 = ctxB.children.find((c) => c.studentId === STUDENT_2)!;
      const sB2 = ctxB.children.find((c) => c.studentId === STUDENT_3)!;
      expect(sB1.isPrimary).toBe(true);
      expect(sB2.isPrimary).toBe(false);

      // 2 次 schema 查询 (按 tenant 分组)
      expect(csideRepoMock.findChildrenByIds).toHaveBeenCalledTimes(2);
      expect(csideRepoMock.findChildrenByIds).toHaveBeenCalledWith(
        `tenant_${TENANT_A}`,
        [STUDENT_1],
      );
      expect(csideRepoMock.findChildrenByIds).toHaveBeenCalledWith(
        `tenant_${TENANT_B}`,
        [STUDENT_2, STUDENT_3],
      );

      // P1-4: 2 tenant 聚合 → audit 写 1 次, schema=首个 tenant, tenantCount=2
      expect(auditLogMock.log).toHaveBeenCalledTimes(1);
      const [auditSchema, auditEntry] = auditLogMock.log.mock.calls[0];
      expect(auditSchema).toBe(`tenant_${TENANT_A.toLowerCase()}`); // 首个 tenant
      expect(auditEntry.action).toBe('c.tenant-contexts.read');
      expect(auditEntry.after).toEqual({ contextCount: 2, tenantCount: 2 });
    });

    it('tenant 名查询 fallback: public.tenants 缺行 → 走 "(机构名待定)"', async () => {
      parentRepoMock.findChildrenByParent.mockResolvedValueOnce([
        makeBinding(STUDENT_1, TENANT_A),
      ]);
      // public.tenants 没有此 tenant row (异常数据完整性)
      pgMock.query.mockResolvedValueOnce([]);
      csideRepoMock.findChildrenByIds.mockResolvedValueOnce([
        makeChild(STUDENT_1, '小明'),
      ]);

      const result = await controller.getTenantContexts(makeReq());
      expect(result.contexts[0].tenantName).toBe('(机构名待定)');
      // P1-4: tenant 名 fallback 仍 happy path → audit 写 1 次
      expect(auditLogMock.log).toHaveBeenCalledTimes(1);
    });
  });

  describe('安全 fail-close: 任何子查询 reject → throw 整体 500', () => {
    it('parentRepo 抛错 → 透传 (不返部分数据)', async () => {
      parentRepoMock.findChildrenByParent.mockRejectedValueOnce(
        new Error('PG connection lost'),
      );
      await expect(controller.getTenantContexts(makeReq())).rejects.toThrow(
        'PG connection lost',
      );
      // P1-4: 主流程 throw 前 audit 未到达写入分支
      expect(auditLogMock.log).not.toHaveBeenCalled();
    });

    it('cside.findChildrenByIds 抛错 → 透传 (不允许 swallow 返部分 contexts)', async () => {
      parentRepoMock.findChildrenByParent.mockResolvedValueOnce([
        makeBinding(STUDENT_1, TENANT_A),
        makeBinding(STUDENT_2, TENANT_B),
      ]);
      pgMock.query.mockResolvedValueOnce([
        { id: TENANT_A, name: '机构 A' },
        { id: TENANT_B, name: '机构 B' },
      ]);
      // tenant A 成功, tenant B 抛错 → Promise.all reject 整体 throw
      csideRepoMock.findChildrenByIds
        .mockResolvedValueOnce([makeChild(STUDENT_1, '小明')])
        .mockRejectedValueOnce(new Error('tenant B schema dropped'));

      await expect(controller.getTenantContexts(makeReq())).rejects.toThrow(
        'tenant B schema dropped',
      );
      // P1-4: 聚合阶段 throw 前 audit 未到达写入分支
      expect(auditLogMock.log).not.toHaveBeenCalled();
    });
  });
});

// P1-3 (2026-05-23): getMyProfile NotFoundException message='PARENT_NOT_FOUND'
//   错误 body 不再暴露内部 ULID, 完整 parentId 仅 server-side log 保留
describe('CSideController.getMyProfile (P1-3 2026-05-23 A05 内部 ID 不透传)', () => {
  let controller: CSideController;
  let parentRepoMock: { findChildrenByParent: jest.Mock; findParentById: jest.Mock };

  beforeEach(async () => {
    parentRepoMock = { findChildrenByParent: jest.fn(), findParentById: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CSideController],
      providers: [
        { provide: ParentRepository, useValue: parentRepoMock },
        { provide: CSideRepository, useValue: { findChildrenByIds: jest.fn() } },
        { provide: AuditLogRepository, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        { provide: PgPoolService, useValue: { query: jest.fn() } },
        { provide: ParentSelfGuard, useValue: { canActivate: () => true } },
      ],
    })
      .overrideGuard(ParentSelfGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<CSideController>(CSideController);
  });

  function makeReqMine(parentId: string | null = PARENT_A): any {
    return {
      parent: parentId ? { sub: parentId, parentId, role: 'parent' } : undefined,
      headers: {},
      ip: '127.0.0.1',
    };
  }

  it('parent JWT 缺失 → ForbiddenException (无 parent 上下文)', async () => {
    await expect(controller.getMyProfile(makeReqMine(null))).rejects.toThrow(
      ForbiddenException,
    );
    expect(parentRepoMock.findParentById).not.toHaveBeenCalled();
  });

  it('findParentById 返 null → NotFoundException(PARENT_NOT_FOUND) 不含内部 ULID', async () => {
    parentRepoMock.findParentById.mockResolvedValueOnce(null);
    let caught: NotFoundException | undefined;
    try {
      await controller.getMyProfile(makeReqMine());
    } catch (e) {
      caught = e as NotFoundException;
    }
    expect(caught).toBeInstanceOf(NotFoundException);
    // message 必须是固定常量, 不含 PARENT_A (内部 ULID)
    expect(caught!.message).toBe('PARENT_NOT_FOUND');
    expect(caught!.message).not.toContain(PARENT_A);
  });
});

describe('CSideController.getFeedbackDetail — C 端反馈详情 family owner scope', () => {
  let controller: CSideController;
  let parentRepoMock: { findChildrenByParent: jest.Mock; findParentById: jest.Mock };
  let csideRepoMock: { findFeedbackDetailForParent: jest.Mock };

  const FEEDBACK_ID = 'fb000000000000000000000000000001';

  beforeEach(async () => {
    parentRepoMock = { findChildrenByParent: jest.fn(), findParentById: jest.fn() };
    csideRepoMock = { findFeedbackDetailForParent: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CSideController],
      providers: [
        { provide: ParentRepository, useValue: parentRepoMock },
        { provide: CSideRepository, useValue: csideRepoMock },
        { provide: AuditLogRepository, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        { provide: PgPoolService, useValue: { query: jest.fn() } },
        { provide: ParentSelfGuard, useValue: { canActivate: () => true } },
      ],
    })
      .overrideGuard(ParentSelfGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<CSideController>(CSideController);
  });

  function makeReqFeedback(parentId: string | null = PARENT_A): any {
    return {
      parent: parentId ? { sub: parentId, parentId, role: 'parent' } : undefined,
      tenantSchema: `tenant_${TENANT_A}`,
      headers: {},
      ip: '127.0.0.1',
    };
  }

  it('绑定孩子的反馈 → 返回详情，并按当前 tenant 的 active bindings scope 查询', async () => {
    parentRepoMock.findChildrenByParent.mockResolvedValueOnce([
      makeBinding(STUDENT_1, TENANT_A),
      makeBinding(STUDENT_2, TENANT_B),
    ]);
    csideRepoMock.findFeedbackDetailForParent.mockResolvedValueOnce({
      id: FEEDBACK_ID,
      studentId: STUDENT_1,
      teacherInternalNote: null,
    });

    const result = await controller.getFeedbackDetail(FEEDBACK_ID, makeReqFeedback());

    expect(csideRepoMock.findFeedbackDetailForParent).toHaveBeenCalledWith(
      `tenant_${TENANT_A}`,
      FEEDBACK_ID,
      [STUDENT_1],
    );
    expect(result).toMatchObject({ id: FEEDBACK_ID, studentId: STUDENT_1 });
  });

  it('反馈不存在或不属于该家长 → 403，不泄露资源是否存在', async () => {
    parentRepoMock.findChildrenByParent.mockResolvedValueOnce([
      makeBinding(STUDENT_1, TENANT_A),
    ]);
    csideRepoMock.findFeedbackDetailForParent.mockResolvedValueOnce(null);

    await expect(
      controller.getFeedbackDetail(FEEDBACK_ID, makeReqFeedback()),
    ).rejects.toThrow(ForbiddenException);
  });

  it('feedbackId 非 32 位 → 400', async () => {
    await expect(
      controller.getFeedbackDetail('bad-id', makeReqFeedback()),
    ).rejects.toThrow(BadRequestException);
    expect(parentRepoMock.findChildrenByParent).not.toHaveBeenCalled();
  });
});
