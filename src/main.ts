import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './filters/global-exception.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  const config = app.get(ConfigService);
  const port = config.get<number>('PORT', 3001);

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

  await app.listen(port);
  Logger.log(`edu-server listening on http://localhost:${port}/api`, 'Bootstrap');
}

void bootstrap();
