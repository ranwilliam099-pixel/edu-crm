#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * seed-traceable-one-tenant.js — 2026-05-22 KPI 可追溯种子（用户拍板)
 *
 * 用户拍板 (5/22):
 *   "在数据库写两个销售，三个老师，三个教务，一个校长，一个老板，10个学生
 *    每一个数据都需要有业务来源，来源一定是最小颗粒度，签约，续约，排课，消课
 *    如果设计有，但是数据不知道从哪里来，你不要幻想，放个0"
 *
 * 2026-05-31 重建明心 demo 扩展（全角色 + 全业务生命周期 + 账目自洽）:
 *   生产租户已 drop, 全测试数据无生产数据 → 本 generator 产「完整可登录可走查」种子.
 *   新增: 5 角色账号 / 明心归属切分 / opportunities 漏斗 / invoices 双态 /
 *         course_packages + student_course_packages (修「生效合同无课时包」) /
 *         confirmed course_consumptions + lesson_feedbacks (账目对平).
 *
 * 输入: --tenant-schema=tenant_XXX --tenant-id=XXX --campus-id=XXX --output=path
 * 输出: 一份 SQL 文件 包含
 *   1.  TRUNCATE 业务表（保留 schema + campuses 占位）
 *   2.  15 user — 全 9 角色覆盖:
 *         admin / boss / sales×2(李雷韩梅) / academic×3 / teacher×3
 *         + sales_manager(明心) / finance / marketing / hr / academic_admin
 *   3.  3 teachers (双轨 + linked to teacher users)
 *   4.  1 course_product
 *   5.  10 customer → 10 student (owner 三方轮转 李雷/韩梅/明心)
 *   6.  10 contract (8 新签 + 2 续费; i=0..6 paid / i=7,8,9 pending)
 *   7.  student_teacher_bindings (主带 mapping)
 *   7A. 14 opportunities (漏斗 8 阶段 + 试听转化 + 流失原因; owner 三方)
 *   7B. 1 course_package + 7 student_course_packages (每 paid 合同 1 课时包)
 *   7C. 10 invoices (7 issued 已收款 + 3 pending 待出票; finance 建单)
 *   8.  30 schedules (14 已完成消课 + 16 已排课/今日/未来)
 *   11. 14 lesson_feedbacks + 14 confirmed course_consumptions (1:1 账目对平)
 *   10. 6 monthly_kpi_targets (校长下发 3 academic + 3 teacher 月度目标)
 *   12. 3 homework_assignments + 3 assessments (业务起点)
 *   13. 3 public.parents + bindings (C 端家长起点)
 *
 * 每行 INSERT 上方有 SQL 注释，标 KPI 字段溯源:
 *   -- 影响 KPI: admin.signed / sales.personalSigned (本月新签 contract)
 *
 * 用法:
 *   ENCRYPTION_KEY=<b64> HASH_KEY=<b64> \
 *   node scripts/seed-traceable-one-tenant.js \
 *     --tenant-schema=tenant_jfrw2a04kfhkft7wakq66xf253wfvvv6 \
 *     --tenant-id=jfrw2a04kfhkft7wakq66xf253wfvvv6 \
 *     --campus-id=$(uuidgen-style-32char) \
 *     --output=/tmp/seed-traceable.sql
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');

// ====== 参数 ======
const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)=(.+)$/);
  if (m) args[m[1]] = m[2];
}
const TENANT_SCHEMA = args['tenant-schema'];
const TENANT_ID = args['tenant-id'];
const CAMPUS_ID = args['campus-id'];
const OUTPUT = args['output'] || '/tmp/seed-traceable.sql';

if (!TENANT_SCHEMA || !TENANT_ID || !CAMPUS_ID) {
  console.error('Usage: --tenant-schema=tenant_X --tenant-id=X --campus-id=X --output=path');
  process.exit(2);
}

// ====== 加密 helper (V40/V41 PII 双写) ======
const ENC_KEY = Buffer.from(process.env.ENCRYPTION_KEY || '', 'base64');
const HMAC_KEY = Buffer.from(process.env.HASH_KEY || '', 'base64');
if (ENC_KEY.length !== 32 || HMAC_KEY.length !== 32) {
  console.error('ENCRYPTION_KEY / HASH_KEY must decode to 32 bytes');
  process.exit(2);
}
function aesGcm(plain) {
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);
}
function hmacHex(plain) {
  if (!plain) return null;
  return crypto.createHmac('sha256', HMAC_KEY).update(String(plain), 'utf8').digest();
}

// ====== ULID 确定性 (相同 key 同一 ID, 幂等再跑) ======
function ulid(prefix, idx = 0) {
  const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const h = crypto.createHash('sha256');
  h.update(`${TENANT_ID}|traceable|${prefix}|${idx}`);
  const d = h.digest();
  let r = '';
  for (let i = 0; i < 20 && r.length < 32; i++) {
    r += ALPHA[d[i] & 0x1f];
    r += ALPHA[(d[i] >> 3) & 0x1f];
  }
  return r.slice(0, 32).toLowerCase();
}

// ====== bcrypt (demo 密码 Demo@12345) ======
const bcryptjs = require('bcryptjs');
const PASSWORD_HASH = bcryptjs.hashSync('Demo@12345', 4);

// ====== SQL escape ======
function S(v) { return v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`; }
function B(buf) { return buf ? `'\\x${buf.toString('hex')}'::bytea` : 'NULL'; }
function N(n) { return n == null ? 'NULL' : String(n); }
function T(d) { return d ? `'${d instanceof Date ? d.toISOString() : d}'::timestamptz` : 'NULL'; }
function J(o) { return o ? `'${JSON.stringify(o).replace(/'/g, "''")}'::jsonb` : 'NULL'; }

// ====== 时间常量 (KPI 30 天滚动窗口) ======
const NOW = new Date();
function daysAgo(d) { return new Date(NOW.getTime() - d * 86400000); }
function daysFromNow(d) { return new Date(NOW.getTime() + d * 86400000); }
function thisMonthStr() { return NOW.toISOString().slice(0, 7); }

// ====== 角色 user 规划 ======
// 注: V2 schema users.campus_id NOT NULL FK campuses(id) — admin 用同一 campus 兼容 (拍板说 admin 跨校, V2 schema 未实现 NULL)
//
// 2026-05-31 全角色覆盖扩展 (重建明心 demo 租户):
//   原 10 user (admin/boss/2sales/3academic/3teacher) 保留 i=0..9 (id 不变, 幂等)
//   新增 5 角色 user i=10..14 同 campus 同密码 Demo@12345:
//     i=10 sales_manager (李雷/韩梅 + 明心 自己也算销售线, 是经理) — 「明心」
//     i=11 finance / i=12 marketing / i=13 hr / i=14 academic_admin
//   全部 5 个 role 值都在 V48 users_role_check 白名单内 (已对照 migration 确认):
//     sales_manager / finance / marketing / hr / academic_admin 均允许 ✓
const USERS = [
  // i=0 admin (本 demo 单校, 占位 campus)
  { i: 0, role: 'admin',     name: '老板·张总',  phone: '13800001000', campus_id: CAMPUS_ID },
  // i=1 boss (本校长)
  { i: 1, role: 'boss',      name: '校长·王主任', phone: '13800001001', campus_id: CAMPUS_ID },
  // i=2-3 sales (2 销售)
  { i: 2, role: 'sales',     name: '销售·李雷',   phone: '13800001002', campus_id: CAMPUS_ID },
  { i: 3, role: 'sales',     name: '销售·韩梅',   phone: '13800001003', campus_id: CAMPUS_ID },
  // i=4-6 academic (3 教务)
  { i: 4, role: 'academic',  name: '教务·赵丽',   phone: '13800001004', campus_id: CAMPUS_ID },
  { i: 5, role: 'academic',  name: '教务·钱倩',   phone: '13800001005', campus_id: CAMPUS_ID },
  { i: 6, role: 'academic',  name: '教务·孙强',   phone: '13800001006', campus_id: CAMPUS_ID },
  // i=7-9 teacher (3 老师 双轨)
  { i: 7, role: 'teacher',   name: '老师·周勇',   phone: '13800001007', campus_id: CAMPUS_ID, subject: '数学' },
  { i: 8, role: 'teacher',   name: '老师·吴敏',   phone: '13800001008', campus_id: CAMPUS_ID, subject: '英语' },
  { i: 9, role: 'teacher',   name: '老师·郑磊',   phone: '13800001009', campus_id: CAMPUS_ID, subject: '语文' },
  // i=10-14 全角色覆盖 (5/31 扩展) — V48 role CHECK 白名单已确认全部允许
  { i: 10, role: 'sales_manager',  name: '销售经理·明心', phone: '13800001010', campus_id: CAMPUS_ID },
  { i: 11, role: 'finance',        name: '财务·孟洁',     phone: '13800001011', campus_id: CAMPUS_ID },
  { i: 12, role: 'marketing',      name: '市场·秦风',     phone: '13800001012', campus_id: CAMPUS_ID },
  { i: 13, role: 'hr',             name: 'HR·陆媛',       phone: '13800001013', campus_id: CAMPUS_ID },
  { i: 14, role: 'academic_admin', name: '教务主管·叶舟', phone: '13800001014', campus_id: CAMPUS_ID },
];
USERS.forEach(u => {
  u.id = ulid('user', u.i);
  u.phone_hash = hmacHex(u.phone);
  u.phone_enc = aesGcm(u.phone);
});

