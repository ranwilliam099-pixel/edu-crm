import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient } from 'pg';

/**
 * PgRow — PG 查询返回行的共享类型别名
 *
 * 用途：在 repository.mapRow 之类的边界处替换 `: any`，
 *      表达「PG 行是动态键值结构，类型在 mapper 内部 narrow」
 *
 * 不收紧到 Record<string, unknown>，因为这会强制每个字段访问加类型断言，
 * 对边界 mapper 收益小、改动量大。当前以「命名 + 文档」表达意图为主。
 */
export type PgRow = Record<string, any>;

/**
 * PgPoolService — 全局 PG 连接池（最小持久化层）
 *
 * 来源：
 *   - 用户 2026-05-02「做啊」（接 PG 让数据真存盘）
 *   - 替代之前 TypeORM 骨架（synchronize:false / autoLoadEntities:false → 实际不接 PG）
 *
 * 职责：
 *   1. 应用启动时建立 pg.Pool（max 10 连接）
 *   2. 应用关闭时优雅 close
 *   3. 暴露 query() / withClient() 接口给 Repository 用
 *   4. schema-per-tenant：withClient 接受 tenantSchema，自动 SET LOCAL search_path
 */
@Injectable()
export class PgPoolService implements OnModuleDestroy {
  private readonly logger = new Logger(PgPoolService.name);
  private pool: Pool;

  constructor(private readonly config: ConfigService) {
    this.pool = new Pool({
      host: this.config.get<string>('DB_HOST', '127.0.0.1'),
      port: parseInt(this.config.get<string>('DB_PORT', '5432'), 10),
      user: this.config.get<string>('DB_USER', 'eduapp'),
      password: this.config.get<string>('DB_PASSWORD', ''),
      database: this.config.get<string>('DB_NAME', 'edu'),
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    this.pool.on('error', (err) => {
      this.logger.error(`[PgPool] idle client error: ${err.message}`);
    });

    this.logger.log(`[PgPool] initialized → ${this.config.get('DB_HOST')}/${this.config.get('DB_NAME')} max=10`);
  }

  /**
   * Public schema query — 不切 search_path
   */
  async query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    const result = await this.pool.query(sql, params);
    return result.rows as T[];
  }

  /**
   * Tenant schema query — 自动 SET LOCAL search_path = tenant_xxx, public
   */
  async tenantQuery<T = any>(
    tenantSchema: string,
    sql: string,
    params: any[] = [],
  ): Promise<T[]> {
    if (!tenantSchema || !/^tenant_[a-z0-9_]+$/.test(tenantSchema)) {
      throw new Error(`Invalid tenantSchema: ${tenantSchema}`);
    }
    const client = await this.pool.connect();
    try {
      // SET search_path（session 级；release 前 reset 回 public 避免连接复用污染）
      // 不用 SET LOCAL — 那需要包在 BEGIN/COMMIT 事务内
      await client.query(`SET search_path TO ${tenantSchema}, public`);
      const result = await client.query(sql, params);
      await client.query(`SET search_path TO public`);
      return result.rows as T[];
    } finally {
      client.release();
    }
  }

  /**
   * 获取裸 client（事务用）
   */
  async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  /**
   * 事务封装 — BEGIN / try fn / COMMIT / catch ROLLBACK
   *
   * 替代散落 8 处的手写 BEGIN/COMMIT/ROLLBACK 模板。
   *
   * 用法：
   *   await pg.transaction(async (client) => {
   *     await client.query('UPDATE x SET y = $1', [val]);
   *     return result;
   *   });
   *
   * 可选 tenantSchema：自动 SET LOCAL search_path（事务级，自动还原）
   */
  async transaction<T>(
    fn: (client: PoolClient) => Promise<T>,
    options: { tenantSchema?: string } = {},
  ): Promise<T> {
    return this.withClient(async (client) => {
      await client.query('BEGIN');
      try {
        if (options.tenantSchema) {
          if (!/^tenant_[a-z0-9_]+$/.test(options.tenantSchema)) {
            throw new Error(`Invalid tenantSchema: ${options.tenantSchema}`);
          }
          await client.query(`SET LOCAL search_path TO ${options.tenantSchema}, public`);
        }
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    });
  }

  /**
   * 健康检查
   */
  async ping(): Promise<boolean> {
    try {
      const result = await this.pool.query('SELECT 1 as ok');
      return result.rows[0]?.ok === 1;
    } catch (e) {
      this.logger.error(`[PgPool] ping failed: ${(e as Error).message}`);
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log('[PgPool] closing...');
    await this.pool.end();
  }
}
