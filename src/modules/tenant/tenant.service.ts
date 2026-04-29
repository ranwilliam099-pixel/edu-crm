import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * 租户初始化服务（W1 BE-W1-2 骨架）
 *
 * 职责（接口清单 V1 §6.3 + A01 schema-per-tenant）：
 *   1. 微信支付 V3 回调 paid_at 触发后，由 checkout 模块调用 provisionTenant()
 *   2. 读 migrations/V2__tenant_schema_template.sql，把占位 `__TENANT_SCHEMA__` 替换为 `tenant_<tenantId>`
 *   3. 在 PG 事务内执行替换后的 SQL，建租户 schema 11 张表
 *   4. 把 tenant_id 入 public.tenants 表，状态 `已付费`
 *
 * §0 不猜测严守：
 *   - 真实 PG 连接由 W1 BE-W1-4 TypeORM DataSource 接入（当前用占位）
 *   - 微信支付回调验签 + 业务编排在 checkout 模块（W2-T3）落地，本服务仅做"建 schema + 注册租户"
 *   - 失败重试策略 / dead-letter 队列等待 D11 第一批（A05 详细规约）
 *
 * 项目隔离（追加 #8）：本服务不引用企业管理系统主项目任何数据源
 */
@Injectable()
export class TenantService {
  private readonly logger = new Logger(TenantService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * 校验 tenantId 格式：32-char ULID（与字段清单 V1.1 §3.2 一致）
   * @throws BadRequestException
   */
  validateTenantId(tenantId: string): void {
    if (!tenantId || tenantId.length !== 32) {
      throw new BadRequestException(`tenantId must be 32-char ULID, got: ${tenantId?.length ?? 0}`);
    }
    // ULID 字符集：Crockford Base32 (0-9, A-Z 去除 I/L/O/U)
    if (!/^[0-9A-HJKMNP-TV-Z]{32}$/i.test(tenantId)) {
      throw new BadRequestException(`tenantId is not valid Crockford Base32 ULID`);
    }
  }

  /**
   * 计算租户 schema 名（与 V2 模板占位对应）
   */
  schemaName(tenantId: string): string {
    this.validateTenantId(tenantId);
    return `tenant_${tenantId.toLowerCase()}`;
  }

  /**
   * 读 V2 模板并做占位替换
   * @returns 替换后的 SQL 字符串（待 BE-W1-4 真实 DataSource 执行）
   */
  async renderTenantSchemaSQL(tenantId: string): Promise<string> {
    const schema = this.schemaName(tenantId);
    const templatePath = resolve(__dirname, '../../../migrations/V2__tenant_schema_template.sql');
    const template = await readFile(templatePath, 'utf-8');
    const rendered = template.replace(/__TENANT_SCHEMA__/g, schema);
    this.logger.log(`Rendered V2 SQL for tenant=${tenantId} schema=${schema} bytes=${rendered.length}`);
    return rendered;
  }

  /**
   * 配置租户：建 schema + 11 张表 + 注册到 public.tenants
   *
   * **当前为占位实现**：仅做模板渲染 + 日志，不真实连 PG。
   * **W1 BE-W1-4 落地点**：
   *   1. 注入 TypeORM DataSource
   *   2. 在事务内执行 rendered SQL
   *   3. INSERT INTO public.tenants ... + UPDATE public.payment_orders SET status='已支付'
   *   4. 失败回滚（包括 schema DROP）
   */
  async provisionTenant(tenantId: string, _orderId: string): Promise<{ schema: string; tablesPlanned: number }> {
    const schema = this.schemaName(tenantId);
    const sql = await this.renderTenantSchemaSQL(tenantId);

    // 占位：W1 BE-W1-4 替换为 dataSource.transaction(async (manager) => { await manager.query(sql); ... })
    this.logger.warn(
      `[BE-W1-2 PLACEHOLDER] provisionTenant(${tenantId}) — would execute ${sql.length} bytes of V2 DDL in tenant schema "${schema}"`,
    );

    return { schema, tablesPlanned: 11 };
  }
}
