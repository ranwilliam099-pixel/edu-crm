import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtPayload, isPlatformRole } from '../modules/auth/jwt-payload.interface';

/**
 * TenantScopeGuard — 跨租户隔离防越权（2026-05-05 全面测试发现的漏洞修复）
 *
 * 来源：
 *   - 用户 2026-05-05「有漏洞你就解决啊」
 *   - 全面测试 §5：boss / 新 endpoint 不校验 token.tenantId 与 body/query/header 一致性
 *   - 2026-05-11 Sprint B 复审：补 body.tenantSchema 校验缺口（17 个 /db endpoint 实际用此字段传 schema 名）
 *
 * 漏洞场景：
 *   员工 A（tenantId=A）持有自己的 JWT，调用：
 *     POST /api/db/boss/subscription/upgrade { tenantId: "B", targetPlan: "growth" }
 *   后端只看 body 不看 token → 误改了 B 公司的订阅 ❌
 *
 *   2026-05-11 新发现：admin_A JWT + body: { tenantSchema: 'tenant_B' } → 旧 Guard 放行
 *   → 跳过 self-check（admin/boss 跳过）→ 写入 tenant_B 数据 ❌
 *
 * 防护规则：
 *   1. 没有 req.user                       → 401（middleware 应已抛，guard 兜底）
 *   2. user.role 是平台角色（platform_admin / finance_admin）→ 放行（可跨 tenant）
 *   3. body.tenantId !== user.tenantId     → 403
 *   4. body.tenantSchema !== `tenant_${user.tenantId.toLowerCase()}`  → 403 (Sprint B 新增)
 *      （body.tenantSchema 大小写归一化后 strip 'tenant_' 前缀 === user.tenantId.toLowerCase()）
 *   5. query.tenantId !== user.tenantId    → 403
 *   6. header x-tenant-schema              必须 === `tenant_${user.tenantId.toLowerCase()}`
 *      不一致 → 403
 *   7. 都没传 tenantId/tenantSchema 标识    → 放行（让 controller 自己处理）
 *
 * 用法：在 controller 上 @UseGuards(TenantScopeGuard)
 *
 * 边界：
 *   - 不依赖任何业务模块，只读 JwtPayload
 *   - 不依赖 ORM / DB
 *   - middleware 已注入 req.user 后才生效（auth 流程在前）
 */
@Injectable()
export class TenantScopeGuard implements CanActivate {
  private readonly logger = new Logger(TenantScopeGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const user = (req as { user?: JwtPayload }).user;

    if (!user) {
      throw new UnauthorizedException('TenantScopeGuard: req.user not set (middleware should have run)');
    }

    // 平台角色：可跨 tenant 访问（用于客户经理 / 平台运维）
    if (isPlatformRole(user.role)) {
      return true;
    }

    // 普通角色：必须有 tenantId
    if (!user.tenantId) {
      throw new ForbiddenException('TenantScopeGuard: tenant role requires non-null tenantId in JWT');
    }

    const expectedTenantId = user.tenantId;
    const expectedSchema = `tenant_${expectedTenantId.toLowerCase()}`;

    // 1. body.tenantId 校验
    const bodyTid = req.body?.tenantId;
    if (bodyTid !== undefined && bodyTid !== null && bodyTid !== expectedTenantId) {
      this.logger.warn(
        `[CROSS-TENANT-DENIED] user=${user.sub} (tenant=${expectedTenantId}) tried body.tenantId=${bodyTid} on ${req.method} ${req.url}`,
      );
      throw new ForbiddenException(
        `tenantId mismatch: body has '${bodyTid}', JWT has '${expectedTenantId}'`,
      );
    }

    // 2. body.tenantSchema 校验（Sprint B 2026-05-11 新增）
    //   - 17 个 /db endpoint 实际用 body.tenantSchema 字段传 schema 名（不是 body.tenantId）
    //   - 攻击：admin_A JWT + body: { tenantSchema: 'tenant_B' } → 旧 Guard 放行 → 跳过 self-check → 写入 tenant_B 数据
    //   - 防御：strip 'tenant_' 前缀后小写比对 user.tenantId（双向 toLowerCase 避免大小写不一致）
    const bodySchema = req.body?.tenantSchema;
    if (bodySchema !== undefined && bodySchema !== null) {
      const normalizedSchema = String(bodySchema).toLowerCase();
      if (normalizedSchema !== expectedSchema) {
        this.logger.warn(
          `[CROSS-TENANT-DENIED] user=${user.sub} (tenant=${expectedTenantId}) tried body.tenantSchema=${bodySchema} on ${req.method} ${req.url}`,
        );
        throw new ForbiddenException(
          `tenantSchema mismatch: body has '${bodySchema}', expected '${expectedSchema}'`,
        );
      }
    }

    // 3. query.tenantId 校验
    const queryTid = req.query?.tenantId;
    if (queryTid !== undefined && queryTid !== null && queryTid !== expectedTenantId) {
      this.logger.warn(
        `[CROSS-TENANT-DENIED] user=${user.sub} (tenant=${expectedTenantId}) tried query.tenantId=${queryTid} on ${req.method} ${req.url}`,
      );
      throw new ForbiddenException(
        `tenantId mismatch: query has '${queryTid}', JWT has '${expectedTenantId}'`,
      );
    }

    // 4. query.tenantSchema 校验（与 body.tenantSchema 对称）
    //   - 部分 controller 用 @Query('tenantSchema')（如 customer.controller.ts:115）
    const querySchema = req.query?.tenantSchema;
    if (querySchema !== undefined && querySchema !== null) {
      const normalizedSchema = String(querySchema).toLowerCase();
      if (normalizedSchema !== expectedSchema) {
        this.logger.warn(
          `[CROSS-TENANT-DENIED] user=${user.sub} (tenant=${expectedTenantId}) tried query.tenantSchema=${querySchema} on ${req.method} ${req.url}`,
        );
        throw new ForbiddenException(
          `tenantSchema mismatch: query has '${querySchema}', expected '${expectedSchema}'`,
        );
      }
    }

    // 5. header x-tenant-schema 校验
    const headerSchema = req.headers?.['x-tenant-schema'];
    if (headerSchema !== undefined && headerSchema !== null) {
      const normalizedSchema = String(headerSchema).toLowerCase();
      if (normalizedSchema !== expectedSchema) {
        this.logger.warn(
          `[CROSS-TENANT-DENIED] user=${user.sub} (tenant=${expectedTenantId}) tried x-tenant-schema=${headerSchema} on ${req.method} ${req.url}`,
        );
        throw new ForbiddenException(
          `x-tenant-schema mismatch: header '${headerSchema}', expected '${expectedSchema}'`,
        );
      }
    }

    return true;
  }
}
