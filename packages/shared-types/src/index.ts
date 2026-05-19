/**
 * @edu/shared-types — Phase B.L3 contract source-of-truth
 *
 * 5/19 v2.0 严谨测试方案 §3.L3 — DTO 单一源
 *
 * 用法：
 *   - 后端 controller：`import { CustomerCreateDto } from '@edu/shared-types';`
 *     `async createSelfBuilt(@Body() body: CustomerCreateDto, @Req() req: ...) {}`
 *   - CI：`pnpm openapi:gen` 跑 nest start CI 模式 emit dist/openapi.json
 *   - 前端：sync-deploy.sh 把 dist/openapi.json copy 到 miniprogram/utils/openapi-schema.json
 *     api.postDb interceptor 加载该 schema 做 required 字段 + 类型校验
 *
 * Day 2 仅 5 个核心 DTO（customer / contract / schedule / lesson-feedback / invoice）
 * 剩余 33 module DTO 渐进补 Day 3-4
 */

export type {
  CustomerCreateDto,
} from './customer.dto';

export type {
  ContractCreateDto,
  ContractOrderType,
} from './contract.dto';

export type {
  ScheduleCreateDto,
  ScheduleCreateInputDto,
  ScheduleSource,
} from './schedule.dto';

export type {
  LessonFeedbackCreateDto,
  AttendanceForFeedback,
  ClassroomPerformance,
  HomeworkDifficulty,
  LessonFeedbackKnowledgePoint,
  LessonFeedbackHomeworkAttachment,
  LessonFeedbackKnowledgeMatrix,
  LessonFeedbackDimRatings,
} from './lesson-feedback.dto';

export type {
  InvoiceCreateDto,
  InvoiceTitleType,
} from './invoice.dto';
