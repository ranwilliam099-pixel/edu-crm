/**
 * RoleFieldFilter unit tests — Sprint B.3
 *
 * 覆盖：
 *   - actorGroupOf：11 role → 8 group
 *   - maskCustomer：5 group × phone/wechat/note/source 字段
 *   - maskTeacher：5 group × phone 字段（Day 2 X1：hourlyPriceYuan 物理删除）
 *   - maskContract：5 group × standardPrice/discountAmount/totalAmount/giftHours
 *   - canAccessCustomer / canAccessContract / canAccessStudent 范围过滤
 *
 * 红线：
 *   - role 过滤后字段类型保持（set null/undefined/0，不删 key）
 *   - admin/boss 看到全字段（不被裁剪）
 *   - sales other 看不到他人客户 phone/wechat
 *   - teacher 不看合同相关信息
 *   - parent c 端独立流程，本 helper 默认全裁剪
 */

import {
  maskCustomer,
  maskTeacher,
  maskContract,
  maskStudentDetail,
  maskPhoneLevel1,
  canAccessCustomer,
  canAccessContract,
  canAccessStudent,
  actorGroupOf,
} from './role-field-filter';
import { JwtPayload, TenantRole } from '../../modules/auth/jwt-payload.interface';
import { Customer } from '../../modules/db/customer.repository';
import { Contract } from '../../modules/db/contract.repository';
import { Teacher } from '../../modules/teacher/teacher.service';
import { StudentDetail } from '../../modules/db/student.repository';

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
    // § 12B JOIN customers 家长字段（findById 路径含；含一级 PII primaryMobile）
    parentName: '小明妈妈',
    parentGender: '女',
    primaryMobile: '13800138000',
    // V55 JOIN students 字段（studentPhone = 学员本人电话，一级 PII）
    studentGender: '男',
    school: '实验小学',
    studentPhone: '13700137000',
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
  // Day 2 Phase C X1 (2026-05-19 D1.4): hourlyPriceYuan 字段物理删除（V50 DROP COLUMN）
  return {
    id: TEACHER_OWN,
    campusId: CAMPUS_A,
    name: '王老师',
    phone: '13900139000',
    userId: USER_OWNER,
    subjects: ['数学', '物理'],
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

function studentDetailFixture(overrides: Partial<StudentDetail> = {}): StudentDetail {
  return {
    id: 'student00000000000000000000A001',
    studentName: '小明',
    gradeOrAge: '三年级',
    currentGrade: '三年级',
    gradeBaseYear: 2026,
    intendedSubject: '英语',
    customerId: 'oppor000000000000000000000000A01',
    parentName: '小明妈妈',
    parentPhone: '13800138000', // 一级 PII（家长手机）
    parentGender: '女',
    campusId: CAMPUS_A,
    campusName: '总校区',
    ownerSalesId: USER_OWNER,
    ownerSalesName: '李雷',
    assignedTeacherId: TEACHER_OWN,
    assignedTeacherName: '王老师',
    notes: '内部备注',
    gender: '男',
    school: '实验小学',
    phone: '13700137000', // 一级 PII（学员本人电话）
    availableTime: ['周一晚'],
    createdAt: '2026-05-01T00:00:00.000Z',
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

  it('sales → sales group（个人销售视角，owner=me 客户明文）', () => {
    expect(actorGroupOf('sales')).toBe('sales');
  });

  it('marketing → academic group（2026-05-31 §4.1「市场视角 = 比照 academic 本校只读 + PII 脱敏」）', () => {
    // ⚠️ 行为变更（Day-A）：marketing 此前误归 sales group（走 owner=me scope + 自己客户 phone 明文）。
    //   §4.1 重新引入 marketing 后归 academic group：本校只读、customer/teacher phone 脱敏、合同价格另议（见 maskContract 单独 raw-role 放行）。
    expect(actorGroupOf('marketing')).toBe('academic');
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

  describe('academic / marketing → 联系人姓名/微信 ✅，手机一级 PII 脱敏，source ❌', () => {
    // 2026-05-31 §4.1：「手机/身份证 = §5 一级隐私，教务/老师/市场脱敏 138****8801」
    //   ⚠️ 行为变更（Day-A）：原 academic 分支 phone 明文 → 现脱敏（与 §4.1 一级隐私一致）。
    it('academic 手机脱敏（phone / primaryMobile / studentPhone 全 138****），wechat 保留', () => {
      const r = maskCustomer(customerFixture(), jwt('academic'));
      expect(r.phone).toBe('138****8000'); // 脱敏（非明文）
      expect(r.primaryMobile).toBe('138****8000'); // 家长手机一级 PII 脱敏
      expect(r.studentPhone).toBe('137****7000'); // 学员手机一级 PII 脱敏
      expect(r.wechat).toBe('wx_parent_abc'); // 微信非一级 PII，本校可见
      expect(r.parentName).toBe('小明妈妈'); // 联系人姓名 ✅
      // source 是销售跟进字段，教务不看
      expect(r.source).toBeNull();
    });

    it('academic_admin 同 academic（手机脱敏）', () => {
      const r = maskCustomer(customerFixture(), jwt('academic_admin'));
      expect(r.phone).toBe('138****8000');
      expect(r.primaryMobile).toBe('138****8000');
      expect(r.source).toBeNull();
    });

    it('marketing 比照 academic：手机脱敏 + wechat/姓名可见 + source ❌（§4.1 2026-05-31）', () => {
      const r = maskCustomer(customerFixture(), jwt('marketing'));
      expect(r.phone).toBe('138****8000'); // 脱敏（marketing 非 owner，无明文）
      expect(r.primaryMobile).toBe('138****8000');
      expect(r.studentPhone).toBe('137****7000');
      expect(r.wechat).toBe('wx_parent_abc');
      expect(r.parentName).toBe('小明妈妈');
      expect(r.source).toBeNull();
    });

    it('academic 无值手机不脱敏成 ***（保持字段类型 null/原值）', () => {
      const r = maskCustomer(
        customerFixture({ phone: null, primaryMobile: undefined }),
        jwt('academic'),
      );
      expect(r.phone).toBeNull(); // null 原样返回
      expect(r.primaryMobile).toBeUndefined(); // undefined 原样返回
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
  // Day 2 Phase C X1 (2026-05-19 D1.4 拍板): hourlyPriceYuan 字段物理删除
  //   原 spec 同 case 验证 phone + hourlyPriceYuan，X1 后仅验 phone
  //   X1「老师页面零财务字段」— V50 migration DROP COLUMN teachers.hourly_price_yuan

  describe('admin / boss → 全字段', () => {
    it('admin 看到 phone', () => {
      const r = maskTeacher(teacherFixture(), jwt('admin'));
      expect(r.phone).toBe('13900139000');
      // X1 拍板：hourlyPriceYuan 字段不应存在
      expect((r as Teacher & { hourlyPriceYuan?: number }).hourlyPriceYuan).toBeUndefined();
    });
  });

  describe('teacher isSelf=true → 全字段', () => {
    it('老师看自己档案 → phone 可见', () => {
      const r = maskTeacher(teacherFixture(), jwt('teacher'), { isSelf: true });
      expect(r.phone).toBe('13900139000');
      expect((r as Teacher & { hourlyPriceYuan?: number }).hourlyPriceYuan).toBeUndefined();
    });
  });

  describe('teacher 同校互看 → phone 不可见', () => {
    it('老师看别人档案 isSelf=false → phone undefined', () => {
      const r = maskTeacher(teacherFixture(), jwt('teacher'), { isSelf: false });
      expect(r.phone).toBeUndefined();
      // 但 name / subjects / status 保留
      expect(r.name).toBe('王老师');
      expect(r.subjects).toEqual(['数学', '物理']);
    });
  });

  describe('academic / marketing → teacher phone 脱敏（§4.3 note 一级隐私仅 self+boss+admin）', () => {
    // ⚠️ 行为变更（Day-A）：原 academic 分支 teacher phone 明文 → 现脱敏（收紧，对齐 §4.3
    //   「一级隐私（手机/身份证）仅 self + boss + admin 可见」+ §5 一级隐私）。
    it('教务双层 → teacher phone 脱敏 138****', () => {
      const r = maskTeacher(teacherFixture(), jwt('academic'));
      expect(r.phone).toBe('139****9000');
      // 教学业务字段保留
      expect(r.name).toBe('王老师');
      expect(r.subjects).toEqual(['数学', '物理']);
    });

    it('marketing（归 academic group）→ teacher phone 脱敏', () => {
      const r = maskTeacher(teacherFixture(), jwt('marketing'));
      expect(r.phone).toBe('139****9000');
      expect(r.name).toBe('王老师');
    });
  });

  describe('sales / parent → phone ❌', () => {
    it('销售推荐老师场景 phone 不可见', () => {
      const r = maskTeacher(teacherFixture(), jwt('sales'));
      expect(r.phone).toBeUndefined();
      // 但 name / subjects 保留（销售给客户介绍老师需要）
      expect(r.name).toBe('王老师');
    });

    it('家长选老师场景 phone 不可见', () => {
      const r = maskTeacher(teacherFixture(), jwt('parent' as TenantRole));
      expect(r.phone).toBeUndefined();
    });
  });

  describe('finance → phone ❌', () => {
    it('财务作账：phone 不可见（薪资全删 V38 + 零财务字段 X1）', () => {
      const r = maskTeacher(teacherFixture(), jwt('finance'));
      expect(r.phone).toBeUndefined();
    });
  });

  describe('hr role mapping（SSOT §1 5/14 Wave 1 删，仅历史 JWT 兜底）', () => {
    it('hr → phone 可见（兜底分支保留）', () => {
      const r = maskTeacher(teacherFixture(), jwt('hr'));
      expect(r.phone).toBe('13900139000');
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
      expect(r.giftHours).toBe(0); // Day 6 leader 拍板（最严）：academic 不看赠课
      expect(r.totalAmount).toBe(9000); // 总价保留（续费话术依据）
      // status / classType / signedAt 保留
      expect(r.status).toBe('active');
    });
  });

  describe('marketing → 含价格全字段（§4.1 表行「业务关系（价格/金额）市 ✅（含价格）」）', () => {
    // 2026-05-31 §4.1 表行 328：marketing 看合同含价格（获客/市场需看签约金额）。
    //   marketing 归 academic group，但 maskContract 内 raw-role 'marketing' 先放行全价格（不随 academic 隐价）。
    it('marketing 看到 standardPrice/discountAmount/totalAmount/giftHours 全值', () => {
      const r = maskContract(contractFixture(), jwt('marketing'));
      expect(r.standardPrice).toBe(9999);
      expect(r.discountAmount).toBe(999);
      expect(r.totalAmount).toBe(9000);
      expect(r.giftHours).toBe(5);
    });
  });

  describe('teacher → 合同 endpoint 不开放，maskContract 仅作纵深兜底', () => {
    it('若误入 maskContract → 金额全清零', () => {
      const r = maskContract(contractFixture(), jwt('teacher'));
      expect(r.standardPrice).toBe(0);
      expect(r.discountAmount).toBe(0);
      expect(r.totalAmount).toBe(0);
      expect(r.giftHours).toBe(0);
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

  it('teacher → 拒绝（老师不看合同相关信息）', () => {
    expect(canAccessContract(c, jwt('teacher'))).toBe(false);
  });

  it('marketing → 可看（§4.1 归 academic group，本校全放行；合同价格 maskContract 不隐）', () => {
    expect(canAccessContract(c, jwt('marketing', USER_OTHER))).toBe(true);
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

  it('marketing → 全部可看（§4.1 归 academic group，本校只读，不强制 owner=me）', () => {
    // ⚠️ 行为变更（Day-A）：marketing 此前 sales group 会被强制 owner=me；现 academic group 本校全放行。
    expect(canAccessStudent(s, jwt('marketing', USER_OTHER))).toBe(true);
  });

  it('finance → 拒绝（SSOT §4.1 student 列头不含 finance，2026-05-19 Day 6 BLOCKER B1 修）', () => {
    // student 是教学线对象，finance 仅在 §6 finance.invoice.* 有权限
    // 双层防御：student.controller @Roles 全 deny finance；本 helper 兜底返 false
    expect(canAccessStudent(s, jwt('finance'))).toBe(false);
  });

  it('parent → 拒绝（c 端独立流程）', () => {
    expect(canAccessStudent(s, jwt('parent' as TenantRole))).toBe(false);
  });

  it('user undefined → 拒绝', () => {
    expect(canAccessStudent(s, undefined)).toBe(false);
  });
});

// ============================================================
// maskPhoneLevel1（一级隐私脱敏 helper）
// ============================================================

describe('maskPhoneLevel1', () => {
  it('标准 11 位手机号 → 前 3 + **** + 后 4', () => {
    expect(maskPhoneLevel1('13800138001')).toBe('138****8001');
    expect(maskPhoneLevel1('13700137000')).toBe('137****7000');
  });

  it('null / undefined / 空串 → 原样返回（保持字段类型，不脱敏成 ***）', () => {
    expect(maskPhoneLevel1(null)).toBeNull();
    expect(maskPhoneLevel1(undefined)).toBeUndefined();
    expect(maskPhoneLevel1('')).toBe('');
  });

  it('长度 < 7（非标准号）→ ***（不暴露任何片段）', () => {
    expect(maskPhoneLevel1('123')).toBe('***');
    expect(maskPhoneLevel1('123456')).toBe('***');
  });

  it('算法与全库 maskPhoneForDisplay / maskPhoneForAudit 一致（前3后4）', () => {
    // customer.repository.maskPhoneForDisplay / teacher.controller.maskPhoneForAudit
    //   / parent.repository.maskPhone 全用 `${slice(0,3)}****${slice(-4)}`
    const phone = '13912345678';
    expect(maskPhoneLevel1(phone)).toBe(`${phone.slice(0, 3)}****${phone.slice(-4)}`);
  });
});

// ============================================================
// maskStudentDetail（学员档案 — 一级 PII 联系字段脱敏，2026-05-31 §4.1）
// ============================================================

describe('maskStudentDetail', () => {
  describe('admin / boss → 全字段明文（含 parentPhone / phone）', () => {
    it('admin 看到家长手机 + 学员电话明文', () => {
      const r = maskStudentDetail(studentDetailFixture(), jwt('admin'));
      expect(r.parentPhone).toBe('13800138000');
      expect(r.phone).toBe('13700137000');
      expect(r.parentName).toBe('小明妈妈');
    });

    it('boss 同 admin（全字段明文）', () => {
      const r = maskStudentDetail(studentDetailFixture(), jwt('boss'));
      expect(r.parentPhone).toBe('13800138000');
      expect(r.phone).toBe('13700137000');
    });
  });

  describe('sales 自己学员（ownerSalesId=me）→ 手机明文（§4.1 自己销售可见明文）', () => {
    it('sales owner=me isOwnerSelf=true → parentPhone / phone 明文', () => {
      const r = maskStudentDetail(studentDetailFixture(), jwt('sales', USER_OWNER), {
        isOwnerSelf: true,
      });
      expect(r.parentPhone).toBe('13800138000');
      expect(r.phone).toBe('13700137000');
    });
  });

  describe('sales 别人学员 → 手机脱敏（个人销售不看他人客户一级 PII）', () => {
    it('sales isOwnerSelf=false → parentPhone / phone 脱敏，姓名保留', () => {
      const r = maskStudentDetail(studentDetailFixture(), jwt('sales', USER_OTHER), {
        isOwnerSelf: false,
      });
      expect(r.parentPhone).toBe('138****8000');
      expect(r.phone).toBe('137****7000');
      // 联系人姓名 / 基础信息保留
      expect(r.parentName).toBe('小明妈妈');
      expect(r.studentName).toBe('小明');
    });
  });

  describe('teacher → 联系人姓名/性别 ✅ + 手机脱敏（§4.1 2026-05-31 放开，墙②脱敏）', () => {
    it('teacher 看到 parentName/parentGender，但 parentPhone / phone 脱敏', () => {
      const r = maskStudentDetail(studentDetailFixture(), jwt('teacher'));
      // 逆转旧实现「teacher → parentName/parentGender 全 null」
      expect(r.parentName).toBe('小明妈妈'); // §4.1 联系人姓名 ✅
      expect(r.parentGender).toBe('女'); // §4.1 联系人 ✅
      expect(r.parentPhone).toBe('138****8000'); // 墙② 一级 PII 脱敏
      expect(r.phone).toBe('137****7000'); // 学员电话一级 PII 脱敏
    });
  });

  describe('academic / academic_admin / marketing → 联系人姓名 ✅ + 手机脱敏', () => {
    it('academic 手机脱敏，姓名/性别保留', () => {
      const r = maskStudentDetail(studentDetailFixture(), jwt('academic'));
      expect(r.parentPhone).toBe('138****8000');
      expect(r.phone).toBe('137****7000');
      expect(r.parentName).toBe('小明妈妈');
    });

    it('academic_admin 同 academic', () => {
      const r = maskStudentDetail(studentDetailFixture(), jwt('academic_admin'));
      expect(r.parentPhone).toBe('138****8000');
      expect(r.phone).toBe('137****7000');
    });

    it('marketing 比照 academic：手机脱敏 + 姓名保留（§4.1 市场可读学员）', () => {
      const r = maskStudentDetail(studentDetailFixture(), jwt('marketing'));
      expect(r.parentPhone).toBe('138****8000');
      expect(r.phone).toBe('137****7000');
      expect(r.parentName).toBe('小明妈妈');
      expect(r.studentName).toBe('小明');
    });
  });

  describe('finance / parent / unknown → 兜底脱敏（纵深防御；endpoint @Roles 已挡）', () => {
    it('finance → 手机脱敏（学员档案非其职，@Roles 已 deny，本函数兜底）', () => {
      const r = maskStudentDetail(studentDetailFixture(), jwt('finance'));
      expect(r.parentPhone).toBe('138****8000');
      expect(r.phone).toBe('137****7000');
    });

    it('user undefined → 手机脱敏', () => {
      const r = maskStudentDetail(studentDetailFixture(), undefined);
      expect(r.parentPhone).toBe('138****8000');
      expect(r.phone).toBe('137****7000');
    });
  });

  it('mask 返回新对象，不污染原对象', () => {
    const original = studentDetailFixture();
    const r = maskStudentDetail(original, jwt('academic'));
    expect(r.parentPhone).toBe('138****8000');
    // 原对象不变
    expect(original.parentPhone).toBe('13800138000');
  });

  it('手机字段为 null → 原样 null（不脱敏成 ***）', () => {
    const r = maskStudentDetail(
      studentDetailFixture({ parentPhone: null, phone: null }),
      jwt('teacher'),
    );
    expect(r.parentPhone).toBeNull();
    expect(r.phone).toBeNull();
    // 姓名仍保留
    expect(r.parentName).toBe('小明妈妈');
  });
});
