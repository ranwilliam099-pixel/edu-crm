/**
 * LessonFeedbackCreateDto — POST /api/db/lesson-feedbacks
 *
 * 抽自 feedback.controller.ts L298-318 `submitFeedbackInDb` @Body interface
 * 5/19 Phase B.L3 contract tests SSOT
 *
 * 业务语义（V9 教学反馈）：
 *   - 老师 24h 内提交课后反馈
 *   - 反馈 confirm → 课消正式扣除
 *   - V18 5 字段扩展：knowledgeMatrix / dimRatings / homeworkDeadline / homeworkDifficulty / nextPreview
 *
 * RBAC: teacher / admin / boss（不含 academic、parent）
 *
 * 必填：tenantSchema / id / scheduleId / studentId / teacherId / attendanceStatus / classroomPerformance
 */
export type AttendanceForFeedback =
  | '出勤'
  | '请假'
  | '迟到'
  | '早退'
  | '旷课';

export type ClassroomPerformance =
  | '优秀'
  | '良好'
  | '一般'
  | '待改进';

export type HomeworkDifficulty = '简单' | '中等' | '困难';

export interface LessonFeedbackKnowledgePoint {
  name: string;
  mastery: ClassroomPerformance;
}

export interface LessonFeedbackHomeworkAttachment {
  url: string;
  type: string;
  filename: string;
}

export interface LessonFeedbackKnowledgeMatrix {
  name: string;
  mastery: string;
}

export interface LessonFeedbackDimRatings {
  focus?: number;
  engage?: number;
  think?: number;
  homework?: number;
}

export interface LessonFeedbackCreateDto {
  /** 多租户 schema（TenantScopeGuard 校验） */
  tenantSchema: string;
  /** 32-char ULID（前端生成） */
  id: string;
  /** 32-char ULID（schedule.id） */
  scheduleId: string;
  /** 32-char ULID（student.id） */
  studentId: string;
  /** 32-char ULID（teacher.id） */
  teacherId: string;
  /** 考勤状态（必填） */
  attendanceStatus: AttendanceForFeedback;
  /** 课堂表现（必填） */
  classroomPerformance: ClassroomPerformance;
  /** 知识点掌握列表 */
  knowledgePoints?: LessonFeedbackKnowledgePoint[];
  /** 课后作业描述 */
  homework?: string;
  /** 作业附件列表 */
  homeworkAttachments?: LessonFeedbackHomeworkAttachment[];
  /** 老师对外笔记（家长可读） */
  teacherNote?: string;
  /** 老师内部笔记（仅老师/admin 可读） */
  teacherInternalNote?: string;
  /** V18 知识矩阵（与 knowledgePoints 不同维度） */
  knowledgeMatrix?: LessonFeedbackKnowledgeMatrix[];
  /** V18 四维评分（0-5） */
  dimRatings?: LessonFeedbackDimRatings;
  /** V18 作业截止时间（毫秒时间戳，controller 内转 Date） */
  homeworkDeadlineMs?: number;
  /** V18 作业难度 */
  homeworkDifficulty?: HomeworkDifficulty;
  /** V18 下节预告 */
  nextPreview?: string;
}
