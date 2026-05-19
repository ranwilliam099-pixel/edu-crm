--
-- PostgreSQL database dump
--

\restrict fFKiHliNllj5kiNbJ3UR1E5ZKWc6JFKPMLK9mhqKlavdNg9AnuktbcwszwDTGai

--
-- Name: __TENANT_SCHEMA__; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA __TENANT_SCHEMA__;

--
-- Name: assessments; Type: TABLE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE TABLE __TENANT_SCHEMA__.assessments (
    id character varying(32) NOT NULL,
    teacher_id character varying(32) NOT NULL,
    title character varying(128) NOT NULL,
    subject character varying(32) NOT NULL,
    assessment_type character varying(16) DEFAULT '月考'::character varying NOT NULL,
    total_score numeric(6,2) DEFAULT 100 NOT NULL,
    scheduled_at timestamp with time zone,
    status character varying(16) DEFAULT 'draft'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT assessments_assessment_type_check CHECK (((assessment_type)::text = ANY ((ARRAY['月考'::character varying, '期中'::character varying, '期末'::character varying, '单元测'::character varying, '其他'::character varying])::text[]))),
    CONSTRAINT assessments_status_check CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'published'::character varying, 'closed'::character varying])::text[]))),
    CONSTRAINT assessments_total_score_check CHECK ((total_score > (0)::numeric))
);

--
-- Name: assignment_recipients; Type: TABLE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE TABLE __TENANT_SCHEMA__.assignment_recipients (
    assignment_id character varying(32) NOT NULL,
    student_id character varying(32) NOT NULL
);

--
-- Name: audit_log; Type: TABLE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE TABLE __TENANT_SCHEMA__.audit_log (
    id bigint NOT NULL,
    actor_user_id uuid,
    actor_role character varying(32) NOT NULL,
    action character varying(64) NOT NULL,
    target_type character varying(64) NOT NULL,
    target_id uuid,
    before jsonb,
    after jsonb,
    ip inet,
    user_agent text,
    request_id character varying(64),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT audit_log_actor_role_chk CHECK (((actor_role)::text = ANY ((ARRAY['admin'::character varying, 'boss'::character varying, 'sales'::character varying, 'sales_manager'::character varying, 'sales_director'::character varying, 'academic'::character varying, 'academic_admin'::character varying, 'edu_admin'::character varying, 'ops'::character varying, 'teacher'::character varying, 'finance'::character varying, 'hr'::character varying, 'parent'::character varying, 'platform_admin'::character varying, 'system'::character varying])::text[])))
);

--
-- Name: TABLE audit_log; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON TABLE __TENANT_SCHEMA__.audit_log IS 'V33 审计日志（生产架构 P0）— 所有 sensitive 写操作落库';

--
-- Name: COLUMN audit_log.actor_user_id; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.audit_log.actor_user_id IS '操作人 user.id；NULL 表示系统动作（cron/migration），actor_role=''system''';

--
-- Name: COLUMN audit_log.actor_role; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.audit_log.actor_role IS '操作时角色（admin/boss/sales/academic/teacher/finance/parent/system 等）';

--
-- Name: COLUMN audit_log.action; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.audit_log.action IS '动作标识（如 student.transfer-sales / contract.activate / user.deactivate）';

--
-- Name: COLUMN audit_log.target_type; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.audit_log.target_type IS '目标对象类型（student/teacher/customer/contract/schedule 等）';

--
-- Name: COLUMN audit_log.target_id; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.audit_log.target_id IS '目标对象 id（UUID）';

--
-- Name: COLUMN audit_log.before; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.audit_log.before IS '更新前 JSON 快照（仅 update/delete 类动作）';

--
-- Name: COLUMN audit_log.after; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.audit_log.after IS '更新后 JSON 快照（仅 create/update 类动作）';

--
-- Name: COLUMN audit_log.ip; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.audit_log.ip IS '操作 IP';

--
-- Name: COLUMN audit_log.user_agent; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.audit_log.user_agent IS 'User-Agent 字符串';

--
-- Name: COLUMN audit_log.request_id; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.audit_log.request_id IS '链路追踪 ID（X-Request-Id），与日志框架联动';

--
-- Name: audit_log_id_seq; Type: SEQUENCE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE SEQUENCE __TENANT_SCHEMA__.audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER SEQUENCE __TENANT_SCHEMA__.audit_log_id_seq OWNED BY __TENANT_SCHEMA__.audit_log.id;

--
-- Name: campuses; Type: TABLE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE TABLE __TENANT_SCHEMA__.campuses (
    id character varying(32) NOT NULL,
    name character varying(64) NOT NULL,
    status character varying(16) DEFAULT '启用'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by character varying(32) NOT NULL,
    updated_by character varying(32) NOT NULL,
    address character varying(256),
    CONSTRAINT campuses_status_check CHECK (((status)::text = ANY ((ARRAY['启用'::character varying, '停用'::character varying])::text[])))
);

--
-- Name: COLUMN campuses.address; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.campuses.address IS 'V31 校区地址（街道 / 楼栋；可空）';

--
-- Name: contracts; Type: TABLE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE TABLE __TENANT_SCHEMA__.contracts (
    id character varying(32) NOT NULL,
    student_id character varying(32) NOT NULL,
    course_product_id character varying(32),
    class_type character varying(32),
    lesson_hours integer DEFAULT 0 NOT NULL,
    standard_price numeric(12,2) NOT NULL,
    discount_amount numeric(12,2) DEFAULT 0 NOT NULL,
    gift_hours integer DEFAULT 0 NOT NULL,
    total_amount numeric(12,2) NOT NULL,
    order_type character varying(16) DEFAULT '新签'::character varying NOT NULL,
    paid_locked boolean DEFAULT false NOT NULL,
    reverse_from_id character varying(32),
    reverse_type character varying(16),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by character varying(32) NOT NULL,
    updated_by character varying(32) NOT NULL,
    deleted_at timestamp with time zone,
    course_product_name_snapshot character varying(64),
    course_line_snapshot character varying(32),
    class_type_snapshot character varying(32),
    standard_price_snapshot numeric(12,2),
    owner_user_id character varying(32),
    opportunity_id character varying(32),
    signed_at timestamp with time zone,
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    activated_at timestamp with time zone,
    campus_id character varying(32),
    owner_changed_at timestamp with time zone,
    owner_change_reason character varying(64),
    course_product_name character varying(128),
    invoice_issued boolean DEFAULT false NOT NULL,
    CONSTRAINT contracts_discount_amount_check CHECK ((discount_amount >= (0)::numeric)),
    CONSTRAINT contracts_gift_hours_check CHECK ((gift_hours >= 0)),
    CONSTRAINT contracts_lesson_hours_check CHECK ((lesson_hours >= 0)),
    CONSTRAINT contracts_order_type_check CHECK (((order_type)::text = ANY ((ARRAY['新签'::character varying, '续费'::character varying, '扩科'::character varying, '升班'::character varying, '转班'::character varying])::text[]))),
    CONSTRAINT contracts_reverse_type_check CHECK (((reverse_type IS NULL) OR ((reverse_type)::text = ANY ((ARRAY['退款'::character varying, '转班'::character varying, '扩科'::character varying, '补充'::character varying])::text[])))),
    CONSTRAINT contracts_standard_price_check CHECK ((standard_price >= (0)::numeric)),
    CONSTRAINT contracts_standard_price_snapshot_check CHECK (((standard_price_snapshot IS NULL) OR (standard_price_snapshot >= (0)::numeric))),
    CONSTRAINT contracts_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'active'::character varying, 'expired'::character varying, 'cancelled'::character varying])::text[]))),
    CONSTRAINT contracts_total_amount_check CHECK ((total_amount >= (0)::numeric))
);

--
-- Name: TABLE contracts; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON TABLE __TENANT_SCHEMA__.contracts IS '合同（学员-课程关联），paid_locked=true 时 amount/status 禁改，调整走 reverse_orders';

--
-- Name: COLUMN contracts.course_product_id; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.contracts.course_product_id IS 'V29 NULLABLE — 销售可自填课程名而不绑定既有 course_products';

--
-- Name: COLUMN contracts.paid_locked; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.contracts.paid_locked IS 'A12：true 时禁止 UPDATE/DELETE 任何 amount/status；调整必须新建 reverse_orders';

--
-- Name: COLUMN contracts.course_product_name_snapshot; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.contracts.course_product_name_snapshot IS 'PD-06 Q08 历史保护快照';

--
-- Name: COLUMN contracts.standard_price_snapshot; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.contracts.standard_price_snapshot IS 'PD-06 Q08 历史合同永远按当时快照,主档改价不污染';

--
-- Name: COLUMN contracts.owner_user_id; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.contracts.owner_user_id IS 'V25 业绩归属销售（与 opportunities.owner_user_id 一致）';

--
-- Name: COLUMN contracts.campus_id; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.contracts.campus_id IS 'V26 签约归属校区（业绩按校区聚合 + 老板视角切换）';

--
-- Name: COLUMN contracts.owner_change_reason; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.contracts.owner_change_reason IS 'V27 contract owner 变更原因（业绩归属影响：转交后业绩归新 owner）';

--
-- Name: COLUMN contracts.course_product_name; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.contracts.course_product_name IS 'V29 销售自填的课程包名（如「英语 1v1 35 课时」）；与 course_product_id 二选一';

--
-- Name: COLUMN contracts.invoice_issued; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.contracts.invoice_issued IS 'Wave 4A V42 - 已开票标志（防重复开票 409 检测）；invoice.status=pending/issued 时该列=true';

--
-- Name: course_consumptions; Type: TABLE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE TABLE __TENANT_SCHEMA__.course_consumptions (
    id character varying(32) NOT NULL,
    schedule_id character varying(32) NOT NULL,
    student_id character varying(32) NOT NULL,
    teacher_id character varying(32) NOT NULL,
    status character varying(24) DEFAULT 'pending_feedback'::character varying NOT NULL,
    amount_yuan numeric(10,2),
    feedback_id character varying(32),
    feedback_due_at timestamp with time zone NOT NULL,
    confirmed_at timestamp with time zone,
    locked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT course_consumptions_status_check CHECK (((status)::text = ANY ((ARRAY['pending_feedback'::character varying, 'confirmed'::character varying, 'locked'::character varying, 'cancelled'::character varying])::text[])))
);

--
-- Name: course_packages; Type: TABLE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE TABLE __TENANT_SCHEMA__.course_packages (
    id character varying(32) NOT NULL,
    course_product_id character varying(32) NOT NULL,
    name character varying(64) NOT NULL,
    total_lessons integer NOT NULL,
    unit_price_yuan numeric(10,2) NOT NULL,
    total_price_yuan numeric(10,2) NOT NULL,
    validity_months integer DEFAULT 12 NOT NULL,
    status character varying(16) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by character varying(32) NOT NULL,
    updated_by character varying(32) NOT NULL,
    CONSTRAINT course_packages_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'archived'::character varying])::text[]))),
    CONSTRAINT course_packages_total_lessons_check CHECK ((total_lessons > 0)),
    CONSTRAINT course_packages_total_price_yuan_check CHECK ((total_price_yuan >= (0)::numeric)),
    CONSTRAINT course_packages_unit_price_yuan_check CHECK ((unit_price_yuan >= (0)::numeric)),
    CONSTRAINT course_packages_validity_months_check CHECK ((validity_months > 0))
);

--
-- Name: course_products; Type: TABLE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE TABLE __TENANT_SCHEMA__.course_products (
    id character varying(32) NOT NULL,
    product_name character varying(64) NOT NULL,
    course_line character varying(32) NOT NULL,
    class_type character varying(32) NOT NULL,
    lesson_package character varying(32),
    standard_price numeric(12,2) NOT NULL,
    campus_scope character varying(128),
    status character varying(16) DEFAULT '上架'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by character varying(32) NOT NULL,
    updated_by character varying(32) NOT NULL,
    CONSTRAINT course_products_standard_price_check CHECK ((standard_price >= (0)::numeric)),
    CONSTRAINT course_products_status_check CHECK (((status)::text = ANY ((ARRAY['上架'::character varying, '下架'::character varying])::text[])))
);

--
-- Name: customer_follow_log; Type: TABLE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE TABLE __TENANT_SCHEMA__.customer_follow_log (
    id character varying(32) NOT NULL,
    opportunity_id character varying(32) NOT NULL,
    follow_type character varying(32) NOT NULL,
    label character varying(256) NOT NULL,
    by_user_id character varying(32),
    by_label character varying(64) DEFAULT '系统'::character varying NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    extra_json jsonb,
    CONSTRAINT customer_follow_log_follow_type_check CHECK (((follow_type)::text = ANY ((ARRAY['lead'::character varying, 'consult'::character varying, 'trial_invited'::character varying, 'trial_done'::character varying, 'signed'::character varying, 'lost'::character varying, 'remark'::character varying, 'released'::character varying, 'claimed'::character varying, 'transferred'::character varying])::text[])))
);

--
-- Name: TABLE customer_follow_log; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON TABLE __TENANT_SCHEMA__.customer_follow_log IS 'V25 客户跟进时间轴（详情页 timeline 数据源）';

--
-- Name: customers; Type: TABLE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE TABLE __TENANT_SCHEMA__.customers (
    id character varying(32) NOT NULL,
    parent_name character varying(32) NOT NULL,
    primary_mobile character varying(16) NOT NULL,
    wechat_id character varying(64),
    city character varying(32),
    campus_id character varying(32) NOT NULL,
    family_tag character varying(128),
    source_level1 character varying(32),
    owner_id character varying(32),
    is_returning_customer boolean DEFAULT false NOT NULL,
    referrer_id character varying(32),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by character varying(32) NOT NULL,
    updated_by character varying(32) NOT NULL,
    deleted_at timestamp with time zone,
    primary_mobile_hash bytea,
    primary_mobile_encrypted bytea
);

