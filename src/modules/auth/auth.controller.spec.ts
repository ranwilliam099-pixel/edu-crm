/**
 * AuthController 单测 — 联调收尾两个登录接口
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { ParentJwtStrategy } from './parent-jwt.strategy';

const ULID32 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMN01';
const ULID32_T = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNTN';
const ULID32_C = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNCM';

describe('AuthController - 登录接口', () => {
  let controller: AuthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: 'test-secret', signOptions: { expiresIn: '1d' } })],
      controllers: [AuthController],
      providers: [
        ParentJwtStrategy,
        {
          provide: ConfigService,
          useValue: { get: () => 'test-secret' },
        },
      ],
    }).compile();
    controller = module.get<AuthController>(AuthController);
  });

  describe('login - B 端员工登录', () => {
    it('合法登录 → 返回 JWT', () => {
      const result = controller.login({
        phone: '13800001111',
        tenantId: ULID32_T,
        role: 'sales',
        campusId: ULID32_C,
        userId: ULID32,
      });
      expect(result.token).toBeTruthy();
      expect(result.tokenType).toBe('Bearer');
      expect(result.payload.role).toBe('sales');
    });

    it('phone 非法 → BadRequestException', () => {
      expect(() =>
        controller.login({
          phone: '12345',
          tenantId: ULID32_T,
          role: 'sales',
          campusId: ULID32_C,
          userId: ULID32,
        }),
      ).toThrow(BadRequestException);
    });

    it('userId 长度非 32 → BadRequestException', () => {
      expect(() =>
        controller.login({
          phone: '13800001111',
          tenantId: ULID32_T,
          role: 'sales',
          campusId: ULID32_C,
          userId: 'short',
        }),
      ).toThrow(BadRequestException);
    });

    it('未知 role → BadRequestException', () => {
      expect(() =>
        controller.login({
          phone: '13800001111',
          tenantId: ULID32_T,
          role: 'unknown',
          campusId: ULID32_C,
          userId: ULID32,
        }),
      ).toThrow(BadRequestException);
    });

    it('admin (跨校 / 老板) 不传 campusId → 接受，payload.campusId=null', () => {
      const result = controller.login({
        phone: '13800001111',
        tenantId: ULID32_T,
        role: 'admin',
        userId: ULID32,
      });
      expect(result.payload.campusId).toBeNull();
      expect(result.payload.role).toBe('admin');
    });

    it('admin 显式给 32 字符 campusId（主校区视角）→ 接受', () => {
      const result = controller.login({
        phone: '13800001111',
        tenantId: ULID32_T,
        role: 'admin',
        campusId: ULID32_C,
        userId: ULID32,
      });
      expect(result.payload.campusId).toBe(ULID32_C);
    });

    it('admin 给非 32 字符 campusId → BadRequestException', () => {
      expect(() =>
        controller.login({
          phone: '13800001111',
          tenantId: ULID32_T,
          role: 'admin',
          campusId: 'short',
          userId: ULID32,
        }),
      ).toThrow(/cross-campus.*null.*32-char/);
    });

    it('sales_director (跨校 / 大区经理) 不传 campusId → 接受', () => {
      const result = controller.login({
        phone: '13800001111',
        tenantId: ULID32_T,
        role: 'sales_director',
        userId: ULID32,
      });
      expect(result.payload.campusId).toBeNull();
    });

    it('hr (跨校) 不传 campusId → 接受', () => {
      const result = controller.login({
        phone: '13800001111',
        tenantId: ULID32_T,
        role: 'hr',
        userId: ULID32,
      });
      expect(result.payload.campusId).toBeNull();
    });

    it('boss (单校 / 校长) 不传 campusId → BadRequestException — V10 单校强校验', () => {
      expect(() =>
        controller.login({
          phone: '13800001111',
          tenantId: ULID32_T,
          role: 'boss',
          userId: ULID32,
        }),
      ).toThrow(/single-campus.*boss.*32-char campusId/);
    });

    it('boss 给非 32 字符 campusId → BadRequestException', () => {
      expect(() =>
        controller.login({
          phone: '13800001111',
          tenantId: ULID32_T,
          role: 'boss',
          campusId: 'short',
          userId: ULID32,
        }),
      ).toThrow(/single-campus.*boss/);
    });

    it('sales (单校) 不传 campusId → BadRequestException', () => {
      expect(() =>
        controller.login({
          phone: '13800001111',
          tenantId: ULID32_T,
          role: 'sales',
          userId: ULID32,
        }),
      ).toThrow(/single-campus.*sales/);
    });

    it('marketing (单校) 不传 campusId → BadRequestException', () => {
      expect(() =>
        controller.login({
          phone: '13800001111',
          tenantId: ULID32_T,
          role: 'marketing',
          userId: ULID32,
        }),
      ).toThrow(/single-campus.*marketing/);
    });

    it('finance (单校) 不传 campusId → BadRequestException', () => {
      expect(() =>
        controller.login({
          phone: '13800001111',
          tenantId: ULID32_T,
          role: 'finance',
          userId: ULID32,
        }),
      ).toThrow(/single-campus.*finance/);
    });
  });

  describe('wechatLogin - C 端家长微信登录', () => {
    it('合法登录 → 返回 ParentJwt', () => {
      const result = controller.wechatLogin({
        parentId: ULID32,
        openid: 'oWxXXX',
      });
      expect(result.token).toBeTruthy();
      expect(result.payload.type).toBe('parent');
      expect(result.payload.parentId).toBe(ULID32);
    });

    it('parentId 长度非 32 → BadRequestException', () => {
      expect(() =>
        controller.wechatLogin({ parentId: 'short' }),
      ).toThrow(BadRequestException);
    });
  });
});