const ADMIN_USER_ID = USERS[0].id;
const BOSS_USER_ID = USERS[1].id;
// 销售线归属池：李雷 / 韩梅 / 明心(经理) 三人 — 单校区排名有 3 人可排, 经理团队视图有多销售
const SALES_USER_IDS = USERS.filter(u => u.role === 'sales').map(u => u.id);
const SALES_MANAGER_USER_ID = USERS.find(u => u.role === 'sales_manager').id;
const FINANCE_USER_ID = USERS.find(u => u.role === 'finance').id;
// 注: marketing / hr / academic_admin 是机构域只读角色 (本 schema 无 per-row owner 字段),
//     不需 owned 行 — 价值在登录 + RBAC 走查, 数据由 academic/finance/sales 域共享可见
// 客户/学员/合同的归属轮转池：李雷(0) / 韩梅(1) / 明心(2 经理也带客户, 让 /mine 自洽)
const OWNER_POOL = [...SALES_USER_IDS, SALES_MANAGER_USER_ID];
const ACADEMIC_USER_IDS = USERS.filter(u => u.role === 'academic').map(u => u.id);
const TEACHER_USERS = USERS.filter(u => u.role === 'teacher');

// ====== teachers 双轨表 ======
const TEACHERS = TEACHER_USERS.map((u, i) => ({
  i,
  id: ulid('teacher', i),
  user_id: u.id,
  name: u.name,
  phone: u.phone,
  phone_enc: aesGcm(u.phone),
  campus_id: CAMPUS_ID,
  subject: u.subject,
}));

// ====== course_product ======
const COURSE_PRODUCT = {
  id: ulid('course_product', 0),
  name: '一对一辅导（标准）',
  course_line: '语数英',
  class_type: '1对1',
  lesson_package: 60,
  standard_price: 200,
};

// ====== customers / students / contracts (10 套) ======
// 链路: customer (sales 拓客) → student (sales 签约后 promote) → contract (sales 签约)
// 5/31 扩展: owner 三方轮转 李雷(0)/韩梅(1)/明心 经理(2)
//   i % 3: 明心拿 i=2,5,8 (3 套), 李雷拿 i=0,3,6,9 (4 套), 韩梅拿 i=1,4,7 (3 套)
//   → 经理明心 /mine 有自洽数据 + 单校区排名有 3 销售可排 + 经理团队视图有多下属
const STUDENTS = [];
for (let i = 0; i < 10; i++) {
  const ownerSales = OWNER_POOL[i % OWNER_POOL.length];
  const customer = {
    id: ulid('customer', i),
    parent_name: `家长${i + 1}`,
    primary_mobile: `13800002${String(i + 100).padStart(3, '0')}`,
    owner_id: ownerSales,
  };
  customer.phone_hash = hmacHex(customer.primary_mobile);
  customer.phone_enc = aesGcm(customer.primary_mobile);

  const student = {
    id: ulid('student', i),
    customer_id: customer.id,
    student_name: `学员${i + 1}`,
    intended_subject: ['数学', '英语', '语文'][i % 3],
    owner_sales_id: ownerSales,
    assigned_teacher_id: TEACHERS[i % 3].id,
  };
  STUDENTS.push({ customer, student, ownerSales });
}

// 8 新签 + 2 续费 (i=0,1 续费 / i=2..9 新签) → 续约金额 KPI > 0
//
// 5/31 扩展: paid 标记 (i=0..6 已收款 / i=7,8,9 待收款)
//   - paid 合同 → invoice status='issued' (已开票+已收款) + 必建 student_course_packages (修「生效合同无课时包」)
//   - 未 paid 合同 → invoice status='pending' (待出票) + 不建课时包 (财务页待办态)
//   - 归属覆盖: 明心(i=2,5,8) 有 paid(2,5)+pending(8) / 李雷(0,3,6,9) paid(0,3,6)+pending(9) / 韩梅(1,4,7) paid(1,4)+pending(7)
//     → 三销售均有 active 课时包, /mine 课时账自洽
const LESSON_HOURS = 60;
const GIFT_HOURS = 0;
const UNIT_PRICE = COURSE_PRODUCT.standard_price; // 200
const CONTRACTS = STUDENTS.map((s, i) => ({
  id: ulid('contract', i),
  customer_id: s.customer.id,
  student_id: s.student.id,
  course_product_id: COURSE_PRODUCT.id,
  class_type: COURSE_PRODUCT.class_type,
  lesson_hours: LESSON_HOURS,
  gift_hours: GIFT_HOURS,
  standard_price: UNIT_PRICE,
  total_amount: UNIT_PRICE * LESSON_HOURS,
  // 0,1 续费 / 2..9 新签
  order_type: i < 2 ? '续费' : '新签',
  owner_user_id: s.ownerSales,
  signed_at: daysAgo(20 - i * 2),  // i=0 最近, i=9 20 天前 — 都在本月 30d 内
  // 5/31 修: status 跟随收款 — paid→active(生效中,有课时包) / 未paid→pending(待激活,无课时包)
  //   修「active 合同无课时包」不一致 + 演示「待激活→生效中」双态 (符合 SSOT「收款才激活建包」)
  status: i <= 6 ? 'active' : 'pending',
  campus_id: CAMPUS_ID,
  paid: i <= 6,  // i=0..6 已收款(7 笔) / i=7,8,9 待收款(3 笔)
}));

// ====== student_teacher_bindings (主带 mapping) ======
// 3 teacher 各带 3-4 student
const STB = STUDENTS.map((s, i) => ({
  id: ulid('stb', i),
  student_id: s.student.id,
  teacher_id: TEACHERS[i % 3].id,
  subject: s.student.intended_subject,
  bound_by_user_id: ACADEMIC_USER_IDS[0],
}));

// ====== schedules: 30 节 (过去课部分终态, 今日/未来全起点) ======
//   - 20 节 start_at 在过去 5-15 天 (isPast=true; paid 学员的过去课会消课)
//   - 3 节 start_at 在今天 14/15/16 点 (isPast=false 强制, teacher home todayLessons —
//       绝不消课, 否则下午跑 seed 会把「今日课」翻成已完成 → demo 失真)
//   - 7 节 start_at 在未来 1-7 天 (isPast=false, 排课预览)
//   消课判定基于 isPast 显式标记 (不用 end_at<NOW, 避免「今日课」随 wall-clock 时段被误消)
const SCHEDULES = [];

// 20 节过去 (老师可补完成, 触发消课)
for (let i = 0; i < 20; i++) {
  const teacher = TEACHERS[i % 3];
  const studentIdx = i % 10;
  const student = STUDENTS[studentIdx].student;
  const startAt = daysAgo(15 - Math.floor(i / 2));  // 15-5 天前
  const durMin = 60;
  SCHEDULES.push({
    studentIdx,
    isPast: true,
    id: ulid('schedule', i),
    course_product_id: COURSE_PRODUCT.id,
    teacher_id: teacher.id,
    student_id: student.id,
    start_at: startAt,
    duration_min: durMin,
    end_at: new Date(startAt.getTime() + durMin * 60000),
    status: '已排课',  // 业务起点, 不是终态 (paid 学员的过去课会在下方被翻成 '已完成'+消课)
    attendance_status: '待出勤',
    source: 'one_off',
    created_by_user_id: ACADEMIC_USER_IDS[0],
    created_by_role: 'academic',
    notes: `${teacher.subject} - 待补完成`,
  });
}

// 3 今日 + 7 未来 = 10 节排课预览 (isPast=false → 永不消课, 保持 '已排课' 起点)
for (let i = 0; i < 10; i++) {
  const teacher = TEACHERS[i % 3];
  const studentIdx = i % 10;
  const student = STUDENTS[studentIdx].student;
  let startAt;
  if (i < 3) {
    // 今日 14/15/16 点
    startAt = new Date(NOW);
    startAt.setHours(14 + i, 0, 0, 0);
  } else {
    startAt = daysFromNow(i - 2);  // 1-7 天后
  }
  const durMin = 60;
  SCHEDULES.push({
    studentIdx,
    isPast: false,
    id: ulid('schedule', 20 + i),
    course_product_id: COURSE_PRODUCT.id,
    teacher_id: teacher.id,
    student_id: student.id,
    start_at: startAt,
    duration_min: durMin,
    end_at: new Date(startAt.getTime() + durMin * 60000),
    status: '已排课',
    attendance_status: '待出勤',
    source: 'one_off',
    created_by_user_id: ACADEMIC_USER_IDS[0],
    created_by_role: 'academic',
    notes: i < 3 ? `今日课时 ${i + 1}` : `未来 ${i - 2} 天后`,
  });
}

