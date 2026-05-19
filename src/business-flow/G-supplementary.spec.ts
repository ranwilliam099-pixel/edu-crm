/**
 * L8 业务流 G — 补充线 (G1-G5 38 case)
 *
 * 来源:
 *   - v2.0 §5.G 补充线
 *   - G1 教师评分 / 月度排行 (8)
 *   - G2 学员请假 / 调课 (6, 复用 B3 语义)
 *   - G3 课时包余额预警 (4, < 5 单阈值)
 *   - G4 学员推荐 / 转介绍 (5, 课时奖励)
 *   - G5 作业 / 评测 / 学情档案 (15)
 *
 * 验证关注点:
 *   - parent 评分 1-5 星 + 月度聚合
 *   - balance < 5 push 提醒, balance = 0 排课拒绝
 *   - 推荐码 + 课时奖励
 *   - homework / assessment 全链路
 */
import { ForbiddenException, BadRequestException } from '@nestjs/common';

interface AuditEntry {
  actorRole: string;
  action: string;
  outcome: 'success' | 'denied';
  meta?: Record<string, unknown>;
}
class MockAuditLog {
  entries: AuditEntry[] = [];
  log(e: AuditEntry): void {
    this.entries.push(e);
  }
  byAction(a: string): AuditEntry[] {
    return this.entries.filter((entry) => entry.action === a);
  }
}

interface MockUser {
  sub: string;
  role: 'sales' | 'academic' | 'admin' | 'boss' | 'teacher' | 'parent';
  ownChildren?: string[];
  authorizedStudents?: string[];
}

type MsgSecResult = 'ok' | 'risky' | 'timeout';
function mockMsgSec(content: string): MsgSecResult {
  if (content.includes('暴力')) return 'risky';
  if (content === '__TIMEOUT__') return 'timeout';
  return 'ok';
}

// =========================================
// G1: 教师评分 / 月度排行 (8 case)
// =========================================

interface Rating {
  id: string;
  parentSub: string;
  teacherId: string;
  scheduleId: string;
  score: number;
  comment?: string;
  pendingReview: boolean;
  idempotencyKey: string;
}

class RatingStore {
  ratings: Rating[] = [];
  upsert(input: Omit<Rating, 'id'>): { created: boolean; rating: Rating } {
    const existing = this.ratings.find((r) => r.idempotencyKey === input.idempotencyKey);
    if (existing) return { created: false, rating: existing };
    const r: Rating = { id: 'R_' + (this.ratings.length + 1), ...input };
    this.ratings.push(r);
    return { created: true, rating: r };
  }
}

function rateTeacher(
  user: MockUser,
  body: {
    scheduleId: string;
    teacherId: string;
    scheduleStudentId: string;
    score: number;
    comment?: string;
    idempotencyKey: string;
  },
  store: RatingStore,
  audit: MockAuditLog,
): { created: boolean; rating: Rating } {
  if (user.role !== 'parent') {
    audit.log({ actorRole: user.role, action: 'rating.create', outcome: 'denied', meta: { reason: 'role not parent' } });
    throw new ForbiddenException('only parent can rate');
  }
  if (!user.ownChildren?.includes(body.scheduleStudentId)) {
    audit.log({ actorRole: 'parent', action: 'rating.create', outcome: 'denied', meta: { reason: 'not own child' } });
    throw new ForbiddenException('parent cannot rate teacher for other children');
  }
  if (body.score < 1 || body.score > 5) {
    throw new BadRequestException('score must be in [1, 5]');
  }
  let pendingReview = false;
  if (body.comment) {
    const r = mockMsgSec(body.comment);
    if (r === 'risky') {
      audit.log({ actorRole: 'parent', action: 'rating.msgsec-blocked', outcome: 'denied' });
      throw new BadRequestException('comment blocked by msgSecCheck');
    }
    pendingReview = r === 'timeout';
  }
  const result = store.upsert({
    parentSub: user.sub,
    teacherId: body.teacherId,
    scheduleId: body.scheduleId,
    score: body.score,
    comment: body.comment,
    pendingReview,
    idempotencyKey: body.idempotencyKey,
  });
  audit.log({
    actorRole: 'parent',
    action: result.created ? 'rating.create' : 'rating.idempotent-hit',
    outcome: 'success',
    meta: { ratingId: result.rating.id },
  });
  return result;
}

interface MonthlyAggregate {
  teacherId: string;
  yearMonth: string;
  avgScore: number;
  count: number;
  distribution: Record<string, number>; // "1"-"5" → count
}

function aggregateRatings(teacherId: string, yearMonth: string, ratings: Rating[]): MonthlyAggregate {
  const my = ratings.filter((r) => r.teacherId === teacherId);
  if (my.length === 0) return { teacherId, yearMonth, avgScore: 0, count: 0, distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 } };
  const sum = my.reduce((acc, r) => acc + r.score, 0);
  const dist: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
  for (const r of my) dist[String(r.score)] = (dist[String(r.score)] || 0) + 1;
  return { teacherId, yearMonth, avgScore: sum / my.length, count: my.length, distribution: dist };
}

function teacherReadOwnRatingHistory(user: MockUser, teacherId: string, ratings: Rating[]): Rating[] {
  if (user.role !== 'teacher' || user.sub !== teacherId) {
    // teacher 只能看自己 (admin/boss 可查任意, 不在本 helper)
    throw new ForbiddenException('teacher can only view own ratings');
  }
  return ratings.filter((r) => r.teacherId === teacherId);
}

function teacherReadMonthlyRanking(
  user: MockUser,
  yearMonth: string,
  aggregates: MonthlyAggregate[],
  bossConfig: { realName: boolean },
): { teacherId: string; avgScore: number; count: number }[] {
  if (user.role !== 'teacher') {
    throw new ForbiddenException('only teacher can view monthly ranking');
  }
  const ranked = [...aggregates].sort((a, b) => b.avgScore - a.avgScore);
  return ranked.map((a) => ({
    teacherId: bossConfig.realName ? a.teacherId : 'ANON',
    avgScore: a.avgScore,
    count: a.count,
  }));
}

