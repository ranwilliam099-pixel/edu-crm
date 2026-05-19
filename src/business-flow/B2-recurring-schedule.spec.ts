/**
 * L8 业务流 B2 — 周期排课 (6 case, ★ 不跳节假日 拍板 10)
 *
 * 来源:
 *   - v2.0 §5.B2 周期排课
 *   - SSOT §6 recurring_schedule.create=[academic]
 *   - 拍板 10: cron 不跳节假日, 照展开
 *   - 老师离职 → 已生成 schedule cancel + 通知 academic 重排
 *
 * 验证:
 *   - academic 建周期模板 → recurring_schedule created
 *   - cron 每日凌晨展开下周 7 天 schedule
 *   - 模板修改 → 影响未来未生成 schedule
 *   - 模板 archive → 停止展开
 *   - 节假日不跳 (拍板 10)
 *   - 老师离职 → 已生成 schedule cancel + 通知
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';

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

interface RecurringTemplate {
  id: string;
  teacherId: string;
  studentIds: string[];
  weekday: number; // 0-6
  hour: number;
  minute: number;
  durationMin: number;
  archived: boolean;
  startDate: Date;
  endDate: Date;
}

interface Schedule {
  id: string;
  templateId: string;
  teacherId: string;
  studentIds: string[];
  startAt: Date;
  endAt: Date;
  status: 'pending' | 'cancelled';
}

class MockStore {
  templates: RecurringTemplate[] = [];
  schedules: Schedule[] = [];
}

function createRecurring(
  user: MockUser,
  body: {
    teacherId: string;
    studentIds: string[];
    weekday: number;
    hour: number;
    minute: number;
    durationMin: number;
    startDate: Date;
    endDate: Date;
  },
  store: MockStore,
  audit: MockAuditLog,
): RecurringTemplate {
  if (user.role !== 'academic') {
    audit.log({ actorRole: user.role, action: 'recurring.create', outcome: 'denied', meta: { reason: 'role not academic' } });
    throw new ForbiddenException(`role ${user.role} cannot create recurring`);
  }
  const t: RecurringTemplate = {
    id: 'RT_' + Math.random().toString(36).slice(2, 8).toUpperCase(),
    teacherId: body.teacherId,
    studentIds: body.studentIds,
    weekday: body.weekday,
    hour: body.hour,
    minute: body.minute,
    durationMin: body.durationMin,
    archived: false,
    startDate: body.startDate,
    endDate: body.endDate,
  };
  store.templates.push(t);
  audit.log({ actorRole: user.role, action: 'recurring.create', outcome: 'success', meta: { templateId: t.id } });
  return t;
}

// 拍板 10: 不跳节假日 (e.g. 春节, 国庆)
const HOLIDAYS = new Set([
  '2026-10-01',
  '2026-10-02',
  '2026-10-03',
  '2026-02-17', // 春节
]);

// cron 每日 02:00 展开下 7 天
function cronExpand(
  store: MockStore,
  now: Date,
  // 拍板 10: 节假日不跳, daysToExpand 不过滤 HOLIDAYS
): Schedule[] {
  const expanded: Schedule[] = [];
  for (const t of store.templates) {
    if (t.archived) continue;
    for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
      const d = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
      // 范围
      if (d < t.startDate || d > t.endDate) continue;
      // weekday 不匹配
      if (d.getUTCDay() !== t.weekday) continue;
      // 拍板 10: 节假日不跳, 照展开
      // (此处特意不过滤 HOLIDAYS, 验证不跳行为)

      // 已生成过?
      const startAt = new Date(d);
      startAt.setUTCHours(t.hour, t.minute, 0, 0);
      const exists = store.schedules.some(
        (s) =>
          s.templateId === t.id &&
          s.startAt.toISOString() === startAt.toISOString() &&
          s.status === 'pending',
      );
      if (exists) continue;

      const endAt = new Date(startAt.getTime() + t.durationMin * 60 * 1000);
      const sch: Schedule = {
        id: 'SCH_' + Math.random().toString(36).slice(2, 8).toUpperCase(),
        templateId: t.id,
        teacherId: t.teacherId,
        studentIds: t.studentIds,
        startAt,
        endAt,
        status: 'pending',
      };
      store.schedules.push(sch);
      expanded.push(sch);
    }
  }
  return expanded;
}

function updateRecurring(
  user: MockUser,
  templateId: string,
  patch: Partial<Pick<RecurringTemplate, 'hour' | 'minute' | 'durationMin'>>,
  store: MockStore,
  audit: MockAuditLog,
): RecurringTemplate {
  if (user.role !== 'academic') throw new ForbiddenException('not academic');
  const t = store.templates.find((x) => x.id === templateId);
  if (!t) throw new BadRequestException('template not found');
  Object.assign(t, patch);
  audit.log({ actorRole: user.role, action: 'recurring.update', outcome: 'success', meta: { templateId } });
  return t;
}

function archiveRecurring(user: MockUser, templateId: string, store: MockStore, audit: MockAuditLog): void {
  if (user.role !== 'academic') throw new ForbiddenException('not academic');
  const t = store.templates.find((x) => x.id === templateId);
  if (!t) throw new BadRequestException('template not found');
  t.archived = true;
  audit.log({ actorRole: user.role, action: 'recurring.archive', outcome: 'success', meta: { templateId } });
}

function onTeacherOffboard(teacherId: string, store: MockStore, audit: MockAuditLog): { cancelled: Schedule[]; notified: boolean } {
  const cancelled: Schedule[] = [];
  for (const s of store.schedules) {
    if (s.teacherId === teacherId && s.status === 'pending') {
      s.status = 'cancelled';
      cancelled.push(s);
    }
  }
  audit.log({
    actorRole: 'system',
    action: 'teacher.offboard-cascade-cancel',
    outcome: 'success',
    meta: { teacherId, cancelCount: cancelled.length, notifyAcademic: true },
  });
  return { cancelled, notified: true };
}

// ---------- Test data ----------

const academic1: MockUser = { sub: 'ACAD01', role: 'academic', tenantId: 'TNT01' };
const sales1: MockUser = { sub: 'SAL01', role: 'sales', tenantId: 'TNT01' };

describe('[L8 业务流 B2] 周期排课 (6 case, 不跳节假日)', () => {
  let store: MockStore;
  let audit: MockAuditLog;

  beforeEach(() => {
    store = new MockStore();
    audit = new MockAuditLog();
  });

  it('B2.1 academic 建周期模板 (每周二 16:00-18:00 × 10 周) → recurring_schedule created', () => {
    const tpl = createRecurring(
      academic1,
      {
        teacherId: 'T_001',
        studentIds: ['STU_001'],
        weekday: 2, // Tuesday
        hour: 16,
        minute: 0,
        durationMin: 120,
        startDate: new Date('2026-05-19T00:00:00Z'),
        endDate: new Date('2026-07-28T23:59:59Z'),
      },
      store,
      audit,
    );
    expect(tpl.weekday).toBe(2);
    expect(tpl.hour).toBe(16);
    expect(tpl.archived).toBe(false);
    expect(store.templates).toHaveLength(1);
    expect(audit.byAction('recurring.create').filter((e) => e.outcome === 'success')).toHaveLength(1);

    // sales 试图建 → 403
    expect(() =>
      createRecurring(
        sales1,
        {
          teacherId: 'T_001',
          studentIds: ['STU_001'],
          weekday: 2,
          hour: 16,
          minute: 0,
          durationMin: 120,
          startDate: new Date('2026-05-19'),
          endDate: new Date('2026-07-28'),
        },
        store,
        audit,
      ),
    ).toThrow(ForbiddenException);
  });

  it('B2.2 cron 每日凌晨展开下周 7 天 schedule', () => {
    createRecurring(
      academic1,
      {
        teacherId: 'T_001',
        studentIds: ['STU_001'],
        weekday: 2, // Tuesday
        hour: 16,
        minute: 0,
        durationMin: 120,
        startDate: new Date('2026-05-19T00:00:00Z'),
        endDate: new Date('2026-07-28T23:59:59Z'),
      },
      store,
      audit,
    );
    // cron @ Mon 02:00, expand 7 days ahead
    const cronTime = new Date('2026-05-18T02:00:00Z'); // Monday
    const expanded = cronExpand(store, cronTime);
    // 7 天里有 1 个 Tuesday (5/19) 在 weekday=2
    expect(expanded).toHaveLength(1);
    expect(expanded[0].startAt.toISOString()).toBe('2026-05-19T16:00:00.000Z');
    expect(expanded[0].endAt.toISOString()).toBe('2026-05-19T18:00:00.000Z');

    // 再跑一次同 cron → 不重复生成
    const expandedAgain = cronExpand(store, cronTime);
    expect(expandedAgain).toHaveLength(0);
    expect(store.schedules).toHaveLength(1);
  });

  it('B2.3 周期模板修改 → 影响未来未生成 schedule, 不影响已生成的', () => {
    const tpl = createRecurring(
      academic1,
      {
        teacherId: 'T_001',
        studentIds: ['STU_001'],
        weekday: 2,
        hour: 16,
        minute: 0,
        durationMin: 120,
        startDate: new Date('2026-05-19T00:00:00Z'),
        endDate: new Date('2026-07-28T23:59:59Z'),
      },
      store,
      audit,
    );
    // expand first batch
    cronExpand(store, new Date('2026-05-18T02:00:00Z'));
    const before = store.schedules[0].startAt;
    expect(before.getUTCHours()).toBe(16);

    // modify template (16:00 → 18:00)
    updateRecurring(academic1, tpl.id, { hour: 18 }, store, audit);

    // 已生成的 schedule 不动 (16:00)
    expect(store.schedules[0].startAt.getUTCHours()).toBe(16);

    // expand next week → use new hour
    const nextWeek = new Date('2026-05-25T02:00:00Z'); // next Monday
    const next = cronExpand(store, nextWeek);
    expect(next).toHaveLength(1);
    expect(next[0].startAt.getUTCHours()).toBe(18); // new
  });

  it('B2.4 周期模板 archive → 停止展开', () => {
    const tpl = createRecurring(
      academic1,
      {
        teacherId: 'T_001',
        studentIds: ['STU_001'],
        weekday: 2,
        hour: 16,
        minute: 0,
        durationMin: 120,
        startDate: new Date('2026-05-19T00:00:00Z'),
        endDate: new Date('2026-07-28T23:59:59Z'),
      },
      store,
      audit,
    );
    archiveRecurring(academic1, tpl.id, store, audit);

    // cron 跑 → 不展开
    const expanded = cronExpand(store, new Date('2026-05-18T02:00:00Z'));
    expect(expanded).toHaveLength(0);
    expect(store.schedules).toHaveLength(0);
    expect(audit.byAction('recurring.archive')).toHaveLength(1);
  });

  it('B2.5 节假日不跳, cron 照展开 (拍板 10)', () => {
    // 10/1 国庆是 Thursday (2026-10-01)
    createRecurring(
      academic1,
      {
        teacherId: 'T_001',
        studentIds: ['STU_001'],
        weekday: 4, // Thursday
        hour: 16,
        minute: 0,
        durationMin: 120,
        startDate: new Date('2026-09-30T00:00:00Z'),
        endDate: new Date('2026-10-10T23:59:59Z'),
      },
      store,
      audit,
    );
    const expanded = cronExpand(store, new Date('2026-09-30T02:00:00Z'));
    // 10/1 节假日是 holiday, 但拍板 10: 不跳 → 照展开
    const dates = expanded.map((s) => s.startAt.toISOString().slice(0, 10));
    expect(dates).toContain('2026-10-01');
    // 节假日 set 里确实包含
    expect(HOLIDAYS.has('2026-10-01')).toBe(true);
  });

  it('B2.6 老师离职 → 已生成 schedule 自动 cancel + 通知 academic 重排', () => {
    createRecurring(
      academic1,
      {
        teacherId: 'T_001',
        studentIds: ['STU_001'],
        weekday: 2,
        hour: 16,
        minute: 0,
        durationMin: 120,
        startDate: new Date('2026-05-19T00:00:00Z'),
        endDate: new Date('2026-07-28T23:59:59Z'),
      },
      store,
      audit,
    );
    // expand 多周
    cronExpand(store, new Date('2026-05-18T02:00:00Z'));
    cronExpand(store, new Date('2026-05-25T02:00:00Z'));
    expect(store.schedules.length).toBeGreaterThanOrEqual(2);
    const beforeCount = store.schedules.length;

    // 老师离职
    const result = onTeacherOffboard('T_001', store, audit);
    expect(result.cancelled).toHaveLength(beforeCount);
    expect(result.notified).toBe(true);
    expect(store.schedules.every((s) => s.status === 'cancelled')).toBe(true);

    const cascade = audit.byAction('teacher.offboard-cascade-cancel');
    expect(cascade).toHaveLength(1);
    expect(cascade[0].meta?.notifyAcademic).toBe(true);
    expect(cascade[0].meta?.cancelCount).toBe(beforeCount);
  });
});
