import { Module } from '@nestjs/common';
import { CourseBalanceService } from './course-balance.service';

@Module({
  providers: [CourseBalanceService],
  exports: [CourseBalanceService],
})
export class CourseBalanceModule {}
