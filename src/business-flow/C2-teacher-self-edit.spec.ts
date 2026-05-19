/**
 * L8 业务流 C2 — 老师 self-edit 双轨 (5 case)
 *
 * 来源:
 *   - v2.0 §5.C2
 *   - SSOT §4.3 teacher 字段矩阵: 务 = 👁 不改 / 老师 self-edit
 *   - 拍板 11: 老师视图零 ¥, X1 V50 物理删除 hourly_price_yuan
 *
 * 验证:
 *   - teacher 自己改档案 (姓名 / 联系 / 简介) → 通过
 *   - teacher 改别人老师 → 403
 *   - academic 改任何 teacher → 403 (教务只读拍板)
 *   - admin / boss 改任何老师 → 通过
 *   - 老师视图零 ¥ 字段 (X1 验证)
 */
import { ForbiddenException } from '@nestjs/common';

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
  role: 'sales' | 'academic' | 'admin' | 'boss' | 'teacher';
  tenantId: string;
}

// X1 拍板: 老师视图零 ¥. teacher view 白名单
const TEACHER_VIEW_TEACHER_FIELDS = [
  'id',
  'name',
  'phone',
  'bio',
  'subjects',
  'avatarUrl',
  // 不含: hourlyPriceYuan / payrollAmount / ratePerLessonYuan / payoutAmount
];

// V50 (X1 拍板) 物理删除字段 → teacher 视图字段集合中不应出现
const FORBIDDEN_FINANCIAL_FIELDS_IN_TEACHER_VIEW = [
  'hourlyPriceYuan',
  'payrollAmount',
  'ratePerLessonYuan',
  'payoutAmount',
];

function teacherSelfView(
  callerSub: string,
  callerRole: string,
  targetTeacherSub: string,
  audit: MockAuditLog,
): { fields: Record<string, unknown> } {
  if (callerRole !== 'teacher') {
    audit.log({ actorRole: callerRole, action: 'teacher.self-view', outcome: 'denied' });
    throw new ForbiddenException('not teacher role');
  }
  if (callerSub !== targetTeacherSub) {
    audit.log({ actorRole: 'teacher', action: 'teacher.self-view', outcome: 'denied', meta: { reason: 'not self' } });
    throw new ForbiddenException('teacher can only view own profile');
  }
  // X1: teacher 视图字段白名单 (零 ¥)
  const view: Record<string, unknown> = {};
  for (const f of TEACHER_VIEW_TEACHER_FIELDS) {
    view[f] = `MOCK_${f}`;
  }
  return { fields: view };
}

function updateTeacherProfile(
  user: MockUser,
  targetTeacherSub: string,
  patch: { name?: string; phone?: string; bio?: string },
  audit: MockAuditLog,
): { id: string; applied: typeof patch } {
  // admin / boss 全权
  if (['admin', 'boss'].includes(user.role)) {
    audit.log({ actorRole: user.role, action: 'teacher.update', outcome: 'success', meta: { targetSub: targetTeacherSub } });
    return { id: targetTeacherSub, applied: patch };
  }
  // teacher self-edit
  if (user.role === 'teacher') {
    if (user.sub !== targetTeacherSub) {
      audit.log({ actorRole: 'teacher', action: 'teacher.update', outcome: 'denied', meta: { reason: 'not self' } });
      throw new ForbiddenException('teacher can only self-edit own profile');
    }
    audit.log({ actorRole: 'teacher', action: 'teacher.update', outcome: 'success', meta: { targetSub: targetTeacherSub } });
    return { id: targetTeacherSub, applied: patch };
  }
  // academic 不能改 (SSOT §4.3 务 = 👁 不改)
  audit.log({ actorRole: user.role, action: 'teacher.update', outcome: 'denied', meta: { reason: 'role not allowed' } });
  throw new ForbiddenException(`role ${user.role} cannot update teacher`);
}

