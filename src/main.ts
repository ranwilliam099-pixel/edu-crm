// PROD-ARCH(2026-05-10) P0-6: Sentry 必须在所有其他 import 之前 init
import './common/sentry/instrument';

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './filters/global-exception.filter';

async function bootstrap(): Promise<void> {
  // PROD-ARCH(2026-05-10) P0-3: bufferLogs 缓冲启动日志，等 useLogger 后再 flush
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // 用 nestjs-pino 替换默认 NestJS Logger
  // 所有现有 Logger.log/warn/error 自动转 pino（结构化 JSON + 链路追踪 + PII 脱敏）
  app.useLogger(app.get(Logger));

  const config = app.get(ConfigService);
  const port = config.get<number>('PORT', 3001);
  const logger = app.get(Logger);

  app.setGlobalPrefix('api');
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
