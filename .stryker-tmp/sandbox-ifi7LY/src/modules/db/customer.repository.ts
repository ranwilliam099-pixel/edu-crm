function stryNS_9fa48() {
  var g = typeof globalThis === 'object' && globalThis && globalThis.Math === Math && globalThis || new Function("return this")();
  var ns = g.__stryker__ || (g.__stryker__ = {});
  if (ns.activeMutant === undefined && g.process && g.process.env && g.process.env.__STRYKER_ACTIVE_MUTANT__) {
    ns.activeMutant = g.process.env.__STRYKER_ACTIVE_MUTANT__;
  }
  function retrieveNS() {
    return ns;
  }
  stryNS_9fa48 = retrieveNS;
  return retrieveNS();
}
stryNS_9fa48();
function stryCov_9fa48() {
  var ns = stryNS_9fa48();
  var cov = ns.mutantCoverage || (ns.mutantCoverage = {
    static: {},
    perTest: {}
  });
  function cover() {
    var c = cov.static;
    if (ns.currentTestId) {
      c = cov.perTest[ns.currentTestId] = cov.perTest[ns.currentTestId] || {};
    }
    var a = arguments;
    for (var i = 0; i < a.length; i++) {
      c[a[i]] = (c[a[i]] || 0) + 1;
    }
  }
  stryCov_9fa48 = cover;
  cover.apply(null, arguments);
}
function stryMutAct_9fa48(id) {
  var ns = stryNS_9fa48();
  function isActive(id) {
    if (ns.activeMutant === id) {
      if (ns.hitCount !== void 0 && ++ns.hitCount > ns.hitLimit) {
        throw new Error('Stryker: Hit count limit reached (' + ns.hitCount + ')');
      }
      return true;
    }
    return false;
  }
  stryMutAct_9fa48 = isActive;
  return isActive(id);
}
import { Injectable, BadRequestException, ConflictException, NotFoundException, Logger } from '@nestjs/common';
import { PgPoolService, PgRow } from './pg-pool.service';
import { FieldEncryptor } from '../../common/crypto/field-encryptor';
import { HmacHasher } from '../../common/crypto/hmac-hasher';

/**
 * CustomerRepository — V25 销售客户管理（基于 V2 opportunities + V25 ALTER）
 *
 * 业务流：
 *   1. 新线索（owner_user_id=NULL）入公共池
 *   2. 销售 claim → owner_user_id = me
 *   3. 销售跟进（addFollow 写 customer_follow_log）
 *   4. 销售 release → owner_user_id 回 NULL
 *   5. 30 天无跟进 cron → 自动回池
 *
 * V34 双写双读模式（A02-2，2026-05-11）：
 *   - opportunities.phone + phone_encrypted 双轨；opportunities.wechat + wechat_encrypted 双轨
 *   - INSERT/UPDATE：明文列 + *_encrypted BYTEA 列同事务一并写
 *   - SELECT：优先解密 *_encrypted；解密失败或 NULL → fallback 明文
 *   - 对外接口（Customer.phone/wechat）始终是解密后的明文，前端透明
 *   - 解密失败 logger.warn + fallback 明文（fail-open，不阻塞主流程）
 *   - opportunities 表无 WHERE phone=? 等值查询、无 UNIQUE 索引 → GCM 随机 IV 不影响功能
 *   - 旧数据（V40 backfill 前 *_encrypted=NULL）走明文 fallback
 *   - 灰度完毕 + V40 backfill 全量后，V41+ DROP 明文列
 *
 * V41 三写模式（A02-4，2026-05-13）：
 *   - customers.primary_mobile + primary_mobile_hash + primary_mobile_encrypted 三轨
 *   - createWithOpportunity INSERT customers：三列同事务一并写
 *   - 兼容期：旧行 *_hash/*_encrypted=NULL，新行三写
 *   - 查重路径（StudentImportRepository）：hash 列优先 + 明文 fallback
 *   - 注意：customers 表的 INSERT 当前只在 createWithOpportunity + StudentImport，
 *     SELECT 路径不在 CustomerRepository（CustomerRepository 操作的是 opportunities 表）
 */

export type CustomerStage = '初步接触' | '需求诊断' | '已预约试听' | '已试听待转化' | '已出方案' | '谈单中' | '已报名' | '已失单';
export type FollowType = 'lead' | 'consult' | 'trial_invited' | 'trial_done' | 'signed' | 'lost' | 'remark' | 'released' | 'claimed';
export interface Customer {
  id: string;
  studentId: string;
  // V25 JOIN students 真姓名 + 年级（mapCustomerRow 只在 SELECT 含 join 字段时填充）
  studentName: string | null;
  gradeOrAge: string | null;
  intendedSubject: string | null;
  ownerUserId: string | null;
  stage: CustomerStage;
  source: string | null;
  phone: string | null;
  wechat: string | null;
  intentLevel: '高' | '中' | '低' | null;
  urgent: boolean;
  note: string | null;
  enteredPoolAt: string | null;
  enterPoolReason: string | null;
  lastContactAt: string | null;
  signedAt: string | null;
  lostReason: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface FollowEntry {
  id: string;
  opportunityId: string;
  followType: FollowType;
  label: string;
  byUserId: string | null;
  byLabel: string;
  occurredAt: string;
  extra: Record<string, unknown> | null;
}
const POOL_LIMIT_PER_SALES = 50;
const POOL_RESET_REASON = stryMutAct_9fa48("0") ? {} : (stryCov_9fa48("0"), {
  newLead: 'new_lead',
  released: 'released_by_sales',
  cold: 'cold_30d',
  salesQuit: 'sales_quit'
});

/**
 * V29 R2 销售即时建客户结果（含 customer + opportunity + 可选 student）
 */
export interface CreateCustomerResult {
  customerId: string;
  opportunityId: string;
  studentId: string | null;
}
@Injectable()
export class CustomerRepository {
  private readonly logger = new Logger(CustomerRepository.name);
  constructor(private readonly pg: PgPoolService, private readonly encryptor: FieldEncryptor, private readonly hasher: HmacHasher) {}

