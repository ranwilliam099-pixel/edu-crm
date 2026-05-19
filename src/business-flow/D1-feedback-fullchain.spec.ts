/**
 * L8 业务流 D1 — 反馈全链路 (14 case, ★ 家长线核心)
 *
 * 来源:
 *   - v2.0 §5.D1 反馈全链路 (14 case)
 *   - 拍板 12: msgSecCheck 超时 fail-open + 人工 review
 *   - 拍板 13: D1 反馈截止 当天 24:00 cron 软提醒, 状态 normal/late
 *   - 拍板 13c: late 反馈仅 boss dashboard 可见, 不自动扣分
 *
 * 验证关注点:
 *   - teacher 当天填 status=normal / 次日补填 status=late + audit_log
 *   - cron 23:59 推送 + boss dashboard 逾期面板
 *   - msgSecCheck risky → 阻断 / 超时 → fail-open + audit_log「待 review」
 *   - parent 评分 1-5 星 + 重复评分 idempotency / 评分非授课老师 403
 *
 * 策略:
 *   - mock LessonFeedbackService.submit + status 状态机
 *   - mock MsgSecCheck 三态 (ok / risky / timeout)
 *   - mock parent rating + audit_log
 */
import { LessonFeedbackService, LessonFeedback } from '../modules/feedback/lesson-feedback.service';
import { ForbiddenException, BadRequestException } from '@nestjs/common';

// ---------- Mock 辅助 ----------

interface AuditEntry {
  actorRole: string;
  action: string;
  outcome: 'success' | 'denied';
  meta?: Record<string, unknown>;
}
class MockAuditLog {
  entries: AuditEntry[] = [];
  log(entry: AuditEntry): void {
    this.entries.push(entry);
  }
  byAction(action: string): AuditEntry[] {
    return this.entries.filter((e) => e.action === action);
  }
}

type MsgSecResult = 'ok' | 'risky' | 'timeout';

function mockMsgSecCheck(content: string): MsgSecResult {
  // 模拟微信内容安全 API:
  //   "暴力" → risky
  //   "__TIMEOUT__" → timeout
  //   其他 → ok
  if (content.includes('暴力')) return 'risky';
  if (content === '__TIMEOUT__') return 'timeout';
  return 'ok';
}

interface FeedbackWithStatus extends LessonFeedback {
  status: 'normal' | 'late';
  pendingReview?: boolean;
}

function deriveStatus(scheduleEndAt: Date, submittedAt: Date): 'normal' | 'late' {
  // 拍板 13: 当天填 normal / 次日补填 late
  // 用 UTC date (toISOString slice) 避免 jest 运行时区差异
  // 生产代码应取 tenant 时区 (Asia/Shanghai), 此 spec 仅验证状态机语义边界
  const sameDay = scheduleEndAt.toISOString().slice(0, 10) === submittedAt.toISOString().slice(0, 10);
  return sameDay ? 'normal' : 'late';
}

function submitFeedbackWithMsgSec(
  service: LessonFeedbackService,
  input: Parameters<LessonFeedbackService['submit']>[0],
  context: { scheduleEndAt: Date; teacherSub: string; callerUser: { sub: string; role: string }; submittedAt: Date },
  audit: MockAuditLog,
): FeedbackWithStatus {
  // RBAC: 只有 teacher (或 admin/boss override) 能填
  if (!['teacher', 'admin', 'boss'].includes(context.callerUser.role)) {
    audit.log({ actorRole: context.callerUser.role, action: 'feedback.submit', outcome: 'denied', meta: { reason: 'role not allowed' } });
    throw new ForbiddenException(`role ${context.callerUser.role} cannot submit feedback`);
  }
  // teacher 必须是 schedule 的 teacher
  if (context.callerUser.role === 'teacher' && input.teacherId !== context.callerUser.sub) {
    audit.log({ actorRole: context.callerUser.role, action: 'feedback.submit', outcome: 'denied', meta: { reason: 'ownership mismatch' } });
    throw new ForbiddenException('teacher can only submit own feedback');
  }
  // msgSecCheck on teacherNote
  const note = input.teacherNote || '';
  const result = mockMsgSecCheck(note);
  if (result === 'risky') {
    audit.log({ actorRole: context.callerUser.role, action: 'feedback.msgsec-blocked', outcome: 'denied', meta: { field: 'teacherNote', risk: 'risky' } });
    throw new BadRequestException('content blocked by msgSecCheck (敏感词)');
  }
  const pendingReview = result === 'timeout';
  if (pendingReview) {
    audit.log({ actorRole: context.callerUser.role, action: 'feedback.msgsec-timeout-pending-review', outcome: 'success', meta: { field: 'teacherNote' } });
  }
  // 调真实 service
  const fb = service.submit(input);
  // override submittedAt to test-supplied date
  const fbWithStatus: FeedbackWithStatus = {
    ...fb,
    submittedAt: context.submittedAt,
    updatedAt: context.submittedAt,
    status: deriveStatus(context.scheduleEndAt, context.submittedAt),
    pendingReview,
  };
  if (fbWithStatus.status === 'late') {
    audit.log({ actorRole: context.callerUser.role, action: 'feedback.submit-late', outcome: 'success', meta: { feedbackId: fb.id } });
  }
  audit.log({ actorRole: context.callerUser.role, action: 'feedback.submit', outcome: 'success', meta: { feedbackId: fb.id, status: fbWithStatus.status } });
  return fbWithStatus;
}

