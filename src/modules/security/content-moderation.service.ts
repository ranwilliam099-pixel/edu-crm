import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { SecurityService } from './security.service';
import { AuditLogRepository, normalizeActorRole } from '../db/audit-log.repository';
import { AuthenticatedRequest } from '../auth/jwt-payload.interface';

/**
 * ContentModerationService — #24 B 端员工自由文本内容安全统一收口
 *
 * 来源：B 端自由文本 msgSecCheck 缺口（盘点 14 个写 endpoint / 20+ 自由文本字段全裸存）。
 *
 * 设计：
 *   - 复用 SecurityService.serverSideCheckContent（微信 v1，无 openid；B 端员工不透传 openid）。
 *   - 把 C 端 teacher-rating.controller 内联的 risky/review/fail-open/audit 40 行逻辑抽成单点，
 *     让 14 个 B 端 endpoint 各 1 行接入，不再复制粘贴。
 *   - 多字段合并为**一次**微信调用（省 access_token 限流；微信侧高频敏感）。
 *   - 审计**绝不写明文**（仅 contentLen / suggest / errcode；防 PII + 违规内容二次泄露）。
 *
 * 策略（mode，按 endpoint 传）：
 *   - 'reject'（默认，对齐 C 端 teacher-rating）：risky → audit + 抛 400 拒存。
 *   - 'audit-only'：risky → 仅 audit 标记后放行（适用于不宜阻断的员工必填流，由拍板决定）。
 *   两种 mode 下 review 都是 audit + 放行；SecurityService 故障都是 fail-open + audit。
 */

export type ModerationMode = 'reject' | 'audit-only';

export interface ModerationContext {
  /** 审计 actor（缺省回退 req.user.sub）*/
  actorUserId?: string | null;
  /** 审计 actorRole（缺省回退 req.user.role；经 normalizeActorRole 收口防 V33 CHECK 违反）*/
  actorRole?: string | null;
  /** 审计动作前缀，如 'lesson-feedback' → 'lesson-feedback.content-violation' */
  action: string;
  /** 审计对象类型，如 'lesson_feedback' */
  targetType: string;
  /** 审计对象 id（可空）*/
  targetId?: string | null;
  /** 请求（取 ip / user-agent / x-request-id / 兜底 actor）*/
  req?: AuthenticatedRequest;
}

@Injectable()
export class ContentModerationService {
  private readonly logger = new Logger(ContentModerationService.name);

  constructor(
    private readonly security: SecurityService,
    // @Optional：单测直接 new 时可省；生产由 @Global DbModule 注入
    @Optional() private readonly audit?: AuditLogRepository,
  ) {}

  /**
   * 校验 B 端员工自由文本。空文本（全 undefined/空白）直接跳过，不调微信。
   *
   * @param tenantSchema 审计落点（per-tenant schema）
   * @param texts        本次写入的自由文本字段集合（合并后单次检测）
   * @param ctx          审计上下文
   * @param mode         'reject'（默认）| 'audit-only'
   * @throws BadRequestException 当 mode='reject' 且微信判定 risky
   */
  async enforceStaffText(
    tenantSchema: string,
    texts: Array<string | null | undefined>,
    ctx: ModerationContext,
    mode: ModerationMode = 'reject',
  ): Promise<void> {
    const combined = texts
      .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      .join('\n')
      .slice(0, 2500); // 微信 msgSecCheck 文本上限 2500 字
    if (!combined) {
      return; // 无自由文本 → 跳过（不耗微信配额）
    }

    try {
      const check = await this.security.serverSideCheckContent(combined);
      if (check.suggest === 'risky') {
        await this.tryAudit(tenantSchema, ctx, `${ctx.action}.content-violation`, {
          suggest: 'risky',
          errcode: check.errcode ?? null,
          contentLen: combined.length,
          mode,
        });
        if (mode === 'reject') {
          throw new BadRequestException('content violates content policy');
        }
        return;
      }
      if (check.suggest === 'review') {
        await this.tryAudit(tenantSchema, ctx, `${ctx.action}.content-review`, {
          suggest: 'review',
          contentLen: combined.length,
        });
      }
    } catch (err) {
      // 业务拒绝（risky+reject）必须透传，不能被 fail-open 吞掉
      if (err instanceof BadRequestException) {
        throw err;
      }
      // SecurityService 网络/凭据故障 → fail-open（不阻塞主业务）+ audit 留痕
      this.logger.warn(
        `content moderation failed (fail-open): ${(err as Error).message}`,
      );
      await this.tryAudit(tenantSchema, ctx, `${ctx.action}.content-check-error`, {
        error: (err as Error).message,
        contentLen: combined.length,
      });
    }
  }

  /** 写一条内容安全审计（fail-open；绝不含明文 content）*/
  private async tryAudit(
    tenantSchema: string,
    ctx: ModerationContext,
    action: string,
    after: Record<string, unknown>,
  ): Promise<void> {
    if (!this.audit) {
      // 2026-06-01 Sprint Y 可观测性：AuditLogRepository @Global 恒注入，
      // undefined 仅错误配线/单测脱钩 → warn 防内容安全审计静默丢失（不含明文 content）
      this.logger.warn(
        `audit log repo not injected, skipping audit for ${action} (target=${ctx.targetId ?? null})`,
      );
      return;
    }
    try {
      await this.audit.log(tenantSchema, {
        actorUserId: ctx.actorUserId ?? ctx.req?.user?.sub ?? null,
        actorRole: normalizeActorRole(ctx.actorRole ?? ctx.req?.user?.role),
        action,
        targetType: ctx.targetType,
        targetId: ctx.targetId ?? null,
        before: null,
        after,
        ip: ctx.req?.ip ?? null,
        userAgent: (ctx.req?.headers?.['user-agent'] as string | undefined) ?? null,
        requestId: (ctx.req?.headers?.['x-request-id'] as string | undefined) ?? null,
      });
    } catch {
      // audit 写失败不阻塞主业务（AuditLogRepository.log 已内部 fail-open，此处兜底 @Optional 缺省）
    }
  }
}
