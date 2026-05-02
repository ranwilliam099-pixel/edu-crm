import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient } from 'pg';

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
