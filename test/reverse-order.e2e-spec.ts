/**
 * ReverseOrder e2e — W3-1 Phase 4 BE-W5-1/2
 *
 * PM-AUTH-7(2026-04-30): A12 4 类逆向单 + paid 锁
 *
 * 覆盖：
 *   - GET /types / /states 列表
 *   - POST /transitions/check 状态校验
 *   - POST /revenue/calculate (无 token → 401)
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/filters/global-exception.filter';

describe('ReverseOrder (e2e) - PM-AUTH-7 A12', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  // /api/reverse-orders/* 不在 TenantMiddleware 公开列表 — 无 token 一律 401（默认安全）
  it('GET /api/reverse-orders/types 无 token → 401（中间件守护）', async () => {
    await request(app.getHttpServer()).get('/api/reverse-orders/types').expect(401);
  });

  it('GET /api/reverse-orders/states 无 token → 401', async () => {
    await request(app.getHttpServer()).get('/api/reverse-orders/states').expect(401);
  });

  it('POST /api/reverse-orders/transitions/check 无 token → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/reverse-orders/transitions/check')
      .send({ from: '申请中', to: '审批通过' })
      .expect(401);
  });

  it('POST /api/reverse-orders/revenue/calculate 无 token → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/reverse-orders/revenue/calculate')
      .send({})
      .expect(401);
  });
});