function readOtherTeacherDetailRatings(user: MockUser, _ratings: Rating[], audit: MockAuditLog): Rating[] {
  if (!['boss', 'admin'].includes(user.role)) {
    audit.log({ actorRole: user.role, action: 'rating.read-other-teacher', outcome: 'denied' });
    throw new ForbiddenException('only boss/admin can read other teacher real ratings');
  }
  return _ratings;
}

// =========================================
// G2: 学员请假 / 调课 — 6 case (复用 B3 语义)
// =========================================

interface Leave {
  id: string;
  scheduleId: string;
  status: 'pending' | 'approved' | 'rejected';
  studentId: string;
}
interface Schedule {
  id: string;
  studentId: string;
  hoursDeducted: number;
  status: 'pending' | 'cancelled';
  leaveId?: string;
}

class ScheduleStore {
  schedules: Schedule[] = [];
  leaves: Leave[] = [];
  notifications: { to: string; body: string }[] = [];
}

function createLeaveG2(user: MockUser, scheduleId: string, store: ScheduleStore, audit: MockAuditLog): Leave {
  if (!['parent', 'academic', 'admin', 'boss'].includes(user.role)) {
    audit.log({ actorRole: user.role, action: 'leave.create', outcome: 'denied' });
    throw new ForbiddenException('role not allowed');
  }
  const sch = store.schedules.find((s) => s.id === scheduleId);
  if (!sch) throw new BadRequestException('schedule not found');
  if (user.role === 'parent' && !user.ownChildren?.includes(sch.studentId)) {
    audit.log({ actorRole: 'parent', action: 'leave.create', outcome: 'denied', meta: { reason: 'not own child' } });
    throw new ForbiddenException('parent only own child');
  }
  const lv: Leave = { id: 'LV_' + Math.random().toString(36).slice(2, 8).toUpperCase(), scheduleId, status: 'pending', studentId: sch.studentId };
  store.leaves.push(lv);
  audit.log({ actorRole: user.role, action: 'leave.create', outcome: 'success' });
  return lv;
}

function decideLeave(user: MockUser, leaveId: string, approve: boolean, store: ScheduleStore, audit: MockAuditLog): { leave: Leave; schedule: Schedule } {
  if (!['academic', 'admin', 'boss'].includes(user.role)) {
    audit.log({ actorRole: user.role, action: 'leave.decide', outcome: 'denied' });
    throw new ForbiddenException('cannot decide');
  }
  const lv = store.leaves.find((l) => l.id === leaveId);
  if (!lv) throw new BadRequestException('leave not found');
  const sch = store.schedules.find((s) => s.id === lv.scheduleId);
  if (!sch) throw new BadRequestException('schedule not found');
  if (approve) {
    lv.status = 'approved';
    sch.leaveId = lv.id;
    sch.hoursDeducted = 0;
  } else {
    lv.status = 'rejected';
    sch.hoursDeducted = 1;
  }
  audit.log({ actorRole: user.role, action: approve ? 'leave.approve' : 'leave.reject', outcome: 'success' });
  return { leave: lv, schedule: sch };
}

function rescheduleG2(user: MockUser, oldSchId: string, store: ScheduleStore, audit: MockAuditLog): { cancelled: Schedule; created: Schedule } {
  if (user.role !== 'academic') {
    audit.log({ actorRole: user.role, action: 'schedule.reschedule', outcome: 'denied' });
    throw new ForbiddenException('only academic can reschedule');
  }
  const old = store.schedules.find((s) => s.id === oldSchId);
  if (!old) throw new BadRequestException('schedule not found');
  old.status = 'cancelled';
  const created: Schedule = { id: 'SCH_NEW_' + Math.random().toString(36).slice(2, 8).toUpperCase(), studentId: old.studentId, hoursDeducted: 0, status: 'pending' };
  store.schedules.push(created);
  store.notifications.push({ to: 'PARENT_' + old.studentId, body: 'reschedule' });
  store.notifications.push({ to: 'TEACHER', body: 'reschedule' });
  audit.log({ actorRole: 'academic', action: 'schedule.reschedule', outcome: 'success' });
  return { cancelled: old, created };
}

function updateScheduleG2(user: MockUser, audit: MockAuditLog): void {
  if (user.role !== 'academic') {
    audit.log({ actorRole: user.role, action: 'schedule.update', outcome: 'denied' });
    throw new ForbiddenException('only academic');
  }
}

function teacherSelfCancelG2(user: MockUser, audit: MockAuditLog): void {
  audit.log({ actorRole: user.role, action: 'schedule.cancel', outcome: 'denied', meta: { reason: 'teacher cannot self-cancel' } });
  throw new ForbiddenException('teacher cannot self-cancel');
}

// =========================================
// G3: 课时包余额预警 (4 case, < 5 单阈值)
// =========================================

interface CoursePackageBalance {
  studentId: string;
  remainingHours: number;
}

const G3_THRESHOLD = 5;

function checkBalanceAndNotify(balance: CoursePackageBalance, audit: MockAuditLog): { showHomeBadge: boolean; pushNotify: boolean } {
  const showHomeBadge = balance.remainingHours < G3_THRESHOLD;
  const pushNotify = balance.remainingHours < G3_THRESHOLD;
  if (showHomeBadge) {
    audit.log({ actorRole: 'system', action: 'balance.low-alert', outcome: 'success', meta: { studentId: balance.studentId, remaining: balance.remainingHours } });
  }
  return { showHomeBadge, pushNotify };
}

function createScheduleG3(balance: CoursePackageBalance, audit: MockAuditLog): { ok: boolean; reason?: string } {
  if (balance.remainingHours === 0) {
    audit.log({ actorRole: 'system', action: 'schedule.create', outcome: 'denied', meta: { reason: 'no balance' } });
    throw new BadRequestException('please renew course package');
  }
  audit.log({ actorRole: 'system', action: 'schedule.create', outcome: 'success' });
  return { ok: true };
}