// ============================================================
// 2026-05-31 重建明心 demo: 补「核心业务终态」让财务/课时账/消课自洽
//   (此 demo 用途 = 重建全数据测试租户, 需 active 合同有课时包, 不是「纯业务起点」演练)
//
//   关键账目不变量 (DB + 生成器双重保证):
//     A. active+paid 合同 必有 student_course_packages (修「生效合同无课时包」)
//     B. student_course_packages.total_lessons = contract.lesson_hours + gift_hours
//     C. remaining_lessons 是 DB GENERATED 列 (total - used - refunded), 生成器不写, DB 自动算
//     D. 每个 confirmed course_consumption ⟺ 1 节 '已完成' schedule + 1 条 lesson_feedback (FK)
//     E. 学员 package.used_lessons = 该学员名下 confirmed consumption 笔数 (精确对平)
// ============================================================

// ---- course_packages: 1 个课包定义 (student_course_packages 的 FK 目标) ----
//   V12 student_course_packages.course_package_id NOT NULL REFERENCES course_packages(id)
//   原 seed 漏了这张表 → 必须建, 否则 active 合同无法挂课时包
const COURSE_PACKAGE = {
  id: ulid('course_package', 0),
  course_product_id: COURSE_PRODUCT.id,
  name: '一对一辅导 60 课时包',
  total_lessons: LESSON_HOURS + GIFT_HOURS,   // 60
  unit_price_yuan: UNIT_PRICE,                 // 200
  total_price_yuan: UNIT_PRICE * LESSON_HOURS, // 12000
  validity_months: 12,
};

// ---- 消课 / 反馈: 把 paid 学员的「过去课」翻成 '已完成' + 反馈 + confirmed 消课 ----
//   每个 paid 学员 (idx 0..6) 的 2 节过去课 (schedule idx k 与 k+10) 全部完成消课
//   → 该学员 package.used_lessons = 2 (与 2 笔 confirmed consumption 对平, 不变量 E)
//   未 paid 学员 (idx 7,8,9) 的过去课保持 '已排课' (无课时包, 不产生 orphan 消课)
const PAID_STUDENT_IDXS = CONTRACTS
  .map((c, i) => (c.paid ? i : -1))
  .filter((i) => i >= 0); // [0,1,2,3,4,5,6]

const FEEDBACKS = [];
const CONSUMPTIONS = [];
let consumeSeq = 0;
for (const sch of SCHEDULES) {
  // 仅「过去课」(isPast 显式标记, 不用 end_at<NOW 避免今日课随时段被误消) 且学员 paid 才消课
  if (!sch.isPast) continue;
  if (!PAID_STUDENT_IDXS.includes(sch.studentIdx)) continue;

  // 翻终态: schedule '已完成' + schedule_students '出勤'
  sch.status = '已完成';
  sch.attendance_status = '出勤';
  sch.notes = `${TEACHERS.find((t) => t.id === sch.teacher_id)?.subject ?? ''} - 已完成消课`;

  const submittedAt = new Date(sch.end_at.getTime() + 2 * 3600000); // 课后 2h 填反馈 (24h 内)
  const fb = {
    id: ulid('feedback', consumeSeq),
    schedule_id: sch.id,
    student_id: sch.student_id,
    teacher_id: sch.teacher_id,
    attendance_status: '出勤',
    classroom_performance: ['优秀', '良好', '合格'][consumeSeq % 3],
    knowledge_points: { points: ['本节重点掌握良好'] },
    homework: '完成课后练习 P12-14',
    teacher_note: '课堂表现积极，继续保持。',
    submitted_at: submittedAt,
  };
  FEEDBACKS.push(fb);

  CONSUMPTIONS.push({
    id: ulid('consumption', consumeSeq),
    schedule_id: sch.id,
    student_id: sch.student_id,
    teacher_id: sch.teacher_id,
    status: 'confirmed',
    amount_yuan: UNIT_PRICE,                                 // 1 节 = 标价 200 元
    feedback_id: fb.id,                                      // FK → lesson_feedbacks (confirmed 必有)
    feedback_due_at: new Date(sch.end_at.getTime() + 24 * 3600000), // V9: end_at + 24h
    confirmed_at: submittedAt,
  });
  consumeSeq += 1;
}

// 每个 paid 学员消课笔数 (= package.used_lessons, 不变量 E 对平)
const usedByStudentId = {};
for (const c of CONSUMPTIONS) {
  usedByStudentId[c.student_id] = (usedByStudentId[c.student_id] || 0) + 1;
}

// ---- student_course_packages: 每个 paid 合同 1 个课时包 (不变量 A/B/E) ----
const STUDENT_PACKAGES = CONTRACTS.filter((c) => c.paid).map((c, i) => {
  const used = usedByStudentId[c.student_id] || 0; // 该学员 confirmed 消课笔数
  return {
    id: ulid('student_package', i),
    student_id: c.student_id,
    course_package_id: COURSE_PACKAGE.id,
    contract_id: c.id,
    total_lessons: c.lesson_hours + c.gift_hours, // 60 (不变量 B)
    used_lessons: used,                            // 与消课笔数对平 (不变量 E); remaining = 60-used DB 自动算 (C)
    refunded_lessons: 0,
    activated_at: c.signed_at,
    expires_at: daysFromNow(365),                  // 有效期 1 年 (V12 expires_at NOT NULL)
    status: 'active',
  };
});

// ---- invoices: 每个合同 1 张 (paid → issued+已收款 / 未 paid → pending 待出票) ----
//   V42 invoices.status 枚举 = pending / issued / cancelled (无 'paid')
//   「已收款」语义 = status='issued' + paid_at + payment_method (V54 mark-paid 落地)
//   contracts.invoice_issued = TRUE (status ∈ pending/issued 时)
const PAYMENT_METHODS = ['微信支付', '对公转账', '现金', '支付宝', '银行卡'];
const INVOICES = CONTRACTS.map((c, i) => {
  const issued = c.paid;
  return {
    id: ulid('invoice', i),
    contract_id: c.id,
    student_id: c.student_id,
    customer_id: STUDENTS[i].customer.id,
    title_type: i % 3 === 0 ? '企业' : '个人',       // 部分企业抬头 (V42 CHECK 个人/企业)
    invoice_title: i % 3 === 0 ? `示范企业${i + 1}有限公司` : `家长${i + 1}`,
    tax_id: i % 3 === 0 ? `91${String(110000000000000 + i)}` : null, // 企业才有税号
    amount: c.total_amount,
    status: issued ? 'issued' : 'pending',
    created_by_user_id: FINANCE_USER_ID,             // 财务建单 (不变量: finance 是 invoice 创建者)
    issued_at: issued ? c.signed_at : null,
    paid_at: issued ? c.signed_at : null,            // 已收款时间
    payment_method: issued ? PAYMENT_METHODS[i % PAYMENT_METHODS.length] : null,
  };
});

// ---- opportunities: 漏斗 + 试听转化 KPI 数据源 (14 条) ----
//   stage 真实枚举 (V2 CHECK, 已对照): 初步接触/需求诊断/已预约试听/已试听待转化/已出方案/谈单中/已报名/已失单
//   funnel 5 桶映射 (dashboard.repository STAGE_MAP, 已对照):
//     consult=初步接触+需求诊断 / contacted=已预约试听 / trial=已试听待转化 / quoted=已出方案+谈单中 / paid=已报名
//   owner 三方分布 李雷/韩梅/明心; 已报名 几条对应已签合同 (复用 student/customer)
//   ⚠️ kpi.service trialRate SQL FILTER stage='已试听' 与 schema '已试听待转化' 不符 (见报告), seed 用 schema 真值
const OPP_PLAN = [
  // [stage, ownerUserIdx(OWNER_POOL 索引), studentIdxOrNull, lostReason, intentLevel]
  { stage: '初步接触',     owner: 0, student: null, lost: null,     intent: '低' },
  { stage: '初步接触',     owner: 2, student: null, lost: null,     intent: '中' },
  { stage: '需求诊断',     owner: 1, student: null, lost: null,     intent: '中' },
  { stage: '已预约试听',   owner: 0, student: null, lost: null,     intent: '中' },
  { stage: '已预约试听',   owner: 2, student: null, lost: null,     intent: '高' },
  { stage: '已试听待转化', owner: 1, student: null, lost: null,     intent: '高' },
  { stage: '已试听待转化', owner: 0, student: null, lost: null,     intent: '中' },
  { stage: '已出方案',     owner: 2, student: null, lost: null,     intent: '高' },
  { stage: '谈单中',       owner: 1, student: null, lost: null,     intent: '高' },
  // 已报名 (= 已签合同): 复用已签学员 i=0(李雷),1(韩梅),2(明心) — opp.signed_at 对齐
  { stage: '已报名',       owner: 0, student: 0,    lost: null,     intent: '高' },
  { stage: '已报名',       owner: 1, student: 1,    lost: null,     intent: '高' },
  { stage: '已报名',       owner: 2, student: 2,    lost: null,     intent: '高' },
  // 已失单 (带 lost_reason, 喂 funnel 流失原因 Top3)
  { stage: '已失单',       owner: 0, student: null, lost: '价格高', intent: '低' },
  { stage: '已失单',       owner: 1, student: null, lost: '竞品成交', intent: '中' },
];
const OPPORTUNITIES = OPP_PLAN.map((p, i) => {
  const ownerUserId = OWNER_POOL[p.owner];
  // 漏斗 opp 需 student_id NOT NULL (V2 schema). student=null 的用 STUDENTS[i] 兜底挂一个真实学员
  const stuIdx = p.student != null ? p.student : i % STUDENTS.length;
  return {
    id: ulid('opportunity', i),
    student_id: STUDENTS[stuIdx].student.id,
    course_product_id: COURSE_PRODUCT.id,
    stage: p.stage,
    intent_level: p.intent,
    owner_user_id: ownerUserId,
    campus_id: CAMPUS_ID,
    source: ['微信广告', '老带新', '门店来访', '微信扫码'][i % 4],
    signed_at: p.stage === '已报名' ? daysAgo(20 - stuIdx * 2) : null, // 已报名对齐合同签约时间
    lost_reason: p.lost,
    last_contact_at: daysAgo(i % 10),
    created_by: ownerUserId,
  };
});

