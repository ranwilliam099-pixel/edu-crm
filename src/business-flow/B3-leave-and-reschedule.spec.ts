/**
 * L8 业务流 B3 — 调课 / 请假 (6 case, ★ 请假任意时间 拍板 G2)
 *
 * 来源:
 *   - v2.0 §5.B3 调课 / 请假
 *   - SSOT §6 schedule.update=[academic] (5/15 Wave 11 教务唯一)
 *   - SSOT §6 leave.create=[parent, academic, admin, boss]
 *   - 拍板 G2: parent 可任意时间提请假 (无最小提前时长限制)
 *
 * 验证:
 *   - parent 任意时间请假 (leaves 表 + 状态 pending)
 *   - academic 审批通过 → schedule.leave_id set + 课时不扣
 *   - academic 调课 (cancel + 新建) → 学员 + 老师 双向通知
 *   - sales 改 schedule → 403
 *   - teacher 自主取消课 → 403 (教务统一调度)
 *   - academic 审批拒绝 → 课正常 + 扣课时
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
  // parent 用 parent_student_bindings 验证
  ownChildren?: string[];
}

interface Schedule {
  id: string;
  studentId: string;
  teacherId: string;
  startAt: Date;
  endAt: Date;
  status: 'pending' | 'cancelled';
  leaveId?: string;
  hoursDeducted: number;
}

interface Leave {
  id: string;
  scheduleId: string;
  studentId: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: Date;
}

interface Notification {
  to: string;
  type: 'student-side' | 'teacher-side';
  scheduleId: string;
  body: string;
}

class MockStore {
  schedules: Schedule[] = [];
  leaves: Leave[] = [];
  notifications: Notification[] = [];
}

function createLeave(
  user: MockUser,
  body: { scheduleId: string; reason: string },
  store: MockStore,
  audit: MockAuditLog,
  now: Date = new Date(),
): Leave {
  // parent / academic / admin / boss 可建
  if (!['parent', 'academic', 'admin', 'boss'].includes(user.role)) {
    audit.log({ actorRole: user.role, action: 'leave.create', outcome: 'denied', meta: { reason: 'role not allowed' } });
    throw new ForbiddenException(`role ${user.role} cannot create leave`);
  }

  const sch = store.schedules.find((s) => s.id === body.scheduleId);
  if (!sch) throw new BadRequestException('schedule not found');

  // parent 只能为自己孩子请假
  if (user.role === 'parent' && !user.ownChildren?.includes(sch.studentId)) {
    audit.log({ actorRole: 'parent', action: 'leave.create', outcome: 'denied', meta: { reason: 'not own child' } });
    throw new ForbiddenException('parent can only request leave for own child');
  }

  // 拍板 G2: 任意时间均可 (无最小提前时长限制)
  // 不做时间窗口校验

  const leave: Leave = {
    id: 'LV_' + Math.random().toString(36).slice(2, 8).toUpperCase(),
    scheduleId: body.scheduleId,
    studentId: sch.studentId,
    reason: body.reason,
    status: 'pending',
    createdAt: now,
  };
  store.leaves.push(leave);
  audit.log({ actorRole: user.role, action: 'leave.create', outcome: 'success', meta: { leaveId: leave.id } });
  return leave;
}

function approveLeave(
  user: MockUser,
  leaveId: string,
  decision: 'approve' | 'reject',
  store: MockStore,
  audit: MockAuditLog,
): { leave: Leave; schedule: Schedule } {
  // 拍板: academic / admin / boss 可审批
  if (!['academic', 'admin', 'boss'].includes(user.role)) {
    audit.log({ actorRole: user.role, action: 'leave.approve', outcome: 'denied', meta: { reason: 'role not allowed' } });
    throw new ForbiddenException(`role ${user.role} cannot approve leave`);
  }
  const lv = store.leaves.find((l) => l.id === leaveId);
  if (!lv) throw new BadRequestException('leave not found');
  const sch = store.schedules.find((s) => s.id === lv.scheduleId);
  if (!sch) throw new BadRequestException('schedule not found');

  if (decision === 'approve') {
    lv.status = 'approved';
    sch.leaveId = lv.id;
    sch.hoursDeducted = 0; // 不扣
    audit.log({ actorRole: user.role, action: 'leave.approve', outcome: 'success', meta: { leaveId, hoursDeducted: 0 } });
  } else {
    lv.status = 'rejected';
    sch.hoursDeducted = 1; // 拒绝 → 课正常 + 扣课时
    audit.log({ actorRole: user.role, action: 'leave.reject', outcome: 'success', meta: { leaveId, hoursDeducted: 1 } });
  }
  return { leave: lv, schedule: sch };
}

function rescheduleByCancel(
  user: MockUser,
  body: {
    cancelScheduleId: string;
    newStartAt: Date;
    newEndAt: Date;
  },
  store: MockStore,
  audit: MockAuditLog,
): { cancelled: Schedule; created: Schedule } {
  // schedule.update / schedule.create 都是 academic 唯一
  if (user.role !== 'academic') {
    audit.log({ actorRole: user.role, action: 'schedule.reschedule', outcome: 'denied', meta: { reason: 'role not academic' } });
    throw new ForbiddenException(`role ${user.role} cannot reschedule`);
  }
  const old = store.schedules.find((s) => s.id === body.cancelScheduleId);
  if (!old) throw new BadRequestException('schedule not found');

  old.status = 'cancelled';

  const created: Schedule = {
    id: 'SCH_' + Math.random().toString(36).slice(2, 8).toUpperCase(),
    studentId: old.studentId,
    teacherId: old.teacherId,
    startAt: body.newStartAt,
    endAt: body.newEndAt,
    status: 'pending',
    hoursDeducted: 0,
  };
  store.schedules.push(created);

  // 双向通知
  store.notifications.push({
    to: 'PARENT_OF_' + old.studentId,
    type: 'student-side',
    scheduleId: created.id,
    body: `调课通知: ${old.startAt.toISOString()} → ${created.startAt.toISOString()}`,
  });
  store.notifications.push({
    to: old.teacherId,
    type: 'teacher-side',
    scheduleId: created.id,
    body: `调课通知: ${old.startAt.toISOString()} → ${created.startAt.toISOString()}`,
  });

  audit.log({
    actorRole: user.role,
    action: 'schedule.reschedule',
    outcome: 'success',
    meta: { oldId: old.id, newId: created.id, notifyBoth: true },
  });
  return { cancelled: old, created };
}

function updateScheduleAttempt(user: MockUser, scheduleId: string, audit: MockAuditLog): void {
  // schedule.update=[academic] only
  if (user.role !== 'academic') {
    audit.log({ actorRole: user.role, action: 'schedule.update', outcome: 'denied', meta: { reason: 'role not academic' } });
    throw new ForbiddenException(`role ${user.role} cannot update schedule`);
  }
}

function teacherSelfCancel(user: MockUser, scheduleId: string, audit: MockAuditLog): void {
  // teacher 自己取消 → 403 (教务统一调度)
  if (user.role !== 'academic') {
    audit.log({ actorRole: user.role, action: 'schedule.cancel', outcome: 'denied', meta: { reason: 'teacher cannot self-cancel' } });
    throw new ForbiddenException(`teacher cannot self-cancel schedule; contact academic`);
  }
}

// ---------- Test data ----------

const STU_001 = 'STU_001';
const academic1: MockUser = { sub: 'ACAD01', role: 'academic', tenantId: 'TNT01' };
const parent1: MockUser = { sub: 'PAR01', role: 'parent', tenantId: 'TNT01', ownChildren: [STU_001] };
const parentOther: MockUser = { sub: 'PAR99', role: 'parent', tenantId: 'TNT01', ownChildren: ['STU_999'] };
const sales1: MockUser = { sub: 'SAL01', role: 'sales', tenantId: 'TNT01' };
const teacher1: MockUser = { sub: 'TCH01', role: 'teacher', tenantId: 'TNT01' };

function makeStore(): MockStore {
  const s = new MockStore();
  s.schedules.push({
    id: 'SCH_001',
    studentId: STU_001,
    teacherId: 'T_001',
    startAt: new Date('2026-05-20T16:00:00Z'),
    endAt: new Date('2026-05-20T17:00:00Z'),
    status: 'pending',
    hoursDeducted: 0,
  });
  return s;
}

describe('[L8 业务流 B3] 调课 / 请假 (6 case, 任意时间)', () => {
  let store: MockStore;
  let audit: MockAuditLog;

  beforeEach(() => {
    store = makeStore();
    audit = new MockAuditLog();
  });

  it('B3.1 parent 任意时间提请假 (拍板 G2 无时间窗口) → leaves 表 + 状态 pending', () => {
    // 即使 1 分钟前 (无提前时长限制)
    const oneMinBefore = new Date('2026-05-20T15:59:00Z');
    const lv = createLeave(parent1, { scheduleId: 'SCH_001', reason: '突发感冒' }, store, audit, oneMinBefore);
    expect(lv.status).toBe('pending');
    expect(lv.reason).toBe('突发感冒');
    expect(store.leaves).toHaveLength(1);

    // 1 个月后请假 (远未来) 也 OK
    const lv2 = createLeave(
      parent1,
      { scheduleId: 'SCH_001', reason: '出差' },
      store,
      audit,
      new Date('2026-04-20T00:00:00Z'),
    );
    expect(lv2.status).toBe('pending');

    // parent 为别孩子请假 → 403
    expect(() =>
      createLeave(parentOther, { scheduleId: 'SCH_001', reason: '随便' }, store, audit),
    ).toThrow(ForbiddenException);
    const denied = audit.byAction('leave.create').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].meta?.reason).toBe('not own child');
  });

  it('B3.2 academic 审批通过 → schedule.leave_id set + 课时不扣', () => {
    const lv = createLeave(parent1, { scheduleId: 'SCH_001', reason: '感冒' }, store, audit);
    const result = approveLeave(academic1, lv.id, 'approve', store, audit);
    expect(result.leave.status).toBe('approved');
    expect(result.schedule.leaveId).toBe(lv.id);
    expect(result.schedule.hoursDeducted).toBe(0); // 不扣
    expect(audit.byAction('leave.approve')).toHaveLength(1);
    expect(audit.byAction('leave.approve')[0].meta?.hoursDeducted).toBe(0);
  });

  it('B3.3 academic 调课 (取消原 schedule + 新建 schedule) → 学员 + 老师 双向通知', () => {
    const result = rescheduleByCancel(
      academic1,
      {
        cancelScheduleId: 'SCH_001',
        newStartAt: new Date('2026-05-21T16:00:00Z'),
        newEndAt: new Date('2026-05-21T17:00:00Z'),
      },
      store,
      audit,
    );
    expect(result.cancelled.status).toBe('cancelled');
    expect(result.cancelled.id).toBe('SCH_001');
    expect(result.created.id).toBeTruthy();
    expect(result.created.startAt.toISOString()).toBe('2026-05-21T16:00:00.000Z');

    // 双向通知
    expect(store.notifications).toHaveLength(2);
    const types = store.notifications.map((n) => n.type).sort();
    expect(types).toEqual(['student-side', 'teacher-side']);

    const success = audit.byAction('schedule.reschedule');
    expect(success).toHaveLength(1);
    expect(success[0].meta?.notifyBoth).toBe(true);
  });

  it('B3.4 sales 改 schedule → 403', () => {
    expect(() => updateScheduleAttempt(sales1, 'SCH_001', audit)).toThrow(ForbiddenException);
    const denied = audit.byAction('schedule.update').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].actorRole).toBe('sales');

    // sales 调课也 403
    expect(() =>
      rescheduleByCancel(
        sales1,
        { cancelScheduleId: 'SCH_001', newStartAt: new Date(), newEndAt: new Date() },
        store,
        audit,
      ),
    ).toThrow(ForbiddenException);
  });

  it('B3.5 teacher 自主取消课 → 403 (教务统一调度)', () => {
    expect(() => teacherSelfCancel(teacher1, 'SCH_001', audit)).toThrow(ForbiddenException);
    const denied = audit.byAction('schedule.cancel').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].actorRole).toBe('teacher');
    expect(denied[0].meta?.reason).toBe('teacher cannot self-cancel');
  });

  it('B3.6 academic 审批拒绝 → 课正常 + 扣课时', () => {
    const lv = createLeave(parent1, { scheduleId: 'SCH_001', reason: '理由不充分' }, store, audit);
    const result = approveLeave(academic1, lv.id, 'reject', store, audit);
    expect(result.leave.status).toBe('rejected');
    expect(result.schedule.leaveId).toBeUndefined(); // 没 set
    expect(result.schedule.hoursDeducted).toBe(1); // 扣
    expect(audit.byAction('leave.reject')).toHaveLength(1);
    expect(audit.byAction('leave.reject')[0].meta?.hoursDeducted).toBe(1);
  });
});
