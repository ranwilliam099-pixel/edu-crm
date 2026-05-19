/**
 * Checkout e2e — W3-1 Phase 1.3 BE-W3-3 主流程黄路径
 *
 * PM-AUTH-6(2026-04-30): 4 SKU 真值 e2e 验证
 *
 * 覆盖：
 *   - GET /api/checkout/sku 列表 4 SKU
 *   - GET /api/checkout/sku/:sku 单 SKU 价格
 *   - POST /api/checkout/orders 创建订单（4 SKU 各一个）
 *   - GET /api/checkout/capacity/:sku 容量边界
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/filters/global-exception.filter';

const ULID32_O = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNOO';
const ULID32_T = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNOT';

describe('Checkout (e2e) - PM-AUTH-6 4 SKU 真值', () => {
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

  it('GET /api/checkout/sku → 4 SKU 列表', async () => {
    const res = await request(app.getHttpServer()).get('/api/checkout/sku').expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(4);
    const skus = res.body.map((p: any) => p.sku);
    expect(skus.sort()).toEqual(['growth', 'school_pro', 'standard_1999', 'trial']);
  });

  it('GET /api/checkout/sku/standard_1999 → 1999 元 / 1 年', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/checkout/sku/standard_1999')
      .expect(200);
    expect(res.body.priceCnyYuan).toBe(1999);
    expect(res.body.billingPeriodDays).toBe(365);
    expect(res.body.maxCampuses).toBe(3);
    expect(res.body.maxAccounts).toBe(50);
  });

  it('GET /api/checkout/sku/school_pro → 4999 元', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/checkout/sku/school_pro')
      .expect(200);
    expect(res.body.priceCnyYuan).toBe(4999);
    expect(res.body.maxAccounts).toBe(100);
  });

  it('GET /api/checkout/sku/growth → 询价制', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/checkout/sku/growth')
      .expect(200);
    expect(res.body.isQuoteBased).toBe(true);
    expect(res.body.priceCnyYuan).toBe(9999);
  });

  it('GET /api/checkout/sku/trial → 0 元 / 14 天', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/checkout/sku/trial')
      .expect(200);
    expect(res.body.priceCnyYuan).toBe(0);
    expect(res.body.billingPeriodDays).toBe(14);
  });

  it('POST /api/checkout/orders standard_1999 → 201 + amount=1999', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/checkout/orders')
      .send({ orderId: ULID32_O, tenantId: ULID32_T, sku: 'standard_1999' })
      .expect(201);
    expect(res.body.amountCnyYuan).toBe(1999);
    expect(res.body.priceTier).toBe('standard_1999');
    expect(res.body.state).toBe('待支付');
  });

  it('POST /api/checkout/orders growth without quote → 400', async () => {
    await request(app.getHttpServer())
      .post('/api/checkout/orders')
      .send({ orderId: ULID32_O, tenantId: ULID32_T, sku: 'growth' })
      .expect(400);
  });

  it('POST /api/checkout/orders growth with quote 15000 → 201 + amount=15000', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/checkout/orders')
      .send({
        orderId: ULID32_O,
        tenantId: ULID32_T,
        sku: 'growth',
        customQuotePriceCnyYuan: 15000,
      })
      .expect(201);
    expect(res.body.amountCnyYuan).toBe(15000);
  });

  it('GET /api/checkout/capacity/school_pro → 5 校区 + 100 账号', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/checkout/capacity/school_pro')
      .expect(200);
    expect(res.body.maxCampuses).toBe(5);
    expect(res.body.maxAccounts).toBe(100);
  });

  it('未知 SKU → 400', async () => {
    await request(app.getHttpServer()).get('/api/checkout/sku/unknown').expect(400);
  });

  it('GlobalExceptionFilter 响应格式：{ statusCode, message, error, timestamp, path }', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/checkout/orders')
      .send({ orderId: 'short', tenantId: ULID32_T, sku: 'standard_1999' })
      .expect(400);
    expect(res.body).toHaveProperty('statusCode', 400);
    expect(res.body).toHaveProperty('message');
    expect(res.body).toHaveProperty('error');
    expect(res.body).toHaveProperty('timestamp');
    expect(res.body).toHaveProperty('path');
  });
});
