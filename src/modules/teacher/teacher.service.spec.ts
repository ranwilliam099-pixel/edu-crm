/**
 * TeacherService 单元测试
 *
 * USER-AUTH(2026-05-02 台账条目 29/31/32): 教师独立档案 + user_id NULLABLE
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { TeacherService, Teacher } from './teacher.service';
import { CreateTeacherDto } from './dto/create-teacher.dto';

const ULID32_T1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNT1';
const ULID32_T2 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNT2';
const ULID32_C1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNC1';
const ULID32_C2 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNC2';
const ULID32_U1 = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNU1';
const ULID32_OP = '01HX7Y6P5K9N3M2QABCDEFGHIJKLMNOP';

describe('TeacherService - V7 BE-V7-1 PD §2 + 用户拍板条目 29/31', () => {
  let service: TeacherService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TeacherService],
    }).compile();
    service = module.get<TeacherService>(TeacherService);
  });

  describe('createTeacher - 创建合法', () => {
    it('全职老师（有 user_id）→ 合法', () => {
      // Day 2 Phase C X1 (2026-05-19 D1.4 拍板): hourlyPriceYuan 字段物理删除
      //   不再传入 / 不再返回 — 老师页面零财务字段
      const dto: CreateTeacherDto = {
        id: ULID32_T1,
        campusId: ULID32_C1,
        name: '王老师',
        phone: '13800001111',
        userId: ULID32_U1,
        subjects: ['数学', '物理'],
        operator: ULID32_OP,
      };
      const teacher = service.createTeacher(dto);
      expect(teacher.id).toBe(ULID32_T1);
      expect(teacher.userId).toBe(ULID32_U1);
      expect(service.hasLoginAccount(teacher)).toBe(true);
      expect(service.isPureArchive(teacher)).toBe(false);
      // 验证 X1 拍板：返回对象不含 hourlyPriceYuan（防回归）
      expect((teacher as Teacher & { hourlyPriceYuan?: number }).hourlyPriceYuan).toBeUndefined();
    });

    it('纯档案老师（无 user_id）→ 合法（条目 31 #2）', () => {
      const dto: CreateTeacherDto = {
        id: ULID32_T1,
        campusId: ULID32_C1,
        name: '李老师（兼职）',
        subjects: ['英语'],
        operator: ULID32_OP,
      };
      const teacher = service.createTeacher(dto);
      expect(teacher.userId).toBeUndefined();
      expect(service.isPureArchive(teacher)).toBe(true);
      expect(service.hasLoginAccount(teacher)).toBe(false);
    });

    it('subjects 默认空数组', () => {
      const dto: CreateTeacherDto = {
        id: ULID32_T1,
        campusId: ULID32_C1,
        name: '测试老师',
        operator: ULID32_OP,
      };
      const teacher = service.createTeacher(dto);
      expect(teacher.subjects).toEqual([]);
    });

    it('status 默认 在职', () => {
      const dto: CreateTeacherDto = {
        id: ULID32_T1,
        campusId: ULID32_C1,
        name: '测试老师',
        operator: ULID32_OP,
      };
      const teacher = service.createTeacher(dto);
      expect(teacher.status).toBe('在职');
    });
  });

  describe('createTeacher - 输入校验', () => {
    const baseDto: CreateTeacherDto = {
      id: ULID32_T1,
      campusId: ULID32_C1,
      name: '王老师',
      operator: ULID32_OP,
    };

    it('id 长度非 32 → BadRequestException', () => {
      expect(() => service.createTeacher({ ...baseDto, id: 'short' })).toThrow(
        BadRequestException,
      );
    });

    it('campusId 长度非 32 → BadRequestException', () => {
      expect(() =>
        service.createTeacher({ ...baseDto, campusId: 'short' }),
      ).toThrow(BadRequestException);
    });

    it('name 为空 → BadRequestException', () => {
      expect(() => service.createTeacher({ ...baseDto, name: '' })).toThrow(
        BadRequestException,
      );
    });

    it('userId 长度非 32（提供时）→ BadRequestException', () => {
      expect(() =>
        service.createTeacher({ ...baseDto, userId: 'short' }),
      ).toThrow(BadRequestException);
    });

    // Day 2 Phase C X1 (2026-05-19 D1.4 拍板): hourlyPriceYuan 字段物理删除
    //   原 test「hourlyPriceYuan 负数 → BadRequestException」已不适用（字段不存在）
    //   X1 拍板「老师页面零财务字段」— V50 DROP COLUMN teachers.hourly_price_yuan
    //   课时单价从 contract.coursePrice / lessonHours 派生
    it('TypeScript 类型守门：传 hourlyPriceYuan 会被 DTO interface 拒绝（编译期）', () => {
      // 运行时校验：即便强转绕过 TS（旧调用方），service 不再校验 / 不再返回该字段
      const result = service.createTeacher({
        ...baseDto,
        // 通过 cast 绕开 TS interface 模拟旧调用方
        hourlyPriceYuan: -10,
      } as unknown as CreateTeacherDto);
      // service 不再 throw（字段已移出 interface） + 返回对象不含此字段
      expect((result as Teacher & { hourlyPriceYuan?: number }).hourlyPriceYuan).toBeUndefined();
    });

    it('未知 status → BadRequestException', () => {
      expect(() =>
        service.createTeacher({ ...baseDto, status: 'unknown' as any }),
      ).toThrow(BadRequestException);
    });

    it('operator 长度非 32 → BadRequestException', () => {
      expect(() =>
        service.createTeacher({ ...baseDto, operator: 'short' }),
      ).toThrow(BadRequestException);
    });
  });

  describe('isSchedulable - 仅在职可排课', () => {
    const baseTeacher: Teacher = {
      id: ULID32_T1,
      campusId: ULID32_C1,
      name: '王老师',
      subjects: [],
      status: '在职',
    };

    it('在职 → true', () => {
      expect(service.isSchedulable(baseTeacher)).toBe(true);
    });

    it('请假 → false', () => {
      expect(service.isSchedulable({ ...baseTeacher, status: '请假' })).toBe(
        false,
      );
    });

    it('归档 → false', () => {
      expect(service.isSchedulable({ ...baseTeacher, status: '归档' })).toBe(
        false,
      );
    });
  });

  describe('filterSchedulableTeachers - 跨校区资源池豁免（条目 29 排课语义）', () => {
    it('返回全部 active 教师，不限 campus_id', () => {
      const teachers: Teacher[] = [
        { id: ULID32_T1, campusId: ULID32_C1, name: 'A', subjects: [], status: '在职' },
        { id: ULID32_T2, campusId: ULID32_C2, name: 'B', subjects: [], status: '在职' },
      ];
      const result = service.filterSchedulableTeachers(teachers);
      expect(result).toHaveLength(2);
      // 验证跨 campus_id 都返回（用户原文「A 校区可以给 B 校区的老师排课程」）
      expect(result.map((t) => t.campusId).sort()).toEqual(
        [ULID32_C1, ULID32_C2].sort(),
      );
    });

    it('归档的老师被排除', () => {
      const teachers: Teacher[] = [
        { id: ULID32_T1, campusId: ULID32_C1, name: 'A', subjects: [], status: '在职' },
        { id: ULID32_T2, campusId: ULID32_C2, name: 'B', subjects: [], status: '归档' },
      ];
      const result = service.filterSchedulableTeachers(teachers);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('A');
    });
  });

  describe('changeStatus - 状态机', () => {
    const base: Teacher = {
      id: ULID32_T1,
      campusId: ULID32_C1,
      name: 'X',
      subjects: [],
      status: '在职',
    };

    it('在职 → 请假 合法', () => {
      const result = service.changeStatus(base, '请假');
      expect(result.status).toBe('请假');
    });

    it('在职 → 归档 合法', () => {
      const result = service.changeStatus(base, '归档');
      expect(result.status).toBe('归档');
    });

    it('请假 → 在职 合法', () => {
      const result = service.changeStatus({ ...base, status: '请假' }, '在职');
      expect(result.status).toBe('在职');
    });

    it('归档 → 在职 → BadRequestException（终态）', () => {
      expect(() =>
        service.changeStatus({ ...base, status: '归档' }, '在职'),
      ).toThrow(BadRequestException);
    });

    it('归档 → 请假 → BadRequestException', () => {
      expect(() =>
        service.changeStatus({ ...base, status: '归档' }, '请假'),
      ).toThrow(BadRequestException);
    });
  });
});
