-- ============================================================
-- V2__tenant_schema_template.sql
-- 租户 schema 模板（W1 起草，提前预热）
-- 占位：`__TENANT_SCHEMA__` 由租户初始化 worker 替换为 `tenant_<tenant_id>`
-- 依据：字段清单-V1.md §3.1 引用的 3 份草案（Lead-Customer-Student / Opportunity-TrialLesson / Contract-Payment-CourseProduct）+ §3.2-§3.6
-- 出具：开发总监 / 研发负责人  2026-04-29 W0-D1（W1 提前预热版）
-- 项目隔离：本工程是 ~/Desktop/edu-server/，与 企业管理系统项目 完全独立
-- ============================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS __TENANT_SCHEMA__;
SET LOCAL search_path = __TENANT_SCHEMA__, public;

-- ----------------------------------------------------------------
-- §3.4 campuses（校区表）
-- A08 标准版校区上限 3，超量提示升级
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campuses (
    id           VARCHAR(32)  PRIMARY KEY,
    name         VARCHAR(64)  NOT NULL,
    status       VARCHAR(16)  NOT NULL DEFAULT '启用'
                 CHECK (status IN ('启用','停用')),
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by   VARCHAR(32)  NOT NULL,
    updated_by   VARCHAR(32)  NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_campuses_status ON campuses(status);

-- ----------------------------------------------------------------
-- §3.3 users（顾问 / 主管 / 校长账号表）
-- A07 标准版账号上限 50，超量提示升级
-- 角色枚举与权限矩阵 §1 一致：sales/sales_manager/sales_director/marketing/finance/boss/admin/hr
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id           VARCHAR(32)  PRIMARY KEY,
    name         VARCHAR(32)  NOT NULL,
    mobile       VARCHAR(16)  NOT NULL,
    role         VARCHAR(32)  NOT NULL DEFAULT 'sales'
                 CHECK (role IN ('sales','sales_manager','sales_director','marketing','finance','boss','admin','hr')),
    campus_id    VARCHAR(32)  NOT NULL REFERENCES campuses(id),
    status       VARCHAR(16)  NOT NULL DEFAULT '启用'
                 CHECK (status IN ('启用','停用')),
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by   VARCHAR(32)  NOT NULL,
    updated_by   VARCHAR(32)  NOT NULL,
    UNIQUE (mobile)
);
CREATE INDEX IF NOT EXISTS idx_users_role      ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_campus_id ON users(campus_id);
CREATE INDEX IF NOT EXISTS idx_users_status    ON users(status);

