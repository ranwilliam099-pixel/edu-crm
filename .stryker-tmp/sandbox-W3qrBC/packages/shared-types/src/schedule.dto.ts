/**
 * ScheduleCreateDto — POST /api/schedules + POST /api/schedules/db
 *
 * 抽自 schedule.controller.ts L107-118 / L333-341 + schedule.service.ts L78-97 CreateScheduleInput
 * 5/19 Phase B.L3 contract tests SSOT
 *
 * 业务语义（V8 排课核心 / Wave 11 拍板修复）：
 *   - 教务唯一创建（callerRole === 'academic'，admin/boss/sales/teacher 403）
 *   - body 自报的 callerRole / currentUser / schedulableTeachers / studentResponsibleSalesPairs
 *     全部由 controller 从 JWT 派生覆盖（B.4-1 round 2 A04 修复）
 *
 * 双轨：
 *   - 内存版 POST /api/schedules：调用方传 existingSchedules + existingStudentsAttachment（应用层冲突）
 *   - 真存盘版 POST /api/schedules/db：service 内查 PG 冲突（无需 existingSchedules）
 *
 * 必填：tenantSchema / input.id / input.teacherId / input.studentIds / input.startAt / input.durationMin
 *
 * 可选：input.courseProductId / input.classType / input.maxStudents / input.notes / input.source / input.recurringScheduleId
 */
export type ScheduleSource = 'one_off' | 'recurring' | 'makeup';

export interface ScheduleCreateInputDto {
  /** 32-char ULID（前端生成） */
  id: string;
  /** 32-char ULID（teacher.id） */
  teacherId: string;
  /** 32-char ULID 数组（student.id），长度 ≥ 1 */
  studentIds: ReadonlyArray<string>;
  /** ISO 8601 开始时间（JSON 传 string，controller 反序列化为 Date） */
  startAt: string;
  /** 时长分钟 ∈ [15, 240] */
  durationMin: number;
  /** 课程包 ID（可选） */
  courseProductId?: string;
  /** 排课备注 */
  notes?: string;
  /**
   * 班型（V32：1v1 / 小组课 / 大班）
   * 与 input.maxStudents 一起 service 兜底校验 studentIds.length ≤ maxStudents
   */
  classType?: string;
  /** 老师自填最多人数（柔性 — service 兜底校验 ≤ maxStudents） */
  maxStudents?: number;
  /**
   * @deprecated B.4-1 round 2 server-derive：controller 强制覆盖 'academic'
   * body 自报字段被忽略；保留接口字段仅向后兼容
   */
  callerRole?: string;
  /**
   * @deprecated B.4-1 round 2 server-derive：controller 强制覆盖 {id, role, tenantId} from JWT
   * body 自报字段被忽略；保留接口字段仅向后兼容
   */
  currentUser?: {
    id: string;
    role: string;
    tenantId: string;
  };
  /** 排课来源，默认 'one_off' */
  source?: ScheduleSource;
  /** 周期排课的父 ID（recurring_schedule.id） */
  recurringScheduleId?: string;
}

export interface ScheduleCreateDto {
  /** 多租户 schema（TenantScopeGuard 校验） */
  tenantSchema: string;
  /** 排课主输入 */
  input: ScheduleCreateInputDto;
  /**
   * 内存版必填：已有非 cancelled 排课列表（冲突检测）
   * 真存盘版 POST /api/schedules/db 不传（service 查 PG）
   */
  existingSchedules?: ReadonlyArray<unknown>;
  /**
   * 内存版必填：已有 schedule_students 学员附着列表（冲突检测）
   * 真存盘版不传
   */
  existingStudentsAttachment?: ReadonlyArray<unknown>;
  /**
   * @deprecated Wave 11 起 server 派生（教务无 ownership 校验，传空 Map）
   * body 自报字段被忽略；保留接口字段仅向后兼容
   */
  studentResponsibleSalesPairs?: Array<[string, string]>;
  /**
   * @deprecated Wave 11 起 server 派生（按 academic.campus_id 过滤本校 active 老师列表）
   * body 自报字段被忽略；保留接口字段仅向后兼容
   */
  schedulableTeachers?: Array<{ id: string; userId?: string }>;
}
