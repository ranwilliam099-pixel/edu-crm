import { Module } from '@nestjs/common';
import { UserService } from './user.service';

/**
 * User 模块（W3-1 sales campus_scope 应用层填充骨架）
 *
 * 来源：
 *   - PM 临时授权《全部人员-审核往来总台账.md》条目 11
 *   - 开发总监查收条目 12
 *
 * PM-TEMP-AUTH(2026-04-30): 主校区单值，等产品最终签字回归
 *
 * 暴露 UserService（无 Controller / 无 Repository — 严守 PM §C 边界）
 * 不暴露 HTTP 路由 — 由 W3 业务编排（待开）注入
 */
@Module({
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