// ====== monthly_kpi_targets (校长下发 3 academic + 3 teacher 月度目标) ======
const TARGETS = [];
const month = thisMonthStr();
[...ACADEMIC_USER_IDS, ...TEACHERS.map(t => t.user_id)].forEach((uid, i) => {
  // 注: academic 用 user_id, teacher 用 teacher.id (但 V56 target_user_id 不区分语义，按 endpoint 调用统一)
  //     实际 endpoint kpi/teacher-home 用 userId 查 (controller line 211) — 教务 endpoint kpi/academic-home 也用 userId
  //     故 target_user_id = user_id 对两个 role 都对齐
  const role = i < 3 ? 'academic' : 'teacher';
  TARGETS.push({
    id: ulid('target', i),
    campus_id: CAMPUS_ID,
    target_role: role,
    target_user_id: role === 'academic' ? uid : USERS.find(u => u.role === 'teacher' && TEACHERS[i - 3].user_id === u.id).id,
    month,
    target_lessons: 80,
    set_by_boss_user_id: BOSS_USER_ID,
    note: '本月目标（5/22 seed 数据）',
  });
});

// 注: FEEDBACKS 已在上方「消课/反馈终态」块声明并填充 (paid 学员已完成课的反馈)

// ============================================================
// 2026-05-23 task #29 验证缺口补 seed:
//   作业 + 测评 + C 端家长是「业务起点」(不是终态行), 类比 schedule '已排课':
//     - homework_assignment + assignment_recipients = 老师布置作业的起点
//     - assessment = 老师创建测评的起点
//     - parents + parent_student_bindings = 家长 c/auth/login 注册的起点
//   后续 submission / 录分 / paywall 由真业务流累积 (不预 seed)
//
// 此 3 类业务起点目前缺前端入口 page (homework new / assessment new / parent register flow),
//   所以 seed 必须建初始数据, 否则前端验证链路被卡 (老师空 assignmentId / C 端无可用 parentId)
// ============================================================

// 3 老师每人 1 作业起点 (3 条 homework_assignment)
//   每作业接收 i%3 老师主带的所有学员 (assignment_recipients fan-out)
const HW_ASSIGNMENTS = TEACHERS.map((t, i) => ({
  id: ulid('hw_assignment', i),
  schedule_id: null,        // 独立作业 (可不关联课次)
  teacher_id: t.id,
  title: `${t.subject} ${['Unit 1 配套练习', 'Unit 2 复习', 'Unit 3 综合'][i]}`,
  content: `请按要求完成本次 ${t.subject} 作业, 周末前上交。`,
  due_at: daysFromNow(7),    // 7 天截止
  difficulty: '中',
  status: 'published',
  // 接收方 = 该老师主带的全部学员
  recipientStudentIds: STUDENTS
    .filter((s) => s.student.assigned_teacher_id === t.id)
    .map((s) => s.student.id),
}));

// 3 老师每人 1 测评起点 (3 条 assessment)
// 2026-05-23 task #33: 加 recipientStudentIds fan-out (V60 assessment_recipients)
//   类比 homework recipients, 默认 = 老师主带学员
const ASSESSMENTS = TEACHERS.map((t, i) => ({
  id: ulid('assessment', i),
  teacher_id: t.id,
  title: `${t.subject} 5 月月考`,
  subject: t.subject,
  assessment_type: '月考',
  total_score: 100,
  scheduled_at: daysAgo(5 - i),  // 5/4/3 天前 — 老师可去录分
  status: 'published',
  // 接收方 = 该老师主带的全部学员 (与 HW_ASSIGNMENTS.recipientStudentIds 同源)
  recipientStudentIds: STUDENTS
    .filter((s) => s.student.assigned_teacher_id === t.id)
    .map((s) => s.student.id),
}));

// 3 家长起点 (parents + parent_student_bindings)
//   按 SSOT C 端家长拍板: 每家长 1 个孩子 (一家长一孩绑定基础)
//   phone 13800003001-003 (避免和 users.phone 13800001000-009 冲突)
const PARENTS = [
  {
    i: 0,
    phone: '13800003001',
    name: '家长·林女士',
    student_id: STUDENTS[0].student.id,
    relationship: 'mother',
  },
  {
    i: 1,
    phone: '13800003002',
    name: '家长·陈先生',
    student_id: STUDENTS[1].student.id,
    relationship: 'father',
  },
  {
    i: 2,
    phone: '13800003003',
    name: '家长·黄女士',
    student_id: STUDENTS[2].student.id,
    relationship: 'mother',
  },
];
PARENTS.forEach((p) => {
  p.id = ulid('parent', p.i);
  p.phone_hash = hmacHex(p.phone);
  p.phone_enc = aesGcm(p.phone);
  p.binding_id = ulid('parent_binding', p.i);
});

// ============================================================
// 生成 SQL
// ============================================================
const sql = [];

sql.push(`-- ============================================================`);
sql.push(`-- seed-traceable-one-tenant.sql  生成于 ${NOW.toISOString()}`);
sql.push(`-- tenant_schema: ${TENANT_SCHEMA}`);
sql.push(`-- tenant_id    : ${TENANT_ID}`);
sql.push(`-- campus_id    : ${CAMPUS_ID}`);
sql.push(`--`);
sql.push(`-- 此 SQL 重置一个 tenant 的全部业务数据为可追溯种子集.`);
sql.push(`-- 每条 INSERT 上方注释标明影响哪个 KPI 字段 (用户拍板 5/22).`);
sql.push(`-- ============================================================`);
sql.push('');
sql.push('BEGIN;');
sql.push(`SET LOCAL search_path = ${TENANT_SCHEMA}, public;`);
sql.push('');

// ====== Step 1: TRUNCATE 业务表 (保留 schema + 系统配置) ======
sql.push(`-- ============================================================`);
sql.push(`-- Step 1: 清当前 tenant 全部业务数据 (CASCADE FK)`);
sql.push(`-- ============================================================`);
sql.push(`TRUNCATE TABLE`);
sql.push(`  ${TENANT_SCHEMA}.lesson_feedbacks,`);
sql.push(`  ${TENANT_SCHEMA}.course_consumptions,`);
sql.push(`  ${TENANT_SCHEMA}.monthly_reports,`);
sql.push(`  ${TENANT_SCHEMA}.parent_referrals,`);
sql.push(`  ${TENANT_SCHEMA}.schedule_students,`);
sql.push(`  ${TENANT_SCHEMA}.schedules,`);
sql.push(`  ${TENANT_SCHEMA}.recurring_schedules,`);
sql.push(`  ${TENANT_SCHEMA}.student_teacher_bindings,`);
sql.push(`  ${TENANT_SCHEMA}.student_course_packages,`);
sql.push(`  ${TENANT_SCHEMA}.course_packages,`);          // 5/31: 课包定义 (student_course_packages 的 FK 父表)
sql.push(`  ${TENANT_SCHEMA}.homework_submissions,`);
sql.push(`  ${TENANT_SCHEMA}.assignment_recipients,`);
sql.push(`  ${TENANT_SCHEMA}.homework_assignments,`);
sql.push(`  ${TENANT_SCHEMA}.student_assessment_results,`);
sql.push(`  ${TENANT_SCHEMA}.assessment_recipients,`);  // V60 task #33
sql.push(`  ${TENANT_SCHEMA}.assessments,`);
sql.push(`  ${TENANT_SCHEMA}.contracts,`);
sql.push(`  ${TENANT_SCHEMA}.invoices,`);
sql.push(`  ${TENANT_SCHEMA}.customer_follow_log,`);       // 5/31: 跟进时间轴 (FK → opportunities)
sql.push(`  ${TENANT_SCHEMA}.opportunities,`);
sql.push(`  ${TENANT_SCHEMA}.students,`);
sql.push(`  ${TENANT_SCHEMA}.customers,`);
sql.push(`  ${TENANT_SCHEMA}.leaves,`);
sql.push(`  ${TENANT_SCHEMA}.teachers,`);
sql.push(`  ${TENANT_SCHEMA}.users,`);
sql.push(`  ${TENANT_SCHEMA}.course_products,`);
sql.push(`  ${TENANT_SCHEMA}.monthly_kpi_targets,`);
sql.push(`  ${TENANT_SCHEMA}.audit_log`);
sql.push(`RESTART IDENTITY CASCADE;`);
sql.push('');
sql.push(`-- 5/23 task #29: 清 public.parents + parent_student_bindings 本 tenant 的家长起点 (跨租户表)`);
sql.push(`-- 注: parents.phone UNIQUE, 历史可能有相同 phone 不同 id 的旧 parent (旧 seed 跑过)`);
sql.push(`--     必须先 DELETE 该 phone 对应 parent 的所有 bindings (跨 tenant), 再 DELETE parent`);
sql.push(`--     之后用 plain INSERT 强制确定性 id (与 binding FK 对齐)`);
sql.push(`-- public.tenants.id 历史大小写不一致 (生产明心是 UPPERCASE), parent_student_bindings.tenant_id FK 用真实存储的 case`);
const phoneList = PARENTS.map((p) => S(p.phone)).join(', ');
// tenant_id 在 public.tenants 大写, 但 ULID seed / tenant_schema 习惯小写 — bindings FK 用 UPPER 对齐 public.tenants.id
const TENANT_ID_FOR_FK = TENANT_ID.toUpperCase();
sql.push(
  `DELETE FROM public.parent_student_bindings`
  + ` WHERE parent_id IN (SELECT id FROM public.parents WHERE phone IN (${phoneList}))`
  + ` OR tenant_id = '${TENANT_ID_FOR_FK}'`
  + ` OR tenant_id = '${TENANT_ID}';`
);
sql.push(
  `DELETE FROM public.parents WHERE id IN (`
  + PARENTS.map((p) => S(p.id)).join(', ') + `)`
  + ` OR phone IN (${phoneList});`
);
sql.push('');
sql.push(`-- (campuses 表保留 + UPSERT 占位行确保 FK 完整)`);
sql.push(
  `INSERT INTO campuses (id, name, status, created_by, updated_by)`
  + `\n VALUES (${S(CAMPUS_ID)}, '示范校区·5月22种子', '启用', ${S(ADMIN_USER_ID)}, ${S(ADMIN_USER_ID)})`
  + `\n ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;`
);
sql.push('');

