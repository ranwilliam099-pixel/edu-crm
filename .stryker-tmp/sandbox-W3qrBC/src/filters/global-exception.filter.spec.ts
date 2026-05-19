import { Test, TestingModule } from '@nestjs/testing';
import {
  ArgumentsHost,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { GlobalExceptionFilter } from './global-exception.filter';

describe('GlobalExceptionFilter - PM-AUTH Phase 5.3', () => {
  let filter: GlobalExceptionFilter;
  let mockJson: jest.Mock;
  let mockStatus: jest.Mock;
  let mockHost: ArgumentsHost;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [GlobalExceptionFilter],
    }).compile();
    filter = module.get<GlobalExceptionFilter>(GlobalExceptionFilter);

    mockJson = jest.fn();
    mockStatus = jest.fn().mockReturnValue({ json: mockJson });
    mockHost = {
      switchToHttp: () => ({
        getResponse: () => ({ status: mockStatus }),
        getRequest: () => ({
          url: '/api/test',
          method: 'POST',
          headers: { 'x-request-id': 'req-123' },
        }),
      }),
    } as any;
  });

  it('BadRequestException → 400 + 原 message', () => {
    filter.catch(new BadRequestException('invalid input'), mockHost);
    expect(mockStatus).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    const body = mockJson.mock.calls[0][0];
    expect(body.statusCode).toBe(400);
    expect(body.message).toBe('invalid input');
    expect(body.path).toBe('/api/test');
    expect(body.requestId).toBe('req-123');
  });

  it('UnauthorizedException → 401', () => {
    filter.catch(new UnauthorizedException('token expired'), mockHost);
    expect(mockStatus).toHaveBeenCalledWith(HttpStatus.UNAUTHORIZED);
  });

  it('ForbiddenException → 403', () => {
    filter.catch(new ForbiddenException('insufficient role'), mockHost);
    expect(mockStatus).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
  });

  it('NotFoundException → 404', () => {
    filter.catch(new NotFoundException(), mockHost);
    expect(mockStatus).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
  });

  it('ConflictException → 409', () => {
    filter.catch(new ConflictException('illegal transition'), mockHost);
    expect(mockStatus).toHaveBeenCalledWith(HttpStatus.CONFLICT);
  });

  it('Error 非 HttpException → 500 + 隐藏内部细节', () => {
    filter.catch(new Error('database connection lost: postgres@10.0.0.1:5432'), mockHost);
    expect(mockStatus).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    const body = mockJson.mock.calls[0][0];
    expect(body.message).toBe('Internal server error'); // 通用文案，不泄露原始 message
    expect(body.error).toBe('Error');
  });

  it('未知异常类型 → 500 + UnknownError', () => {
    filter.catch('plain string thrown', mockHost);
    expect(mockStatus).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    const body = mockJson.mock.calls[0][0];
    expect(body.error).toBe('UnknownError');
  });

  it('HttpException 数组 message → 拼接', () => {
    filter.catch(new BadRequestException(['field1 required', 'field2 invalid']), mockHost);
    const body = mockJson.mock.calls[0][0];
    expect(body.message).toBe('field1 required, field2 invalid');
  });

  it('响应体含必要字段', () => {
    filter.catch(new BadRequestException('x'), mockHost);
    const body = mockJson.mock.calls[0][0];
    expect(body).toHaveProperty('statusCode');
    expect(body).toHaveProperty('message');
    expect(body).toHaveProperty('error');
    expect(body).toHaveProperty('timestamp');
    expect(body).toHaveProperty('path');
    expect(typeof body.timestamp).toBe('string');
    expect(new Date(body.timestamp).toString()).not.toBe('Invalid Date');
  });
});
