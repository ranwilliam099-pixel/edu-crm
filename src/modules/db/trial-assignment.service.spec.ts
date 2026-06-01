import { Test } from '@nestjs/testing';
import { TrialAssignmentService } from './trial-assignment.service';
import { PgPoolService } from './pg-pool.service';
import { AuditLogRepository } from './audit-log.repository';
import { ASSIGNMENT_POOL_ROLES } from './student-assignment.service';

/**
 * TrialAssignmentService (V64 Phase 4) 单测
 *   - round-robin 发牌（复用 Phase 3 pickNext + **独立** rr_last_trial_academic_id 游标，2026-06-02 两线独立）
 *   - 幂等：已分配不重分
 *   - auto off：不分配（status 留 pending_assign）
 *   - 池空：不报错留 NULL
 *   - 审计：仅真分配写 trial.auto_assigned
 *   - campusId 缺失：不进事务
 *   - 共享游标 + FOR UPDATE 锁
 *   - 审计 fail-open
 */
describe('TrialAssignmentService (V64 Phase 4 试听→教务分配)', () => {
  let service: TrialAssignmentService;
  let pg: { transaction: jest.Mock };
  let txClient: { query: jest.Mock };
  let auditLog: { log: jest.Mock };

  const TENANT = 'tenant_073e69d6aa5ac5b7e38496d3f57e7cdb';
  const CAMPUS = 'campus0000000000000000000000C001';
  const TRIAL = 'trial000000000000000000000000T01';
  const SALES = 'salesUser000000000000000000000S1';
  const A = 'academicA0000000000000000000A001';
  const B = 'academicB0000000000000000000A002';
  const C = 'academicC0000000000000000000A003';

  const result = (rows: any[]) => ({ rows, rowCount: rows.length });

  beforeEach(async () => {
    txClient = { query: jest.fn() };
    pg = {
      transaction: jest.fn().mockImplementation(async (fn: any) => fn(txClient)),
    };
    auditLog = { log: jest.fn().mockResolvedValue(undefined) };
    const m = await Test.createTestingModule({
      providers: [
        TrialAssignmentService,
        { provide: PgPoolService, useValue: pg },
        { provide: AuditLogRepository, useValue: auditLog },
      ],
    }).compile();
    service = m.get(TrialAssignmentService);
  });

  /**
   * helper：装配「auto on + pool [A,B,C]」一次分配的 query 序列。
   *   1. SELECT assigned_academic_id FROM trials          → 未分配
   *   2. SELECT ... campus_assignment_config FOR UPDATE     → auto on + rrLast
   *   3. SELECT id FROM users (pool)                        → [A,B,C]
   *   4. UPDATE trials SET assigned + status                → (no read)
   *   5. INSERT campus_assignment_config (cursor)           → (no read)
   */
  const armAutoOn = (rrLast: string | null, pool: string[] = [A, B, C]) => {
    txClient.query
      .mockResolvedValueOnce(result([{ assigned_academic_id: null }])) // 1
      .mockResolvedValueOnce(
        result([{ auto_assign_academic: true, rr_last_trial_academic_id: rrLast }]),
      ) // 2
      .mockResolvedValueOnce(result(pool.map((id) => ({ id })))) // 3
      .mockResolvedValueOnce(result([])) // 4 UPDATE
      .mockResolvedValueOnce(result([])); // 5 INSERT cursor
  };

  describe('round-robin 发牌（复用 Phase 3 pickNext + 独立试听游标）', () => {
    it('rrLast=null → 发第一个 A，并把 trial status 推到 pending_teacher', async () => {
      armAutoOn(null);
      const r = await service.assignTrialIfNeeded(TENANT, TRIAL, CAMPUS, {
        userId: SALES,
        role: 'sales',
      });
      expect(r.assigned).toBe(true);
      expect(r.academicId).toBe(A);
      // UPDATE trials 第 4 次调用：第一个参数 = 选中 academicId，SQL 含 pending_teacher
      const updateCall = txClient.query.mock.calls[3];
      expect(updateCall[1][0]).toBe(A);
      expect(updateCall[0]).toContain("status = 'pending_teacher'");
      expect(updateCall[0]).toContain("WHERE id = $2 AND status = 'pending_assign'");
    });

    it('rrLast=A → 发下一个 B（试听线独立游标在 A 后轮到 B）', async () => {
      armAutoOn(A);
      const r = await service.assignTrialIfNeeded(TENANT, TRIAL, CAMPUS, {
        userId: SALES,
        role: 'sales',
      });
      expect(r.academicId).toBe(B);
    });

    it('rrLast=C → 环绕回 A', async () => {
      armAutoOn(C);
      const r = await service.assignTrialIfNeeded(TENANT, TRIAL, CAMPUS, {
        userId: SALES,
        role: 'sales',
      });
      expect(r.academicId).toBe(A);
    });

    it('rrLast 指向已离职（不在池）→ 从头发 A', async () => {
      armAutoOn('academicGONE000000000000000G999');
      const r = await service.assignTrialIfNeeded(TENANT, TRIAL, CAMPUS, {
        userId: SALES,
        role: 'sales',
      });
      expect(r.academicId).toBe(A);
    });

    it('真分配推进【独立】rr_last_trial_academic_id 游标（不触学员游标）+ 写 trial.auto_assigned 审计', async () => {
      armAutoOn(A);
      await service.assignTrialIfNeeded(TENANT, TRIAL, CAMPUS, {
        userId: SALES,
        role: 'sales',
      });
      // upsert 游标第 5 次调用：参数 [campusId, nextId, actor]，更新的是独立列 rr_last_trial_academic_id
      const cursorCall = txClient.query.mock.calls[4];
      expect(cursorCall[0]).toContain('rr_last_trial_academic_id');
      // 两线独立：试听 upsert 不得触碰学员游标 rr_last_academic_id（仅 SET 试听列）
      expect(cursorCall[0]).not.toMatch(/SET[\s\S]*\brr_last_academic_id\b/);
      expect(cursorCall[1]).toEqual([CAMPUS, B, SALES]);
      // 审计
      expect(auditLog.log).toHaveBeenCalledTimes(1);
      const entry = auditLog.log.mock.calls[0][1];
      expect(entry.action).toBe('trial.auto_assigned');
      expect(entry.targetType).toBe('trial');
      expect(entry.targetId).toBe(TRIAL);
      expect(entry.after.assignedAcademicId).toBe(B);
    });
  });

  describe('幂等：已分配不重分', () => {
    it('assigned_academic_id 非 NULL → already_assigned，不查 config/不写审计', async () => {
      txClient.query.mockResolvedValueOnce(result([{ assigned_academic_id: A }]));
      const r = await service.assignTrialIfNeeded(TENANT, TRIAL, CAMPUS, {
        userId: SALES,
        role: 'sales',
      });
      expect(r.assigned).toBe(false);
      expect(r.reason).toBe('already_assigned');
      expect(r.academicId).toBe(A);
      expect(txClient.query).toHaveBeenCalledTimes(1);
      expect(auditLog.log).not.toHaveBeenCalled();
    });
  });

  describe('auto off：不分配（试听留 pending_assign）', () => {
    it('config 无行 → auto off → 不分配，不 UPDATE trials', async () => {
      txClient.query
        .mockResolvedValueOnce(result([{ assigned_academic_id: null }]))
        .mockResolvedValueOnce(result([])); // config FOR UPDATE 无行
      const r = await service.assignTrialIfNeeded(TENANT, TRIAL, CAMPUS, {
        userId: SALES,
        role: 'sales',
      });
      expect(r.assigned).toBe(false);
      expect(r.reason).toBe('auto_off');
      expect(txClient.query).toHaveBeenCalledTimes(2);
      expect(auditLog.log).not.toHaveBeenCalled();
    });

    it('auto_assign_academic=false → 不分配', async () => {
      txClient.query
        .mockResolvedValueOnce(result([{ assigned_academic_id: null }]))
        .mockResolvedValueOnce(
          result([{ auto_assign_academic: false, rr_last_trial_academic_id: null }]),
        );
      const r = await service.assignTrialIfNeeded(TENANT, TRIAL, CAMPUS, {
        userId: SALES,
        role: 'sales',
      });
      expect(r.assigned).toBe(false);
      expect(r.reason).toBe('auto_off');
    });
  });

  describe('池空：不报错', () => {
    it('auto on 但本校无在职 academic → 留 NULL + empty_pool，不抛', async () => {
      txClient.query
        .mockResolvedValueOnce(result([{ assigned_academic_id: null }]))
        .mockResolvedValueOnce(
          result([{ auto_assign_academic: true, rr_last_trial_academic_id: null }]),
        )
        .mockResolvedValueOnce(result([])); // pool empty
      const r = await service.assignTrialIfNeeded(TENANT, TRIAL, CAMPUS, {
        userId: SALES,
        role: 'sales',
      });
      expect(r.assigned).toBe(false);
      expect(r.reason).toBe('empty_pool');
      expect(txClient.query).toHaveBeenCalledTimes(3);
      expect(auditLog.log).not.toHaveBeenCalled();
    });
  });

  describe('campusId 缺失', () => {
    it('campusId=null → 不进事务，留待分配', async () => {
      const r = await service.assignTrialIfNeeded(TENANT, TRIAL, null, {
        userId: SALES,
        role: 'sales',
      });
      expect(r.assigned).toBe(false);
      expect(r.reason).toBe('empty_pool');
      expect(pg.transaction).not.toHaveBeenCalled();
    });
  });

  describe('试听不存在', () => {
    it('trials 查不到 → 不分配（side-effect 不抛）', async () => {
      txClient.query.mockResolvedValueOnce(result([])); // trials 无行
      const r = await service.assignTrialIfNeeded(TENANT, TRIAL, CAMPUS, {
        userId: SALES,
        role: 'sales',
      });
      expect(r.assigned).toBe(false);
      expect(r.reason).toBe('empty_pool');
    });
  });

  describe('发牌池查询用 ASSIGNMENT_POOL_ROLES（与 Phase 3 同池）', () => {
    it('pool 查询 role 参数 = ASSIGNMENT_POOL_ROLES + status 启用 + 同校', async () => {
      armAutoOn(null);
      await service.assignTrialIfNeeded(TENANT, TRIAL, CAMPUS, {
        userId: SALES,
        role: 'sales',
      });
      const poolCall = txClient.query.mock.calls[2];
      const sql = poolCall[0] as string;
      const params = poolCall[1];
      expect(sql).toContain('FROM users');
      expect(sql).toContain("status = '启用'");
      expect(params[0]).toEqual([...ASSIGNMENT_POOL_ROLES]);
      expect(params[1]).toBe(CAMPUS);
    });
  });

  describe('FOR UPDATE 并发锁（与学员分配共享同一 config 行锁）', () => {
    it('config 查询带 FOR UPDATE', async () => {
      armAutoOn(null);
      await service.assignTrialIfNeeded(TENANT, TRIAL, CAMPUS, {
        userId: SALES,
        role: 'sales',
      });
      const cfgCall = txClient.query.mock.calls[1];
      expect(cfgCall[0]).toContain('FOR UPDATE');
      expect(cfgCall[0]).toContain('campus_assignment_config');
    });
  });

  describe('审计 fail-open', () => {
    it('auditLog 缺失（@Optional 未注入）→ 不抛，分配仍成功', async () => {
      const m = await Test.createTestingModule({
        providers: [
          TrialAssignmentService,
          { provide: PgPoolService, useValue: pg },
        ],
      }).compile();
      const svc = m.get(TrialAssignmentService);
      armAutoOn(null);
      const r = await svc.assignTrialIfNeeded(TENANT, TRIAL, CAMPUS, {
        userId: SALES,
        role: 'sales',
      });
      expect(r.assigned).toBe(true);
      expect(r.academicId).toBe(A);
    });
  });
});
