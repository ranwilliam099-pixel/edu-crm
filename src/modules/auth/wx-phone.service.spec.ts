import { Test, TestingModule } from '@nestjs/testing';
import { InternalServerErrorException } from '@nestjs/common';
import { WxPhoneService } from './wx-phone.service';
import { WxAccessTokenService } from '../security/wx-access-token.service';

/**
 * WxPhoneService spec — 2026-05-25 微信 getuserphonenumber 换真手机号
 *
 * 覆盖：
 *   1. happy path: errcode=0 + phone_info.purePhoneNumber → 返 11 位纯号
 *   2. errcode!=0 → 抛 InternalServerError + 不透传 errcode/errmsg
 *   3. HTTP 非 2xx → 抛 InternalServerError
 *   4. 网络异常 → 抛 InternalServerError
 *   5. response 缺 phone_info → 抛 WX_PHONE_INVALID
 *   6. non-CN 手机号 → 抛 WX_PHONE_NON_CN
 *   7. code 为空 → 抛 WX_PHONE_CODE_INVALID
 *   8. 复用 WxAccessTokenService 拿 access_token（不直接调微信 cgi-bin/token）
 */

describe('WxPhoneService', () => {
  let service: WxPhoneService;
  let accessToken: { getAccessToken: jest.Mock };
  let fetchSpy: jest.SpyInstance;

  beforeEach(async () => {
    accessToken = { getAccessToken: jest.fn().mockResolvedValue('ACCESS_TOKEN_FAKE') };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WxPhoneService,
        { provide: WxAccessTokenService, useValue: accessToken },
      ],
    }).compile();
    service = module.get<WxPhoneService>(WxPhoneService);
    fetchSpy = jest.spyOn(global, 'fetch' as any);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function mockWxResponse(
    body: any,
    init: { status?: number } = {},
  ) {
    fetchSpy.mockResolvedValueOnce({
      status: init.status ?? 200,
      json: async () => body,
    } as Response);
  }

  it('happy path: errcode=0 + phone_info → 返 11 位 phone + countryCode', async () => {
    mockWxResponse({
      errcode: 0,
      errmsg: 'ok',
      phone_info: {
        phoneNumber: '+86 138****0000',
        purePhoneNumber: '13800001000',
        countryCode: '86',
        watermark: { appid: 'wxc4b3ce5dd7e060b4', timestamp: 1779694956 },
      },
    });
    const r = await service.exchange('0a3xKfXY1qZ2WuABCDEF');
    expect(r.phone).toBe('13800001000');
    expect(r.countryCode).toBe('86');
    expect(r.watermarkAppid).toBe('wxc4b3ce5dd7e060b4');
    expect(accessToken.getAccessToken).toHaveBeenCalledTimes(1);
  });

  it('errcode != 0 → 抛 InternalServerError 不透传 errcode/errmsg (A05)', async () => {
    mockWxResponse({ errcode: 40029, errmsg: 'invalid code' });
    let caught: any;
    try { await service.exchange('badcode123456'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(InternalServerErrorException);
    const body = caught.getResponse();
    expect(body.code).toBe('WX_PHONE_FAILED');
    expect(JSON.stringify(body)).not.toContain('40029');
    expect(JSON.stringify(body)).not.toContain('invalid code');
  });

  it('HTTP 5xx → 抛 InternalServerError WX_PHONE_FAILED', async () => {
    mockWxResponse({ message: 'gateway timeout' }, { status: 502 });
    let caught: any;
    try { await service.exchange('code000001234'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(InternalServerErrorException);
    expect(caught.getResponse().code).toBe('WX_PHONE_FAILED');
  });

  it('网络异常 → 抛 InternalServerError WX_PHONE_NETWORK', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNRESET'));
    let caught: any;
    try { await service.exchange('codenet000001'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(InternalServerErrorException);
    expect(caught.getResponse().code).toBe('WX_PHONE_NETWORK');
  });

  it('response 缺 phone_info → 抛 WX_PHONE_INVALID', async () => {
    mockWxResponse({ errcode: 0, errmsg: 'ok' }); // 缺 phone_info
    let caught: any;
    try { await service.exchange('code000missin'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(InternalServerErrorException);
    expect(caught.getResponse().code).toBe('WX_PHONE_INVALID');
  });

  it('non-CN 手机号 → 抛 WX_PHONE_NON_CN', async () => {
    mockWxResponse({
      errcode: 0,
      phone_info: { purePhoneNumber: '4155551234', countryCode: '1' }, // US 10-digit
    });
    let caught: any;
    try { await service.exchange('codenoncn0001'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(InternalServerErrorException);
    expect(caught.getResponse().code).toBe('WX_PHONE_NON_CN');
  });

  it('code 为空 → 抛 WX_PHONE_CODE_INVALID（不调微信 API）', async () => {
    let caught: any;
    try { await service.exchange(''); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(InternalServerErrorException);
    expect(caught.getResponse().code).toBe('WX_PHONE_CODE_INVALID');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('调微信用 access_token query param + POST body { code }', async () => {
    mockWxResponse({
      errcode: 0,
      phone_info: { purePhoneNumber: '13800001234', countryCode: '86' },
    });
    await service.exchange('codetest98765');
    const callArgs = fetchSpy.mock.calls[0];
    const url = callArgs[0] as string;
    const init = callArgs[1] as RequestInit;
    expect(url).toContain('https://api.weixin.qq.com/wxa/business/getuserphonenumber');
    expect(url).toContain('access_token=ACCESS_TOKEN_FAKE');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ code: 'codetest98765' });
  });
});
