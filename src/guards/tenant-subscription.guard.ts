import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { JwtPayload, isPlatformRole } from '../modules/auth/jwt-payload.interface';
import { PgPoolService } from '../modules/db/pg-pool.service';

/**
 * TenantSubscriptionGuard — 订阅过期数据只读门禁（T9-EPIC spec 2026-05-16 §3）
 *
 * 来源：
 *   - 用户 5/16 拍板「14d 试用，14d 后只读 + 付款解锁」
 *   - A2 audit P0-A4 修复（pay.js blocked:true 永久死链）
 *
 * 拍板（spec §11）：
 *   1. global APP_GUARD（不是 class-level）— 35 controller / 183 写装饰器，
 *      class-level 改 35 文件易漏
 *   2. expired 状态：GET 全开（导出 / 查看），method !== 'GET' 才查
 *   3. 不拦截付款 / 公开 / 登录 链路
 *
 * 过滤规则（早退顺序）：
 *   - method === 'GET'                → 放行（只读保护语义）
 *   - 路径白名单 4 前缀                → 放行
 *      /api/checkout/*  付款必须能解锁
 *      /api/public/*    公开路径
 *      /api/auth/*      登录/refresh
 *   - !req.user                       → 放行（上游 middleware 决定 401）
 *   - isPlatformRole(user.role)       → 放行（platform_admin/finance_admin 可跨租户）
 *   - !user.tenantId                  → 放行（无 tenant 上下文，由其他 Guard 处理）
 *   - 查 public.tenants SELECT subscription_status
 *      - 'expired'  → 403 'subscription_expired'  （试用过期，付款解锁）
 *      - 'archived' → 403 'subscription_archived' （主动归档，admin 恢复）
 *      - 'frozen'   → 403 'subscription_frozen'   （欠费/违规冻结，admin 解冻）
 *      - 'trial' / 'active' → 放行
 *
 * 不查 DB 时机（fail-open）：
 *   - GET 请求（数据只读保护语义，导出/查看不应被订阅锁拦截）
 *   - 公开/付款/登录路径（订阅过期仍允许用户付款解锁）
 *   - 平台超管角色（admin 跨租户运维）
 *
 * 5 状态枚举（V49 扩展）：
 *   trial(14d 试用) / active(已订阅) / expired(只读) / archived(归档) / frozen(冻结)
 *   archived/frozen 与 expired 同等待遇 method !== GET 阻断，区别仅在 403 code/message
 */
@Injectable()
export class TenantSubscriptionGuard implements CanActivate {
  private readonly logger = new Logger(TenantSubscriptionGuard.name);

  constructor(private readonly pg: PgPoolService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const method = String(req.method || '').toUpperCase();
    // GET 全开（拍板 4：method!='GET' 才查）
    if (method === 'GET') return true;

    // 白名单：付款 / 公开 / 登录 4 前缀（spec §3）
    const path = String(req.originalUrl || req.url || '').split('?')[0];
    if (
      path.startsWith('/api/checkout/') ||
      path.startsWith('/api/public/') ||
      path.startsWith('/api/auth/')
    ) {
      return true;
    }

    const user = (req as { user?: JwtPayload }).user;
    // 未挂 user → 由上游 middleware/guard 决定 401（本 Guard 不抢权）
    if (!user) return true;
    // 平台角色跨租户 → 放行
    if (isPlatformRole(user.role)) return true;
    // 租户 ID 缺失 → 放行（其他 Guard 会处理）
    if (!user.tenantId) return true;

    let rows: Array<{ subscription_status: string }>;
    try {
      rows = await this.pg.query<{ subscription_status: string }>(
        'SELECT subscription_status FROM public.tenants WHERE id = $1',
        [user.tenantId],
      );
    } catch (err) {
      // DB 查询失败 fail-open（与 audit_log 一致；防 PG 抖动导致服务全停）
      this.logger.warn(
        `[TenantSubscriptionGuard] DB query failed tenant=${user.tenantId}: ${(err as Error).message}`,
      );
      return true;
    }

    // tenant 行不存在（边界）→ 放行，让上游 controller 自己处理
    if (rows.length === 0) return true;

    // V49 扩展 5 状态枚举：expired / archived / frozen 同等阻断（method !== GET 时）
    const status = rows[0].subscription_status;
    if (status === 'expired') {
      throw new ForbiddenException({
        code: 'subscription_expired',
        message: '试用期已结束，请订阅后继续使用',
      });
    }
    if (status === 'archived') {
      throw new ForbiddenException({
        code: 'subscription_archived',
        message: '该租户已归档，请联系管理员恢复',
      });
    }
    if (status === 'frozen') {
      throw new ForbiddenException({
        code: 'subscription_frozen',
        message: '该租户已冻结，请联系管理员解冻',
      });
    }
    // trial / active 放行
    return true;
  }
}
