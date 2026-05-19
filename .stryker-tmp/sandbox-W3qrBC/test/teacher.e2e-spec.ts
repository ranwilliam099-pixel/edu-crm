/**
 * Teacher e2e — V7 BE-V7-1
 *
 * USER-AUTH(2026-05-02): 条目 29 方向 B + 条目 31 #2 + 条目 32 L1
 *
 * 验证：
 *   - /api/teachers/* 路由已暴露
 *   - TenantMiddleware 守护：无 token → 401（符合现有 reverse-order e2e 模式）
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/filters/global-exception.filter';

describe('Teacher (e2e) - V7 BE-V7-1 路由暴露 + middleware 守护', () => {
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

  it('POST /api/teachers 无 token → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/teachers')
      .send({ id: 'x', campusId: 'y', name: 'Test', operator: 'op' })
      .expect(401);
  });

  it('POST /api/teachers/anyId/status 无 token → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/teachers/01HX7Y6P5K9N3M2QABCDEFGHIJKLMN01/status')
      .send({})
      .expect(401);
  });

  it('POST /api/teachers/filter-schedulable 无 token → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/teachers/filter-schedulable')
      .send({ teachers: [] })
      .expect(401);
  });

  it('POST /api/teachers/anyId/profile-type 无 token → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/teachers/01HX7Y6P5K9N3M2QABCDEFGHIJKLMN01/profile-type')
      .send({})
      .expect(401);
  });
});
