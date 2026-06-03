import { Injectable, BadRequestException, Logger, Optional, NotFoundException } from '@nestjs/common';
import { LessonFeedbackRepository } from '../db/lesson-feedback.repository';
import { CourseConsumptionRepository } from '../db/course-consumption.repository';

/**
 * LessonFeedbackService — V9 教学反馈 BE-V9-1
 *
 * 来源：
 *   - 《PD设计稿-排课-教学反馈-家长订阅-V1-2026-05-02.md》§4
 *   - PD 硬规则 P6（24h 必填）+ 配套课消锁定
 */
export type AttendanceForFeedback = '出勤' | '迟到' | '缺席' | '请假';
export type ClassroomPerformance = '优秀' | '良好' | '合格' | '需努力' | '需关注';

export type HomeworkDifficulty = 'basic' | 'medium' | 'hard';

export interface LessonFeedback {
  id: string;
  scheduleId: string;
  studentId: string;
  teacherId: string;
  attendanceStatus: AttendanceForFeedback;
  classroomPerformance: ClassroomPerformance;
  knowledgePoints?: ReadonlyArray<{ name: string; mastery: ClassroomPerformance }>;
  homework?: string;
  homeworkAttachments?: ReadonlyArray<{ url: string; type: string; filename: string }>;
  teacherNote?: string;
  teacherInternalNote?: string;
  // V18 5 fields（pages/b/feedback/new 前端已记录，V18 后端持久化）
  knowledgeMatrix?: ReadonlyArray<{ name: string; mastery: string }>;
  dimRatings?: { focus?: number; engage?: number; think?: number; homework?: number };
  homeworkDeadline?: Date;
  homeworkDifficulty?: HomeworkDifficulty;
  nextPreview?: string;
  // V68 (SSOT §3.-2 2026-06-03) 反馈级图片附件（家长可见，与 teacherInternalNote 相反）。
  //   shape 复用 homework_submission attachments（type 固定 'image'，filename 选填）。
  //   读出参默认 []（repo.mapRow 保证）。
  feedbackAttachments?: ReadonlyArray<{ url: string; type: 'image'; filename?: string }>;
  parentReadAt?: Date;
  submittedAt: Date;
  updatedAt: Date;
}

/**
 * 2026-05-31 字段级安全补充（SSOT §5.1）：
 *   lesson_feedback.teacher_internal_note（老师内部备注）= 老师线内部字段，
 *   仅 teacher / academic / academic_admin / boss / admin 可见；
 *   sales / sales_manager / parent 不可见。
 *
 *   销售对反馈是「读家长可见内容」只读不下载，不含老师内部备注；
 *   家长走 C 端外部报（parent JWT → role='parent'，不在白名单 → 剥离）。
 *
 *   实现策略（仿 common/role-field-filter maskContract）：repo 仍返全字段（单源），
 *   service 按 caller role mask（findInDb / listByStudentInDb），不改 SELECT。
 *   红线：不删 key，只 set null（前端依旧拿到结构化对象，类型不变）。
 */
const TEACHER_INTERNAL_NOTE_VISIBLE_ROLES: ReadonlySet<string> = new Set([
  'teacher',
  'academic',
  'academic_admin',
  'boss',
  'admin',
]);

/**
 * V68 (SSOT §3.-2 2026-06-03)：反馈级图片附件上限（聊天记录截图为主，对齐前端 chooseMessageFile count）。
 */
const FEEDBACK_ATTACHMENT_MAX = 9;

/**
 * V68 反馈附件 url 白名单校验。
 *
 * 契约（SSOT §3.-2）：url 须为 https，或本机 OSS（UploadController nginp 自建方案，
 *   UPLOAD_PUBLIC_BASE 默认 `http://1.14.127.67/uploads`，备案后切 `https://minxin.top`）。
 *   非法项**静默丢弃不抛错**（与前端 imgSecCheck fail-open 一致；不让一张坏图阻断整次反馈提交）。
 *
 * 防 url 注入：用 WHATWG URL 解析（拒 javascript:/data:/file: 等伪协议、空白、相对路径），
 *   只放行 https 任意 host，或 http 但 host 命中本机 OSS allow-list。
 */
