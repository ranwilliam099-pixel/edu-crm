/**
 * L8 业务流 D2 — 学情档案 + 月报 (11 case)
 *
 * 来源:
 *   - v2.0 §5.D2 学情档案 + 月报
 *   - SSOT §4.1 学习表现 / §6 learning_profile.read / monthly_report.read
 *   - 拍板: 教务全只读 → sales 看 learning_profile = 403
 *   - 拍板: parent 看自己孩子, teacher 看授课, academic/boss 看所有
 *
 * 验证:
 *   - learning_profile 聚合 (feedback + assessment + homework + 出勤)
 *   - parent / teacher / academic / boss role 查询路径
 *   - sales 看 learning_profile → 403
 *   - monthly_report 自动聚合
 *   - audience=parent / boss 双视角
 *   - parent 月报评论 msgSecCheck
 *   - parent 评别孩子月报 → 403
 *   - boss showcase 标杆案例
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
  tenantId: string;
  // teacher 授课学员; parent 自己孩子
  authorizedStudents?: string[];
}

interface LearningProfile {
  studentId: string;
  feedbackCount: number;
  assessmentCount: number;
  homeworkCount: number;
  attendanceCount: number;
  lastUpdated: Date;
}

interface MonthlyReport {
  id: string;
  studentId: string;
  audience: 'parent' | 'boss';
  yearMonth: string; // 2026-05
  summary: string;
  teacherView?: boolean;
  showcaseMeta?: { showcase: boolean; reason?: string };
}

interface MonthlyComment {
  id: string;
  reportId: string;
  parentSub: string;
  content: string;
  pendingReview: boolean;
}

class MockStore {
  profiles: Map<string, LearningProfile> = new Map();
  reports: MonthlyReport[] = [];
  comments: MonthlyComment[] = [];
  students: Map<string, { tenantId: string; assignedTeacherId: string; parentSubs: string[] }> = new Map();
}

function aggregateLearningProfile(
  studentId: string,
  feedback: number,
  assessment: number,
  homework: number,
  attendance: number,
  store: MockStore,
  now: Date,
): LearningProfile {
  const lp: LearningProfile = {
    studentId,
    feedbackCount: feedback,
    assessmentCount: assessment,
    homeworkCount: homework,
    attendanceCount: attendance,
    lastUpdated: now,
  };
  store.profiles.set(studentId, lp);
  return lp;
}

function readLearningProfile(
  user: MockUser,
  studentId: string,
  store: MockStore,
  audit: MockAuditLog,
): LearningProfile {
  // SSOT §6 learning_profile.read 允许: parent (自己孩子), teacher (授课), academic/admin/boss (全)
  // sales 不在允许集合 → 403 (拍板教务全只读)
  if (user.role === 'sales') {
    audit.log({ actorRole: 'sales', action: 'learning-profile.read', outcome: 'denied', meta: { reason: 'sales not allowed' } });
    throw new ForbiddenException('sales cannot view learning_profile');
  }

  if (user.role === 'parent') {
    if (!user.authorizedStudents?.includes(studentId)) {
      audit.log({ actorRole: 'parent', action: 'learning-profile.read', outcome: 'denied', meta: { reason: 'not own child' } });
      throw new ForbiddenException('parent can only view own children profile');
    }
  }

  if (user.role === 'teacher') {
    if (!user.authorizedStudents?.includes(studentId)) {
      audit.log({ actorRole: 'teacher', action: 'learning-profile.read', outcome: 'denied', meta: { reason: 'not authorized' } });
      throw new ForbiddenException('teacher can only view authorized students');
    }
  }

  // admin/boss/academic 全可
  const lp = store.profiles.get(studentId);
  if (!lp) throw new BadRequestException('profile not found');
  audit.log({ actorRole: user.role, action: 'learning-profile.read', outcome: 'success', meta: { studentId } });
  return lp;
}

function autoAggregateMonthly(studentId: string, audience: MonthlyReport['audience'], store: MockStore): MonthlyReport {
  const lp = store.profiles.get(studentId);
  const summary = lp
    ? `feedback=${lp.feedbackCount} assessment=${lp.assessmentCount} homework=${lp.homeworkCount} attendance=${lp.attendanceCount}`
    : 'no data';
  const report: MonthlyReport = {
    id: 'MR_' + Math.random().toString(36).slice(2, 8).toUpperCase(),
    studentId,
    audience,
    yearMonth: '2026-05',
    summary,
    teacherView: audience === 'boss', // boss 视角含老师维度
  };
  store.reports.push(report);
  return report;
}

function readMonthlyReport(
  user: MockUser,
  reportId: string,
  store: MockStore,
  audit: MockAuditLog,
): MonthlyReport {
  const report = store.reports.find((r) => r.id === reportId);
  if (!report) throw new BadRequestException('report not found');

  // parent 必须是 student 的 parent
  if (user.role === 'parent') {
    const meta = store.students.get(report.studentId);
    if (!meta || !meta.parentSubs.includes(user.sub)) {
      audit.log({ actorRole: 'parent', action: 'monthly-report.read', outcome: 'denied', meta: { reason: 'not own child' } });
      throw new ForbiddenException('parent can only read own child report');
    }
    if (report.audience !== 'parent') {
      audit.log({ actorRole: 'parent', action: 'monthly-report.read', outcome: 'denied', meta: { reason: 'audience mismatch' } });
      throw new ForbiddenException('parent can only read parent-audience reports');
    }
  }
  // boss 看 boss-audience (含老师视角) — teacherView 已在 autoAggregateMonthly 时 set
  // (此处不重新 assert, assertion 留给 test it block)

  audit.log({ actorRole: user.role, action: 'monthly-report.read', outcome: 'success', meta: { reportId } });
  return report;
}

type MsgSecResult = 'ok' | 'risky' | 'timeout';
function mockMsgSec(content: string): MsgSecResult {
  if (content.includes('暴力')) return 'risky';
  if (content === '__TIMEOUT__') return 'timeout';
  return 'ok';
}

function parentCommentMonthly(
  user: MockUser,
  reportId: string,
  content: string,
  store: MockStore,
  audit: MockAuditLog,
): MonthlyComment {
  if (user.role !== 'parent') {
    audit.log({ actorRole: user.role, action: 'monthly-report.comment', outcome: 'denied', meta: { reason: 'role not parent' } });
    throw new ForbiddenException('only parent can comment');
  }
  const report = store.reports.find((r) => r.id === reportId);
  if (!report) throw new BadRequestException('report not found');
  const meta = store.students.get(report.studentId);
  if (!meta || !meta.parentSubs.includes(user.sub)) {
    audit.log({ actorRole: 'parent', action: 'monthly-report.comment', outcome: 'denied', meta: { reason: 'not own child' } });
    throw new ForbiddenException('parent cannot comment on other children report');
  }
  const result = mockMsgSec(content);
  if (result === 'risky') {
    audit.log({ actorRole: 'parent', action: 'monthly-report.comment-blocked', outcome: 'denied', meta: { field: 'content' } });
    throw new BadRequestException('comment blocked by msgSecCheck');
  }
  const pendingReview = result === 'timeout';
  if (pendingReview) {
    audit.log({ actorRole: 'parent', action: 'monthly-report.comment-pending-review', outcome: 'success' });
  }
  const comment: MonthlyComment = {
    id: 'MC_' + Math.random().toString(36).slice(2, 8).toUpperCase(),
    reportId,
    parentSub: user.sub,
    content,
    pendingReview,
  };
  store.comments.push(comment);
  audit.log({ actorRole: 'parent', action: 'monthly-report.comment', outcome: 'success', meta: { commentId: comment.id } });
  return comment;
}

function bossShowcase(
  user: MockUser,
  reportId: string,
  reason: string,
  store: MockStore,
  audit: MockAuditLog,
): MonthlyReport {
  if (!['boss', 'admin'].includes(user.role)) {
    audit.log({ actorRole: user.role, action: 'monthly-report.showcase', outcome: 'denied' });
    throw new ForbiddenException('only boss/admin can showcase');
  }
  const report = store.reports.find((r) => r.id === reportId);
  if (!report) throw new BadRequestException('report not found');
  report.showcaseMeta = { showcase: true, reason };
  audit.log({ actorRole: user.role, action: 'monthly-report.showcase', outcome: 'success', meta: { reportId } });
  return report;
}

// ---------- Test data ----------

const STU_PARENT_1 = 'STU_OWN';
const STU_OTHER = 'STU_OTHER';

const parent1: MockUser = { sub: 'PAR01', role: 'parent', tenantId: 'TNT01', authorizedStudents: [STU_PARENT_1] };
const parent2: MockUser = { sub: 'PAR02', role: 'parent', tenantId: 'TNT01', authorizedStudents: [STU_OTHER] };
const teacher1: MockUser = { sub: 'T_001', role: 'teacher', tenantId: 'TNT01', authorizedStudents: [STU_PARENT_1] };
const teacherOther: MockUser = { sub: 'T_OTHER', role: 'teacher', tenantId: 'TNT01', authorizedStudents: ['STU_FAR'] };
const academic1: MockUser = { sub: 'ACAD01', role: 'academic', tenantId: 'TNT01' };
const boss1: MockUser = { sub: 'BOSS01', role: 'boss', tenantId: 'TNT01' };
const sales1: MockUser = { sub: 'SAL01', role: 'sales', tenantId: 'TNT01' };

function makeStore(): MockStore {
  const s = new MockStore();
  s.students.set(STU_PARENT_1, { tenantId: 'TNT01', assignedTeacherId: teacher1.sub, parentSubs: [parent1.sub] });
  s.students.set(STU_OTHER, { tenantId: 'TNT01', assignedTeacherId: 'T_OTHER', parentSubs: [parent2.sub] });
  return s;
}

const now = new Date('2026-05-19T10:00:00Z');

describe('[L8 业务流 D2] 学情档案 + 月报 (11 case)', () => {
  let store: MockStore;
  let audit: MockAuditLog;

  beforeEach(() => {
    store = makeStore();
    audit = new MockAuditLog();
  });

  it('D2.1 learning_profile 聚合 feedback + assessment + homework + 出勤', () => {
    const lp = aggregateLearningProfile(STU_PARENT_1, 5, 3, 7, 10, store, now);
    expect(lp.feedbackCount).toBe(5);
    expect(lp.assessmentCount).toBe(3);
    expect(lp.homeworkCount).toBe(7);
    expect(lp.attendanceCount).toBe(10);
    expect(lp.lastUpdated).toEqual(now);
    expect(store.profiles.get(STU_PARENT_1)).toEqual(lp);
  });

  it('D2.2 parent 看自己孩子 learning_profile → 通过', () => {
    aggregateLearningProfile(STU_PARENT_1, 5, 3, 7, 10, store, now);
    const lp = readLearningProfile(parent1, STU_PARENT_1, store, audit);
    expect(lp.studentId).toBe(STU_PARENT_1);
    expect(audit.byAction('learning-profile.read').filter((e) => e.outcome === 'success')).toHaveLength(1);
  });

  it('D2.3 teacher 看自己授课学员 learning_profile → 通过 (非授课 → 403)', () => {
    aggregateLearningProfile(STU_PARENT_1, 5, 3, 7, 10, store, now);
    // teacher1 is authorized for STU_PARENT_1
    const lp = readLearningProfile(teacher1, STU_PARENT_1, store, audit);
    expect(lp.studentId).toBe(STU_PARENT_1);

    // teacherOther 不授课 STU_PARENT_1 → 403
    expect(() => readLearningProfile(teacherOther, STU_PARENT_1, store, audit)).toThrow(ForbiddenException);
    const denied = audit.byAction('learning-profile.read').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].meta?.reason).toBe('not authorized');
  });

  it('D2.4 academic / boss 看所有学员 learning_profile → 通过 (无授权限制)', () => {
    aggregateLearningProfile(STU_PARENT_1, 5, 3, 7, 10, store, now);
    aggregateLearningProfile(STU_OTHER, 2, 1, 3, 4, store, now);

    const lp1 = readLearningProfile(academic1, STU_PARENT_1, store, audit);
    expect(lp1.studentId).toBe(STU_PARENT_1);
    const lp2 = readLearningProfile(boss1, STU_OTHER, store, audit);
    expect(lp2.studentId).toBe(STU_OTHER);

    expect(audit.byAction('learning-profile.read').filter((e) => e.outcome === 'success')).toHaveLength(2);
  });

  it('D2.5 sales 看 learning_profile → 403 (教务全只读边界)', () => {
    aggregateLearningProfile(STU_PARENT_1, 5, 3, 7, 10, store, now);
    expect(() => readLearningProfile(sales1, STU_PARENT_1, store, audit)).toThrow(ForbiddenException);
    const denied = audit.byAction('learning-profile.read').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].actorRole).toBe('sales');
    expect(denied[0].meta?.reason).toBe('sales not allowed');
  });

  it('D2.6 monthly_report 自动聚合 feedback / assessment / consumption', () => {
    aggregateLearningProfile(STU_PARENT_1, 5, 3, 7, 10, store, now);
    const report = autoAggregateMonthly(STU_PARENT_1, 'parent', store);
    expect(report.summary).toContain('feedback=5');
    expect(report.summary).toContain('assessment=3');
    expect(report.audience).toBe('parent');
    expect(store.reports).toHaveLength(1);
  });

  it('D2.7 monthly_report audience=parent → parent 看自己孩子部分', () => {
    aggregateLearningProfile(STU_PARENT_1, 5, 3, 7, 10, store, now);
    const r = autoAggregateMonthly(STU_PARENT_1, 'parent', store);
    const read = readMonthlyReport(parent1, r.id, store, audit);
    expect(read.audience).toBe('parent');
    expect(read.teacherView).toBeFalsy();

    // parent2 看 STU_PARENT_1 报告 → 403 (不是自己孩子)
    expect(() => readMonthlyReport(parent2, r.id, store, audit)).toThrow(ForbiddenException);
  });

  it('D2.8 monthly_report audience=boss → 看老师 + 学员双视角', () => {
    aggregateLearningProfile(STU_PARENT_1, 5, 3, 7, 10, store, now);
    const r = autoAggregateMonthly(STU_PARENT_1, 'boss', store);
    expect(r.audience).toBe('boss');
    expect(r.teacherView).toBe(true); // 含老师维度

    const read = readMonthlyReport(boss1, r.id, store, audit);
    expect(read.teacherView).toBe(true);
  });

  it('D2.9 parent 月报评论 (C 端) → msgSecCheck → DB', () => {
    aggregateLearningProfile(STU_PARENT_1, 5, 3, 7, 10, store, now);
    const r = autoAggregateMonthly(STU_PARENT_1, 'parent', store);
    const comment = parentCommentMonthly(parent1, r.id, '感谢老师辛苦付出', store, audit);
    expect(comment.id).toBeTruthy();
    expect(comment.pendingReview).toBe(false);
    expect(store.comments).toHaveLength(1);
    expect(audit.byAction('monthly-report.comment').filter((e) => e.outcome === 'success')).toHaveLength(1);

    // risky 内容 → 阻断
    expect(() => parentCommentMonthly(parent1, r.id, '暴力威胁', store, audit)).toThrow(BadRequestException);
    expect(audit.byAction('monthly-report.comment-blocked')).toHaveLength(1);

    // timeout → fail-open pending review
    const c2 = parentCommentMonthly(parent1, r.id, '__TIMEOUT__', store, audit);
    expect(c2.pendingReview).toBe(true);
    expect(audit.byAction('monthly-report.comment-pending-review')).toHaveLength(1);
  });

  it('D2.10 parent 评论别孩子月报 → 403', () => {
    aggregateLearningProfile(STU_PARENT_1, 5, 3, 7, 10, store, now);
    const r = autoAggregateMonthly(STU_PARENT_1, 'parent', store);
    expect(() => parentCommentMonthly(parent2, r.id, '看别孩子', store, audit)).toThrow(ForbiddenException);
    const denied = audit.byAction('monthly-report.comment').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].meta?.reason).toBe('not own child');
    expect(store.comments).toHaveLength(0);
  });

  it('D2.11 boss showcase 月报 → 标杆案例 (meta + summary)', () => {
    aggregateLearningProfile(STU_PARENT_1, 8, 5, 10, 12, store, now);
    const r = autoAggregateMonthly(STU_PARENT_1, 'boss', store);
    const showcased = bossShowcase(boss1, r.id, '本月最佳进步学员', store, audit);
    expect(showcased.showcaseMeta?.showcase).toBe(true);
    expect(showcased.showcaseMeta?.reason).toBe('本月最佳进步学员');
    expect(audit.byAction('monthly-report.showcase').filter((e) => e.outcome === 'success')).toHaveLength(1);

    // sales 不能 showcase
    expect(() => bossShowcase(sales1, r.id, '抢功', store, audit)).toThrow(ForbiddenException);
  });
});