--
-- Name: COLUMN customers.primary_mobile_hash; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.customers.primary_mobile_hash IS 'V41 HMAC-SHA256(primary_mobile, HASH_KEY) 32 bytes — 用于等值查询（学员导入查重 / 防重复客户）';

--
-- Name: COLUMN customers.primary_mobile_encrypted; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.customers.primary_mobile_encrypted IS 'V41 AES-256-GCM(primary_mobile, ENCRYPTION_KEY) — 格式 [IV 12B][AuthTag 16B][Cipher]';

--
-- Name: homework_assignments; Type: TABLE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE TABLE __TENANT_SCHEMA__.homework_assignments (
    id character varying(32) NOT NULL,
    schedule_id character varying(32),
    teacher_id character varying(32) NOT NULL,
    title character varying(128) NOT NULL,
    content text,
    attachments jsonb,
    due_at timestamp with time zone,
    difficulty character varying(8),
    status character varying(16) DEFAULT 'published'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT homework_assignments_difficulty_check CHECK (((difficulty)::text = ANY ((ARRAY['易'::character varying, '中'::character varying, '难'::character varying])::text[]))),
    CONSTRAINT homework_assignments_status_check CHECK (((status)::text = ANY ((ARRAY['published'::character varying, 'archived'::character varying])::text[])))
);

--
-- Name: homework_submissions; Type: TABLE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE TABLE __TENANT_SCHEMA__.homework_submissions (
    id character varying(32) NOT NULL,
    assignment_id character varying(32) NOT NULL,
    student_id character varying(32) NOT NULL,
    submitted_by_parent_id character varying(32),
    content text,
    attachments jsonb,
    status character varying(16) DEFAULT 'submitted'::character varying NOT NULL,
    grade character varying(8),
    teacher_comment text,
    graded_at timestamp with time zone,
    graded_by_user_id character varying(32),
    submitted_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT homework_submissions_grade_check CHECK (((grade)::text = ANY ((ARRAY['A+'::character varying, 'A'::character varying, 'B'::character varying, 'C'::character varying, 'D'::character varying, '须重做'::character varying])::text[]))),
    CONSTRAINT homework_submissions_status_check CHECK (((status)::text = ANY ((ARRAY['submitted'::character varying, 'graded'::character varying, 'returned'::character varying])::text[])))
);

--
-- Name: invoices; Type: TABLE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE TABLE __TENANT_SCHEMA__.invoices (
    id character(32) NOT NULL,
    contract_id character(32) NOT NULL,
    student_id character(32),
    customer_id character(32),
    title_type character varying(8) NOT NULL,
    invoice_title text NOT NULL,
    invoice_title_encrypted bytea,
    tax_id text,
    tax_id_encrypted bytea,
    receive_email text,
    receive_phone character varying(16),
    receive_phone_hash bytea,
    receive_phone_encrypted bytea,
    amount numeric(14,2) NOT NULL,
    remark text,
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    created_by_user_id character(32) NOT NULL,
    issued_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT invoices_amount_nonneg CHECK ((amount >= (0)::numeric)),
    CONSTRAINT invoices_status_chk CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'issued'::character varying, 'cancelled'::character varying])::text[]))),
    CONSTRAINT invoices_title_type_chk CHECK (((title_type)::text = ANY ((ARRAY['个人'::character varying, '企业'::character varying])::text[])))
);

--
-- Name: TABLE invoices; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON TABLE __TENANT_SCHEMA__.invoices IS 'Wave 4A B 端 finance 域开票（与 checkout/invoice_requests C 端自助分离）';

--
-- Name: COLUMN invoices.contract_id; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.invoices.contract_id IS 'OOUX 父对象 contracts.id（FK 软引用 - 不加 PG FK 防 tenant schema 迁移困难）';

--
-- Name: COLUMN invoices.student_id; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.invoices.student_id IS '派生 snapshot - 防 contract 改 student 后追溯失真';

--
-- Name: COLUMN invoices.customer_id; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.invoices.customer_id IS '派生 snapshot - 财务作账可不查 students/customers 即知归属';

--
-- Name: COLUMN invoices.title_type; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.invoices.title_type IS '抬头类型 - 个人/企业（与设计契约一致）';

--
-- Name: COLUMN invoices.invoice_title; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.invoices.invoice_title IS '抬头明文（兼容期）- 未来 DROP，仅留 invoice_title_encrypted';

--
-- Name: COLUMN invoices.invoice_title_encrypted; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.invoices.invoice_title_encrypted IS 'AES-256-GCM(invoice_title, ENCRYPTION_KEY) - V42 新写入双写';

--
-- Name: COLUMN invoices.tax_id; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.invoices.tax_id IS '税号明文（兼容期）- 企业必填 18 位统一信用代码';

--
-- Name: COLUMN invoices.tax_id_encrypted; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.invoices.tax_id_encrypted IS 'AES-256-GCM(tax_id, ENCRYPTION_KEY)';

--
-- Name: COLUMN invoices.receive_phone_hash; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.invoices.receive_phone_hash IS 'HMAC-SHA256(receive_phone, HASH_KEY) - 等值查询';

--
-- Name: COLUMN invoices.receive_phone_encrypted; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.invoices.receive_phone_encrypted IS 'AES-256-GCM(receive_phone, ENCRYPTION_KEY)';

--
-- Name: COLUMN invoices.amount; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.invoices.amount IS '金额（元）- snapshot 自 contracts.total_amount，财务不可改';

--
-- Name: COLUMN invoices.status; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.invoices.status IS 'pending=已提交待出票 / issued=已出票 / cancelled=已撤销（红冲）';

--
-- Name: leads; Type: TABLE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE TABLE __TENANT_SCHEMA__.leads (
    id character varying(32) NOT NULL,
    source_level1 character varying(32) NOT NULL,
    source_level2 character varying(64) NOT NULL,
    source_level3 character varying(128),
    campus_id character varying(32) NOT NULL,
    course_line character varying(64),
    owner_id character varying(32),
    first_contact_at timestamp with time zone,
    invalid_reason character varying(32),
    enroll_attribution character varying(32) DEFAULT '末次有效触点'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by character varying(32) NOT NULL,
    updated_by character varying(32) NOT NULL,
    CONSTRAINT leads_enroll_attribution_check CHECK (((enroll_attribution)::text = ANY ((ARRAY['首次接触'::character varying, '末次有效触点'::character varying, '转介绍优先'::character varying])::text[]))),
    CONSTRAINT leads_invalid_reason_check CHECK (((invalid_reason IS NULL) OR ((invalid_reason)::text = ANY ((ARRAY['空号'::character varying, '重复'::character varying, '无需求'::character varying, '预算不足'::character varying, '竞品已成交'::character varying])::text[]))))
);

--
-- Name: leaves; Type: TABLE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE TABLE __TENANT_SCHEMA__.leaves (
    id character varying(32) NOT NULL,
    student_id character varying(32) NOT NULL,
    lesson_id character varying(32),
    type character varying(16) NOT NULL,
    reason character varying(64),
    reason_note text,
    new_date date,
    new_start_at timestamp with time zone,
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    reject_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    CONSTRAINT leaves_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'approved'::character varying, 'rejected'::character varying])::text[]))),
    CONSTRAINT leaves_type_check CHECK (((type)::text = ANY ((ARRAY['leave'::character varying, 'reschedule'::character varying])::text[])))
);

--
-- Name: TABLE leaves; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON TABLE __TENANT_SCHEMA__.leaves IS '请假/调课申请。距上课 < 24h 提交时 controller 在 response 加 warning';

--
-- Name: lesson_feedbacks; Type: TABLE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE TABLE __TENANT_SCHEMA__.lesson_feedbacks (
    id character varying(32) NOT NULL,
    schedule_id character varying(32) NOT NULL,
    student_id character varying(32) NOT NULL,
    teacher_id character varying(32) NOT NULL,
    attendance_status character varying(16) NOT NULL,
    classroom_performance character varying(16) NOT NULL,
    knowledge_points jsonb,
    homework text,
    homework_attachments jsonb,
    teacher_note text,
    teacher_internal_note text,
    parent_read_at timestamp with time zone,
    submitted_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    knowledge_matrix jsonb,
    dim_ratings jsonb,
    homework_deadline timestamp with time zone,
    homework_difficulty character varying(8),
    next_preview text,
    CONSTRAINT lesson_feedbacks_attendance_status_check CHECK (((attendance_status)::text = ANY ((ARRAY['出勤'::character varying, '迟到'::character varying, '缺席'::character varying, '请假'::character varying])::text[]))),
    CONSTRAINT lesson_feedbacks_classroom_performance_check CHECK (((classroom_performance)::text = ANY ((ARRAY['优秀'::character varying, '良好'::character varying, '合格'::character varying, '需努力'::character varying, '需关注'::character varying])::text[]))),
    CONSTRAINT lesson_feedbacks_homework_difficulty_check CHECK (((homework_difficulty IS NULL) OR ((homework_difficulty)::text = ANY ((ARRAY['basic'::character varying, 'medium'::character varying, 'hard'::character varying])::text[]))))
);

--
-- Name: COLUMN lesson_feedbacks.knowledge_matrix; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.lesson_feedbacks.knowledge_matrix IS 'V18 知识点矩阵 [{name, mastery}]';

--
-- Name: COLUMN lesson_feedbacks.dim_ratings; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.lesson_feedbacks.dim_ratings IS 'V18 4 维评分 {focus, engage, think, homework}';

--
-- Name: COLUMN lesson_feedbacks.homework_deadline; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.lesson_feedbacks.homework_deadline IS 'V18 作业截止时间';

--
-- Name: COLUMN lesson_feedbacks.homework_difficulty; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.lesson_feedbacks.homework_difficulty IS 'V18 作业难度 basic|medium|hard';

--
-- Name: COLUMN lesson_feedbacks.next_preview; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.lesson_feedbacks.next_preview IS 'V18 下次课预习提示';

--
-- Name: monthly_aggregates; Type: TABLE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE TABLE __TENANT_SCHEMA__.monthly_aggregates (
    id bigint NOT NULL,
    entity_type character varying(20) NOT NULL,
    entity_id character varying(32) NOT NULL,
    month date NOT NULL,
    lessons_count integer,
    feedback_count integer,
    feedback_rate numeric(5,2),
    avg_stars numeric(3,2),
    revenue_yuan numeric(12,2),
    new_signups integer,
    active_students integer,
    raw_json jsonb,
    computed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT monthly_aggregates_entity_type_check CHECK (((entity_type)::text = ANY ((ARRAY['teacher'::character varying, 'campus'::character varying, 'tenant'::character varying])::text[])))
);

--
-- Name: TABLE monthly_aggregates; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON TABLE __TENANT_SCHEMA__.monthly_aggregates IS 'V24 月度统计快照（每月 1 号 cron 计算上月数据）';

--
-- Name: COLUMN monthly_aggregates.month; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.monthly_aggregates.month IS '月份（DATE 类型，月初 1 号）';

--
-- Name: monthly_aggregates_id_seq; Type: SEQUENCE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE SEQUENCE __TENANT_SCHEMA__.monthly_aggregates_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: monthly_aggregates_id_seq; Type: SEQUENCE OWNED BY; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER SEQUENCE __TENANT_SCHEMA__.monthly_aggregates_id_seq OWNED BY __TENANT_SCHEMA__.monthly_aggregates.id;

--
-- Name: monthly_reports; Type: TABLE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE TABLE __TENANT_SCHEMA__.monthly_reports (
    id character varying(32) NOT NULL,
    student_id character varying(32) NOT NULL,
    teacher_id character varying(32) NOT NULL,
    month date NOT NULL,
    attendance_summary jsonb NOT NULL,
    performance_trend jsonb NOT NULL,
    knowledge_summary jsonb NOT NULL,
    teacher_blessing text,
    renewal_suggestion text,
    status character varying(24) DEFAULT 'auto_generated'::character varying NOT NULL,
    generated_at timestamp with time zone DEFAULT now() NOT NULL,
    finalized_at timestamp with time zone,
    parent_read_at timestamp with time zone,
    parent_blessing text,
    parent_highlights jsonb,
    parent_improvements jsonb,
    parent_next_plan text,
    parent_finalized_at timestamp with time zone,
    CONSTRAINT monthly_reports_status_check CHECK (((status)::text = ANY ((ARRAY['auto_generated'::character varying, 'teacher_finalized'::character varying])::text[])))
);

--
-- Name: COLUMN monthly_reports.teacher_blessing; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.monthly_reports.teacher_blessing IS 'V9 teacher/admin/boss 视角的寄语 — 老师补寄语（finalize 时填）。⚠️ 双轨硬红线: parent audience 路径 SELECT 不暴露此字段（前端 c 端走 parent_blessing 渲染）';

--
-- Name: COLUMN monthly_reports.renewal_suggestion; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.monthly_reports.renewal_suggestion IS 'V9 老师/内部续报建议 — 严禁暴露给家长 c 端。⚠️ 双轨硬红线: parent role JWT 强制 audience=parent，SQL 不返回此列';

--
-- Name: COLUMN monthly_reports.parent_blessing; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.monthly_reports.parent_blessing IS 'V36 家长版"温柔"寄语 — c 端 c/monthly-report/detail 显示。老师可基于 teacher_blessing 改写为家长可读版本（不含 KPI 数据 / 续报话术）';

