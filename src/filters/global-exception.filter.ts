import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
  Optional,
} from '@nestjs/common';
import { Request, Response } from 'express';
import * as Sentry from '@sentry/nestjs';
import { AlertService } from '../common/alert/alert.service';

/**
 * GlobalExceptionFilter — W3-1 Phase 5.3 错误页 / 异常文案
 *
 * 来源：
 *   - 《全部人员-审核往来总台账.md》条目 14 §B Track CODE-5
 *
 * PM-AUTH(2026-04-30): 全局异常统一响应
 * L7(2026-05-19 Day 4) v2.0 §3.L7: 5xx 上报 Sentry + 触发 AlertService（fail-open）
 *
 * 行为：
 *   - HttpException → 沿用 Nest 状态码 + 错误信息
 *   - 其他异常 → 500 + 通用文案，原始 message 仅记日志（避免泄露内部细节）
 *   - 响应体格式：{ statusCode, message, error, timestamp, path, requestId? }
 *   - 4xx 记 warn；5xx 记 error + Sentry.captureException + alert.critical
 *
 * 严守边界：
 *   - 不嵌入业务路径之外的特殊处理
 *   - 不引入企业管理系统主项目任何 filter 实现
 *
 * Sentry / Alert fail-open（v2.0 §0.2 「禁人工 override」反向：可用性优先）：
 *   - Sentry SDK 在 DSN 缺失时本身就是 noop（@sentry/nestjs 文档保证）
 *   - AlertService 是 Optional 注入，构造时缺失 → 跳过告警，不影响主流程
 *   - 任何 Sentry / Alert 异常都 try-catch 吞掉（filter 不能反向制造异常）
 */

interface ErrorResponseBody {
  statusCode: number;
  message: string;
  error: string;
  timestamp: string;
  path: string;
  requestId?: string;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  constructor(@Optional() private readonly alertService?: AlertService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { statusCode, message, error } = this.extract(exception);

    const body: ErrorResponseBody = {
      statusCode,
      message,
      error,
      timestamp: new Date().toISOString(),
      path: request?.url ?? 'unknown',
      requestId: (request?.headers?.['x-request-id'] as string) || undefined,
    };

    if (statusCode >= 500) {
      this.logger.error(
        `[Phase 5.3] 5xx ${request?.method} ${body.path} → ${error}: ${message}`,
        exception instanceof Error ? exception.stack : undefined,
      );

      // L7: 5xx 上报 Sentry（fail-open，DSN 缺失自动 noop）
      this.reportToSentry(exception, request, body.requestId);

      // L7: 5xx 触发告警（fail-open + dedup 防 spam）
      this.fireAlert(error, message, request, body.requestId);
    } else {
      this.logger.warn(
        `[Phase 5.3] ${statusCode} ${request?.method} ${body.path} → ${error}: ${message}`,
      );
    }

    response?.status(statusCode).json(body);
  }

  private extract(exception: unknown): { statusCode: number; message: string; error: string } {
    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const resp = exception.getResponse();
      let message: string;
      let error = exception.name;
      if (typeof resp === 'string') {
        message = resp;
      } else if (resp && typeof resp === 'object') {
        const obj = resp as { message?: unknown; error?: unknown };
        message = Array.isArray(obj.message)
          ? obj.message.join(', ')
          : typeof obj.message === 'string'
            ? obj.message
            : exception.message;
        if (typeof obj.error === 'string') {
          error = obj.error;
        }
      } else {
        message = exception.message;
      }
      return { statusCode, message, error };
    }

    // 非 HttpException：500 + 隐藏内部细节
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error', // 通用文案，不暴露内部 stack
      error: exception instanceof Error ? exception.constructor.name : 'UnknownError',
    };
  }

  /**
   * Sentry 上报（fail-open）
   *
   * Sentry SDK 设计契约：DSN 缺失时 Sentry.init 跳过，
   * 后续 captureException 自动变 noop（不抛错）。
   * 但我们再加一层 try-catch 兜底，防 SDK 边界 case。
   */
  private reportToSentry(
    exception: unknown,
    request: Request | undefined,
    requestId: string | undefined,
  ): void {
    try {
      // 仅 Error 实例上报（plain string thrown 等异常不上报，噪音）
      if (!(exception instanceof Error)) {
        return;
      }
      Sentry.withScope((scope) => {
        if (requestId) scope.setTag('request_id', requestId);
        if (request?.method) scope.setTag('http.method', request.method);
        if (request?.url) scope.setTag('http.path', request.url);
        scope.setLevel('error');
        Sentry.captureException(exception);
      });
    } catch (err) {
      // 不能让监控反向毁掉主流程
      this.logger.warn(`Sentry capture failed (fail-open): ${(err as Error).message}`);
    }
  }

  /**
   * AlertService 告警（fail-open）
   *
   * - alertService Optional 注入：dev / 无 webhook 时跳过
   * - dedupKey = error 类型 + path：同类错误 30s 内只发 1 次
   * - 异步发不 await（不阻塞响应）
   */
  private fireAlert(
    error: string,
    message: string,
    request: Request | undefined,
    requestId: string | undefined,
  ): void {
    if (!this.alertService) return;
    try {
      const path = request?.url ?? 'unknown';
      const method = request?.method ?? 'unknown';
      const dedupKey = `5xx:${error}:${path}`;
      // 不 await：告警发送不阻塞 HTTP 响应
      void this.alertService
        .critical(`5xx ${error}`, `${method} ${path}\n${message}`, {
          dedupKey,
          dedupTtl: 30,
          context: {
            error,
            method,
            path,
            requestId: requestId ?? '(none)',
          },
        })
        .catch((err: Error) => {
          this.logger.warn(`alert send failed (fail-open): ${err.message}`);
        });
    } catch (err) {
      this.logger.warn(`alert dispatch failed (fail-open): ${(err as Error).message}`);
    }
  }
}
