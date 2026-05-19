/**
 * WxCodeSessionService 单测 — 2026-05-14 凌晨 wxpay 沙箱集成
 */
import { Test, TestingModule } from '@nestjs/testing';
import { InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WxCodeSessionService } from './wx-code-session.service';

describe('WxCodeSessionService', () => {
  let service: WxCodeSessionService;
  let configGetOrThrowSpy: jest.Mock;
  let fetchSpy: jest.SpyInstance;

  const ORIGINAL_FETCH = global.fetch;

  beforeEach(async () => {
    configGetOrThrowSpy = jest.fn().mockImplementation((key: string) => {
      const map: Record<string, string> = {
        WX_APP_ID: 'wxde9d7818d7420d00',
        WX_APP_SECRET: 'test_secret_32_chars_abcdefghijkl',
      };
      const val = map[key];
      if (val === undefined) throw new Error(`Config ${key} missing`);
      return val;
    });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WxCodeSessionService,
        {
          provide: ConfigService,
          useValue: { getOrThrow: configGetOrThrowSpy },
        },
      ],
    }).compile();
    service = module.get<WxCodeSessionService>(WxCodeSessionService);

    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    global.fetch = ORIGINAL_FETCH;
  });

  it('happy path: 微信返合法 openid + session_key → 返 openid', async () => {
    fetchSpy.mockResolvedValueOnce({
      status: 200,
      json: async () => ({
        openid: 'oTestOpenid12345678901234567890',
        session_key: 'test_session_key_base64==',
        unionid: 'unionid_optional',
      }),
    } as never);

    const result = await service.exchange('valid_code_12345');
    expect(result.openid).toBe('oTestOpenid12345678901234567890');
    expect(result.sessionKey).toBe('test_session_key_base64==');
    expect(result.unionid).toBe('unionid_optional');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // 验证 URL 含 appid + secret + js_code
    const callUrl = fetchSpy.mock.calls[0][0] as string;
    expect(callUrl).toContain('appid=wxde9d7818d7420d00');
    expect(callUrl).toContain('js_code=valid_code_12345');
    expect(callUrl).toContain('grant_type=authorization_code');

    // 验证 Accept-Language: zh-CN（防 Node 20 fetch undici 默认 * 触发微信 406）
    const callInit = fetchSpy.mock.calls[0][1] as RequestInit;
    expect((callInit.headers as Record<string, string>)['Accept-Language']).toBe('zh-CN');
  });

  it('WX_APP_ID 未配置 → throw WX_CONFIG_MISSING', async () => {
    configGetOrThrowSpy.mockImplementation(() => {
      throw new Error('Config missing');
    });
    await expect(service.exchange('any_code_12345')).rejects.toThrow(
      InternalServerErrorException,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('微信 errcode=40029 (invalid code) → throw WX_CODE2SESSION_FAILED', async () => {
    fetchSpy.mockResolvedValueOnce({
      status: 200,
      json: async () => ({
        errcode: 40029,
        errmsg: 'invalid code',
      }),
    } as never);
    await expect(service.exchange('expired_code_12345')).rejects.toThrow(
      InternalServerErrorException,
    );
  });

  it('微信 HTTP 500 → throw WX_CODE2SESSION_FAILED', async () => {
    fetchSpy.mockResolvedValueOnce({
      status: 500,
      json: async () => ({ errcode: 500, errmsg: 'server error' }),
    } as never);
    await expect(service.exchange('any_code_12345')).rejects.toThrow(
      InternalServerErrorException,
    );
  });

  it('网络异常 → throw WX_CODE2SESSION_NETWORK', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(service.exchange('any_code_12345')).rejects.toThrow(
      InternalServerErrorException,
    );
  });

  it('响应缺 openid → throw WX_CODE2SESSION_INVALID', async () => {
    fetchSpy.mockResolvedValueOnce({
      status: 200,
      json: async () => ({ session_key: 'has_session_key_but_no_openid' }),
    } as never);
    await expect(service.exchange('any_code_12345')).rejects.toThrow(
      InternalServerErrorException,
    );
  });

  it('响应缺 session_key → throw WX_CODE2SESSION_INVALID', async () => {
    fetchSpy.mockResolvedValueOnce({
      status: 200,
      json: async () => ({ openid: 'oTestOpenid_no_session_key' }),
    } as never);
    await expect(service.exchange('any_code_12345')).rejects.toThrow(
      InternalServerErrorException,
    );
  });

  it('errcode=0 视为成功（微信文档：errcode=0 是 happy path）', async () => {
    fetchSpy.mockResolvedValueOnce({
      status: 200,
      json: async () => ({
        errcode: 0,
        errmsg: 'ok',
        openid: 'oTestOpenidErrcodeZero',
        session_key: 'test_session_key',
      }),
    } as never);
    const result = await service.exchange('valid_code_12345');
    expect(result.openid).toBe('oTestOpenidErrcodeZero');
  });

  it('微信 errcode 不透传 client (A05 内部 ID 暴露规避)', async () => {
    fetchSpy.mockResolvedValueOnce({
      status: 200,
      json: async () => ({
        errcode: 40163,
        errmsg: 'code been used',
      }),
    } as never);
    try {
      await service.exchange('any_code_12345');
      throw new Error('should have thrown');
    } catch (err) {
      const response = (err as InternalServerErrorException).getResponse();
      // 错误响应不含 errcode 字段
      expect(JSON.stringify(response)).not.toContain('40163');
      expect(JSON.stringify(response)).not.toContain('code been used');
    }
  });
});
