import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { PgPoolService } from './pg-pool.service';
import {
  AuditCtx,
  PromotionAuditAction,
  PromotionTier,
} from './promotion.types';

/**
 * PromotionAuditRepository — V20 audit 写入唯一入口
 *
 * 由 PromotionRepository（CRUD/toggle/delete）、PromotionQuotaService
 * （reserve/commit/release）、SubscriptionRepository（plan_change 释放）共用
 *
 * 设计：
 *   - 接受可选 PoolClient（事务内复用 client；不传则用 pool 直连）
 *   - 不抛错 — 审计失败不应阻塞业务流（仅 log）
 */
@Injectable()
export class PromotionAuditRepository {
  constructor(private readonly pg: PgPoolService) {}

  async write(args: {
    tierCode: string;
    action: PromotionAuditAction;
    before?: PromotionTier | null;
    after?: PromotionTier | null;
    afterJson?: Record<string, any>;
    tenantId?: string | null;
    ctx?: AuditCtx;
    client?: PoolClient;
  }): Promise<void> {
    const sql = `INSERT INTO public.promotion_tier_audit
       (tier_code, action, before_json, after_json, tenant_id,
        operator_id, operator_role, operator_ip, note)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8, $9)`;
    const beforeJson = args.before ? JSON.stringify(args.before) : null;
    const afterJson = args.afterJson
      ? JSON.stringify(args.afterJson)
      : args.after
        ? JSON.stringify(args.after)
        : null;
    const params = [
      args.tierCode,
      args.action,
      beforeJson,
      afterJson,
      args.tenantId || null,
      args.ctx?.operatorId || null,
      args.ctx?.operatorRole || null,
      args.ctx?.operatorIp || null,
      args.ctx?.note || null,
    ];
    if (args.client) {
      await args.client.query(sql, params);
    } else {
      await this.pg.query(sql, params);
    }
  }
}
