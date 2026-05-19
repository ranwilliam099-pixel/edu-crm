/**
 * L8 业务流 F4 — 学员归档 (3 case)
 *
 * 来源:
 *   - v2.0 §5.F4
 *   - SSOT §6 student.archive=[admin, boss, sales_manager]
 *
 * 验证:
 *   - admin 归档学员 (student.archived_at)
 *   - student 有 active contract → 拒绝归档 (先 archive contract)
 *   - student 有未来 schedule → 拒绝归档 (先 cancel)
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
  role: 'sales' | 'sales_manager' | 'academic' | 'admin' | 'boss' | 'teacher' | 'parent';
}

interface Student {
  id: string;
  archivedAt?: Date;
}

interface Contract {
  id: string;
  studentId: string;
  status: 'active' | 'archived';
}

interface Schedule {
  id: string;
  studentId: string;
  startAt: Date;
  status: 'pending' | 'cancelled' | 'completed';
}

class MockStore {
  students: Map<string, Student> = new Map();
  contracts: Contract[] = [];
  schedules: Schedule[] = [];
}

function archiveStudent(
  user: MockUser,
  studentId: string,
  store: MockStore,
  audit: MockAuditLog,
  now: Date = new Date(),
): Student {
  if (!['admin', 'boss', 'sales_manager'].includes(user.role)) {
    audit.log({ actorRole: user.role, action: 'student.archive', outcome: 'denied', meta: { reason: 'role not allowed' } });
    throw new ForbiddenException(`role ${user.role} cannot archive student`);
  }
  const stu = store.students.get(studentId);
  if (!stu) throw new BadRequestException('student not found');

  // 检查 active contract
  const activeContracts = store.contracts.filter((c) => c.studentId === studentId && c.status === 'active');
  if (activeContracts.length > 0) {
    audit.log({
      actorRole: user.role,
      action: 'student.archive',
      outcome: 'denied',
      meta: { reason: 'has active contract', count: activeContracts.length, contractIds: activeContracts.map((c) => c.id) },
    });
    throw new BadRequestException(`student has ${activeContracts.length} active contract(s); archive contract first`);
  }

  // 检查未来 schedule
  const futureSchedules = store.schedules.filter(
    (s) => s.studentId === studentId && s.status === 'pending' && s.startAt > now,
  );
  if (futureSchedules.length > 0) {
    audit.log({
      actorRole: user.role,
      action: 'student.archive',
      outcome: 'denied',
      meta: { reason: 'has future schedule', count: futureSchedules.length, scheduleIds: futureSchedules.map((s) => s.id) },
    });
    throw new BadRequestException(`student has ${futureSchedules.length} future schedule(s); cancel first`);
  }

  stu.archivedAt = now;
  audit.log({
    actorRole: user.role,
    action: 'student.archive',
    outcome: 'success',
    meta: { studentId, archivedAt: now.toISOString() },
  });
  return stu;
}

// ---------- Test data ----------

const admin1: MockUser = { sub: 'ADM01', role: 'admin' };
const sales1: MockUser = { sub: 'SAL01', role: 'sales' };

describe('[L8 业务流 F4] 学员归档 (3 case)', () => {
  let store: MockStore;
  let audit: MockAuditLog;
  const now = new Date('2026-05-19T10:00:00Z');

  beforeEach(() => {
    store = new MockStore();
    audit = new MockAuditLog();
  });

  it('F4.1 admin 归档学员 (student.archived_at)', () => {
    store.students.set('STU_001', { id: 'STU_001' });
    const stu = archiveStudent(admin1, 'STU_001', store, audit, now);
    expect(stu.archivedAt).toEqual(now);
    expect(audit.byAction('student.archive').filter((e) => e.outcome === 'success')).toHaveLength(1);

    // sales 不能归档
    store.students.set('STU_002', { id: 'STU_002' });
    expect(() => archiveStudent(sales1, 'STU_002', store, audit)).toThrow(ForbiddenException);
    expect(store.students.get('STU_002')?.archivedAt).toBeUndefined();
    const denied = audit.byAction('student.archive').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].meta?.reason).toBe('role not allowed');
  });

  it('F4.2 student 有 active contract → 拒绝归档 (先 archive contract)', () => {
    store.students.set('STU_001', { id: 'STU_001' });
    store.contracts.push({ id: 'CONTRACT_01', studentId: 'STU_001', status: 'active' });

    expect(() => archiveStudent(admin1, 'STU_001', store, audit, now)).toThrow(BadRequestException);
    const denied = audit.byAction('student.archive').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].meta?.reason).toBe('has active contract');
    expect(denied[0].meta?.count).toBe(1);
    expect(store.students.get('STU_001')?.archivedAt).toBeUndefined();

    // archive contract → 再 archive student → OK
    store.contracts[0].status = 'archived';
    const stu = archiveStudent(admin1, 'STU_001', store, audit, now);
    expect(stu.archivedAt).toEqual(now);
  });

  it('F4.3 student 有未来 schedule → 拒绝归档 (先 cancel)', () => {
    store.students.set('STU_001', { id: 'STU_001' });
    store.schedules.push({
      id: 'SCH_FUTURE',
      studentId: 'STU_001',
      startAt: new Date('2026-05-20T16:00:00Z'),
      status: 'pending',
    });

    expect(() => archiveStudent(admin1, 'STU_001', store, audit, now)).toThrow(BadRequestException);
    const denied = audit.byAction('student.archive').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].meta?.reason).toBe('has future schedule');

    // 过去 schedule (已经完成) 不阻挡
    store.schedules[0].status = 'cancelled';
    store.schedules.push({
      id: 'SCH_PAST',
      studentId: 'STU_001',
      startAt: new Date('2026-04-01T16:00:00Z'),
      status: 'completed',
    });

    const stu = archiveStudent(admin1, 'STU_001', store, audit, now);
    expect(stu.archivedAt).toEqual(now);
  });
});