--
-- Name: COLUMN monthly_reports.parent_highlights; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.monthly_reports.parent_highlights IS 'V36 家长版进步亮点 [{ point: string, lessonCount?: number }, ...] — c 端只读列表渲染。与 teacher 内部 knowledge_summary 隔离，已按家长可读语言加工';

--
-- Name: COLUMN monthly_reports.parent_improvements; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.monthly_reports.parent_improvements IS 'V36 家长版待改进 [{ point: string, suggestion?: string }, ...] — c 端只读列表渲染。注：避免出现 KPI / 排名 / 工资等敏感词，仅含建设性指导';

--
-- Name: COLUMN monthly_reports.parent_next_plan; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.monthly_reports.parent_next_plan IS 'V36 家长版下月计划 — c 端可读总览。⚠️ 与 renewal_suggestion 严格隔离：本字段是学习计划而非续报营销';

--
-- Name: COLUMN monthly_reports.parent_finalized_at; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.monthly_reports.parent_finalized_at IS 'V36 家长版 finalize 时间 — NULL 表示家长版尚未补写（前端 fallback 用基础字段）。查询条件: parent_finalized_at IS NOT NULL → 家长版可见';

--
-- Name: opportunities; Type: TABLE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE TABLE __TENANT_SCHEMA__.opportunities (
    id character varying(32) NOT NULL,
    student_id character varying(32) NOT NULL,
    course_product_id character varying(32),
    stage character varying(32) DEFAULT '初步接触'::character varying NOT NULL,
    quote_amount numeric(12,2),
    intent_level character varying(16),
    next_action character varying(128),
    next_followup_at timestamp with time zone,
    signed_at timestamp with time zone,
    lost_reason character varying(32),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by character varying(32) NOT NULL,
    updated_by character varying(32) NOT NULL,
    course_product_name_snapshot character varying(64),
    course_line_snapshot character varying(32),
    class_type_snapshot character varying(32),
    standard_price_snapshot numeric(12,2),
    owner_user_id character varying(32),
    entered_pool_at timestamp with time zone,
    enter_pool_reason character varying(64),
    last_contact_at timestamp with time zone,
    urgent boolean DEFAULT false NOT NULL,
    source character varying(32),
    phone character varying(20),
    wechat character varying(64),
    note text,
    campus_id character varying(32),
    owner_changed_at timestamp with time zone,
    owner_change_reason character varying(64),
    phone_encrypted bytea,
    wechat_encrypted bytea,
    CONSTRAINT opportunities_intent_level_check CHECK (((intent_level IS NULL) OR ((intent_level)::text = ANY ((ARRAY['高'::character varying, '中'::character varying, '低'::character varying])::text[])))),
    CONSTRAINT opportunities_lost_reason_check CHECK (((lost_reason IS NULL) OR ((lost_reason)::text = ANY ((ARRAY['价格高'::character varying, '时间不合适'::character varying, '竞品成交'::character varying, '无需求'::character varying, '家长放弃'::character varying])::text[])))),
    CONSTRAINT opportunities_quote_amount_check CHECK (((quote_amount IS NULL) OR (quote_amount >= (0)::numeric))),
    CONSTRAINT opportunities_stage_check CHECK (((stage)::text = ANY ((ARRAY['初步接触'::character varying, '需求诊断'::character varying, '已预约试听'::character varying, '已试听待转化'::character varying, '已出方案'::character varying, '谈单中'::character varying, '已报名'::character varying, '已失单'::character varying])::text[]))),
    CONSTRAINT opportunities_standard_price_snapshot_check CHECK (((standard_price_snapshot IS NULL) OR (standard_price_snapshot >= (0)::numeric)))
);

--
-- Name: COLUMN opportunities.course_product_id; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.opportunities.course_product_id IS 'V30 NULLABLE — 销售即时建客户时课程未定，可后续补；签约时也可不绑既有产品（V29）';

--
-- Name: COLUMN opportunities.course_product_name_snapshot; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.opportunities.course_product_name_snapshot IS 'PD-06 Q08 写入瞬间 course_products.name 快照,改名不回写';

--
-- Name: COLUMN opportunities.course_line_snapshot; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.opportunities.course_line_snapshot IS 'PD-06 Q08 写入瞬间 course_products.line_category 快照';

--
-- Name: COLUMN opportunities.class_type_snapshot; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.opportunities.class_type_snapshot IS 'PD-06 Q08 写入瞬间 course_products.class_type 快照';

--
-- Name: COLUMN opportunities.standard_price_snapshot; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.opportunities.standard_price_snapshot IS 'PD-06 Q08 写入瞬间 course_products.standard_price 快照,改价不回写';

--
-- Name: COLUMN opportunities.owner_user_id; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.opportunities.owner_user_id IS 'V25 客户归属销售（NULL = 公共池）';

--
-- Name: COLUMN opportunities.entered_pool_at; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.opportunities.entered_pool_at IS 'V25 入池时间（owner_user_id IS NULL 时有意义）';

--
-- Name: COLUMN opportunities.enter_pool_reason; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.opportunities.enter_pool_reason IS 'V25 入池原因：new_lead / released_by_sales / cold_30d / sales_quit';

--
-- Name: COLUMN opportunities.urgent; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.opportunities.urgent IS 'V25 紧急标记（优质线索 / 试听后未跟）';

--
-- Name: COLUMN opportunities.campus_id; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.opportunities.campus_id IS 'V26 客户归属校区（老板视角切换过滤；NULL = 跨校或未指定）';

--
-- Name: COLUMN opportunities.owner_change_reason; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.opportunities.owner_change_reason IS 'V27 owner 变更原因：离职转交 / 校长再分配 / 主动认领（用于审计与「待交接」展示）';

--
-- Name: COLUMN opportunities.phone_encrypted; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.opportunities.phone_encrypted IS 'V34 AES-256-GCM 加密客户手机号';

--
-- Name: COLUMN opportunities.wechat_encrypted; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.opportunities.wechat_encrypted IS 'V34 AES-256-GCM 加密微信号';

--
-- Name: parent_recommendations; Type: TABLE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE TABLE __TENANT_SCHEMA__.parent_recommendations (
    id character varying(32) NOT NULL,
    teacher_id character varying(32) NOT NULL,
    parent_id character varying(32) NOT NULL,
    student_id character varying(32) NOT NULL,
    stars smallint NOT NULL,
    content text,
    tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    parent_authorized boolean DEFAULT false NOT NULL,
    displayed boolean DEFAULT false NOT NULL,
    submitted_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT parent_recommendations_stars_check CHECK (((stars >= 1) AND (stars <= 5)))
);

--
-- Name: TABLE parent_recommendations; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON TABLE __TENANT_SCHEMA__.parent_recommendations IS 'V17 家长推荐。displayed 由老师 toggle，但只有 parent_authorized=true 才可勾选';

--
-- Name: COLUMN parent_recommendations.parent_authorized; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.parent_recommendations.parent_authorized IS '家长授权公开（隐私必备前置条件）';

--
-- Name: COLUMN parent_recommendations.displayed; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.parent_recommendations.displayed IS '老师是否选中展示在业务卡（toggle）';

--
-- Name: parent_referrals; Type: TABLE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE TABLE __TENANT_SCHEMA__.parent_referrals (
    id character varying(32) NOT NULL,
    teacher_id character varying(32) NOT NULL,
    referrer_parent_id character varying(32) NOT NULL,
    referrer_student_id character varying(32) NOT NULL,
    referee_parent_id character varying(32),
    referee_student_id character varying(32),
    referral_code character varying(40) NOT NULL,
    status character varying(20) DEFAULT 'created'::character varying NOT NULL,
    trial_schedule_id character varying(32),
    rating_id character varying(32),
    rating_id_source character varying(20),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    trialed_at timestamp with time zone,
    rated_at timestamp with time zone,
    expires_at timestamp with time zone DEFAULT (now() + '30 days'::interval) NOT NULL,
    note character varying(256),
    CONSTRAINT parent_referrals_rating_id_source_check CHECK (((rating_id_source IS NULL) OR ((rating_id_source)::text = ANY ((ARRAY['lesson_feedback'::character varying, 'parent_recommendation'::character varying])::text[])))),
    CONSTRAINT parent_referrals_status_check CHECK (((status)::text = ANY ((ARRAY['created'::character varying, 'trialed'::character varying, 'rated'::character varying, 'expired'::character varying])::text[])))
);

--
-- Name: TABLE parent_referrals; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON TABLE __TENANT_SCHEMA__.parent_referrals IS 'V22 家长推荐家长关系链（V10 策略 #17-22 推荐机制）';

--
-- Name: COLUMN parent_referrals.referrer_parent_id; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.parent_referrals.referrer_parent_id IS 'A：推荐人 parent_id；必须是该 teacher 学员的家长';

--
-- Name: COLUMN parent_referrals.referee_parent_id; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.parent_referrals.referee_parent_id IS 'B：被推荐人 parent_id；UNIQUE（一个家长只能被推荐一次）';

--
-- Name: COLUMN parent_referrals.referral_code; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.parent_referrals.referral_code IS '小程序码 scene 字符串（前端生成 wxacode 时传入）';

--
-- Name: COLUMN parent_referrals.status; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.parent_referrals.status IS '状态机：created → trialed → rated（计数 +1）/ expired';

--
-- Name: payments; Type: TABLE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE TABLE __TENANT_SCHEMA__.payments (
    id character varying(32) NOT NULL,
    contract_id character varying(32) NOT NULL,
    student_id character varying(32) NOT NULL,
    payment_type character varying(16) DEFAULT '定金'::character varying NOT NULL,
    paid_amount numeric(12,2) DEFAULT 0 NOT NULL,
    due_amount numeric(12,2) DEFAULT 0 NOT NULL,
    installment_no integer DEFAULT 1 NOT NULL,
    invoice_status character varying(16) DEFAULT '未申请'::character varying NOT NULL,
    refund_status character varying(16) DEFAULT '无退款'::character varying NOT NULL,
    paid_at timestamp with time zone,
    paid_locked boolean DEFAULT false NOT NULL,
    reverse_from_id character varying(32),
    reverse_type character varying(16),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by character varying(32) NOT NULL,
    updated_by character varying(32) NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT payments_due_amount_check CHECK ((due_amount >= (0)::numeric)),
    CONSTRAINT payments_installment_no_check CHECK ((installment_no >= 1)),
    CONSTRAINT payments_invoice_status_check CHECK (((invoice_status)::text = ANY ((ARRAY['未申请'::character varying, '待审核'::character varying, '已开票'::character varying])::text[]))),
    CONSTRAINT payments_paid_amount_check CHECK ((paid_amount >= (0)::numeric)),
    CONSTRAINT payments_payment_type_check CHECK (((payment_type)::text = ANY ((ARRAY['定金'::character varying, '首款'::character varying, '尾款'::character varying, '分期'::character varying, '续费款'::character varying])::text[]))),
    CONSTRAINT payments_refund_status_check CHECK (((refund_status)::text = ANY ((ARRAY['无退款'::character varying, '退款中'::character varying, '已退款'::character varying])::text[]))),
    CONSTRAINT payments_reverse_type_check CHECK (((reverse_type IS NULL) OR ((reverse_type)::text = ANY ((ARRAY['退款'::character varying, '转班'::character varying, '扩科'::character varying, '补充'::character varying])::text[]))))
);

--
-- Name: TABLE payments; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON TABLE __TENANT_SCHEMA__.payments IS '学费回款（机构内部），与公共 schema.payment_orders（SaaS 软件费）严格分离，A04 §1.4';

--
-- Name: COLUMN payments.paid_locked; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.payments.paid_locked IS '同 contracts.paid_locked';

--
-- Name: recurring_schedules; Type: TABLE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE TABLE __TENANT_SCHEMA__.recurring_schedules (
    id character varying(32) NOT NULL,
    binding_id character varying(32) NOT NULL,
    student_id character varying(32) NOT NULL,
    teacher_id character varying(32) NOT NULL,
    course_product_id character varying(32),
    by_day jsonb NOT NULL,
    start_minutes integer NOT NULL,
    duration_min integer NOT NULL,
    start_date date NOT NULL,
    end_date date,
    status character varying(16) DEFAULT 'active'::character varying NOT NULL,
    created_by_user_id character varying(32) NOT NULL,
    created_by_role character varying(24) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    CONSTRAINT recurring_schedules_duration_min_check CHECK (((duration_min > 0) AND (duration_min <= 480))),
    CONSTRAINT recurring_schedules_start_minutes_check CHECK (((start_minutes >= 0) AND (start_minutes <= 1439))),
    CONSTRAINT recurring_schedules_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'archived'::character varying])::text[])))
);

--
-- Name: referrals; Type: TABLE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE TABLE __TENANT_SCHEMA__.referrals (
    id character varying(32) NOT NULL,
    tenant_id character varying(32) NOT NULL,
    referrer_customer_id character varying(32) NOT NULL,
    referrer_student_id character varying(32),
    referred_parent_name character varying(32) NOT NULL,
    referred_mobile character varying(16) NOT NULL,
    referred_student_name character varying(32),
    campus_id character varying(32) NOT NULL,
    status character varying(16) DEFAULT 'new'::character varying NOT NULL,
    reward_status character varying(16) DEFAULT 'none'::character varying NOT NULL,
    source_lead_id character varying(32),
    converted_customer_id character varying(32),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT referrals_reward_status_check CHECK (((reward_status)::text = ANY ((ARRAY['none'::character varying, 'pending'::character varying, 'granted'::character varying, 'cancelled'::character varying])::text[]))),
    CONSTRAINT referrals_status_check CHECK (((status)::text = ANY ((ARRAY['new'::character varying, 'contacted'::character varying, 'converted'::character varying, 'invalid'::character varying])::text[])))
);