function renewAndUpdateBalance(
  studentId: string,
  addHours: number,
  store: Map<string, CoursePackageBalance>,
  audit: MockAuditLog,
): CoursePackageBalance {
  const existing = store.get(studentId);
  const updated: CoursePackageBalance = existing
    ? { studentId, remainingHours: existing.remainingHours + addHours }
    : { studentId, remainingHours: addHours };
  store.set(studentId, updated);
  audit.log({ actorRole: 'system', action: 'balance.renew', outcome: 'success', meta: { studentId, newBalance: updated.remainingHours, notifyParent: true } });
  return updated;
}

// =========================================
// G4: 学员推荐 / 转介绍 (5 case, 课时奖励)
// =========================================

interface Referral {
  code: string;
  parentSub: string;
  uses: number;
}

interface ParentRegistration {
  parentSub: string;
  phone: string;
  referredBy?: string; // code
}

class ReferralStore {
  referrals: Map<string, Referral> = new Map(); // code → Referral
  registrations: ParentRegistration[] = [];
  rewards: { parentSub: string; hours: number }[] = [];
  parentPhones: Map<string, string> = new Map(); // sub → phone
}

function generateReferralCode(parentSub: string, store: ReferralStore, audit: MockAuditLog): Referral {
  // 找已有的
  for (const r of store.referrals.values()) {
    if (r.parentSub === parentSub) return r;
  }
  const code = 'REF_' + parentSub.slice(0, 6).toUpperCase();
  const ref: Referral = { code, parentSub, uses: 0 };
  store.referrals.set(code, ref);
  audit.log({ actorRole: 'parent', action: 'referral.generate', outcome: 'success', meta: { code } });
  return ref;
}

function registerParentG4(phone: string, referredByCode: string | undefined, store: ReferralStore, audit: MockAuditLog): ParentRegistration {
  // 检查推荐人是否就是自己 (同手机号)
  if (referredByCode) {
    const ref = store.referrals.get(referredByCode);
    if (ref) {
      const refererPhone = store.parentPhones.get(ref.parentSub);
      if (refererPhone === phone) {
        audit.log({ actorRole: 'parent', action: 'referral.self-referral', outcome: 'denied' });
        throw new BadRequestException('cannot self-refer (same phone)');
      }
    }
  }
  const sub = 'PAR_' + Math.random().toString(36).slice(2, 8).toUpperCase();
  store.parentPhones.set(sub, phone);
  const reg: ParentRegistration = { parentSub: sub, phone, referredBy: referredByCode };
  store.registrations.push(reg);
  audit.log({ actorRole: 'parent', action: 'parent.register', outcome: 'success', meta: { sub, referredBy: referredByCode } });
  return reg;
}

function onFirstSign(newParentSub: string, store: ReferralStore, audit: MockAuditLog, rewardHours = 5): void {
  const reg = store.registrations.find((r) => r.parentSub === newParentSub);
  if (!reg || !reg.referredBy) return;
  const ref = store.referrals.get(reg.referredBy);
  if (!ref) return;
  ref.uses++;
  store.rewards.push({ parentSub: ref.parentSub, hours: rewardHours });
  audit.log({
    actorRole: 'system',
    action: 'referral.reward',
    outcome: 'success',
    meta: { referrer: ref.parentSub, referred: newParentSub, hours: rewardHours },
  });
}

function adminViewReferralRanking(user: MockUser, store: ReferralStore): { code: string; parentSub: string; uses: number }[] {
  if (!['admin', 'boss'].includes(user.role)) {
    throw new ForbiddenException('only admin/boss');
  }
  return Array.from(store.referrals.values())
    .sort((a, b) => b.uses - a.uses)
    .map((r) => ({ code: r.code, parentSub: r.parentSub, uses: r.uses }));
}

// =========================================
// G5: 作业 / 评测 / 学情档案 (15 case)
// =========================================

interface Homework {
  id: string;
  studentId: string;
  teacherId: string;
  content: string;
  status: 'pending' | 'submitted' | 'graded';
  submission?: { content: string; imageUrl?: string; imgSecCheckOk: boolean };
  grade?: { comment: string; score?: number };
  pendingReview: boolean;
}

interface Assessment {
  id: string;
  studentId: string;
  teacherId: string;
  dimensions: Record<string, number>;
  totalScore: number;
  comment: string;
}

interface LP {
  studentId: string;
  feedbackCount: number;
  assessmentCount: number;
  homeworkCount: number;
  attendanceCount: number;
}

class G5Store {
  homeworks: Homework[] = [];
  assessments: Assessment[] = [];
  profiles: Map<string, LP> = new Map();
}

function createHomework(
  user: MockUser,
  body: { studentId: string; content: string },
  store: G5Store,
  audit: MockAuditLog,
): Homework {
  if (user.role !== 'teacher') {
    audit.log({ actorRole: user.role, action: 'homework.create', outcome: 'denied' });
    throw new ForbiddenException('only teacher');
  }
  const r = mockMsgSec(body.content);
  if (r === 'risky') {
    audit.log({ actorRole: 'teacher', action: 'homework.msgsec-blocked', outcome: 'denied' });
    throw new BadRequestException('blocked');
  }
  const hw: Homework = {
    id: 'HW_' + Math.random().toString(36).slice(2, 8).toUpperCase(),
    studentId: body.studentId,
    teacherId: user.sub,
    content: body.content,
    status: 'pending',
    pendingReview: r === 'timeout',
  };
  store.homeworks.push(hw);
  audit.log({ actorRole: 'teacher', action: 'homework.create', outcome: 'success' });
  return hw;
}

function listHomeworksByParent(parentSub: string, parentChildren: string[], store: G5Store): Homework[] {
  return store.homeworks.filter((h) => parentChildren.includes(h.studentId));
}

