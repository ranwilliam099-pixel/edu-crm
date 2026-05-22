// PROD-ARCH(2026-05-10) P0-6: Sentry 必须在所有其他 import 之前 init
import './common/sentry/instrument';

import * as fs from 'fs';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
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

  // 2026-05-22 P0 修生产 bug: NestJS (express adapter) 默认开启 ETag → GET 重复请求
  //   返 304 + 空 body → wx.request 在 statusCode=304 + body 空 + dataType='json'
  //   场景 既不 fire success 也不 fire fail → 前端 Promise 永不 settle → home loading
  //   卡 skeleton (实测 admin 进 /db/kpi/signed 后端日志连续 304)
  //
  // 关 ETag 让所有 GET 返 200 + body (RESTful API 通常不需要 HTTP cache —
  //   业务有 Redis 5min 缓存 + 客户端短时间内同 URL 不会重复调)
  // 影响: 所有 GET endpoint, KPI 返 body 几 KB 带宽影响可忽略
  (app.getHttpAdapter().getInstance() as any).disable('etag');

  // Phase B.L3 (2026-05-19) OpenAPI auto-gen — contract test SSOT
  //   - Swagger UI: GET /api/docs（开发期可视化）
  //   - CI 模式（NODE_ENV=ci）：emit baseline/openapi.json 并立即退出
  //   - 前端 sync-deploy 时 copy baseline/openapi.json → miniprogram/utils/openapi-schema.json
  //   - 5 个核心 DTO 已注册（customer/contract/schedule/lesson-feedback/invoice）
  //     剩 33 module 渐进补 Day 3-4
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Edu Server API')
    .setDescription('教培 CRM 后端 API — Phase B.L3 contract source-of-truth')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, swaggerDocument);

  if (process.env.NODE_ENV === 'ci') {
    // CI: emit openapi.json 到 repo 根 baseline/ 并退出（不监听端口）
    //   - __dirname 在 nest start 模式 = dist/src/，所以 ../../baseline 指向 repo 根 baseline/
    //   - 允许 OPENAPI_OUT_DIR 覆盖（如 sync-deploy 时 emit 到任意位置）
    const baselineDir =
      process.env.OPENAPI_OUT_DIR ||
      path.resolve(__dirname, '../../baseline');
    if (!fs.existsSync(baselineDir)) {
      fs.mkdirSync(baselineDir, { recursive: true });
    }
    const outPath = path.join(baselineDir, 'openapi.json');
    fs.writeFileSync(outPath, JSON.stringify(swaggerDocument, null, 2));
    // eslint-disable-next-line no-console
    console.log(`[openapi:gen] wrote ${outPath}`);
    process.exit(0);
  }

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
  // L7(2026-05-19): 通过 app.get 拿 AlertService → 5xx 自动上报 Sentry + 钉钉/企微告警
  app.useGlobalFilters(app.get(GlobalExceptionFilter));

  // PROD-ARCH(2026-05-10) P0-3: 优雅退出（PM2 reload 无停机）
  app.enableShutdownHooks();

  await app.listen(port);
  logger.log(`edu-server listening on http://localhost:${port}/api`, 'Bootstrap');
}

void bootstrap();