// ====== Step 2: users (15 个 — 全角色覆盖) ======
sql.push(`-- ============================================================`);
sql.push(`-- Step 2: 15 user 全角色 (admin/boss/sales×2/academic×3/teacher×3`);
sql.push(`--          + sales_manager 明心/finance/marketing/hr/academic_admin)`);
sql.push(`-- 数据源 KPI: admin home org_name / boss campus / sales home sub / 全角色登录走查`);
sql.push(`-- V48 users_role_check 已确认 5 新 role 全在白名单 (sales_manager/finance/marketing/hr/academic_admin)`);
sql.push(`-- ============================================================`);
for (const u of USERS) {
  sql.push(`-- ${u.role} ${u.name} (id=${u.id.slice(0,8)}...)`);
  sql.push(
    `INSERT INTO users (id, name, mobile, role, campus_id, status, password_hash, password_updated_at, created_by, updated_by)`
    + `\n VALUES (${S(u.id)}, ${S(u.name)}, ${S(u.phone)}, ${S(u.role)}, ${u.campus_id ? S(u.campus_id) : 'NULL'}, '启用', ${S(PASSWORD_HASH)}, NOW(), ${S(u.id)}, ${S(u.id)});`
  );
}
sql.push('');

// ====== Step 3: teachers (双轨, 3 老师) ======
sql.push(`-- ============================================================`);
sql.push(`-- Step 3: teachers 双轨 (V44 +) — 每 teacher user 对应 1 teachers row`);
sql.push(`-- 数据源 KPI: teacher home teacher_id resolve / student_teacher_bindings FK`);
sql.push(`-- ============================================================`);
for (const t of TEACHERS) {
  sql.push(`-- 老师 ${t.name} (id=${t.id.slice(0,8)}..., user=${t.user_id.slice(0,8)}...)`);
  sql.push(
    `INSERT INTO teachers (id, campus_id, name, phone, phone_encrypted, user_id, subjects, status, created_by, updated_by)`
    + `\n VALUES (${S(t.id)}, ${S(t.campus_id)}, ${S(t.name)}, ${S(t.phone)}, ${B(t.phone_enc)}, ${S(t.user_id)}, ${J([t.subject])}, '在职', ${S(ADMIN_USER_ID)}, ${S(ADMIN_USER_ID)});`
  );
}
sql.push('');

// ====== Step 4: course_product ======
sql.push(`-- ============================================================`);
sql.push(`-- Step 4: 1 course_product (合同 + 排课的 FK)`);
sql.push(`-- ============================================================`);
sql.push(
  // course_products.status CHECK ('上架','下架') / lesson_package VARCHAR(32) (传字符串)
  `INSERT INTO course_products (id, product_name, course_line, class_type, lesson_package, standard_price, campus_scope, status, created_by, updated_by)`
  + `\n VALUES (${S(COURSE_PRODUCT.id)}, ${S(COURSE_PRODUCT.name)}, ${S(COURSE_PRODUCT.course_line)}, ${S(COURSE_PRODUCT.class_type)}, ${S(String(COURSE_PRODUCT.lesson_package))}, ${N(COURSE_PRODUCT.standard_price)}, 'all_campuses', '上架', ${S(ADMIN_USER_ID)}, ${S(ADMIN_USER_ID)});`
);
sql.push('');

// ====== Step 5: customers (10) + students (10) ======
sql.push(`-- ============================================================`);
sql.push(`-- Step 5: 10 customer + 10 student (sales 拓客 → 签约后 promote)`);
sql.push(`-- 数据源 KPI: admin/boss 学员活跃度 totalStudents=10`);
sql.push(`-- ============================================================`);
for (const s of STUDENTS) {
  sql.push(`-- customer (parent ${s.customer.parent_name}, owner=${s.ownerSales.slice(0,8)}...)`);
  sql.push(
    `INSERT INTO customers (id, parent_name, primary_mobile, primary_mobile_hash, primary_mobile_encrypted, campus_id, owner_id, source_level1, created_by, updated_by)`
    + `\n VALUES (${S(s.customer.id)}, ${S(s.customer.parent_name)}, ${S(s.customer.primary_mobile)}, ${B(s.customer.phone_hash)}, ${B(s.customer.phone_enc)}, ${S(CAMPUS_ID)}, ${S(s.ownerSales)}, '自然到访', ${S(s.ownerSales)}, ${S(s.ownerSales)});`
  );
  sql.push(`-- student (${s.student.student_name}, 主带 teacher=${s.student.assigned_teacher_id.slice(0,8)}...)`);
  sql.push(
    `INSERT INTO students (id, student_name, customer_id, grade_or_age, intended_subject, assigned_teacher_id, owner_sales_id, created_by, updated_by)`
    + `\n VALUES (${S(s.student.id)}, ${S(s.student.student_name)}, ${S(s.student.customer_id)}, '小学三年级', ${S(s.student.intended_subject)}, ${S(s.student.assigned_teacher_id)}, ${S(s.student.owner_sales_id)}, ${S(s.ownerSales)}, ${S(s.ownerSales)});`
  );
}
sql.push('');

// ====== Step 6: contracts (10 = 8 新签 + 2 续费) ======
sql.push(`-- ============================================================`);
sql.push(`-- Step 6: 10 contracts (8 新签 + 2 续费) — 签约 KPI 核心数据源`);
sql.push(`-- 数据源 KPI:`);
sql.push(`--   admin/boss signed.amount   = 8 × ¥12000 = ¥96000`);
sql.push(`--   admin/boss renewal.amount  = 2 × ¥12000 = ¥24000`);
sql.push(`--   李雷  personalSigned        = 4 contracts (i=0,3,6,9, i=0 含 1 续费)`);
sql.push(`--   韩梅  personalSigned        = 3 contracts (i=1,4,7, i=1 含 1 续费)`);
sql.push(`--   明心  personalSigned        = 3 contracts (i=2,5,8) — 经理也有个人业绩`);
sql.push(`--   单校区排名: 李雷/韩梅/明心 3 人按本月签约额降序排 (rankText "第 X / 共 3")`);
sql.push(`--   academic renewalAmount     = ¥24000 (本月)`);
sql.push(`-- ============================================================`);
for (const c of CONTRACTS) {
  sql.push(`-- contract ${c.order_type} (¥${c.total_amount}, signed ${c.signed_at.toISOString().slice(0,10)})`);
  sql.push(
    `INSERT INTO contracts (id, student_id, course_product_id, class_type, lesson_hours, standard_price, discount_amount, gift_hours, total_amount, order_type, paid_locked, owner_user_id, signed_at, status, campus_id, created_by, updated_by)`
    + `\n VALUES (${S(c.id)}, ${S(c.student_id)}, ${S(c.course_product_id)}, ${S(c.class_type)}, ${N(c.lesson_hours)}, ${N(c.standard_price)}, 0, 0, ${N(c.total_amount)}, ${S(c.order_type)}, FALSE, ${S(c.owner_user_id)}, ${T(c.signed_at)}, ${S(c.status)}, ${S(c.campus_id)}, ${S(c.owner_user_id)}, ${S(c.owner_user_id)});`
  );
}
sql.push('');

