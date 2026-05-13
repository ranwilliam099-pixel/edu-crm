import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { InternalServerErrorException } from '@nestjs/common';
import { WxAccessTokenService } from './wx-access-token.service';
import { RedisService } from '../redis/redis.service';

describe('WxAccessTokenService', () => {
  let service: WxAccessTokenService;
  let redis: { get: jest.Mock; set: jest.Mock };
  let config: { get: jest.Mock };
  let fetchMock: jest.Mock;

  beforeEach(async () => {
    redis = {
      get: jest.fn(),
      set: jest.fn().mockResolvedValue(undefined),
    };
    config = {
      get: jest.fn((key: string) => {
        if (key === 'WX_APP_ID') return 'wx_test_appid';
        if (key === 'WX_APP_SECRET') return 'wx_test_secret';
        return undefined;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WxAccessTokenService,
        { provide: ConfigService, useValue: config },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();

    service = module.get(WxAccessTokenService);

    fetchMock = jest.fn();
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
  });

  describe('cache hit', () => {
    it('Redis 有缓存 → 直接返回，不调微信', async () => {
      redis.get.mockResolvedValueOnce('cached_access_token_123');
      const token = await service.getAccessToken();
      expect(token).toBe('cached_access_token_123');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(redis.set).not.toHaveBeenCalled();
    });
  });

  describe('cache miss', () => {
    beforeEach(() => {
      redis.get.mockResolvedValueOnce(null);
    });

    it('成功换 token → 写缓存，返回 token', async () => {
      fetchMock.mockResolvedValueOnce({
        json: async () => ({
          access_token: 'new_access_token_abc',
          expires_in: 7200,
        }),
      });
      const token = await service.getAccessToken();
      expect(token).toBe('new_access_token_abc');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // URL 含 appid + secret
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('appid=wx_test_appid');
      expect(url).toContain('secret=wx_test_secret');
      // 写缓存 TTL = 6600
      expect(redis.set).toHaveBeenCalledWith(
        'wx:access_token',
        'new_access_token_abc',
        6600,
      );
    });

    it('微信返回 errcode != 0 → 抛 InternalServerErrorException', async () => {
      fetchMock.mockResolvedValueOnce({
        json: async () => ({
          errcode: 40013,
          errmsg: 'invalid appid',
        }),
      });
      await expect(service.getAccessToken()).rejects.toThrow(
        InternalServerErrorException,
      );
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('fetch 网络异常 → 抛 InternalServerErrorException', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
      await expect(service.getAccessToken()).rejects.toThrow(
        InternalServerErrorException,
      );
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('微信返回无 access_token → 抛 InternalServerErrorException', async () => {
      fetchMock.mockResolvedValueOnce({
        json: async () => ({}),
      });
      await expect(service.getAccessToken()).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('config missing', () => {
    beforeEach(() => {
      redis.get.mockResolvedValueOnce(null);
    });

    it('WX_APP_ID 缺 → 抛 InternalServerErrorException', async () => {
      config.get.mockImplementation((key: string) => {
        if (key === 'WX_APP_SECRET') return 'secret';
        return undefined;
      });
      await expect(service.getAccessToken()).rejects.toThrow(
        InternalServerErrorException,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('WX_APP_SECRET 缺 → 抛 InternalServerErrorException', async () => {
      config.get.mockImplementation((key: string) => {
        if (key === 'WX_APP_ID') return 'appid';
        return undefined;
      });
      await expect(service.getAccessToken()).rejects.toThrow(
        InternalServerErrorException,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('Redis fail-open', () => {
    it('Redis.get 抛错 → 不影响主流程，继续换 token', async () => {
      redis.get.mockRejectedValueOnce(new Error('Redis down'));
      fetchMock.mockResolvedValueOnce({
        json: async () => ({ access_token: 'fallback_token', expires_in: 7200 }),
      });
      const token = await service.getAccessToken();
      expect(token).toBe('fallback_token');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('Redis.set 抛错 → 不影响主流程，仍返回 token', async () => {
      redis.get.mockResolvedValueOnce(null);
      redis.set.mockRejectedValueOnce(new Error('Redis down'));
      fetchMock.mockResolvedValueOnce({
        json: async () => ({ access_token: 'token_xyz', expires_in: 7200 }),
      });
      const token = await service.getAccessToken();
      expect(token).toBe('token_xyz');
    });
  });
});