function submitHomework(
  user: MockUser,
  hwId: string,
  body: { content: string; imageUrl?: string },
  store: G5Store,
  audit: MockAuditLog,
): Homework {
  if (user.role !== 'parent') {
    audit.log({ actorRole: user.role, action: 'homework.submit', outcome: 'denied' });
    throw new ForbiddenException('only parent');
  }
  const hw = store.homeworks.find((h) => h.id === hwId);
  if (!hw) throw new BadRequestException('not found');
  if (!user.ownChildren?.includes(hw.studentId)) {
    audit.log({ actorRole: 'parent', action: 'homework.submit', outcome: 'denied', meta: { reason: 'not own child' } });
    throw new ForbiddenException('parent only own child');
  }
  // imgSecCheck mock: imageUrl 包含 'evil' → 阻断
  const imgSecCheckOk = !body.imageUrl?.includes('evil');
  if (!imgSecCheckOk) {
    audit.log({ actorRole: 'parent', action: 'homework.imgsec-blocked', outcome: 'denied' });
    throw new BadRequestException('image blocked by imgSecCheck');
  }
  hw.submission = { content: body.content, imageUrl: body.imageUrl, imgSecCheckOk };
  hw.status = 'submitted';
  audit.log({ actorRole: 'parent', action: 'homework.submit', outcome: 'success' });
  return hw;
}

function gradeHomework(user: MockUser, hwId: string, grade: { comment: string; score?: number }, store: G5Store, audit: MockAuditLog): Homework {
  if (user.role !== 'teacher') throw new ForbiddenException('only teacher');
  const hw = store.homeworks.find((h) => h.id === hwId);
  if (!hw) throw new BadRequestException('not found');
  if (hw.teacherId !== user.sub) throw new ForbiddenException('not own homework');
  hw.grade = grade;
  hw.status = 'graded';
  audit.log({ actorRole: 'teacher', action: 'homework.grade', outcome: 'success' });
  return hw;
}

function createAssessment(user: MockUser, body: { studentId: string; dimensions: Record<string, number>; comment: string }, store: G5Store, audit: MockAuditLog): Assessment {
  if (user.role !== 'teacher') {
    audit.log({ actorRole: user.role, action: 'assessment.create', outcome: 'denied' });
    throw new ForbiddenException('only teacher');
  }
  const totalScore = Object.values(body.dimensions).reduce((a, b) => a + b, 0);
  const a: Assessment = {
    id: 'AS_' + Math.random().toString(36).slice(2, 8).toUpperCase(),
    studentId: body.studentId,
    teacherId: user.sub,
    dimensions: body.dimensions,
    totalScore,
    comment: body.comment,
  };
  store.assessments.push(a);
  // 同步进 learning_profile
  const lp = store.profiles.get(body.studentId) || { studentId: body.studentId, feedbackCount: 0, assessmentCount: 0, homeworkCount: 0, attendanceCount: 0 };
  lp.assessmentCount++;
  store.profiles.set(body.studentId, lp);
  audit.log({ actorRole: 'teacher', action: 'assessment.create', outcome: 'success', meta: { assessmentId: a.id, totalScore } });
  return a;
}

function viewAssessmentAsParent(user: MockUser, assessmentId: string, store: G5Store, audit: MockAuditLog): Assessment {
  const a = store.assessments.find((x) => x.id === assessmentId);
  if (!a) throw new BadRequestException('not found');
  if (user.role === 'parent') {
    if (!user.ownChildren?.includes(a.studentId)) {
      audit.log({ actorRole: 'parent', action: 'assessment.view', outcome: 'denied', meta: { reason: 'not own child' } });
      throw new ForbiddenException('not own child');
    }
  }
  audit.log({ actorRole: user.role, action: 'assessment.view', outcome: 'success' });
  return a;
}

function readLP(user: MockUser, studentId: string, store: G5Store, audit: MockAuditLog): LP {
  // SSOT: sales 看 lp 403
  if (user.role === 'sales') {
    audit.log({ actorRole: 'sales', action: 'learning-profile.read', outcome: 'denied' });
    throw new ForbiddenException('sales cannot read learning_profile');
  }
  if (user.role === 'parent' && !user.ownChildren?.includes(studentId)) {
    throw new ForbiddenException('not own child');
  }
  if (user.role === 'teacher' && !user.authorizedStudents?.includes(studentId)) {
    throw new ForbiddenException('not authorized');
  }
  const lp = store.profiles.get(studentId);
  if (!lp) throw new BadRequestException('not found');
  audit.log({ actorRole: user.role, action: 'learning-profile.read', outcome: 'success' });
  return lp;
}

// ---------- Test data ----------

const parent1: MockUser = { sub: 'PAR01', role: 'parent', ownChildren: ['STU_001'] };
const parent2: MockUser = { sub: 'PAR02', role: 'parent', ownChildren: ['STU_002'] };
const teacher1: MockUser = { sub: 'T_001', role: 'teacher', authorizedStudents: ['STU_001'] };
const teacher2: MockUser = { sub: 'T_002', role: 'teacher', authorizedStudents: ['STU_002'] };
const academic1: MockUser = { sub: 'ACAD01', role: 'academic' };
const admin1: MockUser = { sub: 'ADM01', role: 'admin' };
const boss1: MockUser = { sub: 'BOSS01', role: 'boss' };
const sales1: MockUser = { sub: 'SAL01', role: 'sales' };

// =========================================
// Tests
// =========================================

