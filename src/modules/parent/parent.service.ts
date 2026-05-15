import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  Optional,
} from '@nestjs/common';
import { ParentRepository } from '../db/parent.repository';

/**
 * ParentService — V10 家长身份 + 学员绑定 BE-V10-1
 *
 * 来源：
 *   - 《PD设计稿-排课-教学反馈-家长订阅-V1-2026-05-02.md》§5
 *   - 用户拍板《全部人员-审核往来总台账.md》条目 31 #3 跨机构共享 + 条目 32 L3
 *   - PD 硬规则 P8（单孩最多 3 家长）+ P11（多家长各自支付）
 *
 * USER-AUTH(2026-05-02): 家长 C 端跨租户身份；单孩最多 3 家长；退订后保留绑定（条目 32 #10）
 */
export type ParentStatus = 'active' | 'suspended' | 'deleted';
export type Relationship =
  | 'father'
  | 'mother'
  | 'grandfather'
  | 'grandmother'
  | 'guardian'
  | 'other';
export type BindingStatus = 'active' | 'unbound';

export interface Parent {
  id: string;
  phone: string;
  wechatOpenid?: string;
  wechatUnionid?: string;
  name?: string;
  avatarUrl?: string;
  status: ParentStatus;
}

export interface ParentStudentBinding {
  id: string;
  parentId: string;
  studentId: string;
  tenantId: string;
  isPrimary: boolean;
  relationship: Relationship;
  bindingStatus: BindingStatus;
  boundAt: Date;
  unboundAt?: Date;
}

@Injectable()
export class ParentService {
  private readonly logger = new Logger(ParentService.name);

  constructor(@Optional() private readonly repo?: ParentRepository) {}

  /**
   * 注册家长（小程序 OAuth 后调用）
   */
  registerParent(input: {
    id: string;
    phone: string;
    wechatOpenid?: string;
    wechatUnionid?: string;
    name?: string;
    avatarUrl?: string;
  }): Parent {
    if (!input.id || input.id.length !== 32) {
      throw new BadRequestException('parent id must be 32-char ULID');
    }
    if (!input.phone || !/^1[3-9]\d{9}$/.test(input.phone)) {
      throw new BadRequestException('phone must be valid 11-digit Chinese mobile');
    }
    if (input.wechatOpenid !== undefined && input.wechatOpenid.length === 0) {
      throw new BadRequestException('wechatOpenid (if provided) cannot be empty');
    }
    this.logger.log(`[BE-V10-1] registerParent id=${input.id} phone=***${input.phone.slice(-4)}`);
    return {
      id: input.id,
      phone: input.phone,
      wechatOpenid: input.wechatOpenid,
      wechatUnionid: input.wechatUnionid,
      name: input.name,
      avatarUrl: input.avatarUrl,
      status: 'active',
    };
  }

  /**
   * 创建家长-学员绑定
   *
   * P8 单孩最多 3 家长（应用层校验，DB 触发器兜底）
   *
   * @param existingActiveBindings 该 student_id 当前已 active 的绑定列表（用于 3 家长上限校验）
   * @throws ConflictException 已达 3 家长上限
   * @throws BadRequestException 输入校验失败
   */
  createBinding(
    input: {
      id: string;
      parentId: string;
      studentId: string;
      tenantId: string;
      isPrimary?: boolean;
      relationship: Relationship;
    },
    existingActiveBindings: ReadonlyArray<ParentStudentBinding>,
  ): ParentStudentBinding {
    if (!input.id || input.id.length !== 32) {
      throw new BadRequestException('binding id must be 32-char ULID');
    }
    if (!input.parentId || input.parentId.length !== 32) {
      throw new BadRequestException('parentId must be 32-char ULID');
    }
    if (!input.studentId || input.studentId.length !== 32) {
      throw new BadRequestException('studentId must be 32-char ULID');
    }
    if (!input.tenantId || input.tenantId.length !== 32) {
      throw new BadRequestException('tenantId must be 32-char ULID');
    }
    if (
      !['father', 'mother', 'grandfather', 'grandmother', 'guardian', 'other'].includes(
        input.relationship,
      )
    ) {
      throw new BadRequestException(`relationship 必须是 father/mother/grandfather/grandmother/guardian/other`);
    }

    // P8 单孩最多 3 家长校验（DB 触发器兜底；应用层先抛 ConflictException 友好提示）
    const activeForStudent = existingActiveBindings.filter(
      (b) => b.studentId === input.studentId && b.bindingStatus === 'active',
    );
    if (activeForStudent.length >= 3) {
      throw new ConflictException('STUDENT_MAX_3_PARENTS_EXCEEDED');
    }

    // 同一家长绑同一学员不可重复
    if (
      activeForStudent.some(
        (b) => b.parentId === input.parentId && b.bindingStatus === 'active',
      )
    ) {
      throw new ConflictException('PARENT_ALREADY_BOUND_TO_STUDENT');
    }

    return {
      id: input.id,
      parentId: input.parentId,
      studentId: input.studentId,
      tenantId: input.tenantId,
      isPrimary: input.isPrimary ?? false,
      relationship: input.relationship,
      bindingStatus: 'active',
      boundAt: new Date(),
    };
  }

