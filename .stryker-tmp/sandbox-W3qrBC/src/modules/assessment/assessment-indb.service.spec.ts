import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AssessmentService, Assessment, StudentAssessmentResult } from './assessment.service';
import { AssessmentRepository } from '../db/assessment.repository';

describe('AssessmentService InDb (V14)', () => {
  let service: AssessmentService;
  let repo: {
    insertAssessment: jest.Mock;
    findAssessmentById: jest.Mock;
    listAssessmentsByTeacher: jest.Mock;
    setAssessmentStatus: jest.Mock;
    insertResult: jest.Mock;
    findResultById: jest.Mock;
    listResultsByAssessment: jest.Mock;
    listResultsByStudent: jest.Mock;
    updateRankings: jest.Mock;
    findResultByAssessmentStudent: jest.Mock;
  };

  const TENANT = 'tenant_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const TEACHER = 'teach' + '0'.repeat(27);
  const STUDENT = 'stu' + '0'.repeat(29);
  const ASMT: Assessment = {
    id: 'asmt' + '0'.repeat(28),
    teacherId: TEACHER,
    title: '5 月月考',
    subject: '英语',
    assessmentType: '月考',
    totalScore: 100,
    status: 'draft',
    createdAt: new Date('2026-05-02'),
  };

  beforeEach(async () => {
    repo = {
      insertAssessment: jest.fn(),
      findAssessmentById: jest.fn(),
      listAssessmentsByTeacher: jest.fn(),
      setAssessmentStatus: jest.fn(),
      insertResult: jest.fn(),
      findResultById: jest.fn(),
      listResultsByAssessment: jest.fn(),
      listResultsByStudent: jest.fn(),
      updateRankings: jest.fn(),
      findResultByAssessmentStudent: jest.fn(),
    };
    const m = await Test.createTestingModule({
      providers: [AssessmentService, { provide: AssessmentRepository, useValue: repo }],
    }).compile();
    service = m.get(AssessmentService);
  });

  it('createAssessmentInDb persists', async () => {
    repo.insertAssessment.mockResolvedValueOnce(ASMT);
    await service.createAssessmentInDb(
      { id: ASMT.id, teacherId: TEACHER, title: '5 月月考', subject: '英语' },
      TENANT,
    );
    expect(repo.insertAssessment).toHaveBeenCalledTimes(1);
  });

  it('recordResultInDb fetches assessment + existing then validates', async () => {
    repo.findAssessmentById.mockResolvedValueOnce(ASMT);
    repo.listResultsByAssessment.mockResolvedValueOnce([]);
    repo.insertResult.mockImplementation(async (_t: string, r: StudentAssessmentResult) => r);
    const result = await service.recordResultInDb(
      {
        id: 'sar' + '0'.repeat(29),
        assessmentId: ASMT.id,
        studentId: STUDENT,
        score: 92,
        recordedByUserId: 'u' + 'x'.repeat(31),
      },
      TENANT,
    );
    expect(result.score).toBe(92);
    expect(repo.insertResult).toHaveBeenCalledTimes(1);
  });

  it('recordResultInDb NotFoundException when assessment missing', async () => {
    repo.findAssessmentById.mockResolvedValueOnce(null);
    await expect(
      service.recordResultInDb(
        {
          id: 'sar' + '0'.repeat(29),
          assessmentId: 'nope',
          studentId: STUDENT,
          score: 92,
          recordedByUserId: 'u' + 'x'.repeat(31),
        },
        TENANT,
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('publishAssessmentInDb computes rankings then sets status', async () => {
    repo.findAssessmentById.mockResolvedValueOnce(ASMT);
    repo.listResultsByAssessment.mockResolvedValueOnce([
      { id: 'r1', assessmentId: ASMT.id, studentId: 's1', score: 90, recordedAt: new Date() },
      { id: 'r2', assessmentId: ASMT.id, studentId: 's2', score: 80, recordedAt: new Date() },
    ]);
    repo.updateRankings.mockResolvedValueOnce(2);
    repo.setAssessmentStatus.mockResolvedValueOnce({ ...ASMT, status: 'published' });
    const r = await service.publishAssessmentInDb(ASMT.id, TENANT);
    expect(r.status).toBe('published');
    expect(repo.updateRankings).toHaveBeenCalledWith(TENANT, [
      { id: 'r1', rankInClass: 1 },
      { id: 'r2', rankInClass: 2 },
    ]);
    expect(repo.setAssessmentStatus).toHaveBeenCalledWith(TENANT, ASMT.id, 'published');
  });

  it('publishAssessmentInDb NotFoundException on missing assessment', async () => {
    repo.findAssessmentById.mockResolvedValueOnce(null);
    await expect(service.publishAssessmentInDb('nope', TENANT)).rejects.toThrow(NotFoundException);
  });

  it('closeAssessmentInDb runs pure validation', async () => {
    repo.findAssessmentById.mockResolvedValueOnce({ ...ASMT, status: 'closed' });
    await expect(service.closeAssessmentInDb(ASMT.id, TENANT)).rejects.toThrow(BadRequestException);
  });

  it('throws when repo not injected', async () => {
    const noRepo = new AssessmentService();
    await expect(noRepo.findAssessmentInDb('x', TENANT)).rejects.toThrow(BadRequestException);
  });
});
