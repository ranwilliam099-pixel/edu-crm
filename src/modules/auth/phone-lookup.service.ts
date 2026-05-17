import { Injectable, Logger } from '@nestjs/common';
import { PgPoolService } from '../db/pg-pool.service';
import { ParentRepository } from '../db/parent.repository';

/**
 * PhoneLookupService — Sprint X.2 (2026-05-17) 跨表 phone 唯一性 + 多 tenant 候选反查
 *
 * 来源：
 *   - SSOT §12.1 跨表 phone 唯一性反查（B/C 端互斥红线）
 *   - SSOT §12.3 B 端跨 tenant 多绑（2+ row 返候选 list）
 *   - 用户拍板 D1「跨 tenant phone lookup 用应用层串行」
 *   - 用户拍板 D5「B/C 同 phone 命中（互斥违反）→ 直接 401 + pino warn ops」
 *
 * 设计（D1）：
 *   - 应用层串行循环 public.tenants（~67 tenants × 5ms ≈ 335ms in worst case）
 *   - 不上 user_phone_index 表（业务量预期 < 200 tenants, 串行性能足够）
 *   - 单次 lookup 内对 parents 表 + N 个 tenant.users 表查询
 *
 * 互斥语义（SSOT §12.7 + D5）：
 *   - 同 phone 同时存在 parents 表 + 任意 tenant.users 表 → 违反互斥 → 上层 401
 *   - PhoneLookupService 仅返事实（accountType + matches），不抛错; 决策在 controller
 *
 * 性能：
 *   - 67 tenants × 5ms = ~335ms（满足 5/min/IP throttle）
 *   - 不缓存（D1 拍板「应用层串行」，简化运维 + 防 stale cache）
 */

/** 单条 B-user 命中信息（多 tenant 候选 list 用） */
export interface BUserMatch {
  /** ULID 32-char */
  userId: string;
  /** 对应 tenant id（schema 派生）*/
  tenantId: string;
  /** tenant.name（前端 candidate 选择器显示）*/
  tenantName: string;
  /** users.role */
  role: string;
  /** users.campus_id（可能为空，admin/hr 跨校 role）*/
  campusId: string | null;
  /** users.name（员工姓名，前端 candidate 选择器辅助显示）*/
  userName: string;
  /** users.password_hash（V46，bcrypt 60 字符；空串 = 旧 row 待重置）*/
  passwordHash: string;
  /** users.status（应用层 login 校验 = '启用'）*/
  status: string;
  /** users.deleted_at（V44 软删，应用层 login 校验 IS NULL）*/
  deletedAt: Date | null;
  /** 校区名（前端 candidate 选择器显示，可能为空字符串当 campusId=null）*/
  campusName: string;
}

/** 单条 parent 命中信息 */
export interface ParentMatch {
  parentId: string;
  /** parents.status（应用层校验 = '启用'）*/
  status: string;
}

/** lookupByPhone 返回 */
export interface PhoneLookupResult {
  /** B 端 user 命中列表（跨 tenant 多绑可能 0/1/2+ 条）*/
  bUsers: BUserMatch[];
  /** C 端 parent 命中（0 或 1 条，public.parents 表 phone UNIQUE）*/
  parent: ParentMatch | null;
}

@Injectable()
export class PhoneLookupService {
  private readonly logger = new Logger(PhoneLookupService.name);

  constructor(
    private readonly pg: PgPoolService,
    private readonly parentRepo: ParentRepository,
  ) {}

  /**
   * 按 phone 跨表反查全部命中
   *
   * @param phone 11-digit Chinese mobile
   * @returns { bUsers: BUserMatch[], parent: ParentMatch | null }
   *
   * 单次调用流程（D1 应用层串行）：
   *   1. parents 表 phone_hash 反查（V40 HMAC, 优先 hash, fallback 明文）
   *   2. SELECT id, name FROM public.tenants ORDER BY created_at ASC
   *   3. for each tenant: tenantQuery 反查 users WHERE mobile=$1 AND deleted_at IS NULL
   *   4. 收集所有命中 → 返
   *
   * fail-open 哲学：
   *   - 某个 tenant schema 查询抛错（schema 不存在 / 列不存在）→ 跳过该 tenant + warn
   *   - 不影响其他 tenant 查询结果（防一个坏 tenant 拖垮全局 login）
   */
  async lookupByPhone(phone: string): Promise<PhoneLookupResult> {
    // 1. C 端 parent 反查（V40 双读: hash 优先 + 明文 fallback）
    let parent: ParentMatch | null = null;
    try {
      const found = await this.parentRepo.findParentByPhone(phone);
      if (found) {
        parent = { parentId: found.id, status: found.status };
      }
    } catch (err) {
      this.logger.warn(
        `[phone-lookup] parent lookup failed: ${(err as Error).message}`,
      );
    }

    // 2. B 端 user 跨 tenant 反查
    const bUsers: BUserMatch[] = [];
    const tenants = await this.listTenants();
    for (const t of tenants) {
      const schema = `tenant_${t.id.toLowerCase()}`;
      try {
        // 反查 users 表（V44: deleted_at IS NULL = 未软删）
        // LEFT JOIN campuses 取 campus_name（前端候选选择器显示用）
        const rows = await this.pg.tenantQuery<{
          id: string;
          name: string;
          mobile: string;
          role: string;
          campus_id: string | null;
          status: string;
          deleted_at: Date | null;
          password_hash: string;
          campus_name: string | null;
        }>(
          schema,
          `SELECT u.id, u.name, u.mobile, u.role, u.campus_id, u.status,
                  u.deleted_at, u.password_hash,
                  c.name AS campus_name
             FROM users u
             LEFT JOIN campuses c ON c.id = u.campus_id
            WHERE u.mobile = $1 AND u.deleted_at IS NULL`,
          [phone],
        );
        for (const r of rows) {
          bUsers.push({
            userId: r.id,
            tenantId: t.id,
            tenantName: t.name,
            role: r.role,
            campusId: r.campus_id ?? null,
            userName: r.name,
            passwordHash: r.password_hash ?? '',
            status: r.status,
            campusName: r.campus_name ?? '',
            deletedAt: r.deleted_at ?? null,
          });
        }
      } catch (err) {
        // schema 不存在 / 列不存在 → 跳过该 tenant（fail-open，防一个坏 tenant 拖垮全局）
        this.logger.warn(
          `[phone-lookup] tenant ${t.id} lookup failed (skip): ${(err as Error).message}`,
        );
      }
    }

    return { bUsers, parent };
  }

  /**
   * 列出所有 tenants（cache 不在此层；D1 应用层串行不缓存）
   *
   * fail-open: 查询失败返空数组（防 PG 单点抖动 → login 全瘫）
   */
  private async listTenants(): Promise<Array<{ id: string; name: string }>> {
    try {
      return await this.pg.query<{ id: string; name: string }>(
        `SELECT id, name FROM public.tenants ORDER BY created_at ASC`,
      );
    } catch (err) {
      this.logger.error(
        `[phone-lookup] listTenants failed: ${(err as Error).message}`,
      );
      return [];
    }
  }
}