  /**
   * 解绑（条目 32 #10：保留 binding 行，仅标记 unbound）
   */
  unbindStudent(binding: ParentStudentBinding): ParentStudentBinding {
    if (binding.bindingStatus === 'unbound') {
      throw new BadRequestException('binding already unbound');
    }
    return {
      ...binding,
      bindingStatus: 'unbound',
      unboundAt: new Date(),
    };
  }

  // ============= 真存盘版 =============

  async registerParentInDb(input: {
    id: string;
    phone: string;
    wechatOpenid?: string;
    wechatUnionid?: string;
    name?: string;
    avatarUrl?: string;
  }): Promise<Parent> {
    if (!this.repo) throw new BadRequestException('ParentRepository not available');
    const parent = this.registerParent(input);
    return this.repo.insertParent(parent);
  }

  /**
   * T6b (2026-05-16) 二道防御：service 层 assert caller (jwt.sub) === 操作目标 parentId.
   * Guard 层已校验 path :parentId === jwt.sub；service 层覆盖非 HTTP 调用（cron / 跨服务调用）.
   * callerParentId 缺失（undefined）→ 视为来自合法的内部调用（如 register 不走此校验），跳过.
   */
  private assertOwnership(targetParentId: string, callerParentId?: string): void {
    if (callerParentId === undefined) return;
    if (callerParentId !== targetParentId) {
      throw new ForbiddenException('parent_self_mismatch');
    }
  }

  async createBindingInDb(
    input: {
      id: string;
      parentId: string;
      studentId: string;
      tenantId: string;
      isPrimary?: boolean;
      relationship: Relationship;
    },
    callerParentId?: string,
  ): Promise<ParentStudentBinding> {
    if (!this.repo) throw new BadRequestException('ParentRepository not available');
    this.assertOwnership(input.parentId, callerParentId);
    const existing = await this.repo.findActiveBindingsForStudent(input.studentId);
    const binding = this.createBinding(input, existing);
    return this.repo.insertBinding(binding);
  }

  async listMyChildrenInDb(
    parentId: string,
    callerParentId?: string,
  ): Promise<ParentStudentBinding[]> {
    if (!this.repo) throw new BadRequestException('ParentRepository not available');
    this.assertOwnership(parentId, callerParentId);
    return this.repo.findChildrenByParent(parentId);
  }

  /**
   * T6b: unbind path 无 :parentId, Guard 跳过 → service 层用 callerParentId 反查
   * binding 归属（防一个 parent 解绑另一个 parent 的 binding）.
   * callerParentId 缺失 → 跳过 ownership（兼容旧调用方 / cron）.
   */
  async unbindBindingInDb(
    bindingId: string,
    callerParentId?: string,
  ): Promise<ParentStudentBinding> {
    if (!this.repo) throw new BadRequestException('ParentRepository not available');
    if (callerParentId !== undefined) {
      const ownedBindings = await this.repo.findChildrenByParent(callerParentId);
      const owned = ownedBindings.some((b) => b.id === bindingId);
      if (!owned) {
        throw new ForbiddenException('parent_self_mismatch');
      }
    }
    return this.repo.unbind(bindingId);
  }

  /**
   * 查询某家长当前 active 绑定的孩子（用于 C-03 我的孩子列表）
   */
  listMyChildren(
    parentId: string,
    allBindings: ReadonlyArray<ParentStudentBinding>,
  ): ParentStudentBinding[] {
    return allBindings.filter(
      (b) => b.parentId === parentId && b.bindingStatus === 'active',
    );
  }

  /**
   * 查询某学员当前 active 的家长数（用于 P8 上限可视化提示）
   */
  countActiveParentsForStudent(
    studentId: string,
    allBindings: ReadonlyArray<ParentStudentBinding>,
  ): number {
    return allBindings.filter(
      (b) => b.studentId === studentId && b.bindingStatus === 'active',
    ).length;
  }
}