// ====== Step 7: student_teacher_bindings ======
sql.push(`-- ============================================================`);
sql.push(`-- Step 7: student_teacher_bindings (10 student × 3 teacher 主带)`);
sql.push(`-- 数据源 KPI: teacher.primaryStudents.count`);
sql.push(`--   teacher[0] 主带 4 student (idx 0,3,6,9)`);
sql.push(`--   teacher[1] 主带 3 student (idx 1,4,7)`);
sql.push(`--   teacher[2] 主带 3 student (idx 2,5,8)`);
sql.push(`-- ============================================================`);
for (const b of STB) {
  sql.push(`-- 主带 student=${b.student_id.slice(0,8)} → teacher=${b.teacher_id.slice(0,8)} ${b.subject}`);
  sql.push(
    `INSERT INTO student_teacher_bindings (id, student_id, teacher_id, subject, status, bound_by_user_id)`
    + `\n VALUES (${S(b.id)}, ${S(b.student_id)}, ${S(b.teacher_id)}, ${S(b.subject)}, 'active', ${S(b.bound_by_user_id)});`
  );
}
sql.push('');

// ====== Step 7A: opportunities (漏斗 + 试听转化 KPI 数据源) ======
sql.push(`-- ============================================================`);
sql.push(`-- Step 7A: ${OPPORTUNITIES.length} opportunities (销售漏斗 + 试听转化 + 流失原因)`);
sql.push(`-- 数据源 KPI:`);
sql.push(`--   sales-funnel 5 桶: consult(初步接触+需求诊断) / contacted(已预约试听) /`);
sql.push(`--                      trial(已试听待转化) / quoted(已出方案+谈单中) / paid(已报名)`);
sql.push(`--   流失原因 Top3: stage='已失单' + lost_reason (价格高 / 竞品成交)`);
sql.push(`--   owner 分布 李雷/韩梅/明心 → 各自 owner='me' 漏斗 + 经理团队漏斗`);
sql.push(`-- ⚠️ stage 用 V2 schema 真实枚举 (CHECK 约束); kpi trialRate 的 '已试听' 与本枚举不符 (见报告)`);
sql.push(`-- ============================================================`);
for (const o of OPPORTUNITIES) {
  sql.push(`-- opp stage=${o.stage} owner=${o.owner_user_id.slice(0,8)} student=${o.student_id.slice(0,8)}${o.lost_reason ? ' lost=' + o.lost_reason : ''}`);
  sql.push(
    `INSERT INTO opportunities (id, student_id, course_product_id, stage, intent_level, owner_user_id, campus_id, source, signed_at, lost_reason, last_contact_at, created_by, updated_by)`
    + `\n VALUES (${S(o.id)}, ${S(o.student_id)}, ${S(o.course_product_id)}, ${S(o.stage)}, ${S(o.intent_level)}, ${S(o.owner_user_id)}, ${S(o.campus_id)}, ${S(o.source)}, ${T(o.signed_at)}, ${S(o.lost_reason)}, ${T(o.last_contact_at)}, ${S(o.created_by)}, ${S(o.created_by)});`
  );
}
sql.push('');

// ====== Step 7B: course_packages (1) + student_course_packages (paid 合同) ======
sql.push(`-- ============================================================`);
sql.push(`-- Step 7B: 1 course_package + ${STUDENT_PACKAGES.length} student_course_packages`);
sql.push(`-- 修「生效合同无课时包」: 每个 paid(active) 合同必有 1 课时包`);
sql.push(`-- 账目不变量:`);
sql.push(`--   B: total_lessons = contract.lesson_hours(${LESSON_HOURS}) + gift_hours(${GIFT_HOURS}) = ${LESSON_HOURS + GIFT_HOURS}`);
sql.push(`--   C: remaining_lessons = total - used - refunded (DB GENERATED 列, 不手写)`);
sql.push(`--   E: used_lessons = 该学员名下 confirmed 消课笔数 (精确对平, 各 paid 学员 = 2)`);
sql.push(`-- ============================================================`);
sql.push(`-- course_packages 定义 (V12, student_course_packages.course_package_id FK 目标)`);
sql.push(
  `INSERT INTO course_packages (id, course_product_id, name, total_lessons, unit_price_yuan, total_price_yuan, validity_months, status, created_by, updated_by)`
  + `\n VALUES (${S(COURSE_PACKAGE.id)}, ${S(COURSE_PACKAGE.course_product_id)}, ${S(COURSE_PACKAGE.name)}, ${N(COURSE_PACKAGE.total_lessons)}, ${N(COURSE_PACKAGE.unit_price_yuan)}, ${N(COURSE_PACKAGE.total_price_yuan)}, ${N(COURSE_PACKAGE.validity_months)}, 'active', ${S(ADMIN_USER_ID)}, ${S(ADMIN_USER_ID)});`
);
for (const p of STUDENT_PACKAGES) {
  sql.push(`-- 课时包 student=${p.student_id.slice(0,8)} total=${p.total_lessons} used=${p.used_lessons} remaining=${p.total_lessons - p.used_lessons - p.refunded_lessons}(DB算)`);
  // remaining_lessons 是 GENERATED STORED 列, 不在 INSERT 列清单 (DB 自动 = total - used - refunded)
  sql.push(
    `INSERT INTO student_course_packages (id, student_id, course_package_id, contract_id, total_lessons, used_lessons, refunded_lessons, activated_at, expires_at, status)`
    + `\n VALUES (${S(p.id)}, ${S(p.student_id)}, ${S(p.course_package_id)}, ${S(p.contract_id)}, ${N(p.total_lessons)}, ${N(p.used_lessons)}, ${N(p.refunded_lessons)}, ${T(p.activated_at)}, ${T(p.expires_at)}, ${S(p.status)});`
  );
}
sql.push('');

// ====== Step 7C: invoices (每合同 1 张; paid → issued+已收款 / 未 paid → pending) ======
sql.push(`-- ============================================================`);
sql.push(`-- Step 7C: ${INVOICES.length} invoices (财务作账) + contracts.invoice_issued 回写`);
sql.push(`-- V42 status 枚举 = pending / issued / cancelled (无 'paid')`);
sql.push(`--   ${INVOICES.filter((v) => v.status === 'issued').length} 张 issued (已开票+已收款: paid_at + payment_method)`);
sql.push(`--   ${INVOICES.filter((v) => v.status === 'pending').length} 张 pending (待出票, 财务待办态)`);
sql.push(`-- 不变量: created_by_user_id = 财务(${FINANCE_USER_ID.slice(0,8)}); amount = contract.total_amount snapshot`);
sql.push(`-- ============================================================`);
for (const v of INVOICES) {
  const titleEnc = aesGcm(v.invoice_title);
  const taxEnc = aesGcm(v.tax_id);
  sql.push(`-- invoice ${v.status} contract=${v.contract_id.slice(0,8)} ${v.title_type} ¥${v.amount}${v.payment_method ? ' via ' + v.payment_method : ''}`);
  sql.push(
    `INSERT INTO invoices (id, contract_id, student_id, customer_id, title_type, invoice_title, invoice_title_encrypted, tax_id, tax_id_encrypted, amount, status, created_by_user_id, issued_at, paid_at, payment_method)`
    + `\n VALUES (${S(v.id)}, ${S(v.contract_id)}, ${S(v.student_id)}, ${S(v.customer_id)}, ${S(v.title_type)}, ${S(v.invoice_title)}, ${B(titleEnc)}, ${S(v.tax_id)}, ${B(taxEnc)}, ${N(v.amount)}, ${S(v.status)}, ${S(v.created_by_user_id)}, ${T(v.issued_at)}, ${T(v.paid_at)}, ${S(v.payment_method)});`
  );
}
sql.push('');
sql.push(`-- 回写 contracts.invoice_issued = TRUE (V42 防重复开票标志, status ∈ pending/issued 的合同)`);
const invoicedContractIds = INVOICES.map((v) => S(v.contract_id)).join(', ');
sql.push(
  `UPDATE contracts SET invoice_issued = TRUE WHERE id IN (${invoicedContractIds});`
);
sql.push('');