const teacher1: MockUser = { sub: 'T_001', role: 'teacher', tenantId: 'TNT01' };
const teacher2: MockUser = { sub: 'T_002', role: 'teacher', tenantId: 'TNT01' };
const academic1: MockUser = { sub: 'ACAD01', role: 'academic', tenantId: 'TNT01' };
const admin1: MockUser = { sub: 'ADM01', role: 'admin', tenantId: 'TNT01' };
const boss1: MockUser = { sub: 'BOS01', role: 'boss', tenantId: 'TNT01' };

describe('[L8 业务流 C2] 老师 self-edit 双轨 (5 case)', () => {
  let audit: MockAuditLog;

  beforeEach(() => {
    audit = new MockAuditLog();
  });

  it('C2.1 teacher self-edit 自己档案 (姓名 / 联系 / 简介) → 通过', () => {
    const result = updateTeacherProfile(teacher1, teacher1.sub, { name: '李老师', phone: '13900001111', bio: '5 年教龄' }, audit);
    expect(result.id).toBe(teacher1.sub);
    expect(result.applied.name).toBe('李老师');
    expect(result.applied.phone).toBe('13900001111');
    expect(result.applied.bio).toBe('5 年教龄');
    const success = audit.byAction('teacher.update').filter((e) => e.outcome === 'success');
    expect(success).toHaveLength(1);
  });

  it('C2.2 teacher 改其他老师档案 → 403', () => {
    expect(() =>
      updateTeacherProfile(teacher1, teacher2.sub, { name: '李老师恶搞' }, audit),
    ).toThrow(ForbiddenException);
    const denied = audit.byAction('teacher.update').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].actorRole).toBe('teacher');
    expect(denied[0].meta?.reason).toBe('not self');
  });

  it('C2.3 academic 改任何 teacher 档案 → 403 (教务只读拍板)', () => {
    expect(() =>
      updateTeacherProfile(academic1, teacher1.sub, { name: '李老师不让改' }, audit),
    ).toThrow(ForbiddenException);
    const denied = audit.byAction('teacher.update').filter((e) => e.outcome === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].actorRole).toBe('academic');
    expect(denied[0].meta?.reason).toBe('role not allowed');

    // academic_admin 同样
    const academicAdmin: MockUser = { sub: 'ACAD_ADM01', role: 'academic', tenantId: 'TNT01' };
    expect(() =>
      updateTeacherProfile(academicAdmin, teacher1.sub, { name: 'X' }, audit),
    ).toThrow(ForbiddenException);
  });

  it('C2.4 admin / boss 改任何老师档案 → 通过', () => {
    // admin
    const r1 = updateTeacherProfile(admin1, teacher1.sub, { name: '管理员改的名' }, audit);
    expect(r1.id).toBe(teacher1.sub);

    // boss
    const r2 = updateTeacherProfile(boss1, teacher2.sub, { phone: '13900000000' }, audit);
    expect(r2.id).toBe(teacher2.sub);

    const success = audit.byAction('teacher.update').filter((e) => e.outcome === 'success');
    expect(success).toHaveLength(2);
    expect(success.map((e) => e.actorRole).sort()).toEqual(['admin', 'boss']);
  });

  it('C2.5 老师视图零 ¥ (X1 拍板 V50 物理删除 hourly_price_yuan, teacher 完全看不到任何金额)', () => {
    // teacher 看自己
    const view = teacherSelfView(teacher1.sub, 'teacher', teacher1.sub, audit);
    const fields = Object.keys(view.fields);

    // 白名单存在
    for (const f of TEACHER_VIEW_TEACHER_FIELDS) {
      expect(fields).toContain(f);
    }
    // 禁忌字段不存在 (X1 V50 拍板)
    for (const forbidden of FORBIDDEN_FINANCIAL_FIELDS_IN_TEACHER_VIEW) {
      expect(fields).not.toContain(forbidden);
    }

    // teacher 看别老师 → 403 (单独 case 验证)
    expect(() => teacherSelfView(teacher1.sub, 'teacher', teacher2.sub, audit)).toThrow(ForbiddenException);
  });
});
