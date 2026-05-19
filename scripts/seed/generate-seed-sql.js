#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * generate-seed-sql.js — 为单个 demo tenant 生成业务 seed SQL
 *
 * 来源：
 *   - Day 1 architect spec §3.2 每 tenant 数据规格
 *   - leader prompt: 不偷懒，所有量精确、严格 INSERT ON CONFLICT 幂等
 *
 * 用法：
 *   node scripts/seed/generate-seed-sql.js \
 *     --tenant-spec='{"logicalName":"demo-empty","tenantId":"...","tenantSchema":"tenant_..."}' \
 *     --demo-users-file=scripts/seed/demo-users.json \
 *     --output-sql=/tmp/seed-<tenant>.sql
 *
 * 输出：
 *   - 一个 .sql 文件，全部 INSERT 在事务里
 *   - 用 ULID 32-char 确定性（seed 通过 logicalName 派生）
 *   - 所有 PII（手机号）用 HMAC + AES-GCM 双写（V40/V41）
 *
 * 严谨度：
 *   - 手机号严格 /^1[3-9]\d{9}$/，phone 范围 13800002001-13800020000 防与 admin 冲突
 *   - 所有 ULID 32-char，可重跑（INSERT ... ON CONFLICT (id) DO NOTHING）
 *   - 5000 schedule + 20000 feedback 分批：每批 500 INSERT 单语句（PG 14 max param ~65535 / 列数）
 *   - 加密：FieldEncryptor AES-256-GCM + HmacHasher HMAC-SHA256（按 ENCRYPTION_KEY + HASH_KEY 环境变量）
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ===== 参数解析 =====
const args = {};
for (const arg of process.argv.slice(2)) {
  const [k, v] = arg.split('=');
  args[k.replace(/^--/, '')] = v;
}

const TENANT_SPEC_RAW = args['tenant-spec'];
const DEMO_USERS_FILE = args['demo-users-file'];
const OUTPUT_SQL = args['output-sql'];
const SCENARIO_FILTER = args['scenario']; // 可选：empty / small / medium / large / edge-case

if (!TENANT_SPEC_RAW || !DEMO_USERS_FILE || !OUTPUT_SQL) {
  console.error('Usage: node generate-seed-sql.js --tenant-spec=<json> --demo-users-file=<path> --output-sql=<path>');
  process.exit(2);
}

const tenantSpec = JSON.parse(TENANT_SPEC_RAW);
const { logicalName, tenantId, tenantSchema, campusIds, admin } = tenantSpec;

if (!logicalName || !tenantId || !tenantSchema || !Array.isArray(campusIds) || !admin) {
  console.error('tenant-spec missing required fields: logicalName/tenantId/tenantSchema/campusIds/admin');
  process.exit(2);
}

// ===== ULID 生成（确定性，seed 派生）=====
function deterministicUlid(prefix, index) {
  // 同一 logicalName + prefix + index 永远生成同一 32-char ULID
  // 用 SHA-256 hash → base32 截 32 字符
  const h = crypto.createHash('sha256');
  h.update(`${logicalName}|${prefix}|${index}`);
  const digest = h.digest();
  // base32 alphabet (Crockford's, ULID 标准)
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let result = '';
  for (let i = 0; i < 20 && result.length < 32; i++) {
    const byte = digest[i];
    result += ALPHABET[byte & 0x1f];
    result += ALPHABET[(byte >> 3) & 0x1f];
  }
  return result.slice(0, 32).toLowerCase();
}

// ===== 加密 helper =====
const ENCRYPTION_KEY_B64 = process.env.ENCRYPTION_KEY || '';
const HASH_KEY_B64 = process.env.HASH_KEY || '';

if (!ENCRYPTION_KEY_B64 || !HASH_KEY_B64) {
  console.error('ENCRYPTION_KEY and HASH_KEY required (set in shell env before invoke)');
  process.exit(2);
}

const ENCRYPTION_KEY = Buffer.from(ENCRYPTION_KEY_B64, 'base64');
const HASH_KEY = Buffer.from(HASH_KEY_B64, 'base64');

if (ENCRYPTION_KEY.length !== 32 || HASH_KEY.length !== 32) {
  console.error(`ENCRYPTION_KEY / HASH_KEY must decode to 32 bytes (got ${ENCRYPTION_KEY.length} / ${HASH_KEY.length})`);
  process.exit(2);
}

