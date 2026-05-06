import { Body, Controller, Post, HttpCode, HttpStatus, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ParentJwtStrategy } from './parent-jwt.strategy';
import { isCrossCampusRole, TenantRole } from './jwt-payload.interface';

/**
 * AuthController — 联调收尾 Q-FE-2 + 待补 B 端 /auth/login
 *
 * 路由前缀：/api/public（公开，TenantMiddleware 已豁免）
 *
 * 来源：
 *   - 派单条目 33 §5 待答清单 Q-FE-2
 *   - 用户 2026-05-02「立即补，马上做完」
 *
 * 当前实现：mock 鉴权（INT-01 docker PG 起来后接真用户表 + bcrypt）
 *   - 凡是手机号末尾 4 位非空，即视为合法登录
 *   - 真实场景：查 users 表 + bcrypt 比对密码
 */
@Controller('public/auth')
export class AuthController {
  constructor(
    private readonly jwt: JwtService,
    private readonly parentJwt: ParentJwtStrategy,
  ) {}

  /**
   * POST /api/public/auth/login — B 端员工登录
   *
   * Body: { phone, password, tenantId, role, campusId, userId }
   *   真实场景：phone + password → 查 users 表 → bcrypt → 取 user.role
   *   当前 mock：直接采信传入的 role / tenantId / userId（前端登录页输入即可）
   *
   * @returns { token, tokenType: 'Bearer', expiresIn, payload }
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(
    @Body()
    body: {
      phone: string;
      password?: string; // mock 不校验
      tenantId: string;
      role: string;
      campusId?: string | null; // 跨校 role 可空
      userId: string;
    },
  ) {
    if (!body.phone || !/^1[3-9]\d{9}$/.test(body.phone)) {
      throw new BadRequestException('phone must be valid 11-digit Chinese mobile');
    }
    if (!body.userId || body.userId.length !== 32) {
      throw new BadRequestException('userId must be 32-char ULID');
    }
    if (!body.tenantId || body.tenantId.length !== 32) {
      throw new BadRequestException('tenantId must be 32-char ULID');
    }
    const validRoles = [
      'sales',
      'sales_manager',
      'sales_director',
      'marketing',
      'finance',
      'boss',
      'admin',
      'hr',
    ];
    if (!validRoles.includes(body.role)) {
      throw new BadRequestException(`role must be one of ${validRoles.join('/')}`);
    }

    // V10 拍板：跨校组（admin/sales_director/hr）campusId 可空；
    // 单校组（boss/sales/sales_manager/marketing/finance）必须 32 字符 ULID
    let campusId: string | null;
    if (isCrossCampusRole(body.role)) {
      if (body.campusId && body.campusId.length !== 32) {
        throw new BadRequestException(
          'cross-campus role campusId must be null/omitted or 32-char ULID',
        );
      }
      campusId = body.campusId || null;
    } else {
      if (!body.campusId || body.campusId.length !== 32) {
        throw new BadRequestException(
          `single-campus role (${body.role}) must have 32-char campusId`,
        );
      }
      campusId = body.campusId;
    }

    const payload = {
      sub: body.userId,
      tenantId: body.tenantId,
      role: body.role as TenantRole,
      campusId,
    };
    const token = this.jwt.sign(payload);
    return {
      token,
      tokenType: 'Bearer',
      expiresIn: 86400,
      payload,
    };
  }

  /**
   * POST /api/public/auth/wechat-login — C 端家长微信登录
   *
   * Body: { code, parentId, openid?, name?, phone? }
   *   真实场景：wx.login → 拿 code → 用 wx-server-sdk 换 openid → 查/建 parents 表
   *   当前 mock：直接采信传入的 parentId（前端 register 后调）
   *
   * @returns { token (ParentJwt), tokenType: 'Bearer', expiresIn, payload }
   */
  @Post('wechat-login')
  @HttpCode(HttpStatus.OK)
  wechatLogin(
    @Body()
    body: {
      parentId: string;
      openid?: string;
      code?: string; // mock 不校验
    },
  ) {
    if (!body.parentId || body.parentId.length !== 32) {
      throw new BadRequestException('parentId must be 32-char ULID');
    }
    const token = this.parentJwt.sign({
      parentId: body.parentId,
      openid: body.openid,
    });
    return {
      token,
      tokenType: 'Bearer',
      expiresIn: 30 * 86400,
      payload: { parentId: body.parentId, openid: body.openid, type: 'parent' },
    };
  }
}
