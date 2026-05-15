/**
 * RoleFieldFilter unit tests — Sprint B.3
 *
 * 覆盖：
 *   - actorGroupOf：11 role → 8 group
 *   - maskCustomer：5 group × phone/wechat/note/source 字段
 *   - maskTeacher：5 group × phone/hourlyPriceYuan 字段
 *   - maskContract：5 group × standardPrice/discountAmount/totalAmount/giftHours
 *   - canAccessCustomer / canAccessContract / canAccessStudent 范围过滤
 *
 * 红线：
 *   - role 过滤后字段类型保持（set null/undefined/0，不删 key）
 *   - admin/boss 看到全字段（不被裁剪）
 *   - sales other 看不到他人客户 phone/wechat
 *   - teacher 看不到合同金额
 *   - parent c 端独立流程，本 helper 默认全裁剪
 */

import {
  maskCustomer,
  maskTeacher,
  maskContract,
  canAccessCustomer,
  canAccessContract,
  canAccessStudent,
  actorGroupOf,
} from './role-field-filter';
import { JwtPayload, TenantRole } from '../../modules/auth/jwt-payload.interface';
import { Customer } from '../../modules/db/customer.repository';
import { Contract } from '../../modules/db/contract.repository';
import { Teacher } from '../../modules/teacher/teacher.service';

// ============================================================
// Fixtures
// ============================================================

const TENANT_A = 'TENANTA00000000000000000000000A1';
const CAMPUS_A = 'campus_A0000000000000000000000A01';
const USER_OWNER = 'salesA00000000000000000000000A01';
const USER_OTHER = 'salesB00000000000000000000000A02';
const TEACHER_OWN = 'teacher00000000000000000000A001';

function jwt(role: TenantRole, sub = USER_OWNER, campusId: string | null = CAMPUS_A): JwtPayload {
  return { sub, tenantId: TENANT_A, role, campusId };
}