describe('[L8 业务流 G1] 教师评分 / 月度排行 (8 case)', () => {
  let store: RatingStore;
  let audit: MockAuditLog;

  beforeEach(() => {
    store = new RatingStore();
    audit = new MockAuditLog();
  });

  it('G1.1 parent 评分 1-5 星 → teacher_ratings + 触发 monthly_aggregates', () => {
    const result = rateTeacher(
      parent1,
      { scheduleId: 'SCH_001', teacherId: 'T_001', scheduleStudentId: 'STU_001', score: 5, idempotencyKey: 'K_001' },
      store,
      audit,
    );
    expect(result.created).toBe(true);
    expect(result.rating.score).toBe(5);
    expect(store.ratings).toHaveLength(1);

    const agg = aggregateRatings('T_001', '2026-05', store.ratings);
    expect(agg.count).toBe(1);
    expect(agg.avgScore).toBe(5);
    expect(agg.distribution['5']).toBe(1);
  });

  it('G1.2 parent 文字评价 → msgSecCheck → 入库', () => {
    const result = rateTeacher(
      parent1,
      { scheduleId: 'SCH_001', teacherId: 'T_001', scheduleStudentId: 'STU_001', score: 4, comment: '老师很认真', idempotencyKey: 'K_002' },
      store,
      audit,
    );
    expect(result.rating.comment).toBe('老师很认真');
    expect(result.rating.pendingReview).toBe(false);

    // risky → 阻断
    expect(() =>
      rateTeacher(
        parent1,
        { scheduleId: 'SCH_002', teacherId: 'T_001', scheduleStudentId: 'STU_001', score: 4, comment: '暴力辱骂', idempotencyKey: 'K_003' },
        store,
        audit,
      ),
    ).toThrow(BadRequestException);
    expect(audit.byAction('rating.msgsec-blocked')).toHaveLength(1);

    // timeout → pending review
    const r3 = rateTeacher(
      parent1,
      { scheduleId: 'SCH_003', teacherId: 'T_001', scheduleStudentId: 'STU_001', score: 3, comment: '__TIMEOUT__', idempotencyKey: 'K_004' },
      store,
      audit,
    );
    expect(r3.rating.pendingReview).toBe(true);
  });

  it('G1.3 老师月度评分聚合 (avg + count + 分布)', () => {
    rateTeacher(parent1, { scheduleId: 'S1', teacherId: 'T_001', scheduleStudentId: 'STU_001', score: 5, idempotencyKey: 'K1' }, store, audit);
    rateTeacher(parent1, { scheduleId: 'S2', teacherId: 'T_001', scheduleStudentId: 'STU_001', score: 4, idempotencyKey: 'K2' }, store, audit);
    rateTeacher(parent1, { scheduleId: 'S3', teacherId: 'T_001', scheduleStudentId: 'STU_001', score: 3, idempotencyKey: 'K3' }, store, audit);
    rateTeacher(parent2, { scheduleId: 'S4', teacherId: 'T_001', scheduleStudentId: 'STU_002', score: 5, idempotencyKey: 'K4' }, store, audit);

    const agg = aggregateRatings('T_001', '2026-05', store.ratings);
    expect(agg.count).toBe(4);
    expect(agg.avgScore).toBeCloseTo((5 + 4 + 3 + 5) / 4, 2);
    expect(agg.distribution['5']).toBe(2);
    expect(agg.distribution['4']).toBe(1);
    expect(agg.distribution['3']).toBe(1);
    expect(agg.distribution['1']).toBe(0);
  });

  it('G1.4 teacher 看自己评分 + 历史趋势 (只读)', () => {
    rateTeacher(parent1, { scheduleId: 'S1', teacherId: teacher1.sub, scheduleStudentId: 'STU_001', score: 5, idempotencyKey: 'K1' }, store, audit);
    const mine = teacherReadOwnRatingHistory(teacher1, teacher1.sub, store.ratings);
    expect(mine).toHaveLength(1);
    expect(mine[0].score).toBe(5);

    // 看别的老师 → 403
    expect(() => teacherReadOwnRatingHistory(teacher1, teacher2.sub, store.ratings)).toThrow(ForbiddenException);
  });

  it('G1.5 teacher 看月度排行榜 (自己 + 其他老师, 匿名 / 实名按 boss 配置)', () => {
    rateTeacher(parent1, { scheduleId: 'S1', teacherId: 'T_001', scheduleStudentId: 'STU_001', score: 5, idempotencyKey: 'K1' }, store, audit);
    rateTeacher(parent2, { scheduleId: 'S2', teacherId: 'T_002', scheduleStudentId: 'STU_002', score: 3, idempotencyKey: 'K2' }, store, audit);
    const aggs = [aggregateRatings('T_001', '2026-05', store.ratings), aggregateRatings('T_002', '2026-05', store.ratings)];

    // 匿名模式
    const anon = teacherReadMonthlyRanking(teacher1, '2026-05', aggs, { realName: false });
    expect(anon).toHaveLength(2);
    expect(anon.every((r) => r.teacherId === 'ANON')).toBe(true);
    expect(anon[0].avgScore).toBe(5); // 排第一
    expect(anon[1].avgScore).toBe(3);

    // 实名
    const real = teacherReadMonthlyRanking(teacher1, '2026-05', aggs, { realName: true });
    expect(real.map((r) => r.teacherId).sort()).toEqual(['T_001', 'T_002']);
  });

  it('G1.6 parent 评分非授课老师 → 403', () => {
    // schedule.studentId 不是 parent1 的孩子 → 403
    expect(() =>
      rateTeacher(
        parent1,
        { scheduleId: 'SCH_X', teacherId: 'T_001', scheduleStudentId: 'STU_999', score: 5, idempotencyKey: 'K_R6' },
        store,
        audit,
      ),
    ).toThrow(ForbiddenException);
    const denied = audit.byAction('rating.create').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].meta?.reason).toBe('not own child');
  });

  it('G1.7 parent 重复评分 → idempotency 防重', () => {
    const r1 = rateTeacher(parent1, { scheduleId: 'S1', teacherId: 'T_001', scheduleStudentId: 'STU_001', score: 5, idempotencyKey: 'K_DUP' }, store, audit);
    const r2 = rateTeacher(parent1, { scheduleId: 'S1', teacherId: 'T_001', scheduleStudentId: 'STU_001', score: 4, idempotencyKey: 'K_DUP' }, store, audit);
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(false);
    expect(r2.rating.id).toBe(r1.rating.id);
    expect(r2.rating.score).toBe(5); // 保持原值
    expect(audit.byAction('rating.idempotent-hit')).toHaveLength(1);
  });

  it('G1.8 teacher 看其他老师真实评分 → 403 (boss/admin 可见)', () => {
    rateTeacher(parent1, { scheduleId: 'S1', teacherId: 'T_001', scheduleStudentId: 'STU_001', score: 5, idempotencyKey: 'K1' }, store, audit);

    expect(() => readOtherTeacherDetailRatings(teacher1, store.ratings, audit)).toThrow(ForbiddenException);
    const denied = audit.byAction('rating.read-other-teacher').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].actorRole).toBe('teacher');

    // boss / admin OK
    const bossView = readOtherTeacherDetailRatings(boss1, store.ratings, audit);
    expect(bossView).toHaveLength(1);
  });
});

