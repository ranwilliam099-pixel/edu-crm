import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * BE-04 health 接口 e2e 测试
 * 对应：评估意见追加 #催办 §6 BE-04 + FE-SANDBOX-04 客户端契约对齐
 *
 * 验证：
 *   - 全局前缀 /api 生效（main.ts setGlobalPrefix）
 *   - 路由 /api/public/health 公开（不要求 token）
 *   - 响应 schema = { ok:true, version:'v1', timestamp:ISO-8601 }
 *   - HTTP 200
 */
describe('Health (e2e)', () => {
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
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/public/health → 200 + { ok, version, timestamp }', async () => {
    const res = await request(app.getHttpServer()).get('/api/public/health').expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.version).toBe('v1');
    expect(res.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('public path is reachable without Authorization header (TenantMiddleware §6.2)', async () => {
    // 显式测试：无 Authorization 应仍 200（公开路径）
    await request(app.getHttpServer())
      .get('/api/public/health')
      .expect(200)
      .expect((res: request.Response) => {
        if (!res.body.ok) throw new Error('expected ok=true on public path');
      });
  });

  it('responses are fresh on each request', async () => {
    const r1 = await request(app.getHttpServer()).get('/api/public/health');
    await new Promise((r) => setTimeout(r, 5));
    const r2 = await request(app.getHttpServer()).get('/api/public/health');
    expect(new Date(r2.body.timestamp).getTime()).toBeGreaterThanOrEqual(
      new Date(r1.body.timestamp).getTime(),
    );
  });

  it('responds with schema matching FE-SANDBOX-04 client expectations', async () => {
    const res = await request(app.getHttpServer()).get('/api/public/health');
    expect(Object.keys(res.body).sort()).toEqual(['ok', 'timestamp', 'version']);
  });
});
