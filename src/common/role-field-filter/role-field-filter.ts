/**
 * RoleFieldFilter — Sprint B.3（2026-05-11）
 *
 * 拍板：docs/fields-by-role.md 第 II 节「5 个核心对象 × 字段集 × 角色矩阵」
 *
 * 设计选项调研（main session leader 推荐 B+C 混合）：
 *   - A 装饰器 + Interceptor：反射元数据，复杂，调试难
 *   - B 显式 helper 调用：每 controller mask 后返回；可读性最好
 *   - C Repository 列投影：SQL 层不返回；最高效但与 role 耦合
 *
 * 本实现采用 **Option B**（controller 层显式调用），原因：
 *   1. 当前 Repository 已有解密链路（V34 phone/wechat_encrypted），把字段从 SQL 删掉
 *      反而绕过解密路径，复杂度↑；
 *   2. 现有 6 endpoint 的 SELECT 已经多列，再分多 SELECT 路径成本太高；
 *   3. Controller 层 mask 容易写单测、容易回滚、容易扩展角色矩阵；
 *   4. 性能差异微秒级，PII 字段不是热路径瓶颈；
 *   5. 拍板未来要按 campus / owner 做更细分的 scope filter，controller 层是
 *      自然的扩展点（拿得到 req.user）。
 *
 * 红线（与拍板对齐）：
 *   - 字段类型保持：不删 key，只 set null（前端依旧拿到结构化对象）
 *   - 范围过滤优先字段过滤：先 403 / 空列表，再字段裁剪
 *   - 范围过滤靠 controller 层 owner/teacher/campus 比对，本 helper 仅做 fields mask
 *   - parent role 走独立 c 端 endpoint（c/student-profile 等），本 helper 不负责
 *
 * 使用方式：
 *   import { maskCustomer, maskTeacher, maskContract } from '../../common/role-field-filter';
 *
 *   const list = await this.repo.listMine(tenantSchema, ownerUserId);
 *   return { items: list.map(c => maskCustomer(c, req.user)) };
 *
 *   const detail = await this.repo.findById(tenantSchema, id);
 *   if (!detail) return { found: false };
 *   return maskCustomer(detail, req.user);
 *
 * 单元测试：role-field-filter.spec.ts（每 role × 每 field 配对 case）。
 */

import { JwtPayload, TenantRole } from '../../modules/auth/jwt-payload.interface';
import { Customer } from '../../modules/db/customer.repository';
import { Contract } from '../../modules/db/contract.repository';
import { Teacher } from '../../modules/teacher/teacher.service';

// ============================================================
// Role 解析 helper
// ============================================================

/**
 * 角色判定（business validator 用 group 而不是单个 role 减少重复）
 *
 * 5/15 A-2 拍板：删 sales_director（不在 fields-by-role.md L6-17 角色清单）
 *   - 原归类 sales_director → admin group（KPI 主可看）已删
 *   - 仍保留 sales_manager → admin group（拍板「销售校内主管收口」）
 *   - 字符串 'sales_director' 如出现 → 落入 default → unknown group（全字段 mask）
 */
export type ActorGroup =
  | 'admin' // admin / boss / sales_manager = 老板/校长/销售校内主管（拍板 ✅ 全权）
  | 'sales' // sales / marketing = 个人销售线
  | 'academic' // academic / academic_admin = 教务双层
  | 'teacher' // teacher = 老师本人
  | 'finance' // finance = 财务
  | 'hr' // hr = 人事
  | 'parent' // parent = 家长 C 端（独立 JWT 流；本 helper 默认拒绝任何 B 端字段）
  | 'unknown'; // 兜底（未识别 → 等同 parent 最小集；含 5/15 删的 sales_director）

export function actorGroupOf(role: TenantRole | string | undefined | null): ActorGroup {
  switch (role) {
    case 'admin':
    case 'boss':
      return 'admin';
    case 'sales':
    case 'marketing':
      return 'sales';
    case 'sales_manager':
      // 5/15 A-2：sales_manager 仍归 admin group（拍板「销售校内主管」字段全可看）
      //   原 sales_director 同组并列已删 — fields-by-role.md 角色清单不含此岗位
      return 'admin';
    case 'academic':
    case 'academic_admin':
      return 'academic';
    case 'teacher':
      return 'teacher';
    case 'finance':
      return 'finance';
    case 'hr':
      return 'hr';
    case 'parent':
      return 'parent';
    default:
      // 5/15 A-2：'sales_director' 字符串如来自 JWT（不应该发生 — login validRoles 已删）
      //   或来自历史 schema row → 落入 unknown，全字段 mask（保守安全）
      return 'unknown';
  }
}

// ============================================================
// Customer 字段过滤（30 字段 → 仅敏感 PII 子集）
// ============================================================

