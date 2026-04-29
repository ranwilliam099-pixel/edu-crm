import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtPayload, isPlatformRole } from './jwt-payload.interface';

/**
 * JWT 解析与校验（接口清单 V1 §6.1）
 *
 * 职责：
 *   1. 从 Authorization: Bearer <token> 解析 JWT
 *   2. 校验 sub / tenantId / role / campusId 字段
 *   3. 拒绝过期 / 签名错误 / claims 缺失的 token
 *
 * §0 不猜测：黑名单 / 续签 / 权限矩阵到角色级具体映射，等产品 + 项目经理拍板后再补
 */
@Injectable()
export class JwtStrategy {
  constructor(private readonly config: ConfigService) {}

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

    const decoded = this.decode(token, secret);
    this.validateClaims(decoded);
    return decoded;
  }

  /**
   * @nestjs/jwt 接入位置（W1 真实接入时替换为 jwtService.verify）
   * 当前为占位实现，仅供单测与契约对齐
   */
  private decode(_token: string, _secret: string): JwtPayload {
    throw new UnauthorizedException(
      'JwtStrategy.decode() is a placeholder — wire @nestjs/jwt JwtService.verify in W1 BE-W1-3',
    );
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
    } else {
      if (!payload.tenantId || payload.tenantId.length !== 32) {
        throw new UnauthorizedException('tenant role must have 32-char tenantId');
      }
      if (!payload.campusId || payload.campusId.length !== 32) {
        throw new UnauthorizedException('tenant role must have 32-char campusId (A08)');
      }
    }
  }
}
