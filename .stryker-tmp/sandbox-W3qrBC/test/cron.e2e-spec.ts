/**
 * V20-V23 Cron HTTP endpoints e2e — 路由暴露 + 鉴权
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/filters/global-exception.filter';

describe('Cron (e2e) - V20-V23 cron HTTP 入口', () => {
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

  it('POST /api/admin/cron/expire-promotions 无 token → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/admin/cron/expire-promotions')
      .expect(401);
  });

  it('POST /api/admin/cron/expire-pending-referrals 无 token → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/admin/cron/expire-pending-referrals')
      .send({ tenantSchemas: [] })
      .expect(401);
  });

  it('POST /api/admin/cron/expire-free-slots 无 token → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/admin/cron/expire-free-slots')
      .expect(401);
  });
});
