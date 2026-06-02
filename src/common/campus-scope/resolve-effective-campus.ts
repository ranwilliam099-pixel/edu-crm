/**
 * resolve-effective-campus — 全局校区筛选器 effective campusId 解析（SSOT §3.-2 D）
 *
 * 背景（2026-06-02 用户真机走查拍板，MVP 范围）：admin 在首页选「具体校区」→
 *   主页面（经营 home KPI / 课程 / 学员 / 漏斗 / 客户）按该校区过滤。前端经 body/query
 *   `campusId` 传 override；后端解析为 effective campusId 应用到查询。
 *
 * 权威逻辑（SSOT §3.-2 D「后端」段）：
 *   - **仅 admin**（跨校角色）+ override 提供（32-char ULID 格式校验通过）+ campusRepo 可用 +
 *     `campusRepo.findById(tenantId, override)` 存在（**校验 ∈ 本租户 campuses 表**）→ 用 override。
 *   - 否则（非 admin / 无 override / 格式非法 / 校区不存在 / repo 未注入）→ 回退 `jwtCampusId`
 *     （**既有行为**：非 admin 含 boss 恒忽略 override，防越权选他校；admin 不选时走 JWT.campusId）。
 *
 * 安全纪律（A04 防 client-controlled scope）：
 *   - **非 admin（含 boss）恒返 jwtCampusId**——boss 锁本校（不能借 override 选他校）。
 *   - admin override **必须 ∈ 本租户 campuses 表**——防 admin 选他租户/不存在校区（即便 admin 跨校，
 *     校区列表仍以 tenantId scope；campusRepo.findById 已 `WHERE id=$1 AND tenant_id=$2` 双条件隔离，
 *     跨租户由它兜住，本 helper 在租户内选校区）。
 *
 * 容错（不抛错）：
 *   - override 格式非法 / 校验不过 / campusRepo.findById 抛错 → **不抛 500**，静默回退 jwtCampusId
 *     （前端传脏值不致主流程 500；fail-open 哲学）。
 *
 * 返回值约定：
 *   - 返回 string（admin override 命中 / JWT.campusId 非空）或 null（JWT.campusId 为 null，
 *     如跨校 admin 不选时）。调用方保留「campusId 为 null 时的既有 403/兜底逻辑」不变
 *     （helper 仅负责「选哪个校区」，不负责「null 时怎么办」）。
 *
 * 注：CampusRepository 操作 public.campuses（平台层表），findById(tenantId, id) 收 **tenantId**
 *   （非 tenantSchema）；JwtPayload.tenantId 即租户 ID（32-char ULID）。
 */
import { Logger } from '@nestjs/common';
import { AuthenticatedRequest } from '../../modules/auth/jwt-payload.interface';
import { CampusRepository } from '../../modules/db/campus.repository';

/** 模块级 logger（pure 函数里独立 new，不依赖 DI） */
const campusScopeLogger = new Logger('resolve-effective-campus');

/**
 * 32-char ULID 格式校验（与 kpi.controller 既有 `length === 32` 约定一致，但更严：
 * 仅允许 ULID/hex 友好的 `[0-9A-Za-z]`，挡住注入/脏值。校验不过 → 调用方回退 JWT）。
 */
function isValidUlid32(value: string | undefined | null): value is string {
  return typeof value === 'string' && /^[0-9A-Za-z]{32}$/.test(value);
}

/**
 * 解析 effective campusId。
 *
 * @param req          已认证请求（取 role / campusId / tenantId）
 * @param bodyCampusId 前端传入的 override campusId（GET 经 @Query('campusId') / POST 经 body.campusId）
 * @param campusRepo   CampusRepository（@Optional；isolated unit spec 不传 → 回退 JWT）
 * @returns effective campusId（string）或 null（JWT.campusId 为 null）
 */
export async function resolveEffectiveCampusId(
  req: AuthenticatedRequest,
  bodyCampusId: string | undefined,
  campusRepo: CampusRepository | undefined,
): Promise<string | null> {
  const role = req.user?.role;
  const jwtCampusId = req.user?.campusId ?? null;
  const tenantId = req.user?.tenantId;

  // 非 admin（含 boss）→ 恒用 JWT.campusId（A04 防越权选他校；既有行为）
  if (role !== 'admin') {
    return jwtCampusId;
  }

  // admin 但无 override（不选 = 仍走 JWT.campusId，明心 admin 有单校 campusId）
  if (!bodyCampusId) {
    return jwtCampusId;
  }

  // admin override 格式非法 → 容错回退 JWT（前端脏值不致 500）
  if (!isValidUlid32(bodyCampusId)) {
    campusScopeLogger.warn(
      `admin campus override rejected (invalid ulid format), fallback to jwt campusId`,
    );
    return jwtCampusId;
  }

  // campusRepo 未注入（isolated spec）/ tenantId 缺失 → 无法校验归属 → 回退 JWT
  if (!campusRepo || !tenantId) {
    return jwtCampusId;
  }

  // 校验 override ∈ 本租户 campuses 表（防越权选他租户/不存在校区）
  try {
    const campus = await campusRepo.findById(tenantId, bodyCampusId);
    if (campus) {
      // 命中本租户校区 → 用 override
      return bodyCampusId;
    }
    // override 不属于本租户 / 不存在 → 回退 JWT（不暴露存在性，不抛错）
    campusScopeLogger.warn(
      `admin campus override not found in tenant campuses, fallback to jwt campusId`,
    );
    return jwtCampusId;
  } catch (err) {
    // fail-open：campusRepo 查询抛错（DB 抖动等）不阻塞主流程，回退 JWT
    campusScopeLogger.warn(
      `campus override lookup failed (${(err as Error)?.message ?? 'unknown'}), fallback to jwt campusId`,
    );
    return jwtCampusId;
  }
}