--
-- Name: renewals; Type: TABLE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE TABLE __TENANT_SCHEMA__.renewals (
    id character varying(32) NOT NULL,
    tenant_id character varying(32) NOT NULL,
    source_contract_id character varying(32) NOT NULL,
    customer_id character varying(32) NOT NULL,
    student_id character varying(32) NOT NULL,
    campus_id character varying(32) NOT NULL,
    course_product_id character varying(32) NOT NULL,
    due_at timestamp with time zone NOT NULL,
    status character varying(16) DEFAULT 'to_renew'::character varying NOT NULL,
    owner_id character varying(32) NOT NULL,
    expected_amount numeric(12,2),
    renewed_contract_id character varying(32),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT renewals_expected_amount_check CHECK (((expected_amount IS NULL) OR (expected_amount >= (0)::numeric))),
    CONSTRAINT renewals_status_check CHECK (((status)::text = ANY ((ARRAY['to_renew'::character varying, 'contacting'::character varying, 'renewed'::character varying, 'lost'::character varying])::text[])))
);

--
-- Name: reverse_orders; Type: TABLE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE TABLE __TENANT_SCHEMA__.reverse_orders (
    id character varying(32) NOT NULL,
    source_contract_id character varying(32) NOT NULL,
    source_payment_id character varying(32),
    reverse_type character varying(16) NOT NULL,
    reverse_amount numeric(12,2) NOT NULL,
    reverse_status character varying(16) DEFAULT '待审核'::character varying NOT NULL,
    reason character varying(256) NOT NULL,
    affect_gmv boolean DEFAULT true NOT NULL,
    affect_student_business boolean DEFAULT true NOT NULL,
    reviewed_by character varying(32),
    executed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by character varying(32) NOT NULL,
    updated_by character varying(32) NOT NULL,
    CONSTRAINT reverse_orders_reverse_status_check CHECK (((reverse_status)::text = ANY ((ARRAY['待审核'::character varying, '已批准'::character varying, '已执行'::character varying, '已拒绝'::character varying, '已取消'::character varying])::text[]))),
    CONSTRAINT reverse_orders_reverse_type_check CHECK (((reverse_type)::text = ANY ((ARRAY['退款'::character varying, '转班'::character varying, '扩科'::character varying, '补充'::character varying])::text[])))
);

--
-- Name: TABLE reverse_orders; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON TABLE __TENANT_SCHEMA__.reverse_orders IS 'A12 逆向单 / 补充单独立表，5 状态机';

--
-- Name: COLUMN reverse_orders.reverse_amount; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.reverse_orders.reverse_amount IS '可正可负：退款类负值 / 扩科补充正值；需与 A12 执行细化规约的 GMV 联动规则一致';

--
-- Name: schedule_students; Type: TABLE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE TABLE __TENANT_SCHEMA__.schedule_students (
    schedule_id character varying(32) NOT NULL,
    student_id character varying(32) NOT NULL,
    attendance_status character varying(16) DEFAULT '待出勤'::character varying NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT schedule_students_attendance_status_check CHECK (((attendance_status)::text = ANY ((ARRAY['待出勤'::character varying, '出勤'::character varying, '迟到'::character varying, '缺席'::character varying, '请假'::character varying])::text[])))
);

--
-- Name: schedules; Type: TABLE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE TABLE __TENANT_SCHEMA__.schedules (
    id character varying(32) NOT NULL,
    course_product_id character varying(32),
    teacher_id character varying(32) NOT NULL,
    start_at timestamp with time zone NOT NULL,
    duration_min integer NOT NULL,
    end_at timestamp with time zone NOT NULL,
    status character varying(16) DEFAULT '已排课'::character varying NOT NULL,
    source character varying(24) DEFAULT 'one_off'::character varying NOT NULL,
    recurring_schedule_id character varying(32),
    created_by_user_id character varying(32) NOT NULL,
    created_by_role character varying(24) NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    class_type character varying(32),
    max_students integer,
    CONSTRAINT schedules_duration_min_check CHECK (((duration_min > 0) AND (duration_min <= 480))),
    CONSTRAINT schedules_max_students_check CHECK (((max_students IS NULL) OR (max_students >= 1))),
    CONSTRAINT schedules_source_check CHECK (((source)::text = ANY ((ARRAY['one_off'::character varying, 'recurring_expansion'::character varying])::text[]))),
    CONSTRAINT schedules_status_check CHECK (((status)::text = ANY ((ARRAY['已排课'::character varying, '已完成'::character varying, '已取消'::character varying, '缺席'::character varying])::text[])))
);

--
-- Name: COLUMN schedules.class_type; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.schedules.class_type IS 'V32 班型标签（一对一/一对二/小班/大班/一对多）— 仅 UI 展示';

--
-- Name: COLUMN schedules.max_students; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.schedules.max_students IS 'V32 老师自填的本节课最多学员数（柔性上限，应用层校验 studentIds 数 ≤ max_students）';

--
-- Name: student_assessment_results; Type: TABLE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE TABLE __TENANT_SCHEMA__.student_assessment_results (
    id character varying(32) NOT NULL,
    assessment_id character varying(32) NOT NULL,
    student_id character varying(32) NOT NULL,
    score numeric(6,2),
    rank_in_class integer,
    knowledge_breakdown jsonb,
    teacher_comment text,
    recorded_at timestamp with time zone,
    recorded_by_user_id character varying(32)
);

--
-- Name: student_course_packages; Type: TABLE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE TABLE __TENANT_SCHEMA__.student_course_packages (
    id character varying(32) NOT NULL,
    student_id character varying(32) NOT NULL,
    course_package_id character varying(32) NOT NULL,
    contract_id character varying(32),
    total_lessons integer NOT NULL,
    used_lessons integer DEFAULT 0 NOT NULL,
    refunded_lessons integer DEFAULT 0 NOT NULL,
    remaining_lessons integer GENERATED ALWAYS AS (((total_lessons - used_lessons) - refunded_lessons)) STORED,
    activated_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    status character varying(24) DEFAULT 'active'::character varying NOT NULL,
    low_balance_alerted boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT student_course_packages_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'expired'::character varying, 'depleted'::character varying, 'frozen'::character varying, 'refunded'::character varying])::text[]))),
    CONSTRAINT student_course_packages_total_lessons_check CHECK ((total_lessons > 0))
);

--
-- Name: student_learning_profile; Type: TABLE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE TABLE __TENANT_SCHEMA__.student_learning_profile (
    student_id character varying(32) NOT NULL,
    total_lessons integer DEFAULT 0 NOT NULL,
    total_homeworks integer DEFAULT 0 NOT NULL,
    total_assessments integer DEFAULT 0 NOT NULL,
    attendance_rate numeric(5,2) DEFAULT 0 NOT NULL,
    avg_homework_grade character varying(8),
    avg_assessment_score numeric(6,2),
    knowledge_mastery jsonb DEFAULT '[]'::jsonb NOT NULL,
    weakness_points jsonb DEFAULT '[]'::jsonb NOT NULL,
    strength_points jsonb DEFAULT '[]'::jsonb NOT NULL,
    last_updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: student_teacher_bindings; Type: TABLE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE TABLE __TENANT_SCHEMA__.student_teacher_bindings (
    id character varying(32) NOT NULL,
    student_id character varying(32) NOT NULL,
    teacher_id character varying(32) NOT NULL,
    subject character varying(64),
    status character varying(16) DEFAULT 'active'::character varying NOT NULL,
    bound_at timestamp with time zone DEFAULT now() NOT NULL,
    unbound_at timestamp with time zone,
    bound_by_user_id character varying(32) NOT NULL,
    CONSTRAINT student_teacher_bindings_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'unbound'::character varying])::text[])))
);

--
-- Name: students; Type: TABLE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE TABLE __TENANT_SCHEMA__.students (
    id character varying(32) NOT NULL,
    student_name character varying(32) NOT NULL,
    gender character varying(8),
    grade_or_age character varying(16),
    school_name character varying(64),
    intended_subject character varying(64),
    ability_level character varying(64),
    pain_point_tags character varying(128),
    target_goal character varying(128),
    customer_id character varying(32) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by character varying(32) NOT NULL,
    updated_by character varying(32) NOT NULL,
    owner_sales_id character varying(32),
    assigned_teacher_id character varying(32),
    owner_changed_at timestamp with time zone,
    owner_change_reason character varying(64),
    deleted_at timestamp with time zone,
    CONSTRAINT students_gender_check CHECK (((gender IS NULL) OR ((gender)::text = ANY ((ARRAY['男'::character varying, '女'::character varying, '未知'::character varying])::text[]))))
);

--
-- Name: COLUMN students.owner_sales_id; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.students.owner_sales_id IS 'V28 学生的销售归属（签约后主跟单销售）';

--
-- Name: COLUMN students.assigned_teacher_id; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.students.assigned_teacher_id IS 'V28 学生的主带老师（区别于 schedules.teacher_id 的具体一节课）';

--
-- Name: COLUMN students.deleted_at; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.students.deleted_at IS 'V44 软删除时间戳，NULL=active；状态机走业务字段';

