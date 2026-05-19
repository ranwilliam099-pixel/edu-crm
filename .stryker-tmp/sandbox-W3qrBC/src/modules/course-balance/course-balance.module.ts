import { Module } from '@nestjs/common';
import { CourseBalanceService } from './course-balance.service';
import { CourseBalanceController } from './course-balance.controller';

@Module({
  controllers: [CourseBalanceController],
  providers: [CourseBalanceService],
  exports: [CourseBalanceService],
})
export class CourseBalanceModule {}
