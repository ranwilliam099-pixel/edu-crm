import { Module } from '@nestjs/common';
import { StudentLearningProfileService } from './student-learning-profile.service';
import { LearningProfileController } from './learning-profile.controller';

@Module({
  controllers: [LearningProfileController],
  providers: [StudentLearningProfileService],
  exports: [StudentLearningProfileService],
})
export class LearningProfileModule {}