--
-- Name: teacher_ratings; Type: TABLE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE TABLE __TENANT_SCHEMA__.teacher_ratings (
    teacher_id character varying(32) NOT NULL,
    rating_count integer DEFAULT 0 NOT NULL,
    rating_sum numeric(10,2) DEFAULT 0 NOT NULL,
    avg_stars numeric(3,2),
    last_rated_at timestamp with time zone,
    avg_focus numeric(3,2),
    avg_engage numeric(3,2),
    avg_think numeric(3,2),
    avg_homework numeric(3,2),
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: TABLE teacher_ratings; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON TABLE __TENANT_SCHEMA__.teacher_ratings IS 'V24 老师评分聚合（V17 家长评 + V18 dim 维度合并）';

--
-- Name: COLUMN teacher_ratings.avg_stars; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.teacher_ratings.avg_stars IS '综合评分 1.00-5.00';

--
-- Name: teacher_showcase_meta; Type: TABLE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE TABLE __TENANT_SCHEMA__.teacher_showcase_meta (
    teacher_id character varying(32) NOT NULL,
    avatar_url text,
    bio text,
    video_urls jsonb DEFAULT '[]'::jsonb NOT NULL,
    testimonials jsonb DEFAULT '[]'::jsonb NOT NULL,
    displayed_recommendations_count integer DEFAULT 0 NOT NULL,
    trial_available boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by_user_id character varying(32),
    CONSTRAINT teacher_showcase_meta_displayed_recommendations_count_check CHECK ((displayed_recommendations_count >= 0))
);

--
-- Name: TABLE teacher_showcase_meta; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON TABLE __TENANT_SCHEMA__.teacher_showcase_meta IS 'V35 老师 showcase 美化数据表（双轨：与 teachers 系统真实数据隔离，仅展示用，严禁参与 KPI）';

--
-- Name: COLUMN teacher_showcase_meta.teacher_id; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.teacher_showcase_meta.teacher_id IS '老师 ID（FK to teachers.id，PK 即 1:1，每老师最多 1 行 meta）';

--
-- Name: COLUMN teacher_showcase_meta.avatar_url; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.teacher_showcase_meta.avatar_url IS '美化头像 URL（销售卡 / 家长选老师页显示；与 dashboard avatar 共用 fallback：meta.avatar_url 优先）';

--
-- Name: COLUMN teacher_showcase_meta.bio; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.teacher_showcase_meta.bio IS 'V35 美化简介（canonical）— teacher.bio 已变 legacy。读取规则：showcase 视图 meta.bio ?? teacher.bio；系统视图 teacher.bio';

--
-- Name: COLUMN teacher_showcase_meta.video_urls; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.teacher_showcase_meta.video_urls IS '教学视频 URL 列表 [{ "url": ..., "title": ..., "duration_seconds": ... }]';

--
-- Name: COLUMN teacher_showcase_meta.testimonials; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.teacher_showcase_meta.testimonials IS '评价墙 [{ "anon_name": "...", "content": "...", "stars": 5, "submitted_at": "..." }]（与 V17 parent_recommendations 区分：本字段是老师自填的外部好评，可手动编辑）';

--
-- Name: COLUMN teacher_showcase_meta.displayed_recommendations_count; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.teacher_showcase_meta.displayed_recommendations_count IS '老师勾选「展示在业务卡」的推荐数（与 V17 parent_recommendations.displayed=true 同步，C.3 待做）；严禁进 KPI/leaderboard 统计';

--
-- Name: COLUMN teacher_showcase_meta.trial_available; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.teacher_showcase_meta.trial_available IS '是否提供试听课（销售推荐时筛选；只影响 UI 展示）';

--
-- Name: COLUMN teacher_showcase_meta.updated_by_user_id; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.teacher_showcase_meta.updated_by_user_id IS '最后一次美化编辑操作人 user.id（配合 V33 audit_log 追溯）';

--
-- Name: teachers; Type: TABLE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE TABLE __TENANT_SCHEMA__.teachers (
    id character varying(32) NOT NULL,
    campus_id character varying(32) NOT NULL,
    name character varying(64) NOT NULL,
    phone character varying(16),
    user_id character varying(32),
    subjects jsonb DEFAULT '[]'::jsonb NOT NULL,
    bio text,
    hourly_price_yuan numeric(10,2),
    status character varying(16) DEFAULT '在职'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by character varying(32) NOT NULL,
    updated_by character varying(32) NOT NULL,
    phone_encrypted bytea,
    deleted_at timestamp with time zone,
    CONSTRAINT teachers_status_check CHECK (((status)::text = ANY ((ARRAY['在职'::character varying, '请假'::character varying, '归档'::character varying])::text[])))
);

--
-- Name: COLUMN teachers.hourly_price_yuan; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.teachers.hourly_price_yuan IS '课时单价（机构对老师的定价，单位元 / NUMERIC(10,2)）— V39 RENAMED from hourly_rate_yuan；与课消金额计算关联，与工资业务无关';

--
-- Name: COLUMN teachers.phone_encrypted; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.teachers.phone_encrypted IS 'V34 AES-256-GCM 加密手机号（[IV 12B][AuthTag 16B][Cipher]）— 旧 phone 列灰度后于 V35+ 删除';

--
-- Name: COLUMN teachers.deleted_at; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.teachers.deleted_at IS 'V44 软删除时间戳，与 status=归档 互补（归档 90 天 → deleted_at）';

--
-- Name: trial_lessons; Type: TABLE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE TABLE __TENANT_SCHEMA__.trial_lessons (
    id character varying(32) NOT NULL,
    opportunity_id character varying(32) NOT NULL,
    trial_course character varying(64) NOT NULL,
    campus_id character varying(32) NOT NULL,
    teacher_name character varying(32),
    schedule_at timestamp with time zone NOT NULL,
    status character varying(32) DEFAULT '已预约试听'::character varying NOT NULL,
    attended boolean DEFAULT false NOT NULL,
    completed boolean DEFAULT false NOT NULL,
    parent_feedback character varying(256),
    student_feedback character varying(256),
    closing_probability numeric(5,2),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by character varying(32) NOT NULL,
    updated_by character varying(32) NOT NULL,
    CONSTRAINT trial_lessons_closing_probability_check CHECK (((closing_probability IS NULL) OR ((closing_probability >= (0)::numeric) AND (closing_probability <= (100)::numeric)))),
    CONSTRAINT trial_lessons_status_check CHECK (((status)::text = ANY ((ARRAY['已预约试听'::character varying, '已确认到访'::character varying, '已试听'::character varying, '试听未到'::character varying, '试听后待跟单'::character varying, '试听后已丢单'::character varying])::text[])))
);

--
-- Name: users; Type: TABLE; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE TABLE __TENANT_SCHEMA__.users (
    id character varying(32) NOT NULL,
    name character varying(32) NOT NULL,
    mobile character varying(16) NOT NULL,
    role character varying(32) DEFAULT 'sales'::character varying NOT NULL,
    campus_id character varying(32) NOT NULL,
    status character varying(16) DEFAULT '启用'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by character varying(32) NOT NULL,
    updated_by character varying(32) NOT NULL,
    campus_scope jsonb DEFAULT '[]'::jsonb NOT NULL,
    deleted_at timestamp with time zone,
    password_hash character varying(60) DEFAULT ''::character varying NOT NULL,
    password_updated_at timestamp with time zone,
    CONSTRAINT users_role_check CHECK (((role)::text = ANY (ARRAY[('admin'::character varying)::text, ('boss'::character varying)::text, ('sales'::character varying)::text, ('sales_manager'::character varying)::text, ('sales_director'::character varying)::text, ('marketing'::character varying)::text, ('finance'::character varying)::text, ('hr'::character varying)::text, ('teacher'::character varying)::text, ('academic'::character varying)::text, ('academic_admin'::character varying)::text]))),
    CONSTRAINT users_status_check CHECK (((status)::text = ANY ((ARRAY['启用'::character varying, '停用'::character varying])::text[])))
);

--
-- Name: COLUMN users.campus_scope; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.users.campus_scope IS 'campus_scope JSONB 数组（校区 ID 列表）。产品经理 2026-04-30 V3V4 协调函签字：sales 默认 campus_scope=[campus_id] 由 NestJS 应用层 UserService 在创建用户时显式写入，不使用 DB 触发器。默认值仍为 ''[]''::jsonb（V4 已设），应用层负责按 role=sales 时的填充逻辑。';

--
-- Name: COLUMN users.deleted_at; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.users.deleted_at IS 'V44 软删除时间戳，与 status=停用 互补（停用 90 天 → deleted_at）';

--
-- Name: COLUMN users.password_hash; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.users.password_hash IS 'V46 bcrypt cost=12; DEFAULT '''' 兜底旧 row, 应用层 login 校验 hash!='''' 否则 401';

--
-- Name: COLUMN users.password_updated_at; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON COLUMN __TENANT_SCHEMA__.users.password_updated_at IS 'V46 最后改密时间; NULL = 旧 row 或未改密';

--
-- Name: CONSTRAINT users_role_check ON users; Type: COMMENT; Schema: __TENANT_SCHEMA__; Owner: -
--

COMMENT ON CONSTRAINT users_role_check ON __TENANT_SCHEMA__.users IS 'V48 (2026-05-17): 11 role 白名单 (admin/boss/sales/sales_manager/sales_director/marketing/finance/hr/teacher/academic/academic_admin); sales_director 历史兼容应用层 jwt 不再发';

--
-- Name: audit_log id; Type: DEFAULT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.audit_log ALTER COLUMN id SET DEFAULT nextval('__TENANT_SCHEMA__.audit_log_id_seq'::regclass);

--
-- Name: monthly_aggregates id; Type: DEFAULT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.monthly_aggregates ALTER COLUMN id SET DEFAULT nextval('__TENANT_SCHEMA__.monthly_aggregates_id_seq'::regclass);

--
-- Name: assessments assessments_pkey; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.assessments
    ADD CONSTRAINT assessments_pkey PRIMARY KEY (id);

--
-- Name: assignment_recipients assignment_recipients_pkey; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.assignment_recipients
    ADD CONSTRAINT assignment_recipients_pkey PRIMARY KEY (assignment_id, student_id);

--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);

--
-- Name: campuses campuses_pkey; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.campuses
    ADD CONSTRAINT campuses_pkey PRIMARY KEY (id);

--
-- Name: contracts contracts_pkey; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.contracts
    ADD CONSTRAINT contracts_pkey PRIMARY KEY (id);

--
-- Name: course_consumptions course_consumptions_pkey; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.course_consumptions
    ADD CONSTRAINT course_consumptions_pkey PRIMARY KEY (id);

--
-- Name: course_consumptions course_consumptions_schedule_id_student_id_key; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.course_consumptions
    ADD CONSTRAINT course_consumptions_schedule_id_student_id_key UNIQUE (schedule_id, student_id);

--
-- Name: course_packages course_packages_pkey; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.course_packages
    ADD CONSTRAINT course_packages_pkey PRIMARY KEY (id);

--
-- Name: course_products course_products_pkey; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.course_products
    ADD CONSTRAINT course_products_pkey PRIMARY KEY (id);

--
-- Name: customer_follow_log customer_follow_log_pkey; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.customer_follow_log
    ADD CONSTRAINT customer_follow_log_pkey PRIMARY KEY (id);

--
-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);

--
-- Name: customers customers_primary_mobile_key; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.customers
    ADD CONSTRAINT customers_primary_mobile_key UNIQUE (primary_mobile) DEFERRABLE;

--
-- Name: homework_assignments homework_assignments_pkey; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.homework_assignments
    ADD CONSTRAINT homework_assignments_pkey PRIMARY KEY (id);

--
-- Name: homework_submissions homework_submissions_assignment_id_student_id_key; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.homework_submissions
    ADD CONSTRAINT homework_submissions_assignment_id_student_id_key UNIQUE (assignment_id, student_id);

--
-- Name: homework_submissions homework_submissions_pkey; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.homework_submissions
    ADD CONSTRAINT homework_submissions_pkey PRIMARY KEY (id);

--
-- Name: invoices invoices_pkey; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);

--
-- Name: leads leads_pkey; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.leads
    ADD CONSTRAINT leads_pkey PRIMARY KEY (id);

--
-- Name: leaves leaves_pkey; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.leaves
    ADD CONSTRAINT leaves_pkey PRIMARY KEY (id);

--
-- Name: lesson_feedbacks lesson_feedbacks_pkey; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.lesson_feedbacks
    ADD CONSTRAINT lesson_feedbacks_pkey PRIMARY KEY (id);

--
-- Name: lesson_feedbacks lesson_feedbacks_schedule_id_student_id_key; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.lesson_feedbacks
    ADD CONSTRAINT lesson_feedbacks_schedule_id_student_id_key UNIQUE (schedule_id, student_id);

--
-- Name: monthly_aggregates monthly_aggregates_entity_type_entity_id_month_key; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.monthly_aggregates
    ADD CONSTRAINT monthly_aggregates_entity_type_entity_id_month_key UNIQUE (entity_type, entity_id, month);

--
-- Name: monthly_aggregates monthly_aggregates_pkey; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.monthly_aggregates
    ADD CONSTRAINT monthly_aggregates_pkey PRIMARY KEY (id);

--
-- Name: monthly_reports monthly_reports_pkey; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.monthly_reports
    ADD CONSTRAINT monthly_reports_pkey PRIMARY KEY (id);

--
-- Name: monthly_reports monthly_reports_student_id_month_key; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.monthly_reports
    ADD CONSTRAINT monthly_reports_student_id_month_key UNIQUE (student_id, month);

--
-- Name: opportunities opportunities_pkey; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.opportunities
    ADD CONSTRAINT opportunities_pkey PRIMARY KEY (id);

--
-- Name: parent_recommendations parent_recommendations_pkey; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.parent_recommendations
    ADD CONSTRAINT parent_recommendations_pkey PRIMARY KEY (id);

--
-- Name: parent_referrals parent_referrals_pkey; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.parent_referrals
    ADD CONSTRAINT parent_referrals_pkey PRIMARY KEY (id);

--
-- Name: parent_referrals parent_referrals_referral_code_key; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.parent_referrals
    ADD CONSTRAINT parent_referrals_referral_code_key UNIQUE (referral_code);

--
-- Name: payments payments_pkey; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);

--
-- Name: recurring_schedules recurring_schedules_pkey; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.recurring_schedules
    ADD CONSTRAINT recurring_schedules_pkey PRIMARY KEY (id);

--
-- Name: referrals referrals_pkey; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.referrals
    ADD CONSTRAINT referrals_pkey PRIMARY KEY (id);

--
-- Name: renewals renewals_pkey; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.renewals
    ADD CONSTRAINT renewals_pkey PRIMARY KEY (id);

--
-- Name: reverse_orders reverse_orders_pkey; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.reverse_orders
    ADD CONSTRAINT reverse_orders_pkey PRIMARY KEY (id);

--
-- Name: schedule_students schedule_students_pkey; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.schedule_students
    ADD CONSTRAINT schedule_students_pkey PRIMARY KEY (schedule_id, student_id);

--
-- Name: schedules schedules_pkey; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.schedules
    ADD CONSTRAINT schedules_pkey PRIMARY KEY (id);

--
-- Name: student_assessment_results student_assessment_results_assessment_id_student_id_key; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.student_assessment_results
    ADD CONSTRAINT student_assessment_results_assessment_id_student_id_key UNIQUE (assessment_id, student_id);

--
-- Name: student_assessment_results student_assessment_results_pkey; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.student_assessment_results
    ADD CONSTRAINT student_assessment_results_pkey PRIMARY KEY (id);

--
-- Name: student_course_packages student_course_packages_pkey; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.student_course_packages
    ADD CONSTRAINT student_course_packages_pkey PRIMARY KEY (id);

--
-- Name: student_learning_profile student_learning_profile_pkey; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.student_learning_profile
    ADD CONSTRAINT student_learning_profile_pkey PRIMARY KEY (student_id);

--
-- Name: student_teacher_bindings student_teacher_bindings_pkey; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.student_teacher_bindings
    ADD CONSTRAINT student_teacher_bindings_pkey PRIMARY KEY (id);

--
-- Name: student_teacher_bindings student_teacher_bindings_student_id_teacher_id_subject_key; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.student_teacher_bindings
    ADD CONSTRAINT student_teacher_bindings_student_id_teacher_id_subject_key UNIQUE (student_id, teacher_id, subject);

--
-- Name: students students_pkey; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.students
    ADD CONSTRAINT students_pkey PRIMARY KEY (id);

--
-- Name: teacher_ratings teacher_ratings_pkey; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.teacher_ratings
    ADD CONSTRAINT teacher_ratings_pkey PRIMARY KEY (teacher_id);

--
-- Name: teacher_showcase_meta teacher_showcase_meta_pkey; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.teacher_showcase_meta
    ADD CONSTRAINT teacher_showcase_meta_pkey PRIMARY KEY (teacher_id);

--
-- Name: teachers teachers_pkey; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.teachers
    ADD CONSTRAINT teachers_pkey PRIMARY KEY (id);

--
-- Name: trial_lessons trial_lessons_pkey; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.trial_lessons
    ADD CONSTRAINT trial_lessons_pkey PRIMARY KEY (id);

--
-- Name: referrals uq_referrals_tenant_mobile; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.referrals
    ADD CONSTRAINT uq_referrals_tenant_mobile UNIQUE (tenant_id, referred_mobile);

--
-- Name: users users_mobile_key; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.users
    ADD CONSTRAINT users_mobile_key UNIQUE (mobile);

--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

--
-- Name: idx_ar_student; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_ar_student ON __TENANT_SCHEMA__.assignment_recipients USING btree (student_id);

--
-- Name: idx_as_status; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_as_status ON __TENANT_SCHEMA__.assessments USING btree (status);