function customerFixture(overrides: Partial<Customer> = {}): Customer {
  return {
    id: 'oppor000000000000000000000000A01',
    studentId: 'student00000000000000000000A001',
    studentName: '小明',
    gradeOrAge: '三年级',
    intendedSubject: '英语',
    ownerUserId: USER_OWNER,
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

function teacherFixture(overrides: Partial<Teacher> = {}): Teacher {
  return {
    id: TEACHER_OWN,
    campusId: CAMPUS_A,
    name: '王老师',
    phone: '13900139000',
    userId: USER_OWNER,
    subjects: ['数学', '物理'],
    hourlyPriceYuan: 200,
    status: '在职',
    ...overrides,
  } as Teacher;
}

function contractFixture(overrides: Partial<Contract> = {}): Contract {
  return {
    id: 'contract0000000000000000000A001',
    studentId: 'student00000000000000000000A001',
    courseProductId: null,
    courseProductName: '一对一英语',
    ownerUserId: USER_OWNER,
    opportunityId: 'oppor000000000000000000000000A01',
    campusId: CAMPUS_A,
    classType: '一对一',
    lessonHours: 60,
    standardPrice: 9999,
    discountAmount: 999,
    giftHours: 5,
    totalAmount: 9000,
    orderType: '新签',
    status: 'active',
    paidLocked: false,
    signedAt: '2026-05-08T00:00:00.000Z',
    activatedAt: '2026-05-08T00:00:00.000Z',
    createdAt: '2026-05-08T00:00:00.000Z',
    updatedAt: '2026-05-08T00:00:00.000Z',
    ...overrides,
  };
}

// ============================================================
// actorGroupOf
// ============================================================

describe('actorGroupOf', () => {
  it('admin/boss → admin group', () => {
    expect(actorGroupOf('admin')).toBe('admin');
    expect(actorGroupOf('boss')).toBe('admin');
  });

  it('sales_manager → admin group（销售校内主管收口）', () => {
    // 拍板：sales_manager 校内主管字段权限与 admin / boss 一致（跨销售可看全部）
    expect(actorGroupOf('sales_manager')).toBe('admin');
  });

  it('sales_director (legacy, 5/15 A-2 已删) → unknown group（保守安全）', () => {
    // 5/15 A-2：sales_director 不在拍板权威 9 角色清单（fields-by-role.md L6-17）
    //   - actorGroupOf switch 不再含 sales_director case → 落 default → unknown
    //   - 历史 JWT 含此 role（不应发生）或字符串透传时：全字段 mask（兜底安全）
    expect(actorGroupOf('sales_director' as never)).toBe('unknown');
  });

  it('sales/marketing → sales group（个人销售视角）', () => {
    expect(actorGroupOf('sales')).toBe('sales');
    expect(actorGroupOf('marketing')).toBe('sales');
  });

  it('academic/academic_admin → academic group', () => {
    expect(actorGroupOf('academic')).toBe('academic');
    expect(actorGroupOf('academic_admin')).toBe('academic');
  });

  it('teacher → teacher group', () => {
    expect(actorGroupOf('teacher')).toBe('teacher');
  });

  it('finance → finance group', () => {
    expect(actorGroupOf('finance')).toBe('finance');
  });

  it('hr → hr group', () => {
    expect(actorGroupOf('hr')).toBe('hr');
  });

  it('parent → parent group', () => {
    expect(actorGroupOf('parent')).toBe('parent');
  });

  it('未识别/空 → unknown', () => {
    expect(actorGroupOf(null)).toBe('unknown');
    expect(actorGroupOf(undefined)).toBe('unknown');
    expect(actorGroupOf('foo' as TenantRole)).toBe('unknown');
  });
});

// ============================================================
// maskCustomer
// ============================================================

describe('maskCustomer', () => {
  describe('admin / boss → 全字段保留', () => {
    it('admin 看到 phone/wechat/source/note', () => {
      const r = maskCustomer(customerFixture(), jwt('admin'));
      expect(r.phone).toBe('13800138000');
      expect(r.wechat).toBe('wx_parent_abc');
      expect(r.source).toBe('抖音');
      expect(r.note).toBe('内部跟进备注');
    });

    it('boss 看到 phone/wechat/source/note', () => {
      const r = maskCustomer(customerFixture(), jwt('boss'));
      expect(r.phone).toBe('13800138000');
      expect(r.wechat).toBe('wx_parent_abc');
    });
  });

  describe('sales owner=me → 全字段保留', () => {
    it('sales 自己客户 isOwnerSelf=true → phone/wechat 可见', () => {
      const r = maskCustomer(customerFixture(), jwt('sales', USER_OWNER), { isOwnerSelf: true });
      expect(r.phone).toBe('13800138000');
      expect(r.wechat).toBe('wx_parent_abc');
      expect(r.note).toBe('内部跟进备注');
    });
  });

  describe('sales other → phone/wechat/note/source 全 null', () => {
    it('sales 看别人客户 isOwnerSelf=false → phone null', () => {
      const r = maskCustomer(customerFixture(), jwt('sales', USER_OTHER), { isOwnerSelf: false });
      expect(r.phone).toBeNull();
      expect(r.wechat).toBeNull();
      expect(r.note).toBeNull();
      expect(r.source).toBeNull();
      // 非敏感字段保留
      expect(r.studentName).toBe('小明');
      expect(r.stage).toBe('初步接触');
    });

    it('sales 不传 isOwnerSelf → 默认 false（保守）', () => {
      const r = maskCustomer(customerFixture(), jwt('sales', USER_OTHER));
      expect(r.phone).toBeNull();
      expect(r.wechat).toBeNull();
    });
  });

  describe('academic → phone/wechat ✅，source ❌', () => {
    it('academic 看到 phone/wechat（拍板「本校已成交可看」）', () => {
      const r = maskCustomer(customerFixture(), jwt('academic'));
      expect(r.phone).toBe('13800138000');
      expect(r.wechat).toBe('wx_parent_abc');
      // source 是销售跟进字段，教务不看
      expect(r.source).toBeNull();
    });

    it('academic_admin 同 academic', () => {
      const r = maskCustomer(customerFixture(), jwt('academic_admin'));
      expect(r.phone).toBe('13800138000');
      expect(r.source).toBeNull();
    });
  });

  describe('finance → phone/wechat/note/source 全 null', () => {
    it('finance 看 customer → phone/wechat null（只作账）', () => {
      const r = maskCustomer(customerFixture(), jwt('finance'));
      expect(r.phone).toBeNull();
      expect(r.wechat).toBeNull();
      expect(r.note).toBeNull();
      expect(r.source).toBeNull();
      // 但保留 stage / signedAt / lostReason 等作账字段
      expect(r.stage).toBe('初步接触');
    });
  });

  describe('teacher / hr / parent / unknown → 全敏感 null', () => {
    it('teacher 不该看 customer PII', () => {
      const r = maskCustomer(customerFixture(), jwt('teacher'));
      expect(r.phone).toBeNull();
      expect(r.wechat).toBeNull();
    });

    it('hr 不看 customer PII（HR 不参与客户线索）', () => {
      const r = maskCustomer(customerFixture(), jwt('hr'));
      expect(r.phone).toBeNull();
      expect(r.wechat).toBeNull();
    });

    it('parent C 端不应走 B 端 customer 路径', () => {
      const r = maskCustomer(customerFixture(), jwt('parent' as TenantRole));
      expect(r.phone).toBeNull();
      expect(r.wechat).toBeNull();
    });

    it('user undefined → 全 null', () => {
      const r = maskCustomer(customerFixture(), undefined);
      expect(r.phone).toBeNull();
      expect(r.wechat).toBeNull();
    });
  });

  it('mask 返回新对象，不污染原对象', () => {
    const original = customerFixture();
    const r = maskCustomer(original, jwt('sales', USER_OTHER));
    expect(r.phone).toBeNull();
    // 原对象不变
    expect(original.phone).toBe('13800138000');
  });
});

// ============================================================
// maskTeacher
// ============================================================

describe('maskTeacher', () => {
  describe('admin / boss → 全字段', () => {
    it('admin 看到 phone + hourlyPriceYuan', () => {
      const r = maskTeacher(teacherFixture(), jwt('admin'));
      expect(r.phone).toBe('13900139000');
      expect(r.hourlyPriceYuan).toBe(200);
    });
  });

  describe('teacher isSelf=true → 全字段', () => {
    it('老师看自己档案 → phone/price 都可见', () => {
      const r = maskTeacher(teacherFixture(), jwt('teacher'), { isSelf: true });
      expect(r.phone).toBe('13900139000');
      expect(r.hourlyPriceYuan).toBe(200);
    });
  });

  describe('teacher 同校互看 → phone/price 不可见', () => {
    it('老师看别人档案 isSelf=false → phone undefined', () => {
      const r = maskTeacher(teacherFixture(), jwt('teacher'), { isSelf: false });
      expect(r.phone).toBeUndefined();
      expect(r.hourlyPriceYuan).toBeUndefined();
      // 但 name / subjects / status 保留
      expect(r.name).toBe('王老师');
      expect(r.subjects).toEqual(['数学', '物理']);
    });
  });

  describe('academic → phone ✅ price ✅', () => {
    it('教务双层 👁 看 phone/price', () => {
      const r = maskTeacher(teacherFixture(), jwt('academic'));
      expect(r.phone).toBe('13900139000');
      expect(r.hourlyPriceYuan).toBe(200);
    });
  });

  describe('sales / parent → phone ❌ price ❌', () => {
    it('销售推荐老师场景 phone 不可见', () => {
      const r = maskTeacher(teacherFixture(), jwt('sales'));
      expect(r.phone).toBeUndefined();
      expect(r.hourlyPriceYuan).toBeUndefined();
      // 但 name / subjects 保留（销售给客户介绍老师需要）
      expect(r.name).toBe('王老师');
    });

    it('家长选老师场景 phone 不可见', () => {
      const r = maskTeacher(teacherFixture(), jwt('parent' as TenantRole));
      expect(r.phone).toBeUndefined();
      expect(r.hourlyPriceYuan).toBeUndefined();
    });
  });

  describe('finance → phone ❌ price ✅', () => {
    it('财务作账：phone 不可见，price 可见', () => {
      const r = maskTeacher(teacherFixture(), jwt('finance'));
      expect(r.phone).toBeUndefined();
      expect(r.hourlyPriceYuan).toBe(200);
    });
  });

  describe('hr → 全字段（薪资场景历史，V38 后薪资已删）', () => {
    it('hr 跨校管理员工 → phone/price 都可见', () => {
      const r = maskTeacher(teacherFixture(), jwt('hr'));
      expect(r.phone).toBe('13900139000');
      expect(r.hourlyPriceYuan).toBe(200);
    });
  });

  it('mask 返回新对象，不污染原对象', () => {
    const original = teacherFixture();
    const r = maskTeacher(original, jwt('sales', USER_OTHER));
    expect(r.phone).toBeUndefined();
    expect(original.phone).toBe('13900139000');
  });
});

// ============================================================
// maskContract
// ============================================================

describe('maskContract', () => {
  describe('admin / finance → 全字段', () => {
    it('admin 看到 standardPrice/discountAmount/totalAmount/giftHours', () => {
      const r = maskContract(contractFixture(), jwt('admin'));
      expect(r.standardPrice).toBe(9999);
      expect(r.discountAmount).toBe(999);
      expect(r.totalAmount).toBe(9000);
      expect(r.giftHours).toBe(5);
    });

    it('finance 看到全字段（作账）', () => {
      const r = maskContract(contractFixture(), jwt('finance'));
      expect(r.standardPrice).toBe(9999);
      expect(r.totalAmount).toBe(9000);
    });
  });

  describe('sales owner=me → 全字段', () => {
    it('sales 自己签约的合同 isOwnerSelf=true → 全字段', () => {
      const r = maskContract(contractFixture(), jwt('sales', USER_OWNER), { isOwnerSelf: true });
      expect(r.standardPrice).toBe(9999);
      expect(r.discountAmount).toBe(999);
      expect(r.totalAmount).toBe(9000);
    });
  });

  describe('sales other → 金额清零', () => {
    it('sales 看别人合同 isOwnerSelf=false → 价格全 0', () => {
      const r = maskContract(contractFixture(), jwt('sales', USER_OTHER), { isOwnerSelf: false });
      expect(r.standardPrice).toBe(0);
      expect(r.discountAmount).toBe(0);
      expect(r.totalAmount).toBe(0);
      expect(r.giftHours).toBe(0);
      // 但 classType / status / signedAt 保留
      expect(r.classType).toBe('一对一');
      expect(r.status).toBe('active');
    });
  });

  describe('academic → 仅 totalAmount，价格细节 ❌', () => {
    it('教务看合同：仅 totalAmount 保留作续费话术', () => {
      const r = maskContract(contractFixture(), jwt('academic'));
      expect(r.standardPrice).toBe(0); // 价格细节不看
      expect(r.discountAmount).toBe(0); // 折扣不看
      expect(r.totalAmount).toBe(9000); // 总价保留（续费话术依据）
      // status / classType / signedAt 保留
      expect(r.status).toBe('active');
    });
  });

  describe('teacher → 金额全 0', () => {
    it('老师看合同 → 金额全清零，仅看 status/classType/lessonHours', () => {
      const r = maskContract(contractFixture(), jwt('teacher'));
      expect(r.standardPrice).toBe(0);
      expect(r.discountAmount).toBe(0);
      expect(r.totalAmount).toBe(0);
      expect(r.giftHours).toBe(0);
      // 教学执行字段保留
      expect(r.lessonHours).toBe(60);
      expect(r.classType).toBe('一对一');
      expect(r.status).toBe('active');
    });
  });

  describe('parent → totalAmount ✅，discountAmount/giftHours ❌', () => {
    it('家长看自己孩子合同：总价 ✅，折扣赠课 ❌', () => {
      const r = maskContract(contractFixture(), jwt('parent' as TenantRole));
      expect(r.totalAmount).toBe(9000); // 家长应知道总价
      expect(r.standardPrice).toBe(9999); // 原价也可看（折扣对比）
      expect(r.discountAmount).toBe(0);
      expect(r.giftHours).toBe(0);
    });
  });

  describe('hr / unknown → 价格全 0', () => {
    it('hr 不看 contract 价格', () => {
      const r = maskContract(contractFixture(), jwt('hr'));
      expect(r.standardPrice).toBe(0);
      expect(r.totalAmount).toBe(0);
    });

    it('user undefined → 价格全 0', () => {
      const r = maskContract(contractFixture(), undefined);
      expect(r.standardPrice).toBe(0);
      expect(r.totalAmount).toBe(0);
    });
  });

  it('mask 返回新对象，不污染原对象', () => {
    const original = contractFixture();
    const r = maskContract(original, jwt('sales', USER_OTHER));
    expect(r.totalAmount).toBe(0);
    expect(original.totalAmount).toBe(9000);
  });
});

// ============================================================
// canAccessCustomer
// ============================================================

describe('canAccessCustomer', () => {
  const c = { ownerUserId: USER_OWNER };

  it('admin → 全部可看', () => {
    expect(canAccessCustomer(c, jwt('admin'))).toBe(true);
    expect(canAccessCustomer(c, jwt('boss'))).toBe(true);
  });

  it('sales 自己 → 可看', () => {
    expect(canAccessCustomer(c, jwt('sales', USER_OWNER))).toBe(true);
  });

  it('sales 别人客户 → 拒绝', () => {
    expect(canAccessCustomer(c, jwt('sales', USER_OTHER))).toBe(false);
  });

  it('sales 公共池（ownerUserId=null）→ 可看', () => {
    expect(canAccessCustomer({ ownerUserId: null }, jwt('sales', USER_OTHER))).toBe(true);
  });

  it('sales_manager → 全部可看（销售校内主管收口）', () => {
    expect(canAccessCustomer(c, jwt('sales_manager', USER_OTHER))).toBe(true);
  });

  it('sales_director (legacy, 5/15 A-2 已删) → 拒绝（unknown group 默认拒绝）', () => {
    // 5/15 A-2：actorGroupOf 不识别 sales_director → unknown → canAccessCustomer 兜底返 false
    expect(canAccessCustomer(c, jwt('sales_director' as never, USER_OTHER))).toBe(false);
  });

  it('academic → 全部可看（campus 校验在 controller）', () => {
    expect(canAccessCustomer(c, jwt('academic'))).toBe(true);
  });

  it('finance → 全部可看（access=true + maskCustomer 字段全 null 双层防御等效拍板「联系人/跟进/接棒 ❌」+「购业 ✅」）', () => {
    expect(canAccessCustomer(c, jwt('finance'))).toBe(true);
  });

  it('teacher → 拒绝（不该看客户）', () => {
    expect(canAccessCustomer(c, jwt('teacher'))).toBe(false);
  });

  it('parent → 拒绝（c 端独立流程）', () => {
    expect(canAccessCustomer(c, jwt('parent' as TenantRole))).toBe(false);
  });

  it('user undefined → 拒绝', () => {
    expect(canAccessCustomer(c, undefined)).toBe(false);
  });
});

// ============================================================
// canAccessContract
// ============================================================

describe('canAccessContract', () => {
  const c = { ownerUserId: USER_OWNER };

  it('admin / finance → 全部可看', () => {
    expect(canAccessContract(c, jwt('admin'))).toBe(true);
    expect(canAccessContract(c, jwt('finance'))).toBe(true);
  });

  it('sales 自己 → 可看', () => {
    expect(canAccessContract(c, jwt('sales', USER_OWNER))).toBe(true);
  });

  it('sales 别人 → 拒绝', () => {
    expect(canAccessContract(c, jwt('sales', USER_OTHER))).toBe(false);
  });

  it('sales_manager → 全部可看（销售校内主管收口）', () => {
    expect(canAccessContract(c, jwt('sales_manager', USER_OTHER))).toBe(true);
  });

  it('sales_director (legacy, 5/15 A-2 已删) → 拒绝（unknown group 兜底）', () => {
    expect(canAccessContract(c, jwt('sales_director' as never, USER_OTHER))).toBe(false);
  });

  it('teacher → 可看（学生关系在 controller 校验）', () => {
    expect(canAccessContract(c, jwt('teacher'))).toBe(true);
  });

  it('hr → 拒绝（不该看合同）', () => {
    expect(canAccessContract(c, jwt('hr'))).toBe(false);
  });
});

// ============================================================
// canAccessStudent
// ============================================================

describe('canAccessStudent', () => {
  const s = { ownerSalesId: USER_OWNER, assignedTeacherId: TEACHER_OWN };

  it('admin → 全部可看', () => {
    expect(canAccessStudent(s, jwt('admin'))).toBe(true);
  });

  it('sales 自己学生 → 可看', () => {
    expect(canAccessStudent(s, jwt('sales', USER_OWNER))).toBe(true);
  });

  it('sales 别人学生 → 拒绝', () => {
    expect(canAccessStudent(s, jwt('sales', USER_OTHER))).toBe(false);
  });

  it('teacher 主带学生 → 可看', () => {
    expect(
      canAccessStudent(s, jwt('teacher'), { ownTeacherId: TEACHER_OWN }),
    ).toBe(true);
  });

  it('teacher 非主带学生 → 拒绝', () => {
    expect(
      canAccessStudent(s, jwt('teacher'), { ownTeacherId: 'other_teacher_id_000000000000A99' }),
    ).toBe(false);
  });

  it('teacher 未传 ownTeacherId → 拒绝（保守）', () => {
    expect(canAccessStudent(s, jwt('teacher'))).toBe(false);
  });

  it('sales_manager → 全部可看（销售校内主管收口）', () => {
    expect(canAccessStudent(s, jwt('sales_manager', USER_OTHER))).toBe(true);
  });

  it('sales_director (legacy, 5/15 A-2 已删) → 拒绝（unknown group 兜底）', () => {
    expect(canAccessStudent(s, jwt('sales_director' as never, USER_OTHER))).toBe(false);
  });

  it('academic → 全部可看', () => {
    expect(canAccessStudent(s, jwt('academic'))).toBe(true);
  });

  it('finance → 全部可看（作账）', () => {
    expect(canAccessStudent(s, jwt('finance'))).toBe(true);
  });

  it('parent → 拒绝（c 端独立流程）', () => {
    expect(canAccessStudent(s, jwt('parent' as TenantRole))).toBe(false);
  });

  it('user undefined → 拒绝', () => {
    expect(canAccessStudent(s, undefined)).toBe(false);
  });
});
