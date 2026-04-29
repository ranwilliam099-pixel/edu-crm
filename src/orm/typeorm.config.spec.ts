import { ConfigService } from '@nestjs/config';
import { createTypeOrmOptions } from './typeorm.config';

// 测试访问 union type 中的 postgres 专属字段（schema），用 cast 避免 narrow 噪音
type PgOpts = ReturnType<typeof createTypeOrmOptions> & {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
  schema?: string;
  synchronize?: boolean;
  autoLoadEntities?: boolean;
  entities?: unknown[];
  logging?: string[];
  extra?: Record<string, unknown>;
};

describe('createTypeOrmOptions (W1 BE-W1-1)', () => {
  function makeConfig(values: Record<string, unknown>): ConfigService {
    return {
      get: <T>(key: string, defaultValue?: T): T | undefined => {
        return values[key] !== undefined ? (values[key] as T) : defaultValue;
      },
    } as ConfigService;
  }

  it('returns postgres dialect', () => {
    const opts = createTypeOrmOptions(makeConfig({})) as PgOpts;
    expect(opts.type).toBe('postgres');
  });

  it('uses defaults when env vars missing', () => {
    const opts = createTypeOrmOptions(makeConfig({})) as PgOpts;
    expect(opts).toMatchObject({
      host: 'localhost',
      port: 5432,
      username: 'eduapp',
      password: 'eduapp',
      database: 'edudb',
      schema: 'public',
    });
  });

  it('overrides from ConfigService values', () => {
    const opts = createTypeOrmOptions(
      makeConfig({
        DB_HOST: 'pg.prod.local',
        DB_PORT: 6543,
        DB_USER: 'app_user',
        DB_PASSWORD: 'sec',
        DB_NAME: 'edu_prod',
      }),
    ) as PgOpts;
    expect(opts).toMatchObject({
      host: 'pg.prod.local',
      port: 6543,
      username: 'app_user',
      password: 'sec',
      database: 'edu_prod',
    });
  });

  it('disables synchronize (migrations owned by node-pg-migrate)', () => {
    const opts = createTypeOrmOptions(makeConfig({})) as PgOpts;
    expect(opts.synchronize).toBe(false);
  });

  it('disables autoLoadEntities + empty entities (§0 不猜测)', () => {
    const opts = createTypeOrmOptions(makeConfig({})) as PgOpts;
    expect(opts.autoLoadEntities).toBe(false);
    expect(opts.entities).toEqual([]);
  });

  it('verbose logging in development, error-only in production', () => {
    const dev = createTypeOrmOptions(makeConfig({ NODE_ENV: 'development' })) as PgOpts;
    expect(dev.logging).toEqual(['error', 'warn']);
    const prod = createTypeOrmOptions(makeConfig({ NODE_ENV: 'production' })) as PgOpts;
    expect(prod.logging).toEqual(['error']);
  });

  it('default schema=public (BE-W1-4 interceptor will SET LOCAL search_path per request)', () => {
    const opts = createTypeOrmOptions(makeConfig({})) as PgOpts;
    expect(opts.schema).toBe('public');
  });

  it('connection pool defaults: max=10, idleTimeoutMillis=30000', () => {
    const opts = createTypeOrmOptions(makeConfig({})) as PgOpts;
    expect(opts.extra).toEqual({ max: 10, idleTimeoutMillis: 30_000 });
  });
});