const FEEDBACK_OSS_HTTP_HOSTS: ReadonlySet<string> = new Set([
  '1.14.127.67',
  'minxin.top',
  'www.minxin.top',
]);

function isAllowedFeedbackAttachmentUrl(url: unknown): boolean {
  if (typeof url !== 'string' || url.length === 0 || url.length > 2048) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false; // 非法 / 相对 / 伪协议（javascript: data: 等会 throw 或被下面协议过滤）
  }
  if (parsed.protocol === 'https:') return true;
  // http 仅放行本机自建 OSS host（备案前过渡；备案后前端切 https，此分支自然不命中）
  if (parsed.protocol === 'http:') {
    return FEEDBACK_OSS_HTTP_HOSTS.has(parsed.hostname.toLowerCase());
  }
  return false;
}

/**
 * V68 反馈附件清洗：数组 → 合法项数组（≤9），每项 normalize 成 { url, type:'image', filename? }。
 *   - 非数组 / 缺省 → []
 *   - 每项 url 不合法（非 https / 非本机 OSS / 伪协议 / 非 string）→ 静默丢弃
 *   - type 强制 'image'（本批仅图片，SSOT §3.-2；非图片文件无内容审核接口，合规风险，不做）
 *   - filename 选填，仅当为 string 时保留（去掉非法类型）
 *   - 超过 9 张 → 取前 9（截断不报错）
 */
function sanitizeFeedbackAttachments(
  input: unknown,
): Array<{ url: string; type: 'image'; filename?: string }> {
  if (!Array.isArray(input)) return [];
  const out: Array<{ url: string; type: 'image'; filename?: string }> = [];
  for (const item of input) {
    if (out.length >= FEEDBACK_ATTACHMENT_MAX) break;
    if (!item || typeof item !== 'object') continue;
    const url = (item as { url?: unknown }).url;
    if (!isAllowedFeedbackAttachmentUrl(url)) continue; // 非法整项丢弃
    const filename = (item as { filename?: unknown }).filename;
    const normalized: { url: string; type: 'image'; filename?: string } = {
      url: url as string,
      type: 'image',
    };
    if (typeof filename === 'string' && filename.length > 0) {
      normalized.filename = filename.slice(0, 256);
    }
    out.push(normalized);
  }
  return out;
}

@Injectable()
export class LessonFeedbackService {
  private readonly logger = new Logger(LessonFeedbackService.name);

  /**
   * 2026-05-31 SSOT §5.1：按 caller role 剥离 teacherInternalNote。
   *
   * - role ∈ 白名单（teacher/academic/academic_admin/boss/admin）→ 原样返（含明文备注）
   * - role ∉ 白名单（sales/sales_manager/parent/marketing/finance/hr/unknown/undefined）→ teacherInternalNote=null
   *
   * 其余字段一律不动（teacherNote 家长可见备注等照常返）。
   * undefined role（理论上不该发生 — 端点都有 RbacGuard/parent middleware 注入）→ 保守剥离。
   *
   * ⚠️ V68 (SSOT §3.-2 2026-06-03) 不变量：feedbackAttachments = **反馈级图片附件，家长可见**，
   *   与 teacherInternalNote **语义相反** → **对所有 role 都保留不剥离**（含 parent / sales）。
   *   本函数只 set teacherInternalNote=null，feedbackAttachments 经 `...fb` 原样透传 →
   *   勿在此为任何 role 删/置空 feedbackAttachments（家长 C 端要看缩略图 + previewImage）。
   *
   * @param fb 反馈对象（可含 findInDb 扩展的 studentName/teacherName/subject meta）
   * @param role caller 的 req.user?.role
   */
  private maskFeedbackForRole<
    T extends { teacherInternalNote?: string | null | undefined },
  >(fb: T, role: string | undefined | null): T {
    if (role && TEACHER_INTERNAL_NOTE_VISIBLE_ROLES.has(role)) {
      return fb;
    }
    // 非白名单（含 sales / sales_manager / parent）→ 剥离老师内部备注。
    //   feedbackAttachments 经 `...fb` 保留（家长可见，V68 不变量，勿删）。
    return { ...fb, teacherInternalNote: null };
  }