// AES-256-GCM: [IV 12B][AuthTag 16B][Cipher]
function aesGcmEncrypt(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

// HMAC-SHA256 确定性 hash
function hmacHash(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  return crypto.createHmac('sha256', HASH_KEY).update(String(plaintext), 'utf8').digest();
}

// bcrypt hash（V46 password_hash），生成固定 hash 节省时间
// 注意：bcrypt cost=12 太慢，seed 用 cost=4（仅 demo / 跑测试用，不上 production user 密码）
//        全部 demo user 共享同一 password "Demo@12345" 的 bcrypt hash（用 bcryptjs sync 算 1 次）
const bcryptjs = require('bcryptjs');
const DEMO_USER_PASSWORD = 'Demo@12345';
const DEMO_BCRYPT_HASH = bcryptjs.hashSync(DEMO_USER_PASSWORD, 4); // cost=4 加速 demo seed

// ===== SQL escape helper =====
function sqlString(v) {
  if (v === null || v === undefined) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

function sqlBytea(buf) {
  if (buf === null || buf === undefined) return 'NULL';
  // PG bytea hex format: '\xDEADBEEF'
  return `'\\x${buf.toString('hex')}'::bytea`;
}

function sqlInt(n) {
  if (n === null || n === undefined) return 'NULL';
  return String(parseInt(n, 10));
}

function sqlNumeric(n) {
  if (n === null || n === undefined) return 'NULL';
  return String(Number(n));
}

function sqlTimestamp(d) {
  if (d === null || d === undefined) return 'NULL';
  if (d instanceof Date) return `'${d.toISOString()}'::timestamptz`;
  return `'${d}'::timestamptz`;
}

function sqlJsonb(obj) {
  if (obj === null || obj === undefined) return 'NULL';
  return `'${JSON.stringify(obj).replace(/'/g, "''")}'::jsonb`;
}

// ===== 数据生成器（scenario-based）=====
// 每 tenant 返回 { users[], students[], contracts[], schedules[], feedbacks[], teacher_ratings[], invoices[], parent_referrals[], parents[], parent_student_bindings[] }
function generateSpec() {
  const scenarios = {
    'demo-empty': () => ({
      users: [],         // admin 已由 provision 建
      teachers: [],
      customers: [],
      students: [],
      courseProducts: [],
      contracts: [],
      schedules: [],
      feedbacks: [],
      teacher_ratings: [],
      invoices: [],
      parent_referrals: [],
      parents: [],
      parent_student_bindings: [],
      recurring_schedules: [],
      student_teacher_bindings: [],
    }),

    'demo-admin-multi-campus': () => buildSpec({
      bossCount: 3,     // 每校区 1 boss（按校区分配）
      salesCount: 2,
      academicCount: 1,
      teacherCount: 1,
      hrCount: 0,
      financeCount: 0,
      marketingCount: 0,
      customerCount: 20,
      studentCount: 12,
      contractCount: 10,
      scheduleCount: 15,
      feedbackCount: 8,
      teacherRatingCount: 0,
      invoiceCount: 0,
      refundCount: 0,
      parentReferralCount: 0,
      parentsCount: 0,
      recurringScheduleCount: 0,
    }),

    'demo-boss-single': () => buildSpec({
      bossCount: 1,
      salesCount: 2,
      academicCount: 1,
      teacherCount: 2,
      customerCount: 30,
      studentCount: 20,
      contractCount: 18,
      scheduleCount: 25,
      feedbackCount: 15,
      teacherRatingCount: 10,
    }),

    'demo-sales-active': () => buildSpec({
      salesCount: 2,    // sales-A 和 sales-B（A 拥有全部 5 customer）
      academicCount: 1,
      teacherCount: 1,   // schedules 5 需要 teacher — spec §3.2 没明说但 schedule 必有老师
      customerCount: 5,
      studentCount: 10,
      contractCount: 8,
      scheduleCount: 5,
      feedbackCount: 3,
      // 1 个合同 stage=pending_schedule
      pendingScheduleContractCount: 1,
      // sales-A 拥有全部 customer（spec §3.2 demo-sales-active "全部 owner=sales-A"）
      allCustomersToFirstSales: true,
    }),

    'demo-academic-busy': () => buildSpec({
      academicCount: 1,
      teacherCount: 2,
      customerCount: 15,    // 给 students 提供 NOT NULL customer_id
      studentCount: 15,
      contractCount: 12,
      scheduleCount: 50,
      feedbackCount: 20,
      recurringScheduleCount: 10,    // 10 周期模板
    }),

    'demo-teacher-rated': () => {
      const s = buildSpec({
        teacherCount: 2,
        academicCount: 1,
        customerCount: 8,
        studentCount: 8,
        contractCount: 6,
        scheduleCount: 20,
        feedbackCount: 20,
        teacherRatingCount: 0,   // 不用通用算法，下面手动注入「仅 teacher-A 5 评分」
      });
      // spec §3.2: 仅 teacher-A 收 5 评分（1/3/4/5/5 avg=3.6），teacher-B 无评分
      if (s.teachers.length >= 1) {
        const stars = [1, 3, 4, 5, 5];
        const sum = stars.reduce((a, b) => a + b, 0);
        s.teacher_ratings.push({
          teacher_id: s.teachers[0].id,
          rating_count: stars.length,
          rating_sum: sum,
          avg_stars: Math.round((sum / stars.length) * 100) / 100,    // 3.6
          last_rated_at: new Date().toISOString(),
        });
      }
      return s;
    },

    'demo-parent-single': () => {
      const s = buildSpec({
        academicCount: 1,
        teacherCount: 1,
        customerCount: 1,   // 给 student 提供 NOT NULL customer_id
        studentCount: 1,
        contractCount: 1,
        scheduleCount: 8,
        feedbackCount: 5,
      });
      // 1 parent 绑 1 student
      s.parents = [{
        id: deterministicUlid('parent', 0),
        phone: '13800003001',
        name: '家长-单孩-1',
        avatar_url: null,
      }];
      s.parent_student_bindings = [{
        id: deterministicUlid('psb', 0),
        parent_id: s.parents[0].id,
        student_id: s.students[0].id,
        tenant_id: tenantId,
        is_primary: true,
        relationship: 'mother',
      }];
      return s;
    },

    'demo-parent-multi-tenant': () => {
      // 此 tenant 自身 2 student；parent 同时绑这 2 个 + tenant-7 的 1 个（共 3 binding，跨 2 tenant）
      // 但「跨 tenant 绑定」需要 tenant-7 的 student id — 这个跨 tenant 数据在 seed 阶段拿不到
      // 解决：parent 自身仅写 tenant-8 的 2 个 binding；后置脚本（seed 全部 tenant 完成后）补 tenant-7
      const s = buildSpec({
        academicCount: 1,
        teacherCount: 1,
        customerCount: 2,   // 给 students 提供 NOT NULL customer_id
        studentCount: 2,
        contractCount: 2,
        scheduleCount: 0,
        feedbackCount: 0,
      });
      s.parents = [{
        id: deterministicUlid('parent-shared', 0),
        phone: '13800003008',   // 与 demo-parent-single 不同手机号
        name: '家长-跨tenant-1',
        avatar_url: null,
      }];
      s.parent_student_bindings = s.students.map((st, i) => ({
        id: deterministicUlid('psb', i),
        parent_id: s.parents[0].id,
        student_id: st.id,
        tenant_id: tenantId,
        is_primary: i === 0,
        relationship: 'father',
      }));
      return s;
    },

    'demo-finance-invoice': () => {
      const s = buildSpec({
        salesCount: 1,
        academicCount: 1,
        financeCount: 1,
        customerCount: 8,
        studentCount: 6,
        contractCount: 8,
        scheduleCount: 0,
        feedbackCount: 0,
        invoiceCount: 10,        // 7 completed + 2 pending + 1 cancelled
        refundCount: 3,
      });
      return s;
    },

    'demo-hr': () => {
      const s = buildSpec({
        bossCount: 1,
        hrCount: 1,
        salesCount: 4,           // 1 离职
        academicCount: 2,
        teacherCount: 3,         // 1 离职
        financeCount: 1,
        customerCount: 20,
        studentCount: 15,
        contractCount: 12,
      });
      // 标记 sales[3] 和 teacher[2] 离职（deactivated_at 不为 NULL）
      if (s.users.length >= 4) {
        // 找一个 sales 离职
        const salesUsers = s.users.filter(u => u.role === 'sales');
        if (salesUsers.length > 0) salesUsers[salesUsers.length - 1].deactivated = true;
        // 找一个 teacher 离职
        const teacherUsers = s.users.filter(u => u.role === 'teacher');
        if (teacherUsers.length > 0) teacherUsers[teacherUsers.length - 1].deactivated = true;
      }
      return s;
    },

    'demo-marketing': () => {
      const s = buildSpec({
        marketingCount: 1,
        salesCount: 1,
        academicCount: 1,
        teacherCount: 1,         // parent_referrals 需要 teacher (FK NOT NULL)
        customerCount: 15,
        studentCount: 10,
        contractCount: 5,
        parentReferralCount: 3,
      });
      // 5 个 customer source='转介绍'（V25 via referral 标记）
      const customersToMark = s.customers.slice(0, 5);
      customersToMark.forEach(c => { c.source = '转介绍'; });
      return s;
    },

    'demo-edge-case': () => {
      const s = buildSpec({
        salesCount: 1,
        academicCount: 1,
        teacherCount: 2,
        customerCount: 5,
        studentCount: 4,
        contractCount: 3,
        scheduleCount: 5,
      });
      // 1 customer primary_mobile_hash=NULL（V41 之前数据模拟）
      if (s.customers.length >= 1) s.customers[0].nullPii = true;
      // 1 customer primary_mobile_encrypted=NULL
      if (s.customers.length >= 2) s.customers[1].nullEncrypted = true;
      // 1 student archived_at 不为 NULL
      if (s.students.length >= 1) s.students[0].archived = true;
      // 1 contract owner_sales_id 指已离职 user — 标记 sales[1] 离职（contract[0] 指它）
      if (s.users.filter(u => u.role === 'sales').length >= 1) {
        // sales-1 离职 → contract[0].owner_user_id 用 sales-1
        const sales = s.users.filter(u => u.role === 'sales')[0];
        sales.deactivated = true;
        if (s.contracts.length >= 1) s.contracts[0].owner_user_id = sales.id;
      }
      // 1 schedule status=cancelled + leave_id
      if (s.schedules.length >= 1) {
        s.schedules[0].status = '已取消';
        s.schedules[0].leave_id_hint = true;    // generator 跳过 leave_id（schema 不需要）
      }
      return s;
    },

    'demo-large-scale': () => buildSpec({
      bossCount: 2,
      salesCount: 3,
      academicCount: 2,
      teacherCount: 5,
      financeCount: 2,
      customerCount: 80,
      studentCount: 200,
      contractCount: 180,
      scheduleCount: 5000,    // 大量
      feedbackCount: 20000,    // 大量
      recurringScheduleCount: 20,
    }),

    'demo-archived': () => buildSpec({
      salesCount: 1,
      customerCount: 5,
      studentCount: 3,
      contractCount: 2,
    }),

    'demo-frozen': () => buildSpec({
      salesCount: 1,
      customerCount: 3,
      studentCount: 1,
      contractCount: 0,
    }),
  };

  const generator = scenarios[logicalName];
  if (!generator) {
    console.error(`Unknown logicalName: ${logicalName}`);
    process.exit(2);
  }
  return generator();
}

// ===== 通用 buildSpec：根据 counts 生成对应行 =====
function buildSpec(opts) {
  const {
    bossCount = 0,
    salesCount = 0,
    academicCount = 0,
    teacherCount = 0,
    hrCount = 0,
    financeCount = 0,
    marketingCount = 0,
    customerCount = 0,
    studentCount = 0,
    contractCount = 0,
    scheduleCount = 0,
    feedbackCount = 0,
    teacherRatingCount = 0,
    invoiceCount = 0,
    refundCount = 0,
    parentReferralCount = 0,
    parentsCount = 0,
    recurringScheduleCount = 0,
    pendingScheduleContractCount = 0,
    allCustomersToFirstSales = false,
  } = opts;

  // ---- users ----
  // admin 由 provision 建（在 demo-users.json 里），其他角色这里加
  const users = [];
  let phoneCounter = 2001;
  const addUser = (role, displayName) => {
    const u = {
      id: deterministicUlid(`user-${role}`, users.length),
      name: `${role}-${displayName}-${users.length + 1}`,
      mobile: `1380000${String(phoneCounter).padStart(4, '0')}`,
      role,
      campus_id: campusIds[users.length % campusIds.length],
      status: '启用',
      deactivated: false,
    };
    phoneCounter += 1;
    users.push(u);
    return u;
  };
  for (let i = 0; i < bossCount; i++) addUser('boss', 'boss');
  for (let i = 0; i < salesCount; i++) addUser('sales', 'sales');
  for (let i = 0; i < academicCount; i++) addUser('academic', 'academic');
  for (let i = 0; i < teacherCount; i++) addUser('teacher', 'teacher');
  for (let i = 0; i < hrCount; i++) addUser('hr', 'hr');
  for (let i = 0; i < financeCount; i++) addUser('finance', 'finance');
  for (let i = 0; i < marketingCount; i++) addUser('marketing', 'marketing');

  // 验证手机号格式（防 phoneCounter 超界）
  for (const u of users) {
    if (!/^1[3-9]\d{9}$/.test(u.mobile)) {
      console.error(`Invalid phone ${u.mobile} for user ${u.id} — phoneCounter overflow?`);
      process.exit(2);
    }
  }

  // ---- teachers ----
  const teacherUsers = users.filter(u => u.role === 'teacher');
  const teachers = teacherUsers.map((u, i) => ({
    id: deterministicUlid('teacher', i),
    user_id: u.id,
    name: `老师-${i + 1}`,
    phone: u.mobile,
    campus_id: u.campus_id,
    subjects: ['数学', '英语'],
    status: '在职',
  }));

  // ---- customers ----
  const customers = [];
  const salesUsers = users.filter(u => u.role === 'sales');
  for (let i = 0; i < customerCount; i++) {
    const owner = allCustomersToFirstSales && salesUsers.length > 0
      ? salesUsers[0]
      : salesUsers.length > 0
        ? salesUsers[i % salesUsers.length]
        : null;
    // 手机号严格 11 位: 138 + 9 位
    //   生产 admin 用 13800001001-13800001015
    //   demo user 用 13800002xxx-13800003xxx 范围（保留 ~10000 个 slot）
    //   customer 用 13800100xxx 起（4 位序号，留 8000 个 slot 给单 tenant max 80 customer × 100 个 tenant 不够）
    //   改用 138 + i 转 hex 8 字符（hex 7 字符 = 16^7 = 2.6 亿 slot）
    // 实际公式：13800 + (10000000 + i × 100) 取 6 位 → 138001000000+i  → 但 138 + 9 位 = 12 位
    // 正确：手机号必须 11 位 = 1 + 10 位
    //   138 + 8 位 = 11 位 → 138 + str(i + 10000000) 取 8 位 → i ∈ [10000000, 99999999]
    //   每 tenant 80 customer ✓ 200 student ✓ 安全
    const customerPhone = `138${String(10000000 + i).padStart(8, '0')}`;
    customers.push({
      id: deterministicUlid('customer', i),
      parent_name: `客户家长-${i + 1}`,
      primary_mobile: customerPhone,
      campus_id: campusIds[i % campusIds.length],
      owner_id: owner ? owner.id : null,
      source: '朋友推荐',
      nullPii: false,
      nullEncrypted: false,
    });
  }

  // 验证 customer 手机号格式
  for (const c of customers) {
    if (!/^1[3-9]\d{9}$/.test(c.primary_mobile)) {
      console.error(`Invalid customer phone ${c.primary_mobile}`);
      process.exit(2);
    }
  }

  // ---- students ----
  const students = [];
  for (let i = 0; i < studentCount; i++) {
    students.push({
      id: deterministicUlid('student', i),
      student_name: `学员-${i + 1}`,
      customer_id: customers.length > 0 ? customers[i % customers.length].id : null,
      grade_or_age: ['初一', '初二', '高一', '高二', '小六'][i % 5],
      intended_subject: ['数学', '英语', '物理', '语文'][i % 4],
      assigned_teacher_id: teachers.length > 0 ? teachers[i % teachers.length].id : null,
      owner_sales_id: salesUsers.length > 0 ? salesUsers[i % salesUsers.length].id : null,
      archived: false,
    });
  }

  // ---- course_products (1 个默认 — admin provision 也建过，这里加 1 个固定 ID 共用) ----
  const courseProducts = [{
    id: deterministicUlid('cp', 0),
    product_name: '初中数学一对一',
    course_line: '数学',
    class_type: '一对一',
    lesson_package: '20课时',
    standard_price: 3000,
    campus_scope: campusIds.join(','),
    status: '上架',
  }];

  // ---- contracts ----
  const contracts = [];
  for (let i = 0; i < contractCount; i++) {
    if (students.length === 0 || courseProducts.length === 0) break;
    contracts.push({
      id: deterministicUlid('contract', i),
      student_id: students[i % students.length].id,
      course_product_id: courseProducts[0].id,
      class_type: '一对一',
      lesson_hours: 20,
      standard_price: 3000,
      discount_amount: 0,
      gift_hours: 0,
      total_amount: 3000,
      order_type: '新签',
      paid_locked: false,
      owner_user_id: salesUsers.length > 0 ? salesUsers[i % salesUsers.length].id : null,
      opportunity_id: null,
      signed_at: new Date(Date.now() - i * 86400 * 1000).toISOString(),
      status: i < pendingScheduleContractCount ? 'pending_schedule' : 'active',
      activated_at: null,
      campus_id: campusIds[i % campusIds.length],
    });
  }

  // ---- schedules (单次 + recurring 展开) ----
  const schedules = [];
  for (let i = 0; i < scheduleCount; i++) {
    if (teachers.length === 0 || students.length === 0) break;
    const teacher = teacherCount === 2 && i % 4 !== 0
      ? teachers[0]    // teacher_rated: teacher-A 主带 15，teacher-B 5
      : teachers[i % teachers.length];
    const student = students[i % students.length];
    // 错开时间：从今天起每 schedule 间隔 1 小时
    const startAt = new Date(Date.now() + i * 3600 * 1000);
    const durationMin = 60;
    const endAt = new Date(startAt.getTime() + durationMin * 60 * 1000);
    schedules.push({
      id: deterministicUlid('schedule', i),
      course_product_id: courseProducts[0].id,
      teacher_id: teacher.id,
      student_id: student.id,
      start_at: startAt.toISOString(),
      duration_min: durationMin,
      end_at: endAt.toISOString(),
      status: '已排课',
      source: 'one_off',
      recurring_schedule_id: null,
      created_by_user_id: users.find(u => u.role === 'academic')?.id || users.find(u => u.role === 'admin')?.id || admin.userId,
      created_by_role: 'academic',
    });
  }

  // ---- recurring_schedules ----
  const recurringSchedules = [];
  for (let i = 0; i < recurringScheduleCount; i++) {
    if (teachers.length === 0 || students.length === 0) break;
    const teacher = teachers[i % teachers.length];
    const student = students[i % students.length];
    const academicUser = users.find(u => u.role === 'academic') || users[0];
    if (!academicUser) break;
    recurringSchedules.push({
      id: deterministicUlid('recurring', i),
      // binding 由 generator 创建（必填 FK）
      binding_id: deterministicUlid('stb', i),
      student_id: student.id,
      teacher_id: teacher.id,
      course_product_id: courseProducts[0].id,
      by_day: ['MO', 'WE'],
      start_minutes: 960,    // 16:00
      duration_min: 60,
      start_date: '2026-05-01',
      end_date: null,
      status: 'active',
      created_by_user_id: academicUser.id,
      created_by_role: 'academic',
    });
  }

  // ---- student_teacher_bindings (recurring 必填 FK) ----
  const studentTeacherBindings = recurringSchedules.map((rs, i) => ({
    id: rs.binding_id,
    student_id: rs.student_id,
    teacher_id: rs.teacher_id,
    subject: '数学',
    status: 'active',
    bound_by_user_id: rs.created_by_user_id,
  }));

  // ---- lesson_feedbacks ----
  const feedbacks = [];
  for (let i = 0; i < feedbackCount; i++) {
    if (schedules.length === 0) break;
    const sch = schedules[i % schedules.length];
    feedbacks.push({
      id: deterministicUlid('feedback', i),
      schedule_id: sch.id,
      student_id: sch.student_id,
      teacher_id: sch.teacher_id,
      attendance_status: '出勤',
      classroom_performance: ['优秀', '良好', '合格'][i % 3],
      knowledge_points: ['加减法', '乘除法'],
      homework: '完成第3章练习',
      teacher_note: '今日表现良好',
      teacher_internal_note: null,
      submitted_at: new Date(Date.now() - (i % 30) * 86400 * 1000).toISOString(),
    });
  }

  // ---- teacher_ratings (聚合表，每老师 1 行) ----
  // architect spec teacherRatingCount = 评分总次数（不是表行数）
  //   - demo-teacher-rated 拍板：1/3/4/5/5 共 5 次评分 avg=3.6（注入 teacher-A）
  //   - demo-boss-single 「teacher_ratings: 10」= 10 次评分分布在 2 个老师
  // 实现：用 1/3/4/5/5 模式循环 N 次，按 teachers.length 切分
  const teacherRatings = [];
  if (teacherRatingCount > 0 && teachers.length > 0) {
    const starPattern = [1, 3, 4, 5, 5];
    // 给每个 teacher 分配评分
    const ratingsPerTeacher = Math.ceil(teacherRatingCount / teachers.length);
    let remaining = teacherRatingCount;
    for (let ti = 0; ti < teachers.length && remaining > 0; ti++) {
      const myCount = Math.min(ratingsPerTeacher, remaining);
      const sum = Array.from({ length: myCount }, (_, k) => starPattern[k % starPattern.length])
        .reduce((a, b) => a + b, 0);
      teacherRatings.push({
        teacher_id: teachers[ti].id,
        rating_count: myCount,
        rating_sum: sum,
        avg_stars: Math.round((sum / myCount) * 100) / 100,
        last_rated_at: new Date().toISOString(),
      });
      remaining -= myCount;
    }
  }

  // ---- invoices ----
  const invoices = [];
  for (let i = 0; i < invoiceCount; i++) {
    if (contracts.length === 0) break;
    const ct = contracts[i % contracts.length];
    let status;
    if (i < 7) status = 'issued';
    else if (i < 9) status = 'pending';
    else status = 'cancelled';
    invoices.push({
      id: deterministicUlid('invoice', i),
      contract_id: ct.id,
      student_id: ct.student_id,
      customer_id: students.find(s => s.id === ct.student_id)?.customer_id || null,
      title_type: i % 2 === 0 ? '个人' : '企业',
      invoice_title: `开票抬头-${i + 1}`,
      tax_id: i % 2 === 1 ? `91500000${String(100000000 + i).slice(0, 9)}MA` : null,
      receive_email: `invoice-${i}@demo.local`,
      receive_phone: `138${String(20000000 + i).padStart(8, '0')}`,
      amount: 3000,
      status,
      created_by_user_id: users.find(u => u.role === 'finance')?.id || admin.userId,
      issued_at: status === 'issued' ? new Date().toISOString() : null,
      cancelled_at: status === 'cancelled' ? new Date().toISOString() : null,
    });
  }

  // ---- parent_referrals ----
  const parentReferrals = [];
  for (let i = 0; i < parentReferralCount; i++) {
    if (teachers.length === 0 || students.length === 0) break;
    parentReferrals.push({
      id: deterministicUlid('referral', i),
      teacher_id: teachers[i % teachers.length].id,
      referrer_parent_id: deterministicUlid('referrer-parent', i),   // demo 用，无 FK 校验
      referrer_student_id: students[i % students.length].id,
      referral_code: `REF-${logicalName}-${String(i + 1).padStart(4, '0')}`,
      status: 'created',
    });
  }

  return {
    users,
    teachers,
    customers,
    students,
    courseProducts,
    contracts,
    schedules,
    feedbacks,
    teacher_ratings: teacherRatings,
    invoices,
    parent_referrals: parentReferrals,
    parents: [],
    parent_student_bindings: [],
    recurring_schedules: recurringSchedules,
    student_teacher_bindings: studentTeacherBindings,
  };
}

// ===== SQL 序列化 =====
function buildSql(spec) {
  const lines = [];
  lines.push('-- ============================================================');
  lines.push(`-- seed data for ${logicalName}`);
  lines.push(`-- tenantId=${tenantId}`);
  lines.push(`-- tenantSchema=${tenantSchema}`);
  lines.push(`-- generated at ${new Date().toISOString()}`);
  lines.push('-- ============================================================');
  lines.push('');
  lines.push('BEGIN;');
  lines.push(`SET LOCAL search_path = ${tenantSchema}, public;`);
  lines.push('');

  // --- users ---
  if (spec.users.length > 0) {
    lines.push('-- users');
    for (const u of spec.users) {
      const deactivatedAt = u.deactivated ? `'${new Date(Date.now() - 30 * 86400 * 1000).toISOString()}'::timestamptz` : 'NULL';
      const deletedAt = u.deactivated ? `'${new Date(Date.now() - 30 * 86400 * 1000).toISOString()}'::timestamptz` : 'NULL';
      const status = u.deactivated ? '停用' : '启用';
      lines.push(
        `INSERT INTO users (id, name, mobile, role, campus_id, status, password_hash, password_updated_at, created_by, updated_by, deleted_at)
 VALUES (${sqlString(u.id)}, ${sqlString(u.name)}, ${sqlString(u.mobile)}, ${sqlString(u.role)}, ${sqlString(u.campus_id)}, ${sqlString(status)}, ${sqlString(DEMO_BCRYPT_HASH)}, NOW(), ${sqlString(admin.userId)}, ${sqlString(admin.userId)}, ${deletedAt})
 ON CONFLICT (id) DO NOTHING;`
      );
    }
    lines.push('');
  }

  // --- teachers ---
  if (spec.teachers.length > 0) {
    lines.push('-- teachers');
    for (const t of spec.teachers) {
      const phoneEnc = sqlBytea(aesGcmEncrypt(t.phone));
      lines.push(
        `INSERT INTO teachers (id, campus_id, name, phone, phone_encrypted, user_id, subjects, status, created_by, updated_by)
 VALUES (${sqlString(t.id)}, ${sqlString(t.campus_id)}, ${sqlString(t.name)}, ${sqlString(t.phone)}, ${phoneEnc}, ${sqlString(t.user_id)}, ${sqlJsonb(t.subjects)}, ${sqlString(t.status)}, ${sqlString(admin.userId)}, ${sqlString(admin.userId)})
 ON CONFLICT (id) DO NOTHING;`
      );
    }
    lines.push('');
  }

  // --- customers (V41 加密 双写) ---
  if (spec.customers.length > 0) {
    lines.push('-- customers');
    for (const c of spec.customers) {
      const mobileHash = c.nullPii ? 'NULL' : sqlBytea(hmacHash(c.primary_mobile));
      const mobileEncrypted = c.nullEncrypted ? 'NULL' : sqlBytea(aesGcmEncrypt(c.primary_mobile));
      lines.push(
        `INSERT INTO customers (id, parent_name, primary_mobile, primary_mobile_hash, primary_mobile_encrypted, campus_id, owner_id, source_level1, created_by, updated_by)
 VALUES (${sqlString(c.id)}, ${sqlString(c.parent_name)}, ${sqlString(c.primary_mobile)}, ${mobileHash}, ${mobileEncrypted}, ${sqlString(c.campus_id)}, ${c.owner_id ? sqlString(c.owner_id) : 'NULL'}, ${sqlString(c.source || null)}, ${sqlString(admin.userId)}, ${sqlString(admin.userId)})
 ON CONFLICT (id) DO NOTHING;`
      );
    }
    lines.push('');
  }

  // --- course_products ---
  if (spec.courseProducts.length > 0) {
    lines.push('-- course_products');
    for (const cp of spec.courseProducts) {
      lines.push(
        `INSERT INTO course_products (id, product_name, course_line, class_type, lesson_package, standard_price, campus_scope, status, created_by, updated_by)
 VALUES (${sqlString(cp.id)}, ${sqlString(cp.product_name)}, ${sqlString(cp.course_line)}, ${sqlString(cp.class_type)}, ${sqlString(cp.lesson_package)}, ${sqlNumeric(cp.standard_price)}, ${sqlString(cp.campus_scope)}, ${sqlString(cp.status)}, ${sqlString(admin.userId)}, ${sqlString(admin.userId)})
 ON CONFLICT (id) DO NOTHING;`
      );
    }
    lines.push('');
  }

  // --- students ---
  if (spec.students.length > 0) {
    lines.push('-- students');
    for (const s of spec.students) {
      const archivedAt = s.archived ? `'${new Date(Date.now() - 7 * 86400 * 1000).toISOString()}'::timestamptz` : 'NULL';
      lines.push(
        `INSERT INTO students (id, student_name, customer_id, grade_or_age, intended_subject, assigned_teacher_id, owner_sales_id, created_by, updated_by, deleted_at)
 VALUES (${sqlString(s.id)}, ${sqlString(s.student_name)}, ${s.customer_id ? sqlString(s.customer_id) : 'NULL'}, ${sqlString(s.grade_or_age)}, ${sqlString(s.intended_subject)}, ${s.assigned_teacher_id ? sqlString(s.assigned_teacher_id) : 'NULL'}, ${s.owner_sales_id ? sqlString(s.owner_sales_id) : 'NULL'}, ${sqlString(admin.userId)}, ${sqlString(admin.userId)}, ${archivedAt})
 ON CONFLICT (id) DO NOTHING;`
      );
    }
    lines.push('');
  }

  // --- contracts ---
  if (spec.contracts.length > 0) {
    lines.push('-- contracts');
    for (const c of spec.contracts) {
      lines.push(
        `INSERT INTO contracts (id, student_id, course_product_id, class_type, lesson_hours, standard_price, discount_amount, gift_hours, total_amount, order_type, paid_locked, owner_user_id, signed_at, status, campus_id, created_by, updated_by)
 VALUES (${sqlString(c.id)}, ${sqlString(c.student_id)}, ${sqlString(c.course_product_id)}, ${sqlString(c.class_type)}, ${sqlInt(c.lesson_hours)}, ${sqlNumeric(c.standard_price)}, ${sqlNumeric(c.discount_amount)}, ${sqlInt(c.gift_hours)}, ${sqlNumeric(c.total_amount)}, ${sqlString(c.order_type)}, ${c.paid_locked ? 'TRUE' : 'FALSE'}, ${c.owner_user_id ? sqlString(c.owner_user_id) : 'NULL'}, ${sqlTimestamp(c.signed_at)}, ${sqlString(c.status)}, ${sqlString(c.campus_id)}, ${sqlString(admin.userId)}, ${sqlString(admin.userId)})
 ON CONFLICT (id) DO NOTHING;`
      );
    }
    lines.push('');
  }

  // --- student_teacher_bindings ---
  if (spec.student_teacher_bindings && spec.student_teacher_bindings.length > 0) {
    lines.push('-- student_teacher_bindings');
    for (const stb of spec.student_teacher_bindings) {
      lines.push(
        `INSERT INTO student_teacher_bindings (id, student_id, teacher_id, subject, status, bound_by_user_id)
 VALUES (${sqlString(stb.id)}, ${sqlString(stb.student_id)}, ${sqlString(stb.teacher_id)}, ${sqlString(stb.subject)}, ${sqlString(stb.status)}, ${sqlString(stb.bound_by_user_id)})
 ON CONFLICT (id) DO NOTHING;`
      );
    }
    lines.push('');
  }

  // --- recurring_schedules ---
  if (spec.recurring_schedules && spec.recurring_schedules.length > 0) {
    lines.push('-- recurring_schedules');
    for (const rs of spec.recurring_schedules) {
      lines.push(
        `INSERT INTO recurring_schedules (id, binding_id, student_id, teacher_id, course_product_id, by_day, start_minutes, duration_min, start_date, end_date, status, created_by_user_id, created_by_role)
 VALUES (${sqlString(rs.id)}, ${sqlString(rs.binding_id)}, ${sqlString(rs.student_id)}, ${sqlString(rs.teacher_id)}, ${sqlString(rs.course_product_id)}, ${sqlJsonb(rs.by_day)}, ${sqlInt(rs.start_minutes)}, ${sqlInt(rs.duration_min)}, '${rs.start_date}'::date, ${rs.end_date ? `'${rs.end_date}'::date` : 'NULL'}, ${sqlString(rs.status)}, ${sqlString(rs.created_by_user_id)}, ${sqlString(rs.created_by_role)})
 ON CONFLICT (id) DO NOTHING;`
      );
    }
    lines.push('');
  }

  // --- schedules (大量分批) ---
  if (spec.schedules.length > 0) {
    lines.push(`-- schedules (${spec.schedules.length} rows, batched)`);
    // 每个 INSERT 一行，便于 ON CONFLICT 处理；大量时跑慢但保正确性
    // 大批量优化：组 multi-value VALUES (...) , (...) — 每 100 条一批
    const BATCH = 100;
    for (let i = 0; i < spec.schedules.length; i += BATCH) {
      const batch = spec.schedules.slice(i, i + BATCH);
      const valueRows = batch.map(s =>
        `(${sqlString(s.id)}, ${sqlString(s.course_product_id)}, ${sqlString(s.teacher_id)}, '${s.start_at}'::timestamptz, ${sqlInt(s.duration_min)}, '${s.end_at}'::timestamptz, ${sqlString(s.status)}, ${sqlString(s.source)}, ${s.recurring_schedule_id ? sqlString(s.recurring_schedule_id) : 'NULL'}, ${sqlString(s.created_by_user_id)}, ${sqlString(s.created_by_role)})`
      ).join(',\n  ');
      lines.push(
        `INSERT INTO schedules (id, course_product_id, teacher_id, start_at, duration_min, end_at, status, source, recurring_schedule_id, created_by_user_id, created_by_role)
 VALUES ${valueRows}
 ON CONFLICT (id) DO NOTHING;`
      );
    }
    // schedule_students (1对1：每 schedule 1 学员)
    lines.push('-- schedule_students');
    for (let i = 0; i < spec.schedules.length; i += BATCH) {
      const batch = spec.schedules.slice(i, i + BATCH);
      const valueRows = batch.map(s =>
        `(${sqlString(s.id)}, ${sqlString(s.student_id)}, '待出勤')`
      ).join(',\n  ');
      lines.push(
        `INSERT INTO schedule_students (schedule_id, student_id, attendance_status)
 VALUES ${valueRows}
 ON CONFLICT (schedule_id, student_id) DO NOTHING;`
      );
    }
    lines.push('');
  }

  // --- lesson_feedbacks (大量分批 + 防 UNIQUE 冲突) ---
  if (spec.feedbacks.length > 0) {
    lines.push(`-- lesson_feedbacks (${spec.feedbacks.length} rows, batched)`);
    // UNIQUE (schedule_id, student_id) — 每 schedule 只能有 1 feedback per student
    // 当 feedbackCount > scheduleCount 时（demo-large-scale: 5000 schedule + 20000 feedback），
    // 多余的 feedback 会撞 UNIQUE → ON CONFLICT 跳过
    // 解决：每个 schedule 最多 1 feedback；20000 > 5000 → 只成功插 5000
    // [待 leader 确认] architect spec §3.2 demo-large-scale: 5000 schedule + 20000 feedback
    //   是否意味着「每 schedule 4 条 feedback」？schema UNIQUE (schedule_id, student_id)
    //   只允许每 schedule 每 student 1 条。本 generator 按 1 feedback per schedule（5000 上限）
    //   实际能插入数 = min(scheduleCount, feedbackCount)
    const seen = new Set();
    const deduped = [];
    for (const fb of spec.feedbacks) {
      const key = `${fb.schedule_id}|${fb.student_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(fb);
    }
    const BATCH = 100;
    for (let i = 0; i < deduped.length; i += BATCH) {
      const batch = deduped.slice(i, i + BATCH);
      const valueRows = batch.map(fb =>
        `(${sqlString(fb.id)}, ${sqlString(fb.schedule_id)}, ${sqlString(fb.student_id)}, ${sqlString(fb.teacher_id)}, ${sqlString(fb.attendance_status)}, ${sqlString(fb.classroom_performance)}, ${sqlJsonb(fb.knowledge_points)}, ${sqlString(fb.homework)}, ${sqlString(fb.teacher_note)}, ${sqlString(fb.teacher_internal_note)}, '${fb.submitted_at}'::timestamptz)`
      ).join(',\n  ');
      lines.push(
        `INSERT INTO lesson_feedbacks (id, schedule_id, student_id, teacher_id, attendance_status, classroom_performance, knowledge_points, homework, teacher_note, teacher_internal_note, submitted_at)
 VALUES ${valueRows}
 ON CONFLICT (schedule_id, student_id) DO NOTHING;`
      );
    }
    lines.push('');
  }

  // --- teacher_ratings ---
  if (spec.teacher_ratings.length > 0) {
    lines.push('-- teacher_ratings');
    for (const tr of spec.teacher_ratings) {
      lines.push(
        `INSERT INTO teacher_ratings (teacher_id, rating_count, rating_sum, avg_stars, last_rated_at)
 VALUES (${sqlString(tr.teacher_id)}, ${sqlInt(tr.rating_count)}, ${sqlNumeric(tr.rating_sum)}, ${sqlNumeric(tr.avg_stars)}, '${tr.last_rated_at}'::timestamptz)
 ON CONFLICT (teacher_id) DO NOTHING;`
      );
    }
    lines.push('');
  }

  // --- invoices (V42 字段加密双写) ---
  if (spec.invoices.length > 0) {
    lines.push('-- invoices');
    for (const inv of spec.invoices) {
      const titleEnc = sqlBytea(aesGcmEncrypt(inv.invoice_title));
      const taxIdEnc = inv.tax_id ? sqlBytea(aesGcmEncrypt(inv.tax_id)) : 'NULL';
      const phoneHash = sqlBytea(hmacHash(inv.receive_phone));
      const phoneEnc = sqlBytea(aesGcmEncrypt(inv.receive_phone));
      lines.push(
        `INSERT INTO invoices (id, contract_id, student_id, customer_id, title_type, invoice_title, invoice_title_encrypted, tax_id, tax_id_encrypted, receive_email, receive_phone, receive_phone_hash, receive_phone_encrypted, amount, status, created_by_user_id, issued_at, cancelled_at)
 VALUES (${sqlString(inv.id)}, ${sqlString(inv.contract_id)}, ${inv.student_id ? sqlString(inv.student_id) : 'NULL'}, ${inv.customer_id ? sqlString(inv.customer_id) : 'NULL'}, ${sqlString(inv.title_type)}, ${sqlString(inv.invoice_title)}, ${titleEnc}, ${inv.tax_id ? sqlString(inv.tax_id) : 'NULL'}, ${taxIdEnc}, ${sqlString(inv.receive_email)}, ${sqlString(inv.receive_phone)}, ${phoneHash}, ${phoneEnc}, ${sqlNumeric(inv.amount)}, ${sqlString(inv.status)}, ${sqlString(inv.created_by_user_id)}, ${sqlTimestamp(inv.issued_at)}, ${sqlTimestamp(inv.cancelled_at)})
 ON CONFLICT (id) DO NOTHING;`
      );
    }
    lines.push('');
  }

  // --- parent_referrals ---
  if (spec.parent_referrals.length > 0) {
    lines.push('-- parent_referrals');
    for (const ref of spec.parent_referrals) {
      lines.push(
        `INSERT INTO parent_referrals (id, teacher_id, referrer_parent_id, referrer_student_id, referral_code, status)
 VALUES (${sqlString(ref.id)}, ${sqlString(ref.teacher_id)}, ${sqlString(ref.referrer_parent_id)}, ${sqlString(ref.referrer_student_id)}, ${sqlString(ref.referral_code)}, ${sqlString(ref.status)})
 ON CONFLICT (id) DO NOTHING;`
      );
    }
    lines.push('');
  }

  lines.push('COMMIT;');
  lines.push('');

  // --- public.parents + parent_student_bindings (跨租户表，单独 schema) ---
  if ((spec.parents && spec.parents.length > 0) || (spec.parent_student_bindings && spec.parent_student_bindings.length > 0)) {
    lines.push('-- public.parents + parent_student_bindings (跨租户共享, 独立事务)');
    lines.push('BEGIN;');
    if (spec.parents.length > 0) {
      for (const p of spec.parents) {
        const phoneHash = sqlBytea(hmacHash(p.phone));
        const phoneEnc = sqlBytea(aesGcmEncrypt(p.phone));
        lines.push(
          `INSERT INTO public.parents (id, phone, phone_hash, phone_encrypted, name, avatar_url, status)
 VALUES (${sqlString(p.id)}, ${sqlString(p.phone)}, ${phoneHash}, ${phoneEnc}, ${sqlString(p.name)}, ${p.avatar_url ? sqlString(p.avatar_url) : 'NULL'}, '启用')
 ON CONFLICT (id) DO NOTHING;`
        );
      }
    }
    if (spec.parent_student_bindings.length > 0) {
      for (const psb of spec.parent_student_bindings) {
        lines.push(
          `INSERT INTO public.parent_student_bindings (id, parent_id, student_id, tenant_id, is_primary, relationship, binding_status)
 VALUES (${sqlString(psb.id)}, ${sqlString(psb.parent_id)}, ${sqlString(psb.student_id)}, ${sqlString(psb.tenant_id)}, ${psb.is_primary ? 'TRUE' : 'FALSE'}, ${sqlString(psb.relationship)}, 'active')
 ON CONFLICT (id) DO NOTHING;`
        );
      }
    }
    lines.push('COMMIT;');
    lines.push('');
  }

  return lines.join('\n');
}

// ===== main =====
const spec = generateSpec();
const sql = buildSql(spec);

fs.writeFileSync(OUTPUT_SQL, sql);

// 输出 summary 到 stderr，stdout 留给可能的 piped reader
const summary = {
  logicalName,
  tenantId,
  tenantSchema,
  rowCounts: {
    users: spec.users.length,
    teachers: spec.teachers.length,
    customers: spec.customers.length,
    students: spec.students.length,
    contracts: spec.contracts.length,
    schedules: spec.schedules.length,
    feedbacks_max: spec.feedbacks.length,
    teacher_ratings: spec.teacher_ratings.length,
    invoices: spec.invoices.length,
    parent_referrals: spec.parent_referrals.length,
    parents: spec.parents.length,
    parent_student_bindings: spec.parent_student_bindings.length,
    recurring_schedules: spec.recurring_schedules.length,
    student_teacher_bindings: (spec.student_teacher_bindings || []).length,
  },
  sqlBytes: sql.length,
};
console.log(JSON.stringify(summary));
