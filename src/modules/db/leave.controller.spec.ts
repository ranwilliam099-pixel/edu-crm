/**
 * leave.controller.spec.ts (5/20 stryker 0% coverage 修补)
 *
 * 来源：5/20 stryker mutation 跑出 LeaveController 59 mutant 全 no-cov
 *   → V16 请假/调课申请 HTTP 暴露（学员/家长提交 + 老师/管理员批准/驳回），
 *     上线后从未测试，dev 改坏单测全绿
 *
 * 4 endpoint 覆盖：
 *   - POST /db/leaves                              — createLeave
 *   - POST /db/students/:studentId/leaves/list     — listByStudent
 *   - POST /db/leaves/:id/approve                  — approveLeave
 *   - POST /db/leaves/:id/reject                   — rejectLeave
 *
 * 覆盖 case：
 *   1. createLeave() — x-tenant-schema 缺 → BadRequest
 *   2. createLeave() — id 缺 → BadRequest "id must be 32-char ULID"
 *   3. createLeave() — id 长度 ≠ 32 → BadRequest
 *   4. createLeave() — studentId 缺 → BadRequest
 *   5. createLeave() — studentId 长度 ≠ 32 → BadRequest
 *   6. createLeave() — type 非 leave/reschedule → BadRequest
 *   7. createLeave() — type='leave' happy path（默认 status=pending / createdAt 是 Date）
 *   8. createLeave() — type='reschedule' + newDateMs/newStartAtMs 转 Date
 *   9. createLeave() — 不传 newDateMs/newStartAtMs → 透传 undefined
 *   10. createLeave() — lessonStartAtMs > 24h → 无 warning
 *   11. createLeave() — lessonStartAtMs < 24h → warning="距上课不足 24 小时，申请可能被驳回"
 *   12. createLeave() — lessonStartAtMs = 0（falsy）→ 跳过 warning 判定
 *   13. createLeave() — lessonStartAtMs 在 24h 边界（恰 24h）→ 无 warning
 *   14. listByStudent() — x-tenant-schema 缺 → BadRequest
 *   15. listByStudent() — limit 缺 → 默认 50
 *   16. listByStudent() — limit 指定 → 转交
 *   17. approveLeave() — x-tenant-schema 缺 → BadRequest
 *   18. approveLeave() — 不传 newDate/newStartAt → 透传 undefined
 *   19. approveLeave() — 传 newDateMs/newStartAtMs → 转 Date
 *   20. approveLeave() — service NotFound → 透传
 *   21. rejectLeave() — x-tenant-schema 缺 → BadRequest
 *   22. rejectLeave() — reason 缺 → BadRequest "reason required"
 *   23. rejectLeave() — happy path 转交 reject(tenantSchema, id, reason)
 *   24. rejectLeave() — service NotFound → 透传
 *
 * 学到的范式：精确 toHaveBeenCalledWith / rejects.toThrow / 时间 mock Date.now
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { LeaveController } from './leave.controller';
import { LeaveRepository, Leave, LeaveType } from './leave.repository';

describe('LeaveController (5/20 stryker 0% coverage 修补)', () => {
  let controller: LeaveController;
  let leaveRepo: {
    create: jest.Mock;
    findByStudent: jest.Mock;
    approve: jest.Mock;
    reject: jest.Mock;
  };

  // 32-char ULID 固定值
  const TENANT_SCHEMA = 'tenant_leave000000000000000000ab01';
  const LEAVE_ID = 'leaveID0000000000000000000000A01';
  const STUDENT_ID = 'studentLeave000000000000000000A1';
  const LESSON_ID = 'lessonLeave0000000000000000000A1';

  // 固定 now 锚点：2026-05-20T12:00:00 UTC = 1779192000000
  const NOW_MS = new Date('2026-05-20T12:00:00.000Z').getTime();

  function leaveFixture(overrides: Partial<Leave> = {}): Leave {
    return {
      id: LEAVE_ID,
      studentId: STUDENT_ID,
      lessonId: LESSON_ID,
      type: 'leave',
      reason: '生病',
      reasonNote: undefined,
      newDate: undefined,
      newStartAt: undefined,
      status: 'pending',
      rejectReason: undefined,
      createdAt: new Date('2026-05-20T12:00:00.000Z'),
      decidedAt: undefined,
      ...overrides,
    };
  }

  beforeEach(() => {
    leaveRepo = {
      create: jest.fn(),
      findByStudent: jest.fn(),
      approve: jest.fn(),
      reject: jest.fn(),
    };
    controller = new LeaveController(
      leaveRepo as unknown as LeaveRepository,
    );

    jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ============================================================
  // Case 1-13: createLeave()
  // ============================================================
  describe('createLeave()', () => {
    function validBody() {
      return {
        id: LEAVE_ID,
        studentId: STUDENT_ID,
        lessonId: LESSON_ID,
        type: 'leave' as LeaveType,
        reason: '生病',
      };
    }

    it('x-tenant-schema 缺 → BadRequest instanceof', async () => {
      await expect(
        controller.createLeave('', validBody()),
      ).rejects.toThrow(BadRequestException);
      expect(leaveRepo.create).not.toHaveBeenCalled();
    });

    it('x-tenant-schema 缺 → message "x-tenant-schema header required"', async () => {
      await expect(
        controller.createLeave('', validBody()),
      ).rejects.toThrow('x-tenant-schema header required');
    });

    it('id 缺 → BadRequest "id must be 32-char ULID"', async () => {
      const body = { ...validBody(), id: '' };
      await expect(
        controller.createLeave(TENANT_SCHEMA, body),
      ).rejects.toThrow('id must be 32-char ULID');
    });

    it('id 长度 ≠ 32 → BadRequest', async () => {
      const body = { ...validBody(), id: 'a'.repeat(31) };
      await expect(
        controller.createLeave(TENANT_SCHEMA, body),
      ).rejects.toThrow('id must be 32-char ULID');
    });

    it('id 长度 33 → BadRequest', async () => {
      const body = { ...validBody(), id: 'a'.repeat(33) };
      await expect(
        controller.createLeave(TENANT_SCHEMA, body),
      ).rejects.toThrow('id must be 32-char ULID');
    });

    it('studentId 缺 → BadRequest', async () => {
      const body = { ...validBody(), studentId: '' };
      await expect(
        controller.createLeave(TENANT_SCHEMA, body),
      ).rejects.toThrow('studentId must be 32-char ULID');
    });

    it('studentId 长度 ≠ 32 → BadRequest', async () => {
      const body = { ...validBody(), studentId: 's'.repeat(20) };
      await expect(
        controller.createLeave(TENANT_SCHEMA, body),
      ).rejects.toThrow('studentId must be 32-char ULID');
    });

    it('type 非 leave/reschedule → BadRequest 含传入值', async () => {
      const body = { ...validBody(), type: 'cancel' as any };
      await expect(
        controller.createLeave(TENANT_SCHEMA, body),
      ).rejects.toThrow('type must be leave|reschedule, got: cancel');
    });

    it('type=undefined → BadRequest', async () => {
      const body = { ...validBody(), type: undefined as any };
      await expect(
        controller.createLeave(TENANT_SCHEMA, body),
      ).rejects.toThrow('type must be leave|reschedule');
    });

    it('type="leave" happy path — status=pending + createdAt 是 Date + 无 warning', async () => {
      const saved = leaveFixture();
      leaveRepo.create.mockResolvedValueOnce(saved);

      const result = await controller.createLeave(TENANT_SCHEMA, validBody());

      expect(leaveRepo.create).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        expect.objectContaining({
          id: LEAVE_ID,
          studentId: STUDENT_ID,
          lessonId: LESSON_ID,
          type: 'leave',
          reason: '生病',
          status: 'pending',
          newDate: undefined,
          newStartAt: undefined,
        }),
      );
      // createdAt 是 Date 实例（不写死毫秒，避免被 mock 时区误差）
      const callArg = leaveRepo.create.mock.calls[0][1] as Leave;
      expect(callArg.createdAt).toBeInstanceOf(Date);
      expect(result).toEqual({ leave: saved });
    });

    it('type="reschedule" + newDateMs + newStartAtMs → 转 Date', async () => {
      const saved = leaveFixture({ type: 'reschedule' });
      leaveRepo.create.mockResolvedValueOnce(saved);

      const newDateMs = new Date('2026-06-01T00:00:00.000Z').getTime();
      const newStartAtMs = new Date('2026-06-01T14:00:00.000Z').getTime();

      const body = {
        ...validBody(),
        type: 'reschedule' as LeaveType,
        newDateMs,
        newStartAtMs,
      };
      await controller.createLeave(TENANT_SCHEMA, body);

      const callArg = leaveRepo.create.mock.calls[0][1] as Leave;
      expect(callArg.type).toBe('reschedule');
      expect(callArg.newDate).toEqual(new Date(newDateMs));
      expect(callArg.newStartAt).toEqual(new Date(newStartAtMs));
    });

    it('不传 newDateMs/newStartAtMs → 透传 undefined（不转 Date(undefined)）', async () => {
      leaveRepo.create.mockResolvedValueOnce(leaveFixture());

      await controller.createLeave(TENANT_SCHEMA, validBody());

      const callArg = leaveRepo.create.mock.calls[0][1] as Leave;
      expect(callArg.newDate).toBeUndefined();
      expect(callArg.newStartAt).toBeUndefined();
    });

    it('newDateMs=0 (falsy) → 透传 undefined（短路条件）', async () => {
      leaveRepo.create.mockResolvedValueOnce(leaveFixture());

      const body = { ...validBody(), newDateMs: 0, newStartAtMs: 0 };
      await controller.createLeave(TENANT_SCHEMA, body);

      const callArg = leaveRepo.create.mock.calls[0][1] as Leave;
      expect(callArg.newDate).toBeUndefined();
      expect(callArg.newStartAt).toBeUndefined();
    });

    it('lessonStartAtMs > 24h 后 → 无 warning', async () => {
      leaveRepo.create.mockResolvedValueOnce(leaveFixture());

      const body = {
        ...validBody(),
        lessonStartAtMs: NOW_MS + 48 * 60 * 60 * 1000, // 2 天后
      };
      const result = await controller.createLeave(TENANT_SCHEMA, body);

      expect(result.warning).toBeUndefined();
      expect(result).toEqual({ leave: expect.any(Object) });
    });

    it('lessonStartAtMs < 24h 后 → warning 提示 24h', async () => {
      const saved = leaveFixture();
      leaveRepo.create.mockResolvedValueOnce(saved);

      const body = {
        ...validBody(),
        lessonStartAtMs: NOW_MS + 12 * 60 * 60 * 1000, // 12h 后
      };
      const result = await controller.createLeave(TENANT_SCHEMA, body);

      expect(result).toEqual({
        leave: saved,
        warning: '距上课不足 24 小时，申请可能被驳回',
      });
    });

    it('lessonStartAtMs 已过去（负差）→ warning（< 24h 包含负数）', async () => {
      leaveRepo.create.mockResolvedValueOnce(leaveFixture());

      const body = {
        ...validBody(),
        lessonStartAtMs: NOW_MS - 60 * 60 * 1000, // 1h 前
      };
      const result = await controller.createLeave(TENANT_SCHEMA, body);

      expect(result.warning).toBe('距上课不足 24 小时，申请可能被驳回');
    });

    it('lessonStartAtMs 恰 24h 后（边界）— diff===24h 不严格小于 → 无 warning', async () => {
      leaveRepo.create.mockResolvedValueOnce(leaveFixture());

      const body = {
        ...validBody(),
        lessonStartAtMs: NOW_MS + 24 * 60 * 60 * 1000,
      };
      const result = await controller.createLeave(TENANT_SCHEMA, body);

      // controller 用 `< ELAPSED_24H`，正好相等 → 不触发
      expect(result.warning).toBeUndefined();
    });

    it('lessonStartAtMs=0 (falsy) → 跳过 warning 判定', async () => {
      leaveRepo.create.mockResolvedValueOnce(leaveFixture());

      const body = { ...validBody(), lessonStartAtMs: 0 };
      const result = await controller.createLeave(TENANT_SCHEMA, body);

      expect(result.warning).toBeUndefined();
    });

    it('lessonStartAtMs undefined → 跳过 warning 判定', async () => {
      leaveRepo.create.mockResolvedValueOnce(leaveFixture());

      const result = await controller.createLeave(TENANT_SCHEMA, validBody());

      expect(result.warning).toBeUndefined();
    });

    it('可选字段 reason/reasonNote/lessonId 缺 → 透传 undefined', async () => {
      leaveRepo.create.mockResolvedValueOnce(leaveFixture());

      const body = {
        id: LEAVE_ID,
        studentId: STUDENT_ID,
        type: 'leave' as LeaveType,
      };
      await controller.createLeave(TENANT_SCHEMA, body);

      const callArg = leaveRepo.create.mock.calls[0][1] as Leave;
      expect(callArg.reason).toBeUndefined();
      expect(callArg.reasonNote).toBeUndefined();
      expect(callArg.lessonId).toBeUndefined();
    });

    it('service 抛错 → controller 透传', async () => {
      leaveRepo.create.mockRejectedValueOnce(new Error('db down'));

      await expect(
        controller.createLeave(TENANT_SCHEMA, validBody()),
      ).rejects.toThrow('db down');
    });
  });

  // ============================================================
  // Case 14-16: listByStudent()
  // ============================================================
  describe('listByStudent()', () => {
    it('x-tenant-schema 缺 → BadRequest', async () => {
      await expect(
        controller.listByStudent(STUDENT_ID, '', {}),
      ).rejects.toThrow('x-tenant-schema header required');
      expect(leaveRepo.findByStudent).not.toHaveBeenCalled();
    });

    it('limit 缺 → 默认 50', async () => {
      leaveRepo.findByStudent.mockResolvedValueOnce([]);

      await controller.listByStudent(STUDENT_ID, TENANT_SCHEMA, {});

      expect(leaveRepo.findByStudent).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        STUDENT_ID,
        50,
      );
    });

    it('limit 指定 → 转交给 repo', async () => {
      leaveRepo.findByStudent.mockResolvedValueOnce([]);

      await controller.listByStudent(STUDENT_ID, TENANT_SCHEMA, { limit: 10 });

      expect(leaveRepo.findByStudent).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        STUDENT_ID,
        10,
      );
    });

    it('返多条记录 → 直接转交', async () => {
      const items = [leaveFixture(), leaveFixture({ id: 'L2'.padEnd(32, 'b') })];
      leaveRepo.findByStudent.mockResolvedValueOnce(items);

      const result = await controller.listByStudent(STUDENT_ID, TENANT_SCHEMA, {});

      expect(result).toEqual(items);
    });

    it('limit=0 → 透传 0（非 falsy 兜底）— 实际是 0 进 ?? 走兜底 50', async () => {
      // 实现：body.limit ?? 50 — `0 ?? 50` 短路：0 不是 nullish → 走 0
      leaveRepo.findByStudent.mockResolvedValueOnce([]);

      await controller.listByStudent(STUDENT_ID, TENANT_SCHEMA, { limit: 0 });

      // ?? 运算符仅 null/undefined 走兜底，0 不算 → 透传 0
      expect(leaveRepo.findByStudent).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        STUDENT_ID,
        0,
      );
    });
  });

  // ============================================================
  // Case 17-20: approveLeave()
  // ============================================================
  describe('approveLeave()', () => {
    it('x-tenant-schema 缺 → BadRequest', async () => {
      await expect(
        controller.approveLeave(LEAVE_ID, '', {}),
      ).rejects.toThrow('x-tenant-schema header required');
      expect(leaveRepo.approve).not.toHaveBeenCalled();
    });

    it('不传 newDateMs/newStartAtMs → 透传 { newDate: undefined, newStartAt: undefined }', async () => {
      const approved = leaveFixture({
        status: 'approved',
        decidedAt: new Date('2026-05-21T00:00:00.000Z'),
      });
      leaveRepo.approve.mockResolvedValueOnce(approved);

      const result = await controller.approveLeave(LEAVE_ID, TENANT_SCHEMA, {});

      expect(leaveRepo.approve).toHaveBeenCalledWith(TENANT_SCHEMA, LEAVE_ID, {
        newDate: undefined,
        newStartAt: undefined,
      });
      expect(result).toEqual(approved);
    });

    it('传 newDateMs + newStartAtMs → 转 Date 给 repo', async () => {
      const approved = leaveFixture({ status: 'approved' });
      leaveRepo.approve.mockResolvedValueOnce(approved);

      const newDateMs = new Date('2026-06-15T00:00:00.000Z').getTime();
      const newStartAtMs = new Date('2026-06-15T15:00:00.000Z').getTime();

      await controller.approveLeave(LEAVE_ID, TENANT_SCHEMA, {
        newDateMs,
        newStartAtMs,
      });

      expect(leaveRepo.approve).toHaveBeenCalledWith(TENANT_SCHEMA, LEAVE_ID, {
        newDate: new Date(newDateMs),
        newStartAt: new Date(newStartAtMs),
      });
    });

    it('newDateMs=0 → 透传 undefined（falsy 短路）', async () => {
      leaveRepo.approve.mockResolvedValueOnce(leaveFixture({ status: 'approved' }));

      await controller.approveLeave(LEAVE_ID, TENANT_SCHEMA, {
        newDateMs: 0,
        newStartAtMs: 0,
      });

      expect(leaveRepo.approve).toHaveBeenCalledWith(TENANT_SCHEMA, LEAVE_ID, {
        newDate: undefined,
        newStartAt: undefined,
      });
    });

    it('只传 newDateMs（不传 newStartAtMs）— 各自独立判定', async () => {
      leaveRepo.approve.mockResolvedValueOnce(leaveFixture({ status: 'approved' }));

      const newDateMs = new Date('2026-07-01T00:00:00.000Z').getTime();
      await controller.approveLeave(LEAVE_ID, TENANT_SCHEMA, { newDateMs });

      expect(leaveRepo.approve).toHaveBeenCalledWith(TENANT_SCHEMA, LEAVE_ID, {
        newDate: new Date(newDateMs),
        newStartAt: undefined,
      });
    });

    it('service NotFound → controller 透传', async () => {
      leaveRepo.approve.mockRejectedValueOnce(
        new NotFoundException(`leave ${LEAVE_ID} not found`),
      );

      await expect(
        controller.approveLeave(LEAVE_ID, TENANT_SCHEMA, {}),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ============================================================
  // Case 21-24: rejectLeave()
  // ============================================================
  describe('rejectLeave()', () => {
    it('x-tenant-schema 缺 → BadRequest', async () => {
      await expect(
        controller.rejectLeave(LEAVE_ID, '', { reason: 'X' }),
      ).rejects.toThrow('x-tenant-schema header required');
      expect(leaveRepo.reject).not.toHaveBeenCalled();
    });

    it('reason 缺（空串）→ BadRequest "reason required"', async () => {
      await expect(
        controller.rejectLeave(LEAVE_ID, TENANT_SCHEMA, { reason: '' }),
      ).rejects.toThrow('reason required');
      expect(leaveRepo.reject).not.toHaveBeenCalled();
    });

    it('reason undefined → BadRequest', async () => {
      await expect(
        controller.rejectLeave(LEAVE_ID, TENANT_SCHEMA, {
          reason: undefined as any,
        }),
      ).rejects.toThrow('reason required');
    });

    it('happy path 转交 reject(tenantSchema, id, reason)', async () => {
      const rejected = leaveFixture({
        status: 'rejected',
        rejectReason: '距上课 < 1h',
        decidedAt: new Date('2026-05-21T00:00:00.000Z'),
      });
      leaveRepo.reject.mockResolvedValueOnce(rejected);

      const result = await controller.rejectLeave(LEAVE_ID, TENANT_SCHEMA, {
        reason: '距上课 < 1h',
      });

      expect(leaveRepo.reject).toHaveBeenCalledWith(
        TENANT_SCHEMA,
        LEAVE_ID,
        '距上课 < 1h',
      );
      expect(result).toEqual(rejected);
    });

    it('service NotFound → controller 透传', async () => {
      leaveRepo.reject.mockRejectedValueOnce(
        new NotFoundException(`leave ${LEAVE_ID} not found`),
      );

      await expect(
        controller.rejectLeave(LEAVE_ID, TENANT_SCHEMA, { reason: 'X' }),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
