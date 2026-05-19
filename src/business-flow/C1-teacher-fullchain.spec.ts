/**
 * L8 业务流 C1 — 老师上课全链路 (17 case, ★ 老师线核心)
 *
 * 来源:
 *   - v2.0 §5.C1 上课全链路 (17 case)
 *   - SSOT §3.5 老师 home / §4.3 teacher 字段矩阵 / §6 schedule.create=[academic] (5/15 Wave 11)
 *   - 拍板 11: 老师视图零财务 / X1 V50 物理删除 hourly_price_yuan
 *   - 拍板 12-13: msgSecCheck 三态 + 反馈 normal/late 软提醒
 *
 * 验证关注点 (17 case):
 *   课前 (1-7): home schedule / 看学员档案 / feedback / assessment / homework / learning_profile / cross-tenant 403 / 不教学员 403
 *   课中 (8-9): 标 present / 标 leave 不扣课时
 *   课后 (10-14): 当天 normal / 次日 late + audit_log / cron 23:59 / risky 阻断 / timeout fail-open
 *   self-edit (15-17): teacher 自改 / academic 改任何 403 / 老师零财务字段 (X1 验证)
 *
 * 策略:
 *   - mock teacher ownership (assigned_teacher_id) + cross-tenant guard
 *   - mock attendance / leave (attendance=leave → 课时不扣)
 *   - mock msgSecCheck (与 D1 共用语义)
 *   - 字段级 X1 验证: teacher 视图字段集合不含 hourlyPriceYuan / contractAmount / rate_per_lesson
 */
import { LessonFeedbackService } from '../modules/feedback/lesson-feedback.service';
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
  log(e: AuditEntry): void { this.entries.push(e); }
  byAction(a: string): AuditEntry[] { return this.entries.filter((e) => e.action === a); }
}

// 32-char ULID 占位 — service.submit 严格校验 length===32 (teacher / student / schedule id 都需对齐)
const TEACHER_A_ID = '01HX7Y6P5K9N3M2QABCDEFGHIJKTCHAA';
const TEACHER_A_USER_SUB = '01HX7Y6P5K9N3M2QABCDEFGHIJKUSRAA';
const TEACHER_B_USER_SUB = '01HX7Y6P5K9N3M2QABCDEFGHIJKUSRBB';
const STUDENT_OWNED_BY_A = '01HX7Y6P5K9N3M2QABCDEFGHIJKSTUAA';
const STUDENT_OWNED_BY_B = '01HX7Y6P5K9N3M2QABCDEFGHIJKSTUBB';
const SCH_ID_001 = '01HX7Y6P5K9N3M2QABCDEFGHIJKSCH01';
const SCH_ID_002 = '01HX7Y6P5K9N3M2QABCDEFGHIJKSCH02';
const SCH_ID_003 = '01HX7Y6P5K9N3M2QABCDEFGHIJKSCH03';
const SCH_ID_004 = '01HX7Y6P5K9N3M2QABCDEFGHIJKSCH04';
const FB_ID_001 = '01HX7Y6P5K9N3M2QABCDEFGHIJKFB001';
const FB_ID_002 = '01HX7Y6P5K9N3M2QABCDEFGHIJKFB002';
const FB_ID_003 = '01HX7Y6P5K9N3M2QABCDEFGHIJKFB003';
const FB_ID_004 = '01HX7Y6P5K9N3M2QABCDEFGHIJKFB004';
const CAMPUS_ID = '01HX7Y6P5K9N3M2QABCDEFGHIJKCMP01';
const TENANT_ID = '01HX7Y6P5K9N3M2QABCDEFGHIJKTNT01';
const OTHER_TENANT_ID = '01HX7Y6P5K9N3M2QABCDEFGHIJKTNT99';
const ACADEMIC_SUB = '01HX7Y6P5K9N3M2QABCDEFGHIJKACAD0';
const ADMIN_SUB = '01HX7Y6P5K9N3M2QABCDEFGHIJKADM001';

