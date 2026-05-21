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
 * 输入: --tenant-schema=tenant_XXX --tenant-id=XXX --campus-id=XXX --output=path
 * 输出: 一份 SQL 文件 包含
 *   1. TRUNCATE 业务表（保留 schema + campuses + 系统用户）
 *   2. 10 user (1 admin 跨校 + 1 boss 本校 + 2 sales + 3 academic + 3 teacher)
 *   3. 3 teachers (双轨 + linked to teacher users)
 *   4. 1 course_product
 *   5. 10 customer → 10 student → 10 contract (8 新签 + 2 续费)
 *   6. student_teacher_bindings (主带 mapping)
 *   7. ~50 schedules (30 已完成 + 15 已排课 + 5 已取消)
 *   8. 30 course_consumptions (confirmed 状态 + recent confirmed_at)
 *   9. 6 monthly_kpi_targets (校长下发 3 academic + 3 teacher 月度目标)
 *   10. 20 lesson_feedbacks (部分已完成有反馈，部分没填 → pendingFeedback > 0)
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
const USERS = [
  // i=0 admin (跨校)
  { i: 0, role: 'admin',     name: '老板·张总',  phone: '13800001000', campus_id: null },
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
];
USERS.forEach(u => {
  u.id = ulid('user', u.i);
  u.phone_hash = hmacHex(u.phone);
  u.phone_enc = aesGcm(u.phone);
});