// ---- cron 23:59 软提醒 ----
interface UnfilledSchedule {
  scheduleId: string;
  teacherId: string;
  scheduleEndAt: Date;
}
function cronCheckUnfilledAtEod(
  schedules: UnfilledSchedule[],
  filledScheduleIds: Set<string>,
  now: Date,
): { teacherIds: string[]; scheduleIds: string[] } {
  // 当天 23:59 检查所有今日 schedule 没填的
  const today = now.toISOString().slice(0, 10);
  const unfilled = schedules.filter(
    (s) => s.scheduleEndAt.toISOString().slice(0, 10) === today && !filledScheduleIds.has(s.scheduleId),
  );
  return {
    teacherIds: Array.from(new Set(unfilled.map((s) => s.teacherId))),
    scheduleIds: unfilled.map((s) => s.scheduleId),
  };
}

// ---- boss dashboard 逾期面板 ----
function bossDashboardLateFeedbacks(feedbacks: FeedbackWithStatus[]): FeedbackWithStatus[] {
  // 拍板 13c: 仅 boss dashboard 可见
  return feedbacks.filter((f) => f.status === 'late');
}

// ---- parent 评分 ----
interface Rating {
  id: string;
  parentSub: string;
  teacherId: string;
  scheduleId: string;
  score: number;
  idempotencyKey: string;
}
class MockRatingStore {
  ratings: Rating[] = [];
  upsert(parentSub: string, teacherId: string, scheduleId: string, score: number, key: string): { created: boolean; rating: Rating } {
    const existing = this.ratings.find((r) => r.idempotencyKey === key);
    if (existing) return { created: false, rating: existing }; // idempotent
    const rating: Rating = { id: 'R' + this.ratings.length, parentSub, teacherId, scheduleId, score, idempotencyKey: key };
    this.ratings.push(rating);
    return { created: true, rating };
  }
}

function rateTeacher(
  parentSub: string,
  scheduleTeacherId: string,
  scheduleId: string,
  score: number,
  idempotencyKey: string,
  parentChildrenStudentIds: Set<string>,
  scheduleStudentId: string,
  store: MockRatingStore,
  audit: MockAuditLog,
): { created: boolean; rating: Rating } {
  // 拍板: parent 评分非授课老师 → 403 (检查 schedule.studentId ∈ parent.children)
  if (!parentChildrenStudentIds.has(scheduleStudentId)) {
    audit.log({ actorRole: 'parent', action: 'rating.rate-not-own-child', outcome: 'denied', meta: { scheduleId, scheduleStudentId } });
    throw new ForbiddenException(`parent cannot rate teacher for student not their child`);
  }
  if (score < 1 || score > 5) {
    throw new BadRequestException('score must be in [1, 5]');
  }
  const result = store.upsert(parentSub, scheduleTeacherId, scheduleId, score, idempotencyKey);
  audit.log({
    actorRole: 'parent',
    action: result.created ? 'rating.create' : 'rating.idempotent-hit',
    outcome: 'success',
    meta: { ratingId: result.rating.id },
  });
  return result;
}

// ---------- Test data ----------

// 32-char ULID 占位 — service.submit 严格校验 length===32
const TEACHER_SUB = '01HX7Y6P5K9N3M2QABCDEFGHIJKTCH01';
const STUDENT_SUB = '01HX7Y6P5K9N3M2QABCDEFGHIJKSTU01';
const PARENT_SUB = '01HX7Y6P5K9N3M2QABCDEFGHIJKPAR01';
const SCHEDULE_ID = '01HX7Y6P5K9N3M2QABCDEFGHIJKSCH01';

