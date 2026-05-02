/**
 * V13/V14/V15 Controllers e2e — 教学链路 §2/§3/§4
 *
 * 验证：路由暴露 + middleware 守护
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/filters/global-exception.filter';

describe('Homework + Assessment + LearningProfile (e2e) - V13/V14/V15', () => {
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

  describe('Homework (V13)', () => {
    it('POST /api/homework/assignments 无 token → 401', async () => {
      await request(app.getHttpServer()).post('/api/homework/assignments').send({}).expect(401);
    });

    it('POST /api/homework/submissions 无 token → 401', async () => {
      await request(app.getHttpServer()).post('/api/homework/submissions').send({}).expect(401);
    });

    it('POST /api/homework/submissions/:id/grade 无 token → 401', async () => {
      await request(app.getHttpServer())
        .post('/api/homework/submissions/01HX7Y6P5K9N3M2QABCDEFGHIJKLMN01/grade')
        .send({})
        .expect(401);
    });

    it('POST /api/homework/submissions/:id/return 无 token → 401', async () => {
      await request(app.getHttpServer())
        .post('/api/homework/submissions/01HX7Y6P5K9N3M2QABCDEFGHIJKLMN01/return')
        .send({})
        .expect(401);
    });

    it('POST /api/homework/teachers/:id/pending-grading 无 token → 401', async () => {
      await request(app.getHttpServer())
        .post('/api/homework/teachers/01HX7Y6P5K9N3M2QABCDEFGHIJKLMN01/pending-grading')
        .send({})
        .expect(401);
    });

    it('POST /api/homework/students/:id/list 无 token → 401', async () => {
      await request(app.getHttpServer())
        .post('/api/homework/students/01HX7Y6P5K9N3M2QABCDEFGHIJKLMN01/list')
        .send({})
        .expect(401);
    });
  });

  describe('Assessment (V14)', () => {
    it('POST /api/assessments 无 token → 401', async () => {
      await request(app.getHttpServer()).post('/api/assessments').send({}).expect(401);
    });

    it('POST /api/assessments/:id/results 无 token → 401', async () => {
      await request(app.getHttpServer())
        .post('/api/assessments/01HX7Y6P5K9N3M2QABCDEFGHIJKLMN01/results')
        .send({})
        .expect(401);
    });

    it('POST /api/assessments/:id/publish 无 token → 401', async () => {
      await request(app.getHttpServer())
        .post('/api/assessments/01HX7Y6P5K9N3M2QABCDEFGHIJKLMN01/publish')
        .send({})
        .expect(401);
    });

    it('POST /api/assessments/:id/close 无 token → 401', async () => {
      await request(app.getHttpServer())
        .post('/api/assessments/01HX7Y6P5K9N3M2QABCDEFGHIJKLMN01/close')
        .send({})
        .expect(401);
    });

    it('POST /api/assessments/:id/ranking 无 token → 401', async () => {
      await request(app.getHttpServer())
        .post('/api/assessments/01HX7Y6P5K9N3M2QABCDEFGHIJKLMN01/ranking')
        .send({})
        .expect(401);
    });

    it('POST /api/assessments/students/:id/list 无 token → 401', async () => {
      await request(app.getHttpServer())
        .post('/api/assessments/students/01HX7Y6P5K9N3M2QABCDEFGHIJKLMN01/list')
        .send({})
        .expect(401);
    });
  });

  describe('LearningProfile (V15)', () => {
    it('POST /api/learning-profile/recompute 无 token → 401', async () => {
      await request(app.getHttpServer())
        .post('/api/learning-profile/recompute')
        .send({})
        .expect(401);
    });

    it('POST /api/learning-profile/students/:id/weaknesses 无 token → 401', async () => {
      await request(app.getHttpServer())
        .post(
          '/api/learning-profile/students/01HX7Y6P5K9N3M2QABCDEFGHIJKLMN01/weaknesses',
        )
        .send({})
        .expect(401);
    });

    it('POST /api/learning-profile/students/:id/strengths 无 token → 401', async () => {
      await request(app.getHttpServer())
        .post(
          '/api/learning-profile/students/01HX7Y6P5K9N3M2QABCDEFGHIJKLMN01/strengths',
        )
        .send({})
        .expect(401);
    });
  });
});
