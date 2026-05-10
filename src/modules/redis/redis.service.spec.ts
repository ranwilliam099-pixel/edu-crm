import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RedisService } from './redis.service';

/**
 * RedisService 单测
 *
 * 策略：
 *   - 不实连 Redis（避免单测依赖外部服务）
 *   - mock ioredis 客户端方法
 *   - 通过 onModuleInit 后替换 client 字段实现
 */

type MockRedis = {
  get: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
  exists: jest.Mock;
  expire: jest.Mock;
  ttl: jest.Mock;
  incr: jest.Mock;
  incrby: jest.Mock;
  decr: jest.Mock;
  hset: jest.Mock;
  hget: jest.Mock;
  hgetall: jest.Mock;
  hdel: jest.Mock;
  eval: jest.Mock;
  ping: jest.Mock;
  quit: jest.Mock;
  on: jest.Mock;
  status: string;
};

function makeMockRedis(): MockRedis {
  return {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    exists: jest.fn(),
    expire: jest.fn(),
    ttl: jest.fn(),
    incr: jest.fn(),
    incrby: jest.fn(),
    decr: jest.fn(),
    hset: jest.fn(),
    hget: jest.fn(),
    hgetall: jest.fn(),
    hdel: jest.fn(),
    eval: jest.fn(),
    ping: jest.fn(),
    quit: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    status: 'ready',
  };
}