--
-- Name: idx_as_teacher; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_as_teacher ON __TENANT_SCHEMA__.assessments USING btree (teacher_id, scheduled_at DESC);

--
-- Name: idx_audit_log_action_created; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_audit_log_action_created ON __TENANT_SCHEMA__.audit_log USING btree (action, created_at DESC);

--
-- Name: idx_audit_log_actor_created; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_audit_log_actor_created ON __TENANT_SCHEMA__.audit_log USING btree (actor_user_id, created_at DESC) WHERE (actor_user_id IS NOT NULL);

--
-- Name: idx_audit_log_created_at; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_audit_log_created_at ON __TENANT_SCHEMA__.audit_log USING btree (created_at DESC);

--
-- Name: idx_audit_log_target_created; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_audit_log_target_created ON __TENANT_SCHEMA__.audit_log USING btree (target_type, target_id, created_at DESC) WHERE (target_id IS NOT NULL);

--
-- Name: idx_campuses_status; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_campuses_status ON __TENANT_SCHEMA__.campuses USING btree (status);

--
-- Name: idx_cc_status_due; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_cc_status_due ON __TENANT_SCHEMA__.course_consumptions USING btree (status, feedback_due_at) WHERE ((status)::text = 'pending_feedback'::text);

--
-- Name: idx_cc_teacher_status; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_cc_teacher_status ON __TENANT_SCHEMA__.course_consumptions USING btree (teacher_id, status);

--
-- Name: idx_cfl_by_user; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_cfl_by_user ON __TENANT_SCHEMA__.customer_follow_log USING btree (by_user_id, occurred_at DESC) WHERE (by_user_id IS NOT NULL);

--
-- Name: idx_cfl_opportunity; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_cfl_opportunity ON __TENANT_SCHEMA__.customer_follow_log USING btree (opportunity_id, occurred_at DESC);

--
-- Name: idx_contracts_campus; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_contracts_campus ON __TENANT_SCHEMA__.contracts USING btree (campus_id, signed_at DESC);

--
-- Name: idx_contracts_course_id; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_contracts_course_id ON __TENANT_SCHEMA__.contracts USING btree (course_product_id);

--
-- Name: idx_contracts_course_name; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_contracts_course_name ON __TENANT_SCHEMA__.contracts USING btree (course_product_name) WHERE (course_product_name IS NOT NULL);

--
-- Name: idx_contracts_order_type; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_contracts_order_type ON __TENANT_SCHEMA__.contracts USING btree (order_type);

--
-- Name: idx_contracts_owner; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_contracts_owner ON __TENANT_SCHEMA__.contracts USING btree (owner_user_id, signed_at DESC);

--
-- Name: idx_contracts_owner_changed; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_contracts_owner_changed ON __TENANT_SCHEMA__.contracts USING btree (owner_changed_at DESC) WHERE (owner_changed_at IS NOT NULL);

--
-- Name: idx_contracts_paid_locked; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_contracts_paid_locked ON __TENANT_SCHEMA__.contracts USING btree (paid_locked);

--
-- Name: idx_contracts_pending_invoice; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_contracts_pending_invoice ON __TENANT_SCHEMA__.contracts USING btree (signed_at DESC) WHERE ((invoice_issued = false) AND (deleted_at IS NULL));

--
-- Name: idx_contracts_reverse_from; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_contracts_reverse_from ON __TENANT_SCHEMA__.contracts USING btree (reverse_from_id);

--
-- Name: idx_contracts_signed_at; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_contracts_signed_at ON __TENANT_SCHEMA__.contracts USING btree (signed_at DESC) WHERE (signed_at IS NOT NULL);

--
-- Name: idx_contracts_status; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_contracts_status ON __TENANT_SCHEMA__.contracts USING btree (status);

--
-- Name: idx_contracts_student_id; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_contracts_student_id ON __TENANT_SCHEMA__.contracts USING btree (student_id);

--
-- Name: idx_courseproducts_course_line; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_courseproducts_course_line ON __TENANT_SCHEMA__.course_products USING btree (course_line);

--
-- Name: idx_courseproducts_status; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_courseproducts_status ON __TENANT_SCHEMA__.course_products USING btree (status);

--
-- Name: idx_cp_product; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_cp_product ON __TENANT_SCHEMA__.course_packages USING btree (course_product_id);

--
-- Name: idx_cp_status; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_cp_status ON __TENANT_SCHEMA__.course_packages USING btree (status);

--
-- Name: idx_customers_campus_id; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_customers_campus_id ON __TENANT_SCHEMA__.customers USING btree (campus_id);

--
-- Name: idx_customers_is_return; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_customers_is_return ON __TENANT_SCHEMA__.customers USING btree (is_returning_customer);

--
-- Name: idx_customers_owner_id; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_customers_owner_id ON __TENANT_SCHEMA__.customers USING btree (owner_id);

--
-- Name: idx_customers_primary_mobile_hash; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_customers_primary_mobile_hash ON __TENANT_SCHEMA__.customers USING btree (primary_mobile_hash);

--
-- Name: idx_customers_referrer_id; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_customers_referrer_id ON __TENANT_SCHEMA__.customers USING btree (referrer_id);

--
-- Name: idx_ha_schedule; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_ha_schedule ON __TENANT_SCHEMA__.homework_assignments USING btree (schedule_id);

--
-- Name: idx_ha_status; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_ha_status ON __TENANT_SCHEMA__.homework_assignments USING btree (status);

--
-- Name: idx_ha_teacher; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_ha_teacher ON __TENANT_SCHEMA__.homework_assignments USING btree (teacher_id, created_at DESC);

--
-- Name: idx_hs_pending_grade; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_hs_pending_grade ON __TENANT_SCHEMA__.homework_submissions USING btree (graded_at) WHERE ((status)::text = 'submitted'::text);

--
-- Name: idx_hs_status; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_hs_status ON __TENANT_SCHEMA__.homework_submissions USING btree (status);

--
-- Name: idx_hs_student_time; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_hs_student_time ON __TENANT_SCHEMA__.homework_submissions USING btree (student_id, submitted_at DESC);

--
-- Name: idx_invoices_contract_unique_active; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE UNIQUE INDEX idx_invoices_contract_unique_active ON __TENANT_SCHEMA__.invoices USING btree (contract_id) WHERE ((status)::text = ANY ((ARRAY['pending'::character varying, 'issued'::character varying])::text[]));

--
-- Name: idx_invoices_status_created; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_invoices_status_created ON __TENANT_SCHEMA__.invoices USING btree (status, created_at DESC);

--
-- Name: idx_invoices_student; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_invoices_student ON __TENANT_SCHEMA__.invoices USING btree (student_id) WHERE (student_id IS NOT NULL);

--
-- Name: idx_leads_campus_id; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_leads_campus_id ON __TENANT_SCHEMA__.leads USING btree (campus_id);

--
-- Name: idx_leads_first_contact_at; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_leads_first_contact_at ON __TENANT_SCHEMA__.leads USING btree (first_contact_at);

--
-- Name: idx_leads_owner_id; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_leads_owner_id ON __TENANT_SCHEMA__.leads USING btree (owner_id);

--
-- Name: idx_leads_source_level1; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_leads_source_level1 ON __TENANT_SCHEMA__.leads USING btree (source_level1);

--
-- Name: idx_leaves_lesson; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_leaves_lesson ON __TENANT_SCHEMA__.leaves USING btree (lesson_id);

--
-- Name: idx_leaves_status; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_leaves_status ON __TENANT_SCHEMA__.leaves USING btree (status);

--
-- Name: idx_leaves_student_time; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_leaves_student_time ON __TENANT_SCHEMA__.leaves USING btree (student_id, created_at DESC);

--
-- Name: idx_lf_student_time; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_lf_student_time ON __TENANT_SCHEMA__.lesson_feedbacks USING btree (student_id, submitted_at DESC);

--
-- Name: idx_lf_teacher_time; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_lf_teacher_time ON __TENANT_SCHEMA__.lesson_feedbacks USING btree (teacher_id, submitted_at DESC);

--
-- Name: idx_lf_unread; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_lf_unread ON __TENANT_SCHEMA__.lesson_feedbacks USING btree (parent_read_at) WHERE (parent_read_at IS NULL);

--
-- Name: idx_ma_entity_month; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_ma_entity_month ON __TENANT_SCHEMA__.monthly_aggregates USING btree (entity_type, entity_id, month DESC);

--
-- Name: idx_ma_month; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_ma_month ON __TENANT_SCHEMA__.monthly_aggregates USING btree (month DESC);

--
-- Name: idx_mr_parent_pending; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_mr_parent_pending ON __TENANT_SCHEMA__.monthly_reports USING btree (student_id, month DESC) WHERE ((parent_finalized_at IS NULL) AND ((status)::text = 'teacher_finalized'::text));

--
-- Name: idx_mr_status; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_mr_status ON __TENANT_SCHEMA__.monthly_reports USING btree (status);

--
-- Name: idx_mr_student_month; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_mr_student_month ON __TENANT_SCHEMA__.monthly_reports USING btree (student_id, month DESC);

--
-- Name: idx_opps_campus; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_opps_campus ON __TENANT_SCHEMA__.opportunities USING btree (campus_id);

--
-- Name: idx_opps_course_product_id; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_opps_course_product_id ON __TENANT_SCHEMA__.opportunities USING btree (course_product_id);

--
-- Name: idx_opps_intent_level; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_opps_intent_level ON __TENANT_SCHEMA__.opportunities USING btree (intent_level);

--
-- Name: idx_opps_last_contact; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_opps_last_contact ON __TENANT_SCHEMA__.opportunities USING btree (last_contact_at) WHERE ((owner_user_id IS NOT NULL) AND ((stage)::text <> ALL ((ARRAY['已报名'::character varying, '已失单'::character varying])::text[])));

--
-- Name: idx_opps_next_followup_at; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_opps_next_followup_at ON __TENANT_SCHEMA__.opportunities USING btree (next_followup_at);

--
-- Name: idx_opps_owner; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_opps_owner ON __TENANT_SCHEMA__.opportunities USING btree (owner_user_id);

--
-- Name: idx_opps_owner_campus; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_opps_owner_campus ON __TENANT_SCHEMA__.opportunities USING btree (owner_user_id, campus_id) WHERE (owner_user_id IS NOT NULL);

--
-- Name: idx_opps_owner_changed; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_opps_owner_changed ON __TENANT_SCHEMA__.opportunities USING btree (owner_changed_at DESC) WHERE (owner_changed_at IS NOT NULL);

--
-- Name: idx_opps_pool; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_opps_pool ON __TENANT_SCHEMA__.opportunities USING btree (entered_pool_at) WHERE (owner_user_id IS NULL);

--
-- Name: idx_opps_stage; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_opps_stage ON __TENANT_SCHEMA__.opportunities USING btree (stage);

--
-- Name: idx_opps_student_id; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_opps_student_id ON __TENANT_SCHEMA__.opportunities USING btree (student_id);

--
-- Name: idx_payments_contract_id; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_payments_contract_id ON __TENANT_SCHEMA__.payments USING btree (contract_id);

--
-- Name: idx_payments_paid_at; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_payments_paid_at ON __TENANT_SCHEMA__.payments USING btree (paid_at);

--
-- Name: idx_payments_paid_locked; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_payments_paid_locked ON __TENANT_SCHEMA__.payments USING btree (paid_locked);

--
-- Name: idx_payments_payment_type; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_payments_payment_type ON __TENANT_SCHEMA__.payments USING btree (payment_type);

--
-- Name: idx_payments_refund_status; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_payments_refund_status ON __TENANT_SCHEMA__.payments USING btree (refund_status);

--
-- Name: idx_payments_student_id; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_payments_student_id ON __TENANT_SCHEMA__.payments USING btree (student_id);

--
-- Name: idx_pr_code; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_pr_code ON __TENANT_SCHEMA__.parent_referrals USING btree (referral_code);

--
-- Name: idx_pr_parent; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_pr_parent ON __TENANT_SCHEMA__.parent_recommendations USING btree (parent_id);

--
-- Name: idx_pr_pending_expires; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_pr_pending_expires ON __TENANT_SCHEMA__.parent_referrals USING btree (expires_at) WHERE ((status)::text = 'created'::text);

--
-- Name: idx_pr_referrer; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_pr_referrer ON __TENANT_SCHEMA__.parent_referrals USING btree (referrer_parent_id, created_at DESC);

--
-- Name: idx_pr_teacher_displayed; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_pr_teacher_displayed ON __TENANT_SCHEMA__.parent_recommendations USING btree (teacher_id, displayed);

--
-- Name: idx_pr_teacher_status; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_pr_teacher_status ON __TENANT_SCHEMA__.parent_referrals USING btree (teacher_id, status);

--
-- Name: idx_pr_teacher_time; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_pr_teacher_time ON __TENANT_SCHEMA__.parent_recommendations USING btree (teacher_id, submitted_at DESC);

--
-- Name: idx_referrals_campus; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_referrals_campus ON __TENANT_SCHEMA__.referrals USING btree (campus_id);

--
-- Name: idx_referrals_created_at; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_referrals_created_at ON __TENANT_SCHEMA__.referrals USING btree (created_at);

--
-- Name: idx_referrals_referrer; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_referrals_referrer ON __TENANT_SCHEMA__.referrals USING btree (referrer_customer_id);

--
-- Name: idx_referrals_reward_status; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_referrals_reward_status ON __TENANT_SCHEMA__.referrals USING btree (reward_status);