  constructor(
    @Optional() private readonly repo?: LessonFeedbackRepository,
    // P1 S3 (2026-05-21)：feedback 提交合并 consumption confirm
    //   @Optional：纯逻辑 spec 用 `new LessonFeedbackService()` 不传 repo，不影响内存版
    //   submitInDb 内部 try-catch 包裹 confirm，fail-open 不阻塞主反馈写入
    @Optional() private readonly consumptionRepo?: CourseConsumptionRepository,
  ) {}

  /**
   * 老师提交反馈（schedule.completed 后 24h 内有效）
   *
   * @throws BadRequestException 输入校验失败 / 已存在
   */
  submit(input: {
    id: string;
    scheduleId: string;
    studentId: string;
    teacherId: string;
    attendanceStatus: AttendanceForFeedback;
    classroomPerformance: ClassroomPerformance;
    knowledgePoints?: ReadonlyArray<{ name: string; mastery: ClassroomPerformance }>;
    homework?: string;
    homeworkAttachments?: ReadonlyArray<{ url: string; type: string; filename: string }>;
    teacherNote?: string;
    teacherInternalNote?: string;
    // V18 5 fields
    knowledgeMatrix?: ReadonlyArray<{ name: string; mastery: string }>;
    dimRatings?: { focus?: number; engage?: number; think?: number; homework?: number };
    homeworkDeadline?: Date;
    homeworkDifficulty?: HomeworkDifficulty;
    nextPreview?: string;
    // V68 (SSOT §3.-2 2026-06-03) 反馈级图片附件（家长可见）；非法项静默丢弃，缺省 []
    feedbackAttachments?: ReadonlyArray<{ url: string; type: 'image'; filename?: string }>;
  }): LessonFeedback {
    if (!input.id || input.id.length !== 32) {
      throw new BadRequestException('feedback id must be 32-char ULID');
    }
    if (!input.scheduleId || input.scheduleId.length !== 32) {
      throw new BadRequestException('scheduleId must be 32-char ULID');
    }
    if (!input.studentId || input.studentId.length !== 32) {
      throw new BadRequestException('studentId must be 32-char ULID');
    }
    if (!input.teacherId || input.teacherId.length !== 32) {
      throw new BadRequestException('teacherId must be 32-char ULID');
    }
    if (!['出勤', '迟到', '缺席', '请假'].includes(input.attendanceStatus)) {
      throw new BadRequestException(`attendanceStatus invalid: ${input.attendanceStatus}`);
    }
    if (
      !['优秀', '良好', '合格', '需努力', '需关注'].includes(input.classroomPerformance)
    ) {
      throw new BadRequestException(
        `classroomPerformance invalid: ${input.classroomPerformance}`,
      );
    }
    const now = new Date();
    // V68 (SSOT §3.-2): 清洗反馈附件 — 非法项静默丢弃，缺省 []，上限 9，url 须 https/本机 OSS
    const feedbackAttachments = sanitizeFeedbackAttachments(input.feedbackAttachments);
    this.logger.log(
      `[BE-V9-1] submitFeedback id=${input.id} schedule=${input.scheduleId} ` +
        `student=${input.studentId} attendance=${input.attendanceStatus} ` +
        `performance=${input.classroomPerformance} attachments=${feedbackAttachments.length}`,
    );
    return {
      id: input.id,
      scheduleId: input.scheduleId,
      studentId: input.studentId,
      teacherId: input.teacherId,
      attendanceStatus: input.attendanceStatus,
      classroomPerformance: input.classroomPerformance,
      knowledgePoints: input.knowledgePoints,
      homework: input.homework,
      homeworkAttachments: input.homeworkAttachments,
      teacherNote: input.teacherNote,
      teacherInternalNote: input.teacherInternalNote,
      knowledgeMatrix: input.knowledgeMatrix,
      dimRatings: input.dimRatings,
      homeworkDeadline: input.homeworkDeadline,
      homeworkDifficulty: input.homeworkDifficulty,
      nextPreview: input.nextPreview,
      feedbackAttachments,
      submittedAt: now,
      updatedAt: now,
    };
  }

