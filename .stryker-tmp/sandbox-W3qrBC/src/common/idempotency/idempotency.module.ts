import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { IdempotencyInterceptor } from './idempotency.interceptor';

/**
 * IdempotencyModule — 全局注册写操作幂等保护
 *
 * 客户端用法（前端）：
 *   wx.request({
 *     url: '...',
 *     method: 'POST',
 *     header: { 'Idempotency-Key': uuidV4() },
 *     ...
 *   })
 *
 * 服务端：自动拦截全部 POST/PUT/PATCH/DELETE 请求
 */
@Module({
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: IdempotencyInterceptor,
    },
  ],
})
export class IdempotencyModule {}