/**
 * Customer 字段权限矩阵（fields-by-role.md 第 II 节 #3）：
 *
 * | 字段             | 销 owner=me | 销 other | 务 | 老校 | 财 |
 * | phone            | ✅           | ❌       | ✅ | ✅    | ❌ |
 * | wechat           | ✅           | ❌       | ✅ | ✅    | ❌ |
 * | source/note      | ✅           | ❌       | ❌ | ✅    | ❌ |
 *
 * 实现策略：
 *   - admin/boss：✅ 全字段返
 *   - academic：✅ 联系人保留（拍板「本校已成交可看」），但 source/follow 不看
 *   - sales：调用方需先用 listMine（已过滤 owner=me）；本 helper 处理 detail 路径
 *           外层确认 owner_user_id=me 后再走全字段；否则只暴露 name + stage
 *   - finance：phone/wechat 都 null（仅看作账金额，不需要联系人）
 *   - teacher / hr / parent / unknown：phone/wechat/source 全 null（不该看）
 *
 * 注：scope filter（sales owner=me 校验）由 controller 完成；本 helper 接受
 *     额外 `isOwnerSelf` 参数标记是否自己客户。
 */
export interface CustomerMaskOptions {
  /**
   * 是否是当前用户自己持有的客户（sales/sales_manager owner_user_id === req.user.sub）
   *
   * 仅对 sales 组生效：
   *   - true：保留联系人字段（拍板 sales ✅ owner=me）
   *   - false：phone/wechat/source/note 全 null（拍板 sales ❌ 别人客户）
   *
   * 其他 group（admin/academic/finance）不依赖此标记，按组规则返回。
   */
  isOwnerSelf?: boolean;
}

export function maskCustomer<T extends Customer>(
  customer: T,
  user: JwtPayload | undefined | null,
  options: CustomerMaskOptions = {},
): T {
  const group = actorGroupOf(user?.role);
  // 不动原对象（业务可能在外层多次使用），返 shallow copy
  const masked: T = { ...customer };

  switch (group) {
    case 'admin':
      // 老板校长 ✅ 全字段
      return masked;

    case 'academic':
      // 教务双层：联系人 ✅（拍板「本校已成交」），source 跟进 ❌
      // 注：拍板「教务全只读老师线」+ 本表 customer 教务有「本校已成交」权限
      masked.source = null;
      return masked;

    case 'sales':
      // 自己客户 ✅；别人客户 phone/wechat/note 全 null（不该看）
      if (options.isOwnerSelf) {
        return masked;
      }
      masked.phone = null;
      masked.wechat = null;
      masked.note = null;
      masked.source = null;
      return masked;

    case 'finance':
      // 财务作账：phone/wechat ❌；只保留 name/stage/signed_at/合同金额（合同走 contract mask）
      masked.phone = null;
      masked.wechat = null;
      masked.note = null;
      masked.source = null;
      return masked;

    case 'teacher':
    case 'hr':
    case 'parent':
    case 'unknown':
    default:
      // 不该看 customer PII → 全 null
      masked.phone = null;
      masked.wechat = null;
      masked.note = null;
      masked.source = null;
      return masked;
  }
}

// ============================================================
// Teacher 字段过滤（23 字段 → showcase 路径重点 phone）
// ============================================================

/**
 * Teacher 字段权限矩阵（fields-by-role.md 第 II 节 #2）：
 *
 * | 字段              | 师自己 | 务 | 老校 | 家 | 销 | 同校师 |
 * | phone             | ✅      | 👁 | ✅    | ❌ | ❌  | 👁     |
 *
 * 实现策略：
 *   - admin / boss / academic：✅ phone 可见
 *   - teacher 看自己：✅；看别人：phone 不可见
 *   - sales / parent / finance：phone 不可见（拍板「看不到手机/身份证」）
 *
 * 注：showcase 路径返回的「teacher」对象已是聚合裁剪过的（仅 id/name/subjects/avatar/bio），
 *     无 phone；本 helper 主要给「老师档案」detail 路径使用（V35+ 老师档案 controller）。
 *     当前 showcase endpoint 不返 phone，本 helper 仍提供保底语义。
 *
 * Day 2 Phase C X1 (2026-05-19 D1.4 拍板): hourlyPriceYuan 字段物理删除
 *   - V50 migration DROP COLUMN teachers.hourly_price_yuan
 *   - Teacher interface 也删字段，mask 函数不再处理（字段不存在 = 永远不出现）
 *   - 拍板「老师页面零财务字段，物理 > 逻辑」
 */
export interface TeacherMaskOptions {
  /**
   * 是否是当前用户的老师档案本人（teacher.userId === req.user.sub）
   *
   * - true：保留全字段（phone）
   * - false：按 group 规则裁剪 phone
   */
  isSelf?: boolean;
}