  /**
   * 老师 24h 内修改反馈
   *
   * @throws BadRequestException 24h 已过
   */
  update(
    feedback: LessonFeedback,
    patch: Partial<{
      attendanceStatus: AttendanceForFeedback;
      classroomPerformance: ClassroomPerformance;
      knowledgePoints: ReadonlyArray<{ name: string; mastery: ClassroomPerformance }>;
      homework: string;
      teacherNote: string;
      teacherInternalNote: string;
      knowledgeMatrix: ReadonlyArray<{ name: string; mastery: string }>;
      dimRatings: { focus?: number; engage?: number; think?: number; homework?: number };
      homeworkDeadline: Date;
      homeworkDifficulty: HomeworkDifficulty;
      nextPreview: string;
    }>,
    now: Date = new Date(),
  ): LessonFeedback {
    const submittedAt = feedback.submittedAt.getTime();
    const ELAPSED_24H = 24 * 60 * 60 * 1000;
    if (now.getTime() - submittedAt > ELAPSED_24H) {
      throw new BadRequestException('feedback can only be modified within 24h of submitted_at');
    }
    return { ...feedback, ...patch, updatedAt: now };
  }

  /**
   * 家长打"已读"
   */
  markParentRead(feedback: LessonFeedback, now: Date = new Date()): LessonFeedback {
    if (feedback.parentReadAt !== undefined) {
      // 重复打勾不报错（幂等）
      return feedback;
    }
    return { ...feedback, parentReadAt: now };
  }

  // ============= 真存盘版 =============

  async submitInDb(
    input: Parameters<LessonFeedbackService['submit']>[0],
    tenantSchema: string,
  ): Promise<LessonFeedback> {
    if (!this.repo) throw new BadRequestException('LessonFeedbackRepository not available');
    const memFeedback = this.submit(input);
    const persisted = await this.repo.insert(tenantSchema, memFeedback);

    // P1 S3 (2026-05-21) — 合并：feedback 提交自动 confirm 同 schedule 下 pending consumption
    //
    // 业务依据：
    //   - 5/20 demo-empty tenant 12 步真生产业务流痛点：
    //     teacher 完课流程需 4 API call（创建 consumption → 写 feedback → admin confirm → cron lock）
    //     UX 不连贯，stats weeklyConsumedYuan 在 admin 介入前为 0
    //   - 拍板：teacher 写反馈 = 已确认上课 = 课消立即 confirmed
    //
    // 5/21 round 2 (security BLOCKER-2 修复)：
    //   旧版 findPendingByScheduleId LIMIT 1 假设 schedule:consumption 1:1
    //   但 V9 schema `UNIQUE (schedule_id, student_id)` 允许多学生小班课 → 多条 consumption
    //   → 改用 findAllPendingByScheduleId 循环 confirm（多学生场景正确语义）
    //   → 每条 confirm 独立 try-catch（一条失败不影响其他学生）
    //
    // 设计原则：
    //   - fail-open：consumption 自动 confirm 失败 → 仅 logger.warn，不阻塞 feedback 主流程
    //   - cron scan-and-lock 兜底（pending_feedback 超 24h → locked 由现有 cron 处理）
    //   - 已 confirmed/locked/cancelled 的 consumption 不重复处理（pending 过滤天然排除）
    //   - audit_log 不在 service 写；controller 层（submitFeedbackInDb）会写 'lesson-feedback.submitted'
    if (this.consumptionRepo) {
      try {
        const pendings = await this.consumptionRepo.findAllPendingByScheduleId(
          tenantSchema,
          input.scheduleId,
        );
        let confirmed = 0;
        for (const c of pendings) {
          try {
            await this.consumptionRepo.confirmByFeedback(tenantSchema, c.id, persisted.id);
            confirmed++;
          } catch (err) {
            this.logger.warn(
              `[S3] auto-confirm consumption ${c.id} failed: ` +
                `${(err as Error).message}`,
            );
          }
        }
        this.logger.log(
          `[S3] auto-confirmed ${confirmed}/${pendings.length} consumptions ` +
            `for schedule ${input.scheduleId} by feedback ${persisted.id}`,
        );
      } catch (err) {
        // fail-open: cron scan-and-lock 兜底，feedback 主流程不受影响
        this.logger.warn(
          `[S3] findAllPending failed for schedule ${input.scheduleId}: ` +
            `${(err as Error).message}`,
        );
      }
    }

    return persisted;
  }