  /**
   * V29 R2 销售即时建客户（家长） + opportunity + 可选 student（一并）
   *
   * 来源：用户 2026-05-07「全做」— 销售自己开拓的客户能即时录入，不必等公共池
   *
   * 事务内：
   *   1. INSERT customers（家长）
   *   2. INSERT students（如 studentName 提供）
   *   3. INSERT opportunities（owner_user_id = 销售自己，stage='初步接触'）
   *
   * RBAC：sales / sales_manager / boss / admin（销售口可建）— 5/15 A-2 删 sales_director
   */
  async createWithOpportunity(tenantSchema: string, payload: {
    customerId: string;
    opportunityId: string;
    parentName: string;
    primaryMobile: string;
    campusId: string;
    ownerSalesId: string;
    // student 可选 — 提供则一并建学生（关联 customer + opportunity）
    studentId?: string;
    studentName?: string;
    gradeOrAge?: string;
    intendedSubject?: string;
    // opportunity 字段
    stage?: string;
    source?: string;
    note?: string;
  }): Promise<CreateCustomerResult> {
    if (stryMutAct_9fa48("5")) {
      {}
    } else {
      stryCov_9fa48("5");
      if (stryMutAct_9fa48("8") ? !payload.customerId && payload.customerId.length !== 32 : stryMutAct_9fa48("7") ? false : stryMutAct_9fa48("6") ? true : (stryCov_9fa48("6", "7", "8"), (stryMutAct_9fa48("9") ? payload.customerId : (stryCov_9fa48("9"), !payload.customerId)) || (stryMutAct_9fa48("11") ? payload.customerId.length === 32 : stryMutAct_9fa48("10") ? false : (stryCov_9fa48("10", "11"), payload.customerId.length !== 32)))) {
        if (stryMutAct_9fa48("12")) {
          {}
        } else {
          stryCov_9fa48("12");
          throw new BadRequestException('customerId must be 32-char ULID');
        }
      }
      if (stryMutAct_9fa48("16") ? !payload.opportunityId && payload.opportunityId.length !== 32 : stryMutAct_9fa48("15") ? false : stryMutAct_9fa48("14") ? true : (stryCov_9fa48("14", "15", "16"), (stryMutAct_9fa48("17") ? payload.opportunityId : (stryCov_9fa48("17"), !payload.opportunityId)) || (stryMutAct_9fa48("19") ? payload.opportunityId.length === 32 : stryMutAct_9fa48("18") ? false : (stryCov_9fa48("18", "19"), payload.opportunityId.length !== 32)))) {
        if (stryMutAct_9fa48("20")) {
          {}
        } else {
          stryCov_9fa48("20");
          throw new BadRequestException('opportunityId must be 32-char ULID');
        }
      }
      if (stryMutAct_9fa48("24") ? false : stryMutAct_9fa48("23") ? true : stryMutAct_9fa48("22") ? payload.parentName : (stryCov_9fa48("22", "23", "24"), !payload.parentName)) throw new BadRequestException('parentName required');
      if (stryMutAct_9fa48("28") ? !payload.primaryMobile && !/^1[3-9]\d{9}$/.test(payload.primaryMobile) : stryMutAct_9fa48("27") ? false : stryMutAct_9fa48("26") ? true : (stryCov_9fa48("26", "27", "28"), (stryMutAct_9fa48("29") ? payload.primaryMobile : (stryCov_9fa48("29"), !payload.primaryMobile)) || (stryMutAct_9fa48("30") ? /^1[3-9]\d{9}$/.test(payload.primaryMobile) : (stryCov_9fa48("30"), !(stryMutAct_9fa48("35") ? /^1[3-9]\D{9}$/ : stryMutAct_9fa48("34") ? /^1[3-9]\d$/ : stryMutAct_9fa48("33") ? /^1[^3-9]\d{9}$/ : stryMutAct_9fa48("32") ? /^1[3-9]\d{9}/ : stryMutAct_9fa48("31") ? /1[3-9]\d{9}$/ : (stryCov_9fa48("31", "32", "33", "34", "35"), /^1[3-9]\d{9}$/)).test(payload.primaryMobile))))) {
        if (stryMutAct_9fa48("36")) {
          {}
        } else {
          stryCov_9fa48("36");
          throw new BadRequestException('primaryMobile must be 11-digit Chinese mobile');
        }
      }
      if (stryMutAct_9fa48("40") ? false : stryMutAct_9fa48("39") ? true : stryMutAct_9fa48("38") ? payload.campusId : (stryCov_9fa48("38", "39", "40"), !payload.campusId)) throw new BadRequestException('campusId required');
      if (stryMutAct_9fa48("44") ? false : stryMutAct_9fa48("43") ? true : stryMutAct_9fa48("42") ? payload.ownerSalesId : (stryCov_9fa48("42", "43", "44"), !payload.ownerSalesId)) throw new BadRequestException('ownerSalesId required');
      if (stryMutAct_9fa48("48") ? payload.studentName || !payload.studentId || payload.studentId.length !== 32 : stryMutAct_9fa48("47") ? false : stryMutAct_9fa48("46") ? true : (stryCov_9fa48("46", "47", "48"), payload.studentName && (stryMutAct_9fa48("50") ? !payload.studentId && payload.studentId.length !== 32 : stryMutAct_9fa48("49") ? true : (stryCov_9fa48("49", "50"), (stryMutAct_9fa48("51") ? payload.studentId : (stryCov_9fa48("51"), !payload.studentId)) || (stryMutAct_9fa48("53") ? payload.studentId.length === 32 : stryMutAct_9fa48("52") ? false : (stryCov_9fa48("52", "53"), payload.studentId.length !== 32)))))) {
        if (stryMutAct_9fa48("54")) {
          {}
        } else {
          stryCov_9fa48("54");
          throw new BadRequestException('当传 studentName 时必须传 32-char studentId');
        }
      }
      return this.pg.transaction(async client => {
        if (stryMutAct_9fa48("56")) {
          {}
        } else {
          stryCov_9fa48("56");
          // 1. customer（家长）
          //    V41 A02-4：primary_mobile 明文 + primary_mobile_hash（HMAC 等值查询）
          //                + primary_mobile_encrypted（AES-GCM 存储）三写（同事务保证一致）
          //    旧数据兼容期 *_hash/*_encrypted=NULL；新写入三列同时落
          const mobilePlain = payload.primaryMobile;
          const mobileHash = this.hashMobile(mobilePlain);
          const mobileEncrypted = this.encryptMobile(mobilePlain);
          await client.query(`INSERT INTO customers (
             id, parent_name,
             primary_mobile, primary_mobile_hash, primary_mobile_encrypted,
             campus_id, owner_id, created_by, updated_by
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $7)`, [payload.customerId, payload.parentName, mobilePlain, mobileHash, mobileEncrypted, payload.campusId, payload.ownerSalesId]);

          // 2. student（可选）
          let createdStudentId: string | null = null;
          if (stryMutAct_9fa48("61") ? payload.studentName || payload.studentId : stryMutAct_9fa48("60") ? false : stryMutAct_9fa48("59") ? true : (stryCov_9fa48("59", "60", "61"), payload.studentName && payload.studentId)) {
            if (stryMutAct_9fa48("62")) {
              {}
            } else {
              stryCov_9fa48("62");
              await client.query(`INSERT INTO students
               (id, student_name, customer_id, grade_or_age, intended_subject,
                owner_sales_id, created_by, updated_by)
             VALUES ($1, $2, $3, $4, $5, $6, $6, $6)`, [payload.studentId, payload.studentName, payload.customerId, stryMutAct_9fa48("67") ? payload.gradeOrAge && null : stryMutAct_9fa48("66") ? false : stryMutAct_9fa48("65") ? true : (stryCov_9fa48("65", "66", "67"), payload.gradeOrAge || null), stryMutAct_9fa48("70") ? payload.intendedSubject && null : stryMutAct_9fa48("69") ? false : stryMutAct_9fa48("68") ? true : (stryCov_9fa48("68", "69", "70"), payload.intendedSubject || null), payload.ownerSalesId]);
              createdStudentId = payload.studentId;
            }
          }

          // 3. opportunity（销售线索 — 必须 student_id 已存在；如无 student 则跳过）
          //    V34 A02-2：phone 明文 + phone_encrypted 密文双写（同事务保证一致）
          //    wechat 在此方法暂无入参（前端流程未传），保留 null；后续如新增编辑接口时双写
          if (stryMutAct_9fa48("72") ? false : stryMutAct_9fa48("71") ? true : (stryCov_9fa48("71", "72"), createdStudentId)) {
            if (stryMutAct_9fa48("73")) {
              {}
            } else {
              stryCov_9fa48("73");
              const phonePlain = payload.primaryMobile;
              const phoneEncrypted = this.encryptPhone(phonePlain);
              await client.query(`INSERT INTO opportunities
               (id, student_id, course_product_id, stage, owner_user_id, campus_id,
                source, phone, phone_encrypted, last_contact_at, note,
                created_by, updated_by)
             VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, NOW(), $9, $4, $4)`, [payload.opportunityId, createdStudentId, stryMutAct_9fa48("78") ? payload.stage && '初步接触' : stryMutAct_9fa48("77") ? false : stryMutAct_9fa48("76") ? true : (stryCov_9fa48("76", "77", "78"), payload.stage || '初步接触'), payload.ownerSalesId, payload.campusId, stryMutAct_9fa48("82") ? payload.source && '销售自建' : stryMutAct_9fa48("81") ? false : stryMutAct_9fa48("80") ? true : (stryCov_9fa48("80", "81", "82"), payload.source || '销售自建'), phonePlain, phoneEncrypted, stryMutAct_9fa48("86") ? payload.note && null : stryMutAct_9fa48("85") ? false : stryMutAct_9fa48("84") ? true : (stryCov_9fa48("84", "85", "86"), payload.note || null)]);
            }
          }
          return stryMutAct_9fa48("87") ? {} : (stryCov_9fa48("87"), {
            customerId: payload.customerId,
            opportunityId: createdStudentId ? payload.opportunityId : '',
            studentId: createdStudentId
          });
        }
      }, stryMutAct_9fa48("89") ? {} : (stryCov_9fa48("89"), {
        tenantSchema
      }));
    }
  }

