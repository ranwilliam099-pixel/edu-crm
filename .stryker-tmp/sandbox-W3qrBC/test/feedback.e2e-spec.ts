/**
 * Feedback (LessonFeedback + CourseConsumption + MonthlyReport) e2e — V9 BE-V9-1/2/3
 *
 * USER-AUTH(2026-05-02): PD §4 + P6/P7
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/filters/global-exception.filter';

describe('Feedback (e2e) - V9 BE-V9-1/2/3 路由暴露 + middleware 守护', () => {
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

  describe('LessonFeedback (V9.1)', () => {
    it('POST /api/lesson-feedbacks 无 token → 401', async () => {
      await request(app.getHttpServer())
        .post('/api/lesson-feedbacks')
        .send({})
        .expect(401);
    });

    it('PATCH /api/lesson-feedbacks/:id 无 token → 401', async () => {
      await request(app.getHttpServer())
        .patch('/api/lesson-feedbacks/01HX7Y6P5K9N3M2QABCDEFGHIJKLMN01')
        .send({})
        .expect(401);
    });

    it('POST /api/lesson-feedbacks/:id/parent-read 无 token → 401', async () => {
      await request(app.getHttpServer())
        .post('/api/lesson-feedbacks/01HX7Y6P5K9N3M2QABCDEFGHIJKLMN01/parent-read')
        .send({})
        .expect(401);
    });
  });

  describe('CourseConsumption (V9.2)', () => {
    it('POST /api/course-consumptions 无 token → 401', async () => {
      await request(app.getHttpServer())
        .post('/api/course-consumptions')
        .send({})
        .expect(401);
    });

    it('POST /api/course-consumptions/:id/confirm 无 token → 401', async () => {
      await request(app.getHttpServer())
        .post('/api/course-consumptions/01HX7Y6P5K9N3M2QABCDEFGHIJKLMN01/confirm')
        .send({})
        .expect(401);
    });

    it('POST /api/course-consumptions/scan-and-lock 无 token → 401', async () => {
      await request(app.getHttpServer())
        .post('/api/course-consumptions/scan-and-lock')
        .send({})
        .expect(401);
    });

    it('POST /api/course-consumptions/:id/unlock-late 无 token → 401', async () => {
      await request(app.getHttpServer())
        .post('/api/course-consumptions/01HX7Y6P5K9N3M2QABCDEFGHIJKLMN01/unlock-late')
        .send({})
        .expect(401);
    });

    // V38: 删 POST /api/teachers/:id/payroll 401 e2e（endpoint 已删）
  });

  describe('MonthlyReport (V9.3)', () => {
    it('POST /api/monthly-reports/generate 无 token → 401', async () => {
      await request(app.getHttpServer())
        .post('/api/monthly-reports/generate')
        .send({})
        .expect(401);
    });

    it('POST /api/monthly-reports/:id/finalize 无 token → 401', async () => {
      await request(app.getHttpServer())
        .post('/api/monthly-reports/01HX7Y6P5K9N3M2QABCDEFGHIJKLMN01/finalize')
        .send({})
        .expect(401);
    });

    it('POST /api/monthly-reports/:id/parent-read 无 token → 401', async () => {
      await request(app.getHttpServer())
        .post('/api/monthly-reports/01HX7Y6P5K9N3M2QABCDEFGHIJKLMN01/parent-read')
        .send({})
        .expect(401);
    });
  });
});
