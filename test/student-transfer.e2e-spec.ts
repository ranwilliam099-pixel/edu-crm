/**
 * V28 Student transfer / Teacher archive e2e — 路由暴露 + 鉴权
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/filters/global-exception.filter';

describe('V28 Student transfer + Teacher archive (e2e)', () => {
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

  describe('Student transfer 2 endpoint 无 token → 401', () => {
    it('POST /db/students/:id/transfer-sales', async () => {
      await request(app.getHttpServer())
        .post('/api/db/students/abc/transfer-sales')
        .send({})
        .expect(401);
    });
    it('POST /db/students/:id/transfer-teacher', async () => {
      await request(app.getHttpServer())
        .post('/api/db/students/abc/transfer-teacher')
        .send({})
        .expect(401);
    });
  });

  describe('V29 R2 Student / Customer create 无 token → 401', () => {
    it('POST /db/students (single create)', async () => {
      await request(app.getHttpServer())
        .post('/api/db/students')
        .send({})
        .expect(401);
    });
    it('POST /db/customers (self-built)', async () => {
      await request(app.getHttpServer())
        .post('/api/db/customers')
        .send({})
        .expect(401);
    });
  });

  describe('Teacher archive 1 endpoint 无 token → 401', () => {
    it('POST /api/teachers/db/:id/archive', async () => {
      await request(app.getHttpServer())
        .post('/api/teachers/db/abc/archive')
        .send({})
        .expect(401);
    });
  });

  describe('V29 R4 OOUX teacher → students[] 一站式', () => {
    it('GET /db/students/by-teacher/:teacherId 无 token → 401', async () => {
      await request(app.getHttpServer())
        .get('/api/db/students/by-teacher/abc')
        .expect(401);
    });
  });
});
