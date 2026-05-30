import { BadRequestException } from '@nestjs/common';
import { ContentModerationService } from './content-moderation.service';
import { SecurityService, SecurityCheckResult } from './security.service';
import { AuditLogRepository } from '../db/audit-log.repository';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';

/**
 * ContentModerationService spec — #24 B 端自由文本内容安全统一收口
 *
 * 覆盖：
 *   - 空文本 → 跳过（不调微信 / 不审计）
 *   - pass → 放行无审计
 *   - risky + reject（默认）→ audit content-violation + 抛 400
 *   - risky + audit-only → audit + 放行（不抛）
 *   - review → audit content-review + 放行
 *   - SecurityService 故障 → fail-open + audit content-check-error（不抛非业务异常）
 *   - 多字段合并为单次 serverSideCheckContent 调用（省限流）
 *   - 审计 after 绝不含明文 content（仅 contentLen）
 *   - actor 取 req.user.sub / normalizeActorRole；溯源 ip/ua/requestId 透传
 *   - 文本超 2500 截断
 */
describe('ContentModerationService (#24)', () => {
  let svc: ContentModerationService;
  let security: { serverSideCheckContent: jest.Mock };
  let audit: { log: jest.Mock };

  const TENANT = 'tenant_moderation_test_xxxxxxxxxx';
  const REQ = {
    user: { sub: 'usrTeacher000000000000000000T001', role: 'teacher' },
    ip: '10.1.2.3',
    headers: { 'user-agent': 'jest', 'x-request-id': 'req-mod-001' },
  } as unknown as AuthenticatedRequest;

  const ctx = (over: Record<string, unknown> = {}) => ({
    action: 'lesson-feedback',
    targetType: 'lesson_feedback',
    targetId: 'fbk00000000000000000000000000F01',
    req: REQ,
    ...over,
  });

  const result = (suggest: SecurityCheckResult['suggest'], extra: Partial<SecurityCheckResult> = {}): SecurityCheckResult => ({
    ok: suggest === 'pass',
    suggest,
    ...extra,
  });

  beforeEach(() => {
    security = { serverSideCheckContent: jest.fn() };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    svc = new ContentModerationService(
      security as unknown as SecurityService,
      audit as unknown as AuditLogRepository,
    );
  });

  describe('空文本跳过', () => {
    it('全 undefined/null/空白 → 不调微信、不审计、不抛', async () => {
      await expect(
        svc.enforceStaffText(TENANT, [undefined, null, '', '   '], ctx()),
      ).resolves.toBeUndefined();
      expect(security.serverSideCheckContent).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });
  });

  describe('pass', () => {
    it('放行 + 不审计', async () => {
      security.serverSideCheckContent.mockResolvedValueOnce(result('pass'));
      await svc.enforceStaffText(TENANT, ['正常的课堂反馈内容'], ctx());
      expect(security.serverSideCheckContent).toHaveBeenCalledTimes(1);
      expect(audit.log).not.toHaveBeenCalled();
    });
  });

  describe('risky', () => {
    it("mode='reject'（默认）→ audit content-violation + 抛 400", async () => {
      security.serverSideCheckContent.mockResolvedValueOnce(
        result('risky', { errcode: 87014 }),
      );
      await expect(
        svc.enforceStaffText(TENANT, ['违规文本'], ctx()),
      ).rejects.toThrow(BadRequestException);

      expect(audit.log).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({
          actorUserId: 'usrTeacher000000000000000000T001',
          actorRole: 'teacher',
          action: 'lesson-feedback.content-violation',
          targetType: 'lesson_feedback',
          targetId: 'fbk00000000000000000000000000F01',
          ip: '10.1.2.3',
          userAgent: 'jest',
          requestId: 'req-mod-001',
        }),
      );
    });

    it("mode='audit-only' → audit + 放行（不抛）", async () => {
      security.serverSideCheckContent.mockResolvedValueOnce(result('risky'));
      await expect(
        svc.enforceStaffText(TENANT, ['违规文本'], ctx(), 'audit-only'),
      ).resolves.toBeUndefined();
      expect(audit.log).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({ action: 'lesson-feedback.content-violation' }),
      );
    });

    it('审计 after 绝不含明文 content（仅 contentLen）', async () => {
      const secret = '违规明文不应进审计日志';
      security.serverSideCheckContent.mockResolvedValueOnce(result('risky'));
      await expect(
        svc.enforceStaffText(TENANT, [secret], ctx()),
      ).rejects.toThrow(BadRequestException);

      const entry = audit.log.mock.calls[0][1];
      expect(JSON.stringify(entry.after)).not.toContain(secret);
      expect(entry.after.contentLen).toBe(secret.length);
      expect(entry.before).toBeNull();
    });
  });

  describe('review', () => {
    it('audit content-review + 放行', async () => {
      security.serverSideCheckContent.mockResolvedValueOnce(result('review'));
      await expect(
        svc.enforceStaffText(TENANT, ['模棱两可文本'], ctx()),
      ).resolves.toBeUndefined();
      expect(audit.log).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({
          action: 'lesson-feedback.content-review',
          targetType: 'lesson_feedback',
        }),
      );
    });
  });

  describe('SecurityService 故障 fail-open', () => {
    it('serverSideCheckContent 抛 → 不阻塞主业务 + audit content-check-error', async () => {
      security.serverSideCheckContent.mockRejectedValueOnce(new Error('wx token boom'));
      await expect(
        svc.enforceStaffText(TENANT, ['任意文本'], ctx()),
      ).resolves.toBeUndefined();
      expect(audit.log).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({ action: 'lesson-feedback.content-check-error' }),
      );
    });

    it('业务拒绝（risky+reject 的 400）不被 fail-open 吞', async () => {
      security.serverSideCheckContent.mockResolvedValueOnce(result('risky'));
      await expect(
        svc.enforceStaffText(TENANT, ['违规'], ctx()),
      ).rejects.toThrow('content violates content policy');
      // 仅 1 条 violation 审计，不应再有 check-error 审计
      expect(audit.log).toHaveBeenCalledTimes(1);
    });
  });

  describe('多字段合并', () => {
    it('多个字段合并为单次微信调用（省 access_token 限流）', async () => {
      security.serverSideCheckContent.mockResolvedValueOnce(result('pass'));
      await svc.enforceStaffText(
        TENANT,
        ['作业批语', undefined, '老师反馈', '', '下节预习'],
        ctx(),
      );
      expect(security.serverSideCheckContent).toHaveBeenCalledTimes(1);
      const sent = security.serverSideCheckContent.mock.calls[0][0] as string;
      expect(sent).toContain('作业批语');
      expect(sent).toContain('老师反馈');
      expect(sent).toContain('下节预习');
    });

    it('文本超 2500 字截断', async () => {
      security.serverSideCheckContent.mockResolvedValueOnce(result('pass'));
      await svc.enforceStaffText(TENANT, ['字'.repeat(5000)], ctx());
      const sent = security.serverSideCheckContent.mock.calls[0][0] as string;
      expect(sent.length).toBe(2500);
    });
  });

  describe('actor 兜底', () => {
    it('显式 actorUserId/actorRole 覆盖 req', async () => {
      security.serverSideCheckContent.mockResolvedValueOnce(result('review'));
      await svc.enforceStaffText(
        TENANT,
        ['x'],
        ctx({ actorUserId: 'usrAdmin0000000000000000000A001', actorRole: 'admin' }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({
          actorUserId: 'usrAdmin0000000000000000000A001',
          actorRole: 'admin',
        }),
      );
    });

    it('越界 role → normalizeActorRole 收口为 system', async () => {
      security.serverSideCheckContent.mockResolvedValueOnce(result('review'));
      await svc.enforceStaffText(TENANT, ['x'], ctx({ actorRole: 'bogus_role', req: undefined }));
      expect(audit.log).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({ actorRole: 'system', actorUserId: null }),
      );
    });
  });

  describe('audit 缺省（@Optional 未注入）', () => {
    it('无 audit repo → risky 仍抛 400（审计静默跳过不报错）', async () => {
      const noAudit = new ContentModerationService(
        security as unknown as SecurityService,
        undefined,
      );
      security.serverSideCheckContent.mockResolvedValueOnce(result('risky'));
      await expect(
        noAudit.enforceStaffText(TENANT, ['违规'], ctx()),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