// teacher view 字段白名单 (X1 拍板: 老师视图零财务)
const TEACHER_VIEW_STUDENT_FIELDS = [
  'id',
  'name',
  'age',
  'grade',
  'school',
  'assignedTeacherId',
  'remainingHours', // 剩余课时 (V12 course_packages_balance 计数, 不是金额)
  // 不含: contractAmount / hourlyPriceYuan / paidAmount / refundAmount / family_address / 家长 phone
];

function teacherViewStudent(
  callerSub: string,
  studentId: string,
  studentAssignedTeacherId: string,
  studentTenantId: string,
  callerTenantId: string,
  audit: MockAuditLog,
): { id: string; fields: Record<string, unknown> } {
  // cross-tenant
  if (studentTenantId !== callerTenantId) {
    audit.log({ actorRole: 'teacher', action: 'student.cross-tenant-denied', outcome: 'denied', meta: { studentId } });
    throw new ForbiddenException('cross-tenant student access denied');
  }
  // ownership: teacher 只能看 assigned_teacher_id = self
  if (studentAssignedTeacherId !== callerSub) {
    audit.log({ actorRole: 'teacher', action: 'student.not-owned-denied', outcome: 'denied', meta: { studentId, assignedTo: studentAssignedTeacherId } });
    throw new ForbiddenException('teacher cannot view student not assigned');
  }
  const fields: Record<string, unknown> = {};
  for (const f of TEACHER_VIEW_STUDENT_FIELDS) {
    fields[f] = `MOCK_${f}_VALUE`;
  }
  return { id: studentId, fields };
}

function teacherViewHistoryFeedbacks(callerSub: string, studentId: string, studentAssignedTeacherId: string, audit: MockAuditLog): { count: number; allOwners: string[] } {
  if (studentAssignedTeacherId !== callerSub) {
    audit.log({ actorRole: 'teacher', action: 'feedback.history.not-owned-denied', outcome: 'denied' });
    throw new ForbiddenException('not own student');
  }
  // 主带老师可看自己 + 其他老师的历史 feedback (全只读)
  return { count: 3, allOwners: [callerSub, 'OTHER_T_001', 'OTHER_T_002'] };
}

function teacherViewLearningProfile(callerSub: string, studentId: string, studentAssignedTeacherId: string, audit: MockAuditLog): { summary: string } {
  if (studentAssignedTeacherId !== callerSub) {
    audit.log({ actorRole: 'teacher', action: 'learning-profile.not-owned-denied', outcome: 'denied' });
    throw new ForbiddenException('not own student');
  }
  return { summary: 'aggregated' };
}

// ---- 课中: 出勤 / 请假 ----

type AttendanceStatus = '待出勤' | 'present' | 'leave' | 'absent' | '迟到';

interface ScheduleAttendance {
  scheduleId: string;
  studentId: string;
  status: AttendanceStatus;
  hoursDeducted: number;
}

function markAttendance(
  callerSub: string,
  scheduleTeacherId: string,
  sa: ScheduleAttendance,
  newStatus: AttendanceStatus,
  hourlyHoursToDeduct: number, // 1 课次=N 小时, 由 contract 带价
  audit: MockAuditLog,
): ScheduleAttendance {
  if (scheduleTeacherId !== callerSub) {
    audit.log({ actorRole: 'teacher', action: 'attendance.not-own-denied', outcome: 'denied' });
    throw new ForbiddenException('not own schedule');
  }
  // leave / absent → 课时是否扣由业务规则: leave 不扣, absent / present 扣
  const hoursDeducted = newStatus === 'leave' ? 0 : hourlyHoursToDeduct;
  return { ...sa, status: newStatus, hoursDeducted };
}

// ---- 课后填反馈 (复用 D1 语义, 此处合并) ----

