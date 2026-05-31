/**
 * RoleFieldFilter barrel — Sprint B.3 字段级权限过滤
 *
 * 使用：
 *   import { maskCustomer, maskTeacher, maskContract, canAccessCustomer } from '../../common/role-field-filter';
 *
 * 拍板源：docs/fields-by-role.md 第 II 节
 */
export {
  maskCustomer,
  maskTeacher,
  maskContract,
  maskStudentDetail,
  maskPhoneLevel1,
  canAccessCustomer,
  canAccessContract,
  canAccessStudent,
  actorGroupOf,
} from './role-field-filter';

export type {
  ActorGroup,
  CustomerMaskOptions,
  TeacherMaskOptions,
  ContractMaskOptions,
  StudentDetailMaskOptions,
} from './role-field-filter';
