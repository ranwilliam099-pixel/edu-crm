/**
 * Parent + Subscription e2e — V10 BE-V10-1/2
 *
 * USER-AUTH(2026-05-02): 条目 31 #3/#4 + 条目 32 #10
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/filters/global-exception.filter';

describe('Parent (e2e) - V10 BE-V10-1/2 路由暴露 + middleware 守护', () => {
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

  it('POST /api/parents/register 无 token → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/parents/register')
      .send({})
      .expect(401);
  });

  it('POST /api/parents/:id/bindings 无 token → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/parents/01HX7Y6P5K9N3M2QABCDEFGHIJKLMN01/bindings')
      .send({})
      .expect(401);
  });

  it('POST /api/parents/bindings/:id/unbind 无 token → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/parents/bindings/01HX7Y6P5K9N3M2QABCDEFGHIJKLMN01/unbind')
      .send({})
      .expect(401);
  });

  it('POST /api/parents/:id/children 无 token → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/parents/01HX7Y6P5K9N3M2QABCDEFGHIJKLMN01/children')
      .send({ allBindings: [] })
      .expect(401);
  });

  it('POST /api/parent-subscriptions/start-trial 无 token → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/parent-subscriptions/start-trial')
      .send({})
      .expect(401);
  });

  it('POST /api/parent-subscriptions/convert-trial 无 token → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/parent-subscriptions/convert-trial')
      .send({})
      .expect(401);
  });

  it('POST /api/parent-subscriptions/renew 无 token → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/parent-subscriptions/renew')
      .send({})
      .expect(401);
  });

  it('POST /api/parent-subscriptions/cancel 无 token → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/parent-subscriptions/cancel')
      .send({})
      .expect(401);
  });

  it('POST /api/parent-subscriptions/access-check 无 token → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/parent-subscriptions/access-check')
      .send({})
      .expect(401);
  });
});
