/**
 * Parent JWT Claims — V10 BE-V10-3 (Q-FE-2 落地)
 *
 * 来源：
 *   - 派单条目 33/34 Q-FE-2「C 端家长 token 鉴权机制」
 *   - 用户拍板「后端补 ParentJwt 模块」
 *
 * 与 B 端 JwtPayload 区分：
 *   - parentId 替代 sub（C 端身份）
 *   - 不含 tenantId / role / campusId（家长跨租户身份，无机构内角色）
 *   - 无 platform 角色（C 端不可能是平台超管）
 */
export interface ParentJwtPayload {
  /** 32-char ULID，对应 parents.id */
  parentId: string;

  /** 微信小程序 openid（C 端身份核心）*/
  openid?: string;

  /** Token 类型标识，用于区分 B 端 vs C 端（防止误用）*/
  type: 'parent';

  /**
   * JWT audience（T6a audit A1-r2 P0-NEW-3）— 强制 'parent-app'
   * 旧 parent token 无此字段时由 type='parent' 兜底（向前兼容）
   */
  aud?: string;

  exp?: number;
  iat?: number;
}

export const PARENT_TOKEN_TYPE = 'parent' as const;