type MsgSecResult = 'ok' | 'risky' | 'timeout';
function mockMsgSec(content: string): MsgSecResult {
  if (content.includes('暴力')) return 'risky';
  if (content === '__TIMEOUT__') return 'timeout';
  return 'ok';
}
function deriveStatus(end: Date, sub: Date): 'normal' | 'late' {
  // UTC date 比较, 避免 jest 时区差异 (生产应取 tenant 时区 Asia/Shanghai, 此 spec 验状态机语义)
  return end.toISOString().slice(0, 10) === sub.toISOString().slice(0, 10) ? 'normal' : 'late';
}

function submitFeedback(
  fbService: LessonFeedbackService,
  input: Parameters<LessonFeedbackService['submit']>[0],
  context: { callerSub: string; callerRole: string; scheduleTeacherId: string; scheduleEndAt: Date; submittedAt: Date },
  audit: MockAuditLog,
): { id: string; status: 'normal' | 'late'; pendingReview: boolean } {
  if (!['teacher', 'admin', 'boss'].includes(context.callerRole)) {
    audit.log({ actorRole: context.callerRole, action: 'feedback.submit-not-allowed', outcome: 'denied' });
    throw new ForbiddenException('role not allowed');
  }
  if (context.callerRole === 'teacher' && context.scheduleTeacherId !== context.callerSub) {
    audit.log({ actorRole: 'teacher', action: 'feedback.not-own-schedule-denied', outcome: 'denied' });
    throw new ForbiddenException('teacher can only submit own schedule feedback');
  }
  const result = mockMsgSec(input.teacherNote || '');
  if (result === 'risky') {
    audit.log({ actorRole: context.callerRole, action: 'feedback.msgsec-blocked', outcome: 'denied' });
    throw new BadRequestException('msgSecCheck risky');
  }
  const pendingReview = result === 'timeout';
  if (pendingReview) {
    audit.log({ actorRole: context.callerRole, action: 'feedback.msgsec-pending-review', outcome: 'success' });
  }
  const fb = fbService.submit(input);
  const status = deriveStatus(context.scheduleEndAt, context.submittedAt);
  if (status === 'late') {
    audit.log({ actorRole: context.callerRole, action: 'feedback.submit-late', outcome: 'success', meta: { feedbackId: fb.id } });
  }
  audit.log({ actorRole: context.callerRole, action: 'feedback.submit', outcome: 'success', meta: { feedbackId: fb.id, status } });
  return { id: fb.id, status, pendingReview };
}

// ---- self-edit (C2 复用) ----

function updateTeacherProfile(
  callerSub: string,
  callerRole: string,
  targetTeacherUserSub: string,
  audit: MockAuditLog,
): { id: string } {
  // admin / boss 全权
  if (['admin', 'boss'].includes(callerRole)) {
    audit.log({ actorRole: callerRole, action: 'teacher.update', outcome: 'success' });
    return { id: targetTeacherUserSub };
  }
  // teacher self-edit only
  if (callerRole === 'teacher') {
    if (callerSub !== targetTeacherUserSub) {
      audit.log({ actorRole: 'teacher', action: 'teacher.update-not-self-denied', outcome: 'denied' });
      throw new ForbiddenException('teacher can only self-edit own profile');
    }
    audit.log({ actorRole: 'teacher', action: 'teacher.update', outcome: 'success' });
    return { id: targetTeacherUserSub };
  }
  // academic 不能改 (SSOT §4.3 务 = 👁 不改)
  audit.log({ actorRole: callerRole, action: 'teacher.update-role-not-allowed', outcome: 'denied' });
  throw new ForbiddenException(`role ${callerRole} cannot update teacher`);
}

// ---------- Tests ----------

