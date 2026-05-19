import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { Request } from 'express';
import { AuditLogRepository, normalizeActorRole } from '../db/audit-log.repository';

/**
 * ParentSelfGuard — T6b (2026-05-16) ParentController 守门
 *
 * 来源：T6a security audit Set 2 P0-2 (A01) — ParentController 0 @UseGuards,
 *   middleware fallback 收紧后仍需 controller 层二道防御.
 *
 * 职责：
 *   1. 校验 req.parent.sub === request.params.parentId
 *   2. 不匹配 → ForbiddenException + audit_log action='parent.access-denied'
 *   3. 无 :parentId path param（如 /register / /bindings/:bindingId/unbind）→ 跳过
 *   4. 无 req.parent（如 fallback 到 B 端 token 的旧 endpoint）→ 跳过（由其他 guard / service 兜底）
 *
 * 边界：
 *   - audit_log 失败不阻塞拒绝 (与 tenant.middleware.requireParentDbUser 一致)
 *   - AuditLogRepository @Optional 注入：单测无 DbModule 时仍可跑通
 */
@Injectable()
export class ParentSelfGuard implements CanActivate {
  private readonly logger = new Logger(ParentSelfGuard.name);

  constructor(@Optional() private readonly auditLog?: AuditLogRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & {
      parent?: { sub?: string; parentId?: string; role?: string };
      tenantSchema?: string;
    }>();

    const rawParam = request.params?.parentId;
    const paramParentId: string | undefined = typeof rawParam === 'string'
      ? rawParam
      : undefined;
    // 无 :parentId path param → 不在本 guard 校验范围（如 /register, /bindings/:bindingId/unbind）
    if (!paramParentId) return true;

    const parentSub = request.parent?.sub;
    // 无 req.parent → 不是 C 端流量（如 fallback 到 B 端 token 的兼容路径）。
    // 由其他鉴权层处理 — 本 guard 仅守 parent self 红线
    if (!parentSub) return true;

    if (parentSub === paramParentId) return true;

    // 不匹配 → audit_log + 403
    if (this.auditLog) {
      const tenantSchema = request.tenantSchema;
      if (tenantSchema) {
        try {
          await this.auditLog.log(tenantSchema, {
            actorUserId: parentSub,
            actorRole: normalizeActorRole('parent'),
            action: 'parent.access-denied',
            targetType: 'parent',
            targetId: paramParentId,
            before: null,
            after: {
              jwtParentId: parentSub,
              urlParentId: paramParentId,
              path: request.originalUrl || request.url,
            },
            ip: request.ip ?? null,
            userAgent: (request.headers?.['user-agent'] as string | undefined) ?? null,
            requestId:
              (request.headers?.['x-request-id'] as string | undefined) ?? null,
          });
        } catch {
          // audit_log 失败不阻塞拒绝
        }
      }
    }
    this.logger.warn(
      `[PARENT-SELF-MISMATCH] jwt.sub=${parentSub} tried url.parentId=${paramParentId} ` +
        `on ${request.method} ${request.originalUrl || request.url}`,
    );
    throw new ForbiddenException('parent_self_mismatch');
  }
}
