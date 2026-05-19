/**
 * monthly-report.repository.integration.spec.ts — Day 3 Phase B.L2 priority spec #10
 *
 * 触发：V9 + V36 双轨 audience 隔离（C 端家长 vs 老师内部）
 *   - V9 monthly_reports — 月报基础表
 *   - V36 加 5 列 parent_* — 家长视角隔离
 *   - 双轨硬红线：audience='parent' 路径 SQL SELECT 不查 renewal_suggestion + mapRow 兜底
 *   - UNIQUE (student_id, month) — 一学员每月一份
 *
 * 必测 case：
 *   1. insert + UPSERT (ON CONFLICT student_id, month)
 *   2. findById audience='teacher' — 完整字段
 *   3. findById audience='parent' — renewalSuggestion 永远 undefined
 *   4. findByStudentMonth — 双 audience 切换
 *   5. listByStudent — ORDER month DESC
 *   6. listPendingFinalize — status='auto_generated' 过滤
 *   7. finalizeTeacher — auditCtx 必填 + status 切换 + audit_log 写入
 *   8. finalizeParent — 仅写 parent_* 5 字段，不动 status + audit_log 写入（snapshotParent 不含 renewal_suggestion）
 *   9. markParentRead 幂等
 *  10. schema drift: DROP renewal_suggestion 列 → teacher SELECT 必失败（parent 不查不受影响）
 */

import { Pool } from 'pg';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  createTestSchema,
  dropTestSchema,
  getTestPool,
  closeTestPool,
  runInSchema,
  seedCampus,
  seedAdminUser,
  seedCustomer,
  seedStudent,
  testUlid,
} from './setup';
import { MonthlyReportRepository } from '../../src/modules/db/monthly-report.repository';
import { AuditLogRepository } from '../../src/modules/db/audit-log.repository';
import { PgPoolService } from '../../src/modules/db/pg-pool.service';

