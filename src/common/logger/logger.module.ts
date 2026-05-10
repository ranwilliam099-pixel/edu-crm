import { Global, Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { makePinoOptions } from './logger.config';

/**
 * LoggerModule — 全局 pino 日志（生产架构 P0 第 3 项）
 *
 * 全局自动注入：
 *   constructor(private readonly logger: PinoLogger) {}
 *
 * 替换 NestJS 默认 Logger：
 *   main.ts:
 *     const app = await NestFactory.create(AppModule, { bufferLogs: true });
 *     app.useLogger(app.get(Logger));  // Logger 来自 'nestjs-pino'
 *
 * 设计：
 *   - 用 forRootAsync 延迟构造 → 进程启动后才读 NODE_ENV
 *   - useFactory 返回 pinoHttp 配置（详见 logger.config.ts）
 */
@Global()
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      useFactory: () => makePinoOptions(),
    }),
  ],
  exports: [PinoLoggerModule],
})
export class LoggerModule {}
