/**
 * #3a 复现单测 — 销售新建客户「设为家长端账户」绑定失败排查
 *
 * 场景：POST /db/customers body.setAsParentAccount=true → createFromCustomerInDb
 *   真机生产（dab2aab）报 parentAccountSet:false。
 *
 * 本 spec 目标：
 *   1. happy path（全新客户 + 合法 11 位手机 + 0 现有绑定）断言 parentAccountSet 路径全绿
 *      → 若 service 逻辑层全绿，则真因在 DB/migration/数据层（环境），非纯代码 logic。
 *   2. 逐一构造候选失败点（tenantId 非 32 / phone UNIQUE 冲突未复用 / insertParent throw），
 *      断言现状行为，定位最可能触发点。
 *
 * mock pg/encryptor/repo（不连真库）。
 */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { ParentService, Parent, ParentStudentBinding, Relationship } from './parent.service';

const ULID32_PARENT = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMP01';
const ULID32_STUDENT = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMST1';
const ULID32_TENANT = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMTN1';
const ULID32_BINDING = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMBN1';
const PHONE_NEW = '13800009999';

/**
 * ParentRepository mock — 全套方法（默认 happy path：phone miss → 新建 → 0 binding → insert）
 *
 * insertParent / insertBinding 默认透传（模拟 DB INSERT 成功）；
 * 单测可覆盖 insertParent 模拟 DB 约束抛错（status CHECK / phone UNIQUE）。
 */
function makeRepoMock(overrides: Partial<Record<string, jest.Mock>> = {}) {
  const base = {
    findParentByPhone: jest.fn().mockResolvedValue(null), // 默认 miss → 新建
    insertParent: jest.fn(async (p: Parent) => p), // 透传（模拟 INSERT 成功）
    findActiveBindingsForStudent: jest.fn().mockResolvedValue([]), // 默认 0 绑定
    insertBinding: jest.fn(async (b: ParentStudentBinding) => b), // 透传
    findParentById: jest.fn(),
    findChildrenByParent: jest.fn().mockResolvedValue([]),
    findChildrenByParentEnriched: jest.fn().mockResolvedValue([]),
    unbind: jest.fn(),
  };
  return { ...base, ...overrides };
}

