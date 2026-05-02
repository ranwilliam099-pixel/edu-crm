import { Module } from '@nestjs/common';
import { HomeworkService } from './homework.service';

@Module({
  providers: [HomeworkService],
  exports: [HomeworkService],
})
export class HomeworkModule {}
