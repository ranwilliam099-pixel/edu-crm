import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { HomeworkService, HomeworkAssignment, HomeworkSubmission } from './homework.service';
import { HomeworkRepository } from '../db/homework.repository';

describe('HomeworkService InDb (V13)', () => {
  let service: HomeworkService;
  let repo: {
    insertAssignmentWithRecipients: jest.Mock;
    findAssignmentById: jest.Mock;
    insertSubmission: jest.Mock;
    findSubmissionById: jest.Mock;
    findSubmissionByAssignmentStudent: jest.Mock;
    grade: jest.Mock;
    returnForRedo: jest.Mock;
    listAssignmentsByTeacher: jest.Mock;
    listAssignmentsByStudent: jest.Mock;
    listPendingByTeacher: jest.Mock;
    listSubmissionsByStudent: jest.Mock;
    setAssignmentStatus: jest.Mock;
    setSubmissionStatus: jest.Mock;
  };

  const TENANT = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const TEACHER = 'teach' + '0'.repeat(27);
  const STUDENT_A = 'stu' + '0'.repeat(29);
  const ASG: HomeworkAssignment = {
    id: 'asg' + '0'.repeat(29),
    teacherId: TEACHER,
    title: '英语',
    status: 'published',
    recipientStudentIds: [STUDENT_A],
    createdAt: new Date('2026-05-02T10:00:00Z'),
  };
  const SUB: HomeworkSubmission = {
    id: 'sub' + '0'.repeat(29),
    assignmentId: ASG.id,
    studentId: STUDENT_A,
    status: 'submitted',
    submittedAt: new Date('2026-05-03T10:00:00Z'),
  };

  beforeEach(async () => {
    repo = {
      insertAssignmentWithRecipients: jest.fn(),
      findAssignmentById: jest.fn(),
      insertSubmission: jest.fn(),
      findSubmissionById: jest.fn(),
      findSubmissionByAssignmentStudent: jest.fn(),
      grade: jest.fn(),
      returnForRedo: jest.fn(),
      listAssignmentsByTeacher: jest.fn(),
      listAssignmentsByStudent: jest.fn(),
      listPendingByTeacher: jest.fn(),
      listSubmissionsByStudent: jest.fn(),
      setAssignmentStatus: jest.fn(),
      setSubmissionStatus: jest.fn(),
    };
    const m = await Test.createTestingModule({
      providers: [HomeworkService, { provide: HomeworkRepository, useValue: repo }],
    }).compile();
    service = m.get(HomeworkService);
  });

  it('publishInDb persists via repo with recipients', async () => {
    repo.insertAssignmentWithRecipients.mockResolvedValueOnce(ASG);
    await service.publishInDb(
      {
        id: ASG.id,
        teacherId: TEACHER,
        title: '英语',
        recipientStudentIds: [STUDENT_A],
      },
      TENANT,
    );
    expect(repo.insertAssignmentWithRecipients).toHaveBeenCalledTimes(1);
    expect(repo.insertAssignmentWithRecipients.mock.calls[0][0]).toBe(TENANT);
  });

  it('submitForStudentInDb checks assignment + STUDENT_NOT_IN_RECIPIENTS', async () => {
    repo.findAssignmentById.mockResolvedValueOnce(ASG);
    repo.findSubmissionByAssignmentStudent.mockResolvedValueOnce(null);
    await expect(
      service.submitForStudentInDb(
        {
          id: 'sub' + 'x'.repeat(29),
          assignmentId: ASG.id,
          studentId: 'other' + 'x'.repeat(27),
        },
        TENANT,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('submitForStudentInDb persists when valid', async () => {
    repo.findAssignmentById.mockResolvedValueOnce(ASG);
    repo.findSubmissionByAssignmentStudent.mockResolvedValueOnce(null);
    repo.insertSubmission.mockResolvedValueOnce(SUB);
    const r = await service.submitForStudentInDb(
      {
        id: SUB.id,
        assignmentId: ASG.id,
        studentId: STUDENT_A,
      },
      TENANT,
    );
    expect(r.id).toBe(SUB.id);
    expect(repo.insertSubmission).toHaveBeenCalledTimes(1);
  });

  it('submitForStudentInDb conflicts on duplicate non-returned submission', async () => {
    repo.findAssignmentById.mockResolvedValueOnce(ASG);
    repo.findSubmissionByAssignmentStudent.mockResolvedValueOnce(SUB);
    await expect(
      service.submitForStudentInDb(
        {
          id: 'sub' + 'x'.repeat(29),
          assignmentId: ASG.id,
          studentId: STUDENT_A,
        },
        TENANT,
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('gradeInDb runs pure validation then calls repo.grade', async () => {
    repo.findSubmissionById.mockResolvedValueOnce(SUB);
    repo.grade.mockResolvedValueOnce({ ...SUB, status: 'graded', grade: 'A' });
    const r = await service.gradeInDb(
      SUB.id,
      { grade: 'A', teacherComment: '不错', gradedByUserId: 't' + 'x'.repeat(31) },
      TENANT,
    );
    expect(r.status).toBe('graded');
    expect(repo.grade).toHaveBeenCalledTimes(1);
  });

  it('gradeInDb NotFoundException on missing submission', async () => {
    repo.findSubmissionById.mockResolvedValueOnce(null);
    await expect(
      service.gradeInDb('nope', { grade: 'A', gradedByUserId: 'u' + 'x'.repeat(31) }, TENANT),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws when repo not injected', async () => {
    const noRepo = new HomeworkService();
    await expect(noRepo.publishInDb({ id: ASG.id, teacherId: TEACHER, title: 'x', recipientStudentIds: [STUDENT_A] }, TENANT)).rejects.toThrow(BadRequestException);
  });
});
