import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AlertService } from './alert.service';
import { RedisService } from '../../modules/redis/redis.service';

describe('AlertService', () => {
  let service: AlertService;
  let redis: { setNX: jest.Mock };
  let config: { get: jest.Mock };
  let fetchMock: jest.Mock;

  beforeEach(async () => {
    redis = { setNX: jest.fn().mockResolvedValue(true) };
    config = {
      get: jest.fn((key: string, def?: string) => {
        if (key === 'DINGTALK_WEBHOOK') return '';
        if (key === 'WEWORK_WEBHOOK') return '';
        return def;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AlertService,
        { provide: ConfigService, useValue: config },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();

    service = module.get(AlertService);

    // mock global fetch
    fetchMock = jest.fn();
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
  });

  describe('无 webhook 配置', () => {
    it('钉钉 + 企微都没配 → 仅 logger，返回 false', async () => {
      const ok = await service.send('warn', 'Test', 'body');
      expect(ok).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('钉钉发送', () => {
    beforeEach(() => {
      config.get.mockImplementation((key: string) => {
        if (key === 'DINGTALK_WEBHOOK') return 'https://dingtalk.example/webhook';
        return '';
      });
    });

    it('成功（errcode=0）→ 返回 true', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ errcode: 0 }),
      });
      const ok = await service.error('5xx', 'Internal Error');
      expect(ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = fetchMock.mock.calls[0];
      expect(call[0]).toBe('https://dingtalk.example/webhook');
      const body = JSON.parse(call[1].body);
      expect(body.msgtype).toBe('markdown');
      expect(body.markdown.title).toBe('5xx');
      expect(body.markdown.text).toContain('Internal Error');
      expect(body.markdown.text).toContain('ERROR');
    });

    it('钉钉 errcode != 0 → false', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ errcode: 1, errmsg: 'invalid token' }),
      });
      expect(await service.warn('T', 'B')).toBe(false);
    });

    it('钉钉网络异常 → false（不抛错）', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
      expect(await service.warn('T', 'B')).toBe(false);
    });
  });

  describe('企微发送', () => {
    beforeEach(() => {
      config.get.mockImplementation((key: string) => {
        if (key === 'WEWORK_WEBHOOK') return 'https://qyapi.weixin.qq.com/webhook';
        return '';
      });
    });

    it('成功 → true', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ errcode: 0 }),
      });
      expect(await service.warn('T', 'B')).toBe(true);
    });
  });

  describe('两个渠道并发', () => {
    beforeEach(() => {
      config.get.mockImplementation((key: string) => {
        if (key === 'DINGTALK_WEBHOOK') return 'https://dingtalk/webhook';
        if (key === 'WEWORK_WEBHOOK') return 'https://wework/webhook';
        return '';
      });
    });

    it('两个都成功 → true', async () => {
      fetchMock
        .mockResolvedValueOnce({ ok: true, json: async () => ({ errcode: 0 }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ errcode: 0 }) });
      expect(await service.error('T', 'B')).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('一个成功一个失败 → true（任一即可）', async () => {
      fetchMock
        .mockResolvedValueOnce({ ok: true, json: async () => ({ errcode: 0 }) })
        .mockRejectedValueOnce(new Error('timeout'));
      expect(await service.error('T', 'B')).toBe(true);
    });

    it('两个都失败 → false', async () => {
      fetchMock
        .mockRejectedValueOnce(new Error('timeout'))
        .mockRejectedValueOnce(new Error('timeout'));
      expect(await service.error('T', 'B')).toBe(false);
    });
  });

  describe('dedup 防 spam', () => {
    beforeEach(() => {
      config.get.mockImplementation((key: string) => {
        if (key === 'DINGTALK_WEBHOOK') return 'https://dingtalk/webhook';
        return '';
      });
    });

    it('首次发送 → setNX true → 真发', async () => {
      redis.setNX.mockResolvedValueOnce(true);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ errcode: 0 }),
      });
      const ok = await service.error('T', 'B', { dedupKey: 'foo' });
      expect(ok).toBe(true);
      expect(redis.setNX).toHaveBeenCalledWith('alert:dedup:foo', '1', 30);
      // 验证 fetch 用了 POST + 钉钉 webhook URL + JSON body 含 markdown msgtype
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://dingtalk/webhook',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
          body: expect.stringContaining('"msgtype":"markdown"'),
        }),
      );
    });

    it('窗口内重复 → setNX false → 跳过发送（返回 true 视为已处理）', async () => {
      redis.setNX.mockResolvedValueOnce(false);
      const ok = await service.error('T', 'B', { dedupKey: 'foo' });
      expect(ok).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('自定义 dedupTtl', async () => {
      redis.setNX.mockResolvedValueOnce(true);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ errcode: 0 }),
      });
      await service.warn('T', 'B', { dedupKey: 'foo', dedupTtl: 600 });
      expect(redis.setNX).toHaveBeenCalledWith('alert:dedup:foo', '1', 600);
    });

    it('Redis 挂了 → 仍能发（不阻塞告警）', async () => {
      redis.setNX.mockRejectedValueOnce(new Error('redis down'));
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ errcode: 0 }),
      });
      const ok = await service.error('T', 'B', { dedupKey: 'foo' });
      expect(ok).toBe(true);
      // Redis 挂了仍要走 fetch — 验证 fetch 真的被触发了一次（dedupKey 失败 fail-open）
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://dingtalk/webhook',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"msgtype":"markdown"'),
        }),
      );
    });

    it('无 dedupKey → 不查 Redis', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ errcode: 0 }),
      });
      await service.error('T', 'B');
      expect(redis.setNX).not.toHaveBeenCalled();
    });
  });

  describe('便捷方法', () => {
    beforeEach(() => {
      config.get.mockImplementation((key: string) => {
        if (key === 'DINGTALK_WEBHOOK') return 'https://dingtalk/webhook';
        return '';
      });
    });

    it.each(['warn', 'error', 'critical'] as const)('%s() level 透传', async (level) => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ errcode: 0 }),
      });
      await (service as unknown as Record<string, (t: string, b: string) => Promise<boolean>>)
        [level]('T', 'B');
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.markdown.text).toContain(level.toUpperCase());
    });
  });

  describe('Markdown 格式', () => {
    beforeEach(() => {
      config.get.mockImplementation((key: string) => {
        if (key === 'DINGTALK_WEBHOOK') return 'https://dingtalk/webhook';
        return '';
      });
    });

    it('含 emoji + level + env + host + time', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ errcode: 0 }),
      });
      await service.critical('Boom', 'PG down');
      const text = JSON.parse(fetchMock.mock.calls[0][1].body).markdown.text;
      expect(text).toContain('🚨');
      expect(text).toContain('CRITICAL');
      expect(text).toContain('Boom');
      expect(text).toContain('PG down');
      expect(text).toContain('host');
      expect(text).toContain('time');
    });

    it('context 字段渲染', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ errcode: 0 }),
      });
      await service.error('T', 'B', { context: { tenant: 't1', error: 'oops' } });
      const text = JSON.parse(fetchMock.mock.calls[0][1].body).markdown.text;
      expect(text).toContain('tenant');
      expect(text).toContain('t1');
      expect(text).toContain('error');
      expect(text).toContain('oops');
    });

    it('context 截断长 string（防 webhook 拒绝）', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ errcode: 0 }),
      });
      const longStr = 'x'.repeat(500);
      await service.error('T', 'B', { context: { big: longStr } });
      const text = JSON.parse(fetchMock.mock.calls[0][1].body).markdown.text;
      // 长字符串被截到 200
      expect(text).toContain('xxxxx');
      expect(text.length).toBeLessThan(2000);
    });
  });
});
