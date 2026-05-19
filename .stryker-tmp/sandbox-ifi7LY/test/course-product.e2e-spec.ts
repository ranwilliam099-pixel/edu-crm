/**
 * V29 R6 课程产品管理 e2e — 路由暴露 + 鉴权
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/filters/global-exception.filter';

describe('V29 R6 CourseProduct (e2e)', () => {
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

  describe('5 endpoint 无 token → 401', () => {
    it('GET /db/course-products', async () => {
      await request(app.getHttpServer()).get('/api/db/course-products').expect(401);
    });
    it('GET /db/course-products/all', async () => {
      await request(app.getHttpServer()).get('/api/db/course-products/all').expect(401);
    });
    it('GET /db/course-products/:id', async () => {
      await request(app.getHttpServer()).get('/api/db/course-products/abc').expect(401);
    });
    it('POST /db/course-products', async () => {
      await request(app.getHttpServer())
        .post('/api/db/course-products')
        .send({})
        .expect(401);
    });
    it('POST /db/course-products/:id/status', async () => {
      await request(app.getHttpServer())
        .post('/api/db/course-products/abc/status')
        .send({})
        .expect(401);
    });
  });
});
