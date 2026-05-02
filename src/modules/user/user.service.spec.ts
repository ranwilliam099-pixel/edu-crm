/**
 * UserService 单元测试
 *
 * USER-AUTH(2026-05-02): sales 主校区单值由用户最终拍板锁定（台账条目 28），不再回归
 * PM-AUTH-5(2026-04-30): admin/teacher/manager 临时填充语义，等 PD 二次明示
 *
 * 测试场景：
 *   1. role=sales 不传 campusScope → 默认 [campusId]（主校区单值，用户拍板）
 *   2. role=sales 显式传 campusScope → 按显式值
 *   3. role=teacher/manager/admin 默认 / 显式 — 临时方案
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { UserService } from './user.service';
import { CreateUserDto } from './dto/create-user.dto';

const ULID32_A = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNOP';
const ULID32_B = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNOQ';
const ULID32_C = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNOR';
const ULID32_D = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNOS';

describe('UserService', () => {
  let service: UserService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [UserService],
    }).compile();
    service = module.get<UserService>(UserService);
  });

  describe('createUser - USER-AUTH(2026-05-02) sales 主校区单值（用户最终拍板）', () => {
    it('sales 不传 campusScope → 默认 [campusId]', () => {
      // USER-AUTH(2026-05-02): 此场景验证主校区单值默认（用户最终拍板，台账条目 28）
      const dto: CreateUserDto = {
        id: ULID32_A,
        tenantId: ULID32_B,
        role: 'sales',
        campusId: ULID32_C,
      };
      const result = service.createUser(dto);
      expect(result.campusScope).toEqual([ULID32_C]);
      expect(result.role).toBe('sales');
    });

    it('sales 显式传 campusScope → 按显式值（运营批量导入场景）', () => {
      // USER-AUTH(2026-05-02): 显式值优先于默认，确保导入场景不被覆盖
      const dto: CreateUserDto = {
        id: ULID32_A,
        tenantId: ULID32_B,
        role: 'sales',
        campusId: ULID32_C,
        campusScope: [ULID32_C, ULID32_D],
      };
      const result = service.createUser(dto);
      expect(result.campusScope).toEqual([ULID32_C, ULID32_D]);
    });

    // USER-AUTH(2026-05-02 台账条目 29): teacher 不再是 users 表枚举（走方向 B 独立 teachers 表）
    // 原 teacher 单测用例已删除

    it('role=manager 不传 campusScope → 默认 [campusId]（临时按主校区单值，等用户/PD 二次明示）', () => {
      const dto: CreateUserDto = {
        id: ULID32_A,
        tenantId: ULID32_B,
        role: 'manager',
        campusId: ULID32_C,
      };
      const result = service.createUser(dto);
      expect(result.campusScope).toEqual([ULID32_C]);
    });

    it('role=admin 不传 campusScope → 默认 []（PM-AUTH-5 admin 不受 campus_scope 限制，业务层跳过 scope check）', () => {
      // PM-AUTH-5(2026-04-30): admin 全校区语义由权限层处理，应用层默认空数组
      const dto: CreateUserDto = {
        id: ULID32_A,
        tenantId: ULID32_B,
        role: 'admin',
        campusId: ULID32_C,
      };
      const result = service.createUser(dto);
      expect(result.campusScope).toEqual([]);
    });

    it('role=admin 显式传 campusScope → 按显式值（特定 admin 限制场景）', () => {
      const dto: CreateUserDto = {
        id: ULID32_A,
        tenantId: ULID32_B,
        role: 'admin',
        campusId: ULID32_C,
        campusScope: [ULID32_C],
      };
      const result = service.createUser(dto);
      expect(result.campusScope).toEqual([ULID32_C]);
    });
  });

  describe('createUser - 输入校验', () => {
    it('id 长度非 32 → BadRequestException', () => {
      const dto: CreateUserDto = {
        id: 'short',
        tenantId: ULID32_B,
        role: 'sales',
        campusId: ULID32_C,
      };
      expect(() => service.createUser(dto)).toThrow(BadRequestException);
    });

    it('role 非 3 枚举 → BadRequestException', () => {
      const dto = {
        id: ULID32_A,
        tenantId: ULID32_B,
        role: 'unknown' as any,
        campusId: ULID32_C,
      };
      expect(() => service.createUser(dto)).toThrow(BadRequestException);
    });

    it('campusId 长度非 32 → BadRequestException', () => {
      const dto: CreateUserDto = {
        id: ULID32_A,
        tenantId: ULID32_B,
        role: 'sales',
        campusId: 'short',
      };
      expect(() => service.createUser(dto)).toThrow(BadRequestException);
    });
  });
});
