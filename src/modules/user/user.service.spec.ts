/**
 * UserService 单元测试
 *
 * PM-TEMP-AUTH(2026-04-30): 全部带本 tag 的 fixture 在产品最终签字回归时一并替换
 *
 * 测试三场景：
 *   1. role=sales 不传 campusScope → 默认 [campusId]（主校区单值）
 *   2. role=sales 显式传 campusScope → 按显式值
 *   3. role=teacher 不传 campusScope → 默认 []
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

  describe('createUser - PM-TEMP-AUTH(2026-04-30) sales 主校区单值', () => {
    it('sales 不传 campusScope → 默认 [campusId]', () => {
      // PM-TEMP-AUTH(2026-04-30): 此场景验证主校区单值临时默认
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
      // PM-TEMP-AUTH(2026-04-30): 显式值优先于默认，确保导入场景不被覆盖
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

    it('role=teacher 不传 campusScope → 默认 [campusId]（PM-AUTH-5 临时按主校区单值，DepartmentService 落地后 V6 ALTER）', () => {
      // PM-AUTH-5(2026-04-30): 普通员工部门归属未实现前，临时与 sales 一致
      const dto: CreateUserDto = {
        id: ULID32_A,
        tenantId: ULID32_B,
        role: 'teacher',
        campusId: ULID32_C,
      };
      const result = service.createUser(dto);
      expect(result.campusScope).toEqual([ULID32_C]);
    });

    it('role=manager 不传 campusScope → 默认 [campusId]（PM-AUTH-5 同 teacher）', () => {
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

    it('role 非 4 枚举 → BadRequestException', () => {
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
