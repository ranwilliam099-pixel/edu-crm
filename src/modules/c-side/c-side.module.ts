import { Module } from '@nestjs/common';
import { CSideController } from './c-side.controller';
import { CSideRepository } from './c-side.repository';
import { ParentSelfGuard } from '../auth/parent-self.guard';

/**
 * CSideModule — P4-Y 2026-05-20 C 端家长聚合
 *
 * 路由前缀：/api/c
 *
 * 端点：
 *   GET   /api/c/home                            家长 home 一站式聚合
 *   GET   /api/c/students/:studentId/profile     C 端学员档案（家长视角脱敏）
 *   GET   /api/c/messages                        消息中心
 *   PATCH /api/c/messages/:id/mark-read          标记已读
 *
 * 依赖：
 *   - DbModule (@Global)：ParentRepository / AuditLogRepository / PgPoolService 自动注入
 *   - AuthModule (@Global)：ParentSelfGuard / JwtStrategy
 *
 * CSideRepository 注册在本 module（仅本 module controller 用，不导出避免 RBAC 污染）
 */
@Module({
  controllers: [CSideController],
  providers: [CSideRepository, ParentSelfGuard],
})
export class CSideModule {}
