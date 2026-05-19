import { Module } from '@nestjs/common';
import { TeacherService } from './teacher.service';
import { TeacherController } from './teacher.controller';

/**
 * Teacher 模块（V7 教师独立档案）
 *
 * USER-AUTH(2026-05-02): 教师独立 teachers 表，user_id NULLABLE
 */
@Module({
  controllers: [TeacherController],
  providers: [TeacherService],
  exports: [TeacherService],
})
export class TeacherModule {}
