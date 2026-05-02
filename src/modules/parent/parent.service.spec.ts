/**
 * ParentService 单元测试
 *
 * USER-AUTH(2026-05-02 台账条目 31 #3 + 条目 32 L3): 家长身份 + 单孩最多 3 家长
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { ParentService, ParentStudentBinding, Relationship } from './parent.service';

const ULID32_P1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMP01';
const ULID32_P2 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMP02';
const ULID32_P3 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMP03';
const ULID32_P4 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMP04';
const ULID32_S1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMST1';
const ULID32_S2 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMST2';
const ULID32_T1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMTN1';
const ULID32_B1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMBN1';
const ULID32_B2 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMBN2';
const ULID32_B3 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMBN3';
const ULID32_B4 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMBN4';

describe('ParentService - V10 BE-V10-1 PD §5 + 用户拍板条目 31/32', () => {
  let service: ParentService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ParentService],
    }).compile();
    service = module.get<ParentService>(ParentService);
  });

  describe('registerParent - 家长注册', () => {
    it('合法注册 → 返回 active 家长', () => {
      const parent = service.registerParent({
        id: ULID32_P1,
        phone: '13800001111',
        wechatOpenid: 'oWxXX',
        name: '王女士',
      });
      expect(parent.id).toBe(ULID32_P1);
      expect(parent.status).toBe('active');
    });

    it('id 长度非 32 → BadRequestException', () => {
      expect(() => service.registerParent({ id: 'short', phone: '13800001111' })).toThrow(
        BadRequestException,
      );
    });

    it('phone 非 11 位中国手机号 → BadRequestException', () => {
      expect(() =>
        service.registerParent({ id: ULID32_P1, phone: '12000001111' }),
      ).toThrow(BadRequestException);
      expect(() =>
        service.registerParent({ id: ULID32_P1, phone: '1380000111' }),
      ).toThrow(BadRequestException);
    });
  });

  describe('createBinding - 家长-学员绑定', () => {
    it('首次绑定（0 → 1）合法', () => {
      const binding = service.createBinding(
        {
          id: ULID32_B1,
          parentId: ULID32_P1,
          studentId: ULID32_S1,
          tenantId: ULID32_T1,
          relationship: 'mother',
        },
        [],
      );
      expect(binding.bindingStatus).toBe('active');
      expect(binding.relationship).toBe('mother');
    });

    it('单孩绑第 4 个家长 → ConflictException(STUDENT_MAX_3_PARENTS_EXCEEDED)（P8）', () => {
      const existing: ParentStudentBinding[] = [
        {
          id: ULID32_B1,
          parentId: ULID32_P1,
          studentId: ULID32_S1,
          tenantId: ULID32_T1,
          isPrimary: true,
          relationship: 'mother',
          bindingStatus: 'active',
          boundAt: new Date(),
        },
        {
          id: ULID32_B2,
          parentId: ULID32_P2,
          studentId: ULID32_S1,
          tenantId: ULID32_T1,
          isPrimary: false,
          relationship: 'father',
          bindingStatus: 'active',
          boundAt: new Date(),
        },
        {
          id: ULID32_B3,
          parentId: ULID32_P3,
          studentId: ULID32_S1,
          tenantId: ULID32_T1,
          isPrimary: false,
          relationship: 'grandmother',
          bindingStatus: 'active',
          boundAt: new Date(),
        },
      ];
      expect(() =>
        service.createBinding(
          {
            id: ULID32_B4,
            parentId: ULID32_P4,
            studentId: ULID32_S1,
            tenantId: ULID32_T1,
            relationship: 'guardian',
          },
          existing,
        ),
      ).toThrow(ConflictException);
    });

    it('解绑后再绑第 3 个 → 通过（计数仅 active）', () => {
      const existing: ParentStudentBinding[] = [
        {
          id: ULID32_B1,
          parentId: ULID32_P1,
          studentId: ULID32_S1,
          tenantId: ULID32_T1,
          isPrimary: true,
          relationship: 'mother',
          bindingStatus: 'unbound', // 已解绑
          boundAt: new Date(),
          unboundAt: new Date(),
        },
        {
          id: ULID32_B2,
          parentId: ULID32_P2,
          studentId: ULID32_S1,
          tenantId: ULID32_T1,
          isPrimary: false,
          relationship: 'father',
          bindingStatus: 'active',
          boundAt: new Date(),
        },
        {
          id: ULID32_B3,
          parentId: ULID32_P3,
          studentId: ULID32_S1,
          tenantId: ULID32_T1,
          isPrimary: false,
          relationship: 'grandfather',
          bindingStatus: 'active',
          boundAt: new Date(),
        },
      ];
      // 第 3 个 active 绑定（前面只有 2 个 active）→ 应该通过
      const binding = service.createBinding(
        {
          id: ULID32_B4,
          parentId: ULID32_P4,
          studentId: ULID32_S1,
          tenantId: ULID32_T1,
          relationship: 'grandmother',
        },
        existing,
      );
      expect(binding.bindingStatus).toBe('active');
    });

    it('同一家长重复绑同一孩子 → ConflictException(PARENT_ALREADY_BOUND_TO_STUDENT)', () => {
      const existing: ParentStudentBinding[] = [
        {
          id: ULID32_B1,
          parentId: ULID32_P1,
          studentId: ULID32_S1,
          tenantId: ULID32_T1,
          isPrimary: true,
          relationship: 'mother',
          bindingStatus: 'active',
          boundAt: new Date(),
        },
      ];
      expect(() =>
        service.createBinding(
          {
            id: ULID32_B2,
            parentId: ULID32_P1,
            studentId: ULID32_S1,
            tenantId: ULID32_T1,
            relationship: 'mother',
          },
          existing,
        ),
      ).toThrow(ConflictException);
    });

    it('未知 relationship → BadRequestException', () => {
      expect(() =>
        service.createBinding(
          {
            id: ULID32_B1,
            parentId: ULID32_P1,
            studentId: ULID32_S1,
            tenantId: ULID32_T1,
            relationship: 'unknown' as Relationship,
          },
          [],
        ),
      ).toThrow(BadRequestException);
    });
  });

  describe('unbindStudent - 解绑（条目 32 #10：保留绑定行）', () => {
    it('active 绑定解绑 → bindingStatus=unbound + unboundAt 标记', () => {
      const binding: ParentStudentBinding = {
        id: ULID32_B1,
        parentId: ULID32_P1,
        studentId: ULID32_S1,
        tenantId: ULID32_T1,
        isPrimary: true,
        relationship: 'mother',
        bindingStatus: 'active',
        boundAt: new Date(),
      };
      const result = service.unbindStudent(binding);
      expect(result.bindingStatus).toBe('unbound');
      expect(result.unboundAt).toBeDefined();
    });

    it('已 unbound 再解绑 → BadRequestException', () => {
      const binding: ParentStudentBinding = {
        id: ULID32_B1,
        parentId: ULID32_P1,
        studentId: ULID32_S1,
        tenantId: ULID32_T1,
        isPrimary: true,
        relationship: 'mother',
        bindingStatus: 'unbound',
        boundAt: new Date(),
        unboundAt: new Date(),
      };
      expect(() => service.unbindStudent(binding)).toThrow(BadRequestException);
    });
  });

  describe('listMyChildren - 跨机构共享（条目 31 #3）', () => {
    it('返回家长所有 active 绑定的孩子（含跨机构）', () => {
      const bindings: ParentStudentBinding[] = [
        {
          id: ULID32_B1,
          parentId: ULID32_P1,
          studentId: ULID32_S1,
          tenantId: ULID32_T1,
          isPrimary: true,
          relationship: 'mother',
          bindingStatus: 'active',
          boundAt: new Date(),
        },
        {
          id: ULID32_B2,
          parentId: ULID32_P1,
          studentId: ULID32_S2,
          tenantId: '01HX7Y6P5K9N3M2QABCDEFGHIJKLMTN2', // 不同租户
          isPrimary: false,
          relationship: 'mother',
          bindingStatus: 'active',
          boundAt: new Date(),
        },
        {
          id: ULID32_B3,
          parentId: ULID32_P2, // 不同家长
          studentId: ULID32_S1,
          tenantId: ULID32_T1,
          isPrimary: false,
          relationship: 'father',
          bindingStatus: 'active',
          boundAt: new Date(),
        },
      ];
      const result = service.listMyChildren(ULID32_P1, bindings);
      expect(result).toHaveLength(2); // 跨租户共享 1 笔订阅，看 2 个孩子
      expect(result.map((b) => b.studentId).sort()).toEqual(
        [ULID32_S1, ULID32_S2].sort(),
      );
    });

    it('已 unbound 的不算', () => {
      const bindings: ParentStudentBinding[] = [
        {
          id: ULID32_B1,
          parentId: ULID32_P1,
          studentId: ULID32_S1,
          tenantId: ULID32_T1,
          isPrimary: true,
          relationship: 'mother',
          bindingStatus: 'unbound',
          boundAt: new Date(),
        },
      ];
      expect(service.listMyChildren(ULID32_P1, bindings)).toHaveLength(0);
    });
  });

  describe('countActiveParentsForStudent', () => {
    it('正确计数 active', () => {
      const bindings: ParentStudentBinding[] = [
        {
          id: ULID32_B1,
          parentId: ULID32_P1,
          studentId: ULID32_S1,
          tenantId: ULID32_T1,
          isPrimary: true,
          relationship: 'mother',
          bindingStatus: 'active',
          boundAt: new Date(),
        },
        {
          id: ULID32_B2,
          parentId: ULID32_P2,
          studentId: ULID32_S1,
          tenantId: ULID32_T1,
          isPrimary: false,
          relationship: 'father',
          bindingStatus: 'active',
          boundAt: new Date(),
        },
        {
          id: ULID32_B3,
          parentId: ULID32_P3,
          studentId: ULID32_S1,
          tenantId: ULID32_T1,
          isPrimary: false,
          relationship: 'grandmother',
          bindingStatus: 'unbound', // 不算
          boundAt: new Date(),
        },
      ];
      expect(service.countActiveParentsForStudent(ULID32_S1, bindings)).toBe(2);
    });
  });
});
