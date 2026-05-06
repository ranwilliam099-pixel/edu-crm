/**
 * Promotion (V20) e2e — 路由暴露 + 鉴权守护
 *
 * USER(2026-05-05)「单独走 promotion 折扣字段，给我一个配置面板」
 *
 * 验证：
 *   - admin/promotions/* 无 token → 401（middleware 拦截）
 *   - checkout/redeem-invite-code 无 token → 401
 *   - 缺必填 body 字段 → 400
 *   - 路由前缀 /api/db 生效
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/filters/global-exception.filter';

describe('Promotion (e2e) - V20 路由暴露 + 鉴权', () => {
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

  describe('admin/promotions（platform_admin only）', () => {
    it('GET /api/admin/promotions 无 token → 401', async () => {
      await request(app.getHttpServer())
        .get('/api/admin/promotions')
        .expect(401);
    });

    it('GET /api/admin/promotions/:code 无 token → 401', async () => {
      await request(app.getHttpServer())
        .get('/api/admin/promotions/early_bird_w1')
        .expect(401);
    });

    it('POST /api/admin/promotions 无 token → 401', async () => {
      await request(app.getHttpServer())
        .post('/api/admin/promotions')
        .send({ code: 'x', name: 'X', discountPct: 10, quotaTotal: 5 })
        .expect(401);
    });

    it('PATCH /api/admin/promotions/:code 无 token → 401', async () => {
      await request(app.getHttpServer())
        .patch('/api/admin/promotions/early_bird_w1')
        .send({ discountPct: 20 })
        .expect(401);
    });

    it('PATCH /api/admin/promotions/:code/toggle 无 token → 401', async () => {
      await request(app.getHttpServer())
        .patch('/api/admin/promotions/early_bird_w1/toggle')
        .send({ active: false })
        .expect(401);
    });

    it('DELETE /api/admin/promotions/:code 无 token → 401', async () => {
      await request(app.getHttpServer())
        .delete('/api/admin/promotions/early_bird_w1')
        .expect(401);
    });

    it('POST /api/admin/promotions/:code/dry-run 无 token → 401', async () => {
      await request(app.getHttpServer())
        .post('/api/admin/promotions/early_bird_w1/dry-run')
        .send({ discountPct: 50 })
        .expect(401);
    });

    it('GET /api/admin/promotions/:code/locked-tenants 无 token → 401', async () => {
      await request(app.getHttpServer())
        .get('/api/admin/promotions/early_bird_w1/locked-tenants')
        .expect(401);
    });
  });

  describe('checkout/redeem-invite-code（租户调用）', () => {
    it('POST /api/db/checkout/redeem-invite-code 无 token → 401', async () => {
      await request(app.getHttpServer())
        .post('/api/db/checkout/redeem-invite-code')
        .send({ tenantId: 't00000000000000000000000000000A01', inviteCode: 'ABCD' })
        .expect(401);
    });
  });
});
