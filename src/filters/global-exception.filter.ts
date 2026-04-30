import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * GlobalExceptionFilter — W3-1 Phase 5.3 错误页 / 异常文案
 *
 * 来源：
 *   - 《全部人员-审核往来总台账.md》条目 14 §B Track CODE-5
 *
 * PM-AUTH(2026-04-30): 全局异常统一响应
 *
 * 行为：
 *   - HttpException → 沿用 Nest 状态码 + 错误信息
 *   - 其他异常 → 500 + 通用文案，原始 message 仅记日志（避免泄露内部细节）
 *   - 响应体格式：{ statusCode, message, error, timestamp, path, requestId? }
 *   - 4xx 记 warn，5xx 记 error
 *
 * 严守边界：
 *   - 不嵌入业务路径之外的特殊处理
 *   - 不引入企业管理系统主项目任何 filter 实现
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
    const msg = exception instanceof Error ? exception.message : String(exception);
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error', // 通用文案，不暴露内部 stack
      error: exception instanceof Error ? exception.constructor.name : 'UnknownError',
    };
  }
}
