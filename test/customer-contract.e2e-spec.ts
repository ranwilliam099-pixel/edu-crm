/**
 * V25 Customer + Contract e2e — 路由暴露 + 鉴权
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/filters/global-exception.filter';

describe('V25 Customer + Contract (e2e)', () => {
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

  describe('Customer 8 endpoint 无 token → 401', () => {
    it('GET /db/customers/mine', async () => {
      await request(app.getHttpServer()).get('/api/db/customers/mine').expect(401);
    });
    it('GET /db/customers/pool', async () => {
      await request(app.getHttpServer()).get('/api/db/customers/pool').expect(401);
    });
    it('GET /db/customers/:id', async () => {
      await request(app.getHttpServer()).get('/api/db/customers/abc123').expect(401);
    });
    it('GET /db/customers/:id/follows', async () => {
      await request(app.getHttpServer()).get('/api/db/customers/abc/follows').expect(401);
    });
    it('POST /db/customers/:id/claim', async () => {
      await request(app.getHttpServer()).post('/api/db/customers/abc/claim').send({}).expect(401);
    });
    it('POST /db/customers/:id/release', async () => {
      await request(app.getHttpServer()).post('/api/db/customers/abc/release').send({}).expect(401);
    });
    it('POST /db/customers/:id/mark-lost', async () => {
      await request(app.getHttpServer()).post('/api/db/customers/abc/mark-lost').send({}).expect(401);
    });
    it('POST /db/customers/:id/follow', async () => {
      await request(app.getHttpServer()).post('/api/db/customers/abc/follow').send({}).expect(401);
    });
  });

  describe('Contract 5 endpoint 无 token → 401', () => {
    it('GET /db/contracts/mine', async () => {
      await request(app.getHttpServer()).get('/api/db/contracts/mine').expect(401);
    });
    it('GET /db/contracts/performance', async () => {
      await request(app.getHttpServer()).get('/api/db/contracts/performance').expect(401);
    });
    it('GET /db/contracts/:id', async () => {
      await request(app.getHttpServer()).get('/api/db/contracts/abc').expect(401);
    });
    it('POST /db/contracts', async () => {
      await request(app.getHttpServer()).post('/api/db/contracts').send({}).expect(401);
    });
    it('POST /db/contracts/:id/activate', async () => {
      await request(app.getHttpServer()).post('/api/db/contracts/abc/activate').send({}).expect(401);
    });
  });
});
