import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { SecurityController } from './security.controller';
import { SecurityService } from './security.service';

describe('SecurityController', () => {
  let controller: SecurityController;
  let security: { msgSecCheck: jest.Mock; imgSecCheck: jest.Mock };

  const VALID_OPENID = 'o-FakeOpenid-abc123XYZ_-';

  beforeEach(async () => {
    security = {
      msgSecCheck: jest.fn(),
      imgSecCheck: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SecurityController],
      providers: [{ provide: SecurityService, useValue: security }],
    }).compile();

    controller = module.get(SecurityController);
  });

  describe('POST /security/msg-check', () => {
    it('合法请求 → 透传 service 结果', async () => {
      security.msgSecCheck.mockResolvedValueOnce({ ok: true, suggest: 'pass' });
      const res = await controller.msgCheck({
        content: 'hello',
        openid: VALID_OPENID,
      });
      expect(res).toEqual({ ok: true, suggest: 'pass' });
      expect(security.msgSecCheck).toHaveBeenCalledWith('hello', VALID_OPENID, 1);
    });

    it('显式 scene=2 → 透传', async () => {
      security.msgSecCheck.mockResolvedValueOnce({ ok: true, suggest: 'pass' });
      await controller.msgCheck({
        content: 'hello',
        openid: VALID_OPENID,
        scene: 2,
      });
      expect(security.msgSecCheck).toHaveBeenCalledWith('hello', VALID_OPENID, 2);
    });

    it('content 缺 → 400', async () => {
      await expect(
        controller.msgCheck({ openid: VALID_OPENID }),
      ).rejects.toThrow(BadRequestException);
    });

    it('content 不是 string → 400', async () => {
      await expect(
        controller.msgCheck({
          content: 12345 as unknown as string,
          openid: VALID_OPENID,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('content 空字符串 → 400', async () => {
      await expect(
        controller.msgCheck({ content: '', openid: VALID_OPENID }),
      ).rejects.toThrow(BadRequestException);
    });

    it('content > 2500 字 → 400', async () => {
      const long = 'a'.repeat(2501);
      await expect(
        controller.msgCheck({ content: long, openid: VALID_OPENID }),
      ).rejects.toThrow(BadRequestException);
    });

    it('content = 2500 字（边界）→ 通过', async () => {
      security.msgSecCheck.mockResolvedValueOnce({ ok: true, suggest: 'pass' });
      const long = 'a'.repeat(2500);
      const res = await controller.msgCheck({
        content: long,
        openid: VALID_OPENID,
      });
      expect(res.ok).toBe(true);
    });

    it('openid 缺 → 400', async () => {
      await expect(
        controller.msgCheck({ content: 'hi' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('openid 格式不合法（短）→ 400', async () => {
      await expect(
        controller.msgCheck({ content: 'hi', openid: 'short' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('openid 格式不合法（特殊字符）→ 400', async () => {
      await expect(
        controller.msgCheck({
          content: 'hi',
          openid: 'invalid<>openid<<<<>>>>',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('scene 非 1/2/3/4 → 400', async () => {
      await expect(
        controller.msgCheck({
          content: 'hi',
          openid: VALID_OPENID,
          scene: 99,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('scene 非 number → 400', async () => {
      await expect(
        controller.msgCheck({
          content: 'hi',
          openid: VALID_OPENID,
          scene: '1' as unknown as number,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('service 返回 risky → 透传', async () => {
      security.msgSecCheck.mockResolvedValueOnce({
        ok: false,
        suggest: 'risky',
        label: 20001,
      });
      const res = await controller.msgCheck({
        content: 'risky content',
        openid: VALID_OPENID,
      });
      expect(res.ok).toBe(false);
      expect(res.suggest).toBe('risky');
    });
  });

  describe('POST /security/img-check', () => {
    const buildFile = (
      size: number = 1000,
      mime: string = 'image/jpeg',
    ): Express.Multer.File =>
      ({
        buffer: Buffer.alloc(size),
        size,
        mimetype: mime,
        originalname: 'test.jpg',
        fieldname: 'image',
        encoding: '7bit',
        stream: undefined as never,
        destination: '',
        filename: '',
        path: '',
      } as unknown as Express.Multer.File);

    it('合法图片 → 透传 service 结果', async () => {
      security.imgSecCheck.mockResolvedValueOnce({ ok: true, suggest: 'pass' });
      const file = buildFile(1024, 'image/jpeg');
      const res = await controller.imgCheck(file, VALID_OPENID);
      expect(res).toEqual({ ok: true, suggest: 'pass' });
      expect(security.imgSecCheck).toHaveBeenCalledWith(
        file.buffer,
        VALID_OPENID,
        'image/jpeg',
      );
    });

    it('无 file → 400', async () => {
      await expect(controller.imgCheck(undefined, VALID_OPENID)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('空 buffer → 400', async () => {
      const file = {
        ...buildFile(),
        buffer: Buffer.alloc(0),
      } as unknown as Express.Multer.File;
      await expect(controller.imgCheck(file, VALID_OPENID)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('size > 1MB → 400', async () => {
      // size 字段超 1MB（buffer 不必真的 1MB，controller 看 size 字段）
      const file = {
        ...buildFile(1024),
        size: 1024 * 1024 + 1,
      } as unknown as Express.Multer.File;
      await expect(controller.imgCheck(file, VALID_OPENID)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('openid 缺 → 400', async () => {
      const file = buildFile();
      await expect(controller.imgCheck(file, undefined)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('openid 格式不合法 → 400', async () => {
      const file = buildFile();
      await expect(controller.imgCheck(file, 'short')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('service 返回 risky → 透传', async () => {
      security.imgSecCheck.mockResolvedValueOnce({
        ok: false,
        suggest: 'risky',
        label: '图片含违法违规',
      });
      const file = buildFile();
      const res = await controller.imgCheck(file, VALID_OPENID);
      expect(res.ok).toBe(false);
      expect(res.suggest).toBe('risky');
    });

    it('image/png mime → 透传 mimetype', async () => {
      security.imgSecCheck.mockResolvedValueOnce({ ok: true, suggest: 'pass' });
      const file = buildFile(1024, 'image/png');
      await controller.imgCheck(file, VALID_OPENID);
      expect(security.imgSecCheck).toHaveBeenCalledWith(
        file.buffer,
        VALID_OPENID,
        'image/png',
      );
    });
  });
});