  /**
   * V34 A02-2：mapCustomerRow 改为 instance 方法以便注入 FieldEncryptor 用于解密
   * phone / wechat：优先解密 *_encrypted；NULL/失败 → fallback 明文
   */
  mapCustomerRow(r: PgRow): Customer {
    if (stryMutAct_9fa48("90")) {
      {}
    } else {
      stryCov_9fa48("90");
      return stryMutAct_9fa48("91") ? {} : (stryCov_9fa48("91"), {
        id: r.id,
        studentId: r.student_id,
        // JOIN 字段（仅 listMine/listPool/findById 包含）
        studentName: stryMutAct_9fa48("94") ? r.student_name && null : stryMutAct_9fa48("93") ? false : stryMutAct_9fa48("92") ? true : (stryCov_9fa48("92", "93", "94"), r.student_name || null),
        gradeOrAge: stryMutAct_9fa48("97") ? r.grade_or_age && null : stryMutAct_9fa48("96") ? false : stryMutAct_9fa48("95") ? true : (stryCov_9fa48("95", "96", "97"), r.grade_or_age || null),
        intendedSubject: stryMutAct_9fa48("100") ? r.intended_subject && null : stryMutAct_9fa48("99") ? false : stryMutAct_9fa48("98") ? true : (stryCov_9fa48("98", "99", "100"), r.intended_subject || null),
        ownerUserId: r.owner_user_id,
        stage: r.stage as CustomerStage,
        source: r.source,
        phone: this.decryptPhone(r.id, r.phone_encrypted, r.phone),
        wechat: this.decryptWechat(r.id, r.wechat_encrypted, r.wechat),
        intentLevel: r.intent_level as Customer['intentLevel'],
        urgent: stryMutAct_9fa48("101") ? !r.urgent : (stryCov_9fa48("101"), !(stryMutAct_9fa48("102") ? r.urgent : (stryCov_9fa48("102"), !r.urgent))),
        note: r.note,
        enteredPoolAt: r.entered_pool_at ? new Date(r.entered_pool_at).toISOString() : null,
        enterPoolReason: r.enter_pool_reason,
        lastContactAt: r.last_contact_at ? new Date(r.last_contact_at).toISOString() : null,
        signedAt: r.signed_at ? new Date(r.signed_at).toISOString() : null,
        lostReason: r.lost_reason,
        createdAt: new Date(r.created_at).toISOString(),
        updatedAt: new Date(r.updated_at).toISOString()
      });
    }
  }
  static mapFollowRow(r: PgRow): FollowEntry {
    if (stryMutAct_9fa48("103")) {
      {}
    } else {
      stryCov_9fa48("103");
      return stryMutAct_9fa48("104") ? {} : (stryCov_9fa48("104"), {
        id: r.id,
        opportunityId: r.opportunity_id,
        followType: r.follow_type as FollowType,
        label: r.label,
        byUserId: r.by_user_id,
        byLabel: r.by_label,
        occurredAt: new Date(r.occurred_at).toISOString(),
        extra: stryMutAct_9fa48("107") ? r.extra_json && null : stryMutAct_9fa48("106") ? false : stryMutAct_9fa48("105") ? true : (stryCov_9fa48("105", "106", "107"), r.extra_json || null)
      });
    }
  }

