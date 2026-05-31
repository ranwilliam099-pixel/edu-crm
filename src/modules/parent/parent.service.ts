import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  Optional,
} from '@nestjs/common';
import { ulid } from 'ulid';
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
// Sprint X.2 (V47 2026-05-17) — public.parents.status 中文双态 (active/suspended/deleted → 启用/停用)
//   旧 enum 'active' / 'suspended' / 'deleted' 已 backfill 至 '启用' / '停用' (V47 migration)
//   保留旧值兼容期 (mapParentRow 解 DB 行；V47 deploy 前过渡期 backfill 进行中) 不影响生产
//   TS 类型仅含新枚举, 旧值通过 unknown 转换或类型断言绕过 (parent.service.ts:87 register 兼容期保留 'active')
export type ParentStatus = '启用' | '停用';
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
  // Phase 3 (2026-05-30 item #2) — C 端「我的孩子」可读性增强（仅 enriched 查询填充）
  //   前端 c/binding/children 现 fallback「孩子」「—」「—」parentCount=1，本次补真值。
  //   studentName  = students.student_name（tenant schema, V2 列名）
  //   gradeOrAge   = students.grade_or_age（可空）
  //   campusName   = campuses.name（经 students.customer_id→customers.campus_id→campuses；
  //                  students 表无 campus_id 列，故走 customer 间接 JOIN）
  //   parentCount  = COUNT(active public.parent_student_bindings WHERE student_id)
  //   非 enriched 路径（findChildrenByParent / insertBinding 等）字段为 undefined（向后兼容）。
  studentName?: string;
  gradeOrAge?: string;
  campusName?: string;
  parentCount?: number;
}

@Injectable()
export class ParentService {
  private readonly logger = new Logger(ParentService.name);

  constructor(@Optional() private readonly repo?: ParentRepository) {}

  /**
   * #3a 修复 (2026-05-31)：32-char ULID 生成（项目全局约定）
   *
   * 背景：`ulid()` 返回标准 26-char ULID，但本项目所有主键列是 VARCHAR(32)，
   *   且 registerParent / createBinding 等强校验 `id.length === 32`。
   *   `createFromCustomerInDb` 历史用裸 `ulid()`（26 char）建 parent/binding id →
   *   registerParent 立即抛 BadRequestException('parent id must be 32-char ULID') →
   *   被 controller try-catch 吞成 parentAccountSet:false（销售「设为家长端账户」全失败）。
   *
   * 全库统一约定（teacher-change-request / user.controller / customer.repository /
   *   parent-binding.controller 等 9+ 处）：`ulid().padEnd(32, '0').slice(0, 32)`。
   *   本 helper 收口该约定，避免再有裸 `ulid()` 漏网。
   */
  private genId32(): string {
    return ulid().padEnd(32, '0').slice(0, 32);
  }

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
      // V47 (Sprint X.2 2026-05-17) — 中文 status 默认 '启用'
      status: '启用',
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

  /**
   * § 12B (2026-05-21) 拍板：从客户家长信息一键创建 parent 账户 + 绑定学员
   *
   * 用途：销售在 sales-customers/new 表单打勾「设为家长端账户」，或在 detail 页后补打勾
   *
   * 步骤（事务外但幂等）：
   *   1. findParentByPhone(phone) — 跨 tenant phone_hash 查 public.parents
   *   2. miss → insertParent(ulid, phone, name, status='启用')
   *   3. findActiveBindingsForStudent(studentId) — 取该学员当前所有家长绑定
   *   4. createBinding 校验（3 上限 + 重复检测，V10 DB 触发器兜底）
   *   5. insertBinding
   *   6. 返回 { parent, binding, isNewParent }
   *
   * Reuse 路径（同手机号跨 tenant 已建 parent）：直接走步骤 3-5，不重建 parent
   *
   * @param input.studentId  学员 ULID
   * @param input.tenantId   学员所属 tenant ULID（写 parent_student_bindings.tenant_id）
   * @param input.phone      家长手机号（由 controller 反查 customers.primary_mobile 拿到）
   * @param input.name       家长姓名（可空，由 controller 反查 customers.parent_name）
   * @param input.relationship 关系（默认 'mother'，前端可改）
   */
  async createFromCustomerInDb(input: {
    studentId: string;
    tenantId: string;
    phone: string;
    name?: string;
    relationship?: Relationship;
  }): Promise<{ parent: Parent; binding: ParentStudentBinding; isNewParent: boolean }> {
    if (!this.repo) throw new BadRequestException('ParentRepository not available');
    if (!input.studentId || input.studentId.length !== 32) {
      throw new BadRequestException('studentId must be 32-char ULID');
    }
    if (!input.tenantId || input.tenantId.length !== 32) {
      throw new BadRequestException('tenantId must be 32-char ULID');
    }
    if (!input.phone || !/^1[3-9]\d{9}$/.test(input.phone)) {
      throw new BadRequestException('家长手机号必须是 11 位中国手机号格式');
    }

    // 1. 跨 tenant 复用 parent
    let parent = await this.repo.findParentByPhone(input.phone);
    let isNewParent = false;

    if (!parent) {
      // 2. 不存在 → 新建
      //   #3a 修复：必须用 genId32（32-char），裸 ulid()=26-char 会被 registerParent 拒
      const newParent = this.registerParent({
        id: this.genId32(),
        phone: input.phone,
        name: input.name,
      });
      parent = await this.repo.insertParent(newParent);
      isNewParent = true;
      this.logger.log(
        `[§12B] createFromCustomer 新建 parent id=${parent.id} phone=***${input.phone.slice(-4)}`,
      );
    } else {
      this.logger.log(
        `[§12B] createFromCustomer 复用已有 parent id=${parent.id} (跨 tenant 共享)`,
      );
    }

    // 3. 查该 student 当前所有 binding（用于 3 上限校验 + 重复检测）
    const existing = await this.repo.findActiveBindingsForStudent(input.studentId);

    // 已有该 parent + student binding → 幂等返回（不重复 INSERT，不抛错）
    const existingBinding = existing.find(
      (b) => b.parentId === parent!.id && b.bindingStatus === 'active',
    );
    if (existingBinding) {
      this.logger.log(
        `[§12B] createFromCustomer 幂等返回已有 binding id=${existingBinding.id}`,
      );
      return { parent, binding: existingBinding, isNewParent };
    }

    // 4. 校验 + 5. INSERT
    //   #3a 修复：binding id 同样必须 32-char（createBinding 强校验 id.length===32）
    const binding = this.createBinding(
      {
        id: this.genId32(),
        parentId: parent.id,
        studentId: input.studentId,
        tenantId: input.tenantId,
        isPrimary: existing.filter((b) => b.bindingStatus === 'active').length === 0,
        relationship: input.relationship || 'mother',
      },
      existing,
    );
    const inserted = await this.repo.insertBinding(binding);
    return { parent, binding: inserted, isNewParent };
  }

  async listMyChildrenInDb(
    parentId: string,
    callerParentId?: string,
  ): Promise<ParentStudentBinding[]> {
    if (!this.repo) throw new BadRequestException('ParentRepository not available');
    this.assertOwnership(parentId, callerParentId);
    // Phase 3 (2026-05-30 item #2) — 用 enriched 查询补 studentName/gradeOrAge/campusName/parentCount
    //   旧 findChildrenByParent 仍保留（其它调用方 / ownership 反查用）；C 端列表走 enriched 版。
    return this.repo.findChildrenByParentEnriched(parentId);
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
