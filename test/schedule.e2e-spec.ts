/**
 * Schedule + RecurringSchedule e2e — V8 / V8.1 BE-V8-1/2
 *
 * USER-AUTH(2026-05-02): PD §3 + §3.6 + 条目 31 #2 + 条目 32 L2
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/filters/global-exception.filter';

describe('Schedule (e2e) - V8/V8.1 路由暴露 + middleware 守护', () => {
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

  describe('Schedule (V8)', () => {
    it('POST /api/schedules 无 token → 401', async () => {
      await request(app.getHttpServer())
        .post('/api/schedules')
        .send({})
        .expect(401);
    });

    it('POST /api/schedules/:id/cancel 无 token → 401', async () => {
      await request(app.getHttpServer())
        .post('/api/schedules/01HX7Y6P5K9N3M2QABCDEFGHIJKLMN01/cancel')
        .send({})
        .expect(401);
    });

    it('POST /api/schedules/:id/complete 无 token → 401', async () => {
      await request(app.getHttpServer())
        .post('/api/schedules/01HX7Y6P5K9N3M2QABCDEFGHIJKLMN01/complete')
        .send({})
        .expect(401);
    });

    it('POST /api/schedules/:scheduleId/students/:studentId/attendance 无 token → 401', async () => {
      await request(app.getHttpServer())
        .post(
          '/api/schedules/01HX7Y6P5K9N3M2QABCDEFGHIJKLMN01/students/01HX7Y6P5K9N3M2QABCDEFGHIJKLMN02/attendance',
        )
        .send({})
        .expect(401);
    });
  });

  describe('RecurringSchedule (V8.1)', () => {
    it('POST /api/recurring/bindings 无 token → 401', async () => {
      await request(app.getHttpServer())
        .post('/api/recurring/bindings')
        .send({})
        .expect(401);
    });

    it('POST /api/recurring/bindings/:id/unbind 无 token → 401', async () => {
      await request(app.getHttpServer())
        .post('/api/recurring/bindings/01HX7Y6P5K9N3M2QABCDEFGHIJKLMN01/unbind')
        .send({})
        .expect(401);
    });

    it('POST /api/recurring/schedules 无 token → 401', async () => {
      await request(app.getHttpServer())
        .post('/api/recurring/schedules')
        .send({})
        .expect(401);
    });

    it('POST /api/recurring/schedules/:id/archive 无 token → 401', async () => {
      await request(app.getHttpServer())
        .post('/api/recurring/schedules/01HX7Y6P5K9N3M2QABCDEFGHIJKLMN01/archive')
        .send({})
        .expect(401);
    });

    it('POST /api/recurring/schedules/expand-preview 无 token → 401', async () => {
      await request(app.getHttpServer())
        .post('/api/recurring/schedules/expand-preview')
        .send({})
        .expect(401);
    });
  });
});