export function maskTeacher<T extends Teacher>(
  teacher: T,
  user: JwtPayload | undefined | null,
  options: TeacherMaskOptions = {},
): T {
  const group = actorGroupOf(user?.role);
  const masked: T = { ...teacher };

  // 老师本人 → 全字段
  if (options.isSelf) {
    return masked;
  }

  switch (group) {
    case 'admin':
      // 老板校长 ✅ 全字段
      return masked;

    case 'academic':
      // 教务双层 👁：phone 可见（拍板「不改但可看」）
      return masked;

    case 'teacher':
      // 同校老师互看 👁：phone 不可见（拍板「除手机身份证」）
      masked.phone = undefined;
      return masked;

    case 'sales':
      // 销售推荐老师场景：phone ❌（拍板「看不到手机/身份证」）
      masked.phone = undefined;
      return masked;

    case 'finance':
      // 财务看老师档案：phone ❌（仅看薪资项已删 V37/V38；X1 后零财务字段）
      masked.phone = undefined;
      return masked;

    case 'hr':
      // HR 跨校管理员工 → phone ✅ 看
      // 注：5/14 Wave 1 SSOT §1 已删 hr 角色，此分支保留兜底（旧 JWT / 历史调用方）
      return masked;

    case 'parent':
    case 'unknown':
    default:
      // 家长 / 未识别 → 全部敏感 null
      masked.phone = undefined;
      return masked;
  }
}

// ============================================================
// Contract 字段过滤（14 字段 → 教学人员不看退费/价格细节）
// ============================================================

/**
 * Contract 字段权限矩阵（fields-by-role.md 第 II 节 #4）：
 *
 * | 字段              | 销 | 务 | 师 | 老校 | 财 | 家 |
 * | totalAmount       | ✅  | 👁 | ❌ | ✅    | ✅ | ✅ |
 * | standardPrice     | ✅  | ❌ | ❌ | ✅    | ✅ | ✅ |
 * | discountAmount    | ✅  | ❌ | ❌ | ✅    | ✅ | ❌ |
 * | giftHours         | ✅  | 👁 | ❌ | ✅    | ✅ | ❌ |
 * | refund_*          | ❌  | ❌ | ❌ | ✅    | ✅ | ✅ |（教学人员不看退费）
 *
 * 实现策略：
 *   - admin / boss：✅ 全字段
 *   - sales（合同 owner=me）：✅；owner != me 拒绝（controller 校验）
 *   - academic：仅看 totalAmount + 付费状态；价格细节 ❌
 *   - teacher：仅 status + class_type + signed_at + 剩余课时；金额全 ❌
 *   - finance：✅（作账需要全字段，含 refund）
 *   - parent：看自己孩子合同：基础 + 时间 + 状态；价格细节 ✅（家长视图）
 *
 * 当前 contract 表无独立 refund 字段（refund 在 payments.refund_status）。
 * 本 helper 处理价格层；refund 字段过滤在未来 V37 加 refund 字段后扩展。
 */
export interface ContractMaskOptions {
  /**
   * 是否是当前用户自己签约的合同（contract.owner_user_id === req.user.sub）
   */
  isOwnerSelf?: boolean;
}

export function maskContract<T extends Contract>(
  contract: T,
  user: JwtPayload | undefined | null,
  options: ContractMaskOptions = {},
): T {
  const group = actorGroupOf(user?.role);
  const masked: T = { ...contract };

  switch (group) {
    case 'admin':
    case 'finance':
      // 老板校长 / 财务 ✅ 全字段
      return masked;

    case 'sales':
      // 自己合同 ✅；别人合同金额隐去
      if (options.isOwnerSelf) {
        return masked;
      }
      masked.standardPrice = 0;
      masked.discountAmount = 0;
      masked.totalAmount = 0;
      masked.giftHours = 0;
      return masked;

    case 'academic':
      // 教务 👁 仅付费状态：金额细节 ❌
      masked.standardPrice = 0;
      masked.discountAmount = 0;
      // totalAmount 保留（拍板「续费话术依据」），但 academic 不看具体折扣构成
      return masked;

    case 'teacher':
      // 老师 ❌ 全金额；保留 status + signed_at + class_type + lessonHours（教学执行需要）
      masked.standardPrice = 0;
      masked.discountAmount = 0;
      masked.totalAmount = 0;
      masked.giftHours = 0;
      return masked;

    case 'parent':
      // 家长 ✅ 自己孩子合同基础字段；discountAmount / giftHours 设 0（拍板「不看」）
      // totalAmount 保留（孩子家长应知道总价）
      masked.discountAmount = 0;
      masked.giftHours = 0;
      return masked;

    case 'hr':
    case 'unknown':
    default:
      // HR / 未识别 → 价格全 0
      masked.standardPrice = 0;
      masked.discountAmount = 0;
      masked.totalAmount = 0;
      masked.giftHours = 0;
      return masked;
  }
}

