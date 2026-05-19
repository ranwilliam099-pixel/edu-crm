/**
 * L8 业务流 B1 — 单次排课 (10 case, 教务核心)
 *
 * 来源:
 *   - v2.0 §5.B1 单次排课
 *   - SSOT §6 schedule.create=[academic] (5/15 Wave 11 教务唯一)
 *   - 拍板: 班型 (一对一/一对多/小班课) 决定并发学员上限
 *   - 拍板: 课时余额 0 → 拒绝 + 提示「请续费」
 *   - 离职老师 (deactivated_at) / 归档学员 (archived_at) → 拒绝
 *
 * 验证:
 *   - academic 选学员 → 老师 → 时段 → schedule created
 *   - 老师同时段冲突 / 学员同时段冲突 → 拒绝
 *   - 学员 contract 余额 0 → 拒绝
 *   - 班型 = 一对多 → 允许多学员同老师
 *   - 班型 = 小班课 → 学员上限 (≤ N)
 *   - sales 排课 / 跨 tenant academic / 离职老师 / 归档学员 → 403 or 拒绝
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
}

type ClassType = 'one-on-one' | 'one-on-many' | 'small-class';

interface Teacher {
  id: string;
  tenantId: string;
  deactivatedAt?: Date;
}

interface Student {
  id: string;
  tenantId: string;
  archivedAt?: Date;
  remainingHours: number;
}

interface Schedule {
  id: string;
  teacherId: string;
  studentIds: string[];
  startAt: Date;
  endAt: Date;
  classType: ClassType;
  classCapacity?: number; // small-class 上限
}

class MockStore {
  teachers: Teacher[] = [];
  students: Student[] = [];
  schedules: Schedule[] = [];
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function createSchedule(
  user: MockUser,
  body: {
    teacherId: string;
    studentIds: string[];
    startAt: Date;
    endAt: Date;
    classType: ClassType;
    classCapacity?: number;
  },
  store: MockStore,
  audit: MockAuditLog,
): Schedule {
  // SSOT §6 schedule.create=[academic] (5/15 Wave 11 教务唯一)
  if (user.role !== 'academic') {
    audit.log({ actorRole: user.role, action: 'schedule.create', outcome: 'denied', meta: { reason: 'role not academic' } });
    throw new ForbiddenException(`role ${user.role} cannot create schedule (academic only)`);
  }

  // 老师存在 + 同 tenant + 未离职
  const teacher = store.teachers.find((t) => t.id === body.teacherId);
  if (!teacher) throw new BadRequestException('teacher not found');
  if (teacher.tenantId !== user.tenantId) {
    audit.log({ actorRole: user.role, action: 'schedule.create', outcome: 'denied', meta: { reason: 'cross-tenant teacher' } });
    throw new ForbiddenException('cross-tenant teacher');
  }
  if (teacher.deactivatedAt) {
    audit.log({ actorRole: user.role, action: 'schedule.create', outcome: 'denied', meta: { reason: 'teacher deactivated' } });
    throw new BadRequestException('teacher has been deactivated');
  }

  // 学员存在 + 同 tenant + 未归档 + 课时余额 > 0
  for (const sid of body.studentIds) {
    const stu = store.students.find((s) => s.id === sid);
    if (!stu) throw new BadRequestException(`student ${sid} not found`);
    if (stu.tenantId !== user.tenantId) {
      audit.log({ actorRole: user.role, action: 'schedule.create', outcome: 'denied', meta: { reason: 'cross-tenant student' } });
      throw new ForbiddenException('cross-tenant student');
    }
    if (stu.archivedAt) {
      audit.log({ actorRole: user.role, action: 'schedule.create', outcome: 'denied', meta: { reason: 'student archived' } });
      throw new BadRequestException(`student ${sid} archived`);
    }
    if (stu.remainingHours <= 0) {
      audit.log({ actorRole: user.role, action: 'schedule.create', outcome: 'denied', meta: { reason: 'no balance', studentId: sid } });
      throw new BadRequestException(`student ${sid} has no remaining hours, please renew`);
    }
  }

  // 班型上限
  if (body.classType === 'one-on-one' && body.studentIds.length > 1) {
    throw new BadRequestException('one-on-one only allows 1 student');
  }
  if (body.classType === 'small-class' && body.classCapacity && body.studentIds.length > body.classCapacity) {
    audit.log({
      actorRole: user.role,
      action: 'schedule.create',
      outcome: 'denied',
      meta: { reason: 'small-class capacity exceeded', cap: body.classCapacity, got: body.studentIds.length },
    });
    throw new BadRequestException(`small-class capacity ${body.classCapacity} exceeded`);
  }

  // 老师同时段冲突
  const teacherConflict = store.schedules.some(
    (s) => s.teacherId === body.teacherId && overlaps(s.startAt, s.endAt, body.startAt, body.endAt),
  );
  if (teacherConflict) {
    audit.log({ actorRole: user.role, action: 'schedule.create', outcome: 'denied', meta: { reason: 'teacher time conflict' } });
    throw new BadRequestException('teacher time conflict');
  }

  // 学员同时段冲突
  for (const sid of body.studentIds) {
    const studentConflict = store.schedules.some(
      (s) => s.studentIds.includes(sid) && overlaps(s.startAt, s.endAt, body.startAt, body.endAt),
    );
    if (studentConflict) {
      audit.log({
        actorRole: user.role,
        action: 'schedule.create',
        outcome: 'denied',
        meta: { reason: 'student time conflict', studentId: sid },
      });
      throw new BadRequestException(`student ${sid} time conflict`);
    }
  }

  const schedule: Schedule = {
    id: 'SCH_' + Math.random().toString(36).slice(2, 8).toUpperCase(),
    teacherId: body.teacherId,
    studentIds: body.studentIds,
    startAt: body.startAt,
    endAt: body.endAt,
    classType: body.classType,
    classCapacity: body.classCapacity,
  };
  store.schedules.push(schedule);
  audit.log({ actorRole: user.role, action: 'schedule.create', outcome: 'success', meta: { scheduleId: schedule.id } });
  return schedule;
}

// ---------- Test data ----------

const academic1: MockUser = { sub: 'ACAD01', role: 'academic', tenantId: 'TNT01' };
const academicOther: MockUser = { sub: 'ACAD99', role: 'academic', tenantId: 'TNT99' };
const sales1: MockUser = { sub: 'SAL01', role: 'sales', tenantId: 'TNT01' };

function makeStore(): MockStore {
  const s = new MockStore();
  s.teachers.push({ id: 'T_001', tenantId: 'TNT01' });
  s.teachers.push({ id: 'T_002', tenantId: 'TNT01' });
  s.teachers.push({ id: 'T_OFF', tenantId: 'TNT01', deactivatedAt: new Date('2025-01-01') });
  s.students.push({ id: 'STU_001', tenantId: 'TNT01', remainingHours: 10 });
  s.students.push({ id: 'STU_002', tenantId: 'TNT01', remainingHours: 5 });
  s.students.push({ id: 'STU_ZERO', tenantId: 'TNT01', remainingHours: 0 });
  s.students.push({ id: 'STU_ARCH', tenantId: 'TNT01', archivedAt: new Date('2025-01-01'), remainingHours: 10 });
  return s;
}

const start = new Date('2026-05-20T16:00:00Z');
const end = new Date('2026-05-20T17:00:00Z');

describe('[L8 业务流 B1] 单次排课 (10 case)', () => {
  let store: MockStore;
  let audit: MockAuditLog;

  beforeEach(() => {
    store = makeStore();
    audit = new MockAuditLog();
  });

  it('B1.1 academic 选学员 → 选老师 → 选时段 → submit → schedule created', () => {
    const result = createSchedule(
      academic1,
      { teacherId: 'T_001', studentIds: ['STU_001'], startAt: start, endAt: end, classType: 'one-on-one' },
      store,
      audit,
    );
    expect(result.id).toBeTruthy();
    expect(result.teacherId).toBe('T_001');
    expect(result.studentIds).toEqual(['STU_001']);
    expect(store.schedules).toHaveLength(1);
    const success = audit.byAction('schedule.create').filter((e) => e.outcome === 'success');
    expect(success).toHaveLength(1);
  });

  it('B1.2 同一老师同时段已有课 → 冲突检测 → 拒绝 + 提示', () => {
    createSchedule(
      academic1,
      { teacherId: 'T_001', studentIds: ['STU_001'], startAt: start, endAt: end, classType: 'one-on-one' },
      store,
      audit,
    );
    expect(() =>
      createSchedule(
        academic1,
        { teacherId: 'T_001', studentIds: ['STU_002'], startAt: start, endAt: end, classType: 'one-on-one' },
        store,
        audit,
      ),
    ).toThrow(/teacher time conflict/);
    const denied = audit.byAction('schedule.create').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].meta?.reason).toBe('teacher time conflict');
  });

  it('B1.3 同一学员同时段已有课 → 冲突检测 → 拒绝', () => {
    createSchedule(
      academic1,
      { teacherId: 'T_001', studentIds: ['STU_001'], startAt: start, endAt: end, classType: 'one-on-one' },
      store,
      audit,
    );
    expect(() =>
      createSchedule(
        academic1,
        { teacherId: 'T_002', studentIds: ['STU_001'], startAt: start, endAt: end, classType: 'one-on-one' },
        store,
        audit,
      ),
    ).toThrow(/student .* time conflict/);
    const denied = audit.byAction('schedule.create').filter((e) => e.meta?.reason === 'student time conflict');
    expect(denied).toHaveLength(1);
  });

  it('B1.4 学员 contract 课时余额 0 → 拒绝 + 提示「请续费」', () => {
    expect(() =>
      createSchedule(
        academic1,
        { teacherId: 'T_001', studentIds: ['STU_ZERO'], startAt: start, endAt: end, classType: 'one-on-one' },
        store,
        audit,
      ),
    ).toThrow(/no remaining hours/);
    const denied = audit.byAction('schedule.create').filter((e) => e.meta?.reason === 'no balance');
    expect(denied).toHaveLength(1);
    expect(denied[0].meta?.studentId).toBe('STU_ZERO');
  });

  it('B1.5 班型 = 一对多 → 允许多学员同时段同老师', () => {
    const result = createSchedule(
      academic1,
      {
        teacherId: 'T_001',
        studentIds: ['STU_001', 'STU_002'],
        startAt: start,
        endAt: end,
        classType: 'one-on-many',
      },
      store,
      audit,
    );
    expect(result.studentIds).toEqual(['STU_001', 'STU_002']);
    expect(audit.byAction('schedule.create').filter((e) => e.outcome === 'success')).toHaveLength(1);
  });

  it('B1.6 班型 = 小班课 → 上限学员数检查 (≤ N)', () => {
    // 上限 2, 给 3 个 → 拒绝
    store.students.push({ id: 'STU_003', tenantId: 'TNT01', remainingHours: 10 });
    expect(() =>
      createSchedule(
        academic1,
        {
          teacherId: 'T_001',
          studentIds: ['STU_001', 'STU_002', 'STU_003'],
          startAt: start,
          endAt: end,
          classType: 'small-class',
          classCapacity: 2,
        },
        store,
        audit,
      ),
    ).toThrow(/capacity 2 exceeded/);
    const denied = audit.byAction('schedule.create').filter((e) => e.meta?.reason === 'small-class capacity exceeded');
    expect(denied).toHaveLength(1);
    expect(denied[0].meta?.cap).toBe(2);
    expect(denied[0].meta?.got).toBe(3);

    // 上限 2, 给 2 个 → 通过
    const ok = createSchedule(
      academic1,
      {
        teacherId: 'T_001',
        studentIds: ['STU_001', 'STU_002'],
        startAt: start,
        endAt: end,
        classType: 'small-class',
        classCapacity: 2,
      },
      store,
      audit,
    );
    expect(ok.studentIds).toHaveLength(2);
  });

  it('B1.7 sales 排课 → 403', () => {
    expect(() =>
      createSchedule(
        sales1,
        { teacherId: 'T_001', studentIds: ['STU_001'], startAt: start, endAt: end, classType: 'one-on-one' },
        store,
        audit,
      ),
    ).toThrow(ForbiddenException);
    const denied = audit.byAction('schedule.create').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].actorRole).toBe('sales');
    expect(denied[0].meta?.reason).toBe('role not academic');
  });

  it('B1.8 academic 跨 tenant 排课 → 403 (老师跨租户)', () => {
    expect(() =>
      createSchedule(
        academicOther,
        { teacherId: 'T_001', studentIds: ['STU_001'], startAt: start, endAt: end, classType: 'one-on-one' },
        store,
        audit,
      ),
    ).toThrow(/cross-tenant/);
    const denied = audit.byAction('schedule.create').filter((e) => e.meta?.reason === 'cross-tenant teacher');
    expect(denied).toHaveLength(1);
  });

  it('B1.9 academic 排已离职老师的课 → 拒绝 + 提示', () => {
    expect(() =>
      createSchedule(
        academic1,
        { teacherId: 'T_OFF', studentIds: ['STU_001'], startAt: start, endAt: end, classType: 'one-on-one' },
        store,
        audit,
      ),
    ).toThrow(/deactivated/);
    const denied = audit.byAction('schedule.create').filter((e) => e.meta?.reason === 'teacher deactivated');
    expect(denied).toHaveLength(1);
  });

  it('B1.10 academic 排已归档学员的课 → 拒绝', () => {
    expect(() =>
      createSchedule(
        academic1,
        { teacherId: 'T_001', studentIds: ['STU_ARCH'], startAt: start, endAt: end, classType: 'one-on-one' },
        store,
        audit,
      ),
    ).toThrow(/archived/);
    const denied = audit.byAction('schedule.create').filter((e) => e.meta?.reason === 'student archived');
    expect(denied).toHaveLength(1);
  });
});
