/**
 * CourseBalance e2e — V12 BE-V12-1（教学链路 §1）
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/filters/global-exception.filter';

describe('CourseBalance (e2e) - V12 路由暴露 + middleware 守护', () => {
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

  it('POST /api/course-balance/activate 无 token → 401', async () => {
    await request(app.getHttpServer()).post('/api/course-balance/activate').send({}).expect(401);
  });

  it('POST /api/course-balance/:id/deduct 无 token → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/course-balance/01HX7Y6P5K9N3M2QABCDEFGHIJKLMN01/deduct')
      .send({})
      .expect(401);
  });

  it('POST /api/course-balance/:id/refund 无 token → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/course-balance/01HX7Y6P5K9N3M2QABCDEFGHIJKLMN01/refund')
      .send({})
      .expect(401);
  });

  it('POST /api/course-balance/check-schedulable 无 token → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/course-balance/check-schedulable')
      .send({})
      .expect(401);
  });

  it('POST /api/course-balance/scan-expired 无 token → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/course-balance/scan-expired')
      .send({})
      .expect(401);
  });

  it('POST /api/course-balance/scan-low-balance 无 token → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/course-balance/scan-low-balance')
      .send({})
      .expect(401);
  });

  it('POST /api/course-balance/:id/freeze 无 token → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/course-balance/01HX7Y6P5K9N3M2QABCDEFGHIJKLMN01/freeze')
      .send({})
      .expect(401);
  });

  it('POST /api/course-balance/:id/unfreeze 无 token → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/course-balance/01HX7Y6P5K9N3M2QABCDEFGHIJKLMN01/unfreeze')
      .send({})
      .expect(401);
  });
});