describe('[L8 业务流 G2] 学员请假 / 调课 (6 case, 任意时间)', () => {
  let store: ScheduleStore;
  let audit: MockAuditLog;

  beforeEach(() => {
    store = new ScheduleStore();
    audit = new MockAuditLog();
    store.schedules.push({ id: 'SCH_001', studentId: 'STU_001', hoursDeducted: 0, status: 'pending' });
  });

  it('G2.1 parent 任意时间提请假 (拍板 G2)', () => {
    const lv = createLeaveG2(parent1, 'SCH_001', store, audit);
    expect(lv.status).toBe('pending');
    expect(store.leaves).toHaveLength(1);
    expect(audit.byAction('leave.create').filter((e) => e.outcome === 'success')).toHaveLength(1);
  });

  it('G2.2 academic 审批通过 → leave_id set + 课时不扣', () => {
    const lv = createLeaveG2(parent1, 'SCH_001', store, audit);
    const r = decideLeave(academic1, lv.id, true, store, audit);
    expect(r.leave.status).toBe('approved');
    expect(r.schedule.leaveId).toBe(lv.id);
    expect(r.schedule.hoursDeducted).toBe(0);
  });

  it('G2.3 academic 审批拒绝 → 课正常 + 课时扣', () => {
    const lv = createLeaveG2(parent1, 'SCH_001', store, audit);
    const r = decideLeave(academic1, lv.id, false, store, audit);
    expect(r.leave.status).toBe('rejected');
    expect(r.schedule.leaveId).toBeUndefined();
    expect(r.schedule.hoursDeducted).toBe(1);
  });

  it('G2.4 academic 调课 (cancel + 新建) → 双向通知', () => {
    const r = rescheduleG2(academic1, 'SCH_001', store, audit);
    expect(r.cancelled.status).toBe('cancelled');
    expect(r.created.status).toBe('pending');
    expect(store.notifications).toHaveLength(2);
  });

  it('G2.5 sales 改 schedule → 403', () => {
    expect(() => updateScheduleG2(sales1, audit)).toThrow(ForbiddenException);
    const denied = audit.byAction('schedule.update').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].actorRole).toBe('sales');
  });

  it('G2.6 teacher 自主取消 → 403 (教务统一调度)', () => {
    expect(() => teacherSelfCancelG2(teacher1, audit)).toThrow(ForbiddenException);
    const denied = audit.byAction('schedule.cancel').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].meta?.reason).toBe('teacher cannot self-cancel');
  });
});

describe('[L8 业务流 G3] 课时包余额预警 (4 case, < 5 单阈值)', () => {
  let audit: MockAuditLog;
  let balances: Map<string, CoursePackageBalance>;

  beforeEach(() => {
    audit = new MockAuditLog();
    balances = new Map();
  });

  it('G3.1 course_packages_balance < 5 课时 → C 端 home 顶部 badge', () => {
    const result = checkBalanceAndNotify({ studentId: 'STU_001', remainingHours: 3 }, audit);
    expect(result.showHomeBadge).toBe(true);
    expect(audit.byAction('balance.low-alert')).toHaveLength(1);

    // 临界值 5 → 不告警
    const r2 = checkBalanceAndNotify({ studentId: 'STU_001', remainingHours: 5 }, audit);
    expect(r2.showHomeBadge).toBe(false);
    expect(audit.byAction('balance.low-alert')).toHaveLength(1); // 未新增

    // > 5 → 不告警
    const r3 = checkBalanceAndNotify({ studentId: 'STU_001', remainingHours: 10 }, audit);
    expect(r3.showHomeBadge).toBe(false);
  });

  it('G3.2 balance < 5 → push 推送家长「续费提醒」(拍板 G3 单阈值)', () => {
    const result = checkBalanceAndNotify({ studentId: 'STU_001', remainingHours: 2 }, audit);
    expect(result.pushNotify).toBe(true);
    expect(audit.byAction('balance.low-alert')).toHaveLength(1);
    expect(audit.byAction('balance.low-alert')[0].meta?.remaining).toBe(2);
  });

  it('G3.3 balance = 0 → 排课 API 拒绝 + 提示「请续费」', () => {
    expect(() => createScheduleG3({ studentId: 'STU_001', remainingHours: 0 }, audit)).toThrow(/renew/);
    const denied = audit.byAction('schedule.create').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].meta?.reason).toBe('no balance');
  });

  it('G3.4 续费后 balance 累加 + push 通知', () => {
    balances.set('STU_001', { studentId: 'STU_001', remainingHours: 3 });
    const updated = renewAndUpdateBalance('STU_001', 20, balances, audit);
    expect(updated.remainingHours).toBe(23); // 3 + 20
    expect(balances.get('STU_001')?.remainingHours).toBe(23);
    const renew = audit.byAction('balance.renew');
    expect(renew).toHaveLength(1);
    expect(renew[0].meta?.notifyParent).toBe(true);
  });
});

