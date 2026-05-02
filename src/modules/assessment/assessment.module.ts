import { Module } from '@nestjs/common';
import { AssessmentService } from './assessment.service';

@Module({
  providers: [AssessmentService],
  exports: [AssessmentService],
})
export class AssessmentModule {}
