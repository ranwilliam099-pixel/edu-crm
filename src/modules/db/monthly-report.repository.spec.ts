import { Test } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { MonthlyReportRepository } from './monthly-report.repository';
import { PgPoolService } from './pg-pool.service';
import { AuditLogRepository } from './audit-log.repository';
import {
  MonthlyReport,
  FinalizeAuditContext,
  FinalizeParentPayload,
} from '../feedback/monthly-report.service';

/**
 * MonthlyReportRepository unit tests
 *
 * V9 基础（向后兼容）：
 *   - insert / findById / findByStudentMonth / listByStudent / listPendingFinalize
 *   - finalizeTeacher（原 finalize 拆分；行为不变 + 新增可选 audit_log）
 *   - markParentRead（idempotent COALESCE）
 *
 * V36 双轨 audience 拓展：
 *   - findById / findByStudentMonth / listByStudent 加 audience 参数
 *   - audience='parent' 时 SELECT 列不含 renewal_suggestion（SQL 层天然遮蔽）
 *   - mapRow 双重防护：哪怕 SELECT 漏写，audience='parent' 仍兜底不暴露
 *   - finalizeTeacher 新参数 auditCtx (可选)：传时记 'monthly-report.finalize-teacher'
 *   - finalizeParent 新方法：写 parent_* 5 字段 + parent_finalized_at=NOW()
 *   - finalizeParent audit_log: 'monthly-report.finalize-parent'，snapshot 仅 parent_* 不泄漏 renewal
 *   - finalizeParent operator 校验（缺失 → BadRequestException）
 */