describe('[L8 业务流 G4] 学员推荐 / 转介绍 (5 case, 课时奖励)', () => {
  let store: ReferralStore;
  let audit: MockAuditLog;

  beforeEach(() => {
    store = new ReferralStore();
    audit = new MockAuditLog();
  });

  it('G4.1 parent 在 C 端生成专属推荐码 → parent_referrals.code', () => {
    const r = generateReferralCode('PAR_OLD', store, audit);
    expect(r.code).toMatch(/^REF_/);
    expect(r.parentSub).toBe('PAR_OLD');
    expect(audit.byAction('referral.generate')).toHaveLength(1);

    // 重新生成 → 返回同一个
    const r2 = generateReferralCode('PAR_OLD', store, audit);
    expect(r2.code).toBe(r.code);
  });

  it('G4.2 新 parent 注册时填推荐码 → 关联 referred_by', () => {
    store.parentPhones.set('PAR_OLD', '13800000000');
    generateReferralCode('PAR_OLD', store, audit);
    const ref = store.referrals.get(Array.from(store.referrals.keys())[0])!;

    const reg = registerParentG4('13800000001', ref.code, store, audit);
    expect(reg.referredBy).toBe(ref.code);
    expect(store.registrations).toHaveLength(1);
  });

  it('G4.3 新 parent 完成首次签约 → 老 parent 课时奖励 (自动到课时包, 拍板 G4)', () => {
    store.parentPhones.set('PAR_OLD', '13800000000');
    generateReferralCode('PAR_OLD', store, audit);
    const ref = store.referrals.get(Array.from(store.referrals.keys())[0])!;
    const reg = registerParentG4('13800000001', ref.code, store, audit);

    onFirstSign(reg.parentSub, store, audit, 5);

    expect(store.rewards).toHaveLength(1);
    expect(store.rewards[0]).toEqual({ parentSub: 'PAR_OLD', hours: 5 });
    expect(ref.uses).toBe(1);
    expect(audit.byAction('referral.reward')).toHaveLength(1);
  });

  it('G4.4 admin 看推荐排行', () => {
    store.parentPhones.set('PAR_A', '13800000000');
    store.parentPhones.set('PAR_B', '13800000001');
    generateReferralCode('PAR_A', store, audit);
    generateReferralCode('PAR_B', store, audit);
    const refA = store.referrals.get(Array.from(store.referrals.keys())[0])!;
    const refB = store.referrals.get(Array.from(store.referrals.keys())[1])!;
    refA.uses = 5;
    refB.uses = 2;

    const ranking = adminViewReferralRanking(admin1, store);
    expect(ranking).toHaveLength(2);
    expect(ranking[0].uses).toBe(5);
    expect(ranking[1].uses).toBe(2);

    // sales / parent 看 → 403
    expect(() => adminViewReferralRanking(sales1, store)).toThrow(ForbiddenException);
    expect(() => adminViewReferralRanking(parent1, store)).toThrow(ForbiddenException);
  });

  it('G4.5 parent 推荐自己 (手机号已存在) → 拒绝', () => {
    store.parentPhones.set('PAR_SELF', '13800000000');
    generateReferralCode('PAR_SELF', store, audit);
    const ref = store.referrals.get(Array.from(store.referrals.keys())[0])!;

    // 用同一个手机号再注册 + 填自己推荐码 → 拒绝
    expect(() => registerParentG4('13800000000', ref.code, store, audit)).toThrow(BadRequestException);
    const denied = audit.byAction('referral.self-referral').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(store.registrations).toHaveLength(0); // 没注册
  });
});

