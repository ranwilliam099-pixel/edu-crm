// PROD-ARCH(2026-05-10) P0-6: Sentry 必须在所有其他 import 之前 init
import './common/sentry/instrument';

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './filters/global-exception.filter';

async function bootstrap(): Promise<void> {
  // PROD-ARCH(2026-05-10) P0-3: bufferLogs 缓冲启动日志，等 useLogger 后再 flush
  // W2-T1(2026-05-14): rawBody:true 用于微信支付 V3 回调签名校验
  //   - V3 签名串 = timestamp\nnonce\nrawBody\n，rawBody 必须原始字节，不能 re-serialize
  //   - 兼容性：express body-parser 在 rawBody:true 下仍正常 parse req.body
  //   - 仅影响 wxpay.controller.ts callbacks/wxpay endpoint；其他 endpoint 行为不变
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });

  // 用 nestjs-pino 替换默认 NestJS Logger
  // 所有现有 Logger.log/warn/error 自动转 pino（结构化 JSON + 链路追踪 + PII 脱敏）
  app.useLogger(app.get(Logger));

  const config = app.get(ConfigService);
  const port = config.get<number>('PORT', 3001);
  const logger = app.get(Logger);

  app.setGlobalPrefix('api');

  // SPRINT-E.1(2026-05-13) helmet 安全 header：CSP / HSTS / X-Frame-Options 等
  //   - frameAncestors 'none'：禁止页面被 iframe 嵌套（点击劫持 CSP3 防御）
  //   - HSTS 1 年 + includeSubDomains（ICP 备案后再开 preload）
  //   - imgSrc 允许 https + data URI（微信头像 / base64 占位）
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          imgSrc: ["'self'", 'https:', 'data:'],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          frameAncestors: ["'none'"],
        },
      },
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: false, // ICP 备案过后再加 preload
      },
    }),
  );

  // SPRINT-E.1(2026-05-13) CORS 严格 origin 白名单
  //   - CORS_ALLOWED_ORIGINS 逗号分隔（如 https://minxin.top,https://app.minxin.top）
  //   - 无 origin（微信小程序 / 内部 cron / curl）放行：不属于浏览器 CORS preflight 范畴
  //   - 不在白名单的 origin 抛 CORS_NOT_ALLOWED（CORS preflight 失败 → 浏览器拒绝）
  //   - allowedHeaders 含 X-Tenant-Schema / Idempotency-Key / X-Request-Id 等业务必需头
  const corsOrigins = (config.get<string>('CORS_ALLOWED_ORIGINS', '') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  app.enableCors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // 微信小程序 / curl / 内部 cron 无 origin
      if (corsOrigins.includes(origin)) return cb(null, true);
      cb(new Error('CORS_NOT_ALLOWED'), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'PUT', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Tenant-Schema',
      'Idempotency-Key',
      'X-Request-Id',
    ],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // PM-AUTH(2026-04-30) Phase 5.3: 全局异常 filter（错误页 / 异常文案统一响应）
  app.useGlobalFilters(new GlobalExceptionFilter());

  // PROD-ARCH(2026-05-10) P0-3: 优雅退出（PM2 reload 无停机）
  app.enableShutdownHooks();

  await app.listen(port);
  logger.log(`edu-server listening on http://localhost:${port}/api`, 'Bootstrap');
}

void bootstrap();