// ====== Step 8: schedules (30 节) + schedule_students ======
sql.push(`-- ============================================================`);
sql.push(`-- Step 8: 30 schedules — paid 学员过去课 = '已完成'(消课), 其余 '已排课'(起点)`);
sql.push(`--   14 节 '已完成': paid 学员(idx 0..6)各 2 节过去课 → 反馈 + confirmed 消课`);
sql.push(`--    6 节 '已排课': 未 paid 学员(idx 7,8,9)的过去课 (无课时包, 不消课)`);
sql.push(`--    3 节今日 14/15/16 点 '已排课' (teacher home todayLessons)`);
sql.push(`--    7 节未来 1-7 天 '已排课' (排课预览)`);
sql.push(`-- ============================================================`);
for (const s of SCHEDULES) {
  sql.push(`-- schedule ${s.status} teacher=${s.teacher_id.slice(0,8)} ${s.start_at.toISOString().slice(0,16)}`);
  sql.push(
    `INSERT INTO schedules (id, course_product_id, teacher_id, start_at, duration_min, end_at, status, source, created_by_user_id, created_by_role, notes, campus_id)`
    + `\n VALUES (${S(s.id)}, ${S(s.course_product_id)}, ${S(s.teacher_id)}, ${T(s.start_at)}, ${N(s.duration_min)}, ${T(s.end_at)}, ${S(s.status)}, ${S(s.source)}, ${S(s.created_by_user_id)}, ${S(s.created_by_role)}, ${S(s.notes)}, ${S(CAMPUS_ID)});`
  );
  sql.push(
    // 已完成课的学员 '出勤'，其余 '待出勤'（与上方终态翻转一致）
    `INSERT INTO schedule_students (schedule_id, student_id, attendance_status)`
    + `\n VALUES (${S(s.id)}, ${S(s.student_id)}, ${S(s.attendance_status)});`
  );
}
sql.push('');

// ====== Step 9: course_consumptions 在 Step 11 (反馈之后) emit ======
//   course_consumptions.feedback_id FK → lesson_feedbacks(id), confirmed 消课必须先有反馈行
//   故消课 INSERT 放到 Step 11 lesson_feedbacks 之后 (FK 顺序)
sql.push(`-- (Step 9: course_consumptions 见 Step 11 — 须在 lesson_feedbacks 之后 INSERT 满足 feedback_id FK)`);
sql.push('');

// ====== Step 10: monthly_kpi_targets (6 entries) ======
sql.push(`-- ============================================================`);
sql.push(`-- Step 10: monthly_kpi_targets (校长下发 3 academic + 3 teacher 月度目标)`);
sql.push(`-- 数据源 KPI: teacher/academic home kpiSummary.target = 80 节/人/本月`);
sql.push(`-- ============================================================`);
for (const t of TARGETS) {
  sql.push(`-- target ${t.target_role} user=${t.target_user_id.slice(0,8)} month=${t.month} = ${t.target_lessons} 节`);
  sql.push(
    `INSERT INTO monthly_kpi_targets (id, campus_id, target_role, target_user_id, month, target_lessons, set_by_boss_user_id, note)`
    + `\n VALUES (${S(t.id)}, ${S(t.campus_id)}, ${S(t.target_role)}, ${S(t.target_user_id)}, ${S(t.month)}, ${N(t.target_lessons)}, ${S(t.set_by_boss_user_id)}, ${S(t.note)});`
  );
}
sql.push('');

// ====== Step 11: lesson_feedbacks (paid 学员已完成课) + course_consumptions (confirmed) ======
sql.push(`-- ============================================================`);
sql.push(`-- Step 11: ${FEEDBACKS.length} lesson_feedbacks + ${CONSUMPTIONS.length} course_consumptions(confirmed)`);
sql.push(`-- 数据源 KPI:`);
sql.push(`--   admin/boss 本月消课 = ${CONSUMPTIONS.length} 节 (confirmed)`);
sql.push(`--   teacher 已完成课 + 反馈率 (每个 confirmed 消课对应 1 节已完成课 + 1 条反馈)`);
sql.push(`-- 账目不变量 D: 每条 confirmed consumption ⟺ 1 节 '已完成' schedule + 1 条 feedback (FK)`);
sql.push(`-- ============================================================`);
for (const f of FEEDBACKS) {
  sql.push(
    `INSERT INTO lesson_feedbacks (id, schedule_id, student_id, teacher_id, attendance_status, classroom_performance, knowledge_points, homework, teacher_note, submitted_at)`
    + `\n VALUES (${S(f.id)}, ${S(f.schedule_id)}, ${S(f.student_id)}, ${S(f.teacher_id)}, ${S(f.attendance_status)}, ${S(f.classroom_performance)}, ${J(f.knowledge_points)}, ${S(f.homework)}, ${S(f.teacher_note)}, ${T(f.submitted_at)});`
  );
}
sql.push('');
// course_consumptions (confirmed) — feedback_id FK 已在上方 INSERT
for (const c of CONSUMPTIONS) {
  sql.push(`-- 消课 confirmed student=${c.student_id.slice(0,8)} schedule=${c.schedule_id.slice(0,8)} feedback=${c.feedback_id.slice(0,8)}`);
  sql.push(
    `INSERT INTO course_consumptions (id, schedule_id, student_id, teacher_id, status, amount_yuan, feedback_id, feedback_due_at, confirmed_at)`
    + `\n VALUES (${S(c.id)}, ${S(c.schedule_id)}, ${S(c.student_id)}, ${S(c.teacher_id)}, ${S(c.status)}, ${N(c.amount_yuan)}, ${S(c.feedback_id)}, ${T(c.feedback_due_at)}, ${T(c.confirmed_at)});`
  );
}
sql.push('');

// ============================================================
// Step 12 (2026-05-23 task #29): homework + assessment 业务起点
//   类比 Step 8 schedule '已排课' = 排课业务起点
//   作业 = 老师布置作业 起点; 测评 = 老师创建测评 起点
//   submission / 录分 由真业务流累积 (不预 seed)
// ============================================================
sql.push(`-- ============================================================`);
sql.push(`-- Step 12: 3 homework_assignments + 3 assessments (业务起点)`);
sql.push(`-- 数据源:`);
sql.push(`--   homework/list 老师视角: 3 个 assignment 每人 1 条`);
sql.push(`--   homework/grade detail page: recipientStudentIds + submissions[] 可拉真数据`);
sql.push(`--   assessment/list + record page: 测评录分流可走通`);
sql.push(`-- ============================================================`);
for (const hw of HW_ASSIGNMENTS) {
  sql.push(`-- homework_assignment teacher=${hw.teacher_id.slice(0, 8)} title="${hw.title}"`);
  sql.push(
    `INSERT INTO homework_assignments (id, schedule_id, teacher_id, title, content, due_at, difficulty, status)`
    + `\n VALUES (${S(hw.id)}, ${S(hw.schedule_id)}, ${S(hw.teacher_id)}, ${S(hw.title)}, ${S(hw.content)}, ${T(hw.due_at)}, ${S(hw.difficulty)}, ${S(hw.status)});`
  );
  // assignment_recipients fan-out
  for (const sid of hw.recipientStudentIds) {
    sql.push(
      `INSERT INTO assignment_recipients (assignment_id, student_id)`
      + ` VALUES (${S(hw.id)}, ${S(sid)});`
    );
  }
}
sql.push('');

for (const a of ASSESSMENTS) {
  sql.push(`-- assessment teacher=${a.teacher_id.slice(0, 8)} title="${a.title}" recipients=${a.recipientStudentIds.length}`);
  sql.push(
    `INSERT INTO assessments (id, teacher_id, title, subject, assessment_type, total_score, scheduled_at, status)`
    + `\n VALUES (${S(a.id)}, ${S(a.teacher_id)}, ${S(a.title)}, ${S(a.subject)}, ${S(a.assessment_type)}, ${N(a.total_score)}, ${T(a.scheduled_at)}, ${S(a.status)});`
  );
  // 2026-05-23 task #33: V60 assessment_recipients fan-out
  for (const sid of a.recipientStudentIds) {
    sql.push(
      `INSERT INTO assessment_recipients (assessment_id, student_id)`
      + ` VALUES (${S(a.id)}, ${S(sid)});`
    );
  }
}
sql.push('');

// ============================================================
// Step 13 (2026-05-23 task #29): C 端 parents + parent_student_bindings 业务起点
//   类比 Step 5 customers = sales 拓客起点
//   parents = 家长 C 端注册起点 (c/auth/login 输入手机号 → check-phone exists:true → 登录)
//   订阅 / 绑定其他孩子 / 看月报 由真业务流累积
//
//   关键: public schema (跨租户), 不是 tenant_xxx schema
//   触发器 check_max_3_parents 单孩 ≤ 3 家长 (每家长 1 孩绑定不会触发)
// ============================================================
sql.push(`-- ============================================================`);
sql.push(`-- Step 13: 3 parents + 3 parent_student_bindings (C 端家长业务起点)`);
sql.push(`-- 数据源:`);
sql.push(`--   c/auth/login: check-phone(13800003001/2/3) → exists:true → 短信验证登录`);
sql.push(`--   c/home: parent 1-3 各看自己 1 个孩子`);
sql.push(`--   c/mine: GET /c/me/profile 返 name + phone (解密)`);
sql.push(`-- ============================================================`);
sql.push(`-- public.parents UPSERT (跨租户, ON CONFLICT phone DO UPDATE 兼容 backfill)`);
for (const p of PARENTS) {
  sql.push(`-- parent name="${p.name}" phone=${p.phone} 绑学员 ${p.student_id.slice(0,8)}`);
  // 2026-05-23 V47 status 切中文 ('启用'/'停用') 取代 V10 'active'/'suspended'/'deleted'
  //   先前 DELETE 已清旧 id + phone 冲突, 此处用 plain INSERT 强制确定性 id
  //   (避免 ON CONFLICT UPDATE 保留旧 id 导致下面 binding FK 不匹配)
  sql.push(
    `INSERT INTO public.parents (id, phone, phone_hash, phone_encrypted, name, status)`
    + `\n VALUES (${S(p.id)}, ${S(p.phone)}, ${B(p.phone_hash)}, ${B(p.phone_enc)}, ${S(p.name)}, '启用');`
  );
  sql.push(
    // tenant_id 必须匹配 public.tenants.id 真实 case (生产明心是 UPPERCASE)
    `INSERT INTO public.parent_student_bindings (id, parent_id, student_id, tenant_id, is_primary, relationship, binding_status)`
    + `\n VALUES (${S(p.binding_id)}, ${S(p.id)}, ${S(p.student_id)}, ${S(TENANT_ID_FOR_FK)}, TRUE, ${S(p.relationship)}, 'active');`
  );
}
sql.push('');

