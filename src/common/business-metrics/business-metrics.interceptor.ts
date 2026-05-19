import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap, catchError, throwError } from 'rxjs';
import { Request, Response } from 'express';
import { BusinessMetricsService } from './business-metrics.service';

/**
 * BusinessMetricsInterceptor (L7 v2.0 §3.L7) — 业务关键路径成功率监控
 *
 * 用法（仅 3 个关键路径 controller 添加，避免全局性能开销）：
 *
 *   @UseInterceptors(BusinessMetricsInterceptor)
 *   @Post('customers')
 *   createCustomer(...) { ... }
 *
 * 拦截路径（v2.0 §3.L7 拍板）：
 *   - POST /db/customers              (sales 关键 funnel)
 *   - POST /checkout/wxpay/unified-order (财务关键路径)
 *   - POST /public/auth/login          (登录入口)
 *
 * 行为：
 *   - 调用 BusinessMetricsService.record(method, path, statusCode)
 *   - 不阻塞业务（service.record 自身 fail-open）
 *   - 异常路径 statusCode = exception.status || 500
 *   - 不解析 response body（隐私 + 性能）
 *
 * 失败模式：
 *   - service.record 内部捕获所有异常 → 不会反向毁 endpoint
 *   - 监控失败 → logger.warn 不抛
 */
@Injectable()
export class BusinessMetricsInterceptor implements NestInterceptor {
  private readonly logger = new Logger(BusinessMetricsInterceptor.name);

  constructor(private readonly metrics: BusinessMetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const method = req?.method ?? 'UNKNOWN';
    // 用 route 而非 url，避免 path param 噪音（/customers/123 → /customers/:id）
    const route = (req?.route?.path as string | undefined) ?? req?.url ?? 'UNKNOWN';
    const startedAt = Date.now();

    return next.handle().pipe(
      tap(() => {
        const res = http.getResponse<Response>();
        const statusCode = res?.statusCode ?? 200;
        this.safeRecord(method, route, statusCode, Date.now() - startedAt);
      }),
      catchError((err) => {
        // exception → 从 err.status / err.getStatus() 推断 statusCode
        const statusCode = this.extractStatus(err);
        this.safeRecord(method, route, statusCode, Date.now() - startedAt);
        return throwError(() => err);
      }),
    );
  }

  private safeRecord(method: string, path: string, statusCode: number, durationMs: number): void {
    try {
      this.metrics.record(method, path, statusCode, durationMs);
    } catch (e) {
      // fail-open：监控异常不影响业务
      this.logger.warn(`metrics.record failed (fail-open): ${(e as Error).message}`);
    }
  }

  private extractStatus(err: unknown): number {
    if (err && typeof err === 'object') {
      const e = err as { status?: number; getStatus?: () => number };
      if (typeof e.getStatus === 'function') {
        try {
          return e.getStatus();
        } catch {
          /* ignore */
        }
      }
      if (typeof e.status === 'number') return e.status;
    }
    return 500;
  }
}
