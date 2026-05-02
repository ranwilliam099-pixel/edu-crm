import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { CreateTeacherDto, TeacherStatus } from './dto/create-teacher.dto';

/**
 * TeacherService — V7 teachers 独立档案 BE-V7-1
 *
 * 来源：
 *   - 《PD设计稿-排课-教学反馈-家长订阅-V1-2026-05-02.md》§2 V7 teachers
 *   - 《全部人员-审核往来总台账.md》条目 29 方向 B（独立 teachers 表）
 *   - 条目 31 #2（teachers.user_id NULLABLE，部分老师纯档案）
 *   - 条目 32 L1（V7 teachers migration + Service）
 *
 * USER-AUTH(2026-05-02): 用户最终拍板「老师 = 独立档案 + user_id NULLABLE」
 *
 * 严守边界：
 *   1. 仅生成内存中的 teacher 对象；不真实 INSERT DB（INT-01 仍挂账）
 *   2. 不引入 ScheduleService 业务逻辑（V8 待开）
 *   3. 跨校区排课资源池豁免不在本 Service（在 V8 ScheduleService）
 */
export interface Teacher {
  id: string;
  campusId: string;
  name: string;
  phone?: string;
  userId?: string;
  subjects: ReadonlyArray<string>;
  bio?: string;
  hourlyRateYuan?: number;
  status: TeacherStatus;
}

@Injectable()
export class TeacherService {
  private readonly logger = new Logger(TeacherService.name);

  /**
   * 创建教师档案（内存对象，不持久化）。
   *
   * @throws BadRequestException 输入校验失败
   */
  createTeacher(dto: CreateTeacherDto): Teacher {
    if (!dto.id || dto.id.length !== 32) {
      throw new BadRequestException('teacher id must be 32-char ULID');
    }
    if (!dto.campusId || dto.campusId.length !== 32) {
      throw new BadRequestException('campusId must be 32-char ULID');
    }
    if (!dto.name || dto.name.trim().length === 0) {
      throw new BadRequestException('name required');
    }
    if (dto.userId !== undefined && dto.userId.length !== 32) {
      throw new BadRequestException('userId (if provided) must be 32-char ULID');
    }
    if (dto.hourlyRateYuan !== undefined && dto.hourlyRateYuan < 0) {
      throw new BadRequestException('hourlyRateYuan must be >= 0');
    }
    if (!dto.operator || dto.operator.length !== 32) {
      throw new BadRequestException('operator must be 32-char ULID');
    }
    const status = dto.status ?? '在职';
    if (!['在职', '请假', '归档'].includes(status)) {
      throw new BadRequestException(`status must be 在职/请假/归档`);
    }

    this.logger.log(
      `[BE-V7-1] createTeacher id=${dto.id} name=${dto.name} ` +
        `userId=${dto.userId ?? 'null(纯档案)'} subjects=${(dto.subjects ?? []).join(',')}`,
    );

    return {
      id: dto.id,
      campusId: dto.campusId,
      name: dto.name,
      phone: dto.phone,
      userId: dto.userId,
      subjects: dto.subjects ?? [],
      bio: dto.bio,
      hourlyRateYuan: dto.hourlyRateYuan,
      status,
    };
  }

  /**
   * 判断教师是否为"纯档案"（无登录账号）— 条目 31 #2
   */
  isPureArchive(teacher: Teacher): boolean {
    return teacher.userId === undefined || teacher.userId === null;
  }

  /**
   * 判断教师是否为"登录账号绑定"（有登录账号）
   */
  hasLoginAccount(teacher: Teacher): boolean {
    return !this.isPureArchive(teacher);
  }

  /**
   * 教师是否可被排课（status='在职' 才可）
   */
  isSchedulable(teacher: Teacher): boolean {
    return teacher.status === '在职';
  }

  /**
   * 应用层过滤：跨校区资源池查询（V8 ScheduleService 调用）
   *
   * USER-AUTH(2026-05-02): 用户原文「A 校区可以给 B 校区的老师排课程」
   * 业务豁免点：返回租户内全部 active 教师，不限 campus_id
   */
  filterSchedulableTeachers(teachers: ReadonlyArray<Teacher>): Teacher[] {
    return teachers.filter((t) => this.isSchedulable(t));
  }

  /**
   * 状态推进：在职 → 请假 → 在职 / 在职 → 归档（终态）
   * @throws BadRequestException 非法转换
   */
  changeStatus(teacher: Teacher, newStatus: TeacherStatus): Teacher {
    const allowed: Record<TeacherStatus, TeacherStatus[]> = {
      在职: ['请假', '归档'],
      请假: ['在职', '归档'],
      归档: [], // 归档为终态
    };
    if (!allowed[teacher.status].includes(newStatus)) {
      throw new BadRequestException(
        `status transition ${teacher.status} → ${newStatus} not allowed`,
      );
    }
    return { ...teacher, status: newStatus };
  }
}
