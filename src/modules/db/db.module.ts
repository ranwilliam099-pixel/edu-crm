import { Global, Module } from '@nestjs/common';
import { PgPoolService } from './pg-pool.service';
import { TenantProvisionService } from './tenant-provision.service';
import { TeacherRepository } from './teacher.repository';
import { OnboardingController } from './onboarding.controller';

/**
 * DbModule — 全局 PG 接入 + 租户开通 + Repository 层
 *
 * @Global() 让 Repository 可在任意业务模块注入而不必重复 imports
 *
 * 用户 2026-05-02「做啊」触发：让数据真存盘
 */
@Global()
@Module({
  controllers: [OnboardingController],
  providers: [PgPoolService, TenantProvisionService, TeacherRepository],
  exports: [PgPoolService, TenantProvisionService, TeacherRepository],
})
export class DbModule {}
