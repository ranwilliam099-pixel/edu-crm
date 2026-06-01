/**
 * Auto-generated RBAC spec — Batch D (字段级权限矩阵 visible / masked / hidden)
 *
 * !!! 禁止手改 !!! 改 src/__rbac__/manifest.json + 重跑 scripts/generate-rbac-spec.js
 *
 * 生成时间: 2026-05-20
 * 来源: docs/SSOT-拍板权威.md §1 角色 + §4 字段矩阵 + §6 操作权限矩阵
 *
 * 测试目标:
 *   验证 RoleFieldFilter.maskCustomer / maskTeacher / maskContract 三个 mask 函数,
 *   外加 canAccessStudent / canAccessContract / canAccessCustomer 三个 access 函数
 *   + actorGroupOf role → group 映射 — 13 角色组路由判定一致性
 *
 * 与 Batch A/B/C 区别:
 *   - Batch A/B: controller-level @Roles (RbacGuard.canActivate)
 *   - Batch C:   跨 tenant 拦截 (TenantScopeGuard.canActivate)
 *   - Batch D:   字段级数据过滤 (mask*() / canAccess*())  ← 本批
 *
 * 总 case 数: 496
 *   customer: 12 字段 × 13 角色变体 = 156 case
 *   teacher:  9 字段 × 13 角色变体 = 117 case
 *   contract: 12 字段 × 13 角色变体 = 156 case
 *   student:  3 access field × 13 角色变体 = 40 case
 *   parent:   role_group_mapping × 13 角色 = 13 case
 *   corner:   14 case (user undefined / null role / fixture immutability / actorGroupOf edge / canAccess public pool)
 *
 * 角色变体扩展 (本批特有):
 *   - sales_owner: sales 角色 + isOwnerSelf=true
 *   - sales_other: sales 角色 + isOwnerSelf=false
 *   - teacher_self: teacher 角色 + isSelf=true
 *   - teacher_other: teacher 角色 + isSelf=false
 *
 * 强约束 (反 agent 偷懒):
 *   - 每个 case 调真 RoleFieldFilter.mask*() / canAccess*() 函数, 不假设行为
 *   - visible: 字段保留原值 (toBe / toEqual)
 *   - masked:  字段值变 null / 0 / undefined (按字段类型, 不为原值)
 *   - hidden:  字段不在返回对象上 (toBeUndefined)
 *   - manifest 与 mask 函数不一致 → 此 spec FAIL = 揭露 RoleFieldFilter bug
 */
import {
  maskCustomer,
  maskTeacher,
  maskContract,
  canAccessCustomer,
  canAccessContract,
  canAccessStudent,
  actorGroupOf,
} from '../../../common/role-field-filter/role-field-filter';
import { JwtPayload, TenantRole } from '../../../modules/auth/jwt-payload.interface';
import { Customer } from '../../../modules/db/customer.repository';
import { Contract } from '../../../modules/db/contract.repository';
import { Teacher } from '../../../modules/teacher/teacher.service';

// ============================================================
// Fixtures (固定原始值，便于断言)
// ============================================================

const TENANT_A = 'TENANTA00000000000000000000000A1';
const CAMPUS_A = 'campus_A0000000000000000000000A01';
const USER_OWNER = 'salesA00000000000000000000000A01';
const USER_OTHER = 'salesB00000000000000000000000A02';
const TEACHER_OWN = 'teacher00000000000000000000A001';
const TEACHER_OTHER = 'teacherX0000000000000000000A099';

type AnyRoleForTest = TenantRole | 'parent';

function jwt(role: AnyRoleForTest, sub: string = USER_OWNER): JwtPayload {
  return { sub, tenantId: TENANT_A, role: role as TenantRole, campusId: CAMPUS_A };
}

function customerFixture(): Customer {
  return {
    id: 'oppor000000000000000000000000A01',
    studentId: 'student00000000000000000000A001',
    studentName: "小明",
    gradeOrAge: '三年级',
    intendedSubject: "英语",
    ownerUserId: USER_OWNER,
    stage: "初步接触",
    source: "抖音",
    phone: "13800138000",
    wechat: "wx_parent_abc",
    intentLevel: "高",
    urgent: false,
    note: "内部跟进备注",
    enteredPoolAt: null,
    enterPoolReason: null,
    lastContactAt: '2026-05-10T10:00:00.000Z',
    signedAt: null,
    lostReason: null,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-10T10:00:00.000Z',
  };
}

function teacherFixture(): Teacher {
  // Day 2 Phase C X1 (2026-05-19 D1.4 拍板): hourlyPriceYuan 字段物理删除
  return {
    id: TEACHER_OWN,
    campusId: CAMPUS_A,
    name: "王老师",
    phone: "13900139000",
    userId: USER_OWNER,
    subjects: ["数学","物理"],
    status: "在职",
  };
}

function contractFixture(): Contract {
  return {
    id: 'contract0000000000000000000A001',
    studentId: 'student00000000000000000000A001',
    courseProductId: null,
    courseProductName: "一对一英语",
    ownerUserId: USER_OWNER,
    opportunityId: 'oppor000000000000000000000000A01',
    campusId: CAMPUS_A,
    classType: "一对一",
    lessonHours: 60,
    standardPrice: 9999,
    discountAmount: 999,
    giftHours: 5,
    totalAmount: 9000,
    orderType: '新签',
    status: "active",
    paidLocked: false,
    signedAt: '2026-05-08T00:00:00.000Z',
    activatedAt: '2026-05-08T00:00:00.000Z',
    createdAt: '2026-05-08T00:00:00.000Z',
    updatedAt: '2026-05-08T00:00:00.000Z',
  };
}

/**
 * Helper: 调 maskCustomer 给定 role 变体 (sales_owner/sales_other 用 isOwnerSelf 区分)
 * 返 actor's view of customer with role-specific mask
 */
function maskCustomerByRoleVariant(roleVariant: string): Customer {
  switch (roleVariant) {
    case 'sales_owner':
      return maskCustomer(customerFixture(), jwt('sales', USER_OWNER), { isOwnerSelf: true });
    case 'sales_other':
      return maskCustomer(customerFixture(), jwt('sales', USER_OTHER), { isOwnerSelf: false });
    case 'unknown':
      return maskCustomer(customerFixture(), { sub: 'x', tenantId: TENANT_A, role: 'foobar' as TenantRole, campusId: CAMPUS_A });
    default:
      return maskCustomer(customerFixture(), jwt(roleVariant as AnyRoleForTest));
  }
}

function maskTeacherByRoleVariant(roleVariant: string): Teacher {
  switch (roleVariant) {
    case 'teacher_self':
      return maskTeacher(teacherFixture(), jwt('teacher', USER_OWNER), { isSelf: true });
    case 'teacher_other':
      return maskTeacher(teacherFixture(), jwt('teacher', USER_OTHER), { isSelf: false });
    case 'unknown':
      return maskTeacher(teacherFixture(), { sub: 'x', tenantId: TENANT_A, role: 'foobar' as TenantRole, campusId: CAMPUS_A });
    default:
      return maskTeacher(teacherFixture(), jwt(roleVariant as AnyRoleForTest));
  }
}

function maskContractByRoleVariant(roleVariant: string): Contract {
  switch (roleVariant) {
    case 'sales_owner':
      return maskContract(contractFixture(), jwt('sales', USER_OWNER), { isOwnerSelf: true });
    case 'sales_other':
      return maskContract(contractFixture(), jwt('sales', USER_OTHER), { isOwnerSelf: false });
    case 'unknown':
      return maskContract(contractFixture(), { sub: 'x', tenantId: TENANT_A, role: 'foobar' as TenantRole, campusId: CAMPUS_A });
    default:
      return maskContract(contractFixture(), jwt(roleVariant as AnyRoleForTest));
  }
}