describe('#3a ParentService.createFromCustomerInDb — 设为家长端账户绑定', () => {
  describe('happy path（全新客户 + 合法手机 + 0 绑定）', () => {
    it('#3a 根因回归：phone miss → 新建 parent + INSERT binding → isNewParent=true', async () => {
      // 修复前：createFromCustomerInDb 用裸 ulid()（26-char）→ registerParent 抛
      //   BadRequestException('parent id must be 32-char ULID') → 被 controller 吞成 parentAccountSet:false。
      // 修复后：genId32() 生成 32-char ULID，registerParent / createBinding 校验通过。
      const repo = makeRepoMock();
      const svc = new ParentService(repo as any);

      const result = await svc.createFromCustomerInDb({
        studentId: ULID32_STUDENT,
        tenantId: ULID32_TENANT,
        phone: PHONE_NEW,
        name: '王女士',
      });

      expect(result.isNewParent).toBe(true);
      expect(result.parent.phone).toBe(PHONE_NEW);
      // #3a 核心断言：新建 parent id 必须是 32-char（不是裸 ulid 的 26-char）
      expect(result.parent.id).toHaveLength(32);
      expect(result.binding.id).toHaveLength(32);
      expect(result.binding.studentId).toBe(ULID32_STUDENT);
      expect(result.binding.tenantId).toBe(ULID32_TENANT);
      expect(result.binding.isPrimary).toBe(true); // 首个家长
      expect(result.binding.relationship).toBe('mother'); // 默认
      expect(repo.insertParent).toHaveBeenCalledTimes(1);
      expect(repo.insertBinding).toHaveBeenCalledTimes(1);
      // insertParent 收到的 parent id 必须 32-char（防止再次回退裸 ulid）
      expect((repo.insertParent.mock.calls[0][0] as Parent).id).toHaveLength(32);
      expect((repo.insertBinding.mock.calls[0][0] as ParentStudentBinding).id).toHaveLength(32);
    });

    it('phone hit（跨 tenant 已存在）→ 复用 parent，不重建', async () => {
      const existingParent: Parent = {
        id: ULID32_PARENT,
        phone: PHONE_NEW,
        name: '王女士',
        status: '启用',
      };
      const repo = makeRepoMock({
        findParentByPhone: jest.fn().mockResolvedValue(existingParent),
      });
      const svc = new ParentService(repo as any);

      const result = await svc.createFromCustomerInDb({
        studentId: ULID32_STUDENT,
        tenantId: ULID32_TENANT,
        phone: PHONE_NEW,
        name: '王女士',
      });

      expect(result.isNewParent).toBe(false);
      expect(result.parent.id).toBe(ULID32_PARENT);
      expect(repo.insertParent).not.toHaveBeenCalled(); // 复用，不重建
      expect(repo.insertBinding).toHaveBeenCalledTimes(1);
    });

    it('同 parent+student 已绑 → 幂等返回，不重复 INSERT', async () => {
      const existingParent: Parent = {
        id: ULID32_PARENT,
        phone: PHONE_NEW,
        status: '启用',
      };
      const existingBinding: ParentStudentBinding = {
        id: ULID32_BINDING,
        parentId: ULID32_PARENT,
        studentId: ULID32_STUDENT,
        tenantId: ULID32_TENANT,
        isPrimary: true,
        relationship: 'mother',
        bindingStatus: 'active',
        boundAt: new Date(),
      };
      const repo = makeRepoMock({
        findParentByPhone: jest.fn().mockResolvedValue(existingParent),
        findActiveBindingsForStudent: jest.fn().mockResolvedValue([existingBinding]),
      });
      const svc = new ParentService(repo as any);

      const result = await svc.createFromCustomerInDb({
        studentId: ULID32_STUDENT,
        tenantId: ULID32_TENANT,
        phone: PHONE_NEW,
      });

      expect(result.binding.id).toBe(ULID32_BINDING); // 幂等返回原 binding
      expect(repo.insertBinding).not.toHaveBeenCalled();
    });
  });

  // -------- 防御性校验 + error 可诊断性（非 #3a 根因，但确认 error 透传不被吞模糊） --------
  describe('防御性校验 + error 透传', () => {
    it('tenantId 非 32 字符 → BadRequestException（input 校验，未到 DB，提前明确报错）', async () => {
      const repo = makeRepoMock();
      const svc = new ParentService(repo as any);
      await expect(
        svc.createFromCustomerInDb({
          studentId: ULID32_STUDENT,
          tenantId: 'tenant_short', // 非 32-char ULID
          phone: PHONE_NEW,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(repo.insertParent).not.toHaveBeenCalled();
    });

    it('insertParent 抛 status CHECK 违反（V47 未部署假想）→ 真实 DB error 透传（不被换成模糊 message）', async () => {
      const repo = makeRepoMock({
        insertParent: jest.fn().mockRejectedValue(
          Object.assign(new Error('new row for relation "parents" violates check constraint "parents_status_check"'), {
            code: '23514',
            constraint: 'parents_status_check',
          }),
        ),
      });
      const svc = new ParentService(repo as any);
      await expect(
        svc.createFromCustomerInDb({
          studentId: ULID32_STUDENT,
          tenantId: ULID32_TENANT,
          phone: PHONE_NEW,
        }),
      ).rejects.toThrow(/parents_status_check/);
    });

    it('phone UNIQUE 冲突（findParentByPhone miss 但 phone 实际已存在）→ insertParent 23505 透传', async () => {
      // 模拟 hash 列 miss（旧数据 phone_hash=NULL 且明文列不匹配/已加密）但 phone 唯一键实际冲突
      const repo = makeRepoMock({
        findParentByPhone: jest.fn().mockResolvedValue(null), // MISS
        insertParent: jest.fn().mockRejectedValue(
          Object.assign(new Error('duplicate key value violates unique constraint "parents_phone_key"'), {
            code: '23505',
            constraint: 'parents_phone_key',
          }),
        ),
      });
      const svc = new ParentService(repo as any);
      await expect(
        svc.createFromCustomerInDb({
          studentId: ULID32_STUDENT,
          tenantId: ULID32_TENANT,
          phone: PHONE_NEW,
        }),
      ).rejects.toThrow(/parents_phone_key|duplicate key/);
    });
  });
});