const ADMIN_USER_ID = USERS[0].id;
const BOSS_USER_ID = USERS[1].id;
const SALES_USER_IDS = USERS.filter(u => u.role === 'sales').map(u => u.id);
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
// 8 新签 by sales[0,1] 交替 / 2 续费 by sales[0]
const STUDENTS = [];
for (let i = 0; i < 10; i++) {
  const ownerSales = SALES_USER_IDS[i % 2];
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
const CONTRACTS = STUDENTS.map((s, i) => ({
  id: ulid('contract', i),
  customer_id: s.customer.id,
  student_id: s.student.id,
  course_product_id: COURSE_PRODUCT.id,
  class_type: COURSE_PRODUCT.class_type,
  lesson_hours: 60,
  standard_price: COURSE_PRODUCT.standard_price,
  total_amount: 200 * 60,
  // 0,1 续费 / 2..9 新签
  order_type: i < 2 ? '续费' : '新签',
  owner_user_id: s.ownerSales,
  signed_at: daysAgo(20 - i * 2),  // i=0 最近, i=9 20 天前 — 都在本月 30d 内
  status: 'active',
  campus_id: CAMPUS_ID,
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

// ====== schedules: 50 节 = 30 已完成(过去) + 15 已排课(未来本月) + 5 已取消 ======
const SCHEDULES = [];

// 30 已完成 schedule (本月内, 过去 1-20 天) → 已消课 / lessons KPI
for (let i = 0; i < 30; i++) {
  const teacher = TEACHERS[i % 3];
  const student = STUDENTS[i % 10].student;
  const startAt = daysAgo(20 - Math.floor(i / 2));  // 20-5 天前
  const durMin = 60;
  SCHEDULES.push({
    id: ulid('schedule', i),
    course_product_id: COURSE_PRODUCT.id,
    teacher_id: teacher.id,
    student_id: student.id,
    start_at: startAt,
    duration_min: durMin,
    end_at: new Date(startAt.getTime() + durMin * 60000),
    status: '已完成',
    source: 'one_off',
    created_by_user_id: ACADEMIC_USER_IDS[0],
    created_by_role: 'academic',
    notes: `${teacher.subject} - 第 ${Math.floor(i / 10) + 1} 节`,
    completed: true,  // 内部 flag 给 course_consumption 用
  });
}

// 15 已排课 (未来 1-15 天内, 仍本月) → 已排课/forecast KPI
for (let i = 0; i < 15; i++) {
  const teacher = TEACHERS[i % 3];
  const student = STUDENTS[i % 10].student;
  // 部分今日: 前 3 节是今天
  let startAt;
  if (i < 3) {
    startAt = new Date(NOW);
    startAt.setHours(14 + i, 0, 0, 0);  // 14:00 / 15:00 / 16:00 today
  } else {
    startAt = daysFromNow(i - 2);  // 1-13 天后
  }
  const durMin = 60;
  SCHEDULES.push({
    id: ulid('schedule', 30 + i),
    course_product_id: COURSE_PRODUCT.id,
    teacher_id: teacher.id,
    student_id: student.id,
    start_at: startAt,
    duration_min: durMin,
    end_at: new Date(startAt.getTime() + durMin * 60000),
    status: '已排课',
    source: 'one_off',
    created_by_user_id: ACADEMIC_USER_IDS[0],
    created_by_role: 'academic',
    notes: i < 3 ? `今日课时 ${i + 1}` : `未来 ${i - 2} 天后`,
    completed: false,
  });
}

// 5 已取消 → 不影响 KPI
for (let i = 0; i < 5; i++) {
  const teacher = TEACHERS[i % 3];
  const student = STUDENTS[i % 10].student;
  const startAt = daysAgo(15 - i);
  const durMin = 60;
  SCHEDULES.push({
    id: ulid('schedule', 45 + i),
    course_product_id: COURSE_PRODUCT.id,
    teacher_id: teacher.id,
    student_id: student.id,
    start_at: startAt,
    duration_min: durMin,
    end_at: new Date(startAt.getTime() + durMin * 60000),
    status: '已取消',
    source: 'one_off',
    created_by_user_id: ACADEMIC_USER_IDS[0],
    created_by_role: 'academic',
    notes: '学员临时请假',
    completed: false,
  });
}

// ====== course_consumptions (仅 30 已完成 schedule 有) ======
const CONSUMPTIONS = SCHEDULES.filter(s => s.completed).map((s, i) => ({
  id: ulid('consumption', i),
  schedule_id: s.id,
  student_id: s.student_id,
  teacher_id: s.teacher_id,
  status: 'confirmed',
  amount_yuan: s.duration_min / 60 * COURSE_PRODUCT.standard_price,
  feedback_due_at: new Date(s.end_at.getTime() + 24 * 3600 * 1000),
  confirmed_at: new Date(s.end_at.getTime() + 60 * 60 * 1000),  // 1 小时后老师 confirm
}));

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

// ====== lesson_feedbacks (20 已完成 schedule 有反馈, 10 没填 → pendingFeedback) ======
const FEEDBACKS = [];
SCHEDULES.filter(s => s.completed).slice(0, 20).forEach((s, i) => {
  FEEDBACKS.push({
    id: ulid('feedback', i),
    schedule_id: s.id,
    student_id: s.student_id,
    teacher_id: s.teacher_id,
    attendance_status: '出勤',
    classroom_performance: '专注度高',
    knowledge_points: { topics: ['基础'] },
    homework: '完成 P10-15',
    teacher_note: `${s.notes} 课后小结`,
    submitted_at: s.confirmed_at || s.end_at,
  });
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
sql.push(`  ${TENANT_SCHEMA}.contracts,`);
sql.push(`  ${TENANT_SCHEMA}.invoices,`);
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
sql.push(`-- (campuses 表保留 — 复用现有 campus_id=${CAMPUS_ID.slice(0,8)}...)`);
sql.push('');

// ====== Step 2: users (10 个) ======
sql.push(`-- ============================================================`);
sql.push(`-- Step 2: 10 user (admin/boss/sales×2/academic×3/teacher×3)`);
sql.push(`-- 数据源 KPI: admin home org_name / boss campus / sales home sub`);
sql.push(`-- ============================================================`);
for (const u of USERS) {
  sql.push(`-- ${u.role} ${u.name} (id=${u.id.slice(0,8)}...)`);
  sql.push(
    `INSERT INTO users (id, name, mobile, role, campus_id, status, password_hash, password_updated_at, created_by, updated_by)`
    + `\n VALUES (${S(u.id)}, ${S(u.name)}, ${S(u.phone)}, ${S(u.role)}, ${u.campus_id ? S(u.campus_id) : 'NULL'}, 'active', ${S(PASSWORD_HASH)}, NOW(), ${S(u.id)}, ${S(u.id)});`
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
    + `\n VALUES (${S(t.id)}, ${S(t.campus_id)}, ${S(t.name)}, ${S(t.phone)}, ${B(t.phone_enc)}, ${S(t.user_id)}, ${J([t.subject])}, 'active', ${S(ADMIN_USER_ID)}, ${S(ADMIN_USER_ID)});`
  );
}
sql.push('');

// ====== Step 4: course_product ======
sql.push(`-- ============================================================`);
sql.push(`-- Step 4: 1 course_product (合同 + 排课的 FK)`);
sql.push(`-- ============================================================`);
sql.push(
  `INSERT INTO course_products (id, product_name, course_line, class_type, lesson_package, standard_price, campus_scope, status, created_by, updated_by)`
  + `\n VALUES (${S(COURSE_PRODUCT.id)}, ${S(COURSE_PRODUCT.name)}, ${S(COURSE_PRODUCT.course_line)}, ${S(COURSE_PRODUCT.class_type)}, ${N(COURSE_PRODUCT.lesson_package)}, ${N(COURSE_PRODUCT.standard_price)}, 'all_campuses', 'active', ${S(ADMIN_USER_ID)}, ${S(ADMIN_USER_ID)});`
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
sql.push(`--   sales[0] personalSigned    = 5 contracts (i=0,2,4,6,8 含 1 续费)`);
sql.push(`--   sales[1] personalSigned    = 5 contracts (i=1,3,5,7,9 含 1 续费)`);
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

// ====== Step 8: schedules (50) + schedule_students ======
sql.push(`-- ============================================================`);
sql.push(`-- Step 8: 50 schedules = 30 已完成 + 15 已排课 + 5 已取消`);
sql.push(`-- 数据源 KPI:`);
sql.push(`--   admin/boss consumption.hours/lessons = 30 节 (course_consumptions confirmed)`);
sql.push(`--   teacher kpiSummary.attended = 10 节 / teacher (本月 status='已完成' / 3 老师)`);
sql.push(`--   teacher kpiSummary.scheduled = ~15 节 (本月所有非取消)`);
sql.push(`--   teacher kpiSummary.forecast = scheduled - attended - absent (~5)`);
sql.push(`--   teacher todayLessons = 1 节 (今日 14/15/16 点 each teacher 1 节)`);
sql.push(`--   academic kpiSummary.attended = 30 节 (本校汇总)`);
sql.push(`-- ============================================================`);
for (const s of SCHEDULES) {
  sql.push(`-- schedule ${s.status} teacher=${s.teacher_id.slice(0,8)} ${s.start_at.toISOString().slice(0,16)}`);
  sql.push(
    `INSERT INTO schedules (id, course_product_id, teacher_id, start_at, duration_min, end_at, status, source, created_by_user_id, created_by_role, notes)`
    + `\n VALUES (${S(s.id)}, ${S(s.course_product_id)}, ${S(s.teacher_id)}, ${T(s.start_at)}, ${N(s.duration_min)}, ${T(s.end_at)}, ${S(s.status)}, ${S(s.source)}, ${S(s.created_by_user_id)}, ${S(s.created_by_role)}, ${S(s.notes)});`
  );
  sql.push(
    `INSERT INTO schedule_students (schedule_id, student_id, attendance_status)`
    + `\n VALUES (${S(s.id)}, ${S(s.student_id)}, ${S(s.status === '已完成' ? '出勤' : s.status === '已取消' ? '请假' : '待出勤')});`
  );
}
sql.push('');

// ====== Step 9: course_consumptions (30 confirmed) ======
sql.push(`-- ============================================================`);
sql.push(`-- Step 9: 30 course_consumptions (confirmed 状态 + 本月内 confirmed_at)`);
sql.push(`-- 数据源 KPI:`);
sql.push(`--   admin/boss consumption.total.hours = 30 节 (60 min × 30 / 60 = 30 hours)`);
sql.push(`--   admin/boss consumption.total.lessons = 30`);
sql.push(`--   admin/boss studentActivity.active = 10 (10 student 都有过消课)`);
sql.push(`-- ============================================================`);
for (const cc of CONSUMPTIONS) {
  sql.push(
    `INSERT INTO course_consumptions (id, schedule_id, student_id, teacher_id, status, amount_yuan, feedback_due_at, confirmed_at)`
    + `\n VALUES (${S(cc.id)}, ${S(cc.schedule_id)}, ${S(cc.student_id)}, ${S(cc.teacher_id)}, 'confirmed', ${N(cc.amount_yuan)}, ${T(cc.feedback_due_at)}, ${T(cc.confirmed_at)});`
  );
}
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

// ====== Step 11: lesson_feedbacks (20 / 30 已完成有反馈, 10 无 → pendingFeedback) ======
sql.push(`-- ============================================================`);
sql.push(`-- Step 11: 20 lesson_feedbacks (30 已完成中 20 填了 / 10 无 → pendingFeedback=10)`);
sql.push(`-- 数据源 KPI:`);
sql.push(`--   teacher primaryStudents.pendingFeedback = 10/3 ≈ 3-4 per teacher`);
sql.push(`--   teacher todos.feedback_overdue 不会出现 (24h 已过 但已填)`);
sql.push(`-- ============================================================`);
for (const f of FEEDBACKS) {
  sql.push(
    `INSERT INTO lesson_feedbacks (id, schedule_id, student_id, teacher_id, attendance_status, classroom_performance, knowledge_points, homework, teacher_note, submitted_at)`
    + `\n VALUES (${S(f.id)}, ${S(f.schedule_id)}, ${S(f.student_id)}, ${S(f.teacher_id)}, ${S(f.attendance_status)}, ${S(f.classroom_performance)}, ${J(f.knowledge_points)}, ${S(f.homework)}, ${S(f.teacher_note)}, ${T(f.submitted_at)});`
  );
}
sql.push('');

sql.push(`COMMIT;`);
sql.push('');

// ====== verification queries (注释里, 给用户跑) ======
sql.push(`-- ============================================================`);
sql.push(`-- 验证 query (跑完后手动检查):`);
sql.push(`-- ============================================================`);
sql.push(`-- SELECT COUNT(*) FROM ${TENANT_SCHEMA}.users;  -- 应 10`);
sql.push(`-- SELECT COUNT(*) FROM ${TENANT_SCHEMA}.teachers;  -- 应 3`);
sql.push(`-- SELECT COUNT(*) FROM ${TENANT_SCHEMA}.students;  -- 应 10`);
sql.push(`-- SELECT COUNT(*) FROM ${TENANT_SCHEMA}.contracts;  -- 应 10 (8 新签 + 2 续费)`);
sql.push(`-- SELECT order_type, COUNT(*), SUM(total_amount) FROM ${TENANT_SCHEMA}.contracts GROUP BY order_type;`);
sql.push(`-- SELECT status, COUNT(*) FROM ${TENANT_SCHEMA}.schedules GROUP BY status;  -- 已完成 30 / 已排课 15 / 已取消 5`);
sql.push(`-- SELECT COUNT(*) FROM ${TENANT_SCHEMA}.course_consumptions WHERE status='confirmed';  -- 应 30`);
sql.push(`-- SELECT target_role, target_user_id, month, target_lessons FROM ${TENANT_SCHEMA}.monthly_kpi_targets ORDER BY target_role, target_user_id;  -- 应 6 行`);
sql.push(`-- SELECT COUNT(*) FROM ${TENANT_SCHEMA}.lesson_feedbacks;  -- 应 20`);
sql.push('');

fs.writeFileSync(OUTPUT, sql.join('\n') + '\n');
console.log(`✓ Wrote ${sql.length} lines → ${OUTPUT}`);

// 输出 user credential 给用户登录测试
console.log('');
console.log('=== 测试登录账户 (所有用户密码 Demo@12345) ===');
for (const u of USERS) {
  console.log(`  ${u.role.padEnd(10)} ${u.name.padEnd(14)} 手机=${u.phone}  user_id=${u.id}`);
}
console.log('');
console.log('=== Tenant 信息 ===');
console.log(`  tenant_schema = ${TENANT_SCHEMA}`);
console.log(`  tenant_id     = ${TENANT_ID}`);
console.log(`  campus_id     = ${CAMPUS_ID}`);
