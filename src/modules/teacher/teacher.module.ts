import { Module } from '@nestjs/common';
import { TeacherService } from './teacher.service';

/**
 * Teacher 模块（V7 教师独立档案）
 *
 * 来源：
 *   - 《PD设计稿-排课-教学反馈-家长订阅-V1-2026-05-02.md》§2
 *   - 用户拍板《全部人员-审核往来总台账.md》条目 29 方向 B + 条目 31 #2
 *
 * USER-AUTH(2026-05-02): 教师独立 teachers 表，user_id NULLABLE
 *
 * 不暴露 HTTP 路由（W3+ 业务编排或 W4+ ScheduleController 注入使用）
 */
@Module({
  providers: [TeacherService],
  exports: [TeacherService],
})
export class TeacherModule {}