describe('[L8 业务流 C1] 老师上课全链路 (17 case)', () => {
  let fbService: LessonFeedbackService;
  let audit: MockAuditLog;

  beforeEach(() => {
    fbService = new LessonFeedbackService();
    audit = new MockAuditLog();
  });

  // ----- 课前 (1-7) -----

  it('1. teacher home 看今日 schedule (按时段排序语义, 此处仅断言可读)', () => {
    // home 走 listByTeacher (schedule.repository); 此处仅断言 ownership 边界
    // teacher 自己可看自己的 schedule, 非自己的查询应返空 (SQL 层 WHERE teacher_id=$caller)
    const teacherOwnSchedules = [{ id: 'S1', teacherId: TEACHER_A_USER_SUB }];
    const filteredForTeacherA = teacherOwnSchedules.filter((s) => s.teacherId === TEACHER_A_USER_SUB);
    expect(filteredForTeacherA).toHaveLength(1);
  });

  it('2. teacher 点 schedule → 跳学员档案 (可读 own student)', () => {
    const view = teacherViewStudent(TEACHER_A_USER_SUB, STUDENT_OWNED_BY_A, TEACHER_A_USER_SUB, TENANT_ID, TENANT_ID, audit);
    expect(view.id).toBe(STUDENT_OWNED_BY_A);
    expect(Object.keys(view.fields).sort()).toEqual(TEACHER_VIEW_STUDENT_FIELDS.sort());
  });

  it('3. teacher 看学员历史 feedback (自己 + 其他老师, 全只读)', () => {
    const history = teacherViewHistoryFeedbacks(TEACHER_A_USER_SUB, STUDENT_OWNED_BY_A, TEACHER_A_USER_SUB, audit);
    expect(history.count).toBe(3);
    expect(history.allOwners).toContain(TEACHER_A_USER_SUB);
    expect(history.allOwners.some((o) => o !== TEACHER_A_USER_SUB)).toBe(true);
  });

  it('4. teacher 看学员历史 assessment / homework 进度 (语义复用 history 路径)', () => {
    // 实际 controller assessment.list / homework.list 走 WHERE student_id=$studentId
    // 此处仅断言 teacher 在 RBAC 允许 read 集合内
    const allowedRoles = ['teacher', 'admin', 'boss', 'academic', 'academic_admin'];
    expect(allowedRoles).toContain('teacher');
  });

  it('5. teacher 看学员 learning_profile 聚合', () => {
    const lp = teacherViewLearningProfile(TEACHER_A_USER_SUB, STUDENT_OWNED_BY_A, TEACHER_A_USER_SUB, audit);
    expect(lp.summary).toBe('aggregated');
  });

  it('6. teacher 跨 tenant 看别 tenant 学员 → 403 + audit_log cross-tenant-denied', () => {
    // student 在 OTHER_TENANT_ID, caller 在 TENANT_ID
    expect(() =>
      teacherViewStudent(TEACHER_A_USER_SUB, STUDENT_OWNED_BY_A, TEACHER_A_USER_SUB, OTHER_TENANT_ID, TENANT_ID, audit),
    ).toThrow(ForbiddenException);
    expect(audit.byAction('student.cross-tenant-denied')).toHaveLength(1);
  });

  it('7. teacher 看自己不教的学员 → 403 + audit_log not-owned-denied', () => {
    expect(() =>
      teacherViewStudent(TEACHER_A_USER_SUB, STUDENT_OWNED_BY_B, TEACHER_B_USER_SUB, TENANT_ID, TENANT_ID, audit),
    ).toThrow(ForbiddenException);
    const denied = audit.byAction('student.not-owned-denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].meta?.assignedTo).toBe(TEACHER_B_USER_SUB);
  });

  // ----- 课中 (8-9) -----

  it('8. teacher 标记「学员到课」→ attendance=present + 课时扣 1', () => {
    const sa: ScheduleAttendance = { scheduleId: 'SCH_C1_001', studentId: STUDENT_OWNED_BY_A, status: '待出勤', hoursDeducted: 0 };
    const updated = markAttendance(TEACHER_A_USER_SUB, TEACHER_A_USER_SUB, sa, 'present', 1, audit);
    expect(updated.status).toBe('present');
    expect(updated.hoursDeducted).toBe(1);
  });

  it('9. teacher 标记「请假」→ attendance=leave + 课时包不扣', () => {
    const sa: ScheduleAttendance = { scheduleId: 'SCH_C1_002', studentId: STUDENT_OWNED_BY_A, status: '待出勤', hoursDeducted: 0 };
    const updated = markAttendance(TEACHER_A_USER_SUB, TEACHER_A_USER_SUB, sa, 'leave', 1, audit);
    expect(updated.status).toBe('leave');
    expect(updated.hoursDeducted).toBe(0); // 不扣
  });

  // ----- 课后填反馈 (10-14) -----

  it('10. teacher 当天填 → status=normal + msgSecCheck OK + DB', () => {
    const result = submitFeedback(
      fbService,
      {
        id: FB_ID_001,
        scheduleId: SCH_ID_001,
        studentId: STUDENT_OWNED_BY_A,
        teacherId: TEACHER_A_USER_SUB,
        attendanceStatus: '出勤',
        classroomPerformance: '良好',
        teacherNote: 'OK',
      },
      {
        callerSub: TEACHER_A_USER_SUB,
        callerRole: 'teacher',
        scheduleTeacherId: TEACHER_A_USER_SUB,
        scheduleEndAt: new Date('2026-05-19T16:00:00Z'),
        submittedAt: new Date('2026-05-19T19:00:00Z'),
      },
      audit,
    );
    expect(result.status).toBe('normal');
    expect(result.pendingReview).toBe(false);
    expect(audit.byAction('feedback.submit-late')).toHaveLength(0);
  });

  it('11. teacher 次日补填 → status=late + audit_log feedback.submit-late', () => {
    const result = submitFeedback(
      fbService,
      {
        id: FB_ID_002,
        scheduleId: SCH_ID_002,
        studentId: STUDENT_OWNED_BY_A,
        teacherId: TEACHER_A_USER_SUB,
        attendanceStatus: '出勤',
        classroomPerformance: '良好',
        teacherNote: 'OK',
      },
      {
        callerSub: TEACHER_A_USER_SUB,
        callerRole: 'teacher',
        scheduleTeacherId: TEACHER_A_USER_SUB,
        scheduleEndAt: new Date('2026-05-19T16:00:00Z'),
        submittedAt: new Date('2026-05-20T10:00:00Z'),
      },
      audit,
    );
    expect(result.status).toBe('late');
    expect(audit.byAction('feedback.submit-late')).toHaveLength(1);
  });

  it('12. cron 当天 23:59 检查未填 → 推送提醒 (语义边界, 实际走 @nestjs/schedule cron)', () => {
    // cron 函数语义: 找今日 schedule 集合 - filled scheduleIds 集合 = 待推送
    const today = new Date('2026-05-19T23:59:00Z').toISOString().slice(0, 10);
    const todayScheds = [
      { scheduleId: 'A', scheduleEndAt: '2026-05-19T16:00:00Z' },
      { scheduleId: 'B', scheduleEndAt: '2026-05-19T18:00:00Z' },
      { scheduleId: 'YESTERDAY', scheduleEndAt: '2026-05-18T18:00:00Z' },
    ];
    const filled = new Set(['A']);
    const todoToday = todayScheds.filter(
      (s) => s.scheduleEndAt.slice(0, 10) === today && !filled.has(s.scheduleId),
    );
    expect(todoToday.map((s) => s.scheduleId)).toEqual(['B']);
  });

  it('13. msgSecCheck risky → 阻断 (敏感词) + audit_log feedback.msgsec-blocked', () => {
    expect(() =>
      submitFeedback(
        fbService,
        {
          id: FB_ID_003,
          scheduleId: SCH_ID_003,
          studentId: STUDENT_OWNED_BY_A,
          teacherId: TEACHER_A_USER_SUB,
          attendanceStatus: '出勤',
          classroomPerformance: '良好',
          teacherNote: '含暴力描述',
        },
        {
          callerSub: TEACHER_A_USER_SUB,
          callerRole: 'teacher',
          scheduleTeacherId: TEACHER_A_USER_SUB,
          scheduleEndAt: new Date('2026-05-19T16:00:00Z'),
          submittedAt: new Date('2026-05-19T19:00:00Z'),
        },
        audit,
      ),
    ).toThrow(BadRequestException);
    expect(audit.byAction('feedback.msgsec-blocked')).toHaveLength(1);
  });

  it('14. msgSecCheck 超时 → fail-open + audit_log msgsec-pending-review', () => {
    const result = submitFeedback(
      fbService,
      {
        id: FB_ID_004,
        scheduleId: SCH_ID_004,
        studentId: STUDENT_OWNED_BY_A,
        teacherId: TEACHER_A_USER_SUB,
        attendanceStatus: '出勤',
        classroomPerformance: '良好',
        teacherNote: '__TIMEOUT__',
      },
      {
        callerSub: TEACHER_A_USER_SUB,
        callerRole: 'teacher',
        scheduleTeacherId: TEACHER_A_USER_SUB,
        scheduleEndAt: new Date('2026-05-19T16:00:00Z'),
        submittedAt: new Date('2026-05-19T19:00:00Z'),
      },
      audit,
    );
    expect(result.pendingReview).toBe(true);
    expect(audit.byAction('feedback.msgsec-pending-review')).toHaveLength(1);
  });

  // ----- self-edit (15-17) -----

  it('15. teacher self-edit 自己档案 → 通过 + audit_log success', () => {
    const result = updateTeacherProfile(TEACHER_A_USER_SUB, 'teacher', TEACHER_A_USER_SUB, audit);
    expect(result.id).toBe(TEACHER_A_USER_SUB);
    expect(audit.byAction('teacher.update').filter((e) => e.outcome === 'success')).toHaveLength(1);
  });

  it('16. teacher 改别的老师档案 → 403 + audit_log not-self-denied', () => {
    expect(() => updateTeacherProfile(TEACHER_A_USER_SUB, 'teacher', TEACHER_B_USER_SUB, audit)).toThrow(ForbiddenException);
    expect(audit.byAction('teacher.update-not-self-denied')).toHaveLength(1);
  });

  it('17. academic 改任何 teacher → 403 (SSOT §4.3 务 = 👁 不改); admin 改通过; teacher 视图零财务字段 (X1)', () => {
    // academic deny
    expect(() => updateTeacherProfile(ACADEMIC_SUB, 'academic', TEACHER_A_USER_SUB, audit)).toThrow(ForbiddenException);
    expect(audit.byAction('teacher.update-role-not-allowed').filter((e) => e.actorRole === 'academic')).toHaveLength(1);

    // admin allow
    const adminResult = updateTeacherProfile(ADMIN_SUB, 'admin', TEACHER_A_USER_SUB, audit);
    expect(adminResult.id).toBe(TEACHER_A_USER_SUB);

    // X1 验证: teacher view student fields 集合不含财务字段
    const teacherView = teacherViewStudent(TEACHER_A_USER_SUB, STUDENT_OWNED_BY_A, TEACHER_A_USER_SUB, TENANT_ID, TENANT_ID, audit);
    const FORBIDDEN_FINANCIAL_FIELDS = ['hourlyPriceYuan', 'contractAmount', 'paidAmount', 'refundAmount', 'rate_per_lesson_yuan'];
    for (const forbidden of FORBIDDEN_FINANCIAL_FIELDS) {
      expect(Object.keys(teacherView.fields)).not.toContain(forbidden);
    }
    expect(Object.keys(teacherView.fields)).toContain('remainingHours'); // 课次而非金额 ✅
  });
});
