/**
 * UserService 单元测试
 *
 * USER-AUTH(2026-05-02 台账条目 28/30/31): 8 枚举 campus_scope 默认填充全部由用户拍板锁定
 *   - 单校区组（sales / sales_manager / boss / marketing / finance）→ [campusId]
 *   - 跨校区组（admin / hr）→ []（业务层豁免）— 5/15 A-2 删 sales_director
 *   - 条目 31 修订：marketing / finance 从 throw 改为单校默认；显式 campusScope 仍优先
 *
 * teacher 走独立 teachers 表（条目 29 方向 B），不在本 service
 *
 * 5/15 A-2 拍板：sales_director 应用层取消（不在拍板权威 9 角色清单）
 *   - validRoles 删 → 创建时 BadRequestException
 *   - 加测拒绝路径
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

  describe('createUser - 单校区组 → [campusId]（USER-AUTH 条目 28/30/31 用户拍板）', () => {
    const singleCampusRoles = ['sales', 'sales_manager', 'boss', 'marketing', 'finance'] as const;

    singleCampusRoles.forEach((role) => {
      it(`role=${role} 不传 campusScope → 默认 [campusId]`, () => {
        const dto: CreateUserDto = {
          id: ULID32_A,
          tenantId: ULID32_B,
          role,
          campusId: ULID32_C,
        };
        const result = service.createUser(dto);
        expect(result.campusScope).toEqual([ULID32_C]);
        expect(result.role).toBe(role);
      });
    });

    it('sales 显式传 campusScope → 按显式值（运营批量导入场景）', () => {
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
  });

  describe('createUser - 跨校区组 → []（USER-AUTH 条目 30 用户拍板；5/15 A-2 删 sales_director）', () => {
    const crossCampusRoles = ['admin', 'hr'] as const;

    crossCampusRoles.forEach((role) => {
      it(`role=${role} 不传 campusScope → 默认 []（业务层豁免，跨校区管理）`, () => {
        const dto: CreateUserDto = {
          id: ULID32_A,
          tenantId: ULID32_B,
          role,
          campusId: ULID32_C,
        };
        const result = service.createUser(dto);
        expect(result.campusScope).toEqual([]);
      });
    });

    // 5/15 A-2：sales_director 应用层取消（不在拍板权威 9 角色清单）
    it('role=sales_director (5/15 A-2 已删) → BadRequestException（不在 validRoles）', () => {
      const dto = {
        id: ULID32_A,
        tenantId: ULID32_B,
        role: 'sales_director' as never,
        campusId: ULID32_C,
      };
      expect(() => service.createUser(dto)).toThrow(BadRequestException);
    });

    it('admin 显式传 campusScope → 按显式值（特定 admin 限制场景）', () => {
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

  describe('createUser - 单校区组显式覆盖 → 多校区授权（USER-AUTH 条目 31 boss 多校支持）', () => {
    it('boss 显式传多校区 → 按显式值（连锁总校长场景）', () => {
      const dto: CreateUserDto = {
        id: ULID32_A,
        tenantId: ULID32_B,
        role: 'boss',
        campusId: ULID32_C,
        campusScope: [ULID32_C, ULID32_D],
      };
      const result = service.createUser(dto);
      expect(result.campusScope).toEqual([ULID32_C, ULID32_D]);
    });

    it('marketing 显式传多校区 → 按显式值', () => {
      const dto: CreateUserDto = {
        id: ULID32_A,
        tenantId: ULID32_B,
        role: 'marketing',
        campusId: ULID32_C,
        campusScope: [ULID32_C, ULID32_D],
      };
      const result = service.createUser(dto);
      expect(result.campusScope).toEqual([ULID32_C, ULID32_D]);
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

    it('role 非 8 枚举（V2 schema CHECK）→ BadRequestException', () => {
      const dto = {
        id: ULID32_A,
        tenantId: ULID32_B,
        role: 'unknown' as any,
        campusId: ULID32_C,
      };
      expect(() => service.createUser(dto)).toThrow(BadRequestException);
    });

    it('role=teacher（已移出 users 表，走 teachers 表）→ BadRequestException', () => {
      const dto = {
        id: ULID32_A,
        tenantId: ULID32_B,
        role: 'teacher' as any,
        campusId: ULID32_C,
      };
      expect(() => service.createUser(dto)).toThrow(BadRequestException);
    });

    it('role=manager（已删，DB 实际为 sales_manager）→ BadRequestException', () => {
      const dto = {
        id: ULID32_A,
        tenantId: ULID32_B,
        role: 'manager' as any,
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
