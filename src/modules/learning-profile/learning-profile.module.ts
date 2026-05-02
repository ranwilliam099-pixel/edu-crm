import { Module } from '@nestjs/common';
import { StudentLearningProfileService } from './student-learning-profile.service';

@Module({
  providers: [StudentLearningProfileService],
  exports: [StudentLearningProfileService],
})
export class LearningProfileModule {}