describe('[RBAC L9 Batch D] 字段级权限矩阵 visible / masked / hidden = 496 case', () => {

  describe('customer (maskCustomer × 12 fields)', () => {
    describe('field: phone', () => {
      // PII 一级隐私（§5 手机仅自己销售/老板/校长明文；§4.1 2026-05-31 教务/老师/市场脱敏 138****）
      // visible=[admin,boss,sales_manager,sales_owner]
      // masked=[academic,academic_admin,marketing,sales_other,finance,teacher,hr,parent,unknown]
      // hidden=[]

      it('visible: admin → phone=13800138000', () => {
        const result = maskCustomerByRoleVariant('admin');
        expect((result as Customer & Record<string, unknown>).phone).toBe("13800138000");
      });
      it('visible: boss → phone=13800138000', () => {
        const result = maskCustomerByRoleVariant('boss');
        expect((result as Customer & Record<string, unknown>).phone).toBe("13800138000");
      });
      it('visible: sales_manager → phone=13800138000', () => {
        const result = maskCustomerByRoleVariant('sales_manager');
        expect((result as Customer & Record<string, unknown>).phone).toBe("13800138000");
      });
      it('visible: sales_owner → phone=13800138000', () => {
        const result = maskCustomerByRoleVariant('sales_owner');
        expect((result as Customer & Record<string, unknown>).phone).toBe("13800138000");
      });
      it('masked: academic → phone="138****8000"', () => {
        const result = maskCustomerByRoleVariant('academic');
        expect((result as Customer & Record<string, unknown>).phone).toBe("138****8000");
      });
      it('masked: academic_admin → phone="138****8000"', () => {
        const result = maskCustomerByRoleVariant('academic_admin');
        expect((result as Customer & Record<string, unknown>).phone).toBe("138****8000");
      });
      it('masked: marketing → phone="138****8000"', () => {
        const result = maskCustomerByRoleVariant('marketing');
        expect((result as Customer & Record<string, unknown>).phone).toBe("138****8000");
      });
      it('masked: sales_other → phone=null', () => {
        const result = maskCustomerByRoleVariant('sales_other');
        expect((result as Customer & Record<string, unknown>).phone).toBeNull();
      });
      it('masked: finance → phone=null', () => {
        const result = maskCustomerByRoleVariant('finance');
        expect((result as Customer & Record<string, unknown>).phone).toBeNull();
      });
      it('masked: teacher → phone=null', () => {
        const result = maskCustomerByRoleVariant('teacher');
        expect((result as Customer & Record<string, unknown>).phone).toBeNull();
      });
      it('masked: hr → phone=null', () => {
        const result = maskCustomerByRoleVariant('hr');
        expect((result as Customer & Record<string, unknown>).phone).toBeNull();
      });
      it('masked: parent → phone=null', () => {
        const result = maskCustomerByRoleVariant('parent');
        expect((result as Customer & Record<string, unknown>).phone).toBeNull();
      });
      it('masked: unknown → phone=null', () => {
        const result = maskCustomerByRoleVariant('unknown');
        expect((result as Customer & Record<string, unknown>).phone).toBeNull();
      });
    });

    describe('field: wechat', () => {
      // 联系人信息（微信非一级 PII；§4.1 教务/市场本校可见明文）
      // visible=[admin,boss,sales_manager,sales_owner,academic,academic_admin,marketing]
      // masked=[sales_other,finance,teacher,hr,parent,unknown]
      // hidden=[]

      it('visible: admin → wechat=wx_parent_abc', () => {
        const result = maskCustomerByRoleVariant('admin');
        expect((result as Customer & Record<string, unknown>).wechat).toBe("wx_parent_abc");
      });
      it('visible: boss → wechat=wx_parent_abc', () => {
        const result = maskCustomerByRoleVariant('boss');
        expect((result as Customer & Record<string, unknown>).wechat).toBe("wx_parent_abc");
      });
      it('visible: sales_manager → wechat=wx_parent_abc', () => {
        const result = maskCustomerByRoleVariant('sales_manager');
        expect((result as Customer & Record<string, unknown>).wechat).toBe("wx_parent_abc");
      });
      it('visible: sales_owner → wechat=wx_parent_abc', () => {
        const result = maskCustomerByRoleVariant('sales_owner');
        expect((result as Customer & Record<string, unknown>).wechat).toBe("wx_parent_abc");
      });
      it('visible: academic → wechat=wx_parent_abc', () => {
        const result = maskCustomerByRoleVariant('academic');
        expect((result as Customer & Record<string, unknown>).wechat).toBe("wx_parent_abc");
      });
      it('visible: academic_admin → wechat=wx_parent_abc', () => {
        const result = maskCustomerByRoleVariant('academic_admin');
        expect((result as Customer & Record<string, unknown>).wechat).toBe("wx_parent_abc");
      });
      it('visible: marketing → wechat=wx_parent_abc', () => {
        const result = maskCustomerByRoleVariant('marketing');
        expect((result as Customer & Record<string, unknown>).wechat).toBe("wx_parent_abc");
      });
      it('masked: sales_other → wechat=null', () => {
        const result = maskCustomerByRoleVariant('sales_other');
        expect((result as Customer & Record<string, unknown>).wechat).toBeNull();
      });
      it('masked: finance → wechat=null', () => {
        const result = maskCustomerByRoleVariant('finance');
        expect((result as Customer & Record<string, unknown>).wechat).toBeNull();
      });
      it('masked: teacher → wechat=null', () => {
        const result = maskCustomerByRoleVariant('teacher');
        expect((result as Customer & Record<string, unknown>).wechat).toBeNull();
      });
      it('masked: hr → wechat=null', () => {
        const result = maskCustomerByRoleVariant('hr');
        expect((result as Customer & Record<string, unknown>).wechat).toBeNull();
      });
      it('masked: parent → wechat=null', () => {
        const result = maskCustomerByRoleVariant('parent');
        expect((result as Customer & Record<string, unknown>).wechat).toBeNull();
      });
      it('masked: unknown → wechat=null', () => {
        const result = maskCustomerByRoleVariant('unknown');
        expect((result as Customer & Record<string, unknown>).wechat).toBeNull();
      });
    });

    describe('field: source', () => {
      // 业务（销售渠道，仅销售看 / 教务市场不看）
      // visible=[admin,boss,sales_manager,sales_owner]
      // masked=[academic,academic_admin,sales_other,marketing,finance,teacher,hr,parent,unknown]
      // hidden=[]

      it('visible: admin → source=抖音', () => {
        const result = maskCustomerByRoleVariant('admin');
        expect((result as Customer & Record<string, unknown>).source).toBe("抖音");
      });
      it('visible: boss → source=抖音', () => {
        const result = maskCustomerByRoleVariant('boss');
        expect((result as Customer & Record<string, unknown>).source).toBe("抖音");
      });
      it('visible: sales_manager → source=抖音', () => {
        const result = maskCustomerByRoleVariant('sales_manager');
        expect((result as Customer & Record<string, unknown>).source).toBe("抖音");
      });
      it('visible: sales_owner → source=抖音', () => {
        const result = maskCustomerByRoleVariant('sales_owner');
        expect((result as Customer & Record<string, unknown>).source).toBe("抖音");
      });
      it('masked: academic → source=null', () => {
        const result = maskCustomerByRoleVariant('academic');
        expect((result as Customer & Record<string, unknown>).source).toBeNull();
      });
      it('masked: academic_admin → source=null', () => {
        const result = maskCustomerByRoleVariant('academic_admin');
        expect((result as Customer & Record<string, unknown>).source).toBeNull();
      });
      it('masked: sales_other → source=null', () => {
        const result = maskCustomerByRoleVariant('sales_other');
        expect((result as Customer & Record<string, unknown>).source).toBeNull();
      });
      it('masked: marketing → source=null', () => {
        const result = maskCustomerByRoleVariant('marketing');
        expect((result as Customer & Record<string, unknown>).source).toBeNull();
      });
      it('masked: finance → source=null', () => {
        const result = maskCustomerByRoleVariant('finance');
        expect((result as Customer & Record<string, unknown>).source).toBeNull();
      });
      it('masked: teacher → source=null', () => {
        const result = maskCustomerByRoleVariant('teacher');
        expect((result as Customer & Record<string, unknown>).source).toBeNull();
      });
      it('masked: hr → source=null', () => {
        const result = maskCustomerByRoleVariant('hr');
        expect((result as Customer & Record<string, unknown>).source).toBeNull();
      });
      it('masked: parent → source=null', () => {
        const result = maskCustomerByRoleVariant('parent');
        expect((result as Customer & Record<string, unknown>).source).toBeNull();
      });
      it('masked: unknown → source=null', () => {
        const result = maskCustomerByRoleVariant('unknown');
        expect((result as Customer & Record<string, unknown>).source).toBeNull();
      });
    });

    describe('field: note', () => {
      // 业务（销售跟进备注；§4.1 教务/市场本校可见）
      // visible=[admin,boss,sales_manager,sales_owner,academic,academic_admin,marketing]
      // masked=[sales_other,finance,teacher,hr,parent,unknown]
      // hidden=[]

      it('visible: admin → note=内部跟进备注', () => {
        const result = maskCustomerByRoleVariant('admin');
        expect((result as Customer & Record<string, unknown>).note).toBe("内部跟进备注");
      });
      it('visible: boss → note=内部跟进备注', () => {
        const result = maskCustomerByRoleVariant('boss');
        expect((result as Customer & Record<string, unknown>).note).toBe("内部跟进备注");
      });
      it('visible: sales_manager → note=内部跟进备注', () => {
        const result = maskCustomerByRoleVariant('sales_manager');
        expect((result as Customer & Record<string, unknown>).note).toBe("内部跟进备注");
      });
      it('visible: sales_owner → note=内部跟进备注', () => {
        const result = maskCustomerByRoleVariant('sales_owner');
        expect((result as Customer & Record<string, unknown>).note).toBe("内部跟进备注");
      });
      it('visible: academic → note=内部跟进备注', () => {
        const result = maskCustomerByRoleVariant('academic');
        expect((result as Customer & Record<string, unknown>).note).toBe("内部跟进备注");
      });
      it('visible: academic_admin → note=内部跟进备注', () => {
        const result = maskCustomerByRoleVariant('academic_admin');
        expect((result as Customer & Record<string, unknown>).note).toBe("内部跟进备注");
      });
      it('visible: marketing → note=内部跟进备注', () => {
        const result = maskCustomerByRoleVariant('marketing');
        expect((result as Customer & Record<string, unknown>).note).toBe("内部跟进备注");
      });
      it('masked: sales_other → note=null', () => {
        const result = maskCustomerByRoleVariant('sales_other');
        expect((result as Customer & Record<string, unknown>).note).toBeNull();
      });
      it('masked: finance → note=null', () => {
        const result = maskCustomerByRoleVariant('finance');
        expect((result as Customer & Record<string, unknown>).note).toBeNull();
      });
      it('masked: teacher → note=null', () => {
        const result = maskCustomerByRoleVariant('teacher');
        expect((result as Customer & Record<string, unknown>).note).toBeNull();
      });
      it('masked: hr → note=null', () => {
        const result = maskCustomerByRoleVariant('hr');
        expect((result as Customer & Record<string, unknown>).note).toBeNull();
      });
      it('masked: parent → note=null', () => {
        const result = maskCustomerByRoleVariant('parent');
        expect((result as Customer & Record<string, unknown>).note).toBeNull();
      });
      it('masked: unknown → note=null', () => {
        const result = maskCustomerByRoleVariant('unknown');
        expect((result as Customer & Record<string, unknown>).note).toBeNull();
      });
    });

    describe('field: stage', () => {
      // 业务参考（state machine，所有角色保留）
      // visible=[admin,boss,sales_manager,sales_owner,sales_other,marketing,academic,academic_admin,finance,teacher,hr,parent,unknown]
      // masked=[]
      // hidden=[]

      it('visible: admin → stage=初步接触', () => {
        const result = maskCustomerByRoleVariant('admin');
        expect((result as Customer & Record<string, unknown>).stage).toBe("初步接触");
      });
      it('visible: boss → stage=初步接触', () => {
        const result = maskCustomerByRoleVariant('boss');
        expect((result as Customer & Record<string, unknown>).stage).toBe("初步接触");
      });
      it('visible: sales_manager → stage=初步接触', () => {
        const result = maskCustomerByRoleVariant('sales_manager');
        expect((result as Customer & Record<string, unknown>).stage).toBe("初步接触");
      });
      it('visible: sales_owner → stage=初步接触', () => {
        const result = maskCustomerByRoleVariant('sales_owner');
        expect((result as Customer & Record<string, unknown>).stage).toBe("初步接触");
      });
      it('visible: sales_other → stage=初步接触', () => {
        const result = maskCustomerByRoleVariant('sales_other');
        expect((result as Customer & Record<string, unknown>).stage).toBe("初步接触");
      });
      it('visible: marketing → stage=初步接触', () => {
        const result = maskCustomerByRoleVariant('marketing');
        expect((result as Customer & Record<string, unknown>).stage).toBe("初步接触");
      });
      it('visible: academic → stage=初步接触', () => {
        const result = maskCustomerByRoleVariant('academic');
        expect((result as Customer & Record<string, unknown>).stage).toBe("初步接触");
      });
      it('visible: academic_admin → stage=初步接触', () => {
        const result = maskCustomerByRoleVariant('academic_admin');
        expect((result as Customer & Record<string, unknown>).stage).toBe("初步接触");
      });
      it('visible: finance → stage=初步接触', () => {
        const result = maskCustomerByRoleVariant('finance');
        expect((result as Customer & Record<string, unknown>).stage).toBe("初步接触");
      });
      it('visible: teacher → stage=初步接触', () => {
        const result = maskCustomerByRoleVariant('teacher');
        expect((result as Customer & Record<string, unknown>).stage).toBe("初步接触");
      });
      it('visible: hr → stage=初步接触', () => {
        const result = maskCustomerByRoleVariant('hr');
        expect((result as Customer & Record<string, unknown>).stage).toBe("初步接触");
      });
      it('visible: parent → stage=初步接触', () => {
        const result = maskCustomerByRoleVariant('parent');
        expect((result as Customer & Record<string, unknown>).stage).toBe("初步接触");
      });
      it('visible: unknown → stage=初步接触', () => {
        const result = maskCustomerByRoleVariant('unknown');
        expect((result as Customer & Record<string, unknown>).stage).toBe("初步接触");
      });
    });

    describe('field: studentName', () => {
      // 业务参考（学员姓名，所有角色保留）
      // visible=[admin,boss,sales_manager,sales_owner,sales_other,marketing,academic,academic_admin,finance,teacher,hr,parent,unknown]
      // masked=[]
      // hidden=[]

      it('visible: admin → studentName=小明', () => {
        const result = maskCustomerByRoleVariant('admin');
        expect((result as Customer & Record<string, unknown>).studentName).toBe("小明");
      });
      it('visible: boss → studentName=小明', () => {
        const result = maskCustomerByRoleVariant('boss');
        expect((result as Customer & Record<string, unknown>).studentName).toBe("小明");
      });
      it('visible: sales_manager → studentName=小明', () => {
        const result = maskCustomerByRoleVariant('sales_manager');
        expect((result as Customer & Record<string, unknown>).studentName).toBe("小明");
      });
      it('visible: sales_owner → studentName=小明', () => {
        const result = maskCustomerByRoleVariant('sales_owner');
        expect((result as Customer & Record<string, unknown>).studentName).toBe("小明");
      });
      it('visible: sales_other → studentName=小明', () => {
        const result = maskCustomerByRoleVariant('sales_other');
        expect((result as Customer & Record<string, unknown>).studentName).toBe("小明");
      });
      it('visible: marketing → studentName=小明', () => {
        const result = maskCustomerByRoleVariant('marketing');
        expect((result as Customer & Record<string, unknown>).studentName).toBe("小明");
      });
      it('visible: academic → studentName=小明', () => {
        const result = maskCustomerByRoleVariant('academic');
        expect((result as Customer & Record<string, unknown>).studentName).toBe("小明");
      });
      it('visible: academic_admin → studentName=小明', () => {
        const result = maskCustomerByRoleVariant('academic_admin');
        expect((result as Customer & Record<string, unknown>).studentName).toBe("小明");
      });
      it('visible: finance → studentName=小明', () => {
        const result = maskCustomerByRoleVariant('finance');
        expect((result as Customer & Record<string, unknown>).studentName).toBe("小明");
      });
      it('visible: teacher → studentName=小明', () => {
        const result = maskCustomerByRoleVariant('teacher');
        expect((result as Customer & Record<string, unknown>).studentName).toBe("小明");
      });
      it('visible: hr → studentName=小明', () => {
        const result = maskCustomerByRoleVariant('hr');
        expect((result as Customer & Record<string, unknown>).studentName).toBe("小明");
      });
      it('visible: parent → studentName=小明', () => {
        const result = maskCustomerByRoleVariant('parent');
        expect((result as Customer & Record<string, unknown>).studentName).toBe("小明");
      });
      it('visible: unknown → studentName=小明', () => {
        const result = maskCustomerByRoleVariant('unknown');
        expect((result as Customer & Record<string, unknown>).studentName).toBe("小明");
      });
    });

    describe('field: intendedSubject', () => {
      // 业务参考（意向学科，所有角色保留）
      // visible=[admin,boss,sales_manager,sales_owner,sales_other,marketing,academic,academic_admin,finance,teacher,hr,parent,unknown]
      // masked=[]
      // hidden=[]

      it('visible: admin → intendedSubject=英语', () => {
        const result = maskCustomerByRoleVariant('admin');
        expect((result as Customer & Record<string, unknown>).intendedSubject).toBe("英语");
      });
      it('visible: boss → intendedSubject=英语', () => {
        const result = maskCustomerByRoleVariant('boss');
        expect((result as Customer & Record<string, unknown>).intendedSubject).toBe("英语");
      });
      it('visible: sales_manager → intendedSubject=英语', () => {
        const result = maskCustomerByRoleVariant('sales_manager');
        expect((result as Customer & Record<string, unknown>).intendedSubject).toBe("英语");
      });
      it('visible: sales_owner → intendedSubject=英语', () => {
        const result = maskCustomerByRoleVariant('sales_owner');
        expect((result as Customer & Record<string, unknown>).intendedSubject).toBe("英语");
      });
      it('visible: sales_other → intendedSubject=英语', () => {
        const result = maskCustomerByRoleVariant('sales_other');
        expect((result as Customer & Record<string, unknown>).intendedSubject).toBe("英语");
      });
      it('visible: marketing → intendedSubject=英语', () => {
        const result = maskCustomerByRoleVariant('marketing');
        expect((result as Customer & Record<string, unknown>).intendedSubject).toBe("英语");
      });
      it('visible: academic → intendedSubject=英语', () => {
        const result = maskCustomerByRoleVariant('academic');
        expect((result as Customer & Record<string, unknown>).intendedSubject).toBe("英语");
      });
      it('visible: academic_admin → intendedSubject=英语', () => {
        const result = maskCustomerByRoleVariant('academic_admin');
        expect((result as Customer & Record<string, unknown>).intendedSubject).toBe("英语");
      });
      it('visible: finance → intendedSubject=英语', () => {
        const result = maskCustomerByRoleVariant('finance');
        expect((result as Customer & Record<string, unknown>).intendedSubject).toBe("英语");
      });
      it('visible: teacher → intendedSubject=英语', () => {
        const result = maskCustomerByRoleVariant('teacher');
        expect((result as Customer & Record<string, unknown>).intendedSubject).toBe("英语");
      });
      it('visible: hr → intendedSubject=英语', () => {
        const result = maskCustomerByRoleVariant('hr');
        expect((result as Customer & Record<string, unknown>).intendedSubject).toBe("英语");
      });
      it('visible: parent → intendedSubject=英语', () => {
        const result = maskCustomerByRoleVariant('parent');
        expect((result as Customer & Record<string, unknown>).intendedSubject).toBe("英语");
      });
      it('visible: unknown → intendedSubject=英语', () => {
        const result = maskCustomerByRoleVariant('unknown');
        expect((result as Customer & Record<string, unknown>).intendedSubject).toBe("英语");
      });
    });

    describe('field: intentLevel', () => {
      // 业务参考（意向等级，所有角色保留 — 不在 mask 字段列表）
      // visible=[admin,boss,sales_manager,sales_owner,sales_other,marketing,academic,academic_admin,finance,teacher,hr,parent,unknown]
      // masked=[]
      // hidden=[]

      it('visible: admin → intentLevel=高', () => {
        const result = maskCustomerByRoleVariant('admin');
        expect((result as Customer & Record<string, unknown>).intentLevel).toBe("高");
      });
      it('visible: boss → intentLevel=高', () => {
        const result = maskCustomerByRoleVariant('boss');
        expect((result as Customer & Record<string, unknown>).intentLevel).toBe("高");
      });
      it('visible: sales_manager → intentLevel=高', () => {
        const result = maskCustomerByRoleVariant('sales_manager');
        expect((result as Customer & Record<string, unknown>).intentLevel).toBe("高");
      });
      it('visible: sales_owner → intentLevel=高', () => {
        const result = maskCustomerByRoleVariant('sales_owner');
        expect((result as Customer & Record<string, unknown>).intentLevel).toBe("高");
      });
      it('visible: sales_other → intentLevel=高', () => {
        const result = maskCustomerByRoleVariant('sales_other');
        expect((result as Customer & Record<string, unknown>).intentLevel).toBe("高");
      });
      it('visible: marketing → intentLevel=高', () => {
        const result = maskCustomerByRoleVariant('marketing');
        expect((result as Customer & Record<string, unknown>).intentLevel).toBe("高");
      });
      it('visible: academic → intentLevel=高', () => {
        const result = maskCustomerByRoleVariant('academic');
        expect((result as Customer & Record<string, unknown>).intentLevel).toBe("高");
      });
      it('visible: academic_admin → intentLevel=高', () => {
        const result = maskCustomerByRoleVariant('academic_admin');
        expect((result as Customer & Record<string, unknown>).intentLevel).toBe("高");
      });
      it('visible: finance → intentLevel=高', () => {
        const result = maskCustomerByRoleVariant('finance');
        expect((result as Customer & Record<string, unknown>).intentLevel).toBe("高");
      });
      it('visible: teacher → intentLevel=高', () => {
        const result = maskCustomerByRoleVariant('teacher');
        expect((result as Customer & Record<string, unknown>).intentLevel).toBe("高");
      });
      it('visible: hr → intentLevel=高', () => {
        const result = maskCustomerByRoleVariant('hr');
        expect((result as Customer & Record<string, unknown>).intentLevel).toBe("高");
      });
      it('visible: parent → intentLevel=高', () => {
        const result = maskCustomerByRoleVariant('parent');
        expect((result as Customer & Record<string, unknown>).intentLevel).toBe("高");
      });
      it('visible: unknown → intentLevel=高', () => {
        const result = maskCustomerByRoleVariant('unknown');
        expect((result as Customer & Record<string, unknown>).intentLevel).toBe("高");
      });
    });

    describe('field: gradeOrAge', () => {
      // 业务参考（年级/年龄，所有角色保留）
      // visible=[admin,boss,sales_manager,sales_owner,sales_other,marketing,academic,academic_admin,finance,teacher,hr,parent,unknown]
      // masked=[]
      // hidden=[]

      it('visible: admin → gradeOrAge=三年级', () => {
        const result = maskCustomerByRoleVariant('admin');
        expect((result as Customer & Record<string, unknown>).gradeOrAge).toBe("三年级");
      });
      it('visible: boss → gradeOrAge=三年级', () => {
        const result = maskCustomerByRoleVariant('boss');
        expect((result as Customer & Record<string, unknown>).gradeOrAge).toBe("三年级");
      });
      it('visible: sales_manager → gradeOrAge=三年级', () => {
        const result = maskCustomerByRoleVariant('sales_manager');
        expect((result as Customer & Record<string, unknown>).gradeOrAge).toBe("三年级");
      });
      it('visible: sales_owner → gradeOrAge=三年级', () => {
        const result = maskCustomerByRoleVariant('sales_owner');
        expect((result as Customer & Record<string, unknown>).gradeOrAge).toBe("三年级");
      });
      it('visible: sales_other → gradeOrAge=三年级', () => {
        const result = maskCustomerByRoleVariant('sales_other');
        expect((result as Customer & Record<string, unknown>).gradeOrAge).toBe("三年级");
      });
      it('visible: marketing → gradeOrAge=三年级', () => {
        const result = maskCustomerByRoleVariant('marketing');
        expect((result as Customer & Record<string, unknown>).gradeOrAge).toBe("三年级");
      });
      it('visible: academic → gradeOrAge=三年级', () => {
        const result = maskCustomerByRoleVariant('academic');
        expect((result as Customer & Record<string, unknown>).gradeOrAge).toBe("三年级");
      });
      it('visible: academic_admin → gradeOrAge=三年级', () => {
        const result = maskCustomerByRoleVariant('academic_admin');
        expect((result as Customer & Record<string, unknown>).gradeOrAge).toBe("三年级");
      });
      it('visible: finance → gradeOrAge=三年级', () => {
        const result = maskCustomerByRoleVariant('finance');
        expect((result as Customer & Record<string, unknown>).gradeOrAge).toBe("三年级");
      });
      it('visible: teacher → gradeOrAge=三年级', () => {
        const result = maskCustomerByRoleVariant('teacher');
        expect((result as Customer & Record<string, unknown>).gradeOrAge).toBe("三年级");
      });
      it('visible: hr → gradeOrAge=三年级', () => {
        const result = maskCustomerByRoleVariant('hr');
        expect((result as Customer & Record<string, unknown>).gradeOrAge).toBe("三年级");
      });
      it('visible: parent → gradeOrAge=三年级', () => {
        const result = maskCustomerByRoleVariant('parent');
        expect((result as Customer & Record<string, unknown>).gradeOrAge).toBe("三年级");
      });
      it('visible: unknown → gradeOrAge=三年级', () => {
        const result = maskCustomerByRoleVariant('unknown');
        expect((result as Customer & Record<string, unknown>).gradeOrAge).toBe("三年级");
      });
    });

    describe('field: lastContactAt', () => {
      // 业务参考（最近联系时间，所有角色保留 — 不在 mask 字段列表）
      // visible=[admin,boss,sales_manager,sales_owner,sales_other,marketing,academic,academic_admin,finance,teacher,hr,parent,unknown]
      // masked=[]
      // hidden=[]

      it('visible: admin → lastContactAt=2026-05-10T10:00:00.000Z', () => {
        const result = maskCustomerByRoleVariant('admin');
        expect((result as Customer & Record<string, unknown>).lastContactAt).toBe("2026-05-10T10:00:00.000Z");
      });
      it('visible: boss → lastContactAt=2026-05-10T10:00:00.000Z', () => {
        const result = maskCustomerByRoleVariant('boss');
        expect((result as Customer & Record<string, unknown>).lastContactAt).toBe("2026-05-10T10:00:00.000Z");
      });
      it('visible: sales_manager → lastContactAt=2026-05-10T10:00:00.000Z', () => {
        const result = maskCustomerByRoleVariant('sales_manager');
        expect((result as Customer & Record<string, unknown>).lastContactAt).toBe("2026-05-10T10:00:00.000Z");
      });
      it('visible: sales_owner → lastContactAt=2026-05-10T10:00:00.000Z', () => {
        const result = maskCustomerByRoleVariant('sales_owner');
        expect((result as Customer & Record<string, unknown>).lastContactAt).toBe("2026-05-10T10:00:00.000Z");
      });
      it('visible: sales_other → lastContactAt=2026-05-10T10:00:00.000Z', () => {
        const result = maskCustomerByRoleVariant('sales_other');
        expect((result as Customer & Record<string, unknown>).lastContactAt).toBe("2026-05-10T10:00:00.000Z");
      });
      it('visible: marketing → lastContactAt=2026-05-10T10:00:00.000Z', () => {
        const result = maskCustomerByRoleVariant('marketing');
        expect((result as Customer & Record<string, unknown>).lastContactAt).toBe("2026-05-10T10:00:00.000Z");
      });
      it('visible: academic → lastContactAt=2026-05-10T10:00:00.000Z', () => {
        const result = maskCustomerByRoleVariant('academic');
        expect((result as Customer & Record<string, unknown>).lastContactAt).toBe("2026-05-10T10:00:00.000Z");
      });
      it('visible: academic_admin → lastContactAt=2026-05-10T10:00:00.000Z', () => {
        const result = maskCustomerByRoleVariant('academic_admin');
        expect((result as Customer & Record<string, unknown>).lastContactAt).toBe("2026-05-10T10:00:00.000Z");
      });
      it('visible: finance → lastContactAt=2026-05-10T10:00:00.000Z', () => {
        const result = maskCustomerByRoleVariant('finance');
        expect((result as Customer & Record<string, unknown>).lastContactAt).toBe("2026-05-10T10:00:00.000Z");
      });
      it('visible: teacher → lastContactAt=2026-05-10T10:00:00.000Z', () => {
        const result = maskCustomerByRoleVariant('teacher');
        expect((result as Customer & Record<string, unknown>).lastContactAt).toBe("2026-05-10T10:00:00.000Z");
      });
      it('visible: hr → lastContactAt=2026-05-10T10:00:00.000Z', () => {
        const result = maskCustomerByRoleVariant('hr');
        expect((result as Customer & Record<string, unknown>).lastContactAt).toBe("2026-05-10T10:00:00.000Z");
      });
      it('visible: parent → lastContactAt=2026-05-10T10:00:00.000Z', () => {
        const result = maskCustomerByRoleVariant('parent');
        expect((result as Customer & Record<string, unknown>).lastContactAt).toBe("2026-05-10T10:00:00.000Z");
      });
      it('visible: unknown → lastContactAt=2026-05-10T10:00:00.000Z', () => {
        const result = maskCustomerByRoleVariant('unknown');
        expect((result as Customer & Record<string, unknown>).lastContactAt).toBe("2026-05-10T10:00:00.000Z");
      });
    });

    describe('field: id', () => {
      // 业务参考（customer id 主键 ULID，所有角色保留）
      // visible=[admin,boss,sales_manager,sales_owner,sales_other,marketing,academic,academic_admin,finance,teacher,hr,parent,unknown]
      // masked=[]
      // hidden=[]

      it('visible: admin → id=oppor000000000000000000000000A01', () => {
        const result = maskCustomerByRoleVariant('admin');
        expect((result as Customer & Record<string, unknown>).id).toBe("oppor000000000000000000000000A01");
      });
      it('visible: boss → id=oppor000000000000000000000000A01', () => {
        const result = maskCustomerByRoleVariant('boss');
        expect((result as Customer & Record<string, unknown>).id).toBe("oppor000000000000000000000000A01");
      });
      it('visible: sales_manager → id=oppor000000000000000000000000A01', () => {
        const result = maskCustomerByRoleVariant('sales_manager');
        expect((result as Customer & Record<string, unknown>).id).toBe("oppor000000000000000000000000A01");
      });
      it('visible: sales_owner → id=oppor000000000000000000000000A01', () => {
        const result = maskCustomerByRoleVariant('sales_owner');
        expect((result as Customer & Record<string, unknown>).id).toBe("oppor000000000000000000000000A01");
      });
      it('visible: sales_other → id=oppor000000000000000000000000A01', () => {
        const result = maskCustomerByRoleVariant('sales_other');
        expect((result as Customer & Record<string, unknown>).id).toBe("oppor000000000000000000000000A01");
      });
      it('visible: marketing → id=oppor000000000000000000000000A01', () => {
        const result = maskCustomerByRoleVariant('marketing');
        expect((result as Customer & Record<string, unknown>).id).toBe("oppor000000000000000000000000A01");
      });
      it('visible: academic → id=oppor000000000000000000000000A01', () => {
        const result = maskCustomerByRoleVariant('academic');
        expect((result as Customer & Record<string, unknown>).id).toBe("oppor000000000000000000000000A01");
      });
      it('visible: academic_admin → id=oppor000000000000000000000000A01', () => {
        const result = maskCustomerByRoleVariant('academic_admin');
        expect((result as Customer & Record<string, unknown>).id).toBe("oppor000000000000000000000000A01");
      });
      it('visible: finance → id=oppor000000000000000000000000A01', () => {
        const result = maskCustomerByRoleVariant('finance');
        expect((result as Customer & Record<string, unknown>).id).toBe("oppor000000000000000000000000A01");
      });
      it('visible: teacher → id=oppor000000000000000000000000A01', () => {
        const result = maskCustomerByRoleVariant('teacher');
        expect((result as Customer & Record<string, unknown>).id).toBe("oppor000000000000000000000000A01");
      });
      it('visible: hr → id=oppor000000000000000000000000A01', () => {
        const result = maskCustomerByRoleVariant('hr');
        expect((result as Customer & Record<string, unknown>).id).toBe("oppor000000000000000000000000A01");
      });
      it('visible: parent → id=oppor000000000000000000000000A01', () => {
        const result = maskCustomerByRoleVariant('parent');
        expect((result as Customer & Record<string, unknown>).id).toBe("oppor000000000000000000000000A01");
      });
      it('visible: unknown → id=oppor000000000000000000000000A01', () => {
        const result = maskCustomerByRoleVariant('unknown');
        expect((result as Customer & Record<string, unknown>).id).toBe("oppor000000000000000000000000A01");
      });
    });

    describe('field: studentId', () => {
      // 业务参考（关联 student id，所有角色保留）
      // visible=[admin,boss,sales_manager,sales_owner,sales_other,marketing,academic,academic_admin,finance,teacher,hr,parent,unknown]
      // masked=[]
      // hidden=[]

      it('visible: admin → studentId=student00000000000000000000A001', () => {
        const result = maskCustomerByRoleVariant('admin');
        expect((result as Customer & Record<string, unknown>).studentId).toBe("student00000000000000000000A001");
      });
      it('visible: boss → studentId=student00000000000000000000A001', () => {
        const result = maskCustomerByRoleVariant('boss');
        expect((result as Customer & Record<string, unknown>).studentId).toBe("student00000000000000000000A001");
      });
      it('visible: sales_manager → studentId=student00000000000000000000A001', () => {
        const result = maskCustomerByRoleVariant('sales_manager');
        expect((result as Customer & Record<string, unknown>).studentId).toBe("student00000000000000000000A001");
      });
      it('visible: sales_owner → studentId=student00000000000000000000A001', () => {
        const result = maskCustomerByRoleVariant('sales_owner');
        expect((result as Customer & Record<string, unknown>).studentId).toBe("student00000000000000000000A001");
      });
      it('visible: sales_other → studentId=student00000000000000000000A001', () => {
        const result = maskCustomerByRoleVariant('sales_other');
        expect((result as Customer & Record<string, unknown>).studentId).toBe("student00000000000000000000A001");
      });
      it('visible: marketing → studentId=student00000000000000000000A001', () => {
        const result = maskCustomerByRoleVariant('marketing');
        expect((result as Customer & Record<string, unknown>).studentId).toBe("student00000000000000000000A001");
      });
      it('visible: academic → studentId=student00000000000000000000A001', () => {
        const result = maskCustomerByRoleVariant('academic');
        expect((result as Customer & Record<string, unknown>).studentId).toBe("student00000000000000000000A001");
      });
      it('visible: academic_admin → studentId=student00000000000000000000A001', () => {
        const result = maskCustomerByRoleVariant('academic_admin');
        expect((result as Customer & Record<string, unknown>).studentId).toBe("student00000000000000000000A001");
      });
      it('visible: finance → studentId=student00000000000000000000A001', () => {
        const result = maskCustomerByRoleVariant('finance');
        expect((result as Customer & Record<string, unknown>).studentId).toBe("student00000000000000000000A001");
      });
      it('visible: teacher → studentId=student00000000000000000000A001', () => {
        const result = maskCustomerByRoleVariant('teacher');
        expect((result as Customer & Record<string, unknown>).studentId).toBe("student00000000000000000000A001");
      });
      it('visible: hr → studentId=student00000000000000000000A001', () => {
        const result = maskCustomerByRoleVariant('hr');
        expect((result as Customer & Record<string, unknown>).studentId).toBe("student00000000000000000000A001");
      });
      it('visible: parent → studentId=student00000000000000000000A001', () => {
        const result = maskCustomerByRoleVariant('parent');
        expect((result as Customer & Record<string, unknown>).studentId).toBe("student00000000000000000000A001");
      });
      it('visible: unknown → studentId=student00000000000000000000A001', () => {
        const result = maskCustomerByRoleVariant('unknown');
        expect((result as Customer & Record<string, unknown>).studentId).toBe("student00000000000000000000A001");
      });
    });

  });

  describe('teacher (maskTeacher × 9 fields)', () => {
    describe('field: phone', () => {
      // PII 一级隐私（§4.3 note 一级隐私仅 self/老板/校长可见明文；§4.1 教务/市场脱敏 139****）
      // visible=[admin,boss,sales_manager,teacher_self,hr]
      // masked=[academic,academic_admin,marketing]
      // hidden=[teacher_other,sales,finance,parent,unknown]

      it('visible: admin → phone=13900139000', () => {
        const result = maskTeacherByRoleVariant('admin');
        expect((result as Teacher & Record<string, unknown>).phone).toBe("13900139000");
      });
      it('visible: boss → phone=13900139000', () => {
        const result = maskTeacherByRoleVariant('boss');
        expect((result as Teacher & Record<string, unknown>).phone).toBe("13900139000");
      });
      it('visible: sales_manager → phone=13900139000', () => {
        const result = maskTeacherByRoleVariant('sales_manager');
        expect((result as Teacher & Record<string, unknown>).phone).toBe("13900139000");
      });
      it('visible: teacher_self → phone=13900139000', () => {
        const result = maskTeacherByRoleVariant('teacher_self');
        expect((result as Teacher & Record<string, unknown>).phone).toBe("13900139000");
      });
      it('visible: hr → phone=13900139000', () => {
        const result = maskTeacherByRoleVariant('hr');
        expect((result as Teacher & Record<string, unknown>).phone).toBe("13900139000");
      });
      it('masked: academic → phone="139****9000"', () => {
        const result = maskTeacherByRoleVariant('academic');
        expect((result as Teacher & Record<string, unknown>).phone).toBe("139****9000");
      });
      it('masked: academic_admin → phone="139****9000"', () => {
        const result = maskTeacherByRoleVariant('academic_admin');
        expect((result as Teacher & Record<string, unknown>).phone).toBe("139****9000");
      });
      it('masked: marketing → phone="139****9000"', () => {
        const result = maskTeacherByRoleVariant('marketing');
        expect((result as Teacher & Record<string, unknown>).phone).toBe("139****9000");
      });
      it('hidden: teacher_other → phone undefined', () => {
        const result = maskTeacherByRoleVariant('teacher_other');
        expect((result as Teacher & Record<string, unknown>).phone).toBeUndefined();
      });
      it('hidden: sales → phone undefined', () => {
        const result = maskTeacherByRoleVariant('sales');
        expect((result as Teacher & Record<string, unknown>).phone).toBeUndefined();
      });
      it('hidden: finance → phone undefined', () => {
        const result = maskTeacherByRoleVariant('finance');
        expect((result as Teacher & Record<string, unknown>).phone).toBeUndefined();
      });
      it('hidden: parent → phone undefined', () => {
        const result = maskTeacherByRoleVariant('parent');
        expect((result as Teacher & Record<string, unknown>).phone).toBeUndefined();
      });
      it('hidden: unknown → phone undefined', () => {
        const result = maskTeacherByRoleVariant('unknown');
        expect((result as Teacher & Record<string, unknown>).phone).toBeUndefined();
      });
    });

    describe('field: name', () => {
      // 业务（公开姓名，所有角色保留）
      // visible=[admin,boss,sales_manager,academic,academic_admin,teacher_self,teacher_other,sales,marketing,finance,hr,parent,unknown]
      // masked=[]
      // hidden=[]

      it('visible: admin → name=王老师', () => {
        const result = maskTeacherByRoleVariant('admin');
        expect((result as Teacher & Record<string, unknown>).name).toBe("王老师");
      });
      it('visible: boss → name=王老师', () => {
        const result = maskTeacherByRoleVariant('boss');
        expect((result as Teacher & Record<string, unknown>).name).toBe("王老师");
      });
      it('visible: sales_manager → name=王老师', () => {
        const result = maskTeacherByRoleVariant('sales_manager');
        expect((result as Teacher & Record<string, unknown>).name).toBe("王老师");
      });
      it('visible: academic → name=王老师', () => {
        const result = maskTeacherByRoleVariant('academic');
        expect((result as Teacher & Record<string, unknown>).name).toBe("王老师");
      });
      it('visible: academic_admin → name=王老师', () => {
        const result = maskTeacherByRoleVariant('academic_admin');
        expect((result as Teacher & Record<string, unknown>).name).toBe("王老师");
      });
      it('visible: teacher_self → name=王老师', () => {
        const result = maskTeacherByRoleVariant('teacher_self');
        expect((result as Teacher & Record<string, unknown>).name).toBe("王老师");
      });
      it('visible: teacher_other → name=王老师', () => {
        const result = maskTeacherByRoleVariant('teacher_other');
        expect((result as Teacher & Record<string, unknown>).name).toBe("王老师");
      });
      it('visible: sales → name=王老师', () => {
        const result = maskTeacherByRoleVariant('sales');
        expect((result as Teacher & Record<string, unknown>).name).toBe("王老师");
      });
      it('visible: marketing → name=王老师', () => {
        const result = maskTeacherByRoleVariant('marketing');
        expect((result as Teacher & Record<string, unknown>).name).toBe("王老师");
      });
      it('visible: finance → name=王老师', () => {
        const result = maskTeacherByRoleVariant('finance');
        expect((result as Teacher & Record<string, unknown>).name).toBe("王老师");
      });
      it('visible: hr → name=王老师', () => {
        const result = maskTeacherByRoleVariant('hr');
        expect((result as Teacher & Record<string, unknown>).name).toBe("王老师");
      });
      it('visible: parent → name=王老师', () => {
        const result = maskTeacherByRoleVariant('parent');
        expect((result as Teacher & Record<string, unknown>).name).toBe("王老师");
      });
      it('visible: unknown → name=王老师', () => {
        const result = maskTeacherByRoleVariant('unknown');
        expect((result as Teacher & Record<string, unknown>).name).toBe("王老师");
      });
    });

    describe('field: subjects', () => {
      // 业务（教学学科，所有角色保留）
      // visible=[admin,boss,sales_manager,academic,academic_admin,teacher_self,teacher_other,sales,marketing,finance,hr,parent,unknown]
      // masked=[]
      // hidden=[]

      it('visible: admin → subjects=["数学","物理"]', () => {
        const result = maskTeacherByRoleVariant('admin');
        expect((result as Teacher & Record<string, unknown>).subjects).toEqual(["数学","物理"]);
      });
      it('visible: boss → subjects=["数学","物理"]', () => {
        const result = maskTeacherByRoleVariant('boss');
        expect((result as Teacher & Record<string, unknown>).subjects).toEqual(["数学","物理"]);
      });
      it('visible: sales_manager → subjects=["数学","物理"]', () => {
        const result = maskTeacherByRoleVariant('sales_manager');
        expect((result as Teacher & Record<string, unknown>).subjects).toEqual(["数学","物理"]);
      });
      it('visible: academic → subjects=["数学","物理"]', () => {
        const result = maskTeacherByRoleVariant('academic');
        expect((result as Teacher & Record<string, unknown>).subjects).toEqual(["数学","物理"]);
      });
      it('visible: academic_admin → subjects=["数学","物理"]', () => {
        const result = maskTeacherByRoleVariant('academic_admin');
        expect((result as Teacher & Record<string, unknown>).subjects).toEqual(["数学","物理"]);
      });
      it('visible: teacher_self → subjects=["数学","物理"]', () => {
        const result = maskTeacherByRoleVariant('teacher_self');
        expect((result as Teacher & Record<string, unknown>).subjects).toEqual(["数学","物理"]);
      });
      it('visible: teacher_other → subjects=["数学","物理"]', () => {
        const result = maskTeacherByRoleVariant('teacher_other');
        expect((result as Teacher & Record<string, unknown>).subjects).toEqual(["数学","物理"]);
      });
      it('visible: sales → subjects=["数学","物理"]', () => {
        const result = maskTeacherByRoleVariant('sales');
        expect((result as Teacher & Record<string, unknown>).subjects).toEqual(["数学","物理"]);
      });
      it('visible: marketing → subjects=["数学","物理"]', () => {
        const result = maskTeacherByRoleVariant('marketing');
        expect((result as Teacher & Record<string, unknown>).subjects).toEqual(["数学","物理"]);
      });
      it('visible: finance → subjects=["数学","物理"]', () => {
        const result = maskTeacherByRoleVariant('finance');
        expect((result as Teacher & Record<string, unknown>).subjects).toEqual(["数学","物理"]);
      });
      it('visible: hr → subjects=["数学","物理"]', () => {
        const result = maskTeacherByRoleVariant('hr');
        expect((result as Teacher & Record<string, unknown>).subjects).toEqual(["数学","物理"]);
      });
      it('visible: parent → subjects=["数学","物理"]', () => {
        const result = maskTeacherByRoleVariant('parent');
        expect((result as Teacher & Record<string, unknown>).subjects).toEqual(["数学","物理"]);
      });
      it('visible: unknown → subjects=["数学","物理"]', () => {
        const result = maskTeacherByRoleVariant('unknown');
        expect((result as Teacher & Record<string, unknown>).subjects).toEqual(["数学","物理"]);
      });
    });

    describe('field: status', () => {
      // 业务（在职状态，所有角色保留）
      // visible=[admin,boss,sales_manager,academic,academic_admin,teacher_self,teacher_other,sales,marketing,finance,hr,parent,unknown]
      // masked=[]
      // hidden=[]

      it('visible: admin → status=在职', () => {
        const result = maskTeacherByRoleVariant('admin');
        expect((result as Teacher & Record<string, unknown>).status).toBe("在职");
      });
      it('visible: boss → status=在职', () => {
        const result = maskTeacherByRoleVariant('boss');
        expect((result as Teacher & Record<string, unknown>).status).toBe("在职");
      });
      it('visible: sales_manager → status=在职', () => {
        const result = maskTeacherByRoleVariant('sales_manager');
        expect((result as Teacher & Record<string, unknown>).status).toBe("在职");
      });
      it('visible: academic → status=在职', () => {
        const result = maskTeacherByRoleVariant('academic');
        expect((result as Teacher & Record<string, unknown>).status).toBe("在职");
      });
      it('visible: academic_admin → status=在职', () => {
        const result = maskTeacherByRoleVariant('academic_admin');
        expect((result as Teacher & Record<string, unknown>).status).toBe("在职");
      });
      it('visible: teacher_self → status=在职', () => {
        const result = maskTeacherByRoleVariant('teacher_self');
        expect((result as Teacher & Record<string, unknown>).status).toBe("在职");
      });
      it('visible: teacher_other → status=在职', () => {
        const result = maskTeacherByRoleVariant('teacher_other');
        expect((result as Teacher & Record<string, unknown>).status).toBe("在职");
      });
      it('visible: sales → status=在职', () => {
        const result = maskTeacherByRoleVariant('sales');
        expect((result as Teacher & Record<string, unknown>).status).toBe("在职");
      });
      it('visible: marketing → status=在职', () => {
        const result = maskTeacherByRoleVariant('marketing');
        expect((result as Teacher & Record<string, unknown>).status).toBe("在职");
      });
      it('visible: finance → status=在职', () => {
        const result = maskTeacherByRoleVariant('finance');
        expect((result as Teacher & Record<string, unknown>).status).toBe("在职");
      });
      it('visible: hr → status=在职', () => {
        const result = maskTeacherByRoleVariant('hr');
        expect((result as Teacher & Record<string, unknown>).status).toBe("在职");
      });
      it('visible: parent → status=在职', () => {
        const result = maskTeacherByRoleVariant('parent');
        expect((result as Teacher & Record<string, unknown>).status).toBe("在职");
      });
      it('visible: unknown → status=在职', () => {
        const result = maskTeacherByRoleVariant('unknown');
        expect((result as Teacher & Record<string, unknown>).status).toBe("在职");
      });
    });

    describe('field: campusId', () => {
      // 业务（所属校区，所有角色保留）
      // visible=[admin,boss,sales_manager,academic,academic_admin,teacher_self,teacher_other,sales,marketing,finance,hr,parent,unknown]
      // masked=[]
      // hidden=[]

      it('visible: admin → campusId=campus_A0000000000000000000000A01', () => {
        const result = maskTeacherByRoleVariant('admin');
        expect((result as Teacher & Record<string, unknown>).campusId).toBe("campus_A0000000000000000000000A01");
      });
      it('visible: boss → campusId=campus_A0000000000000000000000A01', () => {
        const result = maskTeacherByRoleVariant('boss');
        expect((result as Teacher & Record<string, unknown>).campusId).toBe("campus_A0000000000000000000000A01");
      });
      it('visible: sales_manager → campusId=campus_A0000000000000000000000A01', () => {
        const result = maskTeacherByRoleVariant('sales_manager');
        expect((result as Teacher & Record<string, unknown>).campusId).toBe("campus_A0000000000000000000000A01");
      });
      it('visible: academic → campusId=campus_A0000000000000000000000A01', () => {
        const result = maskTeacherByRoleVariant('academic');
        expect((result as Teacher & Record<string, unknown>).campusId).toBe("campus_A0000000000000000000000A01");
      });
      it('visible: academic_admin → campusId=campus_A0000000000000000000000A01', () => {
        const result = maskTeacherByRoleVariant('academic_admin');
        expect((result as Teacher & Record<string, unknown>).campusId).toBe("campus_A0000000000000000000000A01");
      });
      it('visible: teacher_self → campusId=campus_A0000000000000000000000A01', () => {
        const result = maskTeacherByRoleVariant('teacher_self');
        expect((result as Teacher & Record<string, unknown>).campusId).toBe("campus_A0000000000000000000000A01");
      });
      it('visible: teacher_other → campusId=campus_A0000000000000000000000A01', () => {
        const result = maskTeacherByRoleVariant('teacher_other');
        expect((result as Teacher & Record<string, unknown>).campusId).toBe("campus_A0000000000000000000000A01");
      });
      it('visible: sales → campusId=campus_A0000000000000000000000A01', () => {
        const result = maskTeacherByRoleVariant('sales');
        expect((result as Teacher & Record<string, unknown>).campusId).toBe("campus_A0000000000000000000000A01");
      });
      it('visible: marketing → campusId=campus_A0000000000000000000000A01', () => {
        const result = maskTeacherByRoleVariant('marketing');
        expect((result as Teacher & Record<string, unknown>).campusId).toBe("campus_A0000000000000000000000A01");
      });
      it('visible: finance → campusId=campus_A0000000000000000000000A01', () => {
        const result = maskTeacherByRoleVariant('finance');
        expect((result as Teacher & Record<string, unknown>).campusId).toBe("campus_A0000000000000000000000A01");
      });
      it('visible: hr → campusId=campus_A0000000000000000000000A01', () => {
        const result = maskTeacherByRoleVariant('hr');
        expect((result as Teacher & Record<string, unknown>).campusId).toBe("campus_A0000000000000000000000A01");
      });
      it('visible: parent → campusId=campus_A0000000000000000000000A01', () => {
        const result = maskTeacherByRoleVariant('parent');
        expect((result as Teacher & Record<string, unknown>).campusId).toBe("campus_A0000000000000000000000A01");
      });
      it('visible: unknown → campusId=campus_A0000000000000000000000A01', () => {
        const result = maskTeacherByRoleVariant('unknown');
        expect((result as Teacher & Record<string, unknown>).campusId).toBe("campus_A0000000000000000000000A01");
      });
    });

    describe('field: hourlyPriceYuan', () => {
      // X1 物理删除（V50 DROP COLUMN）— 所有角色一律 hidden
      // visible=[]
      // masked=[]
      // hidden=[admin,boss,sales_manager,academic,academic_admin,teacher_self,teacher_other,sales,marketing,finance,hr,parent,unknown]

      it('hidden: admin → hourlyPriceYuan undefined', () => {
        const result = maskTeacherByRoleVariant('admin');
        expect((result as Teacher & Record<string, unknown>).hourlyPriceYuan).toBeUndefined();
      });
      it('hidden: boss → hourlyPriceYuan undefined', () => {
        const result = maskTeacherByRoleVariant('boss');
        expect((result as Teacher & Record<string, unknown>).hourlyPriceYuan).toBeUndefined();
      });
      it('hidden: sales_manager → hourlyPriceYuan undefined', () => {
        const result = maskTeacherByRoleVariant('sales_manager');
        expect((result as Teacher & Record<string, unknown>).hourlyPriceYuan).toBeUndefined();
      });
      it('hidden: academic → hourlyPriceYuan undefined', () => {
        const result = maskTeacherByRoleVariant('academic');
        expect((result as Teacher & Record<string, unknown>).hourlyPriceYuan).toBeUndefined();
      });
      it('hidden: academic_admin → hourlyPriceYuan undefined', () => {
        const result = maskTeacherByRoleVariant('academic_admin');
        expect((result as Teacher & Record<string, unknown>).hourlyPriceYuan).toBeUndefined();
      });
      it('hidden: teacher_self → hourlyPriceYuan undefined', () => {
        const result = maskTeacherByRoleVariant('teacher_self');
        expect((result as Teacher & Record<string, unknown>).hourlyPriceYuan).toBeUndefined();
      });
      it('hidden: teacher_other → hourlyPriceYuan undefined', () => {
        const result = maskTeacherByRoleVariant('teacher_other');
        expect((result as Teacher & Record<string, unknown>).hourlyPriceYuan).toBeUndefined();
      });
      it('hidden: sales → hourlyPriceYuan undefined', () => {
        const result = maskTeacherByRoleVariant('sales');
        expect((result as Teacher & Record<string, unknown>).hourlyPriceYuan).toBeUndefined();
      });
      it('hidden: marketing → hourlyPriceYuan undefined', () => {
        const result = maskTeacherByRoleVariant('marketing');
        expect((result as Teacher & Record<string, unknown>).hourlyPriceYuan).toBeUndefined();
      });
      it('hidden: finance → hourlyPriceYuan undefined', () => {
        const result = maskTeacherByRoleVariant('finance');
        expect((result as Teacher & Record<string, unknown>).hourlyPriceYuan).toBeUndefined();
      });
      it('hidden: hr → hourlyPriceYuan undefined', () => {
        const result = maskTeacherByRoleVariant('hr');
        expect((result as Teacher & Record<string, unknown>).hourlyPriceYuan).toBeUndefined();
      });
      it('hidden: parent → hourlyPriceYuan undefined', () => {
        const result = maskTeacherByRoleVariant('parent');
        expect((result as Teacher & Record<string, unknown>).hourlyPriceYuan).toBeUndefined();
      });
      it('hidden: unknown → hourlyPriceYuan undefined', () => {
        const result = maskTeacherByRoleVariant('unknown');
        expect((result as Teacher & Record<string, unknown>).hourlyPriceYuan).toBeUndefined();
      });
    });

    describe('field: id', () => {
      // 业务参考（teacher id 主键 ULID，所有角色保留）
      // visible=[admin,boss,sales_manager,academic,academic_admin,teacher_self,teacher_other,sales,marketing,finance,hr,parent,unknown]
      // masked=[]
      // hidden=[]

      it('visible: admin → id=teacher00000000000000000000A001', () => {
        const result = maskTeacherByRoleVariant('admin');
        expect((result as Teacher & Record<string, unknown>).id).toBe("teacher00000000000000000000A001");
      });
      it('visible: boss → id=teacher00000000000000000000A001', () => {
        const result = maskTeacherByRoleVariant('boss');
        expect((result as Teacher & Record<string, unknown>).id).toBe("teacher00000000000000000000A001");
      });
      it('visible: sales_manager → id=teacher00000000000000000000A001', () => {
        const result = maskTeacherByRoleVariant('sales_manager');
        expect((result as Teacher & Record<string, unknown>).id).toBe("teacher00000000000000000000A001");
      });
      it('visible: academic → id=teacher00000000000000000000A001', () => {
        const result = maskTeacherByRoleVariant('academic');
        expect((result as Teacher & Record<string, unknown>).id).toBe("teacher00000000000000000000A001");
      });
      it('visible: academic_admin → id=teacher00000000000000000000A001', () => {
        const result = maskTeacherByRoleVariant('academic_admin');
        expect((result as Teacher & Record<string, unknown>).id).toBe("teacher00000000000000000000A001");
      });
      it('visible: teacher_self → id=teacher00000000000000000000A001', () => {
        const result = maskTeacherByRoleVariant('teacher_self');
        expect((result as Teacher & Record<string, unknown>).id).toBe("teacher00000000000000000000A001");
      });
      it('visible: teacher_other → id=teacher00000000000000000000A001', () => {
        const result = maskTeacherByRoleVariant('teacher_other');
        expect((result as Teacher & Record<string, unknown>).id).toBe("teacher00000000000000000000A001");
      });
      it('visible: sales → id=teacher00000000000000000000A001', () => {
        const result = maskTeacherByRoleVariant('sales');
        expect((result as Teacher & Record<string, unknown>).id).toBe("teacher00000000000000000000A001");
      });
      it('visible: marketing → id=teacher00000000000000000000A001', () => {
        const result = maskTeacherByRoleVariant('marketing');
        expect((result as Teacher & Record<string, unknown>).id).toBe("teacher00000000000000000000A001");
      });
      it('visible: finance → id=teacher00000000000000000000A001', () => {
        const result = maskTeacherByRoleVariant('finance');
        expect((result as Teacher & Record<string, unknown>).id).toBe("teacher00000000000000000000A001");
      });
      it('visible: hr → id=teacher00000000000000000000A001', () => {
        const result = maskTeacherByRoleVariant('hr');
        expect((result as Teacher & Record<string, unknown>).id).toBe("teacher00000000000000000000A001");
      });
      it('visible: parent → id=teacher00000000000000000000A001', () => {
        const result = maskTeacherByRoleVariant('parent');
        expect((result as Teacher & Record<string, unknown>).id).toBe("teacher00000000000000000000A001");
      });
      it('visible: unknown → id=teacher00000000000000000000A001', () => {
        const result = maskTeacherByRoleVariant('unknown');
        expect((result as Teacher & Record<string, unknown>).id).toBe("teacher00000000000000000000A001");
      });
    });

    describe('field: userId', () => {
      // 业务参考（teacher.user_id 关联 users.id，所有角色保留 — 不在 mask 列表）
      // visible=[admin,boss,sales_manager,academic,academic_admin,teacher_self,teacher_other,sales,marketing,finance,hr,parent,unknown]
      // masked=[]
      // hidden=[]

      it('visible: admin → userId=salesA00000000000000000000000A01', () => {
        const result = maskTeacherByRoleVariant('admin');
        expect((result as Teacher & Record<string, unknown>).userId).toBe("salesA00000000000000000000000A01");
      });
      it('visible: boss → userId=salesA00000000000000000000000A01', () => {
        const result = maskTeacherByRoleVariant('boss');
        expect((result as Teacher & Record<string, unknown>).userId).toBe("salesA00000000000000000000000A01");
      });
      it('visible: sales_manager → userId=salesA00000000000000000000000A01', () => {
        const result = maskTeacherByRoleVariant('sales_manager');
        expect((result as Teacher & Record<string, unknown>).userId).toBe("salesA00000000000000000000000A01");
      });
      it('visible: academic → userId=salesA00000000000000000000000A01', () => {
        const result = maskTeacherByRoleVariant('academic');
        expect((result as Teacher & Record<string, unknown>).userId).toBe("salesA00000000000000000000000A01");
      });
      it('visible: academic_admin → userId=salesA00000000000000000000000A01', () => {
        const result = maskTeacherByRoleVariant('academic_admin');
        expect((result as Teacher & Record<string, unknown>).userId).toBe("salesA00000000000000000000000A01");
      });
      it('visible: teacher_self → userId=salesA00000000000000000000000A01', () => {
        const result = maskTeacherByRoleVariant('teacher_self');
        expect((result as Teacher & Record<string, unknown>).userId).toBe("salesA00000000000000000000000A01");
      });
      it('visible: teacher_other → userId=salesA00000000000000000000000A01', () => {
        const result = maskTeacherByRoleVariant('teacher_other');
        expect((result as Teacher & Record<string, unknown>).userId).toBe("salesA00000000000000000000000A01");
      });
      it('visible: sales → userId=salesA00000000000000000000000A01', () => {
        const result = maskTeacherByRoleVariant('sales');
        expect((result as Teacher & Record<string, unknown>).userId).toBe("salesA00000000000000000000000A01");
      });
      it('visible: marketing → userId=salesA00000000000000000000000A01', () => {
        const result = maskTeacherByRoleVariant('marketing');
        expect((result as Teacher & Record<string, unknown>).userId).toBe("salesA00000000000000000000000A01");
      });
      it('visible: finance → userId=salesA00000000000000000000000A01', () => {
        const result = maskTeacherByRoleVariant('finance');
        expect((result as Teacher & Record<string, unknown>).userId).toBe("salesA00000000000000000000000A01");
      });
      it('visible: hr → userId=salesA00000000000000000000000A01', () => {
        const result = maskTeacherByRoleVariant('hr');
        expect((result as Teacher & Record<string, unknown>).userId).toBe("salesA00000000000000000000000A01");
      });
      it('visible: parent → userId=salesA00000000000000000000000A01', () => {
        const result = maskTeacherByRoleVariant('parent');
        expect((result as Teacher & Record<string, unknown>).userId).toBe("salesA00000000000000000000000A01");
      });
      it('visible: unknown → userId=salesA00000000000000000000000A01', () => {
        const result = maskTeacherByRoleVariant('unknown');
        expect((result as Teacher & Record<string, unknown>).userId).toBe("salesA00000000000000000000000A01");
      });
    });

    describe('field: bio', () => {
      // X1-related 业务字段（介绍，可选；所有角色对存在的 bio 一致可读 — 不在 mask 列表，hidden for fixture 无此字段）
      // visible=[]
      // masked=[]
      // hidden=[admin,boss,sales_manager,academic,academic_admin,teacher_self,teacher_other,sales,marketing,finance,hr,parent,unknown]

      it('hidden: admin → bio undefined', () => {
        const result = maskTeacherByRoleVariant('admin');
        expect((result as Teacher & Record<string, unknown>).bio).toBeUndefined();
      });
      it('hidden: boss → bio undefined', () => {
        const result = maskTeacherByRoleVariant('boss');
        expect((result as Teacher & Record<string, unknown>).bio).toBeUndefined();
      });
      it('hidden: sales_manager → bio undefined', () => {
        const result = maskTeacherByRoleVariant('sales_manager');
        expect((result as Teacher & Record<string, unknown>).bio).toBeUndefined();
      });
      it('hidden: academic → bio undefined', () => {
        const result = maskTeacherByRoleVariant('academic');
        expect((result as Teacher & Record<string, unknown>).bio).toBeUndefined();
      });
      it('hidden: academic_admin → bio undefined', () => {
        const result = maskTeacherByRoleVariant('academic_admin');
        expect((result as Teacher & Record<string, unknown>).bio).toBeUndefined();
      });
      it('hidden: teacher_self → bio undefined', () => {
        const result = maskTeacherByRoleVariant('teacher_self');
        expect((result as Teacher & Record<string, unknown>).bio).toBeUndefined();
      });
      it('hidden: teacher_other → bio undefined', () => {
        const result = maskTeacherByRoleVariant('teacher_other');
        expect((result as Teacher & Record<string, unknown>).bio).toBeUndefined();
      });
      it('hidden: sales → bio undefined', () => {
        const result = maskTeacherByRoleVariant('sales');
        expect((result as Teacher & Record<string, unknown>).bio).toBeUndefined();
      });
      it('hidden: marketing → bio undefined', () => {
        const result = maskTeacherByRoleVariant('marketing');
        expect((result as Teacher & Record<string, unknown>).bio).toBeUndefined();
      });
      it('hidden: finance → bio undefined', () => {
        const result = maskTeacherByRoleVariant('finance');
        expect((result as Teacher & Record<string, unknown>).bio).toBeUndefined();
      });
      it('hidden: hr → bio undefined', () => {
        const result = maskTeacherByRoleVariant('hr');
        expect((result as Teacher & Record<string, unknown>).bio).toBeUndefined();
      });
      it('hidden: parent → bio undefined', () => {
        const result = maskTeacherByRoleVariant('parent');
        expect((result as Teacher & Record<string, unknown>).bio).toBeUndefined();
      });
      it('hidden: unknown → bio undefined', () => {
        const result = maskTeacherByRoleVariant('unknown');
        expect((result as Teacher & Record<string, unknown>).bio).toBeUndefined();
      });
    });

  });

  describe('contract (maskContract × 12 fields)', () => {
    describe('field: totalAmount', () => {
      // 财务二级隐私（§4.5 教务保留续费话术依据 / 老师墙①不看价格 / §4.1 市场含价格）
      // visible=[admin,boss,sales_manager,finance,sales_owner,academic,academic_admin,parent,marketing]
      // masked=[sales_other,teacher,hr,unknown]
      // hidden=[]

      it('visible: admin → totalAmount=9000', () => {
        const result = maskContractByRoleVariant('admin');
        expect((result as Contract & Record<string, unknown>).totalAmount).toBe(9000);
      });
      it('visible: boss → totalAmount=9000', () => {
        const result = maskContractByRoleVariant('boss');
        expect((result as Contract & Record<string, unknown>).totalAmount).toBe(9000);
      });
      it('visible: sales_manager → totalAmount=9000', () => {
        const result = maskContractByRoleVariant('sales_manager');
        expect((result as Contract & Record<string, unknown>).totalAmount).toBe(9000);
      });
      it('visible: finance → totalAmount=9000', () => {
        const result = maskContractByRoleVariant('finance');
        expect((result as Contract & Record<string, unknown>).totalAmount).toBe(9000);
      });
      it('visible: sales_owner → totalAmount=9000', () => {
        const result = maskContractByRoleVariant('sales_owner');
        expect((result as Contract & Record<string, unknown>).totalAmount).toBe(9000);
      });
      it('visible: academic → totalAmount=9000', () => {
        const result = maskContractByRoleVariant('academic');
        expect((result as Contract & Record<string, unknown>).totalAmount).toBe(9000);
      });
      it('visible: academic_admin → totalAmount=9000', () => {
        const result = maskContractByRoleVariant('academic_admin');
        expect((result as Contract & Record<string, unknown>).totalAmount).toBe(9000);
      });
      it('visible: parent → totalAmount=9000', () => {
        const result = maskContractByRoleVariant('parent');
        expect((result as Contract & Record<string, unknown>).totalAmount).toBe(9000);
      });
      it('visible: marketing → totalAmount=9000', () => {
        const result = maskContractByRoleVariant('marketing');
        expect((result as Contract & Record<string, unknown>).totalAmount).toBe(9000);
      });
      it('masked: sales_other → totalAmount=0', () => {
        const result = maskContractByRoleVariant('sales_other');
        expect((result as Contract & Record<string, unknown>).totalAmount).toBe(0);
      });
      it('masked: teacher → totalAmount=0', () => {
        const result = maskContractByRoleVariant('teacher');
        expect((result as Contract & Record<string, unknown>).totalAmount).toBe(0);
      });
      it('masked: hr → totalAmount=0', () => {
        const result = maskContractByRoleVariant('hr');
        expect((result as Contract & Record<string, unknown>).totalAmount).toBe(0);
      });
      it('masked: unknown → totalAmount=0', () => {
        const result = maskContractByRoleVariant('unknown');
        expect((result as Contract & Record<string, unknown>).totalAmount).toBe(0);
      });
    });

    describe('field: standardPrice', () => {
      // 财务（原价，academic 不看细节 / parent 可看用于折扣对比 / §4.1 市场含价格）
      // visible=[admin,boss,sales_manager,finance,sales_owner,parent,marketing]
      // masked=[academic,academic_admin,sales_other,teacher,hr,unknown]
      // hidden=[]

      it('visible: admin → standardPrice=9999', () => {
        const result = maskContractByRoleVariant('admin');
        expect((result as Contract & Record<string, unknown>).standardPrice).toBe(9999);
      });
      it('visible: boss → standardPrice=9999', () => {
        const result = maskContractByRoleVariant('boss');
        expect((result as Contract & Record<string, unknown>).standardPrice).toBe(9999);
      });
      it('visible: sales_manager → standardPrice=9999', () => {
        const result = maskContractByRoleVariant('sales_manager');
        expect((result as Contract & Record<string, unknown>).standardPrice).toBe(9999);
      });
      it('visible: finance → standardPrice=9999', () => {
        const result = maskContractByRoleVariant('finance');
        expect((result as Contract & Record<string, unknown>).standardPrice).toBe(9999);
      });
      it('visible: sales_owner → standardPrice=9999', () => {
        const result = maskContractByRoleVariant('sales_owner');
        expect((result as Contract & Record<string, unknown>).standardPrice).toBe(9999);
      });
      it('visible: parent → standardPrice=9999', () => {
        const result = maskContractByRoleVariant('parent');
        expect((result as Contract & Record<string, unknown>).standardPrice).toBe(9999);
      });
      it('visible: marketing → standardPrice=9999', () => {
        const result = maskContractByRoleVariant('marketing');
        expect((result as Contract & Record<string, unknown>).standardPrice).toBe(9999);
      });
      it('masked: academic → standardPrice=0', () => {
        const result = maskContractByRoleVariant('academic');
        expect((result as Contract & Record<string, unknown>).standardPrice).toBe(0);
      });
      it('masked: academic_admin → standardPrice=0', () => {
        const result = maskContractByRoleVariant('academic_admin');
        expect((result as Contract & Record<string, unknown>).standardPrice).toBe(0);
      });
      it('masked: sales_other → standardPrice=0', () => {
        const result = maskContractByRoleVariant('sales_other');
        expect((result as Contract & Record<string, unknown>).standardPrice).toBe(0);
      });
      it('masked: teacher → standardPrice=0', () => {
        const result = maskContractByRoleVariant('teacher');
        expect((result as Contract & Record<string, unknown>).standardPrice).toBe(0);
      });
      it('masked: hr → standardPrice=0', () => {
        const result = maskContractByRoleVariant('hr');
        expect((result as Contract & Record<string, unknown>).standardPrice).toBe(0);
      });
      it('masked: unknown → standardPrice=0', () => {
        const result = maskContractByRoleVariant('unknown');
        expect((result as Contract & Record<string, unknown>).standardPrice).toBe(0);
      });
    });

    describe('field: discountAmount', () => {
      // 财务（折扣，parent 也不看 / §4.1 市场含价格）
      // visible=[admin,boss,sales_manager,finance,sales_owner,marketing]
      // masked=[academic,academic_admin,sales_other,teacher,parent,hr,unknown]
      // hidden=[]

      it('visible: admin → discountAmount=999', () => {
        const result = maskContractByRoleVariant('admin');
        expect((result as Contract & Record<string, unknown>).discountAmount).toBe(999);
      });
      it('visible: boss → discountAmount=999', () => {
        const result = maskContractByRoleVariant('boss');
        expect((result as Contract & Record<string, unknown>).discountAmount).toBe(999);
      });
      it('visible: sales_manager → discountAmount=999', () => {
        const result = maskContractByRoleVariant('sales_manager');
        expect((result as Contract & Record<string, unknown>).discountAmount).toBe(999);
      });
      it('visible: finance → discountAmount=999', () => {
        const result = maskContractByRoleVariant('finance');
        expect((result as Contract & Record<string, unknown>).discountAmount).toBe(999);
      });
      it('visible: sales_owner → discountAmount=999', () => {
        const result = maskContractByRoleVariant('sales_owner');
        expect((result as Contract & Record<string, unknown>).discountAmount).toBe(999);
      });
      it('visible: marketing → discountAmount=999', () => {
        const result = maskContractByRoleVariant('marketing');
        expect((result as Contract & Record<string, unknown>).discountAmount).toBe(999);
      });
      it('masked: academic → discountAmount=0', () => {
        const result = maskContractByRoleVariant('academic');
        expect((result as Contract & Record<string, unknown>).discountAmount).toBe(0);
      });
      it('masked: academic_admin → discountAmount=0', () => {
        const result = maskContractByRoleVariant('academic_admin');
        expect((result as Contract & Record<string, unknown>).discountAmount).toBe(0);
      });
      it('masked: sales_other → discountAmount=0', () => {
        const result = maskContractByRoleVariant('sales_other');
        expect((result as Contract & Record<string, unknown>).discountAmount).toBe(0);
      });
      it('masked: teacher → discountAmount=0', () => {
        const result = maskContractByRoleVariant('teacher');
        expect((result as Contract & Record<string, unknown>).discountAmount).toBe(0);
      });
      it('masked: parent → discountAmount=0', () => {
        const result = maskContractByRoleVariant('parent');
        expect((result as Contract & Record<string, unknown>).discountAmount).toBe(0);
      });
      it('masked: hr → discountAmount=0', () => {
        const result = maskContractByRoleVariant('hr');
        expect((result as Contract & Record<string, unknown>).discountAmount).toBe(0);
      });
      it('masked: unknown → discountAmount=0', () => {
        const result = maskContractByRoleVariant('unknown');
        expect((result as Contract & Record<string, unknown>).discountAmount).toBe(0);
      });
    });

    describe('field: giftHours', () => {
      // 财务（赠课，academic + parent 都不看 / §4.1 市场含价格）
      // visible=[admin,boss,sales_manager,finance,sales_owner,marketing]
      // masked=[sales_other,academic,academic_admin,teacher,parent,hr,unknown]
      // hidden=[]

      it('visible: admin → giftHours=5', () => {
        const result = maskContractByRoleVariant('admin');
        expect((result as Contract & Record<string, unknown>).giftHours).toBe(5);
      });
      it('visible: boss → giftHours=5', () => {
        const result = maskContractByRoleVariant('boss');
        expect((result as Contract & Record<string, unknown>).giftHours).toBe(5);
      });
      it('visible: sales_manager → giftHours=5', () => {
        const result = maskContractByRoleVariant('sales_manager');
        expect((result as Contract & Record<string, unknown>).giftHours).toBe(5);
      });
      it('visible: finance → giftHours=5', () => {
        const result = maskContractByRoleVariant('finance');
        expect((result as Contract & Record<string, unknown>).giftHours).toBe(5);
      });
      it('visible: sales_owner → giftHours=5', () => {
        const result = maskContractByRoleVariant('sales_owner');
        expect((result as Contract & Record<string, unknown>).giftHours).toBe(5);
      });
      it('visible: marketing → giftHours=5', () => {
        const result = maskContractByRoleVariant('marketing');
        expect((result as Contract & Record<string, unknown>).giftHours).toBe(5);
      });
      it('masked: sales_other → giftHours=0', () => {
        const result = maskContractByRoleVariant('sales_other');
        expect((result as Contract & Record<string, unknown>).giftHours).toBe(0);
      });
      it('masked: academic → giftHours=0', () => {
        const result = maskContractByRoleVariant('academic');
        expect((result as Contract & Record<string, unknown>).giftHours).toBe(0);
      });
      it('masked: academic_admin → giftHours=0', () => {
        const result = maskContractByRoleVariant('academic_admin');
        expect((result as Contract & Record<string, unknown>).giftHours).toBe(0);
      });
      it('masked: teacher → giftHours=0', () => {
        const result = maskContractByRoleVariant('teacher');
        expect((result as Contract & Record<string, unknown>).giftHours).toBe(0);
      });
      it('masked: parent → giftHours=0', () => {
        const result = maskContractByRoleVariant('parent');
        expect((result as Contract & Record<string, unknown>).giftHours).toBe(0);
      });
      it('masked: hr → giftHours=0', () => {
        const result = maskContractByRoleVariant('hr');
        expect((result as Contract & Record<string, unknown>).giftHours).toBe(0);
      });
      it('masked: unknown → giftHours=0', () => {
        const result = maskContractByRoleVariant('unknown');
        expect((result as Contract & Record<string, unknown>).giftHours).toBe(0);
      });
    });

    describe('field: lessonHours', () => {
      // 业务（课时数，所有角色保留 — 教学执行需要）
      // visible=[admin,boss,sales_manager,finance,sales_owner,sales_other,marketing,academic,academic_admin,teacher,parent,hr,unknown]
      // masked=[]
      // hidden=[]

      it('visible: admin → lessonHours=60', () => {
        const result = maskContractByRoleVariant('admin');
        expect((result as Contract & Record<string, unknown>).lessonHours).toBe(60);
      });
      it('visible: boss → lessonHours=60', () => {
        const result = maskContractByRoleVariant('boss');
        expect((result as Contract & Record<string, unknown>).lessonHours).toBe(60);
      });
      it('visible: sales_manager → lessonHours=60', () => {
        const result = maskContractByRoleVariant('sales_manager');
        expect((result as Contract & Record<string, unknown>).lessonHours).toBe(60);
      });
      it('visible: finance → lessonHours=60', () => {
        const result = maskContractByRoleVariant('finance');
        expect((result as Contract & Record<string, unknown>).lessonHours).toBe(60);
      });
      it('visible: sales_owner → lessonHours=60', () => {
        const result = maskContractByRoleVariant('sales_owner');
        expect((result as Contract & Record<string, unknown>).lessonHours).toBe(60);
      });
      it('visible: sales_other → lessonHours=60', () => {
        const result = maskContractByRoleVariant('sales_other');
        expect((result as Contract & Record<string, unknown>).lessonHours).toBe(60);
      });
      it('visible: marketing → lessonHours=60', () => {
        const result = maskContractByRoleVariant('marketing');
        expect((result as Contract & Record<string, unknown>).lessonHours).toBe(60);
      });
      it('visible: academic → lessonHours=60', () => {
        const result = maskContractByRoleVariant('academic');
        expect((result as Contract & Record<string, unknown>).lessonHours).toBe(60);
      });
      it('visible: academic_admin → lessonHours=60', () => {
        const result = maskContractByRoleVariant('academic_admin');
        expect((result as Contract & Record<string, unknown>).lessonHours).toBe(60);
      });
      it('visible: teacher → lessonHours=60', () => {
        const result = maskContractByRoleVariant('teacher');
        expect((result as Contract & Record<string, unknown>).lessonHours).toBe(60);
      });
      it('visible: parent → lessonHours=60', () => {
        const result = maskContractByRoleVariant('parent');
        expect((result as Contract & Record<string, unknown>).lessonHours).toBe(60);
      });
      it('visible: hr → lessonHours=60', () => {
        const result = maskContractByRoleVariant('hr');
        expect((result as Contract & Record<string, unknown>).lessonHours).toBe(60);
      });
      it('visible: unknown → lessonHours=60', () => {
        const result = maskContractByRoleVariant('unknown');
        expect((result as Contract & Record<string, unknown>).lessonHours).toBe(60);
      });
    });

    describe('field: classType', () => {
      // 业务（班型 1v1/班课，所有角色保留 — 排课/反馈需要）
      // visible=[admin,boss,sales_manager,finance,sales_owner,sales_other,marketing,academic,academic_admin,teacher,parent,hr,unknown]
      // masked=[]
      // hidden=[]

      it('visible: admin → classType=一对一', () => {
        const result = maskContractByRoleVariant('admin');
        expect((result as Contract & Record<string, unknown>).classType).toBe("一对一");
      });
      it('visible: boss → classType=一对一', () => {
        const result = maskContractByRoleVariant('boss');
        expect((result as Contract & Record<string, unknown>).classType).toBe("一对一");
      });
      it('visible: sales_manager → classType=一对一', () => {
        const result = maskContractByRoleVariant('sales_manager');
        expect((result as Contract & Record<string, unknown>).classType).toBe("一对一");
      });
      it('visible: finance → classType=一对一', () => {
        const result = maskContractByRoleVariant('finance');
        expect((result as Contract & Record<string, unknown>).classType).toBe("一对一");
      });
      it('visible: sales_owner → classType=一对一', () => {
        const result = maskContractByRoleVariant('sales_owner');
        expect((result as Contract & Record<string, unknown>).classType).toBe("一对一");
      });
      it('visible: sales_other → classType=一对一', () => {
        const result = maskContractByRoleVariant('sales_other');
        expect((result as Contract & Record<string, unknown>).classType).toBe("一对一");
      });
      it('visible: marketing → classType=一对一', () => {
        const result = maskContractByRoleVariant('marketing');
        expect((result as Contract & Record<string, unknown>).classType).toBe("一对一");
      });
      it('visible: academic → classType=一对一', () => {
        const result = maskContractByRoleVariant('academic');
        expect((result as Contract & Record<string, unknown>).classType).toBe("一对一");
      });
      it('visible: academic_admin → classType=一对一', () => {
        const result = maskContractByRoleVariant('academic_admin');
        expect((result as Contract & Record<string, unknown>).classType).toBe("一对一");
      });
      it('visible: teacher → classType=一对一', () => {
        const result = maskContractByRoleVariant('teacher');
        expect((result as Contract & Record<string, unknown>).classType).toBe("一对一");
      });
      it('visible: parent → classType=一对一', () => {
        const result = maskContractByRoleVariant('parent');
        expect((result as Contract & Record<string, unknown>).classType).toBe("一对一");
      });
      it('visible: hr → classType=一对一', () => {
        const result = maskContractByRoleVariant('hr');
        expect((result as Contract & Record<string, unknown>).classType).toBe("一对一");
      });
      it('visible: unknown → classType=一对一', () => {
        const result = maskContractByRoleVariant('unknown');
        expect((result as Contract & Record<string, unknown>).classType).toBe("一对一");
      });
    });

    describe('field: status', () => {
      // 业务（active/expired，所有角色保留）
      // visible=[admin,boss,sales_manager,finance,sales_owner,sales_other,marketing,academic,academic_admin,teacher,parent,hr,unknown]
      // masked=[]
      // hidden=[]

      it('visible: admin → status=active', () => {
        const result = maskContractByRoleVariant('admin');
        expect((result as Contract & Record<string, unknown>).status).toBe("active");
      });
      it('visible: boss → status=active', () => {
        const result = maskContractByRoleVariant('boss');
        expect((result as Contract & Record<string, unknown>).status).toBe("active");
      });
      it('visible: sales_manager → status=active', () => {
        const result = maskContractByRoleVariant('sales_manager');
        expect((result as Contract & Record<string, unknown>).status).toBe("active");
      });
      it('visible: finance → status=active', () => {
        const result = maskContractByRoleVariant('finance');
        expect((result as Contract & Record<string, unknown>).status).toBe("active");
      });
      it('visible: sales_owner → status=active', () => {
        const result = maskContractByRoleVariant('sales_owner');
        expect((result as Contract & Record<string, unknown>).status).toBe("active");
      });
      it('visible: sales_other → status=active', () => {
        const result = maskContractByRoleVariant('sales_other');
        expect((result as Contract & Record<string, unknown>).status).toBe("active");
      });
      it('visible: marketing → status=active', () => {
        const result = maskContractByRoleVariant('marketing');
        expect((result as Contract & Record<string, unknown>).status).toBe("active");
      });
      it('visible: academic → status=active', () => {
        const result = maskContractByRoleVariant('academic');
        expect((result as Contract & Record<string, unknown>).status).toBe("active");
      });
      it('visible: academic_admin → status=active', () => {
        const result = maskContractByRoleVariant('academic_admin');
        expect((result as Contract & Record<string, unknown>).status).toBe("active");
      });
      it('visible: teacher → status=active', () => {
        const result = maskContractByRoleVariant('teacher');
        expect((result as Contract & Record<string, unknown>).status).toBe("active");
      });
      it('visible: parent → status=active', () => {
        const result = maskContractByRoleVariant('parent');
        expect((result as Contract & Record<string, unknown>).status).toBe("active");
      });
      it('visible: hr → status=active', () => {
        const result = maskContractByRoleVariant('hr');
        expect((result as Contract & Record<string, unknown>).status).toBe("active");
      });
      it('visible: unknown → status=active', () => {
        const result = maskContractByRoleVariant('unknown');
        expect((result as Contract & Record<string, unknown>).status).toBe("active");
      });
    });

    describe('field: courseProductName', () => {
      // 业务参考（产品名称，所有角色保留）
      // visible=[admin,boss,sales_manager,finance,sales_owner,sales_other,marketing,academic,academic_admin,teacher,parent,hr,unknown]
      // masked=[]
      // hidden=[]

      it('visible: admin → courseProductName=一对一英语', () => {
        const result = maskContractByRoleVariant('admin');
        expect((result as Contract & Record<string, unknown>).courseProductName).toBe("一对一英语");
      });
      it('visible: boss → courseProductName=一对一英语', () => {
        const result = maskContractByRoleVariant('boss');
        expect((result as Contract & Record<string, unknown>).courseProductName).toBe("一对一英语");
      });
      it('visible: sales_manager → courseProductName=一对一英语', () => {
        const result = maskContractByRoleVariant('sales_manager');
        expect((result as Contract & Record<string, unknown>).courseProductName).toBe("一对一英语");
      });
      it('visible: finance → courseProductName=一对一英语', () => {
        const result = maskContractByRoleVariant('finance');
        expect((result as Contract & Record<string, unknown>).courseProductName).toBe("一对一英语");
      });
      it('visible: sales_owner → courseProductName=一对一英语', () => {
        const result = maskContractByRoleVariant('sales_owner');
        expect((result as Contract & Record<string, unknown>).courseProductName).toBe("一对一英语");
      });
      it('visible: sales_other → courseProductName=一对一英语', () => {
        const result = maskContractByRoleVariant('sales_other');
        expect((result as Contract & Record<string, unknown>).courseProductName).toBe("一对一英语");
      });
      it('visible: marketing → courseProductName=一对一英语', () => {
        const result = maskContractByRoleVariant('marketing');
        expect((result as Contract & Record<string, unknown>).courseProductName).toBe("一对一英语");
      });
      it('visible: academic → courseProductName=一对一英语', () => {
        const result = maskContractByRoleVariant('academic');
        expect((result as Contract & Record<string, unknown>).courseProductName).toBe("一对一英语");
      });
      it('visible: academic_admin → courseProductName=一对一英语', () => {
        const result = maskContractByRoleVariant('academic_admin');
        expect((result as Contract & Record<string, unknown>).courseProductName).toBe("一对一英语");
      });
      it('visible: teacher → courseProductName=一对一英语', () => {
        const result = maskContractByRoleVariant('teacher');
        expect((result as Contract & Record<string, unknown>).courseProductName).toBe("一对一英语");
      });
      it('visible: parent → courseProductName=一对一英语', () => {
        const result = maskContractByRoleVariant('parent');
        expect((result as Contract & Record<string, unknown>).courseProductName).toBe("一对一英语");
      });
      it('visible: hr → courseProductName=一对一英语', () => {
        const result = maskContractByRoleVariant('hr');
        expect((result as Contract & Record<string, unknown>).courseProductName).toBe("一对一英语");
      });
      it('visible: unknown → courseProductName=一对一英语', () => {
        const result = maskContractByRoleVariant('unknown');
        expect((result as Contract & Record<string, unknown>).courseProductName).toBe("一对一英语");
      });
    });

    describe('field: signedAt', () => {
      // 业务参考（签约时间，所有角色保留 — 不在 mask 列表）
      // visible=[admin,boss,sales_manager,finance,sales_owner,sales_other,marketing,academic,academic_admin,teacher,parent,hr,unknown]
      // masked=[]
      // hidden=[]

      it('visible: admin → signedAt=2026-05-08T00:00:00.000Z', () => {
        const result = maskContractByRoleVariant('admin');
        expect((result as Contract & Record<string, unknown>).signedAt).toBe("2026-05-08T00:00:00.000Z");
      });
      it('visible: boss → signedAt=2026-05-08T00:00:00.000Z', () => {
        const result = maskContractByRoleVariant('boss');
        expect((result as Contract & Record<string, unknown>).signedAt).toBe("2026-05-08T00:00:00.000Z");
      });
      it('visible: sales_manager → signedAt=2026-05-08T00:00:00.000Z', () => {
        const result = maskContractByRoleVariant('sales_manager');
        expect((result as Contract & Record<string, unknown>).signedAt).toBe("2026-05-08T00:00:00.000Z");
      });
      it('visible: finance → signedAt=2026-05-08T00:00:00.000Z', () => {
        const result = maskContractByRoleVariant('finance');
        expect((result as Contract & Record<string, unknown>).signedAt).toBe("2026-05-08T00:00:00.000Z");
      });
      it('visible: sales_owner → signedAt=2026-05-08T00:00:00.000Z', () => {
        const result = maskContractByRoleVariant('sales_owner');
        expect((result as Contract & Record<string, unknown>).signedAt).toBe("2026-05-08T00:00:00.000Z");
      });
      it('visible: sales_other → signedAt=2026-05-08T00:00:00.000Z', () => {
        const result = maskContractByRoleVariant('sales_other');
        expect((result as Contract & Record<string, unknown>).signedAt).toBe("2026-05-08T00:00:00.000Z");
      });
      it('visible: marketing → signedAt=2026-05-08T00:00:00.000Z', () => {
        const result = maskContractByRoleVariant('marketing');
        expect((result as Contract & Record<string, unknown>).signedAt).toBe("2026-05-08T00:00:00.000Z");
      });
      it('visible: academic → signedAt=2026-05-08T00:00:00.000Z', () => {
        const result = maskContractByRoleVariant('academic');
        expect((result as Contract & Record<string, unknown>).signedAt).toBe("2026-05-08T00:00:00.000Z");
      });
      it('visible: academic_admin → signedAt=2026-05-08T00:00:00.000Z', () => {
        const result = maskContractByRoleVariant('academic_admin');
        expect((result as Contract & Record<string, unknown>).signedAt).toBe("2026-05-08T00:00:00.000Z");
      });
      it('visible: teacher → signedAt=2026-05-08T00:00:00.000Z', () => {
        const result = maskContractByRoleVariant('teacher');
        expect((result as Contract & Record<string, unknown>).signedAt).toBe("2026-05-08T00:00:00.000Z");
      });
      it('visible: parent → signedAt=2026-05-08T00:00:00.000Z', () => {
        const result = maskContractByRoleVariant('parent');
        expect((result as Contract & Record<string, unknown>).signedAt).toBe("2026-05-08T00:00:00.000Z");
      });
      it('visible: hr → signedAt=2026-05-08T00:00:00.000Z', () => {
        const result = maskContractByRoleVariant('hr');
        expect((result as Contract & Record<string, unknown>).signedAt).toBe("2026-05-08T00:00:00.000Z");
      });
      it('visible: unknown → signedAt=2026-05-08T00:00:00.000Z', () => {
        const result = maskContractByRoleVariant('unknown');
        expect((result as Contract & Record<string, unknown>).signedAt).toBe("2026-05-08T00:00:00.000Z");
      });
    });

    describe('field: orderType', () => {
      // 业务参考（新签/续签/转介，所有角色保留 — 不在 mask 列表）
      // visible=[admin,boss,sales_manager,finance,sales_owner,sales_other,marketing,academic,academic_admin,teacher,parent,hr,unknown]
      // masked=[]
      // hidden=[]

      it('visible: admin → orderType=新签', () => {
        const result = maskContractByRoleVariant('admin');
        expect((result as Contract & Record<string, unknown>).orderType).toBe("新签");
      });
      it('visible: boss → orderType=新签', () => {
        const result = maskContractByRoleVariant('boss');
        expect((result as Contract & Record<string, unknown>).orderType).toBe("新签");
      });
      it('visible: sales_manager → orderType=新签', () => {
        const result = maskContractByRoleVariant('sales_manager');
        expect((result as Contract & Record<string, unknown>).orderType).toBe("新签");
      });
      it('visible: finance → orderType=新签', () => {
        const result = maskContractByRoleVariant('finance');
        expect((result as Contract & Record<string, unknown>).orderType).toBe("新签");
      });
      it('visible: sales_owner → orderType=新签', () => {
        const result = maskContractByRoleVariant('sales_owner');
        expect((result as Contract & Record<string, unknown>).orderType).toBe("新签");
      });
      it('visible: sales_other → orderType=新签', () => {
        const result = maskContractByRoleVariant('sales_other');
        expect((result as Contract & Record<string, unknown>).orderType).toBe("新签");
      });
      it('visible: marketing → orderType=新签', () => {
        const result = maskContractByRoleVariant('marketing');
        expect((result as Contract & Record<string, unknown>).orderType).toBe("新签");
      });
      it('visible: academic → orderType=新签', () => {
        const result = maskContractByRoleVariant('academic');
        expect((result as Contract & Record<string, unknown>).orderType).toBe("新签");
      });
      it('visible: academic_admin → orderType=新签', () => {
        const result = maskContractByRoleVariant('academic_admin');
        expect((result as Contract & Record<string, unknown>).orderType).toBe("新签");
      });
      it('visible: teacher → orderType=新签', () => {
        const result = maskContractByRoleVariant('teacher');
        expect((result as Contract & Record<string, unknown>).orderType).toBe("新签");
      });
      it('visible: parent → orderType=新签', () => {
        const result = maskContractByRoleVariant('parent');
        expect((result as Contract & Record<string, unknown>).orderType).toBe("新签");
      });
      it('visible: hr → orderType=新签', () => {
        const result = maskContractByRoleVariant('hr');
        expect((result as Contract & Record<string, unknown>).orderType).toBe("新签");
      });
      it('visible: unknown → orderType=新签', () => {
        const result = maskContractByRoleVariant('unknown');
        expect((result as Contract & Record<string, unknown>).orderType).toBe("新签");
      });
    });

    describe('field: campusId', () => {
      // 业务参考（所属校区，所有角色保留）
      // visible=[admin,boss,sales_manager,finance,sales_owner,sales_other,marketing,academic,academic_admin,teacher,parent,hr,unknown]
      // masked=[]
      // hidden=[]

      it('visible: admin → campusId=campus_A0000000000000000000000A01', () => {
        const result = maskContractByRoleVariant('admin');
        expect((result as Contract & Record<string, unknown>).campusId).toBe("campus_A0000000000000000000000A01");
      });
      it('visible: boss → campusId=campus_A0000000000000000000000A01', () => {
        const result = maskContractByRoleVariant('boss');
        expect((result as Contract & Record<string, unknown>).campusId).toBe("campus_A0000000000000000000000A01");
      });
      it('visible: sales_manager → campusId=campus_A0000000000000000000000A01', () => {
        const result = maskContractByRoleVariant('sales_manager');
        expect((result as Contract & Record<string, unknown>).campusId).toBe("campus_A0000000000000000000000A01");
      });
      it('visible: finance → campusId=campus_A0000000000000000000000A01', () => {
        const result = maskContractByRoleVariant('finance');
        expect((result as Contract & Record<string, unknown>).campusId).toBe("campus_A0000000000000000000000A01");
      });
      it('visible: sales_owner → campusId=campus_A0000000000000000000000A01', () => {
        const result = maskContractByRoleVariant('sales_owner');
        expect((result as Contract & Record<string, unknown>).campusId).toBe("campus_A0000000000000000000000A01");
      });
      it('visible: sales_other → campusId=campus_A0000000000000000000000A01', () => {
        const result = maskContractByRoleVariant('sales_other');
        expect((result as Contract & Record<string, unknown>).campusId).toBe("campus_A0000000000000000000000A01");
      });
      it('visible: marketing → campusId=campus_A0000000000000000000000A01', () => {
        const result = maskContractByRoleVariant('marketing');
        expect((result as Contract & Record<string, unknown>).campusId).toBe("campus_A0000000000000000000000A01");
      });
      it('visible: academic → campusId=campus_A0000000000000000000000A01', () => {
        const result = maskContractByRoleVariant('academic');
        expect((result as Contract & Record<string, unknown>).campusId).toBe("campus_A0000000000000000000000A01");
      });
      it('visible: academic_admin → campusId=campus_A0000000000000000000000A01', () => {
        const result = maskContractByRoleVariant('academic_admin');
        expect((result as Contract & Record<string, unknown>).campusId).toBe("campus_A0000000000000000000000A01");
      });
      it('visible: teacher → campusId=campus_A0000000000000000000000A01', () => {
        const result = maskContractByRoleVariant('teacher');
        expect((result as Contract & Record<string, unknown>).campusId).toBe("campus_A0000000000000000000000A01");
      });
      it('visible: parent → campusId=campus_A0000000000000000000000A01', () => {
        const result = maskContractByRoleVariant('parent');
        expect((result as Contract & Record<string, unknown>).campusId).toBe("campus_A0000000000000000000000A01");
      });
      it('visible: hr → campusId=campus_A0000000000000000000000A01', () => {
        const result = maskContractByRoleVariant('hr');
        expect((result as Contract & Record<string, unknown>).campusId).toBe("campus_A0000000000000000000000A01");
      });
      it('visible: unknown → campusId=campus_A0000000000000000000000A01', () => {
        const result = maskContractByRoleVariant('unknown');
        expect((result as Contract & Record<string, unknown>).campusId).toBe("campus_A0000000000000000000000A01");
      });
    });

    describe('field: paidLocked', () => {
      // 业务参考（已锁定支付状态 bool，所有角色保留 — 不在 mask 列表）
      // visible=[admin,boss,sales_manager,finance,sales_owner,sales_other,marketing,academic,academic_admin,teacher,parent,hr,unknown]
      // masked=[]
      // hidden=[]

      it('visible: admin → paidLocked=false', () => {
        const result = maskContractByRoleVariant('admin');
        expect((result as Contract & Record<string, unknown>).paidLocked).toBe(false);
      });
      it('visible: boss → paidLocked=false', () => {
        const result = maskContractByRoleVariant('boss');
        expect((result as Contract & Record<string, unknown>).paidLocked).toBe(false);
      });
      it('visible: sales_manager → paidLocked=false', () => {
        const result = maskContractByRoleVariant('sales_manager');
        expect((result as Contract & Record<string, unknown>).paidLocked).toBe(false);
      });
      it('visible: finance → paidLocked=false', () => {
        const result = maskContractByRoleVariant('finance');
        expect((result as Contract & Record<string, unknown>).paidLocked).toBe(false);
      });
      it('visible: sales_owner → paidLocked=false', () => {
        const result = maskContractByRoleVariant('sales_owner');
        expect((result as Contract & Record<string, unknown>).paidLocked).toBe(false);
      });
      it('visible: sales_other → paidLocked=false', () => {
        const result = maskContractByRoleVariant('sales_other');
        expect((result as Contract & Record<string, unknown>).paidLocked).toBe(false);
      });
      it('visible: marketing → paidLocked=false', () => {
        const result = maskContractByRoleVariant('marketing');
        expect((result as Contract & Record<string, unknown>).paidLocked).toBe(false);
      });
      it('visible: academic → paidLocked=false', () => {
        const result = maskContractByRoleVariant('academic');
        expect((result as Contract & Record<string, unknown>).paidLocked).toBe(false);
      });
      it('visible: academic_admin → paidLocked=false', () => {
        const result = maskContractByRoleVariant('academic_admin');
        expect((result as Contract & Record<string, unknown>).paidLocked).toBe(false);
      });
      it('visible: teacher → paidLocked=false', () => {
        const result = maskContractByRoleVariant('teacher');
        expect((result as Contract & Record<string, unknown>).paidLocked).toBe(false);
      });
      it('visible: parent → paidLocked=false', () => {
        const result = maskContractByRoleVariant('parent');
        expect((result as Contract & Record<string, unknown>).paidLocked).toBe(false);
      });
      it('visible: hr → paidLocked=false', () => {
        const result = maskContractByRoleVariant('hr');
        expect((result as Contract & Record<string, unknown>).paidLocked).toBe(false);
      });
      it('visible: unknown → paidLocked=false', () => {
        const result = maskContractByRoleVariant('unknown');
        expect((result as Contract & Record<string, unknown>).paidLocked).toBe(false);
      });
    });

  });

  describe('student (canAccessStudent / canAccessContract / canAccessCustomer)', () => {
    // fixture: student.ownerSalesId = USER_OWNER, student.assignedTeacherId = TEACHER_OWN
    // contract.ownerUserId = USER_OWNER
    // customer.ownerUserId = USER_OWNER
    const studentRow = { ownerSalesId: USER_OWNER, assignedTeacherId: TEACHER_OWN };
    const contractRow = { ownerUserId: USER_OWNER };
    const customerRow = { ownerUserId: USER_OWNER };

    /** Helper：根据 roleVariant 选择 access 函数 + JWT 配置 */
    function callAccess(fnName: 'student' | 'contract' | 'customer', roleVariant: string): boolean {
      // 计算 sub: sales_owner / teacher_self → USER_OWNER, sales_other / teacher_other → USER_OTHER
      let sub = USER_OWNER;
      let role: AnyRoleForTest = 'admin';
      let ownTeacherId: string | null = null;
      switch (roleVariant) {
        case 'sales_owner':
          role = 'sales';
          sub = USER_OWNER;
          break;
        case 'sales_other':
          role = 'sales';
          sub = USER_OTHER;
          break;
        case 'teacher_self':
          role = 'teacher';
          ownTeacherId = TEACHER_OWN;
          break;
        case 'teacher_other':
          role = 'teacher';
          ownTeacherId = TEACHER_OTHER;
          break;
        case 'unknown':
          role = 'foobar' as TenantRole;
          break;
        case 'teacher':
          role = 'teacher';
          // canAccessStudent teacher 分支需 ownTeacherId — 缺则保守 false
          if (fnName === 'student') ownTeacherId = null;
          break;
        default:
          role = roleVariant as AnyRoleForTest;
      }
      const user = jwt(role, sub);
      if (fnName === 'student') return canAccessStudent(studentRow, user, { ownTeacherId });
      if (fnName === 'contract') return canAccessContract(contractRow, user);
      return canAccessCustomer(customerRow, user);
    }

    describe('field: canAccessStudent_owned', () => {
      // scope filter — student.ownerSalesId = USER_OWNER, student.assignedTeacherId = TEACHER_OWN
      // visible=[admin,boss,sales_manager,sales_owner,marketing,academic,academic_admin,teacher_self]
      // hidden=[sales_other,teacher_other,finance,parent,hr,unknown]

      it('visible: admin → canAccessStudent = true', () => {
        expect(callAccess('student', 'admin')).toBe(true);
      });
      it('visible: boss → canAccessStudent = true', () => {
        expect(callAccess('student', 'boss')).toBe(true);
      });
      it('visible: sales_manager → canAccessStudent = true', () => {
        expect(callAccess('student', 'sales_manager')).toBe(true);
      });
      it('visible: sales_owner → canAccessStudent = true', () => {
        expect(callAccess('student', 'sales_owner')).toBe(true);
      });
      it('visible: marketing → canAccessStudent = true', () => {
        expect(callAccess('student', 'marketing')).toBe(true);
      });
      it('visible: academic → canAccessStudent = true', () => {
        expect(callAccess('student', 'academic')).toBe(true);
      });
      it('visible: academic_admin → canAccessStudent = true', () => {
        expect(callAccess('student', 'academic_admin')).toBe(true);
      });
      it('visible: teacher_self → canAccessStudent = true', () => {
        expect(callAccess('student', 'teacher_self')).toBe(true);
      });
      it('hidden: sales_other → canAccessStudent = false', () => {
        expect(callAccess('student', 'sales_other')).toBe(false);
      });
      it('hidden: teacher_other → canAccessStudent = false', () => {
        expect(callAccess('student', 'teacher_other')).toBe(false);
      });
      it('hidden: finance → canAccessStudent = false', () => {
        expect(callAccess('student', 'finance')).toBe(false);
      });
      it('hidden: parent → canAccessStudent = false', () => {
        expect(callAccess('student', 'parent')).toBe(false);
      });
      it('hidden: hr → canAccessStudent = false', () => {
        expect(callAccess('student', 'hr')).toBe(false);
      });
      it('hidden: unknown → canAccessStudent = false', () => {
        expect(callAccess('student', 'unknown')).toBe(false);
      });
    });

    describe('field: canAccessContract_owned', () => {
      // scope filter — contract.ownerUserId = USER_OWNER
      // visible=[admin,boss,sales_manager,sales_owner,marketing,academic,academic_admin,finance,parent]
      // hidden=[sales_other,teacher,hr,unknown]

      it('visible: admin → canAccessContract = true', () => {
        expect(callAccess('contract', 'admin')).toBe(true);
      });
      it('visible: boss → canAccessContract = true', () => {
        expect(callAccess('contract', 'boss')).toBe(true);
      });
      it('visible: sales_manager → canAccessContract = true', () => {
        expect(callAccess('contract', 'sales_manager')).toBe(true);
      });
      it('visible: sales_owner → canAccessContract = true', () => {
        expect(callAccess('contract', 'sales_owner')).toBe(true);
      });
      it('visible: marketing → canAccessContract = true', () => {
        expect(callAccess('contract', 'marketing')).toBe(true);
      });
      it('visible: academic → canAccessContract = true', () => {
        expect(callAccess('contract', 'academic')).toBe(true);
      });
      it('visible: academic_admin → canAccessContract = true', () => {
        expect(callAccess('contract', 'academic_admin')).toBe(true);
      });
      it('visible: finance → canAccessContract = true', () => {
        expect(callAccess('contract', 'finance')).toBe(true);
      });
      it('visible: parent → canAccessContract = true', () => {
        expect(callAccess('contract', 'parent')).toBe(true);
      });
      it('hidden: sales_other → canAccessContract = false', () => {
        expect(callAccess('contract', 'sales_other')).toBe(false);
      });
      it('hidden: teacher → canAccessContract = false', () => {
        expect(callAccess('contract', 'teacher')).toBe(false);
      });
      it('hidden: hr → canAccessContract = false', () => {
        expect(callAccess('contract', 'hr')).toBe(false);
      });
      it('hidden: unknown → canAccessContract = false', () => {
        expect(callAccess('contract', 'unknown')).toBe(false);
      });
    });

    describe('field: canAccessCustomer_owned', () => {
      // scope filter — customer.ownerUserId = USER_OWNER
      // visible=[admin,boss,sales_manager,sales_owner,marketing,academic,academic_admin,finance]
      // hidden=[sales_other,teacher,parent,hr,unknown]

      it('visible: admin → canAccessCustomer = true', () => {
        expect(callAccess('customer', 'admin')).toBe(true);
      });
      it('visible: boss → canAccessCustomer = true', () => {
        expect(callAccess('customer', 'boss')).toBe(true);
      });
      it('visible: sales_manager → canAccessCustomer = true', () => {
        expect(callAccess('customer', 'sales_manager')).toBe(true);
      });
      it('visible: sales_owner → canAccessCustomer = true', () => {
        expect(callAccess('customer', 'sales_owner')).toBe(true);
      });
      it('visible: marketing → canAccessCustomer = true', () => {
        expect(callAccess('customer', 'marketing')).toBe(true);
      });
      it('visible: academic → canAccessCustomer = true', () => {
        expect(callAccess('customer', 'academic')).toBe(true);
      });
      it('visible: academic_admin → canAccessCustomer = true', () => {
        expect(callAccess('customer', 'academic_admin')).toBe(true);
      });
      it('visible: finance → canAccessCustomer = true', () => {
        expect(callAccess('customer', 'finance')).toBe(true);
      });
      it('hidden: sales_other → canAccessCustomer = false', () => {
        expect(callAccess('customer', 'sales_other')).toBe(false);
      });
      it('hidden: teacher → canAccessCustomer = false', () => {
        expect(callAccess('customer', 'teacher')).toBe(false);
      });
      it('hidden: parent → canAccessCustomer = false', () => {
        expect(callAccess('customer', 'parent')).toBe(false);
      });
      it('hidden: hr → canAccessCustomer = false', () => {
        expect(callAccess('customer', 'hr')).toBe(false);
      });
      it('hidden: unknown → canAccessCustomer = false', () => {
        expect(callAccess('customer', 'unknown')).toBe(false);
      });
    });

  });

  describe('parent (actorGroupOf role → group 映射，13 角色覆盖)', () => {
    // 测 actorGroupOf 对所有 13 SSOT + auxiliary 角色的 group 路由
    // parent 无 maskParent 函数 (走 ParentJwt 独立 C 端 endpoint)，但 actorGroupOf 必须识别所有角色

    it('actorGroupOf("admin") → "admin"', () => {
      expect(actorGroupOf('admin' as TenantRole)).toBe('admin');
    });
    it('actorGroupOf("boss") → "admin"', () => {
      expect(actorGroupOf('boss' as TenantRole)).toBe('admin');
    });
    it('actorGroupOf("sales_manager") → "admin"', () => {
      expect(actorGroupOf('sales_manager' as TenantRole)).toBe('admin');
    });
    it('actorGroupOf("sales") → "sales"', () => {
      expect(actorGroupOf('sales' as TenantRole)).toBe('sales');
    });
    it('actorGroupOf("marketing") → "academic"', () => {
      expect(actorGroupOf('marketing' as TenantRole)).toBe('academic');
    });
    it('actorGroupOf("academic") → "academic"', () => {
      expect(actorGroupOf('academic' as TenantRole)).toBe('academic');
    });
    it('actorGroupOf("academic_admin") → "academic"', () => {
      expect(actorGroupOf('academic_admin' as TenantRole)).toBe('academic');
    });
    it('actorGroupOf("teacher") → "teacher"', () => {
      expect(actorGroupOf('teacher' as TenantRole)).toBe('teacher');
    });
    it('actorGroupOf("finance") → "finance"', () => {
      expect(actorGroupOf('finance' as TenantRole)).toBe('finance');
    });
    it('actorGroupOf("hr") → "hr"', () => {
      expect(actorGroupOf('hr' as TenantRole)).toBe('hr');
    });
    it('actorGroupOf("parent") → "parent"', () => {
      expect(actorGroupOf('parent' as TenantRole)).toBe('parent');
    });
    it('actorGroupOf("platform_admin") → "unknown"', () => {
      expect(actorGroupOf('platform_admin' as TenantRole)).toBe('unknown');
    });
    it('actorGroupOf("finance_admin") → "unknown"', () => {
      expect(actorGroupOf('finance_admin' as TenantRole)).toBe('unknown');
    });
  });

  describe('corner cases (defensive depth — undefined user / null role / fixture immutability)', () => {
    it('maskCustomer with user=undefined → 全 PII null', () => {
      const r = maskCustomer(customerFixture(), undefined);
      expect(r.phone).toBeNull();
      expect(r.wechat).toBeNull();
      expect(r.note).toBeNull();
      expect(r.source).toBeNull();
    });

    it('maskCustomer with user=null → 全 PII null', () => {
      const r = maskCustomer(customerFixture(), null);
      expect(r.phone).toBeNull();
    });

    it('maskTeacher with user=undefined → phone undefined', () => {
      const r = maskTeacher(teacherFixture(), undefined);
      expect(r.phone).toBeUndefined();
    });

    it('maskContract with user=undefined → 价格全 0 / 业务字段保留', () => {
      const r = maskContract(contractFixture(), undefined);
      expect(r.totalAmount).toBe(0);
      expect(r.standardPrice).toBe(0);
      expect(r.discountAmount).toBe(0);
      expect(r.giftHours).toBe(0);
      expect(r.lessonHours).toBe(60); // 业务字段保留
      expect(r.status).toBe('active');
    });

    it('maskCustomer 返新对象，不污染 fixture', () => {
      const original = customerFixture();
      const r = maskCustomer(original, jwt('teacher'));
      expect(r.phone).toBeNull();
      // 原 fixture 不变
      expect(original.phone).toBe('13800138000');
    });

    it('maskTeacher 返新对象，不污染 fixture', () => {
      const original = teacherFixture();
      const r = maskTeacher(original, jwt('sales'));
      expect(r.phone).toBeUndefined();
      expect(original.phone).toBe('13900139000');
    });

    it('maskContract 返新对象，不污染 fixture', () => {
      const original = contractFixture();
      const r = maskContract(original, jwt('teacher'));
      expect(r.totalAmount).toBe(0);
      expect(original.totalAmount).toBe(9000);
    });

    it('canAccessStudent with user=undefined → false', () => {
      const studentRow = { ownerSalesId: USER_OWNER, assignedTeacherId: TEACHER_OWN };
      expect(canAccessStudent(studentRow, undefined)).toBe(false);
    });

    it('canAccessContract with user=undefined → false', () => {
      const contractRow = { ownerUserId: USER_OWNER };
      expect(canAccessContract(contractRow, undefined)).toBe(false);
    });

    it('canAccessCustomer with user=undefined → false', () => {
      const customerRow = { ownerUserId: USER_OWNER };
      expect(canAccessCustomer(customerRow, undefined)).toBe(false);
    });

    it('canAccessCustomer with ownerUserId=null (公共池) + sales → true (sales 可看公共池)', () => {
      expect(canAccessCustomer({ ownerUserId: null }, jwt('sales', USER_OTHER))).toBe(true);
    });

    it('actorGroupOf(null) → unknown', () => {
      expect(actorGroupOf(null)).toBe('unknown');
    });

    it('actorGroupOf(undefined) → unknown', () => {
      expect(actorGroupOf(undefined)).toBe('unknown');
    });

    it('actorGroupOf("sales_director") legacy → unknown (5/15 A-2 删)', () => {
      expect(actorGroupOf('sales_director' as TenantRole)).toBe('unknown');
    });
  });

});
