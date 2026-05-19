import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { StudentLearningProfileService } from './student-learning-profile.service';
import { LearningProfileRepository } from '../db/learning-profile.repository';
import { LessonFeedbackRepository } from '../db/lesson-feedback.repository';
import { HomeworkRepository } from '../db/homework.repository';
import { AssessmentRepository } from '../db/assessment.repository';

describe('StudentLearningProfileService InDb (V15)', () => {
  let service: StudentLearningProfileService;
  let profileRepo: { upsert: jest.Mock; findByStudent: jest.Mock; listAllStudentIds: jest.Mock; listStale: jest.Mock };
  let feedbackRepo: { listByStudent: jest.Mock };
  let homeworkRepo: { listSubmissionsByStudent: jest.Mock };
  let assessmentRepo: { listResultsByStudent: jest.Mock };

  const TENANT = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const STUDENT = 'stu' + '0'.repeat(29);

  beforeEach(async () => {
    profileRepo = {
      upsert: jest.fn(),
      findByStudent: jest.fn(),
      listAllStudentIds: jest.fn(),
      listStale: jest.fn(),
    };
    feedbackRepo = { listByStudent: jest.fn() };
    homeworkRepo = { listSubmissionsByStudent: jest.fn() };
    assessmentRepo = { listResultsByStudent: jest.fn() };

    const m = await Test.createTestingModule({
      providers: [
        StudentLearningProfileService,
        { provide: LearningProfileRepository, useValue: profileRepo },
        { provide: LessonFeedbackRepository, useValue: feedbackRepo },
        { provide: HomeworkRepository, useValue: homeworkRepo },
        { provide: AssessmentRepository, useValue: assessmentRepo },
      ],
    }).compile();
    service = m.get(StudentLearningProfileService);
  });

  it('recomputeInDb fetches all 3 sources in parallel + upserts', async () => {
    feedbackRepo.listByStudent.mockResolvedValueOnce([]);
    homeworkRepo.listSubmissionsByStudent.mockResolvedValueOnce([]);
    assessmentRepo.listResultsByStudent.mockResolvedValueOnce([]);
    profileRepo.upsert.mockImplementation(async (_t: string, p: any) => p);
    const r = await service.recomputeInDb(STUDENT, TENANT, new Date('2026-05-02T00:00:00Z'));
    expect(r.studentId).toBe(STUDENT);
    expect(r.totalLessons).toBe(0);
    expect(feedbackRepo.listByStudent).toHaveBeenCalledTimes(1);
    expect(homeworkRepo.listSubmissionsByStudent).toHaveBeenCalledTimes(1);
    expect(assessmentRepo.listResultsByStudent).toHaveBeenCalledTimes(1);
    expect(profileRepo.upsert).toHaveBeenCalledTimes(1);
  });

  it('recomputeInDb validates studentId 32-char', async () => {
    await expect(
      service.recomputeInDb('short', TENANT),
    ).rejects.toThrow(BadRequestException);
  });

  it('findInDb NotFoundException when missing', async () => {
    profileRepo.findByStudent.mockResolvedValueOnce(null);
    await expect(service.findInDb(STUDENT, TENANT)).rejects.toThrow(NotFoundException);
  });

  it('recomputeAllInDb counts success / failure', async () => {
    profileRepo.listAllStudentIds.mockResolvedValueOnce([STUDENT, 'stu' + 'x'.repeat(29)]);
    feedbackRepo.listByStudent.mockResolvedValue([]);
    homeworkRepo.listSubmissionsByStudent.mockResolvedValue([]);
    assessmentRepo.listResultsByStudent.mockResolvedValue([]);
    profileRepo.upsert
      .mockImplementationOnce(async (_t: string, p: any) => p)
      .mockRejectedValueOnce(new Error('boom'));
    const r = await service.recomputeAllInDb(TENANT);
    expect(r.recomputed).toBe(1);
    expect(r.failed).toBe(1);
  });

  it('throws when any dependency missing', async () => {
    const partial = new StudentLearningProfileService(undefined, undefined, undefined, undefined);
    await expect(partial.recomputeInDb(STUDENT, TENANT)).rejects.toThrow(BadRequestException);
  });

  it('listStaleInDb passes threshold', async () => {
    const t = new Date('2026-05-01');
    profileRepo.listStale.mockResolvedValueOnce([]);
    await service.listStaleInDb(TENANT, t);
    expect(profileRepo.listStale).toHaveBeenCalledWith(TENANT, t);
  });
});
