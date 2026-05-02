import { Body, Controller, Param, Post, HttpCode, HttpStatus } from '@nestjs/common';
import {
  StudentLearningProfileService,
  StudentLearningProfile,
  KnowledgeMastery,
} from './student-learning-profile.service';
import { LessonFeedback } from '../feedback/lesson-feedback.service';
import { HomeworkSubmission } from '../homework/homework.service';
import { StudentAssessmentResult } from '../assessment/assessment.service';

/**
 * LearningProfileController — V15 学情累计档案 HTTP 暴露 BE-V15-1
 * 路由前缀：/api/learning-profile
 */
@Controller('learning-profile')
export class LearningProfileController {
  constructor(private readonly service: StudentLearningProfileService) {}

  /**
   * POST /api/learning-profile/recompute
   * cron 每天 0:00 增量 + 每月 1 号全量
   */
  @Post('recompute')
  @HttpCode(HttpStatus.OK)
  recompute(
    @Body()
    body: {
      studentId: string;
      feedbacks: LessonFeedback[];
      homeworkSubmissions: HomeworkSubmission[];
      assessmentResults: StudentAssessmentResult[];
      nowMs?: number;
    },
  ): StudentLearningProfile {
    return this.service.recompute({
      studentId: body.studentId,
      feedbacks: body.feedbacks.map((f) => this.deserializeFeedback(f)),
      homeworkSubmissions: body.homeworkSubmissions.map((s) =>
        this.deserializeSubmission(s),
      ),
      assessmentResults: body.assessmentResults.map((r) => this.deserializeResult(r)),
      now: body.nowMs ? new Date(body.nowMs) : new Date(),
    });
  }

  @Post('students/:studentId/weaknesses')
  @HttpCode(HttpStatus.OK)
  identifyWeaknesses(
    @Param('studentId') _studentId: string,
    @Body() body: { profile: StudentLearningProfile },
  ): ReadonlyArray<KnowledgeMastery> {
    return this.service.identifyWeaknesses(this.deserializeProfile(body.profile));
  }

  @Post('students/:studentId/strengths')
  @HttpCode(HttpStatus.OK)
  identifyStrengths(
    @Param('studentId') _studentId: string,
    @Body() body: { profile: StudentLearningProfile },
  ): ReadonlyArray<KnowledgeMastery> {
    return this.service.identifyStrengths(this.deserializeProfile(body.profile));
  }

  // -- helpers --

  private deserializeFeedback(f: LessonFeedback): LessonFeedback {
    return {
      ...f,
      submittedAt: new Date(f.submittedAt as unknown as string),
      updatedAt: new Date(f.updatedAt as unknown as string),
      parentReadAt: f.parentReadAt
        ? new Date(f.parentReadAt as unknown as string)
        : undefined,
    };
  }

  private deserializeSubmission(s: HomeworkSubmission): HomeworkSubmission {
    return {
      ...s,
      submittedAt: new Date(s.submittedAt as unknown as string),
      gradedAt: s.gradedAt ? new Date(s.gradedAt as unknown as string) : undefined,
    };
  }

  private deserializeResult(r: StudentAssessmentResult): StudentAssessmentResult {
    return {
      ...r,
      recordedAt: r.recordedAt ? new Date(r.recordedAt as unknown as string) : undefined,
    };
  }

  private deserializeProfile(p: StudentLearningProfile): StudentLearningProfile {
    return {
      ...p,
      lastUpdatedAt: new Date(p.lastUpdatedAt as unknown as string),
      knowledgeMastery: p.knowledgeMastery.map((k) => ({
        ...k,
        lastSeenAt: new Date(k.lastSeenAt as unknown as string),
      })),
      weaknessPoints: p.weaknessPoints.map((k) => ({
        ...k,
        lastSeenAt: new Date(k.lastSeenAt as unknown as string),
      })),
      strengthPoints: p.strengthPoints.map((k) => ({
        ...k,
        lastSeenAt: new Date(k.lastSeenAt as unknown as string),
      })),
    };
  }
}
