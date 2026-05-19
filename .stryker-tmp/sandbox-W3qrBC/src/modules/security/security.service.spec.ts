import { Test, TestingModule } from '@nestjs/testing';
import { SecurityService, MsgSecScene } from './security.service';
import { WxAccessTokenService } from './wx-access-token.service';

describe('SecurityService', () => {
  let service: SecurityService;
  let token: { getAccessToken: jest.Mock };
  let fetchMock: jest.Mock;

  beforeEach(async () => {
    token = {
      getAccessToken: jest.fn().mockResolvedValue('fake_access_token'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SecurityService,
        { provide: WxAccessTokenService, useValue: token },
      ],
    }).compile();

    service = module.get(SecurityService);

    fetchMock = jest.fn();
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
  });

  describe('msgSecCheck', () => {
    const VALID_OPENID = 'o-FakeOpenid-abc123XYZ_-';
    const VALID_CONTENT = '正常的用户输入文本';

    it('errcode=0 + suggest=pass → ok=true', async () => {
      fetchMock.mockResolvedValueOnce({
        json: async () => ({
          errcode: 0,
          errmsg: 'ok',
          result: { suggest: 'pass', label: 100 },
        }),
      });
      const res = await service.msgSecCheck(VALID_CONTENT, VALID_OPENID);
      expect(res.ok).toBe(true);
      expect(res.suggest).toBe('pass');
      expect(res.label).toBe(100);
      expect(res.errcode).toBe(0);
    });

    it('errcode=0 + suggest=risky → ok=false, suggest=risky', async () => {
      fetchMock.mockResolvedValueOnce({
        json: async () => ({
          errcode: 0,
          errmsg: 'ok',
          result: { suggest: 'risky', label: 20001 },
        }),
      });
      const res = await service.msgSecCheck(VALID_CONTENT, VALID_OPENID);
      expect(res.ok).toBe(false);
      expect(res.suggest).toBe('risky');
      expect(res.label).toBe(20001);
    });

    it('errcode=0 + suggest=review → ok=false, suggest=review', async () => {
      fetchMock.mockResolvedValueOnce({
        json: async () => ({
          errcode: 0,
          errmsg: 'ok',
          result: { suggest: 'review', label: 20001 },
        }),
      });
      const res = await service.msgSecCheck(VALID_CONTENT, VALID_OPENID);
      expect(res.ok).toBe(false);
      expect(res.suggest).toBe('review');
    });

    it('errcode=87014 → ok=false, suggest=risky', async () => {
      fetchMock.mockResolvedValueOnce({
        json: async () => ({
          errcode: 87014,
          errmsg: 'risky content',
        }),
      });
      const res = await service.msgSecCheck(VALID_CONTENT, VALID_OPENID);
      expect(res.ok).toBe(false);
      expect(res.suggest).toBe('risky');
      expect(res.label).toBe('内容含违法违规');
      expect(res.errcode).toBe(87014);
    });

    it('errcode 未知（如 40001）→ ok=false, suggest=review', async () => {
      fetchMock.mockResolvedValueOnce({
        json: async () => ({
          errcode: 40001,
          errmsg: 'invalid credential',
        }),
      });
      const res = await service.msgSecCheck(VALID_CONTENT, VALID_OPENID);
      expect(res.ok).toBe(false);
      expect(res.suggest).toBe('review');
      expect(res.errcode).toBe(40001);
      expect(res.errmsg).toBe('invalid credential');
    });

    it('fetch 网络异常 → 不抛错，返回 review', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
      const res = await service.msgSecCheck(VALID_CONTENT, VALID_OPENID);
      expect(res.ok).toBe(false);
      expect(res.suggest).toBe('review');
      expect(res.errmsg).toBe('ECONNRESET');
    });

    it('scene 默认 PROFILE=1', async () => {
      fetchMock.mockResolvedValueOnce({
        json: async () => ({ errcode: 0, result: { suggest: 'pass' } }),
      });
      await service.msgSecCheck(VALID_CONTENT, VALID_OPENID);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.scene).toBe(1);
      expect(body.version).toBe(2);
      expect(body.content).toBe(VALID_CONTENT);
      expect(body.openid).toBe(VALID_OPENID);
    });

    it('scene 显式传 COMMENT=2', async () => {
      fetchMock.mockResolvedValueOnce({
        json: async () => ({ errcode: 0, result: { suggest: 'pass' } }),
      });
      await service.msgSecCheck(VALID_CONTENT, VALID_OPENID, MsgSecScene.COMMENT);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.scene).toBe(2);
    });

    it('URL 含 access_token query', async () => {
      fetchMock.mockResolvedValueOnce({
        json: async () => ({ errcode: 0, result: { suggest: 'pass' } }),
      });
      await service.msgSecCheck(VALID_CONTENT, VALID_OPENID);
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('https://api.weixin.qq.com/wxa/msg_sec_check');
      expect(url).toContain('access_token=fake_access_token');
    });

    it('上游 access_token 失败 → 抛上去（不吞）', async () => {
      token.getAccessToken.mockRejectedValueOnce(new Error('WX_TOKEN_FAILED'));
      await expect(
        service.msgSecCheck(VALID_CONTENT, VALID_OPENID),
      ).rejects.toThrow('WX_TOKEN_FAILED');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('serverSideCheckContent (F-08 v1 免 openid)', () => {
    const NORMAL_CONTENT = '某某教育培训中心';

    it('errcode=0 + result.suggest=pass → ok=true', async () => {
      fetchMock.mockResolvedValueOnce({
        json: async () => ({
          errcode: 0,
          errmsg: 'ok',
          result: { suggest: 'pass', label: 100 },
        }),
      });
      const res = await service.serverSideCheckContent(NORMAL_CONTENT);
      expect(res.ok).toBe(true);
      expect(res.suggest).toBe('pass');
      expect(res.label).toBe(100);
      expect(res.errcode).toBe(0);
    });

    it('errcode=0 兜底（v1 老接口不返 result）→ ok=true, suggest=pass', async () => {
      fetchMock.mockResolvedValueOnce({
        json: async () => ({ errcode: 0, errmsg: 'ok' }),
      });
      const res = await service.serverSideCheckContent(NORMAL_CONTENT);
      expect(res.ok).toBe(true);
      expect(res.suggest).toBe('pass');
      expect(res.errcode).toBe(0);
    });

    it('errcode=87014 → ok=false, suggest=risky', async () => {
      fetchMock.mockResolvedValueOnce({
        json: async () => ({
          errcode: 87014,
          errmsg: 'risky content',
        }),
      });
      const res = await service.serverSideCheckContent('违规内容示例');
      expect(res.ok).toBe(false);
      expect(res.suggest).toBe('risky');
      expect(res.label).toBe('内容含违法违规');
      expect(res.errcode).toBe(87014);
    });

    it('errcode 未知（40001）→ ok=false, suggest=review (fail-open)', async () => {
      fetchMock.mockResolvedValueOnce({
        json: async () => ({
          errcode: 40001,
          errmsg: 'invalid credential',
        }),
      });
      const res = await service.serverSideCheckContent(NORMAL_CONTENT);
      expect(res.ok).toBe(false);
      expect(res.suggest).toBe('review');
      expect(res.errcode).toBe(40001);
      expect(res.errmsg).toBe('invalid credential');
    });

    it('fetch 网络异常 → 不抛错，返回 review (fail-open)', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
      const res = await service.serverSideCheckContent(NORMAL_CONTENT);
      expect(res.ok).toBe(false);
      expect(res.suggest).toBe('review');
      expect(res.errmsg).toBe('ECONNRESET');
    });

    it('上游 access_token 失败 → 抛上去（不吞，caller fail-open）', async () => {
      token.getAccessToken.mockRejectedValueOnce(new Error('WX_TOKEN_FAILED'));
      await expect(
        service.serverSideCheckContent(NORMAL_CONTENT),
      ).rejects.toThrow('WX_TOKEN_FAILED');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('body 仅 content（不含 version/openid/scene v1 形态）', async () => {
      fetchMock.mockResolvedValueOnce({
        json: async () => ({ errcode: 0 }),
      });
      await service.serverSideCheckContent(NORMAL_CONTENT);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body).toEqual({ content: NORMAL_CONTENT });
      expect(body.version).toBeUndefined();
      expect(body.openid).toBeUndefined();
      expect(body.scene).toBeUndefined();
    });

    it('URL 含 access_token query', async () => {
      fetchMock.mockResolvedValueOnce({
        json: async () => ({ errcode: 0 }),
      });
      await service.serverSideCheckContent(NORMAL_CONTENT);
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('https://api.weixin.qq.com/wxa/msg_sec_check');
      expect(url).toContain('access_token=fake_access_token');
    });

    it('errcode=0 + result.suggest=review → ok=false, suggest=review', async () => {
      fetchMock.mockResolvedValueOnce({
        json: async () => ({
          errcode: 0,
          result: { suggest: 'review', label: 20001 },
        }),
      });
      const res = await service.serverSideCheckContent(NORMAL_CONTENT);
      expect(res.ok).toBe(false);
      expect(res.suggest).toBe('review');
    });

    it('errcode=0 + result.suggest=risky → ok=false, suggest=risky (v2 形态在 v1 URL 也兼容)', async () => {
      fetchMock.mockResolvedValueOnce({
        json: async () => ({
          errcode: 0,
          result: { suggest: 'risky', label: 20001 },
        }),
      });
      const res = await service.serverSideCheckContent(NORMAL_CONTENT);
      expect(res.ok).toBe(false);
      expect(res.suggest).toBe('risky');
      expect(res.label).toBe(20001);
    });
  });

  describe('imgSecCheck', () => {
    const VALID_OPENID = 'o-FakeOpenid-abc123XYZ_-';
    const imageBuffer = Buffer.from('fake image bytes');

    it('errcode=0 → ok=true, suggest=pass', async () => {
      fetchMock.mockResolvedValueOnce({
        json: async () => ({ errcode: 0, errmsg: 'ok' }),
      });
      const res = await service.imgSecCheck(imageBuffer, VALID_OPENID);
      expect(res.ok).toBe(true);
      expect(res.suggest).toBe('pass');
      expect(res.errcode).toBe(0);
    });

    it('errcode=87014 → ok=false, suggest=risky', async () => {
      fetchMock.mockResolvedValueOnce({
        json: async () => ({ errcode: 87014, errmsg: 'risky' }),
      });
      const res = await service.imgSecCheck(imageBuffer, VALID_OPENID);
      expect(res.ok).toBe(false);
      expect(res.suggest).toBe('risky');
      expect(res.label).toBe('图片含违法违规');
      expect(res.errcode).toBe(87014);
    });

    it('errcode 未知 → ok=false, suggest=review', async () => {
      fetchMock.mockResolvedValueOnce({
        json: async () => ({ errcode: 40001, errmsg: 'invalid credential' }),
      });
      const res = await service.imgSecCheck(imageBuffer, VALID_OPENID);
      expect(res.ok).toBe(false);
      expect(res.suggest).toBe('review');
      expect(res.errcode).toBe(40001);
    });

    it('fetch 网络异常 → 不抛错，返回 review', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ETIMEDOUT'));
      const res = await service.imgSecCheck(imageBuffer, VALID_OPENID);
      expect(res.ok).toBe(false);
      expect(res.suggest).toBe('review');
      expect(res.errmsg).toBe('ETIMEDOUT');
    });

    it('URL 含 access_token 且 body 是 FormData', async () => {
      fetchMock.mockResolvedValueOnce({
        json: async () => ({ errcode: 0 }),
      });
      await service.imgSecCheck(imageBuffer, VALID_OPENID);
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('https://api.weixin.qq.com/wxa/img_sec_check');
      expect(url).toContain('access_token=fake_access_token');
      const opts = fetchMock.mock.calls[0][1] as { method: string; body: unknown };
      expect(opts.method).toBe('POST');
      // FormData 是 Web Standard，instance 形态，body 包 media + openid
      expect(opts.body).toBeInstanceOf(FormData);
      const fd = opts.body as FormData;
      expect(fd.get('openid')).toBe(VALID_OPENID);
      expect(fd.get('media')).toBeInstanceOf(Blob);
    });

    it('上游 access_token 失败 → 抛上去（不吞）', async () => {
      token.getAccessToken.mockRejectedValueOnce(new Error('WX_TOKEN_FAILED'));
      await expect(
        service.imgSecCheck(imageBuffer, VALID_OPENID),
      ).rejects.toThrow('WX_TOKEN_FAILED');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('自定义 mimeType (image/png) → Blob.type 正确', async () => {
      fetchMock.mockResolvedValueOnce({
        json: async () => ({ errcode: 0 }),
      });
      await service.imgSecCheck(imageBuffer, VALID_OPENID, 'image/png');
      const opts = fetchMock.mock.calls[0][1] as { body: FormData };
      const blob = opts.body.get('media') as Blob;
      expect(blob.type).toBe('image/png');
    });
  });
});