describe('MonthlyReportRepository [integration, real PG, V9 + V36 双轨]', () => {
  let pool: Pool;
  let schema: string;
  let repo: MonthlyReportRepository;
  let pgService: PgPoolService;
  let auditLogRepo: AuditLogRepository;
  let campusId: string;
  let adminId: string;
  let teacherId: string;
  let studentId: string;
  let operatorUuid: string;

  const mockConfig = {
    get: (key: string, def?: any) => {
      const map: Record<string, any> = {
        DB_HOST: 'localhost',
        DB_PORT: '5433',
        DB_USER: 'eduapp',
        DB_PASSWORD: 'testpassword',
        DB_NAME: 'edu_test',
        DB_POOL_MAX: '5',
        DB_STATEMENT_TIMEOUT_MS: '10000',
      };
      return map[key] ?? def;
    },
  };

  beforeAll(async () => {
    pool = getTestPool();
    schema = await createTestSchema('monthly-report');
    pgService = new PgPoolService(mockConfig as any);
    auditLogRepo = new AuditLogRepository(pgService);
    repo = new MonthlyReportRepository(pgService, auditLogRepo);

    const campus = await seedCampus(schema);
    campusId = campus.id;
    const admin = await seedAdminUser(schema, campusId);
    adminId = admin.id;

    teacherId = testUlid();
    await runInSchema(schema, async (c) => {
      await c.query(
        `INSERT INTO ${schema}.teachers
           (id, name, phone, status, hire_date, created_by, updated_by, campus_id)
         VALUES ($1, '月报老师', '13900001300', '在职', NOW(), $2, $2, $3)`,
        [teacherId, adminId, campusId],
      );
    });

    const cust = await seedCustomer(schema, campusId, adminId);
    studentId = (await seedStudent(schema, cust.id)).id;

    operatorUuid = randomUUID();
  }, 30000);

  afterAll(async () => {
    await pgService.onModuleDestroy();
    await dropTestSchema(schema);
    await closeTestPool();
  });

  // ----------------------------------------------------------------
  // Helper: 灌一份月报
  // ----------------------------------------------------------------
  const buildReport = (id: string, month: Date) => ({
    id,
    studentId,
    teacherId,
    month,
    attendanceSummary: { totalLessons: 8, attendedLessons: 7 },
    performanceTrend: { avgScore: 88 },
    knowledgeSummary: { mastered: ['加法', '减法'], weak: ['乘法'] },
    teacherBlessing: null,
    renewalSuggestion: null,
    status: 'auto_generated',
    generatedAt: new Date(),
  });

  // ----------------------------------------------------------------
  // Case 1: insert + UPSERT (student_id, month)
  // ----------------------------------------------------------------
  it('insert UPSERT ON CONFLICT (student_id, month)', async () => {
    const r1Id = testUlid();
    const r1 = await repo.insert(schema, buildReport(r1Id, new Date('2026-05-01')) as any);
    expect(r1.id).toBe(r1Id);
    expect(r1.status).toBe('auto_generated');

    // UPSERT 同 (student, month) — 应更新 attendance_summary 等
    const r1v2 = await repo.insert(schema, {
      ...buildReport(r1Id, new Date('2026-05-01')),
      attendanceSummary: { totalLessons: 10, attendedLessons: 9 },
    } as any);
    expect(r1v2.attendanceSummary).toEqual({ totalLessons: 10, attendedLessons: 9 });
  });

  // ----------------------------------------------------------------
  // Case 2: findById audience='teacher' 完整字段
  // ----------------------------------------------------------------
  it('findById audience=teacher — 完整字段含 renewalSuggestion 可填', async () => {
    // 灌一份带 renewal_suggestion 的月报（直接 SQL）
    const id = testUlid();
    await runInSchema(schema, async (c) => {
      await c.query(
        `INSERT INTO ${schema}.monthly_reports
           (id, student_id, teacher_id, month,
            attendance_summary, performance_trend, knowledge_summary,
            teacher_blessing, renewal_suggestion, status, generated_at)
         VALUES ($1, $2, $3, '2026-04-01', '{}', '{}', '{}',
                 '加油', '建议续报', 'teacher_finalized', NOW())`,
        [id, studentId, teacherId],
      );
    });

    const teacherView = await repo.findById(schema, id, 'teacher');
    expect(teacherView).not.toBeNull();
    expect(teacherView!.teacherBlessing).toBe('加油');
    expect(teacherView!.renewalSuggestion).toBe('建议续报');
  });

  // ----------------------------------------------------------------
  // Case 3: findById audience='parent' renewalSuggestion 永远 undefined
  // ----------------------------------------------------------------
  it('findById audience=parent — renewalSuggestion 永远 undefined（V36 双轨硬红线）', async () => {
    // 沿用 Case 2 月报
    const teacherRows = await runInSchema(schema, async (c) => {
      const r = await c.query<{ id: string }>(
        `SELECT id FROM ${schema}.monthly_reports WHERE renewal_suggestion = '建议续报' LIMIT 1`,
      );
      return r.rows;
    });
    expect(teacherRows.length).toBeGreaterThanOrEqual(1);

    const parentView = await repo.findById(schema, teacherRows[0].id, 'parent');
    expect(parentView).not.toBeNull();
    expect(parentView!.renewalSuggestion).toBeUndefined(); // 双轨硬红线
    expect(parentView!.teacherBlessing).toBe('加油'); // teacherBlessing 仍可见
  });

  // ----------------------------------------------------------------
  // Case 4: findByStudentMonth — 双 audience 切换
  // ----------------------------------------------------------------
  it('findByStudentMonth — 双 audience 切换', async () => {
    const month = new Date('2026-04-01');
    const teacherView = await repo.findByStudentMonth(schema, studentId, month, 'teacher');
    expect(teacherView).not.toBeNull();
    expect(teacherView!.renewalSuggestion).toBe('建议续报');

    const parentView = await repo.findByStudentMonth(schema, studentId, month, 'parent');
    expect(parentView).not.toBeNull();
    expect(parentView!.renewalSuggestion).toBeUndefined();

    // 不存在月份返 null
    const notFound = await repo.findByStudentMonth(
      schema,
      studentId,
      new Date('2025-01-01'),
      'parent',
    );
    expect(notFound).toBeNull();
  });

  // ----------------------------------------------------------------
  // Case 5: listByStudent ORDER month DESC
  // ----------------------------------------------------------------
  it('listByStudent — ORDER month DESC', async () => {
    const items = await repo.listByStudent(schema, studentId, 'parent');
    expect(items.length).toBeGreaterThanOrEqual(2); // Case 1 (5月) + Case 2 (4月)
    // 单调递减 month
    for (let i = 1; i < items.length; i++) {
      expect(items[i - 1].month.getTime()).toBeGreaterThanOrEqual(items[i].month.getTime());
    }
    // parent audience：全部 renewalSuggestion undefined
    items.forEach((it) => expect(it.renewalSuggestion).toBeUndefined());
  });

  // ----------------------------------------------------------------
  // Case 6: listPendingFinalize status='auto_generated' 过滤
  // ----------------------------------------------------------------
  it('listPendingFinalize — 仅 status=auto_generated', async () => {
    const pending = await repo.listPendingFinalize(schema, teacherId);
    pending.forEach((p) => expect(p.status).toBe('auto_generated'));

    // 不传 teacherId（全租户）
    const allPending = await repo.listPendingFinalize(schema);
    expect(allPending.length).toBeGreaterThanOrEqual(pending.length);
  });

  // ----------------------------------------------------------------
  // Case 7: finalizeTeacher — 切 status + audit_log 写入
  // ----------------------------------------------------------------
  it('finalizeTeacher — auditCtx 必填 + status=teacher_finalized + audit_log', async () => {
    // 找一个 auto_generated
    const pending = await repo.listPendingFinalize(schema, teacherId);
    expect(pending.length).toBeGreaterThanOrEqual(1);
    const rid = pending[0].id;

    // 缺 auditCtx → BadRequestException
    await expect(
      repo.finalizeTeacher(schema, rid, 'bless', 'suggest', undefined as any),
    ).rejects.toThrow(BadRequestException);
    await expect(
      repo.finalizeTeacher(schema, rid, 'bless', 'suggest', { actorRole: 'teacher' } as any),
    ).rejects.toThrow(BadRequestException);

    // 正常 finalize
    const updated = await repo.finalizeTeacher(schema, rid, '继续加油', '建议续报', {
      operatorUserId: operatorUuid,
      actorRole: 'teacher',
      ip: '192.168.1.1',
      userAgent: 'test',
      requestId: 'req-001',
    } as any);
    expect(updated.status).toBe('teacher_finalized');
    expect(updated.teacherBlessing).toBe('继续加油');

    // audit_log 应有一条 monthly-report.finalize-teacher
    const auditEntries = await auditLogRepo.list(schema, {
      action: 'monthly-report.finalize-teacher',
      targetId: rid,
    });
    expect(auditEntries.length).toBeGreaterThanOrEqual(1);
    expect(auditEntries[0].actorRole).toBe('teacher');

    // 已 finalize → 再次 finalize 抛 NotFound（status != auto_generated）
    await expect(
      repo.finalizeTeacher(schema, rid, 'x', 'x', {
        operatorUserId: operatorUuid,
        actorRole: 'teacher',
      } as any),
    ).rejects.toThrow(NotFoundException);
  });

  // ----------------------------------------------------------------
  // Case 8: finalizeParent — 仅写 parent_* + audit_log 不泄漏 renewal_suggestion
  // ----------------------------------------------------------------
  it('finalizeParent — 写 parent_* 5 字段 + audit_log snapshotParent 不含 renewalSuggestion', async () => {
    // 灌一份新 auto_generated 给 finalizeParent 测试
    const rid = testUlid();
    await repo.insert(schema, buildReport(rid, new Date('2026-03-01')) as any);

    // 缺 parentBlessing → BadRequestException
    await expect(
      repo.finalizeParent(
        schema,
        rid,
        { parentBlessing: '' } as any,
        { operatorUserId: operatorUuid, actorRole: 'teacher' } as any,
      ),
    ).rejects.toThrow(BadRequestException);

    // 缺 auditCtx → BadRequestException
    await expect(
      repo.finalizeParent(
        schema,
        rid,
        { parentBlessing: 'good' } as any,
        undefined as any,
      ),
    ).rejects.toThrow(BadRequestException);

    // 正常 finalize parent
    const updated = await repo.finalizeParent(
      schema,
      rid,
      {
        parentBlessing: '本月很棒',
        parentHighlights: [{ icon: 'star', label: '加法满分' }],
        parentImprovements: [{ label: '加快计算速度', priority: 'medium' }],
        parentNextPlan: '6 月加强乘法',
      } as any,
      {
        operatorUserId: operatorUuid,
        actorRole: 'teacher',
        ip: '192.168.1.1',
      } as any,
    );
    expect(updated.parentBlessing).toBe('本月很棒');
    expect(updated.parentHighlights).toEqual([{ icon: 'star', label: '加法满分' }]);
    expect(updated.parentNextPlan).toBe('6 月加强乘法');
    expect(updated.parentFinalizedAt).toBeInstanceOf(Date);
    expect(updated.status).toBe('auto_generated'); // finalizeParent 不动 status

    // audit_log snapshot 不应含 renewalSuggestion 字段（hardline）
    const auditEntries = await auditLogRepo.list(schema, {
      action: 'monthly-report.finalize-parent',
      targetId: rid,
    });
    expect(auditEntries.length).toBeGreaterThanOrEqual(1);
    const after = auditEntries[0].after as Record<string, unknown>;
    expect(after).not.toHaveProperty('renewalSuggestion');
    expect(after).toHaveProperty('parentBlessing');
    expect(after.parentBlessing).toBe('本月很棒');
  });

  // ----------------------------------------------------------------
  // Case 9: markParentRead 幂等
  // ----------------------------------------------------------------
  it('markParentRead 幂等 — COALESCE 保留首次 parent_read_at', async () => {
    const items = await repo.listByStudent(schema, studentId, 'teacher');
    expect(items.length).toBeGreaterThanOrEqual(1);
    const rid = items[0].id;

    const r1 = await repo.markParentRead(schema, rid);
    expect(r1.parentReadAt).toBeInstanceOf(Date);
    const firstReadAt = r1.parentReadAt!.getTime();

    await new Promise((res) => setTimeout(res, 50));
    const r2 = await repo.markParentRead(schema, rid);
    expect(r2.parentReadAt!.getTime()).toBe(firstReadAt);

    // NotFound
    await expect(repo.markParentRead(schema, testUlid())).rejects.toThrow(NotFoundException);
  });

  // ----------------------------------------------------------------
  // Case 10: schema drift — DROP renewal_suggestion → teacher SELECT 必失败 / parent 不受影响
  // ----------------------------------------------------------------
  it('schema drift: DROP renewal_suggestion → teacher findById 必失败 / parent findById 仍正常', async () => {
    const driftSchema = await createTestSchema('mr-drift');
    try {
      // seed deps
      const cam = await seedCampus(driftSchema);
      const ad = await seedAdminUser(driftSchema, cam.id);
      const tch = testUlid();
      await runInSchema(driftSchema, async (c) => {
        await c.query(
          `INSERT INTO ${driftSchema}.teachers
             (id, name, phone, status, hire_date, created_by, updated_by, campus_id)
           VALUES ($1, '老师', '13900008813', '在职', NOW(), $2, $2, $3)`,
          [tch, ad.id, cam.id],
        );
      });
      const cust = await seedCustomer(driftSchema, cam.id, ad.id);
      const stu = await seedStudent(driftSchema, cust.id);

      // 灌一份月报（含 renewal_suggestion 列）
      const rid = testUlid();
      const driftRepo = new MonthlyReportRepository(pgService, auditLogRepo);
      await driftRepo.insert(driftSchema, {
        id: rid,
        studentId: stu.id,
        teacherId: tch,
        month: new Date('2026-05-01'),
        attendanceSummary: {},
        performanceTrend: {},
        knowledgeSummary: {},
        teacherBlessing: null,
        renewalSuggestion: null,
        status: 'auto_generated',
        generatedAt: new Date(),
      } as any);

      // DROP renewal_suggestion
      await runInSchema(driftSchema, async (c) => {
        await c.query(
          `ALTER TABLE ${driftSchema}.monthly_reports DROP COLUMN renewal_suggestion`,
        );
      });

      // teacher SELECT 必失败 — SELECT renewal_suggestion 不存在
      await expect(driftRepo.findById(driftSchema, rid, 'teacher')).rejects.toThrow(
        /42703|renewal_suggestion|column|does not exist/i,
      );

      // parent SELECT 不查 renewal_suggestion — 仍能正常工作
      const parentView = await driftRepo.findById(driftSchema, rid, 'parent');
      expect(parentView).not.toBeNull();
      expect(parentView!.renewalSuggestion).toBeUndefined();
    } finally {
      await dropTestSchema(driftSchema);
    }
  });
});