  // ===== 列表查询 =====

  async listMine(tenantSchema: string, ownerUserId: string, options: {
    stage?: CustomerStage;
    limit?: number;
    offset?: number;
  } = {}): Promise<Customer[]> {
    if (stryMutAct_9fa48("108")) {
      {}
    } else {
      stryCov_9fa48("108");
      const limit = stryMutAct_9fa48("109") ? options.limit && 50 : (stryCov_9fa48("109"), options.limit ?? 50);
      const offset = stryMutAct_9fa48("110") ? options.offset && 0 : (stryCov_9fa48("110"), options.offset ?? 0);
      if (stryMutAct_9fa48("112") ? false : stryMutAct_9fa48("111") ? true : (stryCov_9fa48("111", "112"), options.stage)) {
        if (stryMutAct_9fa48("113")) {
          {}
        } else {
          stryCov_9fa48("113");
          const rows = await this.pg.tenantQuery<PgRow>(tenantSchema, `SELECT o.*, s.student_name, s.grade_or_age, s.intended_subject
           FROM opportunities o
           LEFT JOIN students s ON s.id = o.student_id
          WHERE o.owner_user_id = $1 AND o.stage = $2
          ORDER BY o.urgent DESC, COALESCE(o.last_contact_at, o.created_at) DESC
          LIMIT $3 OFFSET $4`, [ownerUserId, options.stage, limit, offset]);
          return rows.map(stryMutAct_9fa48("116") ? () => undefined : (stryCov_9fa48("116"), r => this.mapCustomerRow(r)));
        }
      }
      const rows = await this.pg.tenantQuery<PgRow>(tenantSchema, `SELECT o.*, s.student_name, s.grade_or_age, s.intended_subject
         FROM opportunities o
         LEFT JOIN students s ON s.id = o.student_id
        WHERE o.owner_user_id = $1
          AND o.stage NOT IN ('已报名','已失单')
        ORDER BY o.urgent DESC, COALESCE(o.last_contact_at, o.created_at) DESC
        LIMIT $2 OFFSET $3`, [ownerUserId, limit, offset]);
      return rows.map(stryMutAct_9fa48("119") ? () => undefined : (stryCov_9fa48("119"), r => this.mapCustomerRow(r)));
    }
  }

