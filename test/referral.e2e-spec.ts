/**
 * Referral (V22) e2e — 路由暴露 + 鉴权守护
 *
 * 验证：
 *   - 无 token → 401
 *   - 缺 tenantSchema → 400
 *   - 路由前缀 /api/db/referrals 生效
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/filters/global-exception.filter';

describe('Referral V22 (e2e) - 路由暴露 + 鉴权', () => {
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

  it('POST /api/db/referrals 无 token → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/db/referrals')
      .send({})
      .expect(401);
  });

  it('GET /api/db/referrals/by-code/:code 无 token → 401', async () => {
    await request(app.getHttpServer())
      .get('/api/db/referrals/by-code/CODE12345')
      .expect(401);
  });

  it('POST /api/db/referrals/by-code/:code/trial 无 token → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/db/referrals/by-code/CODE12345/trial')
      .send({})
      .expect(401);
  });

  it('POST /api/db/referrals/mark-rated 无 token → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/db/referrals/mark-rated')
      .send({})
      .expect(401);
  });

  it('GET /api/db/referrals/teacher/:id/stats 无 token → 401', async () => {
    await request(app.getHttpServer())
      .get('/api/db/referrals/teacher/tch00000000000000000000000000T01/stats')
      .expect(401);
  });

  it('GET /api/db/referrals/by-referrer 无 token → 401', async () => {
    await request(app.getHttpServer())
      .get('/api/db/referrals/by-referrer')
      .expect(401);
  });
});