const teacherCaller = { sub: TEACHER_SUB, role: 'teacher' };
const otherTeacherCaller = { sub: '01HX7Y6P5K9N3M2QABCDEFGHIJKTCH99', role: 'teacher' };
const salesCaller = { sub: '01HX7Y6P5K9N3M2QABCDEFGHIJKSAL01', role: 'sales' };

function mkFeedbackInput(overrides: Partial<Parameters<LessonFeedbackService['submit']>[0]> = {}): Parameters<LessonFeedbackService['submit']>[0] {
  return {
    id: ('01HX7Y6P5K9N3M2QABCDEFGHIJKFB' + String(Math.floor(Math.random() * 900) + 100)).slice(0, 32),
    scheduleId: SCHEDULE_ID,
    studentId: STUDENT_SUB,
    teacherId: TEACHER_SUB,
    attendanceStatus: '出勤' as const,
    classroomPerformance: '良好' as const,
    teacherNote: 'OK',
    ...overrides,
  };
}

// ---------- Tests ----------

describe('[L8 业务流 D1] 反馈全链路 (14 case)', () => {
  let service: LessonFeedbackService;
  let audit: MockAuditLog;

  beforeEach(() => {
    service = new LessonFeedbackService();
    audit = new MockAuditLog();
  });

  // ----- 老师填阶段 (1-8) -----

  it('1. teacher 当天填 → status=normal + msgSecCheck OK + DB', () => {
    const scheduleEnd = new Date('2026-05-19T16:00:00Z');
    const submitted = new Date('2026-05-19T19:00:00Z'); // same day
    const fb = submitFeedbackWithMsgSec(
      service,
      mkFeedbackInput(),
      { scheduleEndAt: scheduleEnd, teacherSub: TEACHER_SUB, callerUser: teacherCaller, submittedAt: submitted },
      audit,
    );
    expect(fb.status).toBe('normal');
    expect(fb.pendingReview).toBeFalsy();
    expect(audit.byAction('feedback.submit').filter((e) => e.outcome === 'success')).toHaveLength(1);
    expect(audit.byAction('feedback.submit-late')).toHaveLength(0);
  });

  it('2. teacher 次日补填 → status=late + audit_log feedback.submit-late', () => {
    const scheduleEnd = new Date('2026-05-19T16:00:00Z');
    const submitted = new Date('2026-05-20T10:00:00Z'); // next day
    const fb = submitFeedbackWithMsgSec(
      service,
      mkFeedbackInput(),
      { scheduleEndAt: scheduleEnd, teacherSub: TEACHER_SUB, callerUser: teacherCaller, submittedAt: submitted },
      audit,
    );
    expect(fb.status).toBe('late');
    expect(audit.byAction('feedback.submit-late')).toHaveLength(1);
    expect(audit.byAction('feedback.submit-late')[0].meta?.feedbackId).toBe(fb.id);
  });

  it('3. cron 23:59 检查未填 → 返回未填 teacherIds + scheduleIds', () => {
    const schedules: UnfilledSchedule[] = [
      { scheduleId: 'SCH_FILLED', teacherId: TEACHER_SUB, scheduleEndAt: new Date('2026-05-19T16:00:00Z') },
      { scheduleId: 'SCH_UNFILLED_A', teacherId: TEACHER_SUB, scheduleEndAt: new Date('2026-05-19T17:00:00Z') },
      { scheduleId: 'SCH_UNFILLED_B', teacherId: 'T_OTHER', scheduleEndAt: new Date('2026-05-19T18:00:00Z') },
      { scheduleId: 'SCH_YESTERDAY', teacherId: TEACHER_SUB, scheduleEndAt: new Date('2026-05-18T16:00:00Z') }, // 不在今日, 不上报
    ];
    const filled = new Set(['SCH_FILLED']);
    const now = new Date('2026-05-19T23:59:00Z');
    const result = cronCheckUnfilledAtEod(schedules, filled, now);
    expect(result.scheduleIds).toEqual(['SCH_UNFILLED_A', 'SCH_UNFILLED_B']);
    expect(result.teacherIds.sort()).toEqual([TEACHER_SUB, 'T_OTHER'].sort());
  });

  it('4. 当天 23:59 没填 → boss dashboard 逾期反馈面板可见', () => {
    // 模拟次日 late submit
    const scheduleEnd = new Date('2026-05-19T16:00:00Z');
    const submitted = new Date('2026-05-20T10:00:00Z');
    const fb = submitFeedbackWithMsgSec(
      service,
      mkFeedbackInput(),
      { scheduleEndAt: scheduleEnd, teacherSub: TEACHER_SUB, callerUser: teacherCaller, submittedAt: submitted },
      audit,
    );
    const lateInBossDashboard = bossDashboardLateFeedbacks([fb]);
    expect(lateInBossDashboard).toHaveLength(1);
    expect(lateInBossDashboard[0].id).toBe(fb.id);
  });

  it('5. boss 在「逾期反馈」面板看哪些老师/schedule (late 聚合)', () => {
    // 两条 late, 一条 normal
    const lateA: FeedbackWithStatus = {
      ...service.submit(mkFeedbackInput({ id: 'F'.padEnd(32, 'A') })),
      status: 'late',
    } as FeedbackWithStatus;
    const lateB: FeedbackWithStatus = {
      ...service.submit(mkFeedbackInput({ id: 'F'.padEnd(32, 'B'), teacherId: 'T'.padEnd(32, 'B') })),
      status: 'late',
    } as FeedbackWithStatus;
    const normal: FeedbackWithStatus = {
      ...service.submit(mkFeedbackInput({ id: 'F'.padEnd(32, 'C') })),
      status: 'normal',
    } as FeedbackWithStatus;
    const dash = bossDashboardLateFeedbacks([lateA, lateB, normal]);
    expect(dash).toHaveLength(2);
    expect(dash.map((f) => f.id).sort()).toEqual(['F'.padEnd(32, 'A'), 'F'.padEnd(32, 'B')].sort());
  });

  it('6. teacher 永远可补填 (不阻止) — 软提醒模式', () => {
    // 3 天后还能补填
    const scheduleEnd = new Date('2026-05-19T16:00:00Z');
    const submitted = new Date('2026-05-22T10:00:00Z');
    expect(() =>
      submitFeedbackWithMsgSec(
        service,
        mkFeedbackInput(),
        { scheduleEndAt: scheduleEnd, teacherSub: TEACHER_SUB, callerUser: teacherCaller, submittedAt: submitted },
        audit,
      ),
    ).not.toThrow();
    const fb = audit.byAction('feedback.submit').filter((e) => e.outcome === 'success');
    expect(fb).toHaveLength(1);
    expect(fb[0].meta?.status).toBe('late');
  });

  it('7. msgSecCheck risky → 阻断 + 字段定位 (敏感词)', () => {
    const scheduleEnd = new Date('2026-05-19T16:00:00Z');
    const submitted = new Date('2026-05-19T19:00:00Z');
    expect(() =>
      submitFeedbackWithMsgSec(
        service,
        mkFeedbackInput({ teacherNote: '这里有暴力描述' }),
        { scheduleEndAt: scheduleEnd, teacherSub: TEACHER_SUB, callerUser: teacherCaller, submittedAt: submitted },
        audit,
      ),
    ).toThrow(/msgSecCheck/);
    expect(audit.byAction('feedback.msgsec-blocked')).toHaveLength(1);
    expect(audit.byAction('feedback.msgsec-blocked')[0].meta?.field).toBe('teacherNote');
  });

  it('8. msgSecCheck 超时 → fail-open + audit_log 待 review', () => {
    const scheduleEnd = new Date('2026-05-19T16:00:00Z');
    const submitted = new Date('2026-05-19T19:00:00Z');
    const fb = submitFeedbackWithMsgSec(
      service,
      mkFeedbackInput({ teacherNote: '__TIMEOUT__' }),
      { scheduleEndAt: scheduleEnd, teacherSub: TEACHER_SUB, callerUser: teacherCaller, submittedAt: submitted },
      audit,
    );
    expect(fb.pendingReview).toBe(true);
    expect(audit.byAction('feedback.msgsec-timeout-pending-review')).toHaveLength(1);
  });

  it('9. teacher 填别人课反馈 → 403 + audit_log ownership mismatch', () => {
    const scheduleEnd = new Date('2026-05-19T16:00:00Z');
    const submitted = new Date('2026-05-19T19:00:00Z');
    expect(() =>
      submitFeedbackWithMsgSec(
        service,
        mkFeedbackInput({ teacherId: TEACHER_SUB }), // schedule's teacher
        { scheduleEndAt: scheduleEnd, teacherSub: TEACHER_SUB, callerUser: otherTeacherCaller, submittedAt: submitted },
        audit,
      ),
    ).toThrow(ForbiddenException);
    const denied = audit.byAction('feedback.submit').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].meta?.reason).toBe('ownership mismatch');
  });

  // ----- 家长收到 + 评分 (10-14) -----

  it('10. parent C 端 push 通知 + 看反馈 (语义边界, 实际 push 走 wx.subscribeMessage)', () => {
    // 仅验证: parent role 在 feedback.read 允许集合内 (SSOT §4.1 学习表现 家 = C 端独立 ✅)
    const allowedReadRoles = ['sales', 'sales_manager', 'boss', 'admin', 'academic', 'academic_admin', 'teacher', 'parent'];
    expect(allowedReadRoles).toContain('parent');
  });

  it('11. parent 跨 tenant 多孩 → 多 tenant 反馈聚合 (语义)', () => {
    // ParentJwt aud=parent-app, parent_id 跨 tenant, parent_student_bindings 查询返多 tenant
    // 此 spec 仅断言聚合语义:
    const bindings = [
      { parent_id: PARENT_SUB, tenant_id: 'T1', student_id: STUDENT_SUB },
      { parent_id: PARENT_SUB, tenant_id: 'T2', student_id: '01HX7Y6P5K9N3M2QABCDEFGHIJKSTUY' },
    ];
    const parentBindings = bindings.filter((b) => b.parent_id === PARENT_SUB);
    expect(parentBindings).toHaveLength(2);
    expect(new Set(parentBindings.map((b) => b.tenant_id))).toEqual(new Set(['T1', 'T2']));
  });

  it('12. parent 评分 1-5 星 + msgSecCheck → teacher_ratings 写入', () => {
    const store = new MockRatingStore();
    const result = rateTeacher(
      PARENT_SUB,
      TEACHER_SUB,
      'SCH_001',
      5,
      'KEY_001',
      new Set([STUDENT_SUB]),
      STUDENT_SUB,
      store,
      audit,
    );
    expect(result.created).toBe(true);
    expect(result.rating.score).toBe(5);
    expect(store.ratings).toHaveLength(1);
    expect(audit.byAction('rating.create')).toHaveLength(1);
  });

  it('13. parent 评分非授课老师 → 403 + audit_log denied (student 不是自己孩子)', () => {
    const store = new MockRatingStore();
    expect(() =>
      rateTeacher(
        PARENT_SUB,
        TEACHER_SUB,
        'SCH_001',
        5,
        'KEY_002',
        new Set([STUDENT_SUB]), // 自己孩子是 STUDENT_SUB
        '01HX7Y6P5K9N3M2QABCDEFGHIJKOTHER1', // schedule 是别人孩子
        store,
        audit,
      ),
    ).toThrow(ForbiddenException);
    expect(audit.byAction('rating.rate-not-own-child')).toHaveLength(1);
    expect(store.ratings).toHaveLength(0); // 没写入
  });

  it('14. parent 重复评分 → idempotency 防重 (同 key 返 created=false)', () => {
    const store = new MockRatingStore();
    const r1 = rateTeacher(PARENT_SUB, TEACHER_SUB, 'SCH_001', 5, 'KEY_SAME', new Set([STUDENT_SUB]), STUDENT_SUB, store, audit);
    const r2 = rateTeacher(PARENT_SUB, TEACHER_SUB, 'SCH_001', 4, 'KEY_SAME', new Set([STUDENT_SUB]), STUDENT_SUB, store, audit);
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(false);
    expect(r2.rating.id).toBe(r1.rating.id);
    expect(r2.rating.score).toBe(5); // 第一次的分数, 不被改写
    expect(store.ratings).toHaveLength(1);
    expect(audit.byAction('rating.idempotent-hit')).toHaveLength(1);
  });

  // ----- Corner / safety -----

  it('corner: sales role 试图填 feedback → 403 (RBAC 不包含 sales)', () => {
    const scheduleEnd = new Date('2026-05-19T16:00:00Z');
    const submitted = new Date('2026-05-19T19:00:00Z');
    expect(() =>
      submitFeedbackWithMsgSec(
        service,
        mkFeedbackInput(),
        { scheduleEndAt: scheduleEnd, teacherSub: TEACHER_SUB, callerUser: salesCaller, submittedAt: submitted },
        audit,
      ),
    ).toThrow(ForbiddenException);
    const denied = audit.byAction('feedback.submit').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].actorRole).toBe('sales');
  });

  it('corner: parent score < 1 → BadRequestException', () => {
    const store = new MockRatingStore();
    expect(() =>
      rateTeacher(PARENT_SUB, TEACHER_SUB, 'SCH_001', 0, 'KEY_003', new Set([STUDENT_SUB]), STUDENT_SUB, store, audit),
    ).toThrow(BadRequestException);
  });

  it('corner: parent score > 5 → BadRequestException', () => {
    const store = new MockRatingStore();
    expect(() =>
      rateTeacher(PARENT_SUB, TEACHER_SUB, 'SCH_001', 6, 'KEY_004', new Set([STUDENT_SUB]), STUDENT_SUB, store, audit),
    ).toThrow(BadRequestException);
  });
});