  /**
   * 老板视角（admin / sales_manager）：跨校查看全部客户 — 5/15 A-2 删 sales_director
   *
   * @param ownerFilter undefined = 所有；'unassigned' = 公共池；具体 sub = 某销售
   * @param campusId V26 校区切换过滤；undefined = 全部校区
   */
  async listAllForBoss(tenantSchema: string, options: {
    ownerFilter?: string;
    stage?: CustomerStage;
    campusId?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<Customer[]> {
    if (stryMutAct_9fa48("120")) {
      {}
    } else {
      stryCov_9fa48("120");
      const limit = stryMutAct_9fa48("121") ? options.limit && 200 : (stryCov_9fa48("121"), options.limit ?? 200);
      const offset = stryMutAct_9fa48("122") ? options.offset && 0 : (stryCov_9fa48("122"), options.offset ?? 0);
      const where: string[] = [`o.stage NOT IN ('已报名','已失单')`];
      const params: any[] = [];
      if (stryMutAct_9fa48("127") ? false : stryMutAct_9fa48("126") ? true : (stryCov_9fa48("126", "127"), options.stage)) {
        if (stryMutAct_9fa48("128")) {
          {}
        } else {
          stryCov_9fa48("128");
          params.push(options.stage);
          where.push(`o.stage = $${params.length}`);
        }
      }
      if (stryMutAct_9fa48("132") ? options.ownerFilter !== 'unassigned' : stryMutAct_9fa48("131") ? false : stryMutAct_9fa48("130") ? true : (stryCov_9fa48("130", "131", "132"), options.ownerFilter === 'unassigned')) {
        if (stryMutAct_9fa48("134")) {
          {}
        } else {
          stryCov_9fa48("134");
          where.push(`o.owner_user_id IS NULL`);
        }
      } else if (stryMutAct_9fa48("137") ? false : stryMutAct_9fa48("136") ? true : (stryCov_9fa48("136", "137"), options.ownerFilter)) {
        if (stryMutAct_9fa48("138")) {
          {}
        } else {
          stryCov_9fa48("138");
          params.push(options.ownerFilter);
          where.push(`o.owner_user_id = $${params.length}`);
        }
      }
      if (stryMutAct_9fa48("141") ? false : stryMutAct_9fa48("140") ? true : (stryCov_9fa48("140", "141"), options.campusId)) {
        if (stryMutAct_9fa48("142")) {
          {}
        } else {
          stryCov_9fa48("142");
          params.push(options.campusId);
          where.push(`o.campus_id = $${params.length}`);
        }
      }
      params.push(limit, offset);
      const rows = await this.pg.tenantQuery<PgRow>(tenantSchema, `SELECT o.*, s.student_name, s.grade_or_age, s.intended_subject
         FROM opportunities o
         LEFT JOIN students s ON s.id = o.student_id
        WHERE ${where.join(' AND ')}
        ORDER BY o.urgent DESC, COALESCE(o.last_contact_at, o.created_at) DESC
        LIMIT $${stryMutAct_9fa48("146") ? params.length + 1 : (stryCov_9fa48("146"), params.length - 1)} OFFSET $${params.length}`, params);
      return rows.map(stryMutAct_9fa48("147") ? () => undefined : (stryCov_9fa48("147"), r => this.mapCustomerRow(r)));
    }
  }
  async listPool(tenantSchema: string, options: {
    source?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<Customer[]> {
    if (stryMutAct_9fa48("148")) {
      {}
    } else {
      stryCov_9fa48("148");
      const limit = stryMutAct_9fa48("149") ? options.limit && 100 : (stryCov_9fa48("149"), options.limit ?? 100);
      const offset = stryMutAct_9fa48("150") ? options.offset && 0 : (stryCov_9fa48("150"), options.offset ?? 0);
      if (stryMutAct_9fa48("152") ? false : stryMutAct_9fa48("151") ? true : (stryCov_9fa48("151", "152"), options.source)) {
        if (stryMutAct_9fa48("153")) {
          {}
        } else {
          stryCov_9fa48("153");
          const rows = await this.pg.tenantQuery<PgRow>(tenantSchema, `SELECT o.*, s.student_name, s.grade_or_age, s.intended_subject
           FROM opportunities o
           LEFT JOIN students s ON s.id = o.student_id
          WHERE o.owner_user_id IS NULL
            AND o.stage NOT IN ('已报名','已失单')
            AND o.source = $1
          ORDER BY o.urgent DESC, o.entered_pool_at ASC
          LIMIT $2 OFFSET $3`, [options.source, limit, offset]);
          return rows.map(stryMutAct_9fa48("156") ? () => undefined : (stryCov_9fa48("156"), r => this.mapCustomerRow(r)));
        }
      }
      const rows = await this.pg.tenantQuery<PgRow>(tenantSchema, `SELECT o.*, s.student_name, s.grade_or_age, s.intended_subject
         FROM opportunities o
         LEFT JOIN students s ON s.id = o.student_id
        WHERE o.owner_user_id IS NULL
          AND o.stage NOT IN ('已报名','已失单')
        ORDER BY o.urgent DESC, o.entered_pool_at ASC
        LIMIT $1 OFFSET $2`, [limit, offset]);
      return rows.map(stryMutAct_9fa48("159") ? () => undefined : (stryCov_9fa48("159"), r => this.mapCustomerRow(r)));
    }
  }
  async findById(tenantSchema: string, id: string): Promise<Customer | null> {
    if (stryMutAct_9fa48("160")) {
      {}
    } else {
      stryCov_9fa48("160");
      const rows = await this.pg.tenantQuery<PgRow>(tenantSchema, `SELECT o.*, s.student_name, s.grade_or_age, s.intended_subject
         FROM opportunities o
         LEFT JOIN students s ON s.id = o.student_id
        WHERE o.id = $1`, [id]);
      return (stryMutAct_9fa48("165") ? rows.length !== 0 : stryMutAct_9fa48("164") ? false : stryMutAct_9fa48("163") ? true : (stryCov_9fa48("163", "164", "165"), rows.length === 0)) ? null : this.mapCustomerRow(rows[0]);
    }
  }

  // ===== 公共池操作 =====

  async claim(tenantSchema: string, customerId: string, userId: string, userLabel: string): Promise<Customer> {
    if (stryMutAct_9fa48("166")) {
      {}
    } else {
      stryCov_9fa48("166");
      return this.pg.transaction(async client => {
        if (stryMutAct_9fa48("167")) {
          {}
        } else {
          stryCov_9fa48("167");
          // 在跟客户上限校验
          const cntRows = await client.query(`SELECT COUNT(*) AS cnt FROM opportunities
             WHERE owner_user_id = $1 AND stage NOT IN ('已报名','已失单')`, [userId]);
          const myCount = parseInt(stryMutAct_9fa48("172") ? cntRows.rows[0]?.cnt && '0' : stryMutAct_9fa48("171") ? false : stryMutAct_9fa48("170") ? true : (stryCov_9fa48("170", "171", "172"), (stryMutAct_9fa48("173") ? cntRows.rows[0].cnt : (stryCov_9fa48("173"), cntRows.rows[0]?.cnt)) || '0'), 10);
          if (stryMutAct_9fa48("178") ? myCount < POOL_LIMIT_PER_SALES : stryMutAct_9fa48("177") ? myCount > POOL_LIMIT_PER_SALES : stryMutAct_9fa48("176") ? false : stryMutAct_9fa48("175") ? true : (stryCov_9fa48("175", "176", "177", "178"), myCount >= POOL_LIMIT_PER_SALES)) {
            if (stryMutAct_9fa48("179")) {
              {}
            } else {
              stryCov_9fa48("179");
              throw new ConflictException(`POOL_LIMIT_REACHED: ${myCount}/${POOL_LIMIT_PER_SALES}`);
            }
          }

          // FCFS 抢占（必须 owner_user_id IS NULL）
          const upd = await client.query(`UPDATE opportunities
              SET owner_user_id = $1,
                  entered_pool_at = NULL,
                  enter_pool_reason = NULL,
                  last_contact_at = NOW(),
                  updated_at = NOW(),
                  updated_by = $1
            WHERE id = $2 AND owner_user_id IS NULL
          RETURNING *`, [userId, customerId]);
          if (stryMutAct_9fa48("185") ? upd.rows.length !== 0 : stryMutAct_9fa48("184") ? false : stryMutAct_9fa48("183") ? true : (stryCov_9fa48("183", "184", "185"), upd.rows.length === 0)) {
            if (stryMutAct_9fa48("186")) {
              {}
            } else {
              stryCov_9fa48("186");
              // 区分原因
              const check = await client.query(`SELECT owner_user_id FROM opportunities WHERE id = $1`, [customerId]);
              if (stryMutAct_9fa48("191") ? check.rows.length !== 0 : stryMutAct_9fa48("190") ? false : stryMutAct_9fa48("189") ? true : (stryCov_9fa48("189", "190", "191"), check.rows.length === 0)) {
                if (stryMutAct_9fa48("192")) {
                  {}
                } else {
                  stryCov_9fa48("192");
                  throw new NotFoundException(`customer ${customerId} not found`);
                }
              }
              throw new ConflictException('CUSTOMER_ALREADY_OWNED');
            }
          }
          await client.query(`INSERT INTO customer_follow_log
             (id, opportunity_id, follow_type, label, by_user_id, by_label)
           VALUES ($1, $2, 'claimed', $3, $4, $5)`, [this.genId(), customerId, `${userLabel} 从公共池捞客户`, userId, userLabel]);
          return this.mapCustomerRow(upd.rows[0]);
        }
      }, stryMutAct_9fa48("198") ? {} : (stryCov_9fa48("198"), {
        tenantSchema
      }));
    }
  }
  async release(tenantSchema: string, customerId: string, userId: string, userLabel: string, reason?: string): Promise<Customer> {
    if (stryMutAct_9fa48("199")) {
      {}
    } else {
      stryCov_9fa48("199");
      return this.pg.transaction(async client => {
        if (stryMutAct_9fa48("200")) {
          {}
        } else {
          stryCov_9fa48("200");
          const upd = await client.query(`UPDATE opportunities
              SET owner_user_id = NULL,
                  entered_pool_at = NOW(),
                  enter_pool_reason = $3,
                  updated_at = NOW(),
                  updated_by = $2
            WHERE id = $1 AND owner_user_id = $2
          RETURNING *`, [customerId, userId, stryMutAct_9fa48("205") ? reason && POOL_RESET_REASON.released : stryMutAct_9fa48("204") ? false : stryMutAct_9fa48("203") ? true : (stryCov_9fa48("203", "204", "205"), reason || POOL_RESET_REASON.released)]);
          if (stryMutAct_9fa48("208") ? upd.rows.length !== 0 : stryMutAct_9fa48("207") ? false : stryMutAct_9fa48("206") ? true : (stryCov_9fa48("206", "207", "208"), upd.rows.length === 0)) {
            if (stryMutAct_9fa48("209")) {
              {}
            } else {
              stryCov_9fa48("209");
              throw new NotFoundException(`customer ${customerId} not owned by you`);
            }
          }
          await client.query(`INSERT INTO customer_follow_log
             (id, opportunity_id, follow_type, label, by_user_id, by_label, extra_json)
           VALUES ($1, $2, 'released', $3, $4, $5, $6::jsonb)`, [this.genId(), customerId, `${userLabel} 退回公共池${reason ? ' · ' + reason : ''}`, userId, userLabel, JSON.stringify(stryMutAct_9fa48("216") ? {} : (stryCov_9fa48("216"), {
            reason: stryMutAct_9fa48("219") ? reason && 'no_reason' : stryMutAct_9fa48("218") ? false : stryMutAct_9fa48("217") ? true : (stryCov_9fa48("217", "218", "219"), reason || 'no_reason')
          }))]);
          return this.mapCustomerRow(upd.rows[0]);
        }
      }, stryMutAct_9fa48("221") ? {} : (stryCov_9fa48("221"), {
        tenantSchema
      }));
    }
  }
  async markLost(tenantSchema: string, customerId: string, userId: string, userLabel: string, lostReason: string): Promise<Customer> {
    if (stryMutAct_9fa48("222")) {
      {}
    } else {
      stryCov_9fa48("222");
      const validReasons = ['价格高', '时间不合适', '竞品成交', '无需求', '家长放弃'];
      if (stryMutAct_9fa48("231") ? false : stryMutAct_9fa48("230") ? true : stryMutAct_9fa48("229") ? validReasons.includes(lostReason) : (stryCov_9fa48("229", "230", "231"), !validReasons.includes(lostReason))) {
        if (stryMutAct_9fa48("232")) {
          {}
        } else {
          stryCov_9fa48("232");
          throw new BadRequestException(`lost_reason must be one of: ${validReasons.join(',')}`);
        }
      }
      return this.pg.transaction(async client => {
        if (stryMutAct_9fa48("235")) {
          {}
        } else {
          stryCov_9fa48("235");
          const upd = await client.query(`UPDATE opportunities
              SET stage = '已失单',
                  lost_reason = $3,
                  updated_at = NOW(),
                  updated_by = $2,
                  last_contact_at = NOW()
            WHERE id = $1 AND owner_user_id = $2
          RETURNING *`, [customerId, userId, lostReason]);
          if (stryMutAct_9fa48("240") ? upd.rows.length !== 0 : stryMutAct_9fa48("239") ? false : stryMutAct_9fa48("238") ? true : (stryCov_9fa48("238", "239", "240"), upd.rows.length === 0)) {
            if (stryMutAct_9fa48("241")) {
              {}
            } else {
              stryCov_9fa48("241");
              throw new NotFoundException(`customer ${customerId} not owned by you`);
            }
          }
          await client.query(`INSERT INTO customer_follow_log
             (id, opportunity_id, follow_type, label, by_user_id, by_label, extra_json)
           VALUES ($1, $2, 'lost', $3, $4, $5, $6::jsonb)`, [this.genId(), customerId, `标记失单：${lostReason}`, userId, userLabel, JSON.stringify(stryMutAct_9fa48("246") ? {} : (stryCov_9fa48("246"), {
            lostReason
          }))]);
          return this.mapCustomerRow(upd.rows[0]);
        }
      }, stryMutAct_9fa48("247") ? {} : (stryCov_9fa48("247"), {
        tenantSchema
      }));
    }
  }

  // ===== 跟进时间轴 =====

  async listFollowLog(tenantSchema: string, customerId: string, limit = 100): Promise<FollowEntry[]> {
    if (stryMutAct_9fa48("248")) {
      {}
    } else {
      stryCov_9fa48("248");
      const rows = await this.pg.tenantQuery<PgRow>(tenantSchema, `SELECT * FROM customer_follow_log
         WHERE opportunity_id = $1
         ORDER BY occurred_at DESC LIMIT $2`, [customerId, limit]);
      return rows.map(stryMutAct_9fa48("251") ? () => undefined : (stryCov_9fa48("251"), r => CustomerRepository.mapFollowRow(r)));
    }
  }
  async addFollow(tenantSchema: string, customerId: string, args: {
    followType: FollowType;
    label: string;
    byUserId: string;
    byLabel: string;
    extra?: Record<string, unknown>;
  }): Promise<FollowEntry> {
    if (stryMutAct_9fa48("252")) {
      {}
    } else {
      stryCov_9fa48("252");
      return this.pg.transaction(async client => {
        if (stryMutAct_9fa48("253")) {
          {}
        } else {
          stryCov_9fa48("253");
          // 校验客户存在
          const cust = await client.query(`SELECT id FROM opportunities WHERE id = $1`, [customerId]);
          if (stryMutAct_9fa48("258") ? cust.rows.length !== 0 : stryMutAct_9fa48("257") ? false : stryMutAct_9fa48("256") ? true : (stryCov_9fa48("256", "257", "258"), cust.rows.length === 0)) {
            if (stryMutAct_9fa48("259")) {
              {}
            } else {
              stryCov_9fa48("259");
              throw new NotFoundException(`customer ${customerId} not found`);
            }
          }
          const ins = await client.query(`INSERT INTO customer_follow_log
             (id, opportunity_id, follow_type, label, by_user_id, by_label, extra_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
          RETURNING *`, [this.genId(), customerId, args.followType, args.label, args.byUserId, args.byLabel, args.extra ? JSON.stringify(args.extra) : null]);
          // 更新 last_contact_at
          await client.query(`UPDATE opportunities
              SET last_contact_at = NOW(),
                  updated_at = NOW(),
                  updated_by = $2
            WHERE id = $1`, [customerId, args.byUserId]);
          return CustomerRepository.mapFollowRow(ins.rows[0]);
        }
      }, stryMutAct_9fa48("265") ? {} : (stryCov_9fa48("265"), {
        tenantSchema
      }));
    }
  }

  /**
   * cron 巡检：在跟客户 30 天无 last_contact_at → 自动入池
   */
  async expireColdToPool(tenantSchema: string): Promise<number> {
    if (stryMutAct_9fa48("266")) {
      {}
    } else {
      stryCov_9fa48("266");
      const rows = await this.pg.tenantQuery<{
        id: string;
      }>(tenantSchema, `UPDATE opportunities
          SET owner_user_id = NULL,
              entered_pool_at = NOW(),
              enter_pool_reason = $1,
              updated_at = NOW()
        WHERE owner_user_id IS NOT NULL
          AND stage NOT IN ('已报名','已失单')
          AND COALESCE(last_contact_at, created_at) < NOW() - INTERVAL '30 days'
      RETURNING id`, [POOL_RESET_REASON.cold]);
      return rows.length;
    }
  }

  // ===== Helper =====
  private genId(): string {
    if (stryMutAct_9fa48("269")) {
      {}
    } else {
      stryCov_9fa48("269");
      // 32-char ULID-style（与项目其他地方一致）
      const chars = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
      let s = '';
      for (let i = 0; stryMutAct_9fa48("274") ? i >= 32 : stryMutAct_9fa48("273") ? i <= 32 : stryMutAct_9fa48("272") ? false : (stryCov_9fa48("272", "273", "274"), i < 32); stryMutAct_9fa48("275") ? i-- : (stryCov_9fa48("275"), i++)) stryMutAct_9fa48("276") ? s -= chars[Math.floor(Math.random() * chars.length)] : (stryCov_9fa48("276"), s += chars[Math.floor(stryMutAct_9fa48("277") ? Math.random() / chars.length : (stryCov_9fa48("277"), Math.random() * chars.length))]);
      return s;
    }
  }

  // =====================================================================
  // V34 字段加密 helper（A02-2）
  // =====================================================================

  /**
   * 加密 phone 明文 → BYTEA Buffer。null/undefined → null
   * encryptor.encrypt 内部对 null/undefined 直接返回 null，安全
   */
  private encryptPhone(plaintext: string | null | undefined): Buffer | null {
    if (stryMutAct_9fa48("278")) {
      {}
    } else {
      stryCov_9fa48("278");
      return this.encryptor.encrypt(plaintext);
    }
  }

  /**
   * 加密 wechat 明文 → BYTEA Buffer。null/undefined → null
   * 当前 createWithOpportunity 不接收 wechat 入参（保留接口对称性 + 未来扩展）
   */
  private encryptWechat(plaintext: string | null | undefined): Buffer | null {
    if (stryMutAct_9fa48("279")) {
      {}
    } else {
      stryCov_9fa48("279");
      return this.encryptor.encrypt(plaintext);
    }
  }

  /**
   * 解密 phone_encrypted → 明文。fallback 路径（V34 fail-open）：
   *   - encrypted = null/undefined/非 Buffer/空 → 返回明文 fallback（phone 列）
   *   - encrypted 解密抛错（key 不匹配 / 数据损坏）→ logger.warn + 返回明文 fallback
   *   - 都没有 → null（Customer.phone 类型是 string | null）
   *
   * 注：PG node-pg 驱动会把 BYTEA 自动转为 Buffer；测试 mock 可能传 null/undefined。
   */
  private decryptPhone(rowId: string, encrypted: Buffer | null | undefined, fallbackPlain: string | null | undefined): string | null {
    if (stryMutAct_9fa48("280")) {
      {}
    } else {
      stryCov_9fa48("280");
      if (stryMutAct_9fa48("283") ? encrypted && Buffer.isBuffer(encrypted) || encrypted.length > 0 : stryMutAct_9fa48("282") ? false : stryMutAct_9fa48("281") ? true : (stryCov_9fa48("281", "282", "283"), (stryMutAct_9fa48("285") ? encrypted || Buffer.isBuffer(encrypted) : stryMutAct_9fa48("284") ? true : (stryCov_9fa48("284", "285"), encrypted && Buffer.isBuffer(encrypted))) && (stryMutAct_9fa48("288") ? encrypted.length <= 0 : stryMutAct_9fa48("287") ? encrypted.length >= 0 : stryMutAct_9fa48("286") ? true : (stryCov_9fa48("286", "287", "288"), encrypted.length > 0)))) {
        if (stryMutAct_9fa48("289")) {
          {}
        } else {
          stryCov_9fa48("289");
          try {
            if (stryMutAct_9fa48("290")) {
              {}
            } else {
              stryCov_9fa48("290");
              const decoded = this.encryptor.decrypt(encrypted);
              if (stryMutAct_9fa48("293") ? decoded !== null || decoded !== undefined : stryMutAct_9fa48("292") ? false : stryMutAct_9fa48("291") ? true : (stryCov_9fa48("291", "292", "293"), (stryMutAct_9fa48("295") ? decoded === null : stryMutAct_9fa48("294") ? true : (stryCov_9fa48("294", "295"), decoded !== null)) && (stryMutAct_9fa48("297") ? decoded === undefined : stryMutAct_9fa48("296") ? true : (stryCov_9fa48("296", "297"), decoded !== undefined)))) {
                if (stryMutAct_9fa48("298")) {
                  {}
                } else {
                  stryCov_9fa48("298");
                  return decoded;
                }
              }
            }
          } catch (err) {
            if (stryMutAct_9fa48("299")) {
              {}
            } else {
              stryCov_9fa48("299");
              // V34 fail-open：解密失败不阻塞业务，logger.warn + 走明文 fallback
              this.logger.warn(`[V34-decrypt-fallback] opportunity ${rowId} phone_encrypted decrypt failed: ${(err as Error).message}; using plaintext fallback`);
            }
          }
        }
      }
      return stryMutAct_9fa48("301") ? fallbackPlain && null : (stryCov_9fa48("301"), fallbackPlain ?? null);
    }
  }

  /**
   * 解密 wechat_encrypted → 明文。同 decryptPhone 的 fallback 策略。
   */
  private decryptWechat(rowId: string, encrypted: Buffer | null | undefined, fallbackPlain: string | null | undefined): string | null {
    if (stryMutAct_9fa48("302")) {
      {}
    } else {
      stryCov_9fa48("302");
      if (stryMutAct_9fa48("305") ? encrypted && Buffer.isBuffer(encrypted) || encrypted.length > 0 : stryMutAct_9fa48("304") ? false : stryMutAct_9fa48("303") ? true : (stryCov_9fa48("303", "304", "305"), (stryMutAct_9fa48("307") ? encrypted || Buffer.isBuffer(encrypted) : stryMutAct_9fa48("306") ? true : (stryCov_9fa48("306", "307"), encrypted && Buffer.isBuffer(encrypted))) && (stryMutAct_9fa48("310") ? encrypted.length <= 0 : stryMutAct_9fa48("309") ? encrypted.length >= 0 : stryMutAct_9fa48("308") ? true : (stryCov_9fa48("308", "309", "310"), encrypted.length > 0)))) {
        if (stryMutAct_9fa48("311")) {
          {}
        } else {
          stryCov_9fa48("311");
          try {
            if (stryMutAct_9fa48("312")) {
              {}
            } else {
              stryCov_9fa48("312");
              const decoded = this.encryptor.decrypt(encrypted);
              if (stryMutAct_9fa48("315") ? decoded !== null || decoded !== undefined : stryMutAct_9fa48("314") ? false : stryMutAct_9fa48("313") ? true : (stryCov_9fa48("313", "314", "315"), (stryMutAct_9fa48("317") ? decoded === null : stryMutAct_9fa48("316") ? true : (stryCov_9fa48("316", "317"), decoded !== null)) && (stryMutAct_9fa48("319") ? decoded === undefined : stryMutAct_9fa48("318") ? true : (stryCov_9fa48("318", "319"), decoded !== undefined)))) {
                if (stryMutAct_9fa48("320")) {
                  {}
                } else {
                  stryCov_9fa48("320");
                  return decoded;
                }
              }
            }
          } catch (err) {
            if (stryMutAct_9fa48("321")) {
              {}
            } else {
              stryCov_9fa48("321");
              this.logger.warn(`[V34-decrypt-fallback] opportunity ${rowId} wechat_encrypted decrypt failed: ${(err as Error).message}; using plaintext fallback`);
            }
          }
        }
      }
      return stryMutAct_9fa48("323") ? fallbackPlain && null : (stryCov_9fa48("323"), fallbackPlain ?? null);
    }
  }

  // =====================================================================
  // V41 customers.primary_mobile 三写 helper（A02-4，2026-05-13）
  // =====================================================================

  /**
   * V41 计算 primary_mobile HMAC-SHA256 hash → BYTEA Buffer
   * null/undefined → null（防 INSERT 入参为空时崩溃）
   */
  private hashMobile(plaintext: string | null | undefined): Buffer | null {
    if (stryMutAct_9fa48("324")) {
      {}
    } else {
      stryCov_9fa48("324");
      return this.hasher.hash(plaintext);
    }
  }

  /**
   * V41 加密 primary_mobile 明文 → BYTEA Buffer（AES-256-GCM）
   * encryptor.encrypt 内部对 null/undefined 返回 null
   */
  private encryptMobile(plaintext: string | null | undefined): Buffer | null {
    if (stryMutAct_9fa48("325")) {
      {}
    } else {
      stryCov_9fa48("325");
      return this.encryptor.encrypt(plaintext);
    }
  }

  /**
   * V41 解密 primary_mobile_encrypted → 明文。同 decryptPhone fallback 策略。
   *
   * **当前调用方：0**（mapCustomerRow 不返 primary_mobile，Customer interface 不含此字段）
   * **预防性 helper**（Sprint E backlog #24 闭环 2026-05-13）：
   *   - 未来如新 GET endpoint 需返回客户主联系手机号（如 /db/customers/:id/with-primary-contact），
   *     必须先在 Customer interface 加 `primary_mobile?: string` + mapCustomerRow 加
   *     `primary_mobile: this.decryptPrimaryMobile(...)` 字段填充。
   *   - 直接用 r.primary_mobile 明文绕过解密 = 历史明文 backfill 后 V41+ 数据可能 NULL，字段不全。
   *   - 必须用 decryptPrimaryMobile 才能正确处理 V41 backfill 后的双轨数据（hash 列查询 + encrypted 列存储）。
   *
   * 字段权限红线（fields-by-role.md 5 对象矩阵）：
   *   - admin/boss/sales(owner=me)/academic(已成交) 可见 → mask 由 maskCustomer 处理
   *   - teacher / finance 不可见 → maskCustomer 已 mask 成 null
   *   helper 仅做技术解密，权限由 maskCustomer 守门（双层防御）。
   */
  private decryptPrimaryMobile(rowId: string, encrypted: Buffer | null | undefined, fallbackPlain: string | null | undefined): string | null {
    if (stryMutAct_9fa48("326")) {
      {}
    } else {
      stryCov_9fa48("326");
      if (stryMutAct_9fa48("329") ? encrypted && Buffer.isBuffer(encrypted) || encrypted.length > 0 : stryMutAct_9fa48("328") ? false : stryMutAct_9fa48("327") ? true : (stryCov_9fa48("327", "328", "329"), (stryMutAct_9fa48("331") ? encrypted || Buffer.isBuffer(encrypted) : stryMutAct_9fa48("330") ? true : (stryCov_9fa48("330", "331"), encrypted && Buffer.isBuffer(encrypted))) && (stryMutAct_9fa48("334") ? encrypted.length <= 0 : stryMutAct_9fa48("333") ? encrypted.length >= 0 : stryMutAct_9fa48("332") ? true : (stryCov_9fa48("332", "333", "334"), encrypted.length > 0)))) {
        if (stryMutAct_9fa48("335")) {
          {}
        } else {
          stryCov_9fa48("335");
          try {
            if (stryMutAct_9fa48("336")) {
              {}
            } else {
              stryCov_9fa48("336");
              const decoded = this.encryptor.decrypt(encrypted);
              if (stryMutAct_9fa48("339") ? decoded !== null || decoded !== undefined : stryMutAct_9fa48("338") ? false : stryMutAct_9fa48("337") ? true : (stryCov_9fa48("337", "338", "339"), (stryMutAct_9fa48("341") ? decoded === null : stryMutAct_9fa48("340") ? true : (stryCov_9fa48("340", "341"), decoded !== null)) && (stryMutAct_9fa48("343") ? decoded === undefined : stryMutAct_9fa48("342") ? true : (stryCov_9fa48("342", "343"), decoded !== undefined)))) {
                if (stryMutAct_9fa48("344")) {
                  {}
                } else {
                  stryCov_9fa48("344");
                  return decoded;
                }
              }
            }
          } catch (err) {
            if (stryMutAct_9fa48("345")) {
              {}
            } else {
              stryCov_9fa48("345");
              // V41 fail-open：解密失败不阻塞业务，logger.warn + 走明文 fallback
              this.logger.warn(`[V41-decrypt-fallback] customer ${rowId} primary_mobile_encrypted decrypt failed: ${(err as Error).message}; using plaintext fallback`);
            }
          }
        }
      }
      return stryMutAct_9fa48("347") ? fallbackPlain && null : (stryCov_9fa48("347"), fallbackPlain ?? null);
    }
  }
}