--
-- Name: idx_referrals_status; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_referrals_status ON __TENANT_SCHEMA__.referrals USING btree (status);

--
-- Name: idx_renewals_campus; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_renewals_campus ON __TENANT_SCHEMA__.renewals USING btree (campus_id);

--
-- Name: idx_renewals_due_at; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_renewals_due_at ON __TENANT_SCHEMA__.renewals USING btree (due_at);

--
-- Name: idx_renewals_owner; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_renewals_owner ON __TENANT_SCHEMA__.renewals USING btree (owner_id);

--
-- Name: idx_renewals_source; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_renewals_source ON __TENANT_SCHEMA__.renewals USING btree (source_contract_id);

--
-- Name: idx_renewals_status; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_renewals_status ON __TENANT_SCHEMA__.renewals USING btree (status);

--
-- Name: idx_reverse_source_contract; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_reverse_source_contract ON __TENANT_SCHEMA__.reverse_orders USING btree (source_contract_id);

--
-- Name: idx_reverse_source_payment; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_reverse_source_payment ON __TENANT_SCHEMA__.reverse_orders USING btree (source_payment_id);

--
-- Name: idx_reverse_status; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_reverse_status ON __TENANT_SCHEMA__.reverse_orders USING btree (reverse_status);

--
-- Name: idx_reverse_type; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_reverse_type ON __TENANT_SCHEMA__.reverse_orders USING btree (reverse_type);

--
-- Name: idx_rs_active; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_rs_active ON __TENANT_SCHEMA__.recurring_schedules USING btree (status) WHERE ((status)::text = 'active'::text);

--
-- Name: idx_rs_binding; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_rs_binding ON __TENANT_SCHEMA__.recurring_schedules USING btree (binding_id);

--
-- Name: idx_rs_student; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_rs_student ON __TENANT_SCHEMA__.recurring_schedules USING btree (student_id);

--
-- Name: idx_rs_teacher; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_rs_teacher ON __TENANT_SCHEMA__.recurring_schedules USING btree (teacher_id);

--
-- Name: idx_sar_assessment; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_sar_assessment ON __TENANT_SCHEMA__.student_assessment_results USING btree (assessment_id);

--
-- Name: idx_sar_student_time; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_sar_student_time ON __TENANT_SCHEMA__.student_assessment_results USING btree (student_id, recorded_at DESC);

--
-- Name: idx_schedule_students_attendance; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_schedule_students_attendance ON __TENANT_SCHEMA__.schedule_students USING btree (attendance_status);

--
-- Name: idx_schedule_students_student; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_schedule_students_student ON __TENANT_SCHEMA__.schedule_students USING btree (student_id);

--
-- Name: idx_schedules_class_type; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_schedules_class_type ON __TENANT_SCHEMA__.schedules USING btree (class_type) WHERE (class_type IS NOT NULL);

--
-- Name: idx_schedules_course; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_schedules_course ON __TENANT_SCHEMA__.schedules USING btree (course_product_id);

--
-- Name: idx_schedules_recurring; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_schedules_recurring ON __TENANT_SCHEMA__.schedules USING btree (recurring_schedule_id);

--
-- Name: idx_schedules_status; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_schedules_status ON __TENANT_SCHEMA__.schedules USING btree (status);

--
-- Name: idx_schedules_teacher_time; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_schedules_teacher_time ON __TENANT_SCHEMA__.schedules USING btree (teacher_id, start_at, end_at);

--
-- Name: idx_scp_expires; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_scp_expires ON __TENANT_SCHEMA__.student_course_packages USING btree (expires_at) WHERE ((status)::text = 'active'::text);

--
-- Name: idx_scp_lowbal; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_scp_lowbal ON __TENANT_SCHEMA__.student_course_packages USING btree (student_id, remaining_lessons) WHERE (((status)::text = 'active'::text) AND (low_balance_alerted = false));

--
-- Name: idx_scp_status; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_scp_status ON __TENANT_SCHEMA__.student_course_packages USING btree (status);

--
-- Name: idx_scp_student; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_scp_student ON __TENANT_SCHEMA__.student_course_packages USING btree (student_id);

--
-- Name: idx_stb_status; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_stb_status ON __TENANT_SCHEMA__.student_teacher_bindings USING btree (status);

--
-- Name: idx_stb_student; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_stb_student ON __TENANT_SCHEMA__.student_teacher_bindings USING btree (student_id);

--
-- Name: idx_stb_teacher; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_stb_teacher ON __TENANT_SCHEMA__.student_teacher_bindings USING btree (teacher_id);

--
-- Name: idx_students_assigned_teacher; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_students_assigned_teacher ON __TENANT_SCHEMA__.students USING btree (assigned_teacher_id) WHERE (assigned_teacher_id IS NOT NULL);

--
-- Name: idx_students_customer_id; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_students_customer_id ON __TENANT_SCHEMA__.students USING btree (customer_id);

--
-- Name: idx_students_deleted_at; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_students_deleted_at ON __TENANT_SCHEMA__.students USING btree (deleted_at) WHERE (deleted_at IS NOT NULL);

--
-- Name: idx_students_intended_subject; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_students_intended_subject ON __TENANT_SCHEMA__.students USING btree (intended_subject);

--
-- Name: idx_students_owner_sales; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_students_owner_sales ON __TENANT_SCHEMA__.students USING btree (owner_sales_id) WHERE (owner_sales_id IS NOT NULL);

--
-- Name: idx_teachers_campus_id; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_teachers_campus_id ON __TENANT_SCHEMA__.teachers USING btree (campus_id);

--
-- Name: idx_teachers_deleted_at; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_teachers_deleted_at ON __TENANT_SCHEMA__.teachers USING btree (deleted_at) WHERE (deleted_at IS NOT NULL);

--
-- Name: idx_teachers_status; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_teachers_status ON __TENANT_SCHEMA__.teachers USING btree (status);

--
-- Name: idx_teachers_user_id; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_teachers_user_id ON __TENANT_SCHEMA__.teachers USING btree (user_id);

--
-- Name: idx_tr_avg_stars; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_tr_avg_stars ON __TENANT_SCHEMA__.teacher_ratings USING btree (avg_stars DESC NULLS LAST);

--
-- Name: idx_trial_campus_id; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_trial_campus_id ON __TENANT_SCHEMA__.trial_lessons USING btree (campus_id);

--
-- Name: idx_trial_opp_id; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_trial_opp_id ON __TENANT_SCHEMA__.trial_lessons USING btree (opportunity_id);

--
-- Name: idx_trial_schedule_at; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_trial_schedule_at ON __TENANT_SCHEMA__.trial_lessons USING btree (schedule_at);

--
-- Name: idx_trial_status; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_trial_status ON __TENANT_SCHEMA__.trial_lessons USING btree (status);

--
-- Name: idx_tsm_disp_rec_count; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_tsm_disp_rec_count ON __TENANT_SCHEMA__.teacher_showcase_meta USING btree (displayed_recommendations_count DESC);

--
-- Name: idx_tsm_trial_available; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_tsm_trial_available ON __TENANT_SCHEMA__.teacher_showcase_meta USING btree (trial_available) WHERE (trial_available = true);

--
-- Name: idx_tsm_updated_at; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_tsm_updated_at ON __TENANT_SCHEMA__.teacher_showcase_meta USING btree (updated_at DESC);

--
-- Name: idx_users_campus_id; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_users_campus_id ON __TENANT_SCHEMA__.users USING btree (campus_id);

--
-- Name: idx_users_deleted_at; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_users_deleted_at ON __TENANT_SCHEMA__.users USING btree (deleted_at) WHERE (deleted_at IS NOT NULL);

--
-- Name: idx_users_role; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_users_role ON __TENANT_SCHEMA__.users USING btree (role);

--
-- Name: idx_users_status; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE INDEX idx_users_status ON __TENANT_SCHEMA__.users USING btree (status);

--
-- Name: uniq_recurring_expansion; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE UNIQUE INDEX uniq_recurring_expansion ON __TENANT_SCHEMA__.schedules USING btree (recurring_schedule_id, start_at) WHERE ((source)::text = 'recurring_expansion'::text);

--
-- Name: uq_courseproducts_name_active; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE UNIQUE INDEX uq_courseproducts_name_active ON __TENANT_SCHEMA__.course_products USING btree (product_name) WHERE ((status)::text = '上架'::text);

--
-- Name: uq_pr_referee_parent; Type: INDEX; Schema: __TENANT_SCHEMA__; Owner: -
--

CREATE UNIQUE INDEX uq_pr_referee_parent ON __TENANT_SCHEMA__.parent_referrals USING btree (referee_parent_id) WHERE (referee_parent_id IS NOT NULL);

--
-- Name: assessments assessments_teacher_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.assessments
    ADD CONSTRAINT assessments_teacher_id_fkey FOREIGN KEY (teacher_id) REFERENCES __TENANT_SCHEMA__.teachers(id);

--
-- Name: assignment_recipients assignment_recipients_assignment_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.assignment_recipients
    ADD CONSTRAINT assignment_recipients_assignment_id_fkey FOREIGN KEY (assignment_id) REFERENCES __TENANT_SCHEMA__.homework_assignments(id) ON DELETE CASCADE;

--
-- Name: assignment_recipients assignment_recipients_student_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.assignment_recipients
    ADD CONSTRAINT assignment_recipients_student_id_fkey FOREIGN KEY (student_id) REFERENCES __TENANT_SCHEMA__.students(id);

--
-- Name: contracts contracts_campus_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.contracts
    ADD CONSTRAINT contracts_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES __TENANT_SCHEMA__.campuses(id);

--
-- Name: contracts contracts_course_product_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.contracts
    ADD CONSTRAINT contracts_course_product_id_fkey FOREIGN KEY (course_product_id) REFERENCES __TENANT_SCHEMA__.course_products(id);

--
-- Name: contracts contracts_opportunity_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.contracts
    ADD CONSTRAINT contracts_opportunity_id_fkey FOREIGN KEY (opportunity_id) REFERENCES __TENANT_SCHEMA__.opportunities(id);

--
-- Name: contracts contracts_student_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.contracts
    ADD CONSTRAINT contracts_student_id_fkey FOREIGN KEY (student_id) REFERENCES __TENANT_SCHEMA__.students(id);

--
-- Name: course_consumptions course_consumptions_feedback_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.course_consumptions
    ADD CONSTRAINT course_consumptions_feedback_id_fkey FOREIGN KEY (feedback_id) REFERENCES __TENANT_SCHEMA__.lesson_feedbacks(id);

--
-- Name: course_consumptions course_consumptions_schedule_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.course_consumptions
    ADD CONSTRAINT course_consumptions_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES __TENANT_SCHEMA__.schedules(id);

--
-- Name: course_consumptions course_consumptions_student_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.course_consumptions
    ADD CONSTRAINT course_consumptions_student_id_fkey FOREIGN KEY (student_id) REFERENCES __TENANT_SCHEMA__.students(id);

--
-- Name: course_consumptions course_consumptions_teacher_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.course_consumptions
    ADD CONSTRAINT course_consumptions_teacher_id_fkey FOREIGN KEY (teacher_id) REFERENCES __TENANT_SCHEMA__.teachers(id);

--
-- Name: course_packages course_packages_course_product_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.course_packages
    ADD CONSTRAINT course_packages_course_product_id_fkey FOREIGN KEY (course_product_id) REFERENCES __TENANT_SCHEMA__.course_products(id);

--
-- Name: customer_follow_log customer_follow_log_opportunity_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.customer_follow_log
    ADD CONSTRAINT customer_follow_log_opportunity_id_fkey FOREIGN KEY (opportunity_id) REFERENCES __TENANT_SCHEMA__.opportunities(id);

--
-- Name: customers customers_campus_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.customers
    ADD CONSTRAINT customers_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES __TENANT_SCHEMA__.campuses(id);

--
-- Name: customers customers_owner_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.customers
    ADD CONSTRAINT customers_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES __TENANT_SCHEMA__.users(id);

--
-- Name: opportunities fk_opps_course_product; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.opportunities
    ADD CONSTRAINT fk_opps_course_product FOREIGN KEY (course_product_id) REFERENCES __TENANT_SCHEMA__.course_products(id);

--
-- Name: homework_assignments homework_assignments_schedule_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.homework_assignments
    ADD CONSTRAINT homework_assignments_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES __TENANT_SCHEMA__.schedules(id);

--
-- Name: homework_assignments homework_assignments_teacher_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.homework_assignments
    ADD CONSTRAINT homework_assignments_teacher_id_fkey FOREIGN KEY (teacher_id) REFERENCES __TENANT_SCHEMA__.teachers(id);

--
-- Name: homework_submissions homework_submissions_assignment_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.homework_submissions
    ADD CONSTRAINT homework_submissions_assignment_id_fkey FOREIGN KEY (assignment_id) REFERENCES __TENANT_SCHEMA__.homework_assignments(id);

--
-- Name: homework_submissions homework_submissions_student_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.homework_submissions
    ADD CONSTRAINT homework_submissions_student_id_fkey FOREIGN KEY (student_id) REFERENCES __TENANT_SCHEMA__.students(id);

--
-- Name: leads leads_campus_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.leads
    ADD CONSTRAINT leads_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES __TENANT_SCHEMA__.campuses(id);

--
-- Name: leads leads_owner_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.leads
    ADD CONSTRAINT leads_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES __TENANT_SCHEMA__.users(id);

--
-- Name: leaves leaves_lesson_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.leaves
    ADD CONSTRAINT leaves_lesson_id_fkey FOREIGN KEY (lesson_id) REFERENCES __TENANT_SCHEMA__.schedules(id);