-- ----------------------------------------------------------------
-- 字段清单草案-Lead-Customer-Student §1：Lead 招生线索（9 行业字段 + 标准追加）
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leads (
    id                  VARCHAR(32)  PRIMARY KEY,
    source_level1       VARCHAR(32)  NOT NULL,                  -- 一级渠道
    source_level2       VARCHAR(64)  NOT NULL,                  -- 二级渠道
    source_level3       VARCHAR(128) NULL,                      -- 三级渠道/批次
    campus_id           VARCHAR(32)  NOT NULL REFERENCES campuses(id),
    course_line         VARCHAR(64)  NULL,                      -- 意向课程线
    owner_id            VARCHAR(32)  NULL REFERENCES users(id), -- 顾问归属
    first_contact_at    TIMESTAMPTZ  NULL,                      -- 首呼时间，用于首呼率
    invalid_reason      VARCHAR(32)  NULL
                        CHECK (invalid_reason IS NULL OR invalid_reason IN
                               ('空号','重复','无需求','预算不足','竞品已成交')),
    enroll_attribution  VARCHAR(32)  NOT NULL DEFAULT '末次有效触点'
                        CHECK (enroll_attribution IN ('首次接触','末次有效触点','转介绍优先')),
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by          VARCHAR(32)  NOT NULL,
    updated_by          VARCHAR(32)  NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_campus_id        ON leads(campus_id);
CREATE INDEX IF NOT EXISTS idx_leads_owner_id         ON leads(owner_id);
CREATE INDEX IF NOT EXISTS idx_leads_source_level1    ON leads(source_level1);
CREATE INDEX IF NOT EXISTS idx_leads_first_contact_at ON leads(first_contact_at);

-- ----------------------------------------------------------------
-- §2 customers 家庭客户（10 行业字段 + 标准追加 + deleted_at 软删除）
-- 主手机号参与查重（脱敏 Y）
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
    id                    VARCHAR(32)  PRIMARY KEY,
    parent_name           VARCHAR(32)  NOT NULL,
    primary_mobile        VARCHAR(16)  NOT NULL,                -- 脱敏 + 查重
    wechat_id             VARCHAR(64)  NULL,                    -- 脱敏
    city                  VARCHAR(32)  NULL,
    campus_id             VARCHAR(32)  NOT NULL REFERENCES campuses(id),
    family_tag            VARCHAR(128) NULL,                    -- 多标签逗号分隔
    source_level1         VARCHAR(32)  NULL,                    -- 从 lead 继承
    owner_id              VARCHAR(32)  NULL REFERENCES users(id),
    is_returning_customer BOOLEAN      NOT NULL DEFAULT FALSE,
    referrer_id           VARCHAR(32)  NULL,                    -- 推荐人客户ID（关联 customers.id）
    created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by            VARCHAR(32)  NOT NULL,
    updated_by            VARCHAR(32)  NOT NULL,
    deleted_at            TIMESTAMPTZ  NULL,
    UNIQUE (primary_mobile) DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX IF NOT EXISTS idx_customers_campus_id   ON customers(campus_id);
CREATE INDEX IF NOT EXISTS idx_customers_owner_id    ON customers(owner_id);
CREATE INDEX IF NOT EXISTS idx_customers_is_return   ON customers(is_returning_customer);
CREATE INDEX IF NOT EXISTS idx_customers_referrer_id ON customers(referrer_id);

-- ----------------------------------------------------------------
-- §3 students 学员（9 字段 + 标准追加）
-- 一名学员归属一个家庭主档（customer_id 必填，参见 Q.STUDENT-MULTI-PARENT 待答 → 默认一个）
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS students (
    id                 VARCHAR(32)  PRIMARY KEY,
    student_name       VARCHAR(32)  NOT NULL,
    gender             VARCHAR(8)   NULL
                       CHECK (gender IS NULL OR gender IN ('男','女','未知')),
    grade_or_age       VARCHAR(16)  NULL,
    school_name        VARCHAR(64)  NULL,
    intended_subject   VARCHAR(64)  NULL,
    ability_level      VARCHAR(64)  NULL,
    pain_point_tags    VARCHAR(128) NULL,
    target_goal        VARCHAR(128) NULL,
    customer_id        VARCHAR(32)  NOT NULL REFERENCES customers(id),
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by         VARCHAR(32)  NOT NULL,
    updated_by         VARCHAR(32)  NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_students_customer_id      ON students(customer_id);
CREATE INDEX IF NOT EXISTS idx_students_intended_subject ON students(intended_subject);

-- ----------------------------------------------------------------
-- 字段清单草案-Opportunity-TrialLesson §1：opportunities 商机（9 字段 + 追加）
-- 8 阶段教培招生漏斗：初步接触/需求诊断/已预约试听/已试听待转化/已出方案/谈单中/已报名/已失单
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS opportunities (
    id                  VARCHAR(32)   PRIMARY KEY,
    student_id          VARCHAR(32)   NOT NULL REFERENCES students(id),
    course_product_id   VARCHAR(32)   NOT NULL,                 -- FK 到 course_products，但允许 deferred 引用（建表顺序）
    stage               VARCHAR(32)   NOT NULL DEFAULT '初步接触'
                        CHECK (stage IN ('初步接触','需求诊断','已预约试听','已试听待转化','已出方案','谈单中','已报名','已失单')),
    quote_amount        NUMERIC(12,2) NULL CHECK (quote_amount IS NULL OR quote_amount >= 0),
    intent_level        VARCHAR(16)   NULL
                        CHECK (intent_level IS NULL OR intent_level IN ('高','中','低')),
    next_action         VARCHAR(128)  NULL,
    next_followup_at    TIMESTAMPTZ   NULL,
    signed_at           TIMESTAMPTZ   NULL,                     -- stage=已报名时必填（应用层校验）
    lost_reason         VARCHAR(32)   NULL                      -- stage=已失单时必填
                        CHECK (lost_reason IS NULL OR lost_reason IN
                               ('价格高','时间不合适','竞品成交','无需求','家长放弃')),
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by          VARCHAR(32)   NOT NULL,
    updated_by          VARCHAR(32)   NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opps_student_id        ON opportunities(student_id);
CREATE INDEX IF NOT EXISTS idx_opps_course_product_id ON opportunities(course_product_id);
CREATE INDEX IF NOT EXISTS idx_opps_stage             ON opportunities(stage);
CREATE INDEX IF NOT EXISTS idx_opps_intent_level      ON opportunities(intent_level);
CREATE INDEX IF NOT EXISTS idx_opps_next_followup_at  ON opportunities(next_followup_at);

-- ----------------------------------------------------------------
-- §2 trial_lessons 试听（11 字段 + 追加）
-- 6 状态：已预约试听 / 已确认到访 / 已试听 / 试听未到 / 试听后待跟单 / 试听后已丢单
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trial_lessons (
    id                    VARCHAR(32)   PRIMARY KEY,
    opportunity_id        VARCHAR(32)   NOT NULL REFERENCES opportunities(id),
    trial_course          VARCHAR(64)   NOT NULL,
    campus_id             VARCHAR(32)   NOT NULL REFERENCES campuses(id),
    teacher_name          VARCHAR(32)   NULL,                    -- 第一阶段不强依赖教师对象
    schedule_at           TIMESTAMPTZ   NOT NULL,
    status                VARCHAR(32)   NOT NULL DEFAULT '已预约试听'
                          CHECK (status IN ('已预约试听','已确认到访','已试听','试听未到','试听后待跟单','试听后已丢单')),
    attended              BOOLEAN       NOT NULL DEFAULT FALSE,
    completed             BOOLEAN       NOT NULL DEFAULT FALSE,
    parent_feedback       VARCHAR(256)  NULL,
    student_feedback      VARCHAR(256)  NULL,
    closing_probability   NUMERIC(5,2)  NULL CHECK (closing_probability IS NULL OR (closing_probability >= 0 AND closing_probability <= 100)),
    created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by            VARCHAR(32)   NOT NULL,
    updated_by            VARCHAR(32)   NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trial_opp_id      ON trial_lessons(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_trial_campus_id   ON trial_lessons(campus_id);
CREATE INDEX IF NOT EXISTS idx_trial_status      ON trial_lessons(status);
CREATE INDEX IF NOT EXISTS idx_trial_schedule_at ON trial_lessons(schedule_at);

-- ----------------------------------------------------------------
-- 字段清单草案-Contract-Payment-CourseProduct §3：course_products 课程产品（7 字段 + 追加）
-- Q08 历史保护策略待产品经理拍板（最迟 2026-05-05）；当前不建 versioned 子表
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS course_products (
    id              VARCHAR(32)   PRIMARY KEY,
    product_name    VARCHAR(64)   NOT NULL,                   -- 参与查重
    course_line     VARCHAR(32)   NOT NULL,
    class_type      VARCHAR(32)   NOT NULL,
    lesson_package  VARCHAR(32)   NULL,
    standard_price  NUMERIC(12,2) NOT NULL CHECK (standard_price >= 0),
    campus_scope    VARCHAR(128)  NULL,                       -- 单校区/多校区/指定校区列表
    status          VARCHAR(16)   NOT NULL DEFAULT '上架'
                    CHECK (status IN ('上架','下架')),
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by      VARCHAR(32)   NOT NULL,
    updated_by      VARCHAR(32)   NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_courseproducts_status      ON course_products(status);
CREATE INDEX IF NOT EXISTS idx_courseproducts_course_line ON course_products(course_line);
-- 产品名查重唯一性（status=上架）
CREATE UNIQUE INDEX IF NOT EXISTS uq_courseproducts_name_active
    ON course_products(product_name) WHERE status = '上架';

-- 补 opportunities → course_products 的外键约束（建完 course_products 后）
ALTER TABLE opportunities
    ADD CONSTRAINT fk_opps_course_product
    FOREIGN KEY (course_product_id) REFERENCES course_products(id);

-- ----------------------------------------------------------------
-- §1 contracts 合同（9 字段 + 追加 + paid 锁/逆向单字段，A12）
-- A12：paid_locked = true 时禁止 UPDATE/DELETE 任何 amount/status；调整必须新建 reverse_orders
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contracts (
    id                  VARCHAR(32)   PRIMARY KEY,
    student_id          VARCHAR(32)   NOT NULL REFERENCES students(id),
    course_product_id   VARCHAR(32)   NOT NULL REFERENCES course_products(id),
    class_type          VARCHAR(32)   NULL,
    lesson_hours        INTEGER       NOT NULL DEFAULT 0 CHECK (lesson_hours >= 0),
    standard_price      NUMERIC(12,2) NOT NULL CHECK (standard_price >= 0),
    discount_amount     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
    gift_hours          INTEGER       NOT NULL DEFAULT 0 CHECK (gift_hours >= 0),
    total_amount        NUMERIC(12,2) NOT NULL CHECK (total_amount >= 0),
    order_type          VARCHAR(16)   NOT NULL DEFAULT '新签'
                        CHECK (order_type IN ('新签','续费','扩科','升班','转班')),
    paid_locked         BOOLEAN       NOT NULL DEFAULT FALSE,
    reverse_from_id     VARCHAR(32)   NULL,                                 -- 补充单关联原合同 id
    reverse_type        VARCHAR(16)   NULL
                        CHECK (reverse_type IS NULL OR reverse_type IN ('退款','转班','扩科','补充')),
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by          VARCHAR(32)   NOT NULL,
    updated_by          VARCHAR(32)   NOT NULL,
    deleted_at          TIMESTAMPTZ   NULL
);
CREATE INDEX IF NOT EXISTS idx_contracts_student_id    ON contracts(student_id);
CREATE INDEX IF NOT EXISTS idx_contracts_course_id     ON contracts(course_product_id);
CREATE INDEX IF NOT EXISTS idx_contracts_order_type    ON contracts(order_type);
CREATE INDEX IF NOT EXISTS idx_contracts_paid_locked   ON contracts(paid_locked);
CREATE INDEX IF NOT EXISTS idx_contracts_reverse_from  ON contracts(reverse_from_id);

-- ----------------------------------------------------------------
-- §2 payments 学费回款（9 字段 + 追加 + paid 锁/逆向单字段，A12）
-- 注意：本表是租户内部"学费回款"，与公共 schema payment_orders（公司收 SaaS 软件费）严格分离（A04 §1.4）
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
    id              VARCHAR(32)   PRIMARY KEY,
    contract_id     VARCHAR(32)   NOT NULL REFERENCES contracts(id),
    student_id      VARCHAR(32)   NOT NULL REFERENCES students(id),
    payment_type    VARCHAR(16)   NOT NULL DEFAULT '定金'
                    CHECK (payment_type IN ('定金','首款','尾款','分期','续费款')),
    paid_amount     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
    due_amount      NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (due_amount >= 0),
    installment_no  INTEGER       NOT NULL DEFAULT 1 CHECK (installment_no >= 1),
    invoice_status  VARCHAR(16)   NOT NULL DEFAULT '未申请'
                    CHECK (invoice_status IN ('未申请','待审核','已开票')),
    refund_status   VARCHAR(16)   NOT NULL DEFAULT '无退款'
                    CHECK (refund_status IN ('无退款','退款中','已退款')),
    paid_at         TIMESTAMPTZ   NULL,
    paid_locked     BOOLEAN       NOT NULL DEFAULT FALSE,
    reverse_from_id VARCHAR(32)   NULL,
    reverse_type    VARCHAR(16)   NULL
                    CHECK (reverse_type IS NULL OR reverse_type IN ('退款','转班','扩科','补充')),
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by      VARCHAR(32)   NOT NULL,
    updated_by      VARCHAR(32)   NOT NULL,
    deleted_at      TIMESTAMPTZ   NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_contract_id   ON payments(contract_id);
CREATE INDEX IF NOT EXISTS idx_payments_student_id    ON payments(student_id);
CREATE INDEX IF NOT EXISTS idx_payments_payment_type  ON payments(payment_type);
CREATE INDEX IF NOT EXISTS idx_payments_refund_status ON payments(refund_status);
CREATE INDEX IF NOT EXISTS idx_payments_paid_at       ON payments(paid_at);
CREATE INDEX IF NOT EXISTS idx_payments_paid_locked   ON payments(paid_locked);

-- ----------------------------------------------------------------
-- §3.5 reverse_orders 逆向单 / 补充单（A12 独立表）
-- 5 状态机：待审核 / 已批准 / 已执行 / 已拒绝 / 已取消（A12 执行细化规约）
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reverse_orders (
    id                       VARCHAR(32)   PRIMARY KEY,
    source_contract_id       VARCHAR(32)   NOT NULL REFERENCES contracts(id),
    source_payment_id        VARCHAR(32)   NULL REFERENCES payments(id),
    reverse_type             VARCHAR(16)   NOT NULL
                             CHECK (reverse_type IN ('退款','转班','扩科','补充')),
    reverse_amount           NUMERIC(12,2) NOT NULL,             -- 可正可负（退款负 / 扩科正）
    reverse_status           VARCHAR(16)   NOT NULL DEFAULT '待审核'
                             CHECK (reverse_status IN ('待审核','已批准','已执行','已拒绝','已取消')),
    reason                   VARCHAR(256)  NOT NULL,
    affect_gmv               BOOLEAN       NOT NULL DEFAULT TRUE,
    affect_student_business  BOOLEAN       NOT NULL DEFAULT TRUE,
    reviewed_by              VARCHAR(32)   NULL REFERENCES users(id),
    executed_at              TIMESTAMPTZ   NULL,
    created_at               TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by               VARCHAR(32)   NOT NULL,
    updated_by               VARCHAR(32)   NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reverse_source_contract ON reverse_orders(source_contract_id);
CREATE INDEX IF NOT EXISTS idx_reverse_source_payment  ON reverse_orders(source_payment_id);
CREATE INDEX IF NOT EXISTS idx_reverse_status          ON reverse_orders(reverse_status);
CREATE INDEX IF NOT EXISTS idx_reverse_type            ON reverse_orders(reverse_type);

-- ----------------------------------------------------------------
-- §3.6 referrals 老客转介绍（链路 A 占位，F05 待答前最小骨架）
-- 链路 B 同行推荐（不进入本期）将放公共 schema 的 product_referrals 表
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS referrals (
    id                      VARCHAR(32)  PRIMARY KEY,
    referrer_customer_id    VARCHAR(32)  NOT NULL REFERENCES customers(id),
    recipient_lead_id       VARCHAR(32)  NOT NULL REFERENCES leads(id),
    recipient_customer_id   VARCHAR(32)  NULL REFERENCES customers(id),
    reward_type             VARCHAR(16)  NULL,
    reward_status           VARCHAR(16)  NOT NULL DEFAULT '待发放'
                            CHECK (reward_status IN ('待发放','已发放','已取消')),
    reward_at               TIMESTAMPTZ  NULL,
    created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by              VARCHAR(32)  NOT NULL,
    updated_by              VARCHAR(32)  NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer  ON referrals(referrer_customer_id);
CREATE INDEX IF NOT EXISTS idx_referrals_recipient ON referrals(recipient_lead_id);
CREATE INDEX IF NOT EXISTS idx_referrals_status    ON referrals(reward_status);

-- ----------------------------------------------------------------
-- 表注释
-- ----------------------------------------------------------------
COMMENT ON TABLE  contracts                  IS '合同（学员-课程关联），paid_locked=true 时 amount/status 禁改，调整走 reverse_orders';
COMMENT ON TABLE  payments                   IS '学费回款（机构内部），与公共 schema.payment_orders（SaaS 软件费）严格分离，A04 §1.4';
COMMENT ON TABLE  reverse_orders             IS 'A12 逆向单 / 补充单独立表，5 状态机';
COMMENT ON TABLE  referrals                  IS '链路 A 老客转介绍占位，F05 拍板前最小骨架（Q.PRICE/F05/Q08 等待答清单见协同问题分流表）';
COMMENT ON COLUMN contracts.paid_locked      IS 'A12：true 时禁止 UPDATE/DELETE 任何 amount/status；调整必须新建 reverse_orders';
COMMENT ON COLUMN payments.paid_locked       IS '同 contracts.paid_locked';
COMMENT ON COLUMN reverse_orders.reverse_amount IS '可正可负：退款类负值 / 扩科补充正值；需与 A12 执行细化规约的 GMV 联动规则一致';

COMMIT;
