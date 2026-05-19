import { UploadController } from './upload.controller';

describe('UploadController — 静态白名单 + 大小上限', () => {
  describe('ALLOWED_EXT', () => {
    const cases: Array<[string, boolean]> = [
      // 图片
      ['.jpg', true],
      ['.jpeg', true],
      ['.png', true],
      ['.webp', true],
      ['.gif', true],
      // 视频（V25 R-upload 加：老师业务展示视频）
      ['.mp4', true],
      ['.mov', true],
      ['.webm', true],
      // 拒
      ['.exe', false],
      ['.html', false],
      ['.php', false],
      ['.svg', false], // svg 含脚本风险，不放行
      ['.pdf', false],
      ['.JPG', false], // 大小写敏感，前端必须 toLowerCase
    ];

    it.each(cases)('扩展名 %s → 允许=%s', (ext, allowed) => {
      expect(UploadController.ALLOWED_EXT.has(ext)).toBe(allowed);
    });
  });

  describe('DEFAULT_MAX_BYTES', () => {
    it('20 MB（覆盖 30s 压缩视频）', () => {
      expect(UploadController.DEFAULT_MAX_BYTES).toBe(20 * 1024 * 1024);
    });
  });

  describe('getUploadDir / getPublicBase fallback', () => {
    const SAVED_ENV = { ...process.env };
    afterEach(() => {
      process.env = { ...SAVED_ENV };
    });

    it('无 env → 默认路径', () => {
      delete process.env.UPLOAD_DIR;
      delete process.env.UPLOAD_PUBLIC_BASE;
      expect(UploadController.getUploadDir()).toBe('/home/ubuntu/uploads');
      expect(UploadController.getPublicBase()).toBe('http://1.14.127.67/uploads');
    });

    it('env override 生效', () => {
      process.env.UPLOAD_DIR = '/tmp/test-uploads';
      process.env.UPLOAD_PUBLIC_BASE = 'https://minxin.top/uploads';
      expect(UploadController.getUploadDir()).toBe('/tmp/test-uploads');
      expect(UploadController.getPublicBase()).toBe('https://minxin.top/uploads');
    });
  });
});