describe('[L8 业务流 G5] 作业 / 评测 / 学情档案 (15 case)', () => {
  let store: G5Store;
  let audit: MockAuditLog;

  beforeEach(() => {
    store = new G5Store();
    audit = new MockAuditLog();
  });

  // ----- 作业 5 case -----
  it('G5.1 teacher 课后布置 homework → msgSecCheck → DB', () => {
    const hw = createHomework(teacher1, { studentId: 'STU_001', content: '完成数学习题第 1-10 题' }, store, audit);
    expect(hw.id).toBeTruthy();
    expect(hw.status).toBe('pending');
    expect(hw.pendingReview).toBe(false);
    expect(store.homeworks).toHaveLength(1);

    // sales 不能 → 403
    expect(() => createHomework(sales1, { studentId: 'STU_001', content: 'x' }, store, audit)).toThrow(ForbiddenException);

    // risky → 阻断
    expect(() => createHomework(teacher1, { studentId: 'STU_001', content: '暴力威胁' }, store, audit)).toThrow(BadRequestException);
    expect(audit.byAction('homework.msgsec-blocked')).toHaveLength(1);

    // timeout → pendingReview
    const hw2 = createHomework(teacher1, { studentId: 'STU_001', content: '__TIMEOUT__' }, store, audit);
    expect(hw2.pendingReview).toBe(true);
  });

  it('G5.2 parent 看作业列表 + 状态 pending', () => {
    createHomework(teacher1, { studentId: 'STU_001', content: 'HW1' }, store, audit);
    createHomework(teacher1, { studentId: 'STU_001', content: 'HW2' }, store, audit);
    createHomework(teacher2, { studentId: 'STU_002', content: 'HW3' }, store, audit);

    const myHws = listHomeworksByParent(parent1.sub, parent1.ownChildren!, store);
    expect(myHws).toHaveLength(2);
    expect(myHws.every((h) => h.status === 'pending')).toBe(true);
    // 别孩子的 HW3 不在内
    expect(myHws.every((h) => h.studentId === 'STU_001')).toBe(true);
  });

  it('G5.3 parent 提交完成 (含图 → wx.security.imgSecCheck) → 状态 submitted', () => {
    const hw = createHomework(teacher1, { studentId: 'STU_001', content: 'HW1' }, store, audit);

    // 提交 OK
    const submitted = submitHomework(parent1, hw.id, { content: '完成', imageUrl: 'https://example.com/hw.jpg' }, store, audit);
    expect(submitted.status).toBe('submitted');
    expect(submitted.submission?.imgSecCheckOk).toBe(true);

    // 提交带 evil 图 → 阻断
    const hw2 = createHomework(teacher1, { studentId: 'STU_001', content: 'HW2' }, store, audit);
    expect(() =>
      submitHomework(parent1, hw2.id, { content: '完成', imageUrl: 'https://evil.com/x.jpg' }, store, audit),
    ).toThrow(BadRequestException);
    expect(audit.byAction('homework.imgsec-blocked')).toHaveLength(1);
  });

  it('G5.4 teacher 批改 → 评语 + 状态 graded', () => {
    const hw = createHomework(teacher1, { studentId: 'STU_001', content: 'HW1' }, store, audit);
    submitHomework(parent1, hw.id, { content: '完成' }, store, audit);
    const graded = gradeHomework(teacher1, hw.id, { comment: '不错', score: 90 }, store, audit);
    expect(graded.status).toBe('graded');
    expect(graded.grade?.comment).toBe('不错');
    expect(graded.grade?.score).toBe(90);

    // 别 teacher 不能改
    expect(() => gradeHomework(teacher2, hw.id, { comment: 'x' }, store, audit)).toThrow(ForbiddenException);
  });

  it('G5.5 parent 提交非自己孩子作业 → 403', () => {
    const hw = createHomework(teacher2, { studentId: 'STU_002', content: 'HW_OTHER' }, store, audit);
    expect(() => submitHomework(parent1, hw.id, { content: '别孩子' }, store, audit)).toThrow(ForbiddenException);
    const denied = audit.byAction('homework.submit').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].meta?.reason).toBe('not own child');
  });

  // ----- 评测 5 case -----
  it('G5.6 teacher 创建 assessment → DB', () => {
    const a = createAssessment(
      teacher1,
      { studentId: 'STU_001', dimensions: { 听力: 85, 阅读: 90 }, comment: '进步明显' },
      store,
      audit,
    );
    expect(a.id).toBeTruthy();
    expect(a.totalScore).toBe(175);
    expect(store.assessments).toHaveLength(1);
    // sales 不能
    expect(() => createAssessment(sales1, { studentId: 'STU_001', dimensions: {}, comment: 'x' }, store, audit)).toThrow(ForbiddenException);
  });

  it('G5.7 teacher 给学员评分 (每维度 + 总分 + 评语)', () => {
    const a = createAssessment(
      teacher1,
      { studentId: 'STU_001', dimensions: { listening: 85, reading: 90, speaking: 80, writing: 88 }, comment: '稳步提升' },
      store,
      audit,
    );
    expect(a.dimensions.listening).toBe(85);
    expect(a.dimensions.reading).toBe(90);
    expect(a.totalScore).toBe(343);
    expect(a.comment).toBe('稳步提升');
  });

  it('G5.8 parent 看评测结果', () => {
    const a = createAssessment(teacher1, { studentId: 'STU_001', dimensions: { x: 80 }, comment: 'OK' }, store, audit);
    const viewed = viewAssessmentAsParent(parent1, a.id, store, audit);
    expect(viewed.id).toBe(a.id);
  });

  it('G5.9 评测自动汇入 learning_profile', () => {
    expect(store.profiles.get('STU_001')).toBeUndefined();
    createAssessment(teacher1, { studentId: 'STU_001', dimensions: { x: 80 }, comment: 'a' }, store, audit);
    expect(store.profiles.get('STU_001')?.assessmentCount).toBe(1);
    // 再创建一个 → 累加
    createAssessment(teacher1, { studentId: 'STU_001', dimensions: { y: 90 }, comment: 'b' }, store, audit);
    expect(store.profiles.get('STU_001')?.assessmentCount).toBe(2);
  });

  it('G5.10 parent 看其他学员评测 → 403', () => {
    const a = createAssessment(teacher2, { studentId: 'STU_002', dimensions: { x: 80 }, comment: 'OK' }, store, audit);
    expect(() => viewAssessmentAsParent(parent1, a.id, store, audit)).toThrow(ForbiddenException);
    const denied = audit.byAction('assessment.view').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].meta?.reason).toBe('not own child');
  });

  // ----- 学情档案 5 case -----
  it('G5.11 learning_profile 聚合 feedback + assessment + homework + 出勤', () => {
    store.profiles.set('STU_001', { studentId: 'STU_001', feedbackCount: 3, assessmentCount: 2, homeworkCount: 5, attendanceCount: 10 });
    const lp = readLP(admin1, 'STU_001', store, audit);
    expect(lp.feedbackCount).toBe(3);
    expect(lp.assessmentCount).toBe(2);
    expect(lp.homeworkCount).toBe(5);
    expect(lp.attendanceCount).toBe(10);
  });

  it('G5.12 parent 看自己孩子学情档案', () => {
    store.profiles.set('STU_001', { studentId: 'STU_001', feedbackCount: 1, assessmentCount: 1, homeworkCount: 1, attendanceCount: 1 });
    const lp = readLP(parent1, 'STU_001', store, audit);
    expect(lp.studentId).toBe('STU_001');
    expect(audit.byAction('learning-profile.read').filter((e) => e.outcome === 'success')).toHaveLength(1);
  });

  it('G5.13 teacher 看自己授课学员学情档案', () => {
    store.profiles.set('STU_001', { studentId: 'STU_001', feedbackCount: 0, assessmentCount: 0, homeworkCount: 0, attendanceCount: 0 });
    const lp = readLP(teacher1, 'STU_001', store, audit);
    expect(lp.studentId).toBe('STU_001');

    // teacher 看非授课 → 403
    expect(() => readLP(teacher1, 'STU_999', store, audit)).toThrow(ForbiddenException);
  });

  it('G5.14 academic / boss 看所有学员学情档案', () => {
    store.profiles.set('STU_001', { studentId: 'STU_001', feedbackCount: 1, assessmentCount: 1, homeworkCount: 1, attendanceCount: 1 });
    store.profiles.set('STU_002', { studentId: 'STU_002', feedbackCount: 2, assessmentCount: 2, homeworkCount: 2, attendanceCount: 2 });

    const academicView1 = readLP(academic1, 'STU_001', store, audit);
    const academicView2 = readLP(academic1, 'STU_002', store, audit);
    const bossView = readLP(boss1, 'STU_002', store, audit);

    expect(academicView1.studentId).toBe('STU_001');
    expect(academicView2.studentId).toBe('STU_002');
    expect(bossView.studentId).toBe('STU_002');
    expect(audit.byAction('learning-profile.read').filter((e) => e.outcome === 'success')).toHaveLength(3);
  });

  it('G5.15 sales 看学情档案 → 403', () => {
    store.profiles.set('STU_001', { studentId: 'STU_001', feedbackCount: 0, assessmentCount: 0, homeworkCount: 0, attendanceCount: 0 });
    expect(() => readLP(sales1, 'STU_001', store, audit)).toThrow(ForbiddenException);
    const denied = audit.byAction('learning-profile.read').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].actorRole).toBe('sales');
  });
});