sql.push(`COMMIT;`);
sql.push('');

// ====== verification queries (注释里, 给用户跑) ======
sql.push(`-- ============================================================`);
sql.push(`-- 验证 query (跑完后手动检查):`);
sql.push(`-- ============================================================`);
sql.push(`-- SELECT role, COUNT(*) FROM ${TENANT_SCHEMA}.users GROUP BY role;  -- 应 15 行(admin1/boss1/sales2/academic3/teacher3/sales_manager1/finance1/marketing1/hr1/academic_admin1)`);
sql.push(`-- SELECT COUNT(*) FROM ${TENANT_SCHEMA}.teachers;  -- 应 3`);
sql.push(`-- SELECT COUNT(*) FROM ${TENANT_SCHEMA}.students;  -- 应 10`);
sql.push(`-- SELECT COUNT(*) FROM ${TENANT_SCHEMA}.contracts;  -- 应 10 (8 新签 + 2 续费, 全 active)`);
sql.push(`-- SELECT order_type, COUNT(*), SUM(total_amount) FROM ${TENANT_SCHEMA}.contracts GROUP BY order_type;  -- 续费 2 ¥24000 / 新签 8 ¥96000`);
sql.push(`-- SELECT owner_user_id, COUNT(*), SUM(total_amount) FROM ${TENANT_SCHEMA}.contracts GROUP BY owner_user_id;  -- 3 销售(李雷4/韩梅3/明心3)`);
sql.push(`-- SELECT status, COUNT(*) FROM ${TENANT_SCHEMA}.schedules GROUP BY status;  -- 已完成 14 / 已排课 16`);
sql.push(`-- SELECT status, COUNT(*) FROM ${TENANT_SCHEMA}.course_consumptions GROUP BY status;  -- confirmed 14`);
sql.push(`-- SELECT COUNT(*) FROM ${TENANT_SCHEMA}.lesson_feedbacks;  -- 应 14 (每 confirmed 消课 1 条)`);
sql.push(`-- 账目对平验证 (核心): used_lessons 必 = 该学员 confirmed 消课笔数, remaining = total - used`);
sql.push(`-- SELECT scp.student_id, scp.total_lessons, scp.used_lessons, scp.remaining_lessons,`);
sql.push(`--        (SELECT COUNT(*) FROM ${TENANT_SCHEMA}.course_consumptions cc`);
sql.push(`--          WHERE cc.student_id = scp.student_id AND cc.status='confirmed') AS confirmed_cnt`);
sql.push(`--   FROM ${TENANT_SCHEMA}.student_course_packages scp;`);
sql.push(`--   -- 期望每行: used_lessons = confirmed_cnt (=2), remaining_lessons = total - used (=58)`);
sql.push(`-- 「生效合同无课时包」修复验证: 应 0 行 (每 active+invoice_issued 合同都有 package)`);
sql.push(`-- SELECT c.id FROM ${TENANT_SCHEMA}.contracts c`);
sql.push(`--   LEFT JOIN ${TENANT_SCHEMA}.student_course_packages scp ON scp.contract_id = c.id`);
sql.push(`--   WHERE c.status='active' AND c.invoice_issued=TRUE AND scp.id IS NULL;  -- 应 0 行`);
sql.push(`-- SELECT status, COUNT(*) FROM ${TENANT_SCHEMA}.invoices GROUP BY status;  -- issued 7 / pending 3`);
sql.push(`-- SELECT stage, COUNT(*) FROM ${TENANT_SCHEMA}.opportunities GROUP BY stage;  -- 8 阶段分布 (含已报名3/已失单2)`);
sql.push(`-- 销售漏斗 owner 自洽 (明心 sales_manager):`);
sql.push(`-- SELECT owner_user_id, COUNT(*) FROM ${TENANT_SCHEMA}.opportunities GROUP BY owner_user_id;`);
sql.push(`-- SELECT target_role, COUNT(*) FROM ${TENANT_SCHEMA}.monthly_kpi_targets GROUP BY target_role;  -- academic 3 + teacher 3 = 6`);
sql.push(`-- SELECT COUNT(*) FROM ${TENANT_SCHEMA}.homework_assignments;  -- 应 3 (3 老师 × 1 作业起点)`);
sql.push(`-- SELECT COUNT(*) FROM ${TENANT_SCHEMA}.assignment_recipients;  -- 应 ~10 (3 老师 fan-out 主带学员)`);
sql.push(`-- SELECT COUNT(*) FROM ${TENANT_SCHEMA}.assessments;  -- 应 3 (3 老师 × 1 测评起点)`);
sql.push(`-- SELECT COUNT(*) FROM public.parents WHERE phone IN ('13800003001','13800003002','13800003003');  -- 应 3`);
sql.push(`-- SELECT COUNT(*) FROM public.parent_student_bindings WHERE tenant_id = '${TENANT_ID}' AND binding_status='active';  -- 应 3`);
sql.push('');

fs.writeFileSync(OUTPUT, sql.join('\n') + '\n');
console.log(`✓ Wrote ${sql.length} lines → ${OUTPUT}`);

// 输出 user credential 给用户登录测试
console.log('');
console.log('=== B 端测试账户 (所有用户密码 Demo@12345) ===');
for (const u of USERS) {
  console.log(`  ${u.role.padEnd(10)} ${u.name.padEnd(14)} 手机=${u.phone}  user_id=${u.id}`);
}
console.log('');
console.log('=== C 端家长账户 (走 c/auth/login 手机号短信验证) ===');
for (const p of PARENTS) {
  const stu = STUDENTS.find((s) => s.student.id === p.student_id);
  console.log(`  parent  ${p.name.padEnd(14)} 手机=${p.phone}  绑学员=${stu ? stu.student.student_name : '?'}  parent_id=${p.id}`);
}
console.log('');
console.log('=== 业务数据 seed (全生命周期闭环) ===');
const completedCnt = SCHEDULES.filter((s) => s.status === '已完成').length;
const scheduledCnt = SCHEDULES.filter((s) => s.status === '已排课').length;
console.log(`  客户/学员/合同: 10 套 (8 新签 + 2 续费; owner 李雷4/韩梅3/明心3)`);
console.log(`  invoices    : ${INVOICES.length} 张 (issued ${INVOICES.filter((v) => v.status === 'issued').length} 已收款 / pending ${INVOICES.filter((v) => v.status === 'pending').length} 待出票)`);
console.log(`  课时包      : 1 course_package + ${STUDENT_PACKAGES.length} student_course_packages (每 paid 合同 1 个; total=${LESSON_HOURS + GIFT_HOURS}/used=2/remaining=58)`);
console.log(`  排课        : ${SCHEDULES.length} 节 (已完成 ${completedCnt} 消课 / 已排课 ${scheduledCnt})`);
console.log(`  消课+反馈   : ${CONSUMPTIONS.length} confirmed consumption + ${FEEDBACKS.length} feedback (1:1 对平)`);
console.log(`  opportunities: ${OPPORTUNITIES.length} 条 (漏斗 8 阶段 + 试听转化 + 流失原因)`);
console.log(`  作业/测评起点: 各 3 条 (老师每人 1, recipients fan-out 主带学员)`);
console.log(`  KPI 目标     : ${TARGETS.length} 条 (校长下发 academic+teacher 月度)`);
console.log(`  submission / 录分 由真业务事件累积 (不预 seed)`);
console.log('');
console.log('=== 账目自洽不变量 (DB + 生成器双保证) ===');
console.log('  A. active+paid 合同 必有 student_course_packages (修「生效合同无课时包」)');
console.log(`  B. package.total_lessons = contract.lesson_hours(${LESSON_HOURS}) + gift_hours(${GIFT_HOURS}) = ${LESSON_HOURS + GIFT_HOURS}`);
console.log('  C. remaining_lessons = total - used - refunded (DB GENERATED 列, 生成器不写)');
console.log('  D. 每条 confirmed 消课 ⟺ 1 节 已完成 schedule + 1 条 lesson_feedback (FK)');
console.log('  E. package.used_lessons = 该学员 confirmed 消课笔数 (各 paid 学员 = 2)');
console.log('');
console.log('=== Tenant 信息 ===');
console.log(`  tenant_schema = ${TENANT_SCHEMA}`);
console.log(`  tenant_id     = ${TENANT_ID}`);
console.log(`  campus_id     = ${CAMPUS_ID}`);
