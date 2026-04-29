import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Request } from 'express';
import { Observable } from 'rxjs';

/**
 * 租户 search_path 拦截器（W1 BE-W1-4 骨架）
 *
 * 职责（A01 schema-per-tenant + 接口清单 V1 §6.2）：
 *   - 从 req.tenantSchema 读 tenant.middleware 注入的 schema 名（如 `tenant_<id>`）
 *   - 在每个业务接口请求处理周期内，把当前 request 关联的 ORM connection / queryRunner
 *     的 search_path 设置为 [tenantSchema, public]
 *   - 业务结束后 search_path 自动随 connection 释放回到默认
 *
 * §0 不猜测严守：
 *   - 真实 TypeORM DataSource / QueryRunner 注入由 BE-W1-1 落地后才能接入
 *   - 当前 interceptor 仅做"读 req → 验证 schema 名 → 日志记录"骨架；ORM 层 SET LOCAL search_path 命令在 BE-W1-1 + DataSource 落地后通过 dependency injection 接通
 *
 * 项目隔离（追加 #8）：本类不引用企业管理系统主项目任何 ORM 或 DataSource
 */
@Injectable()
export class TenantSearchPathInterceptor implements NestInterceptor {
  private readonly logger = new Logger(TenantSearchPathInterceptor.name);

  /**
   * 验证 schema 名格式：以 `tenant_` 开头 + 32-char Crockford Base32（小写）
   * 防止 SQL 注入（schema 名拼接进 SET LOCAL search_path）
   */
  static isValidSchemaName(schema: string): boolean {
    return /^tenant_[0-9a-hjkmnp-tv-z]{32}$/.test(schema);
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<RequestWithTenant>();
    const schema = req.tenantSchema;

    if (schema) {
      if (!TenantSearchPathInterceptor.isValidSchemaName(schema)) {
        // 防御：tenant.middleware 应只设合法值，但 interceptor 二次校验防止注入
        this.logger.error(
          `[BE-W1-4] Invalid tenantSchema rejected: "${schema}" (path=${req.path})`,
        );
        throw new Error('Invalid tenant schema name (potential SQL injection)');
      }

      // BE-W1-1 真集成 DataSource 后，此处插入：
      //   await queryRunner.query(`SET LOCAL search_path TO "${schema}", public`);
      // 当前为骨架，仅记录日志
      this.logger.debug(
        `[BE-W1-4 PLACEHOLDER] Would SET LOCAL search_path TO "${schema}", public (path=${req.path})`,
      );
    }
    // 非业务接口（公开 / admin / onboarding）schema 为空，不动 search_path

    return next.handle();
  }
}

interface RequestWithTenant extends Request {
  tenantSchema?: string;
}