--
-- Name: leaves leaves_student_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.leaves
    ADD CONSTRAINT leaves_student_id_fkey FOREIGN KEY (student_id) REFERENCES __TENANT_SCHEMA__.students(id);

--
-- Name: lesson_feedbacks lesson_feedbacks_schedule_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.lesson_feedbacks
    ADD CONSTRAINT lesson_feedbacks_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES __TENANT_SCHEMA__.schedules(id);

--
-- Name: lesson_feedbacks lesson_feedbacks_student_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.lesson_feedbacks
    ADD CONSTRAINT lesson_feedbacks_student_id_fkey FOREIGN KEY (student_id) REFERENCES __TENANT_SCHEMA__.students(id);

--
-- Name: lesson_feedbacks lesson_feedbacks_teacher_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.lesson_feedbacks
    ADD CONSTRAINT lesson_feedbacks_teacher_id_fkey FOREIGN KEY (teacher_id) REFERENCES __TENANT_SCHEMA__.teachers(id);

--
-- Name: monthly_reports monthly_reports_student_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.monthly_reports
    ADD CONSTRAINT monthly_reports_student_id_fkey FOREIGN KEY (student_id) REFERENCES __TENANT_SCHEMA__.students(id);

--
-- Name: monthly_reports monthly_reports_teacher_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.monthly_reports
    ADD CONSTRAINT monthly_reports_teacher_id_fkey FOREIGN KEY (teacher_id) REFERENCES __TENANT_SCHEMA__.teachers(id);

--
-- Name: opportunities opportunities_campus_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.opportunities
    ADD CONSTRAINT opportunities_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES __TENANT_SCHEMA__.campuses(id);

--
-- Name: opportunities opportunities_student_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.opportunities
    ADD CONSTRAINT opportunities_student_id_fkey FOREIGN KEY (student_id) REFERENCES __TENANT_SCHEMA__.students(id);

--
-- Name: parent_recommendations parent_recommendations_student_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.parent_recommendations
    ADD CONSTRAINT parent_recommendations_student_id_fkey FOREIGN KEY (student_id) REFERENCES __TENANT_SCHEMA__.students(id);

--
-- Name: parent_recommendations parent_recommendations_teacher_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.parent_recommendations
    ADD CONSTRAINT parent_recommendations_teacher_id_fkey FOREIGN KEY (teacher_id) REFERENCES __TENANT_SCHEMA__.teachers(id);

--
-- Name: parent_referrals parent_referrals_referee_student_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.parent_referrals
    ADD CONSTRAINT parent_referrals_referee_student_id_fkey FOREIGN KEY (referee_student_id) REFERENCES __TENANT_SCHEMA__.students(id);

--
-- Name: parent_referrals parent_referrals_referrer_student_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.parent_referrals
    ADD CONSTRAINT parent_referrals_referrer_student_id_fkey FOREIGN KEY (referrer_student_id) REFERENCES __TENANT_SCHEMA__.students(id);

--
-- Name: parent_referrals parent_referrals_teacher_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.parent_referrals
    ADD CONSTRAINT parent_referrals_teacher_id_fkey FOREIGN KEY (teacher_id) REFERENCES __TENANT_SCHEMA__.teachers(id);

--
-- Name: parent_referrals parent_referrals_trial_schedule_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.parent_referrals
    ADD CONSTRAINT parent_referrals_trial_schedule_id_fkey FOREIGN KEY (trial_schedule_id) REFERENCES __TENANT_SCHEMA__.schedules(id);

--
-- Name: payments payments_contract_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.payments
    ADD CONSTRAINT payments_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES __TENANT_SCHEMA__.contracts(id);

--
-- Name: payments payments_student_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.payments
    ADD CONSTRAINT payments_student_id_fkey FOREIGN KEY (student_id) REFERENCES __TENANT_SCHEMA__.students(id);

--
-- Name: recurring_schedules recurring_schedules_binding_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.recurring_schedules
    ADD CONSTRAINT recurring_schedules_binding_id_fkey FOREIGN KEY (binding_id) REFERENCES __TENANT_SCHEMA__.student_teacher_bindings(id);

--
-- Name: recurring_schedules recurring_schedules_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.recurring_schedules
    ADD CONSTRAINT recurring_schedules_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES __TENANT_SCHEMA__.users(id);

--
-- Name: recurring_schedules recurring_schedules_student_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.recurring_schedules
    ADD CONSTRAINT recurring_schedules_student_id_fkey FOREIGN KEY (student_id) REFERENCES __TENANT_SCHEMA__.students(id);

--
-- Name: recurring_schedules recurring_schedules_teacher_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.recurring_schedules
    ADD CONSTRAINT recurring_schedules_teacher_id_fkey FOREIGN KEY (teacher_id) REFERENCES __TENANT_SCHEMA__.teachers(id);

--
-- Name: referrals referrals_campus_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.referrals
    ADD CONSTRAINT referrals_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES __TENANT_SCHEMA__.campuses(id);

--
-- Name: referrals referrals_converted_customer_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.referrals
    ADD CONSTRAINT referrals_converted_customer_id_fkey FOREIGN KEY (converted_customer_id) REFERENCES __TENANT_SCHEMA__.customers(id);

--
-- Name: referrals referrals_referrer_customer_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.referrals
    ADD CONSTRAINT referrals_referrer_customer_id_fkey FOREIGN KEY (referrer_customer_id) REFERENCES __TENANT_SCHEMA__.customers(id);

--
-- Name: referrals referrals_referrer_student_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.referrals
    ADD CONSTRAINT referrals_referrer_student_id_fkey FOREIGN KEY (referrer_student_id) REFERENCES __TENANT_SCHEMA__.students(id);

--
-- Name: referrals referrals_source_lead_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.referrals
    ADD CONSTRAINT referrals_source_lead_id_fkey FOREIGN KEY (source_lead_id) REFERENCES __TENANT_SCHEMA__.leads(id);

--
-- Name: renewals renewals_campus_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.renewals
    ADD CONSTRAINT renewals_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES __TENANT_SCHEMA__.campuses(id);

--
-- Name: renewals renewals_course_product_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.renewals
    ADD CONSTRAINT renewals_course_product_id_fkey FOREIGN KEY (course_product_id) REFERENCES __TENANT_SCHEMA__.course_products(id);

--
-- Name: renewals renewals_customer_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.renewals
    ADD CONSTRAINT renewals_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES __TENANT_SCHEMA__.customers(id);

--
-- Name: renewals renewals_owner_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.renewals
    ADD CONSTRAINT renewals_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES __TENANT_SCHEMA__.users(id);

--
-- Name: renewals renewals_renewed_contract_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.renewals
    ADD CONSTRAINT renewals_renewed_contract_id_fkey FOREIGN KEY (renewed_contract_id) REFERENCES __TENANT_SCHEMA__.contracts(id);

--
-- Name: renewals renewals_source_contract_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.renewals
    ADD CONSTRAINT renewals_source_contract_id_fkey FOREIGN KEY (source_contract_id) REFERENCES __TENANT_SCHEMA__.contracts(id);

--
-- Name: renewals renewals_student_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.renewals
    ADD CONSTRAINT renewals_student_id_fkey FOREIGN KEY (student_id) REFERENCES __TENANT_SCHEMA__.students(id);

--
-- Name: reverse_orders reverse_orders_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.reverse_orders
    ADD CONSTRAINT reverse_orders_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES __TENANT_SCHEMA__.users(id);

--
-- Name: reverse_orders reverse_orders_source_contract_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.reverse_orders
    ADD CONSTRAINT reverse_orders_source_contract_id_fkey FOREIGN KEY (source_contract_id) REFERENCES __TENANT_SCHEMA__.contracts(id);

--
-- Name: reverse_orders reverse_orders_source_payment_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.reverse_orders
    ADD CONSTRAINT reverse_orders_source_payment_id_fkey FOREIGN KEY (source_payment_id) REFERENCES __TENANT_SCHEMA__.payments(id);

--
-- Name: schedule_students schedule_students_schedule_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.schedule_students
    ADD CONSTRAINT schedule_students_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES __TENANT_SCHEMA__.schedules(id) ON DELETE CASCADE;

--
-- Name: schedule_students schedule_students_student_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.schedule_students
    ADD CONSTRAINT schedule_students_student_id_fkey FOREIGN KEY (student_id) REFERENCES __TENANT_SCHEMA__.students(id);

--
-- Name: schedules schedules_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.schedules
    ADD CONSTRAINT schedules_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES __TENANT_SCHEMA__.users(id);

--
-- Name: schedules schedules_teacher_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.schedules
    ADD CONSTRAINT schedules_teacher_id_fkey FOREIGN KEY (teacher_id) REFERENCES __TENANT_SCHEMA__.teachers(id);

--
-- Name: student_assessment_results student_assessment_results_assessment_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.student_assessment_results
    ADD CONSTRAINT student_assessment_results_assessment_id_fkey FOREIGN KEY (assessment_id) REFERENCES __TENANT_SCHEMA__.assessments(id);

--
-- Name: student_assessment_results student_assessment_results_student_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.student_assessment_results
    ADD CONSTRAINT student_assessment_results_student_id_fkey FOREIGN KEY (student_id) REFERENCES __TENANT_SCHEMA__.students(id);

--
-- Name: student_course_packages student_course_packages_contract_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.student_course_packages
    ADD CONSTRAINT student_course_packages_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES __TENANT_SCHEMA__.contracts(id);

--
-- Name: student_course_packages student_course_packages_course_package_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.student_course_packages
    ADD CONSTRAINT student_course_packages_course_package_id_fkey FOREIGN KEY (course_package_id) REFERENCES __TENANT_SCHEMA__.course_packages(id);

--
-- Name: student_course_packages student_course_packages_student_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.student_course_packages
    ADD CONSTRAINT student_course_packages_student_id_fkey FOREIGN KEY (student_id) REFERENCES __TENANT_SCHEMA__.students(id);

--
-- Name: student_learning_profile student_learning_profile_student_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.student_learning_profile
    ADD CONSTRAINT student_learning_profile_student_id_fkey FOREIGN KEY (student_id) REFERENCES __TENANT_SCHEMA__.students(id);

--
-- Name: student_teacher_bindings student_teacher_bindings_bound_by_user_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.student_teacher_bindings
    ADD CONSTRAINT student_teacher_bindings_bound_by_user_id_fkey FOREIGN KEY (bound_by_user_id) REFERENCES __TENANT_SCHEMA__.users(id);

--
-- Name: student_teacher_bindings student_teacher_bindings_student_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.student_teacher_bindings
    ADD CONSTRAINT student_teacher_bindings_student_id_fkey FOREIGN KEY (student_id) REFERENCES __TENANT_SCHEMA__.students(id);

--
-- Name: student_teacher_bindings student_teacher_bindings_teacher_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.student_teacher_bindings
    ADD CONSTRAINT student_teacher_bindings_teacher_id_fkey FOREIGN KEY (teacher_id) REFERENCES __TENANT_SCHEMA__.teachers(id);

--
-- Name: students students_assigned_teacher_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.students
    ADD CONSTRAINT students_assigned_teacher_id_fkey FOREIGN KEY (assigned_teacher_id) REFERENCES __TENANT_SCHEMA__.teachers(id);

--
-- Name: students students_customer_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.students
    ADD CONSTRAINT students_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES __TENANT_SCHEMA__.customers(id);

--
-- Name: students students_owner_sales_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.students
    ADD CONSTRAINT students_owner_sales_id_fkey FOREIGN KEY (owner_sales_id) REFERENCES __TENANT_SCHEMA__.users(id);

--
-- Name: teacher_ratings teacher_ratings_teacher_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.teacher_ratings
    ADD CONSTRAINT teacher_ratings_teacher_id_fkey FOREIGN KEY (teacher_id) REFERENCES __TENANT_SCHEMA__.teachers(id);

--
-- Name: teacher_showcase_meta teacher_showcase_meta_teacher_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.teacher_showcase_meta
    ADD CONSTRAINT teacher_showcase_meta_teacher_id_fkey FOREIGN KEY (teacher_id) REFERENCES __TENANT_SCHEMA__.teachers(id) ON DELETE CASCADE;

--
-- Name: teachers teachers_campus_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.teachers
    ADD CONSTRAINT teachers_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES __TENANT_SCHEMA__.campuses(id);

--
-- Name: teachers teachers_user_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.teachers
    ADD CONSTRAINT teachers_user_id_fkey FOREIGN KEY (user_id) REFERENCES __TENANT_SCHEMA__.users(id);

--
-- Name: trial_lessons trial_lessons_campus_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.trial_lessons
    ADD CONSTRAINT trial_lessons_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES __TENANT_SCHEMA__.campuses(id);

--
-- Name: trial_lessons trial_lessons_opportunity_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.trial_lessons
    ADD CONSTRAINT trial_lessons_opportunity_id_fkey FOREIGN KEY (opportunity_id) REFERENCES __TENANT_SCHEMA__.opportunities(id);

--
-- Name: users users_campus_id_fkey; Type: FK CONSTRAINT; Schema: __TENANT_SCHEMA__; Owner: -
--

ALTER TABLE ONLY __TENANT_SCHEMA__.users
    ADD CONSTRAINT users_campus_id_fkey FOREIGN KEY (campus_id) REFERENCES __TENANT_SCHEMA__.campuses(id);

--
-- PostgreSQL database dump complete
--

\unrestrict fFKiHliNllj5kiNbJ3UR1E5ZKWc6JFKPMLK9mhqKlavdNg9AnuktbcwszwDTGai

