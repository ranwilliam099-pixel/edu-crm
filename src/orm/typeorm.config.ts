import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';

/**
 * TypeORM 配置工厂（W1 BE-W1-1 骨架）
 *
 * 职责（A01 schema-per-tenant + 字段清单 V1.1 §2）：
 *   - 从 ConfigService 读 DB_* 环境变量（与 .env.example 对应）
 *   - 返回 TypeOrmModuleOptions 供 TypeOrmModule.forRootAsync 使用
 *   - synchronize: false（迁移由 node-pg-migrate 负责，不让 ORM 自动建表）
 *   - schema: public（默认 schema；租户业务接口由 BE-W1-4 search_path interceptor 在 query 前 SET LOCAL）
 *
 * §0 不猜测严守：
 *   - 实体类（entities）暂留空 — 等 W1-W2 各业务模块逐步定义 *.entity.ts 时显式列出，避免 autoLoadEntities 引入未审计实体
 *   - 连接池参数（max / idleTimeoutMillis）等 INT-01 线上 PG 实例规格落实后再调
 *
 * 项目隔离（追加 #8）：本配置不引用企业管理系统主项目的 ORM 配置
 */
export function createTypeOrmOptions(config: ConfigService): TypeOrmModuleOptions {
  // @nestjs/typeorm `TypeOrmModuleOptions` 是 union；type:'postgres' 实际对应
  // PostgresConnectionOptions（含 schema 字段）。整体 as 断言避免 union narrow 问题。
  return {
    type: 'postgres',
    host: config.get<string>('DB_HOST', 'localhost'),
    port: config.get<number>('DB_PORT', 5432),
    username: config.get<string>('DB_USER', 'eduapp'),
    password: config.get<string>('DB_PASSWORD', 'eduapp'),
    database: config.get<string>('DB_NAME', 'edudb'),
    schema: config.get<string>('DB_PUBLIC_SCHEMA', 'public'),
    synchronize: false,
    autoLoadEntities: false,
    entities: [],
    logging: config.get<string>('NODE_ENV', 'development') === 'development' ? ['error', 'warn'] : ['error'],
    extra: {
      // 默认连接池配置；INT-01 真实 PG 落实后微调
      max: 10,
      idleTimeoutMillis: 30_000,
    },
  } as TypeOrmModuleOptions;
}
