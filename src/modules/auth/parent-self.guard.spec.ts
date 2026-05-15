import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ParentSelfGuard } from './parent-self.guard';

/**
 * ParentSelfGuard 测试（T6b 2026-05-16）
 *
 * 来源：T6a security audit Set 2 P0-2 — ParentController 0 @UseGuards
 *
 * 覆盖：
 *   1. 有 :parentId path param + req.parent.sub 匹配 → 放行
 *   2. 有 :parentId path param + req.parent.sub 不匹配 → 403 + audit_log
 *   3. 无 :parentId path param（如 /register）→ 放行
 *   4. 无 req.parent（B 端 token 或未鉴权路径）→ 放行（不归本 guard 管）
 *   5. audit_log 注入但 tenantSchema 缺失 → 仍 403 但不写 audit
 *   6. audit_log 抛错 → fail-open，仍 403
 */
describe('ParentSelfGuard (T6b ParentController 守门)', () => {
  const PARENT_A = 'p00000000000000000000000000000A1';
  const PARENT_B = 'p00000000000000000000000000000B2';

  function makeContext(req: Record<string, unknown>): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => req,
      }),
    } as unknown as ExecutionContext;
  }

  function makeReq(overrides: Record<string, unknown> = {}): any {
    return {
      params: {},
      headers: {},
      method: 'POST',
      originalUrl: '/api/parents/x',
      url: '/api/parents/x',
      ip: '1.2.3.4',
      ...overrides,
    };
  }

  describe('放行场景', () => {
    it('无 :parentId path param → 跳过校验（如 /register, /bindings/:bindingId/unbind）', async () => {
      const guard = new ParentSelfGuard();
      const req = makeReq({
        params: {},
        parent: { sub: PARENT_A },
      });
      await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    });

    it('无 req.parent → 不是 C 端流量 → 跳过（其他鉴权层兜底）', async () => {
      const guard = new ParentSelfGuard();
      const req = makeReq({
        params: { parentId: PARENT_A },
        // 没有 req.parent
      });
      await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    });

    it('req.parent.sub === req.params.parentId → 放行', async () => {
      const guard = new ParentSelfGuard();
      const req = makeReq({
        params: { parentId: PARENT_A },
        parent: { sub: PARENT_A },
      });
      await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    });
  });

  describe('拒绝场景', () => {
    it('req.parent.sub !== req.params.parentId → 403 parent_self_mismatch', async () => {
      const guard = new ParentSelfGuard();
      const req = makeReq({
        params: { parentId: PARENT_B }, // 攻击 parent B 的资源
        parent: { sub: PARENT_A }, // 自己是 A
      });
      await expect(guard.canActivate(makeContext(req))).rejects.toThrow(
        ForbiddenException,
      );
      await expect(guard.canActivate(makeContext(req))).rejects.toThrow(
        'parent_self_mismatch',
      );
    });

    it('audit_log 注入 + tenantSchema 存在 → 写 parent.access-denied', async () => {
      const auditLog = { log: jest.fn().mockResolvedValue(undefined) };
      const guard = new ParentSelfGuard(auditLog as any);
      const req = makeReq({
        params: { parentId: PARENT_B },
        parent: { sub: PARENT_A },
        tenantSchema: 'tenant_xxx',
        originalUrl: '/api/parents/db/' + PARENT_B + '/children',
        headers: { 'user-agent': 'jest', 'x-request-id': 'req-T6b-1' },
      });
      await expect(guard.canActivate(makeContext(req))).rejects.toThrow(
        ForbiddenException,
      );
      expect(auditLog.log).toHaveBeenCalledTimes(1);
      const [schema, entry] = auditLog.log.mock.calls[0];
      expect(schema).toBe('tenant_xxx');
      expect(entry.action).toBe('parent.access-denied');
      expect(entry.actorUserId).toBe(PARENT_A);
      expect(entry.actorRole).toBe('parent');
      expect(entry.targetType).toBe('parent');
      expect(entry.targetId).toBe(PARENT_B);
      expect(entry.after).toMatchObject({
        jwtParentId: PARENT_A,
        urlParentId: PARENT_B,
      });
      expect(entry.requestId).toBe('req-T6b-1');
    });

    it('audit_log 注入但 tenantSchema 缺失 → 仍 403 但跳过 audit（无合法 schema 可写）', async () => {
      const auditLog = { log: jest.fn() };
      const guard = new ParentSelfGuard(auditLog as any);
      const req = makeReq({
        params: { parentId: PARENT_B },
        parent: { sub: PARENT_A },
        // 没有 tenantSchema
      });
      await expect(guard.canActivate(makeContext(req))).rejects.toThrow(
        ForbiddenException,
      );
      expect(auditLog.log).not.toHaveBeenCalled();
    });

    it('audit_log 抛错 → fail-open 不阻塞 403', async () => {
      const auditLog = {
        log: jest.fn().mockRejectedValue(new Error('PG down')),
      };
      const guard = new ParentSelfGuard(auditLog as any);
      const req = makeReq({
        params: { parentId: PARENT_B },
        parent: { sub: PARENT_A },
        tenantSchema: 'tenant_xxx',
      });
      await expect(guard.canActivate(makeContext(req))).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('无 AuditLogRepository 注入（单测模式）→ 仍 403', async () => {
      const guard = new ParentSelfGuard(); // 不传 auditLog
      const req = makeReq({
        params: { parentId: PARENT_B },
        parent: { sub: PARENT_A },
        tenantSchema: 'tenant_xxx',
      });
      await expect(guard.canActivate(makeContext(req))).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
});