// ============================================================
// 范围过滤 helper（scope filter）
// ============================================================

/**
 * 判定 sales 是否可看某客户（owner_user_id === me 或 admin/boss/sales_manager）
 *
 * 用于 controller 层 detail / list 路径的访问决策（先 scope filter，再 field filter）
 *
 * 5/15 A-2：actorGroupOf 已删 sales_director → admin group 内仅含 admin/boss/sales_manager
 *
 * @returns true 允许访问；false 拒绝（controller 抛 403 / 返 {found:false}）
 */
export function canAccessCustomer(
  customer: { ownerUserId: string | null },
  user: JwtPayload | undefined | null,
): boolean {
  if (!user) return false;
  const group = actorGroupOf(user.role);

  switch (group) {
    case 'admin':
      // 老板校长 / sales_manager（销售主管收口）：全部可看
      // 5/15 A-2 删 sales_director（不在拍板角色清单）
      return true;
    case 'sales':
      // 销售（sales / marketing）：仅看 owner=me 或公共池
      return customer.ownerUserId === user.sub || customer.ownerUserId === null;
    case 'academic':
      // 教务：本校已成交客户（具体 campus 比对在 controller 层）
      return true;
    case 'finance':
      // 财务：access 层放行 + maskCustomer 字段层 phone/wechat/note/source 全 null
      //   实现 fields-by-role.md 拍板「联系人 ❌ / 跟进 ❌ / 接棒 ❌ / 购业 ✅ 作账」语义
      //
      // 2026-05-13 Sprint E backlog #25 leader 复审决策：保留 access=true（Sprint B.3 现状）
      //   原因：拍板「customer 联系人/跟进/接棒 finance ❌ + 购业 ✅ 作账」有两种合规实现：
      //     A) access=true + maskCustomer mask phone/wechat/note/source null（Sprint B.3 已实施）
      //     B) access=false（finance 不调 customer GET，只通过 contract.amount JOIN 拿金额）
      //   A 与 B 字段层等效（finance 实际看到的字段相同），A 更符合「双层防御」+「字段类型保持」
      //   原则（前端拿到完整对象便于 UI 渲染，仅敏感字段 null）。本次保留 A。
      //
      //   campus 比对仍在 controller 层处理（本 helper 仅做角色组路由判定）。
      return true;
    default:
      // teacher / parent / hr：不该访问 customer 资料
      return false;
  }
}

/**
 * 判定 sales 是否可看某 contract（owner_user_id === me 或 admin/boss）
 */
export function canAccessContract(
  contract: { ownerUserId: string | null },
  user: JwtPayload | undefined | null,
): boolean {
  if (!user) return false;
  const group = actorGroupOf(user.role);

  switch (group) {
    case 'admin':
    case 'finance':
      // admin 含 sales_manager（销售主管收口）— 5/15 A-2 删 sales_director
      return true;
    case 'sales':
      // 个人销售：仅自己签约的合同
      return contract.ownerUserId === user.sub;
    case 'academic':
      // 教务可看本校合同（campus 比对在 controller）
      return true;
    case 'teacher':
      // 老师可看主带学生的合同（需 controller 层校验 student.assigned_teacher_id === ownTeacherId）
      // 此 helper 不做学生关系反查（避免重 IO），controller 校验后传 ok
      return true;
    case 'parent':
      // 家长可看自己孩子合同（controller 校验 student 关系）
      return true;
    default:
      return false;
  }
}

/**
 * 判定 sales 是否可看某 student（owner_sales_id === me 或 admin/boss）
 *
 * 注：学生归属字段 V28 已加（owner_sales_id / assigned_teacher_id）
 */
export function canAccessStudent(
  student: { ownerSalesId: string | null; assignedTeacherId: string | null },
  user: JwtPayload | undefined | null,
  options: { ownTeacherId?: string | null } = {},
): boolean {
  if (!user) return false;
  const group = actorGroupOf(user.role);

  switch (group) {
    case 'admin':
      // admin / boss / sales_manager — 5/15 A-2 删 sales_director
      return true;
    case 'sales':
      // 个人销售：仅 owner_sales_id=me
      return student.ownerSalesId === user.sub;
    case 'academic':
      // 教务本校全部学生（campus 比对在 controller）
      return true;
    case 'teacher':
      // 老师仅主带学生（assigned_teacher_id === options.ownTeacherId）
      if (!options.ownTeacherId) return false;
      return student.assignedTeacherId === options.ownTeacherId;
    case 'finance':
      // 财务作账：本校全部
      return true;
    case 'parent':
      // 家长走 c 端独立 endpoint（c/student-profile），不走本判定
      return false;
    default:
      return false;
  }
}
