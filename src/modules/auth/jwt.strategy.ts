import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, TokenExpiredError, JsonWebTokenError } from '@nestjs/jwt';
import {
  JwtPayload,
  isPlatformRole,
  isCrossCampusRole,
} from './jwt-payload.interface';

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
  ) {}

  /**
   * 解析并校验 JWT，返回 typed payload
   * @throws UnauthorizedException
   */
  parse(token: string): JwtPayload {
    if (!token) {
      throw new UnauthorizedException('Missing token');
    }

    const secret = this.config.get<string>('JWT_SECRET');
    if (!secret || secret === '__CHANGE_ME_IN_PROD__') {
      throw new UnauthorizedException('JWT_SECRET not configured');
    }

    const decoded = this.verify(token);
    this.validateClaims(decoded);
    return decoded;
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
    // V10 拍板：跨校组（admin / sales_director / hr）campusId 可空（业务上无单一校区）
    // 单校组（含 boss 校长 / sales / sales_manager / marketing / finance）必须 32 字符
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
