/**
 * V23 CampusFreeSlot e2e — 路由暴露 + 鉴权
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/filters/global-exception.filter';

describe('V23 CampusFreeSlot (e2e)', () => {
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

  it('GET /api/db/campus-free-slots/campus/:id 无 token → 401', async () => {
    await request(app.getHttpServer())
      .get('/api/db/campus-free-slots/campus/cmp00000000000000000000000000C01')
      .expect(401);
  });

  it('GET /api/db/campus-free-slots/campus/:id/stats 无 token → 401', async () => {
    await request(app.getHttpServer())
      .get('/api/db/campus-free-slots/campus/cmp00000000000000000000000000C01/stats')
      .expect(401);
  });

  it('POST /api/db/campus-free-slots/claim 无 token → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/db/campus-free-slots/claim')
      .send({})
      .expect(401);
  });

  it('POST /api/db/campus-free-slots/release 无 token → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/db/campus-free-slots/release')
      .send({})
      .expect(401);
  });

  it('GET /api/db/campus-free-slots/by-parent/:id 无 token → 401', async () => {
    await request(app.getHttpServer())
      .get('/api/db/campus-free-slots/by-parent/par00000000000000000000000000P01')
      .expect(401);
  });
});
