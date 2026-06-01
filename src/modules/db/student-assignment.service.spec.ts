import { Test } from '@nestjs/testing';
import {
  StudentAssignmentService,
  ASSIGNMENT_POOL_ROLES,
} from './student-assignment.service';
import { PgPoolService } from './pg-pool.service';
import { AuditLogRepository } from './audit-log.repository';

/**
 * StudentAssignmentService (V63 Phase 3) 单测
 *   - round-robin 发牌顺序（A→B→C→A 环绕）
 *   - 幂等：已分配不重分
 *   - auto off：不分配
 *   - 池空：不报错留 NULL
 *   - 审计：仅真分配写 student.auto_assigned
 *   - pickNext 纯函数边界
 */
describe('StudentAssignmentService (V63 Phase 3 学员→教务分配)', () => {
  let service: StudentAssignmentService;
  let pg: { transaction: jest.Mock };
  let txClient: { query: jest.Mock };
  let auditLog: { log: jest.Mock };

  const TENANT = 'tenant_073e69d6aa5ac5b7e38496d3f57e7cdb';
  const CAMPUS = 'campus0000000000000000000000C001';
  const STUDENT = 'student00000000000000000000S0001';
  const FINANCE = 'finance0000000000000000000000F01';
  const A = 'academicA0000000000000000000A001';
  const B = 'academicB0000000000000000000A002';
  const C = 'academicC0000000000000000000A003';

  // 构造 txClient.query 的顺序化返回（pg 原始结果 { rows, rowCount }）
  const result = (rows: any[]) => ({ rows, rowCount: rows.length });

  beforeEach(async () => {
    txClient = { query: jest.fn() };
    pg = {
      transaction: jest
        .fn()
        .mockImplementation(async (fn: any) => fn(txClient)),
    };
    auditLog = { log: jest.fn().mockResolvedValue(undefined) };
    const m = await Test.createTestingModule({
      providers: [
        StudentAssignmentService,
        { provide: PgPoolService, useValue: pg },
        { provide: AuditLogRepository, useValue: auditLog },
      ],
    }).compile();
    service = m.get(StudentAssignmentService);
  });

  /**
   * helper：装配「auto on + pool [A,B,C]」一次分配的 query 序列。
   *   query 调用顺序：
   *     1. SELECT assigned_academic_id FROM students        → 未分配
   *     2. SELECT ... campus_assignment_config FOR UPDATE    → auto on + rrLast
   *     3. SELECT id FROM users (pool)                       → [A,B,C]
   *     4. UPDATE students SET assigned_academic_id          → (no read)
   *     5. INSERT campus_assignment_config ON CONFLICT       → (no read)
   */
  const armAutoOn = (rrLast: string | null, pool: string[] = [A, B, C]) => {
    txClient.query
      .mockResolvedValueOnce(result([{ assigned_academic_id: null }])) // 1
      .mockResolvedValueOnce(
        result([{ auto_assign_academic: true, rr_last_academic_id: rrLast }]),
      ) // 2
      .mockResolvedValueOnce(result(pool.map((id) => ({ id })))) // 3
      .mockResolvedValueOnce(result([])) // 4 UPDATE
      .mockResolvedValueOnce(result([])); // 5 INSERT/upsert cursor
  };

  describe('round-robin 发牌顺序', () => {
    it('rrLast=null → 发第一个 A', async () => {
      armAutoOn(null);
      const r = await service.assignStudentIfNeeded(TENANT, STUDENT, CAMPUS, {
        userId: FINANCE,
        role: 'finance',
      });
      expect(r.assigned).toBe(true);
      expect(r.academicId).toBe(A);
      // UPDATE students 第 4 次调用第一个参数 = 选中 academicId
      const updateCall = txClient.query.mock.calls[3];
      expect(updateCall[1][0]).toBe(A);
    });

    it('rrLast=A → 发下一个 B', async () => {
      armAutoOn(A);
      const r = await service.assignStudentIfNeeded(TENANT, STUDENT, CAMPUS, {
        userId: FINANCE,
        role: 'finance',
      });
      expect(r.academicId).toBe(B);
    });

    it('rrLast=B → 发下一个 C', async () => {
      armAutoOn(B);
      const r = await service.assignStudentIfNeeded(TENANT, STUDENT, CAMPUS, {
        userId: FINANCE,
        role: 'finance',
      });
      expect(r.academicId).toBe(C);
    });

    it('rrLast=C → 环绕回 A', async () => {
      armAutoOn(C);
      const r = await service.assignStudentIfNeeded(TENANT, STUDENT, CAMPUS, {
        userId: FINANCE,
        role: 'finance',
      });
      expect(r.academicId).toBe(A);
    });

    it('rrLast 指向已离职（不在池）→ 从头发 A', async () => {
      armAutoOn('academicGONE000000000000000G999');
      const r = await service.assignStudentIfNeeded(TENANT, STUDENT, CAMPUS, {
        userId: FINANCE,
        role: 'finance',
      });
      expect(r.academicId).toBe(A);
    });

    it('真分配时推进游标 + 写 student.auto_assigned 审计', async () => {
      armAutoOn(A);
      await service.assignStudentIfNeeded(TENANT, STUDENT, CAMPUS, {
        userId: FINANCE,
        role: 'finance',
      });
      // upsert 游标第 5 次调用：参数 [campusId, nextId, actor]
      const cursorCall = txClient.query.mock.calls[4];
      expect(cursorCall[1]).toEqual([CAMPUS, B, FINANCE]);
      // 审计写一次
      expect(auditLog.log).toHaveBeenCalledTimes(1);
      const entry = auditLog.log.mock.calls[0][1];
      expect(entry.action).toBe('student.auto_assigned');
      expect(entry.targetId).toBe(STUDENT);
      expect(entry.after.assignedAcademicId).toBe(B);
    });
  });

  describe('幂等：已分配不重分', () => {
    it('assigned_academic_id 非 NULL → 直接 return already_assigned，不查 config/不写审计', async () => {
      txClient.query.mockResolvedValueOnce(
        result([{ assigned_academic_id: A }]),
      );
      const r = await service.assignStudentIfNeeded(TENANT, STUDENT, CAMPUS, {
        userId: FINANCE,
        role: 'finance',
      });
      expect(r.assigned).toBe(false);
      expect(r.reason).toBe('already_assigned');
      expect(r.academicId).toBe(A);
      // 只查了 students 一次（未到 config FOR UPDATE）
      expect(txClient.query).toHaveBeenCalledTimes(1);
      expect(auditLog.log).not.toHaveBeenCalled();
    });
  });

  describe('auto off：不分配', () => {
    it('config 无行 → auto off → 不分配，不 UPDATE students', async () => {
      txClient.query
        .mockResolvedValueOnce(result([{ assigned_academic_id: null }])) // students
        .mockResolvedValueOnce(result([])); // config FOR UPDATE 无行
      const r = await service.assignStudentIfNeeded(TENANT, STUDENT, CAMPUS, {
        userId: FINANCE,
        role: 'finance',
      });
      expect(r.assigned).toBe(false);
      expect(r.reason).toBe('auto_off');
      expect(txClient.query).toHaveBeenCalledTimes(2);
      expect(auditLog.log).not.toHaveBeenCalled();
    });

    it('config auto_assign_academic=false → 不分配', async () => {
      txClient.query
        .mockResolvedValueOnce(result([{ assigned_academic_id: null }]))
        .mockResolvedValueOnce(
          result([
            { auto_assign_academic: false, rr_last_academic_id: null },
          ]),
        );
      const r = await service.assignStudentIfNeeded(TENANT, STUDENT, CAMPUS, {
        userId: FINANCE,
        role: 'finance',
      });
      expect(r.assigned).toBe(false);
      expect(r.reason).toBe('auto_off');
    });
  });

  describe('池空：不报错', () => {
    it('auto on 但本校无在职 academic → 留 NULL + reason empty_pool，不抛', async () => {
      txClient.query
        .mockResolvedValueOnce(result([{ assigned_academic_id: null }])) // students
        .mockResolvedValueOnce(
          result([{ auto_assign_academic: true, rr_last_academic_id: null }]),
        ) // config
        .mockResolvedValueOnce(result([])); // pool empty
      const r = await service.assignStudentIfNeeded(TENANT, STUDENT, CAMPUS, {
        userId: FINANCE,
        role: 'finance',
      });
      expect(r.assigned).toBe(false);
      expect(r.reason).toBe('empty_pool');
      // 未 UPDATE students（3 次：students/config/pool）
      expect(txClient.query).toHaveBeenCalledTimes(3);
      expect(auditLog.log).not.toHaveBeenCalled();
    });
  });

  describe('campusId 缺失', () => {
    it('campusId=null（异常合同）→ 不进事务，留待分配', async () => {
      const r = await service.assignStudentIfNeeded(TENANT, STUDENT, null, {
        userId: FINANCE,
        role: 'finance',
      });
      expect(r.assigned).toBe(false);
      expect(r.reason).toBe('empty_pool');
      expect(pg.transaction).not.toHaveBeenCalled();
    });
  });

  describe('学员不存在', () => {
    it('students 查不到 → 不分配（side-effect 不抛）', async () => {
      txClient.query.mockResolvedValueOnce(result([])); // students 无行
      const r = await service.assignStudentIfNeeded(TENANT, STUDENT, CAMPUS, {
        userId: FINANCE,
        role: 'finance',
      });
      expect(r.assigned).toBe(false);
      expect(r.reason).toBe('empty_pool');
    });
  });

  describe('发牌池查询用 ASSIGNMENT_POOL_ROLES（默认仅 academic）', () => {
    it('pool 查询 role 参数 = ASSIGNMENT_POOL_ROLES + status 启用 + 同校', async () => {
      armAutoOn(null);
      await service.assignStudentIfNeeded(TENANT, STUDENT, CAMPUS, {
        userId: FINANCE,
        role: 'finance',
      });
      const poolCall = txClient.query.mock.calls[2];
      const sql = poolCall[0] as string;
      const params = poolCall[1];
      expect(sql).toContain('FROM users');
      expect(sql).toContain("status = '启用'");
      expect(params[0]).toEqual([...ASSIGNMENT_POOL_ROLES]);
      expect(params[1]).toBe(CAMPUS);
      // 默认池仅 academic
      expect(ASSIGNMENT_POOL_ROLES).toEqual(['academic']);
    });
  });

  describe('pickNext 纯函数', () => {
    it('null → 第一个', () => {
      expect(StudentAssignmentService.pickNext([A, B, C], null)).toBe(A);
    });
    it('环绕：C → A', () => {
      expect(StudentAssignmentService.pickNext([A, B, C], C)).toBe(A);
    });
    it('中间：A → B', () => {
      expect(StudentAssignmentService.pickNext([A, B, C], A)).toBe(B);
    });
    it('不在池 → 第一个', () => {
      expect(StudentAssignmentService.pickNext([A, B, C], 'zzz')).toBe(A);
    });
    it('单人池：自己 → 还是自己（环绕回 idx 0）', () => {
      expect(StudentAssignmentService.pickNext([A], A)).toBe(A);
    });
  });

  describe('FOR UPDATE 并发锁', () => {
    it('config 查询带 FOR UPDATE（锁配置行防双发）', async () => {
      armAutoOn(null);
      await service.assignStudentIfNeeded(TENANT, STUDENT, CAMPUS, {
        userId: FINANCE,
        role: 'finance',
      });
      const cfgCall = txClient.query.mock.calls[1];
      expect(cfgCall[0]).toContain('FOR UPDATE');
    });
  });

  describe('审计 fail-open', () => {
    it('auditLog 缺失（@Optional 未注入）→ 不抛，分配仍成功', async () => {
      const m = await Test.createTestingModule({
        providers: [
          StudentAssignmentService,
          { provide: PgPoolService, useValue: pg },
        ],
      }).compile();
      const svc = m.get(StudentAssignmentService);
      armAutoOn(null);
      const r = await svc.assignStudentIfNeeded(TENANT, STUDENT, CAMPUS, {
        userId: FINANCE,
        role: 'finance',
      });
      expect(r.assigned).toBe(true);
      expect(r.academicId).toBe(A);
    });
  });
});