describe('MonthlyReportRepository (V9 + V36)', () => {
  let repo: MonthlyReportRepository;
  let pg: { tenantQuery: jest.Mock; query: jest.Mock; withClient: jest.Mock };
  let audit: { log: jest.Mock };

  const TENANT = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const OPERATOR = 'usr00000000000000000000000000A001';
  const MONTH = new Date('2026-05-01');

  const AUDIT_CTX: FinalizeAuditContext = {
    operatorUserId: OPERATOR,
    actorRole: 'teacher',
    ip: '1.2.3.4',
    userAgent: 'WeChatMP/8.0.45',
    requestId: 'req-abc-123',
  };

  const SAMPLE: MonthlyReport = {
    id: 'report000000000000000000000000A',
    studentId: 'stu00000000000000000000000000A001',
    teacherId: 'teach000000000000000000000000A001',
    month: MONTH,
    attendanceSummary: { total: 8, '出勤': 7, '迟到': 1, '缺席': 0, '请假': 0 },
    performanceTrend: [{ date: '2026-05-01', performance: '良好' }],
    knowledgeSummary: [{ name: '函数', mastery: '良好', lessonCount: 4 }],
    status: 'auto_generated',
    generatedAt: new Date('2026-05-01T00:30:00Z'),
  };

  const ROW = {
    id: SAMPLE.id,
    student_id: SAMPLE.studentId,
    teacher_id: SAMPLE.teacherId,
    month: SAMPLE.month,
    attendance_summary: SAMPLE.attendanceSummary,
    performance_trend: SAMPLE.performanceTrend,
    knowledge_summary: SAMPLE.knowledgeSummary,
    teacher_blessing: null,
    renewal_suggestion: null,
    status: 'auto_generated',
    generated_at: SAMPLE.generatedAt,
    finalized_at: null,
    parent_read_at: null,
    // V36 parent_* 5 字段
    parent_blessing: null,
    parent_highlights: null,
    parent_improvements: null,
    parent_next_plan: null,
    parent_finalized_at: null,
  };

  const finalizedTeacherRow = (overrides: Record<string, unknown> = {}) => ({
    ...ROW,
    teacher_blessing: '本月进步显著',
    renewal_suggestion: '建议续报暑期班',
    status: 'teacher_finalized',
    finalized_at: new Date('2026-05-02T10:00:00Z'),
    ...overrides,
  });

  const finalizedParentRow = (overrides: Record<string, unknown> = {}) => ({
    ...ROW,
    teacher_blessing: '本月进步显著',
    renewal_suggestion: '建议续报暑期班',
    status: 'teacher_finalized',
    parent_blessing: '亲爱的家长，孩子本月很棒',
    parent_highlights: [{ point: '基础运算稳定提升', lessonCount: 4 }],
    parent_improvements: [{ point: '应用题审题', suggestion: '每日 1 题练习' }],
    parent_next_plan: '巩固分数 + 进入比例',
    parent_finalized_at: new Date('2026-05-02T15:00:00Z'),
    ...overrides,
  });

  beforeEach(async () => {
    pg = { tenantQuery: jest.fn(), query: jest.fn(), withClient: jest.fn() };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    const m = await Test.createTestingModule({
      providers: [
        MonthlyReportRepository,
        { provide: PgPoolService, useValue: pg },
        { provide: AuditLogRepository, useValue: audit },
      ],
    }).compile();
    repo = m.get(MonthlyReportRepository);
  });

  // ==================================================================
  // V9 基础回归（保持向后兼容）
  // ==================================================================
  describe('V9 基础（向后兼容）', () => {
    it('insert uses ON CONFLICT for monthly idempotency', async () => {
      pg.tenantQuery.mockResolvedValueOnce([ROW]);
      await repo.insert(TENANT, SAMPLE);
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain('ON CONFLICT (student_id, month) DO UPDATE');
    });

    it('insert serializes JSONB summaries', async () => {
      pg.tenantQuery.mockResolvedValueOnce([ROW]);
      await repo.insert(TENANT, SAMPLE);
      const params = pg.tenantQuery.mock.calls[0][2];
      expect(params[4]).toBe(JSON.stringify(SAMPLE.attendanceSummary));
      expect(params[5]).toBe(JSON.stringify(SAMPLE.performanceTrend));
      expect(params[6]).toBe(JSON.stringify(SAMPLE.knowledgeSummary));
    });

    it('findByStudentMonth returns null when no row', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      const r = await repo.findByStudentMonth(TENANT, SAMPLE.studentId, MONTH);
      expect(r).toBeNull();
    });

    it('listByStudent maps rows', async () => {
      pg.tenantQuery.mockResolvedValueOnce([ROW, { ...ROW, id: 'r2' }]);
      const list = await repo.listByStudent(TENANT, SAMPLE.studentId);
      expect(list).toHaveLength(2);
    });

    it('listPendingFinalize without teacher returns global pending', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.listPendingFinalize(TENANT);
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain("status = 'auto_generated'");
      expect(sql).not.toContain('teacher_id =');
    });

    it('listPendingFinalize with teacher filters', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]);
      await repo.listPendingFinalize(TENANT, SAMPLE.teacherId);
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain('teacher_id = $1');
    });

    it('finalizeTeacher requires auto_generated state (NotFoundException on 0 rows)', async () => {
      // before 查询返回行（无所谓），UPDATE 返回空（状态不对）
      pg.tenantQuery.mockResolvedValueOnce([ROW]); // findById before
      pg.tenantQuery.mockResolvedValueOnce([]);    // UPDATE 0 rows
      await expect(
        repo.finalizeTeacher(TENANT, SAMPLE.id, '加油', '续报建议', AUDIT_CTX),
      ).rejects.toThrow(NotFoundException);
    });

    it('markParentRead is idempotent (COALESCE)', async () => {
      pg.tenantQuery.mockResolvedValueOnce([{ ...ROW, parent_read_at: new Date() }]);
      const r = await repo.markParentRead(TENANT, SAMPLE.id);
      expect(r.parentReadAt).toBeInstanceOf(Date);
    });

    it('parses attendance_summary string and object both', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        { ...ROW, attendance_summary: JSON.stringify(SAMPLE.attendanceSummary) },
      ]);
      const r = await repo.findById(TENANT, SAMPLE.id);
      expect(r?.attendanceSummary.total).toBe(8);
    });
  });

  // ==================================================================
  // V36 audience='parent' SQL 层隔离（不查 renewal_suggestion 列）
  // ==================================================================
  describe('V36 audience=parent SELECT 列隔离', () => {
    it('findById audience=parent → SELECT 不含 renewal_suggestion', async () => {
      pg.tenantQuery.mockResolvedValueOnce([ROW]);
      await repo.findById(TENANT, SAMPLE.id, 'parent');
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      // 双轨硬红线：parent 路径 SELECT 不含 renewal_suggestion
      expect(sql).not.toContain('renewal_suggestion');
      // teacher_blessing 仍 SELECT（作为家长版的 fallback）
      expect(sql).toContain('teacher_blessing');
      // parent_* 5 字段必含
      expect(sql).toContain('parent_blessing');
      expect(sql).toContain('parent_highlights');
      expect(sql).toContain('parent_improvements');
      expect(sql).toContain('parent_next_plan');
      expect(sql).toContain('parent_finalized_at');
    });

    it('findById audience=teacher (default) → SELECT 含 renewal_suggestion', async () => {
      pg.tenantQuery.mockResolvedValueOnce([ROW]);
      await repo.findById(TENANT, SAMPLE.id);
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain('renewal_suggestion');
    });

    it('findByStudentMonth audience=parent → SELECT 不含 renewal_suggestion', async () => {
      pg.tenantQuery.mockResolvedValueOnce([ROW]);
      await repo.findByStudentMonth(TENANT, SAMPLE.studentId, MONTH, 'parent');
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).not.toContain('renewal_suggestion');
    });

    it('listByStudent audience=parent → SELECT 不含 renewal_suggestion', async () => {
      pg.tenantQuery.mockResolvedValueOnce([ROW]);
      await repo.listByStudent(TENANT, SAMPLE.studentId, 'parent');
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).not.toContain('renewal_suggestion');
    });

    it('listByStudent audience=teacher (default) → SELECT 含 renewal_suggestion', async () => {
      pg.tenantQuery.mockResolvedValueOnce([ROW]);
      await repo.listByStudent(TENANT, SAMPLE.studentId);
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain('renewal_suggestion');
    });

    it('mapRow 双重防护：audience=parent 时即便 row 有 renewal_suggestion 也不暴露', async () => {
      // 模拟错误场景：row 漏带了 renewal_suggestion（不应发生，但兜底）
      pg.tenantQuery.mockResolvedValueOnce([
        finalizedTeacherRow({ renewal_suggestion: '泄漏的续报话术' }),
      ]);
      const r = await repo.findById(TENANT, SAMPLE.id, 'parent');
      // 双轨硬红线：audience='parent' 永不暴露 renewal_suggestion
      expect(r?.renewalSuggestion).toBeUndefined();
      // 但 teacher_blessing 仍可作为家长版 fallback
      expect(r?.teacherBlessing).toBe('本月进步显著');
    });

    it('mapRow audience=teacher 时 row.renewal_suggestion 正常暴露', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        finalizedTeacherRow({ renewal_suggestion: '建议续报暑期班' }),
      ]);
      const r = await repo.findById(TENANT, SAMPLE.id, 'teacher');
      expect(r?.renewalSuggestion).toBe('建议续报暑期班');
    });

    it('mapRow parent_* 字段正常映射（含 JSONB array parse）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        finalizedParentRow({
          parent_highlights: JSON.stringify([{ point: '提升 1', lessonCount: 2 }]),
          parent_improvements: JSON.stringify([{ point: '改进 1', suggestion: '建议 1' }]),
        }),
      ]);
      const r = await repo.findById(TENANT, SAMPLE.id, 'parent');
      expect(r?.parentBlessing).toBe('亲爱的家长，孩子本月很棒');
      expect(r?.parentHighlights).toEqual([{ point: '提升 1', lessonCount: 2 }]);
      expect(r?.parentImprovements).toEqual([{ point: '改进 1', suggestion: '建议 1' }]);
      expect(r?.parentNextPlan).toBe('巩固分数 + 进入比例');
      expect(r?.parentFinalizedAt).toBeInstanceOf(Date);
    });

    it('parent_highlights NULL → []（兜底）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([ROW]);
      const r = await repo.findById(TENANT, SAMPLE.id, 'parent');
      expect(r?.parentHighlights).toEqual([]);
      expect(r?.parentImprovements).toEqual([]);
    });
  });

  // ==================================================================
  // V36 finalizeTeacher audit_log 接入
  // ==================================================================
  describe('V36 finalizeTeacher audit_log', () => {
    // 2026-05-11 修复 (P2): finalizeTeacher auditCtx 改为必传 (跟 finalizeParent 一致)
    // 原向后兼容 case (不传 auditCtx → 不调 audit_log) 已不适用,
    // 替换为 "operator 缺失 → BadRequestException" 验证 (与 finalizeParent 对齐)
    it('finalizeTeacher 不传 auditCtx → BadRequestException (audit_log 链路硬红线)', async () => {
      await expect(
        repo.finalizeTeacher(TENANT, SAMPLE.id, '加油', '续报建议', undefined as any),
      ).rejects.toThrow(BadRequestException);
      expect(pg.tenantQuery).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('finalizeTeacher operatorUserId 空 → BadRequestException', async () => {
      const badCtx: FinalizeAuditContext = { ...AUDIT_CTX, operatorUserId: '' };
      await expect(
        repo.finalizeTeacher(TENANT, SAMPLE.id, '加油', '续报建议', badCtx),
      ).rejects.toThrow(BadRequestException);
      expect(pg.tenantQuery).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('finalizeTeacher with valid auditCtx → 调 audit_log action=monthly-report.finalize-teacher', async () => {
      pg.tenantQuery.mockResolvedValueOnce([ROW]);                       // before
      pg.tenantQuery.mockResolvedValueOnce([
        finalizedTeacherRow({ teacher_blessing: '加油', renewal_suggestion: '续报建议' }),
      ]); // UPDATE returning（注：实际数据库 returning 应是 UPDATE 后值；mock 与 input 对齐）
      await repo.finalizeTeacher(TENANT, SAMPLE.id, '加油', '续报建议', AUDIT_CTX);
      expect(audit.log).toHaveBeenCalledTimes(1);
      const [schema, entry] = audit.log.mock.calls[0];
      expect(schema).toBe(TENANT);
      expect(entry.action).toBe('monthly-report.finalize-teacher');
      expect(entry.targetType).toBe('monthly_report');
      expect(entry.targetId).toBe(SAMPLE.id);
      expect(entry.actorUserId).toBe(OPERATOR);
      expect(entry.actorRole).toBe('teacher');
      // before snapshot 含 status='auto_generated' / 无 blessing
      expect(entry.before).toMatchObject({
        status: 'auto_generated',
        teacherBlessing: null,
        renewalSuggestion: null,
      });
      // after snapshot 含 finalized + blessing + renewal
      expect(entry.after).toMatchObject({
        status: 'teacher_finalized',
        teacherBlessing: '加油',
        renewalSuggestion: '续报建议',
      });
      expect(entry.ip).toBe('1.2.3.4');
      expect(entry.requestId).toBe('req-abc-123');
    });
  });

  // ==================================================================
  // V36 finalizeParent — 新方法核心路径
  // ==================================================================
  describe('V36 finalizeParent', () => {
    const PARENT_PAYLOAD: FinalizeParentPayload = {
      parentBlessing: '亲爱的家长，孩子本月很棒',
      parentHighlights: [{ point: '基础运算稳定提升', lessonCount: 4 }],
      parentImprovements: [{ point: '应用题审题', suggestion: '每日 1 题练习' }],
      parentNextPlan: '巩固分数 + 进入比例',
    };

    it('正常路径：写 parent_* 5 字段 + audit_log 记 finalize-parent', async () => {
      pg.tenantQuery.mockResolvedValueOnce([ROW]);                    // before findById
      pg.tenantQuery.mockResolvedValueOnce([finalizedParentRow()]);   // UPDATE returning
      const r = await repo.finalizeParent(TENANT, SAMPLE.id, PARENT_PAYLOAD, AUDIT_CTX);
      expect(r.parentBlessing).toBe('亲爱的家长，孩子本月很棒');
      expect(r.parentFinalizedAt).toBeInstanceOf(Date);

      // UPDATE SQL 校验
      const updateCall = pg.tenantQuery.mock.calls[1];
      const updateSql = updateCall[1] as string;
      expect(updateSql).toMatch(/UPDATE monthly_reports/);
      expect(updateSql).toMatch(/parent_blessing\s*=\s*\$1/);
      expect(updateSql).toMatch(/parent_finalized_at\s*=\s*NOW\(\)/);
      // 不动 status
      expect(updateSql).not.toMatch(/status\s*=/);

      // params: parentBlessing, highlightsJSON, improvementsJSON, parentNextPlan, id
      const params = updateCall[2];
      expect(params[0]).toBe('亲爱的家长，孩子本月很棒');
      expect(typeof params[1]).toBe('string');
      expect(JSON.parse(params[1] as string)).toEqual(PARENT_PAYLOAD.parentHighlights);
      expect(typeof params[2]).toBe('string');
      expect(params[3]).toBe('巩固分数 + 进入比例');
      expect(params[4]).toBe(SAMPLE.id);

      // audit_log: action='monthly-report.finalize-parent'，snapshot 仅 parent_* 5 字段
      expect(audit.log).toHaveBeenCalledTimes(1);
      const [, entry] = audit.log.mock.calls[0];
      expect(entry.action).toBe('monthly-report.finalize-parent');
      expect(entry.targetType).toBe('monthly_report');
      expect(entry.targetId).toBe(SAMPLE.id);
      // 双轨硬红线：snapshot 不泄漏 renewal_suggestion
      expect(entry.before).not.toHaveProperty('renewalSuggestion');
      expect(entry.after).not.toHaveProperty('renewalSuggestion');
      expect(entry.before).not.toHaveProperty('renewal_suggestion');
      expect(entry.after).not.toHaveProperty('renewal_suggestion');
      // before parent_* 全 null（首次写入）
      expect(entry.before).toMatchObject({
        parentBlessing: null,
        parentNextPlan: null,
        parentFinalizedAt: null,
      });
      // after parent_* 已写入
      expect(entry.after).toMatchObject({
        parentBlessing: '亲爱的家长，孩子本月很棒',
        parentNextPlan: '巩固分数 + 进入比例',
      });
    });

    it('仅传 parentBlessing → JSONB 字段未提供走 COALESCE 保留旧值（params null）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([ROW]);
      pg.tenantQuery.mockResolvedValueOnce([finalizedParentRow()]);
      await repo.finalizeParent(
        TENANT,
        SAMPLE.id,
        { parentBlessing: '简短家长版' },
        AUDIT_CTX,
      );
      const params = pg.tenantQuery.mock.calls[1][2];
      expect(params[0]).toBe('简短家长版');
      // 未传 → null → COALESCE 走旧值
      expect(params[1]).toBeNull(); // highlights
      expect(params[2]).toBeNull(); // improvements
      expect(params[3]).toBeNull(); // nextPlan
    });

    it('显式传 parentHighlights=[] → 清空（不是 COALESCE 跳过）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([ROW]);
      pg.tenantQuery.mockResolvedValueOnce([finalizedParentRow({ parent_highlights: [] })]);
      await repo.finalizeParent(
        TENANT,
        SAMPLE.id,
        { parentBlessing: '简短', parentHighlights: [] },
        AUDIT_CTX,
      );
      const params = pg.tenantQuery.mock.calls[1][2];
      // [] 序列化为 '[]'（不是 null）
      expect(params[1]).toBe('[]');
    });

    it('operatorUserId 缺失 → BadRequestException + 不走 PG + 不走 audit_log', async () => {
      const badCtx: FinalizeAuditContext = { ...AUDIT_CTX, operatorUserId: '' };
      await expect(
        repo.finalizeParent(TENANT, SAMPLE.id, { parentBlessing: 'x' }, badCtx),
      ).rejects.toThrow(BadRequestException);
      expect(pg.tenantQuery).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('parentBlessing 空字符串 → BadRequestException', async () => {
      await expect(
        repo.finalizeParent(TENANT, SAMPLE.id, { parentBlessing: '   ' }, AUDIT_CTX),
      ).rejects.toThrow(/parentBlessing required/);
    });

    it('记录不存在 → NotFoundException（before 查不到）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]); // before findById null
      await expect(
        repo.finalizeParent(
          TENANT,
          SAMPLE.id,
          { parentBlessing: '简短' },
          AUDIT_CTX,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('UPDATE 返回 0 行 → NotFoundException', async () => {
      pg.tenantQuery.mockResolvedValueOnce([ROW]); // before 找到
      pg.tenantQuery.mockResolvedValueOnce([]);    // UPDATE 0 行
      await expect(
        repo.finalizeParent(
          TENANT,
          SAMPLE.id,
          { parentBlessing: '简短' },
          AUDIT_CTX,
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ==================================================================
  // V36 SQL 结构性验证（防回归）
  // ==================================================================
  describe('V36 SQL 结构性防回归', () => {
    it('insert RETURNING 含 parent_* 5 字段', async () => {
      pg.tenantQuery.mockResolvedValueOnce([ROW]);
      await repo.insert(TENANT, SAMPLE);
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain('parent_blessing');
      expect(sql).toContain('parent_highlights');
      expect(sql).toContain('parent_improvements');
      expect(sql).toContain('parent_next_plan');
      expect(sql).toContain('parent_finalized_at');
    });

    it('finalizeParent UPDATE 不动 status（V36 红线：finalize-parent 不切状态机）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([ROW]);
      pg.tenantQuery.mockResolvedValueOnce([finalizedParentRow()]);
      await repo.finalizeParent(
        TENANT,
        SAMPLE.id,
        { parentBlessing: 'x' },
        AUDIT_CTX,
      );
      const updateSql = pg.tenantQuery.mock.calls[1][1] as string;
      // 不能含 status = 'xxx'（finalize-parent 与 status 状态机完全解耦）
      expect(updateSql).not.toMatch(/SET[\s\S]+status\s*=/);
    });

    it('audit_log snapshot 不泄漏 renewal_suggestion（双轨硬红线 snapshot 层）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([
        finalizedTeacherRow({ renewal_suggestion: '本月续报话术' }),
      ]);
      pg.tenantQuery.mockResolvedValueOnce([
        finalizedParentRow({ renewal_suggestion: '本月续报话术' }),
      ]);
      await repo.finalizeParent(
        TENANT,
        SAMPLE.id,
        { parentBlessing: '家长版' },
        AUDIT_CTX,
      );
      const [, entry] = audit.log.mock.calls[0];
      // 哪怕 row 含 renewal_suggestion，snapshot 也不写入 audit_log.before/after
      expect(JSON.stringify(entry.before)).not.toContain('续报话术');
      expect(JSON.stringify(entry.after)).not.toContain('续报话术');
      expect(JSON.stringify(entry.before)).not.toContain('renewal');
      expect(JSON.stringify(entry.after)).not.toContain('renewal');
    });
  });
});
