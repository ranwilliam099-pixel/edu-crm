/**
 * V27 User offboard / handover e2e — 路由暴露 + 鉴权
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/filters/global-exception.filter';

describe('V27 User offboard + handover (e2e)', () => {
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

  describe('User 6 endpoint 无 token → 401', () => {
    it('GET /db/users/inactive-with-pending', async () => {
      await request(app.getHttpServer())
        .get('/api/db/users/inactive-with-pending')
        .expect(401);
    });
    it('GET /db/users/list', async () => {
      await request(app.getHttpServer()).get('/api/db/users/list').expect(401);
    });
    it('GET /db/users/active-with-data', async () => {
      await request(app.getHttpServer()).get('/api/db/users/active-with-data').expect(401);
    });
    it('GET /db/users/:id', async () => {
      await request(app.getHttpServer())
        .get('/api/db/users/abc123')
        .expect(401);
    });
    it('POST /db/users/:userId/deactivate', async () => {
      await request(app.getHttpServer())
        .post('/api/db/users/abc/deactivate')
        .send({})
        .expect(401);
    });
    it('POST /db/users/:fromUserId/handover', async () => {
      await request(app.getHttpServer())
        .post('/api/db/users/abc/handover')
        .send({})
        .expect(401);
    });
  });
});