describe('RedisService', () => {
  let service: RedisService;
  let mockClient: MockRedis;

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RedisService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, def: string) => {
              if (key === 'REDIS_URL') return 'redis://localhost:6379';
              if (key === 'REDIS_KEY_PREFIX') return 'edu-test:';
              return def;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<RedisService>(RedisService);
    service.onModuleInit();

    // 替换内部 client 为 mock
    mockClient = makeMockRedis();
    (service as unknown as { client: MockRedis }).client = mockClient;
  });

  describe('基础 K/V', () => {
    it('get() 正常', async () => {
      mockClient.get.mockResolvedValueOnce('v');
      expect(await service.get('k')).toBe('v');
      expect(mockClient.get).toHaveBeenCalledWith('k');
    });

    it('set() 无 TTL', async () => {
      mockClient.set.mockResolvedValueOnce('OK');
      await service.set('k', 'v');
      expect(mockClient.set).toHaveBeenCalledWith('k', 'v');
    });

    it('set() 带 TTL', async () => {
      mockClient.set.mockResolvedValueOnce('OK');
      await service.set('k', 'v', 60);
      expect(mockClient.set).toHaveBeenCalledWith('k', 'v', 'EX', 60);
    });

    it('setNX() 成功（key 不存在）', async () => {
      mockClient.set.mockResolvedValueOnce('OK');
      expect(await service.setNX('k', 'v', 60)).toBe(true);
      expect(mockClient.set).toHaveBeenCalledWith('k', 'v', 'EX', 60, 'NX');
    });

    it('setNX() 失败（key 已存在）', async () => {
      mockClient.set.mockResolvedValueOnce(null);
      expect(await service.setNX('k', 'v', 60)).toBe(false);
    });

    it('del() 多 key', async () => {
      mockClient.del.mockResolvedValueOnce(2);
      expect(await service.del('a', 'b')).toBe(2);
      expect(mockClient.del).toHaveBeenCalledWith('a', 'b');
    });

    it('del() 空数组 → 不调 redis 直接 0', async () => {
      expect(await service.del()).toBe(0);
      expect(mockClient.del).not.toHaveBeenCalled();
    });

    it('exists() 存在', async () => {
      mockClient.exists.mockResolvedValueOnce(1);
      expect(await service.exists('k')).toBe(true);
    });

    it('exists() 不存在', async () => {
      mockClient.exists.mockResolvedValueOnce(0);
      expect(await service.exists('k')).toBe(false);
    });

    it('expire()', async () => {
      mockClient.expire.mockResolvedValueOnce(1);
      expect(await service.expire('k', 30)).toBe(true);
    });

    it('ttl()', async () => {
      mockClient.ttl.mockResolvedValueOnce(120);
      expect(await service.ttl('k')).toBe(120);
    });
  });

  describe('计数', () => {
    it('incr / incrBy / decr', async () => {
      mockClient.incr.mockResolvedValueOnce(1);
      mockClient.incrby.mockResolvedValueOnce(11);
      mockClient.decr.mockResolvedValueOnce(10);
      expect(await service.incr('c')).toBe(1);
      expect(await service.incrBy('c', 10)).toBe(11);
      expect(await service.decr('c')).toBe(10);
    });
  });

  describe('分布式锁', () => {
    it('acquireLock() 成功 → 返回 owner token', async () => {
      mockClient.set.mockResolvedValueOnce('OK');
      const owner = await service.acquireLock('pool:claim:cust_x', 30);
      expect(owner).toBeTruthy();
      expect(typeof owner).toBe('string');
      expect(mockClient.set).toHaveBeenCalledWith(
        'lock:pool:claim:cust_x',
        owner,
        'EX',
        30,
        'NX',
      );
    });

    it('acquireLock() 失败（已被锁）→ null', async () => {
      mockClient.set.mockResolvedValueOnce(null);
      expect(await service.acquireLock('pool:claim:cust_x')).toBeNull();
    });

    it('releaseLock() 成功（持有者匹配）', async () => {
      mockClient.eval.mockResolvedValueOnce(1);
      const ok = await service.releaseLock('pool:claim:cust_x', 'owner-1');
      expect(ok).toBe(true);
      expect(mockClient.eval).toHaveBeenCalledWith(
        expect.stringContaining('redis.call("get", KEYS[1])'),
        1,
        'lock:pool:claim:cust_x',
        'owner-1',
      );
    });

    it('releaseLock() 失败（持有者不匹配 / 锁已过期）', async () => {
      mockClient.eval.mockResolvedValueOnce(0);
      expect(await service.releaseLock('pool:claim:cust_x', 'owner-2')).toBe(false);
    });

    it('两次 acquireLock 同一资源 → 第 1 次成功，第 2 次（其他实例）失败', async () => {
      mockClient.set.mockResolvedValueOnce('OK');
      mockClient.set.mockResolvedValueOnce(null);
      expect(await service.acquireLock('r')).toBeTruthy();
      expect(await service.acquireLock('r')).toBeNull();
    });

    it('acquireLock 默认 TTL 30 秒', async () => {
      mockClient.set.mockResolvedValueOnce('OK');
      await service.acquireLock('r');
      expect(mockClient.set).toHaveBeenCalledWith(
        'lock:r',
        expect.any(String),
        'EX',
        30,
        'NX',
      );
    });
  });

  describe('Hash', () => {
    it('hset / hget / hgetall / hdel', async () => {
      mockClient.hset.mockResolvedValueOnce(1);
      mockClient.hget.mockResolvedValueOnce('v');
      mockClient.hgetall.mockResolvedValueOnce({ a: '1', b: '2' });
      mockClient.hdel.mockResolvedValueOnce(2);

      expect(await service.hset('k', 'a', '1')).toBe(1);
      expect(await service.hget('k', 'a')).toBe('v');
      expect(await service.hgetall('k')).toEqual({ a: '1', b: '2' });
      expect(await service.hdel('k', 'a', 'b')).toBe(2);
    });

    it('hdel() 空字段 → 不调 redis 直接 0', async () => {
      expect(await service.hdel('k')).toBe(0);
      expect(mockClient.hdel).not.toHaveBeenCalled();
    });
  });

  describe('健康检查', () => {
    it('ping() PONG → true', async () => {
      mockClient.ping.mockResolvedValueOnce('PONG');
      expect(await service.ping()).toBe(true);
    });

    it('ping() 失败 → false（不抛错）', async () => {
      mockClient.ping.mockRejectedValueOnce(new Error('connection refused'));
      expect(await service.ping()).toBe(false);
    });
  });

  describe('优雅退出', () => {
    it('onModuleDestroy() 调 quit', async () => {
      await service.onModuleDestroy();
      expect(mockClient.quit).toHaveBeenCalled();
    });

    it('client 已 end → 不重复 quit', async () => {
      mockClient.status = 'end';
      await service.onModuleDestroy();
      expect(mockClient.quit).not.toHaveBeenCalled();
    });
  });

  describe('getClient() 暴露原始实例（BullMQ 用）', () => {
    it('返回内部 client', () => {
      expect(service.getClient()).toBe(mockClient);
    });
  });
});
