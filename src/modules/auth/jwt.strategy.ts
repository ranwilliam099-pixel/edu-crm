import { Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, TokenExpiredError, JsonWebTokenError } from '@nestjs/jwt';
import {
  JwtPayload,
  isPlatformRole,
  isCrossCampusRole,
} from './jwt-payload.interface';
import { RedisService } from '../redis/redis.service';

/**
 * JWT 解析与校验（接口清单 V1 §6.1）— BE-W1-3 真接入版
 *
 * 职责：
 *   1. 从 Authorization: Bearer <token> 解析 JWT（用 @nestjs/jwt JwtService.verify）
 *   2. 校验 sub / tenantId / role / campusId 字段（claims 完整性）
 *   3. 拒绝过期 / 签名错误 / claims 缺失的 token
 *
 * §0 不猜测严守：
 *   - 黑名单 / 续签 / Redis 失效列表等待产品 + 项目经理拍板后补
 *   - 权限矩阵到角色级具体路由映射在路由 guard 层落地，本类只做 token 解析
 *
 * 项目隔离（追加 #8）：本类不引用企业管理系统主项目任何 auth 实现
 */
@Injectable()
export class JwtStrategy {
  constructor(
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
    @Optional() private readonly redis?: RedisService,
  ) {}

  /**
   * 解析并校验 JWT，返回 typed payload
   * @throws UnauthorizedException
   *
   * SPRINT-E.1(2026-05-13): parse 由 sync → async
   *   - 新增 jti 黑名单查询（logout 后再用同 token → 401 TOKEN_REVOKED）
   *   - 旧 token 无 jti：跳过查询（向前兼容，旧 token 自然过期后失效）
   *   - RedisService 可选注入（@Optional）：单测无 RedisModule 时跳过黑名单查询，保持现有 spec 兼容
   *   - Redis 异常：fail-open 放行（不阻塞主流程，与 idempotency / sentry 哲学一致）
   *
   * NOTE: 4 个生产调用点（tenant.middleware）全部已改为 await
   */
  async parse(token: string): Promise<JwtPayload> {
    if (!token) {
      throw new UnauthorizedException('Missing token');
    }

    const secret = this.config.get<string>('JWT_SECRET');
    if (!secret || secret === '__CHANGE_ME_IN_PROD__') {
      throw new UnauthorizedException('JWT_SECRET not configured');
    }

    const decoded = this.verify(token);
    this.validateClaims(decoded);
    await this.assertNotRevoked(decoded);
    return decoded;
  }

  /**
   * 查 Redis 黑名单 auth:revoked:{jti}
   *   - 命中 → 401 TOKEN_REVOKED
   *   - 未命中或无 jti 或未注入 RedisService → 通过
   *   - Redis 异常 → fail-open（运营告警自查；用户体验优先）
   */
  private async assertNotRevoked(payload: JwtPayload): Promise<void> {
    if (!payload.jti) return; // 旧 token 无 jti：跳过黑名单查询
    if (!this.redis) return; // 单测 / RedisModule 未注入：跳过
    try {
      const revoked = await this.redis.get(`auth:revoked:${payload.jti}`);
      if (revoked) {
        throw new UnauthorizedException('TOKEN_REVOKED');
      }
    } catch (e) {
      if (e instanceof UnauthorizedException) throw e;
      // Redis 不可用 → fail-open，避免一行 Redis 故障 → 全站登录瘫痪
    }
  }

  /**
   * 用 @nestjs/jwt JwtService.verify 真实校验签名 + 过期
   */
  private verify(token: string): JwtPayload {
    try {
      return this.jwt.verify<JwtPayload>(token);
    } catch (e) {
      if (e instanceof TokenExpiredError) {
        throw new UnauthorizedException('Token expired');
      }
      if (e instanceof JsonWebTokenError) {
        throw new UnauthorizedException(`Invalid token: ${e.message}`);
      }
      throw new UnauthorizedException('Token verification failed');
    }
  }

  private validateClaims(payload: JwtPayload): void {
    if (!payload.sub || payload.sub.length !== 32) {
      throw new UnauthorizedException('Invalid sub (expect 32-char ULID)');
    }
    if (!payload.role) {
      throw new UnauthorizedException('Missing role');
    }
    if (isPlatformRole(payload.role)) {
      if (payload.tenantId !== null) {
        throw new UnauthorizedException('platform role must have tenantId=null (A11)');
      }
      return;
    }
    if (!payload.tenantId || payload.tenantId.length !== 32) {
      throw new UnauthorizedException('tenant role must have 32-char tenantId');
    }
    // V10 拍板（+ 5/15 A-2 删 sales_director）：
    //   跨校组（admin / hr）campusId 可空（业务上无单一校区）
    //   单校组（含 boss 校长 / sales / sales_manager / marketing / finance / teacher / academic / academic_admin）
    //   必须 32 字符
    if (isCrossCampusRole(payload.role)) {
      if (payload.campusId !== null && payload.campusId.length !== 32) {
        throw new UnauthorizedException(
          'cross-campus role campusId must be null or 32-char ULID',
        );
      }
    } else {
      if (!payload.campusId || payload.campusId.length !== 32) {
        throw new UnauthorizedException(
          `single-campus role (${payload.role}) must have 32-char campusId (A08)`,
        );
      }
    }
  }
}
