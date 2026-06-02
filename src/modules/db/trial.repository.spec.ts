import { TrialRepository } from './trial.repository';
import { PgPoolService } from './pg-pool.service';

/**
 * TrialRepository 单测 (V64 Phase 4)
 *   - create：INSERT pending_assign（id/campus/initiatedBy 落库）
 *   - list：参数化 where 拼接（campus / assigned / assignedIsNull / teacher / status）
 *   - 状态机 UPDATE：assignAcademic/arrange/complete/setResult 带 WHERE status 二次兜底
 *   - findTeacherConflicts：decision 3 — 同时查 schedules + trials 两表 overlap
 */
describe('TrialRepository (V64 Phase 4)', () => {
  let repo: TrialRepository;
  let pg: { tenantQuery: jest.Mock };

  const TENANT = 'tenant_073e69d6aa5ac5b7e38496d3f57e7cdb';
  const TRIAL = 'trial000000000000000000000000T01';
  const CAMPUS = 'campus0000000000000000000000C001';
  const ACADEMIC = 'academicA0000000000000000000A001';
  const TEACHER = 'teacher00000000000000000000000T1';

  const row = (overrides: Record<string, any> = {}) => ({
    id: TRIAL,
    customer_id: 'customer0000000000000000000000C1',
    student_name: '小明',
    subject: '数学',
    preferred_time: '周六',
    scheduled_at: null,
    status: 'pending_assign',
    assigned_academic_id: null,
    teacher_id: null,
    campus_id: CAMPUS,
    initiated_by: 'salesUser000000000000000000000S1',
    result_note: null,
    converted_contract_id: null,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  });

  beforeEach(() => {
    pg = { tenantQuery: jest.fn() };
    repo = new TrialRepository(pg as unknown as PgPoolService);
  });

  describe('create', () => {
    it('INSERT status=pending_assign，回填字段', async () => {
      pg.tenantQuery.mockResolvedValue([row()]);
      const t = await repo.create(TENANT, {
        id: TRIAL,
        customerId: 'customer0000000000000000000000C1',
        studentName: '小明',
        subject: '数学',
        preferredTime: '周六',
        campusId: CAMPUS,
        initiatedBy: 'salesUser000000000000000000000S1',
      });
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain('INSERT INTO trials');
      expect(sql).toContain("'pending_assign'");
      expect(t.status).toBe('pending_assign');
      expect(t.campusId).toBe(CAMPUS);
    });
  });

  describe('list — 参数化 where', () => {
    it('campus + assignedIsNull → WHERE campus_id + assigned_academic_id IS NULL', async () => {
      pg.tenantQuery.mockResolvedValue([]);
      await repo.list(TENANT, { campusId: CAMPUS, assignedIsNull: true });
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      const params = pg.tenantQuery.mock.calls[0][2] as unknown[];
      expect(sql).toContain('campus_id = $1');
      expect(sql).toContain('assigned_academic_id IS NULL');
      expect(params[0]).toBe(CAMPUS);
    });

    it('assignedAcademicId + status → 两条件参数化', async () => {
      pg.tenantQuery.mockResolvedValue([]);
      await repo.list(TENANT, { assignedAcademicId: ACADEMIC, status: 'scheduled' });
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      const params = pg.tenantQuery.mock.calls[0][2] as unknown[];
      expect(sql).toContain('assigned_academic_id = $1');
      expect(sql).toContain('status = $2');
      expect(params).toContain(ACADEMIC);
      expect(params).toContain('scheduled');
    });

    it('initiatedBy → WHERE initiated_by 参数化（销售闭环 my-initiated）', async () => {
      pg.tenantQuery.mockResolvedValue([]);
      await repo.list(TENANT, { initiatedBy: 'salesUser000000000000000000000S1' });
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      const params = pg.tenantQuery.mock.calls[0][2] as unknown[];
      expect(sql).toContain('initiated_by = $1');
      expect(params).toContain('salesUser000000000000000000000S1');
    });

    it('limit 上限 200', async () => {
      pg.tenantQuery.mockResolvedValue([]);
      await repo.list(TENANT, { limit: 9999 });
      const params = pg.tenantQuery.mock.calls[0][2] as unknown[];
      // 倒数第二个参数为 limit
      expect(params[params.length - 2]).toBe(200);
    });
  });

  describe('状态机 UPDATE — WHERE status 二次兜底', () => {
    it('assignAcademic：set pending_teacher WHERE status=pending_assign', async () => {
      pg.tenantQuery.mockResolvedValue([row({ status: 'pending_teacher', assigned_academic_id: ACADEMIC })]);
      const t = await repo.assignAcademic(TENANT, TRIAL, ACADEMIC);
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain("status = 'pending_teacher'");
      expect(sql).toContain("WHERE id = $2 AND status = 'pending_assign'");
      expect(t?.status).toBe('pending_teacher');
    });

    it('assignAcademic：行不存在/状态不符 → 返 null', async () => {
      pg.tenantQuery.mockResolvedValue([]);
      const t = await repo.assignAcademic(TENANT, TRIAL, ACADEMIC);
      expect(t).toBeNull();
    });

    it('arrange：set scheduled WHERE status=pending_teacher', async () => {
      pg.tenantQuery.mockResolvedValue([row({ status: 'scheduled' })]);
      await repo.arrange(TENANT, TRIAL, TEACHER, new Date('2026-06-10T02:00:00Z'));
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain("status = 'scheduled'");
      expect(sql).toContain("WHERE id = $3 AND status = 'pending_teacher'");
    });

    it('complete：set done WHERE status=scheduled', async () => {
      pg.tenantQuery.mockResolvedValue([row({ status: 'done' })]);
      await repo.complete(TENANT, TRIAL);
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain("status = 'done'");
      expect(sql).toContain("WHERE id = $1 AND status = 'scheduled'");
    });

    it('setResult：set converted/lost WHERE status=done', async () => {
      pg.tenantQuery.mockResolvedValue([row({ status: 'converted', result_note: 'ok' })]);
      const t = await repo.setResult(TENANT, TRIAL, 'converted', 'ok');
      const sql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(sql).toContain("WHERE id = $3 AND status = 'done'");
      expect(t?.status).toBe('converted');
    });
  });

  describe('findTeacherConflicts — decision 3 双表 overlap', () => {
    it('同时查 schedules + trials，合并冲突；trials 用 scheduled_at+duration 推算 end', async () => {
      // 第 1 次 tenantQuery = schedules，第 2 次 = trials
      pg.tenantQuery
        .mockResolvedValueOnce([
          { id: 'sch1', start_at: '2026-06-10T02:00:00Z', end_at: '2026-06-10T03:00:00Z' },
        ])
        .mockResolvedValueOnce([
          {
            id: 'tr2',
            scheduled_at: '2026-06-10T02:30:00Z',
            end_at: '2026-06-10T03:30:00Z',
          },
        ]);
      const conflicts = await repo.findTeacherConflicts(
        TENANT,
        TEACHER,
        new Date('2026-06-10T02:00:00Z'),
        new Date('2026-06-10T03:00:00Z'),
        60,
      );
      expect(conflicts).toHaveLength(2);
      expect(conflicts.find((c) => c.source === 'schedule')?.id).toBe('sch1');
      expect(conflicts.find((c) => c.source === 'trial')?.id).toBe('tr2');

      // schedules 查询：teacher + 排除已取消 + overlap
      const schSql = pg.tenantQuery.mock.calls[0][1] as string;
      expect(schSql).toContain('FROM schedules');
      expect(schSql).toContain("status != '已取消'");
      expect(schSql).toContain('start_at < $3');
      expect(schSql).toContain('end_at > $2');

      // trials 查询：仅 scheduled 试听 + interval 推算 end overlap
      const trSql = pg.tenantQuery.mock.calls[1][1] as string;
      expect(trSql).toContain('FROM trials');
      expect(trSql).toContain("status = 'scheduled'");
      expect(trSql).toContain("|| ' minutes')::interval");
    });

    it('excludeTrialId → trials 查询加 id != 排除自身（重排幂等）', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      await repo.findTeacherConflicts(
        TENANT,
        TEACHER,
        new Date('2026-06-10T02:00:00Z'),
        new Date('2026-06-10T03:00:00Z'),
        60,
        TRIAL,
      );
      const trSql = pg.tenantQuery.mock.calls[1][1] as string;
      const trParams = pg.tenantQuery.mock.calls[1][2] as unknown[];
      expect(trSql).toMatch(/id != \$\d/);
      expect(trParams).toContain(TRIAL);
    });

    it('两表均无 → 空冲突', async () => {
      pg.tenantQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      const conflicts = await repo.findTeacherConflicts(
        TENANT,
        TEACHER,
        new Date('2026-06-10T02:00:00Z'),
        new Date('2026-06-10T03:00:00Z'),
        60,
      );
      expect(conflicts).toHaveLength(0);
    });
  });
});