  /**
   * @param callerRole 2026-05-31 SSOT §5.1：caller 的 req.user?.role，
   *   非白名单（含 sales/sales_manager/parent）→ 剥离 teacherInternalNote。
   *   省略时（如 cron / 内部调用）保守剥离（最小可见集）。
   */
  async findInDb(
    id: string,
    tenantSchema: string,
    callerRole?: string,
  ): Promise<LessonFeedback & {
    studentName?: string | null;
    teacherName?: string | null;
    subject?: string | null;
  }> {
    if (!this.repo) throw new BadRequestException('LessonFeedbackRepository not available');
    // 2026-05-22 Wave A: 返扩展 meta (studentName/teacherName/subject) 供 B 端 detail page 直接用
    //   JOIN students + teachers + course_products, 不增加额外 HTTP roundtrip
    const r = await this.repo.findByIdWithMeta(tenantSchema, id);
    if (!r) throw new NotFoundException(`feedback ${id} not found`);
    // 2026-05-31 SSOT §5.1: 按 caller role 剥离 teacherInternalNote（销售/家长不可见明文）
    return this.maskFeedbackForRole(r, callerRole);
  }

  /**
   * @param callerRole 2026-05-31 SSOT §5.1：同 findInDb，list 对每条结果应用 mask。
   */
  async listByStudentInDb(
    studentId: string,
    tenantSchema: string,
    options: { limit?: number; offset?: number } = {},
    callerRole?: string,
  ): Promise<LessonFeedback[]> {
    if (!this.repo) throw new BadRequestException('LessonFeedbackRepository not available');
    const rows = await this.repo.listByStudent(tenantSchema, studentId, options);
    // 2026-05-31 SSOT §5.1: 逐条剥离 teacherInternalNote
    return rows.map((fb) => this.maskFeedbackForRole(fb, callerRole));
  }

  async updateInDb(
    id: string,
    patch: {
      attendanceStatus?: AttendanceForFeedback;
      classroomPerformance?: ClassroomPerformance;
      knowledgePoints?: ReadonlyArray<{ name: string; mastery: ClassroomPerformance }>;
      homework?: string;
      teacherNote?: string;
      teacherInternalNote?: string;
      knowledgeMatrix?: ReadonlyArray<{ name: string; mastery: string }>;
      dimRatings?: { focus?: number; engage?: number; think?: number; homework?: number };
      homeworkDeadline?: Date;
      homeworkDifficulty?: HomeworkDifficulty;
      nextPreview?: string;
    },
    tenantSchema: string,
    now: Date = new Date(),
  ): Promise<LessonFeedback> {
    if (!this.repo) throw new BadRequestException('LessonFeedbackRepository not available');
    const existing = await this.repo.findById(tenantSchema, id);
    if (!existing) throw new NotFoundException(`feedback ${id} not found`);
    // 24h 校验沿用纯逻辑
    this.update(existing, patch, now);
    return this.repo.update(tenantSchema, id, patch);
  }

  async markParentReadInDb(
    id: string,
    tenantSchema: string,
    callerRole?: string,
  ): Promise<LessonFeedback> {
    if (!this.repo) throw new BadRequestException('LessonFeedbackRepository not available');
    const fb = await this.repo.markParentRead(tenantSchema, id);
    // 2026-05-31 安全审残留路径修复：parent-read 返回的反馈也按 caller role 剥离
    //   teacherInternalNote（parent / sales / sales_manager 不可见，SSOT §5.1）。
    return this.maskFeedbackForRole(fb, callerRole);
  }
}
